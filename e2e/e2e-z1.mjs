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
// крэш посреди матрицы не должен глотать накопленный лог — печатаем всё и падаем
for (const sig of ['uncaughtException', 'unhandledRejection'])
  process.on(sig, (e) => {
    console.log(log.join('\n'));
    console.error('\nCRASH (' + sig + '):', e && e.stack || e);
    process.exit(1);
  });

/* ---------- сервер ---------- */
const dataDir = mkdtempSync(path.join(tmpdir(), 'z1e2e-'));
writeFileSync(path.join(dataDir, 'seats.json'), JSON.stringify({ 1: 'Тест-А', 2: 'Тест-Б' }));
const server = spawn('python3', [path.join(ROOT, 'server/tele.py')], {
  // LESSON_DB=1 — SQLite-тень M1 (dual-write): после прогона сверяем тень с файлами
  env: { ...process.env, WS_TELE_DIR: dataDir, WS_TELE_PORT: String(PORT), WS_STATIC_DIR: ROOT, LESSON_DB: '1' },
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
// ENGINE=head node e2e-z1.mjs — та же матрица на другом движке (флаг ?engine=, §2.2);
// без переменной — дефолт занятия (kNN), как у детей
const ENGINE = process.env.ENGINE ? `&engine=${process.env.ENGINE}` : '';
const mkChild = async (seat, variant) => {
  const c = await browser.newContext({ viewport: { width: 640, height: 760 } });   // узкая половина 13"
  const p = await c.newPage();
  p.setDefaultTimeout(30000);
  await p.goto(`${BASE}/z1.html?ws=1&demo=1&seat=${seat}` + (variant ? `&variant=${variant}` : '') + ENGINE);
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

/* ---------- одноразовые проверки И3-Т, живущие в generic-драйвере ---------- */
let trainbarSeen = null;        // была ли полоска эпох при первом «Научить» (head vs kNN)
let probeGateChecked = false;   // «Дальше» заперта до ответа «Коробка права?»
let reactionChecked = null;     // текст микрофидбека «Ведущий увидел 👍»
let entryOverlayLeak = 0;       // оверлеи на экранах входа в шаг (гейтах) — быть не должно

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
    let key = st.step + '|' + st.phase + '|' + st.entry;
    // подсостояния пробы различимы в DOM-чеке (Codex-ревью И3, минор 5): «свежая» /
    // вопрос «Коробка права?» / после ответа — разные наборы интерактивов,
    // каждое проверяется конституцией отдельно
    if (!st.entry) {
      const stepK = man.stepById[st.step];
      const phK = stepK && (stepK.phases || []).find(ph => ph.id === st.phase);
      if (phK && phK.probe_set) {
        key += '|' + await p.evaluate(() =>
          document.getElementById('btn_mistake') ? 'question'
            : (document.querySelector('.verdict') ? 'answered' : 'fresh'));
      }
    }
    if (key !== lastKey) {
      lastKey = key;
      await domCheck(p, (man.lesson.id) + ':' + key);
      if (hook) await hook(st, p);
      if (stopWhen && stopWhen(await state(p))) return state(p);
    }
    const step = man.stepById[st.step];

    if (st.entry) {
      // расписание оверлеев (И3-Т п.5, фидбек #28): на экране входа (гейт/step_enter)
      // полоса оверлеев обязана быть пустой — «Получилось!» с прошлого такта не течёт
      const leak = await p.evaluate(() =>
        !document.getElementById('overlaybar').classList.contains('empty'));
      if (leak) entryOverlayLeak += 1;
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
      const clicked = await clickIf(p, '#btn_train');
      // видимая разница движков (И3-Т): head — ЧЕСТНАЯ полоска эпох (реальный прогресс
      // trainAsync), kNN — мгновенен без неё. В demo эпохи долетают быстрее кадра —
      // факт показа полоски читаем из машинного следа dataset.trainbar, он не гаснет.
      // Фиксируем только по НАСТОЯЩЕМУ клику (после relayout-хука драйвер бывает
      // со stale-фазой — кнопки нет, это не «обучение без полоски»)
      if (clicked && trainbarSeen === null)
        trainbarSeen = await p.evaluate(() =>
          document.getElementById('screen').dataset.trainbar === '1');
      await waitState(p, s2 => s2.phase !== st.phase, 15000, 'после train');
    } else if (phase.probe_set) {
      // обязательный вопрос «Коробка права?» на каждом вердикте (И3-Т п.8): «Дальше»
      // заперта до ответа; драйвер отвечает «Ошиблась!». Подсостояния проходятся
      // РАЗНЫМИ итерациями цикла (вопрос → ответ → дальше) — каждое попадает
      // в DOM-чек своим ключом (Codex-ревью И3, минор 5)
      if (await clickIf(p, '#btn_check')) {
        // вердикт появится — вопрос увидит следующая итерация
      } else if (await p.$('#btn_mistake')) {
        if (!probeGateChecked) {
          probeGateChecked = true;
          const gated = await p.$eval('#btn_next', e => e.disabled).catch(() => true);
          ok('пробы: «Дальше» заперта до ответа «Коробка права?»', gated);
          await p.screenshot({ path: '/tmp/z1-probe-question.png' });   // ревью вопроса
        }
        await clickIf(p, '#btn_mistake');
      } else {
        // микрофидбек «Получилось!» (И3-Т п.5): жмём один раз, читаем отклик
        if (reactionChecked === null && await p.$('#btn_react:not(:disabled)')) {
          await clickIf(p, '#btn_react');
          reactionChecked = await p.waitForSelector('.reaction-note', { timeout: 3000 })
            .then(e => e.textContent()).catch(() => '');
        }
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
let overlayEmptyOnTask = null, relayoutDone = false, backChecked = false;
let quizLockChecked = false, reactHonestDone = false;

const versionStep = man.lesson.steps.find(s => s.version);
await driveLesson(A, man, {
  code: '4712',
  hook: async (st, p) => {
    // отвеченный квиз: варианты гаснут (закалка 18.07, major «кнопки-пустышки») —
    // клик и чтение disabled ОДНИМ evaluate: рендер синхронный, авто-переход не успевает
    if (!quizLockChecked && !st.entry && man.stepById[st.step] &&
        man.stepById[st.step].type === 'cards_quiz') {
      const card = (man.stepById[st.step].cards || []).find(c => 'card_' + c.id === st.phase);
      if (card && !card.multi) {
        quizLockChecked = true;
        const res = await p.evaluate((correct) => {
          document.getElementById('quizopt' + correct).click();
          return [...document.querySelectorAll('[id^=quizopt]')].map(b => b.disabled);
        }, card.correct);
        ok('квиз: после ответа варианты неактивны (разбор, не живые кнопки)',
           res.length > 0 && res.every(Boolean), JSON.stringify(res));
      }
    }
    // честное подтверждение реакции (закалка 18.07, major): /react не долетел —
    // «Ведущий увидел» НЕ показывается, кнопка возвращается
    if (!reactHonestDone && !st.entry && st.step === versionStep.id && st.phase === 'probe'
        && await p.$('#btn_react:not(:disabled)')) {
      reactHonestDone = true;
      await p.route('**/react', r => r.abort());
      await p.click('#btn_react');
      await new Promise(r => setTimeout(r, 900));
      const after = await p.evaluate(() => ({
        note: !!document.querySelector('.reaction-note'),
        btnActive: !!document.querySelector('#btn_react:not(:disabled)'),
      }));
      ok('реакция честная: недоставка — нет «Ведущий увидел», кнопка снова активна',
         !after.note && after.btnActive, JSON.stringify(after));
      await p.unroute('**/react');
    }
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
    // «← Назад» по тактам версии до коммита (И3-Т п.2, фидбек #24): со слота 2
    // возвращаемся на слот 1, потом драйвер своим ходом снова доходит вперёд
    // (слот-такты после хука безопасны: драйвер жмёт clickIf по одинаковым id)
    if (!backChecked && !st.entry && st.step === versionStep.id &&
        (versionStep.phases.find(ph => ph.id === st.phase) || {}).slot > 1) {
      backChecked = true;
      const prevPhase = versionStep.phases[versionStep.phases.findIndex(ph => ph.id === st.phase) - 1].id;
      await p.click('#btn_back');
      await waitState(p, s2 => s2.phase === prevPhase, 8000, '«Назад» к прошлому такту');
      ok('«← Назад»: со слота 2 вернулись на предыдущий такт (до коммита)', true);
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
// И3-Т п.4/п.10: первый показ — иллюстрация крупно, слова разгадки ПЕРЕД картинкой
ok('разгадка: иллюстрация крупно при первом показе', !!(await A.$('.revealcard .imgcard-big')));
await A.screenshot({ path: '/tmp/z1-reveal.png', fullPage: true });   // ревью порядка текстов
{
  const order = await A.evaluate(() => [...document.querySelector('.revealcard').children]
    .map(e => e.className.split(' ')[0]));
  ok('разгадка: текст разгадки идёт до иллюстрации (ревизия #25)',
     order.indexOf('kidtext') > -1 && order.indexOf('kidtext') < order.indexOf('imgcard'),
     order.join(','));
}
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
  const capTxt = await A.evaluate(() => document.querySelector('.vshelf-cap')?.textContent || '');
  ok('И3 п.6: подпись полки «версии коробки:» перед чипами', capTxt.includes('версии коробки'), capTxt);
  /* клавиатура и семантика модалки (закалка 18.07, major): полка отвечает на Enter,
   * карточка версии — настоящий диалог (role=dialog, фокус внутрь, возврат фокуса) */
  await A.focus('#version_shelf');
  await A.keyboard.press('Enter');
  const kbModal = await A.waitForSelector('.modalcard', { timeout: 5000 })
    .then(() => true).catch(() => false);
  ok('клавиатура: Enter на полке версий открывает карточку', kbModal);
  if (kbModal) {
    await new Promise(r => setTimeout(r, 150));   // фокус переводится после вставки
    const dlg = await A.evaluate(() => {
      const m = document.querySelector('.modalcard');
      return { role: m.getAttribute('role'), focusInside: m.contains(document.activeElement) };
    });
    ok('модалка: role=dialog + фокус внутри', dlg.role === 'dialog' && dlg.focusInside,
       JSON.stringify(dlg));
    await A.click('#vcard_back');
    await A.waitForSelector('.modalcard', { state: 'detached', timeout: 5000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 100));
    const backFocus = await A.evaluate(() => document.activeElement && document.activeElement.id);
    ok('модалка: закрытие возвращает фокус на полку', backFocus === 'version_shelf', String(backFocus));
  }
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
  // контраст неактивных зон (закалка 18.07, major): приглушение НЕ opacity на блок,
  // текст держит ≥4.5:1 против фактического фона зоны — считаем в браузере
  {
    const zoneCheck = await A.evaluate(() => {
      const z = document.querySelector('.zone:not(.zone-active)');
      const lum = (r, g, b) => {
        const c = [r, g, b].map(v => v / 255)
          .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      };
      const parse = s => (s.match(/[\d.]+/g) || [255, 255, 255]).map(Number);
      const txt = z.querySelector('.zone-title');
      const l1 = lum(...parse(getComputedStyle(txt).color).slice(0, 3));
      const l2 = lum(...parse(getComputedStyle(z).backgroundColor).slice(0, 3));
      const [hi, lo] = [Math.max(l1, l2), Math.min(l1, l2)];
      return { opacity: getComputedStyle(z).opacity,
               ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 };
    });
    ok('контраст: неактивная зона без opacity-глушения', zoneCheck.opacity === '1',
       JSON.stringify(zoneCheck));
    ok('контраст: текст неактивной зоны ≥4.5:1', zoneCheck.ratio >= 4.5, JSON.stringify(zoneCheck));
  }
  // разложить 5 картинок и F5: позиция и модель v1 должны пережить перезагрузку.
  // Первая — С КЛАВИАТУРЫ (закалка 18.07, major): корзина role=button обязана
  // отвечать на Enter; при провале докладываем кликом, чтобы матрица жила дальше
  {
    const imgId = await A.$eval('#img_current', el => el.dataset.img);
    const img = man.byRole.train_core.find(x => x.id === imgId);
    await A.focus('#basket_' + img.class);
    await A.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 150));
    const c1 = await A.evaluate(() =>
      [...document.querySelectorAll('.basket-count')].reduce((s, e) => s + (+e.textContent || 0), 0));
    ok('клавиатура: Enter на корзине (role=button) кладёт картинку', c1 === 1, 'counts=' + c1);
    if (c1 === 0) await A.click('#basket_' + img.class);
  }
  for (let i = 1; i < 5; i++) {
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
  // И3 п.6: строка при первом появлении v2 — на том же такте, где версия родилась
  const v2note = await A.evaluate(() => document.querySelector('.vshelf-v2note')?.textContent || '');
  ok('И3 п.6: строка при первом v2 «научил заново — старая на полке»', /версия 2/.test(v2note), v2note);
  let alertSeen = false;   // акцент на ошибке пробы (аудит линзы): «Стоп… она уверена — и ошибается!»
  let alertBeforeAnswer = false;
  let dblChecked = false, f5probeChecked = false;
  for (let i = 0; i < 4; i++) {
    await clickIf(A, '#btn_check');
    await A.waitForSelector('.verdict', { timeout: 8000 });
    // обязательный вопрос (И3 п.8): акцент не подсказывает ДО ответа; отвечаем «Права»
    if (await A.$('.verdict-alert')) alertBeforeAnswer = true;
    if (!dblChecked) {
      dblChecked = true;
      // идемпотентность ответа (Codex-ревью И3, минор 2): двойной тап по обеим кнопкам
      // подряд — обе гаснут с первого, записан ПЕРВЫЙ ответ («права»), второй не долетает
      await A.evaluate(() => {
        document.getElementById('btn_right').click();
        const b2 = document.getElementById('btn_mistake');
        if (b2) b2.click();   // после первого тапа disabled/отсоединена — клик глохнет
      });
      const recTxt = await A.evaluate(() => document.body.textContent);
      ok('пробы: двойной тап не перезаписывает ответ (записан первый — «права»)',
         recTxt.includes('Записано: ты считаешь — права'),
         (recTxt.match(/Записано[^!.]*/) || [''])[0]);
    } else await clickIf(A, '#btn_right');
    if (await A.$('.verdict-alert')) alertSeen = true;
    if (!f5probeChecked && i === 1) {
      f5probeChecked = true;
      // F5 между ответом и «Дальше» (Codex-ревью И3, минор 3): подтверждение/разбор
      // не глотаются — после перезагрузки та же проверка с «Записано…», не следующая
      await f5restore(A, 'между ответом и «Дальше» (проба)', '#btn_next');
      const fc = await A.$eval('.feedcount', e => e.textContent).catch(() => '');
      const recap = await A.evaluate(() => document.body.textContent.includes('Записано'));
      ok('F5 между ответом и «Дальше»: разбор пробы не проглочен (та же проверка, «Записано» видно)',
         recap && /2 из/.test(fc), 'recap=' + recap + ' · ' + fc);
    }
    await clickIf(A, '#btn_next');
    await new Promise(r => setTimeout(r, 120));
  }
  ok('внимательность: акцент-текст НЕ виден до ответа «Коробка права?»', !alertBeforeAnswer);
  ok('линза: акцент-текст на неверном вердикте пробы (драматургия без голоса)', alertSeen);
  await clickIf(A, '#btn_next');   // «все проверки пройдены» → возврат к разгадке
  await waitState(A, s => s.phase === lastPhase, 8000, 'эксперимент → назад к разгадке');
  ok('эксперимент: после проб вернулись к разгадке (такты версии не перепоказаны)', true);
  // И3 п.4 (фидбек #27): повторный заход на разгадку — иллюстрация миниатюрой, не дубль
  ok('разгадка повторно: иллюстрация миниатюрой (крупно — один раз)',
     !(await A.$('.revealcard .imgcard-big')) && !!(await A.$('.revealcard .imgcard')));
  /* чат: входящее сообщение НЕ стирает черновик (закалка 18.07, major): chat_delta
   * пересоздаёт панель — недописанный текст и фокус обязаны пережить ререндер */
  {
    await A.click('.chaticon');
    await A.waitForSelector('#chat_input', { timeout: 5000 });
    await A.fill('#chat_input', 'недописанный черновик');
    await B.click('.chaticon');
    await B.waitForSelector('#chat_input', { timeout: 5000 });
    await B.fill('#chat_input', 'сообщение от Б');
    await B.click('#btn_chat_send');
    await A.waitForFunction(() => [...document.querySelectorAll('.chatmsg')]
      .some(m => m.textContent.includes('сообщение от Б')), null, { timeout: 12000 });
    const draft = await A.evaluate(() => ({
      value: (document.getElementById('chat_input') || {}).value || '',
      focused: document.activeElement && document.activeElement.id === 'chat_input',
    }));
    ok('чат: черновик пережил входящее сообщение', draft.value === 'недописанный черновик',
       JSON.stringify(draft));
    ok('чат: фокус в поле ввода сохранён', draft.focused === true, JSON.stringify(draft));
    // свернуть чат у обоих: открытая панель не должна влиять на дальнейшие DOM-чеки
    await A.click('.chaticon');
    await B.click('.chaticon');
  }
  // версия состава — в серверном снапшоте seat-save (журнал localStorage подрезается после /save)
  await new Promise(r => setTimeout(r, 700));
  const snap1 = readdirSync(dataDir).filter(f => /^lesson-save-.*-seat1\.json$/.test(f))
    .map(f => JSON.parse(readFileSync(path.join(dataDir, f), 'utf-8'))).pop();
  const mdl = snap1 && snap1.payload && snap1.payload.model;
  ok('эксперимент: «Научить» дал версию состава v2 (payload.model в снапшоте)',
     !!mdl && mdl.version === 2 && (snap1.payload.model_history || []).length === 2,
     JSON.stringify(mdl && { v: mdl.version, hist: (snap1.payload.model_history || []).length }));
}

/* --- identity движка (Codex-ревью 18.07, находка 4): заход БЕЗ ?engine= обязан
 *     восстановить модель ДВИЖКОМ ЕЁ ВЕРСИИ (train_commit.engine), а не молча
 *     переобучить дефолтным kNN. В head-прогоне это и есть сценарий «F5 head-версии
 *     без флага»; в kNN-прогоне чек сторожит сам механизм (dataset.engine) --- */
{
  await A.goto(`${BASE}/z1.html?ws=1&demo=1&seat=1`);   // URL сознательно без engine-флага
  await waitState(A, s => !!s.step, 20000, 'boot после захода без флага движка');
  const engRestored = await A.evaluate(() => document.getElementById('screen').dataset.engine);
  const wantEng = process.env.ENGINE || 'knn';
  ok(`restore: движок версии восстановлен без URL-флага (${engRestored})`,
     engRestored === wantEng, `ждали ${wantEng}, получили ${engRestored}`);
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
/* аудит ядра 18.07, п.5: done живёт в снапшоте — F5 после финала снова «Дело закрыто»,
 * а не перепоказ последнего шага (до фикса boot чтил только acked_step) */
{
  // дождаться, пока сейв-веха финала доедет до диска (дебаунс ~1 c) — заодно проверка,
  // что state='done' вообще пишется в снапшот
  let snapDone = false;
  for (const t0 = Date.now(); Date.now() - t0 < 8000;) {
    const snap = readdirSync(dataDir).filter(f => /^lesson-save-.*-seat1\.json$/.test(f))
      .map(f => JSON.parse(readFileSync(path.join(dataDir, f), 'utf-8'))).pop();
    if (snap && snap.state === 'done') { snapDone = true; break; }
    await new Promise(r => setTimeout(r, 300));
  }
  ok('финал: снапшот state=done доехал на сервер', snapDone);
  await A.reload({ waitUntil: 'domcontentloaded' });
  const st = await waitState(A, s => s.done || (s.step && !s.entry), 15000, 'boot после F5 на done');
  ok('F5 после финала: снова «Дело закрыто» (done восстановлен из снапшота)', st.done,
     JSON.stringify(st));
}
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
  const more = await B.$('#btn_more_traps');
  if (ENGINE !== '&engine=head') {
    // kNN (demo-синтез калиброван под него): подмножество ловушек чинит слабо → цикл добора
    ok('слабый замер на подмножестве: 2 из 4', score.includes('2 из 4'), score);
    ok('цикл добора: кнопка «Добрать ловушки» при слабом замере', !!more);
    await B.click('#btn_more_traps');
    await waitState(B, s => s.phase === 'traps', 8000, 'B → добор ловушек');
    for (let guard = 0; guard < 20; guard++) {
      if (!await clickIf(B, '#btn_pick')) break;                // пропущенные вернулись в очередь
      await new Promise(r => setTimeout(r, 80));
    }
    await clickIf(B, '#btn_next');                              // «Дальше» (пул исчерпан)
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
  } else {
    // head на demo-фичах генерализует с односторонних ловушек (ТЗ v3 §2.2: коэффициенты
    // demo-синтеза подбирались под kNN — для head подвижка честная, реальный банк даёт
    // слабый замер 1/4 и добор; см. pilot/head-pilot-report.md). Проверяем честность UI:
    // сильный замер → кнопки добора нет
    ok('head: подмножество ловушек уже чинит демо-коробку (4 из 4), добор честно не предлагается',
       score.includes('4 из 4') && !more, score + (more ? ' + кнопка добора' : ''));
  }
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
  // карточка дела: пара «до → после» честная (баг #33) — «до» = авто-замер v1,
  // который ребёнок видел строкой «Было», «после» — итог добора
  await driveLesson(B, man, { code: '4712',
    stopWhen: (st) => !st.entry && st.phase === 'card_view' });
  const factB = await B.evaluate(() =>
    [...document.querySelectorAll('.factrow')].map(e => e.textContent).join(' | '));
  if (ENGINE !== '&engine=head')
    ok('карточка дела B: точность «0 → 4 из 4» — та же пара, что на экране замера',
       factB.includes('0 → 4 из 4'), factB.slice(0, 160));
  else
    ok('карточка дела B (head): пара «до → после» присутствует и честна',
       /\d+ → 4 из 4/.test(factB), factB.slice(0, 160));
  // финал (И3 п.7): путь детектива — «Дело №1 ✓» + серые будущие дела из данных курса
  let casesInfo = null;
  await driveLesson(B, man, { code: '4712', hook: async (st, p) => {
    if (!casesInfo && !st.entry && st.phase === 'next_block') {
      await p.screenshot({ path: '/tmp/z1-cases.png', fullPage: true });   // ревью пути детектива
      casesInfo = await p.evaluate(() => ({
        done: document.querySelectorAll('.casechip-done').length,
        future: document.querySelectorAll('.casechip-future').length,
        first: (document.querySelector('.casechip-done') || {}).textContent || '',
      }));
    }
  } });
  ok('финал: «Дело №1 ✓» + 4 серых будущих дела (плашки из данных курса)',
     !!casesInfo && casesInfo.done === 1 && casesInfo.future === 4 && casesInfo.first.includes('✓'),
     JSON.stringify(casesInfo));
  ok('B: занятие пройдено до конца после цикла добора', (await state(B)).done);
}

/* --- C: догоняющий приходит сразу на s6 (без своей v1-модели) — честность
 *     авто-замера «до» (БАГ #33: карточка «3 → 3 из 4»). До фикса отложенный
 *     авто-«до» мерил УЖЕ ПОЧИНЕННУЮ модель — «Было» совпадало со «Стало» --- */
{
  const fixStep = man.lesson.steps.find(s => s.type === 'trainer_act' && s.mode === 'fix');
  await host('/host/gate', { action: 'step', step: fixStep.id });   // группа уже на s6
  const C = await mkChild(3);
  await C.waitForSelector('#btn_catchup_go', { timeout: 15000 });   // карточка догоняющего
  await C.click('#btn_catchup_go');
  await waitState(C, s => s.entry, 15000, 'гейт C (checkin)');
  await C.click('#btn_gate');                                       // «Я тут!»
  await waitState(C, s => !s.entry && s.step === fixStep.id, 15000, 'C вошёл в s6');
  for (let guard = 0; guard < 10 && (await state(C)).phase !== 'traps'; guard++) {
    await clickIf(C, '#btn_next');
    await new Promise(r => setTimeout(r, 150));
  }
  let cats = 0;                       // сперва — 2 ловушки ОДНОГО класса (только коты)
  for (let guard = 0; guard < 40 && cats < 2; guard++) {
    const cur = await C.$eval('#img_current', el => el.dataset.img).catch(() => null);
    if (!cur) break;
    if (man.byId[cur].class === 'cat') { await C.click('#btn_pick'); cats += 1; }
    else await C.click('#btn_skip');
    await new Promise(r => setTimeout(r, 80));
  }
  await clickIf(C, '#btn_next');                                    // «Хватит, проверяем»
  await waitState(C, s => s.phase === 'retrain', 8000, 'C → научить');
  /* обучение одним классом заблокировано (закалка 18.07, major): у догоняющего корзины
   * пусты, в коробке только коты — «Научить» заперта с детским текстом и путём добора */
  const oneClass = await C.evaluate(() => ({
    disabled: (document.getElementById('btn_train') || {}).disabled === true,
    note: (document.getElementById('one_class_note') || {}).textContent || '',
    more: !!document.getElementById('btn_more_traps'),
  }));
  ok('один класс: «Научить» заперта, пока в коробке только коты', oneClass.disabled,
     JSON.stringify(oneClass));
  ok('один класс: детский текст «нужны и коты, и собаки»',
     /коты/.test(oneClass.note) && /собаки/.test(oneClass.note), oneClass.note);
  ok('один класс: есть путь добора («Добрать картинок»)', oneClass.more, JSON.stringify(oneClass));
  await C.click('#btn_more_traps');
  await waitState(C, s => s.phase === 'traps', 8000, 'C → добор второго класса');
  let dogs = 0;
  for (let guard = 0; guard < 40 && dogs < 1; guard++) {
    const cur = await C.$eval('#img_current', el => el.dataset.img).catch(() => null);
    if (!cur) break;
    if (man.byId[cur].class === 'dog') { await C.click('#btn_pick'); dogs += 1; }
    else await C.click('#btn_skip');
    await new Promise(r => setTimeout(r, 80));
  }
  await clickIf(C, '#btn_next');                                    // «Хватит, проверяем»
  await waitState(C, s => s.phase === 'retrain', 8000, 'C → научить (оба класса)');
  ok('оба класса набраны: «Научить» ожила',
     await C.$eval('#btn_train', b => !b.disabled).catch(() => false));
  await C.click('#btn_train');
  await waitState(C, s => s.phase === 'measure_after', 10000, 'C → замер');
  await clickIf(C, '#btn_check');
  await C.waitForSelector('.growthcap-score, .score-big', { timeout: 8000 });
  const txtC = await C.evaluate(() => document.getElementById('screen').textContent);
  ok('баг #33: у догоняющего нет фальшивого «Было» (авто-«до» с починенной модели не пишется)',
     !txtC.includes('Было'), txtC.slice(0, 140));
  ok('баг #33: рост-рядов нет — только честное «Стало»', !(await C.$('.growth')));
  await driveLesson(C, man, { code: '4712',
    stopWhen: (st) => !st.entry && st.phase === 'card_view' });
  const factC = await C.evaluate(() =>
    [...document.querySelectorAll('.factrow')].map(e => e.textContent).join(' | '));
  ok('баг #33: карточка дела догоняющего — «— → N из 4», а не «N → N из 4»',
     /— → \d из 4/.test(factC), factC.slice(0, 160));
  await driveLesson(C, man, { code: '4712' });
  ok('C: догоняющий дошёл до конца занятия', (await state(C)).done);
  await C.close();
}

/* --- D: F5 СРАЗУ после «Научить» (Codex-ревью И3, находка 2): крах в окне
 *     «train_commit в журнале, phase_enter следующего такта не записан» —
 *     restore возвращает на такт обучения, повторный «Научить» того же состава
 *     НЕ плодит новую версию. Окно симулируем детерминированно: /save глушится
 *     (offline-паттерн), журнал подрезается до train_commit включительно, F5 --- */
{
  const fixStep = man.lesson.steps.find(s => s.type === 'trainer_act' && s.mode === 'fix');
  const D = await mkChild(4);   // группа всё ещё на s6 (host-переход сделан для C)
  await D.waitForSelector('#btn_catchup_go', { timeout: 15000 });
  await D.click('#btn_catchup_go');
  await waitState(D, s => s.entry, 15000, 'гейт D (checkin)');
  await D.click('#btn_gate');
  await waitState(D, s => !s.entry && s.step === fixStep.id, 15000, 'D вошёл в s6');
  for (let guard = 0; guard < 10 && (await state(D)).phase !== 'traps'; guard++) {
    await clickIf(D, '#btn_next');
    await new Promise(r => setTimeout(r, 150));
  }
  // по одной ловушке каждого класса: состав из двух классов — «Научить» не заперта
  let gotCat = 0, gotDog = 0;
  for (let guard = 0; guard < 40 && (gotCat < 1 || gotDog < 1); guard++) {
    const cur = await D.$eval('#img_current', el => el.dataset.img).catch(() => null);
    if (!cur) break;
    const cls = man.byId[cur].class;
    if (cls === 'cat' && gotCat < 1) { await D.click('#btn_pick'); gotCat += 1; }
    else if (cls === 'dog' && gotDog < 1) { await D.click('#btn_pick'); gotDog += 1; }
    else await D.click('#btn_skip');
    await new Promise(r => setTimeout(r, 80));
  }
  await clickIf(D, '#btn_next');                                    // «Хватит, проверяем»
  await waitState(D, s => s.phase === 'retrain', 8000, 'D → научить');
  await D.route('**/save', r => r.abort());   // дебаунс-сейв не должен унести журнал на сервер
  await D.click('#btn_train');
  await waitState(D, s => s.phase === 'measure_after', 15000, 'D обучил (v1)');
  await D.evaluate(() => {
    // симуляция краха: срезать всё после train_commit (phase_enter не дожил до диска)
    const key = Object.keys(localStorage).find(k => k.startsWith('z1_journal_') && k.endsWith('_4'));
    const j = JSON.parse(localStorage.getItem(key));
    const at = j.entries.map(e => e.type).lastIndexOf('train_commit');
    j.entries = j.entries.slice(0, at + 1);
    localStorage.setItem(key, JSON.stringify(j));
  });
  await D.reload({ waitUntil: 'domcontentloaded' });
  await waitState(D, s => !!s.step && !s.entry, 20000, 'boot D после подрезки журнала');
  const stD = await state(D);
  ok('F5 после «Научить»: вернулись на такт обучения (переход такта не записан)',
     stD.step === fixStep.id && stD.phase === 'retrain', JSON.stringify(stD));
  await clickIf(D, '#btn_train');
  await waitState(D, s => s.phase === 'measure_after', 15000, 'D → замер после повторного «Научить»');
  const chipsD = await D.evaluate(() => [...document.querySelectorAll('.vchip')].map(e => e.textContent));
  ok('F5 после «Научить»: повторный тап не плодит версию (на полке только v1)',
     chipsD.length === 1 && /^v1 /.test(chipsD[0] || ''), JSON.stringify(chipsD));
  await D.close();
}

/* --- E: две вкладки с ОДНИМ sessionStorage (аудит ядра 18.07, critical «две вкладки»):
 *     дубль вкладки копирует sessionStorage — раньше оба документа наследовали один
 *     client_instance_id и сервер принимал их как одного писателя (потеря действий).
 *     Теперь живая вкладка держит Web Lock своего id → дубль берёт новый id и честно
 *     ловит «Открыто в другой вкладке» --- */
{
  const fixStep = man.lesson.steps.find(s => s.type === 'trainer_act' && s.mode === 'fix');
  const E1 = await mkChild(5);
  await E1.waitForSelector('#btn_catchup_go', { timeout: 15000 });
  await E1.click('#btn_catchup_go');
  await waitState(E1, s => s.entry, 15000, 'гейт E1 (checkin)');
  await E1.click('#btn_gate');
  await waitState(E1, s => !s.entry && s.step === fixStep.id, 15000, 'E1 вошёл в s6');
  const instKey = await E1.evaluate(() =>
    Object.keys(sessionStorage).find(k => k.startsWith('z1_inst_')));
  const id1 = await E1.evaluate((k) => JSON.parse(sessionStorage.getItem(k)).id, instKey);
  // «Duplicate Tab»: новая страница ТОГО ЖЕ контекста с копией sessionStorage
  const ssDump = await E1.evaluate(() => JSON.stringify(Object.entries(sessionStorage)));
  const E2 = await E1.context().newPage();
  E2.setDefaultTimeout(30000);
  // посев — ОДИН раз: addInitScript выполняется при каждой навигации, а takeover
  // делает location.reload() — повторный посев затирал бы новый id дубля старым id1
  // и дубль после takeover снова ловил бы other_tab (артефакт харнесса, не приложения)
  await E2.addInitScript((dump) => {
    if (sessionStorage.getItem('__dup_seeded')) return;
    for (const [k, v] of JSON.parse(dump)) sessionStorage.setItem(k, v);
    sessionStorage.setItem('__dup_seeded', '1');
  }, ssDump);
  await E2.goto(E1.url());
  await waitState(E2, s => !!s.step, 20000, 'boot дубля E2');
  const id2 = await E2.evaluate((k) => JSON.parse(sessionStorage.getItem(k)).id, instKey);
  ok('две вкладки: дубль взял НОВЫЙ client_instance_id (Web Lock у живой вкладки)',
     !!id2 && id2 !== id1, id1 + ' vs ' + id2);
  // первая же мутация дубля — other_tab: сервер знает писателем E1
  await clickIf(E2, '#btn_next');
  const otherTab = await E2.waitForSelector('button:has-text("Продолжить здесь")', { timeout: 12000 })
    .then(() => true).catch(() => false);
  ok('две вкладки: дубль получил «Открыто в другой вкладке», а не молча пишет как E1', otherTab);
  // «Продолжить здесь» в дубле: claim-only takeover → E2 работает, E1 теряет право.
  // Маркер на старом документе: ассерты только ПОСЛЕ настоящего reload
  await E2.evaluate(() => { document.body.dataset.pre = '1'; });
  await E2.click('button:has-text("Продолжить здесь")');
  await E2.waitForFunction(() => !document.body.dataset.pre, null, { timeout: 20000 });
  await waitState(E2, s => !!s.step && !s.entry, 20000, 'E2 после takeover');
  await clickIf(E2, '#btn_next');
  await new Promise(r => setTimeout(r, 2500));   // дебаунс-сейв нового поколения успел ответить
  ok('две вкладки: после takeover дубль работает без overlay',
     !(await E2.$('button:has-text("Продолжить здесь")')));
  await clickIf(E1, '#btn_next');   // мутация старой вкладки → other_tab у неё
  const e1Lost = await E1.waitForSelector('button:has-text("Продолжить здесь")', { timeout: 12000 })
    .then(() => true).catch(() => false);
  ok('две вкладки: старая вкладка честно получает «Открыто в другой вкладке»', e1Lost);
  await E1.close(); await E2.close();
}

/* --- R: резервный блок — вход посреди шага, F5 внутри резерва, выход через acked,
 *     F5 после выхода (аудит ядра 18.07, пп.6–7) --- */
{
  const fixStep = man.lesson.steps.find(s => s.type === 'trainer_act' && s.mode === 'fix');
  const R = await mkChild(6);
  await R.waitForSelector('#btn_catchup_go', { timeout: 15000 });
  await R.click('#btn_catchup_go');
  await waitState(R, s => s.entry, 15000, 'гейт R (checkin)');
  await R.click('#btn_gate');
  await waitState(R, s => !s.entry && s.step === fixStep.id, 15000, 'R вошёл в s6');
  for (let guard = 0; guard < 10 && (await state(R)).phase !== 'traps'; guard++) {
    await clickIf(R, '#btn_next');
    await new Promise(r => setTimeout(r, 150));
  }
  const before = await state(R);   // приостановимся ПОСРЕДИ шага: s6.traps (НЕ первый такт)
  ok('резерв: точка приостановки — не первый такт шага', before.phase === 'traps', JSON.stringify(before));
  await host('/host/gate', { action: 'reserve', which: 'trainer' });
  await R.waitForSelector('#reservebar button', { timeout: 12000 });
  await R.click('#reservebar button');
  const reserveId = man.lesson.reserve_steps.find(s => s.kind === 'trainer').id;
  await waitState(R, s => s.step === reserveId && !s.entry, 15000, 'вход в резерв');
  await clickIf(R, '#btn_pick');   // немного поработали в резерве
  // F5 внутри резерва: восстановиться обязан И резерв, И suspended-позиция основной машины
  await R.reload({ waitUntil: 'domcontentloaded' });
  await waitState(R, s => !!s.step && !s.entry, 20000, 'boot после F5 в резерве');
  ok('F5 в резерве: снова резерв (acked_step резервный)', (await state(R)).step === reserveId,
     JSON.stringify(await state(R)));
  // доводим резерв до конца: pick → Дальше → Научить → замер → Дальше (finishStep)
  for (let guard = 0; guard < 40 && (await state(R)).step === reserveId; guard++) {
    if (!await clickIf(R, '#btn_pick'))
      if (!await clickIf(R, '#btn_train'))
        if (!await clickIf(R, '#btn_check'))
          await clickIf(R, '#btn_next');
    await new Promise(r => setTimeout(r, 250));
  }
  const back = await state(R);
  ok('выход из резерва: вернулись на приостановленный такт основного шага (s6.traps)',
     back.step === before.step && back.phase === before.phase, JSON.stringify({ before, back }));
  // F5 после выхода: до фикса acked_step оставался резервным и F5 снова открывал резерв;
  // suspended-фаза (traps, не intro) — из снапшота
  await R.reload({ waitUntil: 'domcontentloaded' });
  await waitState(R, s => !!s.step && !s.entry, 20000, 'boot после выхода из резерва');
  const after = await state(R);
  ok('F5 после выхода из резерва: основной шаг, НЕ резерв (выход был acked)',
     after.step === before.step, JSON.stringify(after));
  ok('F5 после выхода: такт приостановки не потерян (suspended в снапшоте)',
     after.phase === before.phase, JSON.stringify({ before, after }));
  await host('/host/gate', { action: 'reserve', which: 'none' });
  await R.close();
}

// --- телеметрия: связки в JSONL реального прогона (DoD п.6) ---
await A.evaluate(() => new Promise(r => setTimeout(r, 800)));   // добежали дампы
const jsonl = readdirSync(dataDir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
  .flatMap(f => readFileSync(path.join(dataDir, f), 'utf-8').trim().split('\n'))
  .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
const evTypes = new Set(jsonl.flatMap(r => (r.data.events || []).map(e => e.type)));
for (const t of ['gate_enter', 'quiz_click', 'basket_undo', 'trained', 'probe', 'probe_judgement',
                 'version_committed',
                 'version_choice', 'reveal_seen', 'captcha_commit', 'trap_added', 'retrained',
                 'measure', 'forecast_committed', 'forecast_result', 'hint', 'stuck_pressed',
                 'buffer_forecast', 'chat_msg', 'card_opened', 'best_trap_marked', 'artifact_saved',
                 'baskets_cleared', 'experiment_start', 'trap_skipped', 'traps_done',
                 // traps_more шлётся только в цикле добора — на head-прогоне demo его нет (см. выше)
                 ...(ENGINE === '&engine=head' ? [] : ['traps_more'])])
  ok('телеметрия: событие ' + t + ' в JSONL', evTypes.has(t));
const measureEvents = jsonl.flatMap(r => (r.data.events || []).filter(e => e.type === 'measure'));
ok('телеметрия: замер несёт версию состава (model_sig)', measureEvents.some(e => e.model_sig));
// identity модели в телеметрии (Codex-ревью 18.07, находка 5): каким движком и на каких
// params сделаны замер/проба/обучение. КАЖДОЕ событие несёт engine+params_rev; события
// движка прогона обязаны присутствовать (в head-прогоне RUN 3 на _test-variant банке
// честно откатывается на knn — там head не пилотирован, поэтому не every по engRun)
const engRun = ENGINE === '&engine=head' ? 'head' : 'knn';
ok('телеметрия: каждый замер несёт engine+params_rev',
   measureEvents.length > 0 && measureEvents.every(e => e.engine && e.params_rev != null),
   JSON.stringify(measureEvents.map(e => [e.engine, e.params_rev]).slice(0, 3)));
ok('телеметрия: есть замеры движка прогона (' + engRun + ')',
   measureEvents.some(e => e.engine === engRun));
const probeEvents = jsonl.flatMap(r => (r.data.events || []).filter(e => e.type === 'probe'));
ok('телеметрия: пробы несут engine движка вердикта', probeEvents.some(e => e.engine === engRun));
// внимательность (И3 п.8): обязательный ответ «Коробка права?» на КАЖДОМ вердикте пробы,
// каждый ответ несёт correct (совпал ли с фактом) и saw_mistake (что ответил ребёнок)
const pjEvents = jsonl.flatMap(r => (r.data.events || []).filter(e => e.type === 'probe_judgement'));
ok('телеметрия внимательности: probe_judgement на каждой пробе',
   pjEvents.length >= probeEvents.length && pjEvents.length > 0,
   pjEvents.length + ' ответов на ' + probeEvents.length + ' проб');
ok('телеметрия внимательности: каждый ответ несёт correct и saw_mistake',
   pjEvents.every(e => typeof e.correct === 'boolean' && typeof e.saw_mistake === 'boolean'));
const trainedEvents = jsonl.flatMap(r => (r.data.events || [])
  .filter(e => e.type === 'trained' || e.type === 'retrained'));
ok('телеметрия: trained/retrained несут engine+params_rev',
   trainedEvents.length > 0 && trainedEvents.every(e => e.engine && e.params_rev != null));
const gateEvents = jsonl.flatMap(r => (r.data.events || []).filter(e => e.type === 'gate_enter'));
ok('телеметрия: gate_enter с ok:false (неверный код)', gateEvents.some(e => e.ok === false));
const hintEvents = jsonl.flatMap(r => (r.data.events || []).filter(e => e.type === 'hint'));
ok('телеметрия: hint с уровнями (1 и 2)', hintEvents.some(e => e.level === 1) && hintEvents.some(e => e.level === 2));

// --- дашборд: замеры и прогресс живьём (DoD п.5) ---
await dash.reload();
html = await dash.content();
ok('дашборд: замер R1→R2 в таблице', /0\/4 → [34]\/4/.test(html), html.match(/[0-9]\/4 → [0-9]\/4/)?.[0] || 'нет');
ok('дашборд: уровень помощи виден', html.includes('ур.2'));

/* --- автообновление дашборда без потери контекста (Codex-ревью И3, минор 4):
 *     meta-refresh снят; свёртки переживают перезагрузку; недовведённый текст
 *     в поле откладывает reload --- */
ok('дашборд: meta-refresh снят (умный таймер вместо слепого reload)',
   !html.includes('http-equiv="refresh"'));
{
  await dash.evaluate(() => {
    const s = [...document.querySelectorAll('details summary')]
      .find(el => el.textContent.includes('Как читать'));
    if (s) s.click();
  });
  await dash.reload();
  const legendOpen = await dash.evaluate(() => {
    const d = [...document.querySelectorAll('details')]
      .find(el => (el.querySelector('summary') || { textContent: '' }).textContent.includes('Как читать'));
    return !!(d && d.open);
  });
  ok('дашборд: открытая свёртка переживает обновление (sessionStorage)', legendOpen === true);
  const dirty = await dash.evaluate(() => {
    const inp = document.querySelector('input:not([readonly])');
    inp.value = inp.value + '9';   // «недовведённый код» — value разошёлся с defaultValue
    return window.__dashDirty();
  });
  ok('дашборд: недовведённый текст в поле откладывает автообновление', dirty === true);
  await dash.reload();   // вернуть чистое поле перед следующими шагами
}

await A.close(); await B.close();

/* ================================================================== */
/* RUN Z: закалка 18.07 — reset_version из поллинга (обычный такт / entry / резерв),  */
/* повторный баннер резерва, отказ эмбеддера, fallback-identity движка              */
/* ================================================================== */
{
  await dash.reload();
  dash.once('dialog', d => d.accept());
  await dash.click('button:has-text("▶ Запустить заново")');
  await dash.waitForLoadState('networkidle');
  await host('/host/gate', { action: 'code', step: gateStepId, code: '4712', show: true });

  const Z1 = await mkChild(1);
  const Z2 = await mkChild(2);
  const zWaiting = { code: '4712', stopWhen: (st) => !st.entry && st.step === versionStep.id &&
    (versionStep.phases.find(ph => ph.id === st.phase) || {}).elements?.length === 0 };
  await driveLesson(Z1, man, zWaiting);
  await driveLesson(Z2, man, zWaiting);

  // --- reset на обычном такте: Z2 с waiting возвращается на первый слот и пересобирает ---
  // (reset_version на сервере активен ТОЛЬКО до reveal — все reset-кейсы идут до раскрытия)
  await host('/host/reset_version', { step: versionStep.id, seat: '2' });
  await waitState(Z2, s => !s.entry && s.step === versionStep.id && s.phase === 'version_slot1',
    12000, 'reset у Z2 (поллинг)');
  ok('reset: Z2 вернулся на пересборку версии (первый слот)', true);
  await driveLesson(Z2, man, zWaiting);
  ok('reset: Z2 пересобрал и закоммитил версию заново (epoch принят)', true);

  // --- CRITICAL reset В РЕЗЕРВЕ: Z2 входит в r2 с waiting — экран резерва жив,
  //     выход ведёт на пересборку версии ---
  await host('/host/gate', { action: 'reserve', which: 'trainer' });
  await Z2.waitForSelector('#reservebar button', { timeout: 12000 });
  await Z2.click('#reservebar button');
  const rid = man.lesson.reserve_steps.find(s => s.kind === 'trainer').id;
  await waitState(Z2, s => s.step === rid && !s.entry, 15000, 'Z2 вошёл в r2');
  await host('/host/reset_version', { step: versionStep.id, seat: '2' });
  await new Promise(r => setTimeout(r, 3500));   // ≥2 демо-поллинга: reset доехал
  const inR = await state(Z2);
  ok('CRITICAL reset в резерве: экран резерва жив (машина резерва не тронута)',
     inR.step === rid && !!inR.phase, JSON.stringify(inR));
  for (let guard = 0; guard < 40 && (await state(Z2)).step === rid; guard++) {
    if (!await clickIf(Z2, '#btn_pick'))
      if (!await clickIf(Z2, '#btn_train'))
        if (!await clickIf(Z2, '#btn_check'))
          await clickIf(Z2, '#btn_next');
    await new Promise(r => setTimeout(r, 250));
  }
  const afterR = await state(Z2);
  ok('reset в резерве: выход из резерва ведёт на пересборку версии (suspended переписан)',
     afterR.step === versionStep.id && afterR.phase === 'version_slot1', JSON.stringify(afterR));
  await host('/host/gate', { action: 'reserve', which: 'none' });

  // --- повторное включение ТОГО ЖЕ резерва снова показывает баннер (major, закалка):
  //     Z1 на waiting видел баннер и не входил — после выключения и включения баннер
  //     обязан вернуться (раньше застревал dataset.which) ---
  await Z1.waitForFunction(() => !document.querySelector('#reservebar button'), null, { timeout: 12000 });
  await host('/host/gate', { action: 'reserve', which: 'trainer' });
  await Z1.waitForSelector('#reservebar button', { timeout: 12000 });
  await host('/host/gate', { action: 'reserve', which: 'none' });
  await Z1.waitForFunction(() => !document.querySelector('#reservebar button'), null, { timeout: 12000 });
  await host('/host/gate', { action: 'reserve', which: 'trainer' });
  const bannerAgain = await Z1.waitForSelector('#reservebar button', { timeout: 12000 })
    .then(() => true).catch(() => false);
  ok('резерв: повторное включение того же блока снова показывает баннер', bannerAgain);
  await host('/host/gate', { action: 'reserve', which: 'none' });

  // --- CRITICAL reset на ENTRY: свежее место стоит на экране входа (гейт s1 с кодом) —
  //     вход отменяется, машина не ломается, экран уходит на пересборку версии ---
  const Z3 = await mkChild(5);
  await waitState(Z3, s => s.entry, 15000, 'Z3 на гейте s1 (entry)');
  await host('/host/reset_version', { step: versionStep.id, seat: '5' });
  await waitState(Z3, s => !s.entry && s.step === versionStep.id && s.phase === 'version_slot1',
    12000, 'reset на entry у Z3');
  ok('CRITICAL reset на entry: вход отменён, машина цела, экран на пересборке версии', true);
  await Z3.close();
  await Z1.close(); await Z2.close();

  /* --- fallback-identity движка (major): v1 обучена head, перезаход с ?engine=knn —
   *     пересборка ЧУЖИМ движком морозит новую версию, полка не двоит, проба живая --- */
  {
    const c3 = await browser.newContext({ viewport: { width: 640, height: 760 } });
    const F = await c3.newPage();
    F.setDefaultTimeout(30000);
    await F.goto(`${BASE}/z1.html?ws=1&demo=1&seat=3&engine=head`);
    await driveLesson(F, man, { code: '4712',
      stopWhen: (st) => !st.entry && st.step === versionStep.id && st.phase === 'probe' });
    await F.goto(`${BASE}/z1.html?ws=1&demo=1&seat=3&engine=knn`);
    await waitState(F, s => !!s.step && !s.entry, 20000, 'boot F с engine=knn');
    await F.waitForFunction(() => document.querySelectorAll('.vchip').length >= 2, null, { timeout: 10000 })
      .catch(() => {});
    const shelf = await F.evaluate(() => ({
      chips: [...document.querySelectorAll('.vchip')].map(e => e.textContent),
      active: document.querySelectorAll('.vchip-active').length,
    }));
    ok('fallback identity: пересборка чужим движком дала НОВУЮ версию (v2 на полке)',
       shelf.chips.length === 2, JSON.stringify(shelf));
    ok('полка: активный чип ровно один (пара sig+engine, не только sig)',
       shelf.active === 1, JSON.stringify(shelf));
    await clickIf(F, '#btn_check');
    const verdictOk = await F.waitForSelector('.verdict', { timeout: 8000 })
      .then(() => true).catch(() => false);
    ok('fallback identity: проба после смены движка работает (не вечный stale)', verdictOk);
    await F.close(); await c3.close();
  }

  /* --- CRITICAL отказ эмбеддера (не-demo): кнопки модели НЕ оживают, честная плашка,
   *     «Попробовать ещё раз» после возврата сети реально чинит --- */
  {
    const c4 = await browser.newContext({ viewport: { width: 640, height: 760 } });
    const E = await c4.newPage();
    E.setDefaultTimeout(45000);
    await E.route('**/vendor/mediapipe/**', r => r.abort());
    await E.goto(`${BASE}/z1.html?ws=1&seat=4`);   // БЕЗ demo: настоящий warmup
    await driveLesson(E, man, { code: '4712',
      stopWhen: (st) => !st.entry && st.step === versionStep.id && st.phase === 'train' });
    await E.waitForSelector('.model-error', { timeout: 15000 });
    const embFail = await E.evaluate(() => ({
      banner: !!document.querySelector('.model-error'),
      retry: !!document.getElementById('btn_model_retry'),
      trainDisabled: (document.getElementById('btn_train') || {}).disabled === true,
      trainText: (document.getElementById('btn_train') || {}).textContent || '',
    }));
    ok('CRITICAL эмбеддер упал: «Научить» НЕ разблокирована', embFail.trainDisabled,
       JSON.stringify(embFail));
    ok('эмбеддер упал: честная плашка + кнопка восстановления', embFail.banner && embFail.retry,
       JSON.stringify(embFail));
    ok('эмбеддер упал: кнопка честно говорит про отказ', /не загрузилась/.test(embFail.trainText),
       embFail.trainText);
    // «сеть вернулась»: вместо реального MediaPipe (в headless валит браузер) отдаём
    // fake-модуль с тем же контрактом — тест проверяет ПУТЬ восстановления приложения.
    // Красный без фикса cache-busting: упавший import() закэширован в module map
    // навсегда, и retry без ?retry=N получил бы старую ошибку даже при живой сети
    await E.unroute('**/vendor/mediapipe/**');
    await E.route('**/vendor/mediapipe/vision_bundle.mjs*', r => r.fulfill({
      status: 200, contentType: 'application/javascript',
      body: `export const FilesetResolver = { forVisionTasks: async () => ({}) };
export class ImageEmbedder {
  static async createFromOptions() { return new ImageEmbedder(); }
  embed() { const v = new Float32Array(64); v[0] = 1; return { embeddings: [{ floatEmbedding: v }] }; }
}`,
    }));
    const t0e = Date.now();
    await E.click('#btn_model_retry');
    const revived = await E.waitForFunction(() => {
      const b = document.getElementById('btn_train');
      return b && !b.disabled;
    }, null, { timeout: 30000 }).then(() => true).catch(() => false);
    ok('эмбеддер восстановился: «Научить» ожила после retry (' +
       Math.round((Date.now() - t0e) / 1000) + ' c)', revived);
    ok('после восстановления плашка ошибки исчезла', !(await E.$('.model-error')));
    await E.close(); await c4.close();
  }
}

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
if (ENGINE === '&engine=head') {
  // находка 5: откат непилотированного движка — СОБЫТИЕ телеметрии, не console.warn.
  // На _test-variant банке head не пилотирован → boot V1/V2 обязан дать engine_fallback
  // (событие IMM — дамп улетает сразу; jsonl перечитываем, RUN 3 позже общего свода)
  await V1.evaluate(() => new Promise(r => setTimeout(r, 500)));
  const jsonl3 = readdirSync(dataDir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .flatMap(f => readFileSync(path.join(dataDir, f), 'utf-8').trim().split('\n'))
    .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  const fb = jsonl3.flatMap(r => (r.data.events || []).filter(e => e.type === 'engine_fallback'));
  ok('телеметрия: engine_fallback на непилотированном банке (want=head → used=knn)',
     fb.some(e => e.want === 'head' && e.used === 'knn'), JSON.stringify(fb.slice(0, 2)));
}
await V1.close(); await V2.close();

/* ---------- смоук широкого окна 1512px: раскладка-«конвейер» (И3-Т раздел B) ----------
 * Зоны «вход → коробка → выход» тремя колонками в один ряд (grid 40/30/30);
 * клики и настоящий drag работают; DOM-чек конституции на широком экране. */
{
  const firstGate = man.lesson.steps.find(s => s.type === 'gate' && s.gate.kind === 'code').id;
  await host('/host/gate', { action: 'code', step: firstGate, code: '4712', show: true });
  const c = await browser.newContext({ viewport: { width: 1512, height: 950 } });
  const W = await c.newPage();
  W.setDefaultTimeout(30000);
  await W.goto(`${BASE}/z1.html?ws=1&demo=1&seat=9` + ENGINE);
  const trainer = man.lesson.steps.find(s => s.type === 'trainer_act').id;
  await driveLesson(W, man, { code: '4712',
    stopWhen: (st) => st.step === trainer && st.phase === 'baskets' && !st.entry });
  const grid = await W.evaluate(() => {
    const z = document.querySelector('.zones');
    const cols = z ? getComputedStyle(z).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
    const zones = [...document.querySelectorAll('.zone')];
    const tops = zones.map(e => Math.round(e.getBoundingClientRect().top));
    const order = zones.map(e => e.dataset.zone);
    const lefts = zones.map(e => Math.round(e.getBoundingClientRect().left));
    return { cols, sameRow: new Set(tops).size === 1, order,
             ltr: lefts[0] < lefts[1] && lefts[1] < lefts[2] };
  });
  ok('конвейер: три колонки зон в один ряд', grid.cols === 3 && grid.sameRow, JSON.stringify(grid));
  ok('конвейер: поток слева направо «вход → коробка → выход»',
     grid.order.join(',') === 'in,box,out' && grid.ltr, JSON.stringify(grid));
  await W.screenshot({ path: '/tmp/z1-wide.png', fullPage: true });   // ревью конвейера
  await domCheck(W, 'wide1512:baskets');
  const countBefore = await W.evaluate(() =>
    parseInt(document.querySelector('#basket_cat .basket-count')?.textContent || '0', 10) || 0);
  await W.dragAndDrop('#img_current', '#basket_cat');
  const countAfter = await W.evaluate(() =>
    parseInt(document.querySelector('#basket_cat .basket-count')?.textContent || '0', 10) || 0);
  ok('конвейер: настоящий drag в корзину на широком окне (счёт ' +
     countBefore + '→' + countAfter + ')', countAfter === countBefore + 1);
  // живое сужение окна ПОСРЕДИ такта (Codex-ревью И3, минор 1): конвейер сложился
  // в столбик — matchMedia-слушатель докручивает к активной зоне сам
  await W.setViewportSize({ width: 820, height: 420 });
  await new Promise(r => setTimeout(r, 500));
  const narrow = await W.evaluate(() => {
    const act = document.querySelector('.zone-active .kbtn:not(:disabled)')
      || document.querySelector('.zone-active');
    const r = act.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight,
             visible: r.top >= 0 && r.bottom <= innerHeight };
  });
  ok('живое сужение <1100px: активная зона докручена в кадр', narrow.visible,
     JSON.stringify(narrow));
  /* пороговые вьюпорты (закалка 18.07): конвейер включается media-порогом ≥1100px —
   * проверяем обе стороны порога, не только 1512 */
  for (const [wpx, wantWide] of [[1101, true], [1100, true], [1099, false]]) {
    await W.setViewportSize({ width: wpx, height: 900 });
    await new Promise(r => setTimeout(r, 350));
    const g = await W.evaluate(() => {
      const z = document.querySelector('.zones');
      const disp = getComputedStyle(z).display;
      const cols = disp === 'grid'
        ? getComputedStyle(z).gridTemplateColumns.split(' ').filter(Boolean).length : 1;
      const zones = [...document.querySelectorAll('.zone')];
      const tops = zones.map(e => Math.round(e.getBoundingClientRect().top));
      return { disp, cols, sameRow: new Set(tops).size === 1 };
    });
    ok('порог ' + wpx + 'px: ' + (wantWide ? 'конвейер (3 колонки в ряд)' : 'столбик'),
       wantWide ? (g.cols === 3 && g.sameRow) : (g.cols === 1 && !g.sameRow), JSON.stringify(g));
  }
  /* низкое узкое окно рядом со звонком (683×750): активная зона достижима, страница
   * не расползается горизонтально; DOM-чек конституции на этом вьюпорте */
  await W.setViewportSize({ width: 683, height: 750 });
  await new Promise(r => setTimeout(r, 400));
  const low = await W.evaluate(() => {
    const act = document.querySelector('.zone-active .kbtn:not(:disabled)')
      || document.querySelector('.zone-active');
    act.scrollIntoView({ block: 'center' });
    const r = act.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight,
             visible: r.top < innerHeight && r.bottom > 0,
             hscroll: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  ok('низкое окно 683×750: активная зона достижима, без горизонтального скролла',
     low.visible && !low.hscroll, JSON.stringify(low));
  await domCheck(W, 'low683x750:baskets');
  await W.close(); await c.close();
}

/* ---------- свод одноразовых проверок И3-Т ---------- */
if (ENGINE === '&engine=head')
  ok('движки различимы: head показывает полоску эпох при «Научить»', trainbarSeen === true);
else
  ok('движки различимы: kNN мгновенен — полоски эпох нет', trainbarSeen === false);
ok('микрофидбек «Получилось!»: «Ведущий увидел 👍» после нажатия',
   typeof reactionChecked === 'string' && reactionChecked.includes('👍'), String(reactionChecked));
ok('расписание оверлеев: на экранах входа в шаг (гейтах) оверлеи не текут',
   entryOverlayLeak === 0, 'утечек: ' + entryOverlayLeak);

/* ---------- DOM-чек: свод ---------- */
let domFails = 0;
for (const [tag, list] of domViolations) {
  for (const v of list) { log.push('FAIL DOM ' + tag + ': ' + v); domFails += 1; fails += 1; }
}
ok('DOM-чеки конституции: экранов проверено ' + domViolations.size + ', нарушений ' + domFails, domFails === 0);

/* ---------- финал ---------- */
await browser.close();   // сперва гасим браузер и сервер: доезжающий debounce-/save
server.kill();           // не должен дать ложный транзиент в parity-сверке ниже
await new Promise(r => setTimeout(r, 300));

/* ---------- M1: parity «тень против файлов» на ПОЛНОМ прогоне e2e ---------- */
{
  const { execFileSync } = await import('node:child_process');
  let out = '', code = 0;
  try {
    out = execFileSync('python3', [path.join(ROOT, 'server/check_db_parity.py'), dataDir],
      { encoding: 'utf8' });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status ?? 1; }
  ok('M1 SQLite-тень: parity после полного e2e — ' + out.trim().split('\n')[0], code === 0);
}

console.log(log.join('\n'));
console.log(`\n${log.filter(l => l.startsWith('PASS')).length} PASS · ${fails} FAIL`);
process.exit(fails ? 1 : 0);
