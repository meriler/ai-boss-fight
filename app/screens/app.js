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
import { initialPayload, reduce, activeStableModel, beforeMeasureHonest,
         measureBindingIntact } from '../core/reducer.js';
import { createJournal } from '../core/journal.js';
import { fetchRestore, applyRestore, createSeatSave, claimInstanceId } from '../core/save.js';
import { createAcked } from '../core/acked.js';
import { createPoll } from '../core/poll.js';
import { createTele } from '../core/tele.js';
import { createClassifier, allowedEngines } from '../engine/classifier.js';
import { h, bigBtn, kidText } from './dom.js';
import { createOverlays } from './overlays.js';
import { renderPhase, basketsSig } from './phases.js';

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
  suspendedMain: null,       // {step, phase} основной машины на время резерва (в снапшоте)
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
  // счётчик визитов такта: «первый показ» отличим от повторного захода на тот же такт
  // (миниатюра разгадки, строка о первом v2) — поллинг-ререндеры визит не меняют
  const posKey = screen.dataset.step + '|' + screen.dataset.phase + '|' + screen.dataset.entry;
  const posChanged = posKey !== ctx.local._posKey;
  if (posChanged) {
    ctx.local._posKey = posKey;
    ctx.local._posVisit = (ctx.local._posVisit || 0) + 1;
  }
  if (ctx.entering) { renderEntry(); return; }
  if (ctx.machine.done) { renderDone(); return; }
  const content = renderPhase(ctx);
  const phase = ctx.machine.phase();
  // интро-такты («только btn_next») несут текст в самой карточке — шапка дублировала бы его
  const introOnly = phase && (phase.elements || []).length &&
    (phase.elements || []).every(e => e === 'btn_next');
  screen.replaceChildren(
    phase && phase.text && !introOnly ? h('div', { class: 'phasetext', 'data-kid': '1' }, phase.text) : '',
    modelErrorBanner(),
    content || '');
  ctx.overlays.refreshOverlays();
  // узкий режим (столбик зон): при входе в такт кнопка действия видна сразу — автоскролл
  // к активной зоне (план И3 п.1: «Проверить» пряталась под сгибом). Широкий конвейер
  // (≥1100px) весь на экране — скроллить нечего
  if (posChanged && !(window.matchMedia && window.matchMedia('(min-width: 1100px)').matches))
    scrollToActiveZone();
}
ctx.render = render;

function scrollToActiveZone() {
  requestAnimationFrame(() => {
    const act = document.querySelector('.zone-active .kbtn:not(:disabled)')
      || document.querySelector('.zone-active');
    if (act) act.scrollIntoView({ block: 'center' });
    else window.scrollTo(0, 0);
  });
}

// живое сужение окна ПОСРЕДИ такта (Codex-ревью И3, минор 1): конвейер сложился в
// столбик — кнопка действия могла уехать под сгиб; докручиваем, как при входе в такт
if (window.matchMedia) {
  const mqWide = window.matchMedia('(min-width: 1100px)');
  const onMq = (e) => { if (!e.matches) scrollToActiveZone(); };
  if (mqWide.addEventListener) mqWide.addEventListener('change', onMq);
  else if (mqWide.addListener) mqWide.addListener(onMq);   // старые WebKit
}

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
  const myEntering = ctx.entering;   // замораживаем: reset из поллинга мог отменить вход,
                                     // поздний ack не должен двигать уже сброшенную машину
  const { req, advance } = myEntering;
  const btn = document.getElementById('btn_gate');
  if (btn) btn.disabled = true;
  try {
    await ctx.acked.commit(req.ack, req.step, data);
    if (ctx.entering !== myEntering) return;   // вход отменён (handleVersionReset)
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
    if (ctx.entering !== myEntering) return;   // вход уже отменён — ошибку не показываем
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

/** Журнальный прыжок на такт ВНУТРИ текущего шага (фаза 0.5): «разложить заново»,
 * «проверить другую раскладку», цикл добора ловушек. Позиция переживает F5 через
 * phase_enter в журнале — тем же механизмом, что обычные переходы тактов. */
ctx.jumpToPhase = (stepId, phaseId) => {
  ctx.machine.jumpTo(stepId, phaseId);
  ctx.j('phase_enter', { phase: phaseId });
  ctx.seatSave.flushNow();
  render();
};

/* Колбэк, привязанный к месту планирования: сработает, только если ребёнок всё ещё
 * на том же шаге/такте ТОЙ ЖЕ машины. Закрывает гонки: двойной тап по вариантам,
 * поздний ответ сети, авто-таймер после ручного «Дальше», вход в резерв при
 * коммите в полёте (находки Codex-ревью 1/6/7/10). */
ctx.guarded = (fn) => {
  const m = ctx.machine, p = m.position();
  const key = (p.step || '') + '/' + (p.phaseIndex ?? -1);
  return (...args) => {
    if (ctx.machine !== m) return;
    const q = ctx.machine.position();
    if ((q.step || '') + '/' + (q.phaseIndex ?? -1) !== key) return;
    return fn(...args);
  };
};

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
  // пул починки шага (ловушки/добор) — для честности «до» (beforeMeasureHonest)
  const hasPick = step.phases.some(p => (p.elements || []).includes('btn_pick'));
  const poolIds = (step.images_from_role || hasPick)
    ? (ctx.bankIndex.byRole.get(step.images_from_role || 'trap') || []).map(i => i.id)
    : [];
  // привязка колбэка к МЕСТУ планирования (Codex-ревью И3, находка 1): машина (вход в
  // резерв подменяет ctx.machine), шаг и версия активной модели. Уход в резерв, переход
  // шага или новый train_commit за время ожидания whenReady — замер «до» уже не
  // принадлежит этому месту и не пишется в payload
  const bind = { machine: ctx.machine, stepId: step.id,
                 modelVersion: ctx.payload.model ? ctx.payload.model.version : null };
  ctx.classifier.whenReady().then(() => {
    if (!ctx.classifier.ready) return;   // whenReady резолвится и на ошибке эмбеддера
    const cur = ctx.machine.done ? null : ctx.machine.step();
    if (!measureBindingIntact(bind, { machine: ctx.machine, stepId: cur && cur.id,
          modelVersion: ctx.payload.model ? ctx.payload.model.version : null })) return;
    if (ctx.payload.measures.before || !ctx.classifier.exampleCount()) return;
    // БАГ #33 (прогон 18.07, карточка «3 → 3 из 4»): колбэк отложен на whenReady и мог
    // замерить «до» УЖЕ ПОЧИНЕННОЙ моделью (догоняющий без v1, «Сделай за меня до
    // точки», рестарт run) — модель с ловушками этого шага не годится как «до»
    if (!beforeMeasureHonest(ctx.payload, poolIds)) return;
    const r = ctx.classifier.measure(step.measure.holdout);
    const mi = ctx.classifier.modelInfo();
    // identity модели с замером (sig состава + engine + params_rev): stale-«Было» после
    // переразметки/restore/смены движка инвалидируется (п.3 + Codex-ревью 18.07 п.5)
    ctx.j('measure_result', { phase: 'before', score: r.score, of: r.of, details: r.details,
                              model_n: mi.n, model_sig: mi.sig, baskets_sig: basketsSig(ctx),
                              engine: mi.engine,
                              ...(mi.params_rev != null ? { params_rev: mi.params_rev } : {}) });
    ctx.tele.push('measure', { phase: 'before', score: r.score, of: r.of, model_sig: mi.sig,
                               engine: mi.engine, params_rev: mi.params_rev });
    render();
  });
}

ctx.modelGate = (btn) => {
  if (ctx.classifier.ready) return btn;
  btn.disabled = true;
  btn.classList.add('waitmodel');
  const old = btn.textContent;
  // ошибка эмбеддера уже известна к моменту рендера — честный текст сразу
  btn.textContent = (ctx.classifier.error ? 'Коробка не загрузилась'
    : (ctx.ui.restoring || 'Коробка вспоминает…'));
  ctx.classifier.whenReady().then(() => {
    if (!document.contains(btn)) return;
    // ошибка эмбеддера НЕ разблокирует кнопку (закалка 18.07, critical embedder):
    // модель не готова — обучение/замер упали бы на отсутствующих фичах. Путь
    // восстановления — плашка с «Попробовать ещё раз» (render), не эта кнопка
    if (!ctx.classifier.ready) {
      btn.textContent = 'Коробка не загрузилась';
      return;
    }
    btn.disabled = false;
    btn.classList.remove('waitmodel');
    btn.textContent = old;
  });
  return btn;
};

/** Плашка ошибки эмбеддера с рабочим путём восстановления (закалка 18.07): повторный
 * warmup; при успехе модель тихо пересобирается и кнопки оживают штатным modelGate. */
ctx.retryWarmup = () => {
  if (ctx.classifier.ready) return;
  ctx.overlays.showPill('Пробую загрузить…', 'info', true);
  ctx.classifier.warmup(() => {}).then(() => {
    ctx.overlays.hidePill();
    rebuildModelIfTrained();
    maybeAutoMeasureBefore();
    render();
  }).catch(() => {
    ctx.tele.push('boot_fail', { what: 'embedder_retry' });
    ctx.overlays.showPill('Опять не вышло — проверь интернет и попробуй ещё', 'warn', true);
    render();
  });
};

function modelErrorBanner() {
  if (ctx.demo || !ctx.classifier || ctx.classifier.ready || !ctx.classifier.error) return '';
  const step = ctx.machine && !ctx.machine.done && ctx.machine.step();
  if (!step || step.type !== 'trainer_act') return '';   // модель нужна только тренажёру
  return h('div', { class: 'model-error' },
    kidText('Коробка-модель не загрузилась — обучение и проверки пока не работают', { small: true }),
    bigBtn('Попробовать ещё раз', () => ctx.retryWarmup(), { kind: 'secondary', id: 'btn_model_retry' }));
}

/** Тихо восстановить обученность после F5: «Научить» — журнальный факт (train_commit,
 * фаза 0.5), поэтому восстановление модели идёт ИЗ COMPOSITION версии состава,
 * а не из эвристик позиции. Раскладка могла уже уехать дальше (переразметка, добор) —
 * модель честно остаётся той версии, которую ребёнок реально заморозил кнопкой.
 * V2 (§3.3): восстанавливается последняя НЕ-volatile версия — фотка (класс C) живёт
 * только в памяти вкладки, volatile-версия после F5 невоспроизводима by design. */
function rebuildModelIfTrained() {
  const model = activeStableModel(ctx.payload);
  if (!model || !(model.composition || []).length) return;
  ctx.classifier.whenReady().then(() => {
    if (!ctx.classifier.ready) return;   // ошибка эмбеддера — пересборки нет (плашка + retry)
    ctx.classifier.train(model.composition);
    // движок пересборки разошёлся с движком версии (fallback непилотированного банка
    // или осознанный ?engine=): модель РЕАЛЬНО другая — identity §3.1 различает пары
    // sig+engine. Морозим новой версией, иначе каждый новый замер вечно stale против
    // старого engine и «Дальше» не появляется (закалка 18.07, major fallback)
    const mi = ctx.classifier.modelInfo();
    if ((model.engine || 'knn') !== mi.engine) {
      const version = ((ctx.payload.model && ctx.payload.model.version) || 0) + 1;
      ctx.j('train_commit', { version, sig: mi.sig, n: mi.n, composition: model.composition,
                              counts: model.counts || null, engine: mi.engine,
                              ...(mi.params_rev != null ? { params_rev: mi.params_rev } : {}) });
      ctx.tele.push('retrained', { n: mi.n, version, sig: mi.sig, engine: mi.engine,
                                   params_rev: mi.params_rev, reason: 'engine_fallback_rebuild' });
    }
    maybeAutoMeasureBefore();
    render();
  });
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
    // claim-only takeover (аудит 18.07, critical 3): seat захвачен, наш буфер НЕ ушёл
    // на сервер; чистый заход от серверного снапшота (§1.1)
    const resp = await ctx.seatSave.takeover();
    if (resp && resp.ok) {
      ctx.acked.clearPending();   // операции старого поколения не должны пугать новую вкладку
      location.reload();
    } else fatal('Не получилось перехватить. Обнови страницу');
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
  // reset на экране входа в шаг (закалка 18.07, critical reset): вход отменяется —
  // submitEntry сверяет ссылку и поздний ack не двигает уже сброшенную машину
  ctx.entering = null;
  if (ctx.inReserve) {
    // в резерве ctx.machine — ДРУГАЯ машина, version-шага в ней нет (jumpTo бросал бы).
    // Резерв не рвём: прыгает ОСНОВНАЯ машина, точка возврата — пересборка версии;
    // suspended уезжает в снапшот, phase_enter запишет exitReserve
    if (mainMachine) {
      try { mainMachine.jumpTo(step.id, first.id); } catch (e) { /* нет такта — старт шага */ }
      ctx.suspendedMain = { step: step.id, phase: first.id };
    }
    ctx.overlays.showPill('Ведущий сбросил твою версию — соберёшь заново после доп-задания', 'warn');
    ctx.seatSave.flushNow();
    render();
    return;
  }
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
    // повторное включение ТОГО ЖЕ резерва обязано снова показать баннер (закалка 18.07):
    // застрявший dataset.which делал второй показ невозможным
    delete holder.dataset.which;
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
  const pos = mainMachine.position();
  // приостановленная позиция основной машины уезжает в снапшот (аудит 18.07, п.7):
  // F5 внутри резерва восстановит и резерв, и ТОЧНУЮ фазу, куда вернуться
  ctx.suspendedMain = pos.done ? null : { step: pos.step, phase: pos.phase };
  ctx.inReserve = true;
  ctx.machine = createMachine({ ...ctx.normalized, steps: [step] },
    { onJournal: (t, a) => ctx.j(t, a) });
  document.getElementById('reservebar').replaceChildren();
  startEntry(0, { advance: false });
}

/** Выход из резерва — через acked-восстановление основного шага (аудит 18.07, п.6):
 * иначе серверный acked_step оставался резервным и F5 снова открывал резерв. */
async function exitReserve() {
  const main = mainMachine;
  const step = main && main.step();
  if (step) {
    try {
      await ctx.acked.commit('step_enter', step.id, {});
    } catch (e) {
      // other_tab: overlay перехвата уже показан, машину не трогаем
      if (e && e.resp && e.resp.error === 'other_tab') return;
      // прочий терминальный отказ — возвращаемся локально: не запирать ребёнка в резерве
    }
  }
  ctx.inReserve = false;
  ctx.suspendedMain = null;
  ctx.machine = main;
  document.getElementById('reservebar').dataset.which = '';
  ctx.j('phase_enter', { phase: ctx.machine.phase() ? ctx.machine.phase().id : 'done' });
  ctx.seatSave.flushNow();
  render();
}

/* ---------- клампинг после restore: не перепоказывать сделанное ---------- */

function clampToAcked() {
  const step = ctx.machine.step();
  if (!step) return;
  // эксперимент «проверить другую раскладку» (фаза 0.5): позиция ЗАКОННО раньше
  // закоммиченных version/choice — вперёд не клампим, F5 возвращает в эксперимент
  if ((ctx.payload.experiments || {})[step.id]) return;
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
    // commit последним тактом валидатор теперь запрещает; min — защита от падения
    // на undefined при старом контенте (аудит 18.07, п.15)
    if (commitIdx >= 0 && cur <= commitIdx)
      jump(Math.min(commitIdx + 1, step.phases.length - 1));
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
  // идентичность вкладки (аудит 18.07, critical «две вкладки»): sessionStorage переживает
  // F5 той же вкладки, но ДУБЛИРОВАНИЕ вкладки его копирует — живой документ держит
  // Web Lock своего id, дубль честно берёт новый id и ловит other_tab
  const ssKey = 'z1_inst_' + ctx.runId + '_' + ctx.seat;
  ctx.instanceId = await claimInstanceId({ key: ssKey });
  // generation ≥1: сервер при claim свободного seat ставит max(1, присланное) — стартуя
  // с 0, клиент разошёлся бы с сервером после первого же коммита (свой seat = other_tab)
  ctx.generation = Math.max(1, view.writer_generation || 0);
  ctx.epoch = view.epoch || 0;

  // журнал с владельцем записей (аудит 18.07, critical 4): localStorage общий между
  // вкладками — replay берёт только хвост ТЕКУЩЕГО (instance, generation)
  ctx.journal = createJournal({ storageKey: 'z1_journal_' + ctx.runId + '_' + ctx.seat,
                                owner: { inst: ctx.instanceId, gen: ctx.generation } });
  const { payload } = applyRestore(view, ctx.journal);
  ctx.payload = payload;
  ctx.ackedCommits = view.acked || {};

  // Движок (ТЗ-платформа-v3 §2.2, identity модели §3.1 — Codex-ревью 18.07, находка 4):
  // явный флаг ?engine= (осознанное перекрытие) > ДВИЖОК АКТИВНОЙ СТАБИЛЬНОЙ ВЕРСИИ
  // (restore обязан пересобрать ту же модель: раньше F5 head-версии без флага молча
  // переобучал её kNN-ом) > манифест > kNN. Детям — только движки, пилотированные на
  // ЭТОМ банке; непилотированный честно откатывается на kNN, и это — событие
  // телеметрии engine_fallback, не только console.warn (находка 5).
  const restoredModel = activeStableModel(ctx.payload);
  const wantEngine = QP.get('engine') || (restoredModel && restoredModel.engine)
    || normalized.lesson.engine || 'knn';
  ctx.engineId = allowedEngines(bankIndex.bank).includes(wantEngine) ? wantEngine : 'knn';
  if (ctx.engineId !== wantEngine) {
    console.warn('движок «' + wantEngine + '» не пилотирован на банке — работаем на knn');
    ctx.tele.push('engine_fallback', {
      want: wantEngine, used: ctx.engineId,
      from: QP.get('engine') === wantEngine ? 'query'
        : (restoredModel && restoredModel.engine === wantEngine ? 'restore' : 'manifest'),
    });
  }
  // vendorBase — АБСОЛЮТНАЯ база от URL страницы: внутри classifier.js идёт dynamic import,
  // а относительный/голый спецификатор там резолвится от модуля (или падает сразу), не от страницы
  ctx.classifier = createClassifier({ bankIndex, assetsBase: ctx.assetsBase, demo: ctx.demo,
                                      vendorBase: new URL('.', location.href).href,
                                      engine: ctx.engineId });
  screen.dataset.engine = ctx.engineId;   // машинное поле для e2e, людям не видно

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
    getEpoch: () => ctx.epoch,          // epoch в /save: задержанный снапшот не переживает сброс
    getState: () => {
      const pos = ctx.machine ? ctx.machine.position() : {};
      return pos.done ? 'done' : (pos.step || 'boot');
    },
    getPayload: () => ctx.payload,
    // позиция основной машины при уходе в резерв — в снапшоте (аудит 18.07, п.7)
    getSuspended: () => (ctx.inReserve && ctx.suspendedMain) || null,
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
  if (reserveStep) {
    ctx.inReserve = true;
    mainMachine = createMachine(normalized, { onJournal: (t, a) => ctx.j(t, a) });
    // F5 внутри резерва (аудит 18.07, п.7): suspended-позиция основной машины хранится
    // в снапшоте — восстанавливаем И шаг, И фазу. Фолбэк для старых снапшотов без
    // suspended — current_step ведущего (хотя бы не начало занятия)
    const susp = view.suspended;
    if (susp && susp.step && normalized.stepById.get(susp.step)) {
      try { mainMachine.jumpTo(susp.step, susp.phase); }
      catch (e) { try { mainMachine.jumpTo(susp.step); } catch (e2) { /* старт занятия */ } }
    } else {
      const cur = view.current_step;
      if (cur && normalized.stepById.get(cur)) { try { mainMachine.jumpTo(cur); } catch (e) { /* нет такта — старт шага */ } }
    }
    const mp = mainMachine.position();
    ctx.suspendedMain = mp.done ? null : { step: mp.step, phase: mp.phase };
  }

  // фон: эмбеддер + переобучение из payload (restore ≤3 c — не ждём модель)
  if (!ctx.demo) {
    ctx.classifier.warmup(() => {}).catch(() => {
      ctx.tele.push('boot_fail', { what: 'embedder' });
      ctx.overlays.showPill('Модель не загрузилась', 'warn', true);
      render();   // плашка с «Попробовать ещё раз» (закалка 18.07: честный отказ + восстановление)
    });
  }

  if (view.state === 'done' && !reserveStep) {
    // занятие завершено (аудит 18.07, п.5): F5 после финала показывает «Дело закрыто»,
    // а не перепоказывает последний шаг (acked_step остаётся финальным — раньше boot
    // его чтил и открывал шаг заново)
    ctx.machine.restoreDone();
    render();
  } else if (ackedStep && ctx.normalized.stepById.get(ackedStep)) {
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
