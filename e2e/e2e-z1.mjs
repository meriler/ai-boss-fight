// E2E-must демки З1 (ТЗ-демка-з1 §9, DoD пп.2–8): полный tap-проход ?ws=1&seat=N →
// artifact_saved · reveal-lock на 2 клиентах + дашборд (замок до N/N, override с логом) ·
// 3 ключевые F5-точки (посреди раскладки / «коммит есть, reveal не наступил» / после R2)
// с restore ≤3 c и без перепоказа сделанного · DOM-чеки конституции (≤5 интерактивов,
// тексты ≤120, touch ≥44 px) на каждом детском экране · дифф тест-манифеста ТЕМ ЖЕ кодом.
//
// Запуск (самодостаточный — сам спавнит сервер со статикой):
//   cd e2e && node e2e-z1.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PORT = 8600 + (process.pid % 300);   // уникальный порт: осиротевший сервер прошлого прогона не подставит своё состояние
const BASE = `http://127.0.0.1:${PORT}`;
process.on('exit', () => { try { server.kill(); } catch (e) {} });

const log = [];
let fails = 0;
const ok = (name, cond, extra = '') => {
  log.push((cond ? 'PASS ' : 'FAIL ') + name + (extra && !cond ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

/* ---------- сервер ---------- */
const dataDir = mkdtempSync(path.join(tmpdir(), 'z1e2e-'));
writeFileSync(path.join(dataDir, 'seats.json'), JSON.stringify({ 1: 'Тест-А', 2: 'Тест-Б' }));
const server = spawn('python3', [path.join(ROOT, 'server/tele.py')], {
  env: { ...process.env, WS_TELE_DIR: dataDir, WS_TELE_PORT: String(PORT), WS_STATIC_DIR: ROOT },
  stdio: 'ignore',
});
for (let i = 0; ; i++) {
  try { const r = await fetch(BASE + '/dash'); if (r.ok) break; } catch (e) {}
  if (i > 50) { console.log('FAIL сервер не поднялся'); process.exit(1); }
  await new Promise(r => setTimeout(r, 200));
}

const host = (p, body) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Referer: BASE + '/dash' },
  body: JSON.stringify(body),
}).then(r => r.json());

/* ---------- браузер ---------- */
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const mkChild = async (seat, variant) => {
  const c = await browser.newContext({ viewport: { width: 640, height: 760 } });   // узкая половина 13"
  const p = await c.newPage();
  p.setDefaultTimeout(30000);
  await p.goto(`${BASE}/z1.html?ws=1&demo=1&seat=${seat}` + (variant ? `&variant=${variant}` : ''));
  return p;
};

const state = (p) => p.evaluate(() => {
  const s = document.getElementById('screen');
  return { step: s.dataset.step || '', phase: s.dataset.phase || '',
           entry: s.dataset.entry === '1', done: s.dataset.done === '1' };
});
async function waitState(p, pred, timeout = 30000, what = '') {
  const t0 = Date.now();
  for (;;) {
    const st = await state(p);
    if (pred(st)) return st;
    if (Date.now() - t0 > timeout)
      throw new Error('waitState timeout' + (what ? ' (' + what + ')' : '') + ': ' + JSON.stringify(st));
    await new Promise(r => setTimeout(r, 120));
  }
}
const clickIf = async (p, sel) => {
  const el = await p.$(sel);
  if (!el) return false;
  const usable = await el.evaluate(e => !e.disabled && !e.closest('[inert]') && e.getClientRects().length > 0);
  if (!usable) return false;
  await el.click();
  return true;
};

/* ---------- DOM-чек конституции (правило 11: скриптом по DOM, не «на глаз») ---------- */
const domViolations = new Map();
async function domCheck(p, tag) {
  if (domViolations.has(tag)) return;
  const v = await p.evaluate(() => {
    const out = [];
    const vis = el => el.getClientRects().length > 0 && !el.closest('[inert]') &&
      getComputedStyle(el).visibility !== 'hidden';
    const inter = [...document.querySelectorAll('button, input, textarea, select, [role=button], [draggable=true], a[href]')]
      .filter(el => vis(el) && !el.disabled && el.id !== 'stuck' && !el.closest('#stuck'));
    if (inter.length > 5)
      out.push(`интерактивов ${inter.length} > 5: ` + inter.map(e => e.id || e.className).join(','));
    for (const el of inter) {
      const r = el.getBoundingClientRect();
      if (Math.min(r.width, r.height) < 44)
        out.push(`touch <44px: ${el.id || el.className} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    for (const el of document.querySelectorAll('[data-kid], button')) {
      if (!vis(el)) continue;
      const t = (el.textContent || '').trim();
      if (t.length > 120) out.push(`текст >120: ${t.slice(0, 40)}…`);
    }
    return out;
  });
  domViolations.set(tag, v);
}

/* ---------- generic-драйвер занятия по манифесту (identity-agnostic — DoD п.2) ---------- */
function loadManifestNode(variant) {
  const lesson = JSON.parse(readFileSync(path.join(ROOT, 'content', variant, 'lesson.json'), 'utf-8')).lesson;
  const bank = JSON.parse(readFileSync(path.join(ROOT, 'content', variant, 'bank.json'), 'utf-8'));
  const byId = Object.fromEntries(bank.images.map(i => [i.id, i]));
  const byRole = {};
  for (const i of bank.images) (byRole[i.role] = byRole[i.role] || []).push(i);
  return { lesson, bank, byId, byRole, stepById: Object.fromEntries(lesson.steps.map(s => [s.id, s])) };
}

async function driveLesson(p, man, { code, stopWhen, hook } = {}) {
  let lastKey = '';
  for (let guard = 0; guard < 900; guard++) {
    const st = await waitState(p, () => true);
    if (st.done) return st;
    if (stopWhen && stopWhen(st)) return st;
    const key = st.step + '|' + st.phase + '|' + st.entry;
    if (key !== lastKey) {
      lastKey = key;
      await domCheck(p, (man.lesson.id) + ':' + key);
      if (hook) await hook(st, p);
      if (stopWhen && stopWhen(await state(p))) return state(p);
    }
    const step = man.stepById[st.step];

    if (st.entry) {
      if (step && step.gate && step.gate.kind === 'code') {
        if (await p.$('#gate_code')) {
          await p.fill('#gate_code', code || '');
          await clickIf(p, '#btn_gate');
        }
      } else if (step && step.gate) await clickIf(p, '#btn_gate');
      await new Promise(r => setTimeout(r, 150));
      continue;
    }
    if (!step) { await new Promise(r => setTimeout(r, 150)); continue; }

    if (step.type === 'cards_quiz') {
      const card = (step.cards || []).find(c => 'card_' + c.id === st.phase);
      if (card && card.multi) {
        if (await p.$('#btn_next')) { await clickIf(p, '#btn_next'); }     // экран reveal_text после коммита
        else {
          const onCells = await p.evaluate(() => [...document.querySelectorAll('.capcell.on')].length);
          if (onCells < card.correct.length) await clickIf(p, '#cell' + card.correct[onCells]);
          else await clickIf(p, '#btn_commit');
        }
      } else if (card) await clickIf(p, '#quizopt' + card.correct);
      await new Promise(r => setTimeout(r, 120));
      continue;
    }

    if (step.type === 'talk_chat') {
      if (await clickIf(p, '#btn_next')) continue;
      if (await clickIf(p, '#btn_think')) { continue; }
      if (await p.$('#chat_input')) {
        await p.fill('#chat_input', 'она не думает — она сравнивает картинки');
        await clickIf(p, '#btn_chat_send');
        await p.waitForSelector('#btn_next', { timeout: 10000 });
      }
      await new Promise(r => setTimeout(r, 200));
      continue;
    }

    if (step.type === 'final_card') {
      if (st.phase === 'best_trap') { if (!await clickIf(p, '#btn_pick')) await clickIf(p, '#btn_next'); }
      else await clickIf(p, '#btn_next');
      await new Promise(r => setTimeout(r, 150));
      continue;
    }

    // trainer_act — по элементам такта
    const phase = (step.phases || []).find(ph => ph.id === st.phase);
    if (!phase) { await new Promise(r => setTimeout(r, 150)); continue; }
    const els = phase.elements || [];

    if (els.some(e => e.startsWith('basket_'))) {
      // порядок подачи перемешан per-seat — текущую картинку читаем из DOM, не по индексу банка
      const imgId = await p.$eval('#img_current', el => el.dataset.img).catch(() => null);
      const img = imgId && (man.byRole.train_core || []).find(i => i.id === imgId);
      if (img) {
        await clickIf(p, '#basket_' + img.class);
      } else await clickIf(p, '#btn_next');
    } else if (els.includes('btn_pick')) {
      if (!await clickIf(p, '#btn_pick')) await clickIf(p, '#btn_next');
    } else if (els.includes('btn_train')) {
      await clickIf(p, '#btn_train');
      await waitState(p, s2 => s2.phase !== st.phase, 15000, 'после train');
    } else if (phase.probe_set) {
      if (!await clickIf(p, '#btn_check')) await clickIf(p, '#btn_next');
    } else if (els.some(e => /^frag[1-9]$/.test(e))) {
      await clickIf(p, '#frag1');
      await waitState(p, s2 => s2.phase !== st.phase, 10000, 'после frag');
    } else if (els.includes('free_text')) {
      await p.fill('#free_text', 'смотрит не на того, на кого надо');
      await clickIf(p, '#btn_skip');
    } else if (els.includes('btn_commit')) {
      await clickIf(p, '#btn_commit');
      await waitState(p, s2 => s2.phase !== st.phase, 15000, 'ack коммита');
    } else if (els.some(e => /^opt[1-9]$/.test(e))) {
      // какой это opt-такт по порядку: choice → predict → reason (как в walk.js)
      const optPhases = step.phases.filter(ph => (ph.elements || []).some(e => /^opt[1-9]$/.test(e)));
      const lists = [];
      if (step.version) lists.push(step.version.choice.correct);
      if (step.forecast) lists.push(step.forecast.expected.predict, step.forecast.expected.reason);
      const idx = optPhases.findIndex(ph => ph.id === st.phase);
      await clickIf(p, '#opt' + (lists[idx] + 1));
      await waitState(p, s2 => s2.phase !== st.phase, 15000, 'после opt');
    } else if (!els.length) {
      // ожидание reveal — двигает внешний актор (второй клиент + дашборд)
      await new Promise(r => setTimeout(r, 300));
    } else if (els.includes('btn_check')) {
      if (!await clickIf(p, '#btn_check')) await clickIf(p, '#btn_next');
    } else if (els.includes('btn_next')) {
      await clickIf(p, '#btn_next');
    }
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error('driveLesson: не дошли до done за лимит шагов; застряли на ' + lastKey);
}

/* ---------- F5-проверка: reload → restore ≤3 c до интерактивного экрана ---------- */
async function f5restore(p, name, interactiveSel, { maxMs = 3000 } = {}) {
  const t0 = Date.now();
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return el && !el.disabled && el.getClientRects().length > 0;
  }, interactiveSel, { timeout: 15000 });
  const dt = Date.now() - t0;
  ok(`F5 ${name}: restore ≤3 c (${dt} мс)`, dt <= maxMs, String(dt));
}

/* ================================================================== */
/* RUN 1: полный проход z1-kot, reveal-lock на двух клиентах, F5×3     */
/* ================================================================== */
const man = loadManifestNode('z1-kot');
const dash = await browser.newPage();
await dash.goto(BASE + '/dash');
await dash.click('button:has-text("Запустить занятие")');
await dash.waitForLoadState('networkidle');
ok('дашборд: занятие запущено (панель показывает run)', (await dash.content()).includes('Занятие: z1-kot'));

// код гейта s1 с дашборда
const gateStepId = man.lesson.steps.find(s => s.type === 'gate' && s.gate.kind === 'code').id;
await dash.fill('#gcode_' + gateStepId, '4712');
await dash.click(`button:has-text("задать")`);
await dash.waitForLoadState('networkidle');
await host('/host/gate', { action: 'step', step: gateStepId });

const A = await mkChild(1);
const B = await mkChild(2);

// --- гейт: неверный код не пропускает ---
await waitState(A, s => s.entry, 15000, 'гейт A');
await domCheck(A, 'z1-kot:gate-entry');
await A.fill('#gate_code', '9999');
await A.click('#btn_gate');
await A.waitForSelector('.gate-error', { timeout: 10000 });
ok('гейт: неверный код — одна фраза, не пропускает', (await state(A)).entry);
// B проходит гейт сразу (попадает в состав N reveal-lock) и паркуется на квизе
await waitState(B, s => s.entry, 15000, 'гейт B');
await B.fill('#gate_code', '4712');
await B.click('#btn_gate');
await waitState(B, s => !s.entry, 15000, 'B прошёл гейт');
// дашборд: «N из … перешли»
await dash.reload();
ok('дашборд: гейт показывает 1 из 2 перешли', (await dash.content()).includes('1 из 2'));

// --- A: полный tap-проход с брейками ---
let f5basketsDone = false, f5commitDone = false, f5measureDone = false, bufferChecked = false;
let overlayEmptyOnTask = null;

const versionStep = man.lesson.steps.find(s => s.version);
await driveLesson(A, man, {
  code: '4712',
  hook: async (st, p) => {
    // F5-точка 1: посреди раскладки корзин (3 разложено)
    if (!f5basketsDone && !st.entry && man.stepById[st.step] &&
        (man.stepById[st.step].phases || []).some(ph => ph.id === st.phase && (ph.elements || []).some(e => e.startsWith('basket_')))) {
      f5basketsDone = true;
      for (let i = 0; i < 3; i++) {
        const img = man.byRole.train_core[i];
        await p.click('#basket_' + img.class);
        await new Promise(r => setTimeout(r, 80));
      }
      // проверка «буфер не поверх активного такта»
      overlayEmptyOnTask = await p.evaluate(() => document.getElementById('overlaybar').classList.contains('empty'));
      // undo не наказуем: вернуть → переразложить
      await p.click('#btn_undo');
      await p.click('#basket_' + man.byRole.train_core[2].class);
      await f5restore(p, 'посреди раскладки', '.basket');
      const counts = await p.evaluate(() =>
        [...document.querySelectorAll('.basket-count')].reduce((s, e) => s + (+e.textContent || 0), 0));
      ok('F5 раскладка: 3 разложенные картинки целы (дебаунс-сейв + журнал)', counts === 3, 'counts=' + counts);
      const fc = await p.$eval('.feedcount', e => e.textContent);
      ok('F5 раскладка: лента продолжает с 4-й картинки', /4 из/.test(fc), fc);
    }
    // «застрял» → подсказки l1/l2 (события hint в телеметрию)
    if (st.phase && !p.__stuckDone && st.step === versionStep.id) {
      p.__stuckDone = true;
      await p.click('#stuck');
      await p.waitForSelector('.modalcard');
      await domCheck(p, 'z1-kot:hint-modal');
      if (await clickIf(p, 'button:has-text("Ещё подсказку")')) {
        await p.waitForSelector('.modalcard');
        await clickIf(p, 'button:has-text("Понял!")');
      } else await clickIf(p, 'button:has-text("Понял!")');
    }
  },
  stopWhen: (st) => !st.entry && st.step === versionStep.id && st.phase &&
    (versionStep.phases.find(ph => ph.id === st.phase) || {}).elements?.length === 0,
});
ok('A дошёл до ожидания reveal (оба коммита отправлены)', true);

// F5-точка 2: «коммит есть, reveal не наступил» — не перепоказывать версию
await f5restore(A, '«коммит есть, reveal нет»', '#stuck');
{
  const st = await state(A);
  const waitingPhase = versionStep.phases.find(ph => (ph.elements || []).length === 0);
  ok('F5 после коммита: снова ожидание, ввод версии НЕ перепоказан',
     st.step === versionStep.id && st.phase === waitingPhase.id, JSON.stringify(st));
  const bufferSeen = await A.waitForSelector('.buffer', { timeout: 8000 }).then(() => true).catch(() => false);
  ok('ожидание — не пустой экран: буфер «предскажи» виден', bufferSeen);
  await domCheck(A, 'z1-kot:waiting-buffer');
  if (bufferSeen && !bufferChecked) {
    bufferChecked = true;
    const cls = man.byRole.buffer[0].class;
    const lbl = man.bank.classes.find(c => c.id === cls).label;
    await clickIf(A, `.buffer button:has-text("${lbl}")`);
  }
}

// --- reveal-lock: дашборд показывает 🔒 1/2, «Раскрыть» неактивна ---
await dash.reload();
let html = await dash.content();
ok('дашборд: reveal-lock 🔒 1/2 (готов только A)', html.includes('1/2'), html.match(/🔒[^<]*/)?.[0] || '');
ok('дашборд: «Раскрыть» неактивна до N/N', /<button[^>]*disabled[^>]*>🔓 Раскрыть<\/button>/.test(html));

// --- B докоммичивает → 2/2 → ведущий раскрывает ---
await driveLesson(B, man, {
  code: '4712',
  stopWhen: (st) => !st.entry && st.step === versionStep.id &&
    (versionStep.phases.find(ph => ph.id === st.phase) || {}).elements?.length === 0,
});
await dash.reload();
html = await dash.content();
ok('дашборд: reveal-lock 🔒 2/2 после коммитов B', html.includes('2/2'));
ok('дашборд: версии видны текстом (без «верно/неверно»)', html.includes('✓ версия'));
await dash.click('button:has-text("🔓 Раскрыть")');
await dash.waitForLoadState('networkidle');
await dash.reload();
ok('дашборд: разгадка открыта', (await dash.content()).includes('разгадка ОТКРЫТА'));

// --- A и B получают reveal поллингом (≤5 c, в демо 1.5 c) ---
const lastPhase = versionStep.phases[versionStep.phases.length - 1].id;
await waitState(A, s => s.phase === lastPhase, 12000, 'reveal у A');
ok('A: reveal открыт поллингом, ожидание сменилось разгадкой', true);
const anonN = await A.evaluate(() => document.querySelectorAll('.anonitem').length);
ok('A: анонимная подборка версий группы видна (≥2)', anonN >= 2, 'anon=' + anonN);
await domCheck(A, 'z1-kot:reveal');
await waitState(B, s => s.phase === lastPhase, 12000, 'reveal у B');

// --- A: продолжение до конца занятия, F5-точка 3 после R2 внутри hook ---
await driveLesson(A, man, {
  code: '4712',
  hook: async (st, p) => {
    const step = man.stepById[st.step];
    if (!f5measureDone && step && step.measure && !st.entry &&
        (step.phases.find(ph => ph.id === st.phase) || {}).elements?.includes('btn_check') &&
        !(step.phases.find(ph => ph.id === st.phase) || {}).probe_set &&
        !(step.phases.find(ph => ph.id === st.phase) || {}).elements?.includes('btn_next')) {
      // это такт замера: прогоняем R2 и делаем F5
      f5measureDone = true;
      await p.click('#btn_check');
      await p.waitForSelector('.score-big', { timeout: 10000 });
      const before = await p.evaluate(() => [...document.querySelectorAll('.score-big')].map(e => e.textContent));
      await f5restore(p, 'после замера R2', '#btn_check');
      await p.waitForSelector('.score-big', { timeout: 5000 });
      const after = await p.evaluate(() => [...document.querySelectorAll('.score-big')].map(e => e.textContent));
      ok('F5 после R2: счёт восстановлен без перегона замера', JSON.stringify(before) === JSON.stringify(after),
         JSON.stringify({ before, after }));
    }
  },
});
ok('A: занятие пройдено целиком до «Дело закрыто»', (await state(A)).done);
ok('оверлеи: на активном такте раскладки буфер НЕ висел', overlayEmptyOnTask === true);

// --- телеметрия: связки в JSONL реального прогона (DoD п.6) ---
await A.evaluate(() => new Promise(r => setTimeout(r, 800)));   // добежали дампы
const jsonl = readdirSync(dataDir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
  .flatMap(f => readFileSync(path.join(dataDir, f), 'utf-8').trim().split('\n'))
  .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
const evTypes = new Set(jsonl.flatMap(r => (r.data.events || []).map(e => e.type)));
for (const t of ['gate_enter', 'quiz_click', 'basket_undo', 'trained', 'probe', 'version_committed',
                 'version_choice', 'reveal_seen', 'captcha_commit', 'trap_added', 'retrained',
                 'measure', 'forecast_committed', 'forecast_result', 'hint', 'stuck_pressed',
                 'buffer_forecast', 'chat_msg', 'card_opened', 'best_trap_marked', 'artifact_saved'])
  ok('телеметрия: событие ' + t + ' в JSONL', evTypes.has(t));
const gateEvents = jsonl.flatMap(r => (r.data.events || []).filter(e => e.type === 'gate_enter'));
ok('телеметрия: gate_enter с ok:false (неверный код)', gateEvents.some(e => e.ok === false));
const hintEvents = jsonl.flatMap(r => (r.data.events || []).filter(e => e.type === 'hint'));
ok('телеметрия: hint с уровнями (1 и 2)', hintEvents.some(e => e.level === 1) && hintEvents.some(e => e.level === 2));

// --- дашборд: замеры и прогресс живьём (DoD п.5) ---
await dash.reload();
html = await dash.content();
ok('дашборд: замер R1→R2 в таблице', /0\/4 → [34]\/4/.test(html), html.match(/[0-9]\/4 → [0-9]\/4/)?.[0] || 'нет');
ok('дашборд: уровень помощи виден', html.includes('ур.2'));

await A.close(); await B.close();

/* ================================================================== */
/* RUN 2: override — «раскрыть без отвалившегося» с подтверждением и логом */
/* ================================================================== */
await dash.reload();
dash.once('dialog', d => d.accept());          // confirm «Новый запуск?»
await dash.click('button:has-text("▶ Запустить заново")');
await dash.waitForLoadState('networkidle');
await host('/host/gate', { action: 'code', step: gateStepId, code: '4712', show: true });

const A2 = await mkChild(1);
const B2 = await mkChild(2);
// оба проходят гейт (оба в составе N), но B2 замирает сразу после
for (const [pg, nm] of [[A2, 'A2'], [B2, 'B2']]) {
  await waitState(pg, s => s.entry, 15000, 'гейт ' + nm);
  await pg.fill('#gate_code', '4712');
  await pg.click('#btn_gate');
  await waitState(pg, s => !s.entry, 15000, nm + ' прошёл гейт');
}
await B2.close();                              // клиент «умер» → на дашборде «нет связи»
await driveLesson(A2, man, {
  code: '4712',
  stopWhen: (st) => !st.entry && st.step === versionStep.id &&
    (versionStep.phases.find(ph => ph.id === st.phase) || {}).elements?.length === 0,
});
await new Promise(r => setTimeout(r, 65000 / 60));             // короткая пауза на сейвы
await dash.reload();
html = await dash.content();
ok('run2: reveal-lock 🔒 1/2, «Раскрыть» заперта', html.includes('1/2') &&
   /<button[^>]*disabled[^>]*>🔓 Раскрыть<\/button>/.test(html));
ok('run2: кнопка «Раскрыть без отвалившегося» доступна', html.includes('Раскрыть без отвалившегося'));
dash.once('dialog', d => d.accept());          // подтверждение override
await dash.click('button:has-text("Раскрыть без отвалившегося")');
await dash.waitForLoadState('networkidle');
await dash.reload();
html = await dash.content();
ok('run2: override открыл разгадку', html.includes('разгадка ОТКРЫТА'));
ok('run2: override в логе действий ведущего', html.includes('override'));
await waitState(A2, s => s.phase === lastPhase, 12000, 'reveal у A2 после override');
ok('run2: A2 получил разгадку после override', true);
await A2.close();

/* ================================================================== */
/* RUN 3: дифф тест-манифеста — полный проход ТЕМ ЖЕ кодом (DoD п.2)   */
/* ================================================================== */
const man2 = loadManifestNode('_test-variant');
await dash.reload();
dash.once('dialog', d => d.accept());
await dash.fill('#zlesson', '_test-variant');
await dash.click('button:has-text("▶ Запустить заново")');
await dash.waitForLoadState('networkidle');
const gate2 = man2.lesson.steps.find(s => s.type === 'gate' && s.gate.kind === 'code').id;
await host('/host/gate', { action: 'code', step: gate2, code: '7', show: true });

const V1 = await mkChild(1, '_test-variant');
const V2 = await mkChild(2, '_test-variant');
const vStep = man2.lesson.steps.find(s => s.version);
const vWaiting = vStep.phases.find(ph => (ph.elements || []).length === 0).id;
const vLast = vStep.phases[vStep.phases.length - 1].id;
const toWaiting = { code: '7', stopWhen: (st) => !st.entry && st.step === vStep.id && st.phase === vWaiting };
await driveLesson(V1, man2, toWaiting);
await driveLesson(V2, man2, toWaiting);
await dash.reload();
await dash.click('button:has-text("🔓 Раскрыть")');
await dash.waitForLoadState('networkidle');
await waitState(V1, s => s.phase === vLast, 12000, 'reveal V1');
await driveLesson(V1, man2, { code: '7' });
ok('тест-вариант: полный проход ТЕМ ЖЕ кодом до done (критерий фазы 0)', (await state(V1)).done);
await V1.close(); await V2.close();

/* ---------- смоук широкого окна: ветка zoom ≥1400px (клики + настоящий drag) ---------- */
{
  const firstGate = man.lesson.steps.find(s => s.type === 'gate' && s.gate.kind === 'code').id;
  await host('/host/gate', { action: 'code', step: firstGate, code: '4712', show: true });
  const c = await browser.newContext({ viewport: { width: 1512, height: 950 } });
  const W = await c.newPage();
  W.setDefaultTimeout(30000);
  await W.goto(`${BASE}/z1.html?ws=1&demo=1&seat=9`);
  const zoomVal = await W.evaluate(() => getComputedStyle(document.body).zoom);
  ok('широкий экран: zoom-ветка активна (' + zoomVal + ')', parseFloat(zoomVal) === 1.5);
  const trainer = man.lesson.steps.find(s => s.type === 'trainer_act').id;
  await driveLesson(W, man, { code: '4712',
    stopWhen: (st) => st.step === trainer && st.phase === 'baskets' && !st.entry });
  const target = await W.evaluate(() => {
    const img = document.querySelector('#img_current');
    return img ? 'basket_cat' : null;
  });
  ok('широкий экран: гейт и квиз пройдены кликами до раскладки', !!target);
  const countBefore = await W.evaluate(() =>
    parseInt(document.querySelector('#basket_cat .basket-count')?.textContent || '0', 10) || 0);
  await W.dragAndDrop('#img_current', '#basket_cat');
  const countAfter = await W.evaluate(() =>
    parseInt(document.querySelector('#basket_cat .basket-count')?.textContent || '0', 10) || 0);
  ok('широкий экран: настоящий drag в корзину при zoom работает (счёт ' +
     countBefore + '→' + countAfter + ')', countAfter === countBefore + 1);
  await W.close(); await c.close();
}

/* ---------- DOM-чек: свод ---------- */
let domFails = 0;
for (const [tag, list] of domViolations) {
  for (const v of list) { log.push('FAIL DOM ' + tag + ': ' + v); domFails += 1; fails += 1; }
}
ok('DOM-чеки конституции: экранов проверено ' + domViolations.size + ', нарушений ' + domFails, domFails === 0);

/* ---------- финал ---------- */
console.log(log.join('\n'));
console.log(`\n${log.filter(l => l.startsWith('PASS')).length} PASS · ${fails} FAIL`);
await browser.close();
server.kill();
process.exit(fails ? 1 : 0);
