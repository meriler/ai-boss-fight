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
  // рендер (поллинг/авто-замер) может заменить узел между захватом и кликом — перезахват до 3 раз
  for (let attempt = 0; attempt < 3; attempt++) {
    const target = attempt === 0 ? el : await p.$(sel);
    if (!target) return false;
    try { await target.click({ timeout: 5000 }); return true; }
    catch (e) {
      if (attempt === 2) throw new Error('clickIf(' + sel + '): ' + e.message.split('\n')[0]);
      await new Promise(r => setTimeout(r, 200));
    }
  }
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

    if (step.type === 'slide') {                       // слайд «для поговорить» (фаза 0.5)
      await clickIf(p, '#btn_next');
      await new Promise(r => setTimeout(r, 150));
      continue;
    }

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
      // на показанном вердикте — отметка «она ошиблась!» (наблюдение ребёнка, п.4 плана),
      // потом «Дальше»; кнопка есть только при вердикте, clickIf безопасен
      if (!await clickIf(p, '#btn_check')) {
        await clickIf(p, '#btn_mistake');
        await clickIf(p, '#btn_next');
      }
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
let overlayEmptyOnTask = null, relayoutDone = false;

const versionStep = man.lesson.steps.find(s => s.version);
await driveLesson(A, man, {
  code: '4712',
  hook: async (st, p) => {
    // «Разложить заново» (В-3): двухтактно — кнопка → крупное подтверждение; «Назад»
    // ничего не сбрасывает (конституция п.7). Доступна только до первого обучения
    if (!relayoutDone && !st.entry && st.step === versionStep.id && st.phase === 'train') {
      relayoutDone = true;
      const before = await p.evaluate(() =>
        [...document.querySelectorAll('.basket-count')].reduce((s, e) => s + (+e.textContent || 0), 0));
      await p.click('#btn_relayout');
      await p.waitForSelector('#btn_cancel_confirm', { timeout: 8000 });
      await p.click('#btn_cancel_confirm');
      const afterCancel = await p.evaluate(() =>
        [...document.querySelectorAll('.basket-count')].reduce((s, e) => s + (+e.textContent || 0), 0));
      ok('В-3 двухтактность: «Назад» не сбрасывает раскладку', afterCancel === before,
         before + '→' + afterCancel);
      await p.click('#btn_relayout');
      await p.waitForSelector('#btn_confirm_relayout', { timeout: 8000 });
      await p.click('#btn_confirm_relayout');
      await waitState(p, s2 => s2.phase === 'baskets', 8000, 'relayout → корзины');
      const counts = await p.evaluate(() =>
        [...document.querySelectorAll('.basket-count')].reduce((s, e) => s + (+e.textContent || 0), 0));
      ok('«Разложить заново»: корзины пусты, лента с 1-й картинки', counts === 0, 'counts=' + counts);
      // дальше generic-драйвер раскладывает заново и снова доходит до «Научить»
    }
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
  // «зачем»-строка при первой встрече (аудит линзы): куда попадёт результат
  const bufTxt = await A.evaluate(() => document.querySelector('.buffer')?.textContent || '');
  ok('линза: «зачем»-строка при первой встрече буфера', /Пока ждём: предскажи/.test(bufTxt),
     bufTxt.slice(0, 80));
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

/* --- A: «проверить другую раскладку» (фаза 0.5) — эксперимент после reveal,
 *     F5 МЕЖДУ версиями состава (v1 заморожена, v2 ещё нет), возврат к разгадке --- */
{
  /* В-1: полка версий на «спокойном» экране разгадки — один тапабельный блок,
   * карточка версии в модалке (состав словами, легенда, одна кнопка «Назад») */
  ok('В-1: полка версий видна на разгадке', !!(await A.$('#version_shelf')));
  const chipTxt = await A.evaluate(() => [...document.querySelectorAll('.vchip')].map(e => e.textContent).join(' | '));
  ok('В-1: чип v1 с числом картинок, активный подсвечен', /v1 · 16/.test(chipTxt), chipTxt);
  await A.click('#version_shelf');
  await A.waitForSelector('.modalcard', { timeout: 8000 });
  await domCheck(A, 'z1-kot:version-card');
  const cardTxt = await A.evaluate(() => document.querySelector('.modalcard').textContent);
  ok('В-1 карточка версии: v1 активная, состав словами, легенда полки',
     /Версия v1 — активная/.test(cardTxt) && /Коты: 8/.test(cardTxt) && /новая версия/.test(cardTxt),
     cardTxt.slice(0, 120));
  await A.screenshot({ path: '/tmp/z1-version-card.png' });   // ревью интерфейса В-1
  await A.click('#vcard_back');
  await A.waitForSelector('.modalcard', { state: 'detached', timeout: 8000 }).catch(() => {});
  /* В-4 двухтактность: «Проверить другую раскладку» — кнопка → подтверждение
   * с оговоркой «версии на полке сохранятся»; «Назад» ничего не сбрасывает */
  await A.click('#btn_experiment');
  await A.waitForSelector('#btn_cancel_confirm', { timeout: 8000 });
  const confirmTxt = await A.evaluate(() => document.querySelector('.modalcard').textContent);
  ok('В-4 подтверждение: «начнутся заново — точно?» + «версии на полке сохранятся»',
     /заново — точно\?/.test(confirmTxt) && /Версии на полке сохранятся/.test(confirmTxt), confirmTxt);
  await A.click('#btn_cancel_confirm');
  ok('В-4 двухтактность: «Назад» оставил разгадку на месте', (await state(A)).phase === lastPhase);
  await A.click('#btn_experiment');
  await A.waitForSelector('#btn_confirm_experiment', { timeout: 8000 });
  await A.click('#btn_confirm_experiment');
  await waitState(A, s => s.step === versionStep.id && s.phase === 'baskets', 8000, 'эксперимент → корзины');
  let counts = await A.evaluate(() =>
    [...document.querySelectorAll('.basket-count')].reduce((s, e) => s + (+e.textContent || 0), 0));
  ok('эксперимент: раскладка с нуля (замок открыт, version/choice не трогаются)', counts === 0);
  /* В-2 «черновик ≠ учёное»: корзины сброшены, коробка думает по v1 — полка в зоне
   * коробки пассивна (0 из лимита) и несёт бейдж */
  const badge = await A.evaluate(() => document.querySelector('.vshelf-badge')?.textContent || '');
  ok('В-2: бейдж «в корзинах уже по-другому» при расхождении с активной версией',
     /по-другому/.test(badge), badge);
  ok('В-2/В-1: полка на активном такте пассивна (не тапается)', !(await A.$('#version_shelf')));
  // разложить 5 картинок и F5: позиция и модель v1 должны пережить перезагрузку
  for (let i = 0; i < 5; i++) {
    const imgId = await A.$eval('#img_current', el => el.dataset.img);
    const img = man.byRole.train_core.find(x => x.id === imgId);
    await A.click('#basket_' + img.class);
    await new Promise(r => setTimeout(r, 60));
  }
  await f5restore(A, 'между версиями (эксперимент)', '.basket');
  const st = await state(A);
  ok('F5 в эксперименте: вернулись в корзины, вперёд не клампит (acked-коммиты есть, но эксперимент законен)',
     st.step === versionStep.id && st.phase === 'baskets', JSON.stringify(st));
  counts = await A.evaluate(() =>
    [...document.querySelectorAll('.basket-count')].reduce((s, e) => s + (+e.textContent || 0), 0));
  ok('F5 в эксперименте: 5 разложенных целы', counts === 5, 'counts=' + counts);
  const known = await A.evaluate(() => document.querySelector('.zone-box .kidtext')?.textContent || '');
  ok('F5 в эксперименте: модель осталась версии v1 (знает 16 картинок)', /16/.test(known), known);
  // доразложить, «Научить» (v2), прогнать пробы заново, вернуться к разгадке
  for (let guard = 0; guard < 40; guard++) {
    const cur = await A.$eval('#img_current', el => el.dataset.img).catch(() => null);
    if (!cur) break;
    const img = man.byRole.train_core.find(x => x.id === cur);
    await A.click('#basket_' + img.class);
    await new Promise(r => setTimeout(r, 60));
  }
  await clickIf(A, '#btn_next');
  await waitState(A, s => s.phase === 'train', 8000, 'эксперимент → научить');
  await A.click('#btn_train');
  await waitState(A, s => s.phase === 'probe', 10000, 'эксперимент → пробы');
  let alertSeen = false;   // акцент на ошибке пробы (аудит линзы): «Стоп… она уверена — и ошибается!»
  for (let i = 0; i < 4; i++) {
    await clickIf(A, '#btn_check');
    await A.waitForSelector('.verdict', { timeout: 8000 });
    if (await A.$('.verdict-alert')) alertSeen = true;
    await clickIf(A, '#btn_next');
    await new Promise(r => setTimeout(r, 120));
  }
  ok('линза: акцент-текст на неверном вердикте пробы (драматургия без голоса)', alertSeen);
  await clickIf(A, '#btn_next');   // «все проверки пройдены» → возврат к разгадке
  await waitState(A, s => s.phase === lastPhase, 8000, 'эксперимент → назад к разгадке');
  ok('эксперимент: после проб вернулись к разгадке (такты версии не перепоказаны)', true);
  // версия состава — в серверном снапшоте seat-save (журнал localStorage подрезается после /save)
  await new Promise(r => setTimeout(r, 700));
  const snap1 = readdirSync(dataDir).filter(f => /^lesson-save-.*-seat1\.json$/.test(f))
    .map(f => JSON.parse(readFileSync(path.join(dataDir, f), 'utf-8'))).pop();
  const mdl = snap1 && snap1.payload && snap1.payload.model;
  ok('эксперимент: «Научить» дал версию состава v2 (payload.model в снапшоте)',
     !!mdl && mdl.version === 2 && (snap1.payload.model_history || []).length === 2,
     JSON.stringify(mdl && { v: mdl.version, hist: (snap1.payload.model_history || []).length }));
}

// --- A: продолжение до конца занятия, F5-точка 3 после R2 внутри hook ---
// счёт замера живёт и в growth-рядах (В-5), и в scoreCard (fallback) — читаем оба вида
const scoresOf = (p) => p.evaluate(() =>
  [...document.querySelectorAll('.growthcap-score, .score-big')].map(e => e.textContent));
let chatPreviewSeen = false, shelfOnCard = false, growthSeenA = false;
await driveLesson(A, man, {
  code: '4712',
  hook: async (st, p) => {
    const step = man.stepById[st.step];
    // линза П5: панель чата видна заранее в неактивном виде (до think-таймера)
    if (!chatPreviewSeen && step && step.type === 'talk_chat' && !st.entry)
      chatPreviewSeen = !!(await p.$('.chatpanel-preview'));
    // В-1: полка версий на card_view («спокойный» экран) — тапабельна
    if (!shelfOnCard && step && step.type === 'final_card' && st.phase === 'card_view')
      shelfOnCard = !!(await p.$('#version_shelf'));
    if (!f5measureDone && step && step.measure && !st.entry &&
        (step.phases.find(ph => ph.id === st.phase) || {}).elements?.includes('btn_check') &&
        !(step.phases.find(ph => ph.id === st.phase) || {}).probe_set &&
        !(step.phases.find(ph => ph.id === st.phase) || {}).elements?.includes('btn_next')) {
      // это такт замера: прогоняем R2 и делаем F5
      f5measureDone = true;
      await p.click('#btn_check');
      await p.waitForSelector('.growthcap-score, .score-big', { timeout: 10000 });
      growthSeenA = !!(await p.$('.growth'));
      const before = await scoresOf(p);
      await f5restore(p, 'после замера R2', '#btn_check');
      await p.waitForSelector('.growthcap-score, .score-big', { timeout: 5000 });
      const after = await scoresOf(p);
      ok('F5 после R2: счёт восстановлен без перегона замера', JSON.stringify(before) === JSON.stringify(after),
         JSON.stringify({ before, after }));
    }
  },
});
ok('A: занятие пройдено целиком до «Дело закрыто»', (await state(A)).done);
ok('линза: чат-поле показано заранее в неактивном виде (talk_chat)', chatPreviewSeen);
ok('В-1: полка версий тапабельна на card_view', shelfOnCard);
ok('В-5: замер R2 у A — ростом ячейками (два ряда «было/стало»)', growthSeenA);
ok('оверлеи: на активном такте раскладки буфер НЕ висел', overlayEmptyOnTask === true);

/* --- B: настоящий выбор ловушек + цикл добора (фаза 0.5) ---
 * подмножество (2 кота) → «Хватит, проверяем» → слабый замер 2/4 → «Добрать ловушки» →
 * честная инвалидация старого замера после переобучения → добор до 8 → 4/4 */
{
  const fixStep = man.lesson.steps.find(s => s.type === 'trainer_act' && s.mode === 'fix');
  await driveLesson(B, man, {
    code: '4712',
    stopWhen: (st) => !st.entry && st.step === fixStep.id && st.phase === 'traps',
  });
  let cats = 0;
  for (let guard = 0; guard < 40 && cats < 2; guard++) {
    const cur = await B.$eval('#img_current', el => el.dataset.img);
    const img = man.byId[cur];
    if (img.class === 'cat') { await B.click('#btn_pick'); cats += 1; }
    else await B.click('#btn_skip');
    await new Promise(r => setTimeout(r, 80));
  }
  const fc = await B.$eval('.feedcount', e => e.textContent);
  ok('выбор ловушек: подмножество 2 из 8 (пропуски не наказуемы)', /2 из 8/.test(fc), fc);
  await B.click('#btn_next');                                   // «Хватит, проверяем»
  await waitState(B, s => s.phase === 'retrain', 8000, 'B → научить заново');
  await B.click('#btn_train');
  await waitState(B, s => s.phase === 'measure_after', 10000, 'B → замер');
  await clickIf(B, '#btn_check');                               // «Проверить коробку»
  await B.waitForSelector('.growthcap-score, .score-big', { timeout: 8000 });
  let score = (await scoresOf(B)).pop() || '';
  ok('слабый замер на подмножестве: 2 из 4', score.includes('2 из 4'), score);
  const more = await B.$('#btn_more_traps');
  ok('цикл добора: кнопка «Добрать ловушки» при слабом замере', !!more);
  await B.click('#btn_more_traps');
  await waitState(B, s => s.phase === 'traps', 8000, 'B → добор ловушек');
  for (let guard = 0; guard < 20; guard++) {
    if (!await clickIf(B, '#btn_pick')) break;                  // пропущенные вернулись в очередь
    await new Promise(r => setTimeout(r, 80));
  }
  await clickIf(B, '#btn_next');                                // «Дальше» (пул исчерпан)
  await waitState(B, s => s.phase === 'retrain', 8000, 'B → повторное обучение');
  await B.click('#btn_train');
  await waitState(B, s => s.phase === 'measure_after', 10000, 'B → повторный замер');
  const staleNote = await B.evaluate(() => document.body.textContent.includes('Состав обучения менялся'));
  ok('честная инвалидация: старый замер не показан после смены состава', staleNote);
  await clickIf(B, '#btn_check');
  await B.waitForSelector('.growthcap-score, .score-big', { timeout: 8000 });
  score = (await scoresOf(B)).pop() || '';
  ok('добор починил коробку: 4 из 4', score.includes('4 из 4'), score);
  ok('после сильного замера кнопки добора нет', !(await B.$('#btn_more_traps')));
  // В-5: рост ячейками — два ряда одних holdout-миниатюр, стрелки на изменившихся,
  // счёт — подписью (число не заголовком: .score-big в growth-режиме отсутствует)
  const growth = await B.evaluate(() => ({
    rows: document.querySelectorAll('.growthrow').length,
    arrows: document.querySelectorAll('.growtharrow.on').length,
    cells: document.querySelectorAll('.gcell').length,
    bigNum: document.querySelectorAll('.score-big').length,
  }));
  await B.screenshot({ path: '/tmp/z1-growth.png' });   // ревью интерфейса В-5
  ok('В-5: два ряда ячеек (было/стало) по 4 holdout-миниатюры',
     growth.rows === 2 && growth.cells === 8, JSON.stringify(growth));
  ok('В-5: стрелки на изменившихся ячейках есть', growth.arrows >= 1, JSON.stringify(growth));
  ok('В-5: счёт — подписью, не крупным числом (П4)', growth.bigNum === 0, JSON.stringify(growth));
  await driveLesson(B, man, { code: '4712' });                  // добить занятие до конца
  ok('B: занятие пройдено до конца после цикла добора', (await state(B)).done);
}

// --- телеметрия: связки в JSONL реального прогона (DoD п.6) ---
await A.evaluate(() => new Promise(r => setTimeout(r, 800)));   // добежали дампы
const jsonl = readdirSync(dataDir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
  .flatMap(f => readFileSync(path.join(dataDir, f), 'utf-8').trim().split('\n'))
  .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
const evTypes = new Set(jsonl.flatMap(r => (r.data.events || []).map(e => e.type)));
for (const t of ['gate_enter', 'quiz_click', 'basket_undo', 'trained', 'probe', 'mistake_marked',
                 'version_committed',
                 'version_choice', 'reveal_seen', 'captcha_commit', 'trap_added', 'retrained',
                 'measure', 'forecast_committed', 'forecast_result', 'hint', 'stuck_pressed',
                 'buffer_forecast', 'chat_msg', 'card_opened', 'best_trap_marked', 'artifact_saved',
                 'baskets_cleared', 'experiment_start', 'trap_skipped', 'traps_done', 'traps_more'])
  ok('телеметрия: событие ' + t + ' в JSONL', evTypes.has(t));
const measureEvents = jsonl.flatMap(r => (r.data.events || []).filter(e => e.type === 'measure'));
ok('телеметрия: замер несёт версию состава (model_sig)', measureEvents.some(e => e.model_sig));
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
