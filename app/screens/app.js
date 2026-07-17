/* Оркестратор детского клиента З1 (ТЗ-демка-з1 §1.1, §2): boot → restore ≤3 c →
 * машина шагов/тактов → рендер тактов (phases.js) + сквозные оверлеи (overlays.js).
 *
 * Инварианты, которые живут здесь:
 *  - вход в шаг/гейт — acked ПО ПОСТРОЕНИЮ (машина отдаёт требование, транспорт acked.js
 *    ждёт подтверждения сервера; «Отправляю…» → «нет связи — повторю сам»);
 *  - restore: серверная склейка (/restore) + replay журнала; эмбеддер греется ФОНОМ
 *    под «коробка вспоминает…», кнопки модели активируются по готовности;
 *  - не перепоказывать сделанное: acked-коммиты сервера клампят такт после F5
 *    (версия закоммичена → не перепоказывать ввод; вердикт показан → не перегонять);
 *  - single-writer: instanceId в sessionStorage (F5 той же вкладки — тот же писатель,
 *    вторая вкладка — «Открыто в другой вкладке» + takeover);
 *  - догоняющий: нет снапшота при открытом окне → карточка catchup текущего шага. */

import { loadManifest } from '../core/manifest.js';
import { createMachine } from '../core/machine.js';
import { initialPayload, reduce } from '../core/reducer.js';
import { createJournal } from '../core/journal.js';
import { fetchRestore, applyRestore, createSeatSave, newInstanceId } from '../core/save.js';
import { createAcked } from '../core/acked.js';
import { createPoll } from '../core/poll.js';
import { createTele } from '../core/tele.js';
import { createClassifier } from '../engine/classifier.js';
import { h, bigBtn, kidText } from './dom.js';
import { createOverlays } from './overlays.js';
import { renderPhase, trainExamples } from './phases.js';

const QP = new URLSearchParams(location.search);
const screen = document.getElementById('screen');
const stepInd = document.getElementById('stepind');
const titleEl = document.getElementById('lessontitle');

const ctx = {
  QP,
  seat: QP.get('seat'),
  demo: QP.has('demo'),
  variant: QP.get('variant') || QP.get('lesson') || 'z1-kot',
  local: {},                 // локальное между рендерами такта (указатели лент и т.п.)
  chatLog: [],
  syncData: null,
  ackedCommits: {},          // step -> {type: true} — авторитетный слой сервера
  epoch: 0,
  generation: 0,
  inReserve: false,
  entering: null,            // {req} — экран входа в шаг (гейт/step_enter)
};
ctx.assetsBase = 'content/' + ctx.variant + '/assets/';

function fatal(text) {
  screen.replaceChildren(h('div', { class: 'taskcard' },
    kidText(text),
    bigBtn('Попробовать снова', () => location.reload(), { kind: 'secondary' })));
}

/* ---------- рендер ---------- */

function renderStepIndicator() {
  const pos = ctx.machine.position();
  stepInd.textContent = pos.done ? 'готово!'
    : 'шаг ' + (pos.stepIndex + 1) + ' из ' + pos.of + (ctx.inReserve ? ' · доп' : '');
}

function render() {
  if (!ctx.machine) return;
  renderStepIndicator();
  renderReserveBanner();
  // машинное состояние для e2e-драйвера (data-атрибуты, людям не видны)
  const pos = ctx.machine.position();
  screen.dataset.step = ctx.entering ? ctx.entering.req.step : (pos.done ? '' : pos.step);
  screen.dataset.phase = ctx.entering || pos.done ? '' : pos.phase;
  screen.dataset.entry = ctx.entering ? '1' : '';
  screen.dataset.done = pos.done ? '1' : '';
  if (ctx.entering) { renderEntry(); return; }
  if (ctx.machine.done) { renderDone(); return; }
  const content = renderPhase(ctx);
  const phase = ctx.machine.phase();
  screen.replaceChildren(
    phase && phase.text ? h('div', { class: 'phasetext', 'data-kid': '1' }, phase.text) : '',
    content || '');
  ctx.overlays.refreshOverlays();
}
ctx.render = render;

function renderDone() {
  screen.replaceChildren(h('div', { class: 'taskcard donecard' },
    h('div', { class: 'reveal-title', 'data-kid': '1' }, 'Дело закрыто!'),
    kidText('Отличная работа, детектив. До встречи!')));
  ctx.overlays.refreshOverlays();
  document.getElementById('stuck').disabled = true;
}

/* ---------- вход в шаг (acked по построению) ---------- */

function renderEntry() {
  const { req, error } = ctx.entering;
  const step = ctx.normalized.stepById.get(req.step);
  if (req.ack === 'gate_enter' && req.kind === 'code') {
    const input = h('input', { class: 'kinput', id: 'gate_code', inputmode: 'numeric',
      maxlength: '8', placeholder: 'Код от ведущего' });
    screen.replaceChildren(h('div', { class: 'taskcard gatecard' },
      h('div', { class: 'quiz-title', 'data-kid': '1' }, (step && step.catchup) || 'Введи код с голоса ведущего'),
      input,
      error ? h('div', { class: 'gate-error', 'data-kid': '1' }, 'Не тот код — послушай ведущего') : '',
      bigBtn('Войти', () => submitEntry({ code: input.value.trim() }), { id: 'btn_gate' })));
    input.focus();
  } else if (req.ack === 'gate_enter') {
    screen.replaceChildren(h('div', { class: 'taskcard gatecard' },
      h('div', { class: 'quiz-title', 'data-kid': '1' }, (step && step.catchup) || 'Собираемся вместе'),
      bigBtn('Я тут!', () => submitEntry({}), { id: 'btn_gate' })));
  } else {
    screen.replaceChildren(h('div', { class: 'taskcard gatecard' },
      kidText(ctx.ui.sending || 'Отправляю…')));
    submitEntry({});
  }
  ctx.overlays.refreshOverlays();
}

async function submitEntry(data) {
  const { req, advance } = ctx.entering;
  const btn = document.getElementById('btn_gate');
  if (btn) btn.disabled = true;
  try {
    await ctx.acked.commit(req.ack, req.step, data);
    if (req.ack === 'gate_enter') ctx.tele.push('gate_enter', { step: req.step, ok: true });
    ctx.entering = null;
    if (advance) ctx.machine.advanceStepAcked();
    else ctx.j('phase_enter', { phase: ctx.machine.phase().id });   // boot-вход: зафиксировать такт
    // гейт-шаг состоит из одного «пустого» такта — сразу идём дальше
    const step = ctx.machine.step();
    if (step && step.type === 'gate') { finishStep(); return; }
    ctx.seatSave.flushNow();
    maybeAutoMeasureBefore();   // R1 «до» — автозамер при входе в шаг с measure.before=auto
    render();
  } catch (e) {
    const err = e && e.resp && e.resp.error;
    if (err === 'bad_code') {
      ctx.tele.push('gate_enter', { step: req.step, ok: false });
      ctx.entering.error = true;
      render();
    } else if (err !== 'other_tab') {
      ctx.entering.error = true;
      render();
    }
  }
}

/** Требование входа в шаг idx (или в текущий при boot). advance — двигать ли машину после ack. */
function startEntry(idx, { advance } = {}) {
  const req = ctx.machine.entryRequirement(idx);
  ctx.entering = { req, advance: !!advance };
  render();
}

function finishStep() {
  if (ctx.inReserve) { exitReserve(); return; }
  const pos = ctx.machine.position();
  if (pos.done || pos.stepIndex + 1 >= pos.of) {
    ctx.machine.advanceStepAcked();          // done
    ctx.seatSave.flushNow();
    render();
    return;
  }
  startEntry(pos.stepIndex + 1, { advance: true });
}
ctx.finishStep = finishStep;

function advancePhase() {
  const ok = ctx.machine.advancePhase();
  if (ok) {
    ctx.seatSave.markDirty();
    render();
    maybeAutoMeasureBefore();
  }
  return ok;
}
ctx.advancePhase = advancePhase;

ctx.finishFinal = () => {
  ctx.tele.push('artifact_saved', { lesson: ctx.normalized.lesson.id, best_trap: ctx.payload.best_trap });
  ctx.seatSave.flushNow();
  finishStep();
};

/* ---------- модель ---------- */

function maybeAutoMeasureBefore() {
  const step = ctx.machine.step();
  if (!step || !step.measure || step.measure.before !== 'auto') return;
  if (ctx.payload.measures.before) return;
  ctx.classifier.whenReady().then(() => {
    if (ctx.payload.measures.before || !ctx.classifier.exampleCount()) return;
    const r = ctx.classifier.measure(step.measure.holdout);
    ctx.j('measure_result', { phase: 'before', score: r.score, of: r.of });
    ctx.tele.push('measure', { phase: 'before', score: r.score, of: r.of });
    render();
  });
}

ctx.modelGate = (btn) => {
  if (ctx.classifier.ready) return btn;
  btn.disabled = true;
  btn.classList.add('waitmodel');
  const old = btn.textContent;
  btn.textContent = ctx.ui.restoring || 'Коробка вспоминает…';
  ctx.classifier.whenReady().then(() => {
    if (!document.contains(btn)) return;
    btn.disabled = false;
    btn.classList.remove('waitmodel');
    btn.textContent = old;
  });
  return btn;
};

/** Тихо восстановить обученность после F5: если позиция уже ЗА первым тактом «Научить»
 * (ребёнок жал кнопку до перезагрузки) — переобучить модель из payload, не заставляя жать снова. */
function rebuildModelIfTrained() {
  if (!ctx.payload.baskets.length) return;
  const pos = ctx.machine.position();
  if (pos.done) return;
  let trainedAlready = false;
  outer:
  for (let si = 0; si < ctx.normalized.steps.length; si++) {
    const phases = ctx.normalized.steps[si].phases;
    for (let pi = 0; pi < phases.length; pi++) {
      if ((phases[pi].elements || []).includes('btn_train')) {
        trainedAlready = (si < pos.stepIndex) || (si === pos.stepIndex && pi < pos.phaseIndex);
        break outer;
      }
    }
  }
  if (!trainedAlready) return;
  ctx.classifier.whenReady().then(() => {
    // переобучаем ТЕКУЩИМ составом (корзины + ловушки только если ребёнок уже прошёл retrain)
    const pastRetrain = pastSecondTrain();
    const ex = trainExamples(ctx);
    const base = pastRetrain ? ex : ex.filter(e => ctx.payload.baskets.some(b => b.img === e.img));
    ctx.classifier.train(base);
    maybeAutoMeasureBefore();
    render();
  });
}

function pastSecondTrain() {
  const pos = ctx.machine.position();
  let seen = 0;
  for (let si = 0; si < ctx.normalized.steps.length; si++) {
    const phases = ctx.normalized.steps[si].phases;
    for (let pi = 0; pi < phases.length; pi++) {
      if ((phases[pi].elements || []).includes('btn_train')) {
        seen += 1;
        if (seen === 2)
          return (si < pos.stepIndex) || (si === pos.stepIndex && pi < pos.phaseIndex);
      }
    }
  }
  return false;
}

/* ---------- контрольные точки подсказки уровня 3 ---------- */

ctx.applyRestorePoint = (anchor) => {
  const [stepId, phaseId] = String(anchor).split('.');
  const step = ctx.normalized.stepById.get(stepId);
  if (!step) return;
  const target = step.phases.find(p => p.id === phaseId);
  // готовое промежуточное состояние: докладываем раскладку/ловушки правильно по банку
  const needsBaskets = step.phases.some(p => (p.elements || []).some(e => e.startsWith('basket_')));
  if (needsBaskets) {
    const assigned = new Set(ctx.payload.baskets.map(b => b.img));
    for (const img of ctx.bankIndex.byRole.get('train_core') || [])
      if (!assigned.has(img.id)) ctx.j('basket_assign', { img: img.id, basket: img.class });
  }
  const needsTraps = step.phases.some(p => (p.elements || []).includes('btn_pick'));
  if (needsTraps && target && (target.elements || []).includes('btn_train')) {
    const added = new Set(ctx.payload.traps);
    const pool = step.images_from_role ? (ctx.bankIndex.byRole.get(step.images_from_role) || [])
                                       : (ctx.bankIndex.byRole.get('trap') || []);
    for (const img of pool) if (!added.has(img.id)) ctx.j('trap_add', { img: img.id });
  }
  ctx.machine.restoreTo(anchor);
  ctx.seatSave.flushNow();
  render();
};

/* ---------- acked-коммиты ---------- */

ctx.commit = async (type, data) => {
  const step = ctx.machine.step();
  const resp = await ctx.acked.commit(type, step.id, data);
  (ctx.ackedCommits[step.id] = ctx.ackedCommits[step.id] || {})[type] = { data };
  ctx.seatSave.flushNow();
  return resp;
};

ctx.commitDone = (type, stepId) => !!(ctx.ackedCommits[stepId] && ctx.ackedCommits[stepId][type]);

ctx.postSeat = async (path, body) => {
  const r = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seat: ctx.seat, run_id: ctx.runId, client_instance_id: ctx.instanceId,
      writer_generation: ctx.generation, ...body,
    }),
  });
  const resp = await r.json().catch(() => ({}));
  if (resp.error === 'other_tab') { onOtherTab(); throw new Error('other_tab'); }
  if (!r.ok) throw new Error(resp.error || 'http ' + r.status);
  return resp;
};

/* ---------- single-writer ---------- */

function onOtherTab() {
  ctx.poll && ctx.poll.stop();
  ctx.overlays.showOtherTab(async () => {
    const resp = await ctx.seatSave.takeover();
    if (resp && resp.ok) location.reload();    // чистый заход от серверного снапшота (§1.1)
    else fatal('Не получилось перехватить. Обнови страницу');
  });
}

/* ---------- sync ---------- */

ctx.revealInfo = (stepId) => (ctx.syncData && ctx.syncData.reveal && ctx.syncData.reveal[stepId]) || null;

let lastResetEpoch = 0;
function onSync(resp) {
  ctx.syncData = resp;
  if (resp.chat_delta && resp.chat_delta.length) {
    ctx.chatLog.push(...resp.chat_delta);
    const step = ctx.machine && ctx.machine.step();
    const phase = ctx.machine && ctx.machine.phase();
    if (step && (step.type === 'talk_chat' || (phase && (phase.overlays || []).includes('chat')))) render();
  }
  if (resp.seat) {
    ctx.generation = resp.seat.writer_generation || ctx.generation;
    if (resp.seat.epoch !== ctx.epoch) ctx.epoch = resp.seat.epoch;
    if (resp.seat.version_status === 'reset' && ctx.epoch > lastResetEpoch) {
      lastResetEpoch = ctx.epoch;
      handleVersionReset();
    }
  }
  // reveal открыт, а мы в ожидании → перейти к разгадке
  const step = ctx.machine && !ctx.machine.done && ctx.machine.step();
  if (step && step.reveal) {
    const info = ctx.revealInfo(step.id);
    const phase = ctx.machine.phase();
    if (info && info.open && phase && !(phase.elements || []).length) advancePhase();
    else if (info && info.open && phase && step.phases[step.phases.length - 1].id === phase.id) render();
  }
  renderReserveBanner();
}

function handleVersionReset() {
  const step = ctx.normalized.steps.find(s => s.version);
  if (!step) return;
  delete ctx.ackedCommits[step.id];
  ctx.payload.version = { slots: {}, free_text: null };
  const first = step.phases.find(p => (p.elements || []).some(e => /^frag[1-9]$/.test(e)))
    || step.phases[0];
  ctx.machine.jumpTo(step.id, first.id);
  ctx.j('phase_enter', { phase: first.id });
  ctx.overlays.showPill('Ведущий сбросил твою версию — собери заново', 'warn');
  ctx.seatSave.flushNow();
  render();
}

/* ---------- резервный блок ---------- */

function renderReserveBanner() {
  const holder = document.getElementById('reservebar');
  const which = ctx.syncData && ctx.syncData.reserve_active;
  if (!which || which === 'none' || ctx.inReserve || (ctx.machine && ctx.machine.done)) {
    holder.replaceChildren();
    return;
  }
  const step = ctx.normalized.reserve.find(s => s.kind === (which === 'talk' ? 'talk' : 'trainer'));
  if (!step || holder.dataset.which === which) return;
  holder.dataset.which = which;
  holder.replaceChildren(bigBtn('Доп-задание: ' + (step.title || ''), () => enterReserve(step), { kind: 'secondary' }));
}

let mainMachine = null;
function enterReserve(step) {
  mainMachine = ctx.machine;
  ctx.inReserve = true;
  ctx.machine = createMachine({ ...ctx.normalized, steps: [step] },
    { onJournal: (t, a) => ctx.j(t, a) });
  document.getElementById('reservebar').replaceChildren();
  startEntry(0, { advance: false });
}

function exitReserve() {
  ctx.inReserve = false;
  ctx.machine = mainMachine;
  document.getElementById('reservebar').dataset.which = '';
  ctx.j('phase_enter', { phase: ctx.machine.phase() ? ctx.machine.phase().id : 'done' });
  render();
}

/* ---------- клампинг после restore: не перепоказывать сделанное ---------- */

function clampToAcked() {
  const step = ctx.machine.step();
  if (!step) return;
  const acked = ctx.ackedCommits[step.id] || {};
  const idx = (pred) => step.phases.findIndex(pred);
  const cur = ctx.machine.position().phaseIndex;
  const jump = (i) => {
    if (i > cur && i >= 0) {
      ctx.machine.jumpTo(step.id, step.phases[i].id);
      ctx.j('phase_enter', { phase: step.phases[i].id });
    }
  };
  if (step.version) {
    const optIdx = idx(p => (p.elements || []).some(e => /^opt[1-9]$/.test(e)));
    const waitingIdx = idx((p, i) => !(p.elements || []).length && i > optIdx);
    const lastIdx = step.phases.length - 1;
    if (acked.choice) {
      const info = ctx.revealInfo(step.id);
      jump(info && info.open ? lastIdx : (waitingIdx >= 0 ? waitingIdx : lastIdx));
    } else if (acked.version && optIdx >= 0) jump(optIdx);
  }
  if (step.forecast && acked.forecast) {
    const commitIdx = idx(p => (p.elements || []).includes('btn_commit'));
    if (commitIdx >= 0 && cur <= commitIdx) jump(commitIdx + 1);
  }
}

/* ---------- boot ---------- */

async function boot() {
  if (!ctx.seat) { fatal('В ссылке нет места. Попроси ведущего дать твою ссылку'); return; }

  const t0 = performance.now();
  const { normalized, bankIndex } = await loadManifest('content/' + ctx.variant);
  ctx.normalized = normalized;
  ctx.bankIndex = bankIndex;
  ctx.ui = normalized.ui;
  titleEl.textContent = normalized.lesson.title;
  document.getElementById('stuck').textContent = ctx.ui.stuck_btn || 'Застрял';

  ctx.tele = createTele({ seat: parseInt(ctx.seat, 10) || ctx.seat,
                          demo: ctx.demo, ws: QP.has('ws') }).attach();
  ctx.tele.cleanup();
  ctx.tele.resend();
  // vendorBase — АБСОЛЮТНАЯ база от URL страницы: внутри classifier.js идёт dynamic import,
  // а относительный/голый спецификатор там резолвится от модуля (или падает сразу), не от страницы
  ctx.classifier = createClassifier({ bankIndex, assetsBase: ctx.assetsBase, demo: ctx.demo,
                                      vendorBase: new URL('.', location.href).href });
  ctx.overlays = createOverlays(ctx);

  // /restore: занятие могло ещё не начаться (no_run) — ждём старта ведущего
  let view;
  try {
    view = await fetchRestore({ seat: ctx.seat });
  } catch (e) {
    if (String(e.message).includes('409')) {
      screen.replaceChildren(h('div', { class: 'taskcard' },
        kidText('Занятие ещё не началось — подожди, ведущий вот-вот запустит')));
      setTimeout(boot, 4000);
      return;
    }
    screen.replaceChildren(h('div', { class: 'taskcard' },
      kidText(ctx.ui.offline_retry || 'Нет связи — повторю сам')));
    setTimeout(boot, 4000);
    return;
  }

  ctx.runId = view.run_id;
  const ssKey = 'z1_inst_' + ctx.runId + '_' + ctx.seat;
  try {
    const saved = JSON.parse(sessionStorage.getItem(ssKey) || 'null');
    ctx.instanceId = (saved && saved.id) || newInstanceId();
    sessionStorage.setItem(ssKey, JSON.stringify({ id: ctx.instanceId }));
  } catch (e) { ctx.instanceId = newInstanceId(); }
  // generation ≥1: сервер при claim свободного seat ставит max(1, присланное) — стартуя
  // с 0, клиент разошёлся бы с сервером после первого же коммита (свой seat = other_tab)
  ctx.generation = Math.max(1, view.writer_generation || 0);
  ctx.epoch = view.epoch || 0;

  ctx.journal = createJournal({ storageKey: 'z1_journal_' + ctx.runId + '_' + ctx.seat });
  const { payload } = applyRestore(view, ctx.journal);
  ctx.payload = payload;
  ctx.ackedCommits = view.acked || {};

  ctx.j = (type, args) => {
    const entry = ctx.journal.append(type, args);
    reduce(ctx.payload, entry);
    ctx.seatSave.markDirty();
    return entry;
  };

  ctx.acked = createAcked({
    seat: ctx.seat, runId: ctx.runId, instanceId: ctx.instanceId,
    getGeneration: () => ctx.generation, getEpoch: () => ctx.epoch,
    storageKey: 'z1_acked_' + ctx.runId + '_' + ctx.seat,
    onStatus: (st) => {
      if (st === 'sending') ctx.overlays.showPill(ctx.ui.sending || 'Отправляю…', 'info', true);
      else if (st === 'offline_retry') ctx.overlays.showPill(ctx.ui.offline_retry || 'Нет связи — повторю сам', 'warn', true);
      else ctx.overlays.hidePill();
    },
    onOtherTab,
  });

  ctx.seatSave = createSeatSave({
    seat: ctx.seat, runId: ctx.runId, lessonId: normalized.lesson.id, instanceId: ctx.instanceId,
    getGeneration: () => ctx.generation, setGeneration: (g) => { ctx.generation = g; },
    getState: () => {
      const pos = ctx.machine ? ctx.machine.position() : {};
      return pos.done ? 'done' : (pos.step || 'boot');
    },
    getPayload: () => ctx.payload,
    journal: ctx.journal,
    onOtherTab,
  });

  ctx.poll = createPoll({
    seat: ctx.seat,
    intervalMs: ctx.demo ? 1500 : 5000,
    onUpdate: onSync,
    onOffline: () => ctx.overlays.showPill('Нет связи — пробую снова…', 'warn'),
  });

  // машина: серверный acked_step — авторитет позиции шага; такт — из payload (журнал)
  let ackedStep = view.acked_step;
  let reserveStep = ackedStep && normalized.reserve.find(s => s.id === ackedStep);
  ctx.machine = createMachine(
    reserveStep ? { ...normalized, steps: [reserveStep] } : normalized,
    { onJournal: (t, a) => ctx.j(t, a) });
  if (reserveStep) { ctx.inReserve = true; mainMachine = createMachine(normalized, { onJournal: (t, a) => ctx.j(t, a) }); }

  // фон: эмбеддер + переобучение из payload (restore ≤3 c — не ждём модель)
  if (!ctx.demo) {
    ctx.classifier.warmup(() => {}).catch(() => {
      ctx.tele.push('boot_fail', { what: 'embedder' });
      ctx.overlays.showPill('Модель не загрузилась — обнови страницу', 'warn', true);
    });
  }

  if (ackedStep && ctx.normalized.stepById.get(ackedStep)) {
    const target = reserveStep || ackedStep;
    try { ctx.machine.jumpTo(reserveStep ? reserveStep.id : ackedStep, ctx.payload.phase); }
    catch (e) { ctx.machine.jumpTo(reserveStep ? reserveStep.id : ackedStep); }
    clampToAcked();
    rebuildModelIfTrained();
    maybeAutoMeasureBefore();
    render();
  } else {
    // первый вход seat: обычный старт ИЛИ догоняющий (окно открыто, current_step дальше первого)
    const cur = view.current_step;
    const firstId = normalized.steps[0].id;
    if (cur && cur !== firstId && normalized.steps.some(s => s.id === cur)) {
      const idx = normalized.steps.findIndex(s => s.id === cur);
      ctx.machine.jumpTo(cur);
      const stepCur = normalized.steps[idx];
      ctx.overlays.showCatchup(stepCur.catchup || '', () => startEntry(idx, { advance: false }));
      renderStepIndicator();
    } else {
      startEntry(0, { advance: false });
    }
  }

  ctx.acked.resendPending();   // F5 в окне «коммит послан, ответ потерян» — дослать те же op_id
  ctx.poll.start();
  ctx.tele.push('seat', { seat: ctx.seat, restore_ms: Math.round(performance.now() - t0) });
}

boot().catch(e => { console.error(e); fatal('Что-то сломалось: ' + e.message); });
