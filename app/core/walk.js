/* Эталонная проходимость (ТЗ-демка-з1 §1.2, §9 «Контент-CI», DoD п.2): скриптовое
 * прохождение занятия по манифесту БЕЗ браузера — тем же кодом, что живой клиент
 * (createMachine + reduce). Гоняется в CI на оба манифеста и в браузере на ?demo=1.
 *
 * Синтетический ребёнок действует ПО ДАННЫМ манифеста (identity-agnostic): раскладывает
 * train_core по верным корзинам (+ разок «вернуть»), смотрит вердикты probe_set,
 * собирает версию из фрагментов, коммитит, добавляет ловушки, снимает замеры, делает
 * прогноз и отмечает лучшую ловушку. Acked-действия (version/choice/forecast/captcha/
 * gate_enter/step_enter) НЕ пишутся в журнал — копятся списком acked (авторитет — сервер;
 * в CI сервера нет, в e2e их подтверждает настоящий /commit).
 *
 * Семантика такта — через ОБЩИЙ классификатор phaseSemantics (аудит 18.07, п.11):
 * walk исполняет РОВНО ОДНУ экранную ветку, как живой рендер; двойная семантика на
 * такте — ошибка walk (и отдельная ошибка валидатора).
 *
 * Резервы (аудит 18.07, п.17): режим includeReserve моделирует ЖИВОЙ сценарий —
 * вход в резерв ПОСРЕДИ шага (машина основного маршрута приостанавливается на своей
 * позиции), полный проход обоих резервов отдельными машинами, возврат через acked
 * step_enter приостановленного шага (клиентский exitReserve) и продолжение с ТОЙ ЖЕ
 * позиции — а не дописывание резервов в конец маршрута. */

import { createMachine } from './machine.js';
import { phaseSemantics } from './manifest.js';
import { reduce, initialPayload } from './reducer.js';

const TS0 = 1700000000000;   // детерминизм: ts информационный, порядок задаёт rev

export function walkLesson(normalized, bankIndex, { includeReserve = false } = {}) {
  const errors = [], journal = [], acked = [], visited = [];
  let rev = 0;
  const payload = initialPayload();
  const j = (type, args) => {
    rev += 1;
    const entry = { type, args, rev, ts: TS0 + rev };
    journal.push(entry);
    try { reduce(payload, entry); }
    catch (e) { errors.push(`редьюсер: ${e.message}`); }
  };
  // пост-условия считаются по ВСЕМУ пройденному набору шагов (основные + резервы)
  const allSteps = includeReserve
    ? [...normalized.steps, ...normalized.reserve]
    : normalized.steps;
  const machine = createMachine(normalized, { onJournal: j });
  let trainVersion = 0;   // версии состава обучения (train_commit, фаза 0.5)
  let reserveDone = !includeReserve;

  const otherClass = cls => bankIndex.classIds.find(c => c !== cls);
  const role = r => bankIndex.byRole.get(r) || [];

  /* одна экранная ветка такта — по общему классификатору (как живой рендер) */
  const doPhase = (m, step, p, optLists, optState) => {
    const els = p.elements || [];

    if (p.card) {                                        // derived-такт cards_quiz
      const card = p.card;
      if (card.multi) {
        for (const cell of card.correct) j('captcha_toggle', { card: card.id, cell });
        acked.push({ ack: 'commit', type: 'captcha', step: step.id,
                     data: { card: card.id, cells: [...card.correct] } });
      } else {
        j('quiz_answer', { card: card.id, answer: card.correct });
      }
      return;
    }

    const sem = phaseSemantics(p);
    if (sem.length > 1)
      errors.push(`${step.id}.${p.id}: ${sem.length} экранных семантик на такте (${sem.join(', ')}) — живой рендер покажет одну`);

    switch (sem[0]) {
      case 'probe':                                      // показанные вердикты — в журнал
        for (const pid of p.probe_set) {
          const img = bankIndex.byId.get(pid);
          if (!img) { errors.push(`probe_set: ${pid} нет в банке`); continue; }
          j('probe_result', { img: pid,
            label: img.expected_flip ? otherClass(img.class) : img.class,
            conf: 88, margin: 0.05 });
          // обязательный вопрос «Коробка права?» на КАЖДОМ вердикте (И3-Т п.8):
          // эталонный ребёнок отвечает честно — на флипе «Ошиблась!», иначе «Права»
          j('probe_judgement', { img: pid, saw_mistake: !!img.expected_flip, correct: true });
        }
        break;

      case 'baskets': {
        if (step.traps_from_bank) {
          // акт 2 (И4-Т B): разметка ловушек В КОРЗИНЫ — метка из банка, журналим trap_add
          const pool = role('trap');
          if (!pool.length) errors.push(step.id + ': пустой пул ловушек');
          pool.forEach((img, i) => {
            if (i === 0 && pool.length > 1) j('trap_skip', { img: img.id });   // «Пропустить»
            j('trap_add', { img: img.id });
            if (i === 0) { j('trap_undo', {}); j('trap_add', { img: img.id }); }
          });
          break;
        }
        const train = role('train_core');                // акт 1: раскладка по одной + «вернуть»
        if (!train.length) errors.push(step.id + ': в банке нет train_core');
        train.forEach((img, i) => {
          j('basket_assign', { img: img.id, basket: img.class });
          if (i === 0) {                                 // undo не наказуем (правило 7)
            j('basket_undo', {});
            j('basket_assign', { img: img.id, basket: img.class });
          }
        });
        break;
      }

      case 'pick': {                                     // ловушки: настоящий выбор
        if (step.type !== 'trainer_act') break;
        const pool = step.images_from_role ? role(step.images_from_role) : role('trap');
        if (!pool.length) errors.push(step.id + ': пустой пул для btn_pick');
        pool.forEach((img, i) => {
          if (i === 0 && pool.length > 1) j('trap_skip', { img: img.id });   // «Пропустить» не наказуем
          j('trap_add', { img: img.id });
          if (i === 0) { j('trap_undo', {}); j('trap_add', { img: img.id }); }
        });
        break;
      }

      case 'train': {
        // «Научить» — журнальный факт (фаза 0.5): версия состава обучения
        trainVersion += 1;
        const composition = [
          ...payload.baskets.map(b => ({ img: b.img, class: b.basket })),
          ...payload.traps.map(t => {
            const img = bankIndex.byId.get(t);
            return { img: t, class: img ? img.class : '?' };
          }),
        ];
        const counts = { traps: payload.traps.length };
        for (const b of payload.baskets) counts[b.basket] = (counts[b.basket] || 0) + 1;
        j('train_commit', { version: trainVersion, sig: 'walk-v' + trainVersion,
                            n: composition.length, composition, counts, engine: 'knn' });
        break;
      }

      case 'frag':
        if (!p.slot) errors.push(`${step.id}.${p.id}: frag-такт без slot`);
        else j('frag_pick', { slot: p.slot, frag: 1 });
        break;

      case 'free_text':
        j('free_text_set', { text: 'она смотрит не на того, на кого надо' });
        break;

      case 'opt': {
        const spec = optLists[optState.i++];
        if (!spec) errors.push(`${step.id}.${p.id}: opt-такт без соответствующего спека`);
        else if (spec.kind === 'choice')
          acked.push({ ack: 'commit', type: 'choice', step: step.id,
                       data: { option: step.version.choice.correct } });
        else j('forecast_pick', { field: spec.kind === 'predict' ? 'predict' : 'reason',
                                  option: step.forecast.expected[spec.kind === 'predict' ? 'predict' : 'reason'] });
        break;
      }

      case 'commit':
        if (step.version && !acked.some(a => a.type === 'version' && a.step === step.id))
          acked.push({ ack: 'commit', type: 'version', step: step.id,
                       data: { slots: { ...payload.version.slots }, text: payload.version.free_text } });
        else if (step.forecast)
          acked.push({ ack: 'commit', type: 'forecast', step: step.id,
                       data: { ...payload.forecast } });
        break;

      case 'check': {
        const forecastDone = acked.some(a => a.type === 'forecast' && a.step === step.id);
        if (step.measure && !payload.measures.after)
          j('measure_result', { phase: 'after', score: 3, of: step.measure.holdout.length,
            details: step.measure.holdout.map((hid, i) => ({ img: hid, label: null, conf: null, ok: i < 3 })),
            model_n: payload.baskets.length + payload.traps.length,
            model_sig: 'walk', baskets_sig: 'walk' });
        else if (step.forecast && forecastDone) {
          const img = bankIndex.byId.get(step.forecast.img);
          if (img) j('probe_result', { img: img.id, label: img.class, conf: 91, margin: 0.05 });
        }
        break;
      }

      default:   // такт без экранной семантики: интро (btn_next), ожидание, финальные блоки
        break;
    }

    if ((p.overlays || []).includes('buffer')) {         // ожидание занято буфером
      const b = role('buffer')[payload.buffer.length];
      if (b) j('buffer_predict', { img: b.id, predict: b.class });
    }

    if (step.type === 'final_card' && p.id === 'best_trap') {
      const trap = payload.traps[0];
      if (!trap) errors.push('final_card: нет добавленных ловушек для best_trap');
      else j('best_trap_pick', { img: trap });
    }

    if (step.type === 'talk_chat')
      acked.push({ ack: 'chat', step: step.id, text: 'она не думает — она сравнивает картинки' });
  };

  /* проход тактов шага текущей машины; allowSuspend — можно ли посреди шага уйти в резерв */
  const walkStep = (m, { allowSuspend = false } = {}) => {
    const step = m.step();
    visited.push(step.id);
    // вход в шаг — acked по построению (гейт или step_enter)
    acked.push(m.entryRequirement());
    // R1 «до» — автозамер при входе в шаг с measure (before: auto — резерв-добор)
    if (step.measure && step.measure.before === 'auto')
      j('measure_result', { phase: 'before', score: 1, of: step.measure.holdout.length });
    // «до починки» из ПРОБЫ акта 1 (И4-Т A+D, before: from_probe): тот же контрольный
    // набор проверен в акте 1 — «Было» это его результат, не скрытый авто-замер
    if (step.measure && step.measure.before === 'from_probe') {
      const ids = step.measure.holdout;
      if (ids.every(id => payload.probes[id])) {
        const details = ids.map(id => {
          const v = payload.probes[id]; const img = bankIndex.byId.get(id);
          return { img: id, label: v.label, conf: v.conf, ok: !!img && v.label === img.class };
        });
        j('measure_result', { phase: 'before', score: details.filter(d => d.ok).length,
          of: ids.length, details, model_sig: 'walk', baskets_sig: 'walk' });
      }
    }

    // маппинг opt-тактов по порядку: choice → predict → reason
    const optLists = [];
    if (step.version) optLists.push({ kind: 'choice', n: step.version.choice.options.length });
    if (step.forecast) optLists.push({ kind: 'predict', n: step.forecast.predict_options.length },
                                     { kind: 'reason', n: step.forecast.reason_options.length });
    const optState = { i: 0 };

    for (let first = true; ; first = false) {
      if (!first && !m.advancePhase()) break;
      doPhase(m, step, m.phase(), optLists, optState);
      // резерв ПОСРЕДИ шага: после первого такта первого многотактного шага —
      // основная машина приостанавливается на своей позиции (как ctx.machine у клиента)
      if (first && allowSuspend && !reserveDone && step.phases.length > 1)
        enterReserves(m);
    }
  };

  /* вход в резерв посреди шага + возврат через acked-восстановление (клиентский exitReserve) */
  const enterReserves = (m) => {
    reserveDone = true;
    const susp = m.position();               // приостановленная позиция основной машины
    for (const r of normalized.reserve) {
      const rm = createMachine({ ...normalized, steps: [r] }, { onJournal: j });
      walkStep(rm);
    }
    // возврат: acked step_enter приостановленного шага, потом журнальный такт (аудит п.6)
    acked.push({ ack: 'step_enter', step: susp.step, resume: true });
    j('phase_enter', { phase: susp.phase });
    const back = m.position();
    if (back.step !== susp.step || back.phase !== susp.phase)
      errors.push(`резерв: возврат не вернул приостановленную позицию ` +
                  `(ждали ${susp.step}.${susp.phase}, машина на ${back.step}.${back.phase})`);
  };

  // проход: шаг → такты → следующий шаг (advanceStepAcked — после «ack» из acked-списка)
  walkStep(machine, { allowSuspend: true });
  while (machine.advanceStepAcked()) walkStep(machine, { allowSuspend: true });
  if (includeReserve && !reserveDone)
    errors.push('резервы: не нашлось многотактного шага для входа посреди шага');

  // пост-условия эталонного прохода — то, что обязано быть в конце занятия
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(machine.done, 'машина не дошла до done');
  const hasVersion = allSteps.some(s => s.version);
  const hasForecast = allSteps.some(s => s.forecast);
  const hasMeasure = allSteps.some(s => s.measure);
  const hasFinal = allSteps.some(s => s.type === 'final_card');
  const trainN = role('train_core').length;
  need(payload.baskets.length === trainN,
       `корзины: ${payload.baskets.length} картинок разложено, ждали ${trainN} (undo снял и вернул одну)`);
  if (hasVersion) {
    need(acked.some(a => a.type === 'version'), 'нет acked-коммита version');
    need(acked.some(a => a.type === 'choice'), 'нет acked-коммита choice');
  }
  if (hasForecast) {
    need(acked.some(a => a.type === 'forecast'), 'нет acked-коммита forecast');
    need(payload.forecast.predict !== null && payload.forecast.reason !== null,
         'forecast_pick не заполнил predict/reason');
  }
  if (hasMeasure) need(payload.measures.before && payload.measures.after,
                       'замеры before/after не записаны');
  // обязательный вопрос на пробах (И3-Т п.8): у каждого вердикта probe_set есть ответ
  const probeIds = allSteps.flatMap(s => s.phases.flatMap(p => p.probe_set || []));
  need(probeIds.every(id => (payload.probe_judgements || {})[id]),
       'не на каждом вердикте пробы есть probe_judgement («Коробка права?»)');
  if (hasFinal) need(payload.best_trap !== null, 'лучшая ловушка не отмечена');
  const trainTacts = allSteps.reduce((s, st) =>
    s + st.phases.filter(p => (p.elements || []).includes('btn_train')).length, 0);
  if (trainTacts) need(payload.model && payload.model.version === trainTacts &&
                       (payload.model_history || []).length === trainTacts,
                       'версии состава обучения (train_commit) не сошлись с числом тактов «Научить»');
  need(acked.filter(a => a.ack === 'gate_enter').length ===
       allSteps.filter(s => s.gate).length, 'не все гейты пройдены acked gate_enter');
  if (includeReserve) {
    for (const r of normalized.reserve)
      need(visited.includes(r.id), `резерв ${r.id} не пройден`);
    need(acked.some(a => a.ack === 'step_enter' && a.resume),
         'возврат из резерва без acked-восстановления основного шага');
  }

  return { ok: errors.length === 0, errors, journal, acked, payload, visited };
}
