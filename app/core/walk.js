/* Эталонная проходимость (ТЗ-демка-з1 §1.2, §9 «Контент-CI», DoD п.2): скриптовое
 * прохождение занятия по манифесту БЕЗ браузера — тем же кодом, что живой клиент
 * (createMachine + reduce). Гоняется в CI на оба манифеста и в браузере на ?demo=1.
 *
 * Синтетический ребёнок действует ПО ДАННЫМ манифеста (identity-agnostic): раскладывает
 * train_core по верным корзинам (+ разок «вернуть»), смотрит вердикты probe_set,
 * собирает версию из фрагментов, коммитит, добавляет ловушки, снимает замеры, делает
 * прогноз и отмечает лучшую ловушку. Acked-действия (version/choice/forecast/captcha/
 * gate_enter/step_enter) НЕ пишутся в журнал — копятся списком acked (авторитет — сервер;
 * в CI сервера нет, в e2e их подтверждает настоящий /commit). */

import { createMachine } from './machine.js';
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
  const steps = includeReserve
    ? [...normalized.steps, ...normalized.reserve]
    : normalized.steps;
  const machine = createMachine({ ...normalized, steps }, { onJournal: j });

  const otherClass = cls => bankIndex.classIds.find(c => c !== cls);
  const role = r => bankIndex.byRole.get(r) || [];

  const walkStep = (step) => {
    visited.push(step.id);
    // вход в шаг — acked по построению (гейт или step_enter)
    acked.push(machine.entryRequirement());
    // R1 «до» — автозамер при входе в шаг с measure (before: auto)
    if (step.measure && step.measure.before === 'auto')
      j('measure_result', { phase: 'before', score: 1, of: step.measure.holdout.length });

    let optPhase = 0;            // маппинг opt-тактов по порядку: choice → predict → reason
    const optLists = [];
    if (step.version) optLists.push({ kind: 'choice', n: step.version.choice.options.length });
    if (step.forecast) optLists.push({ kind: 'predict', n: step.forecast.predict_options.length },
                                     { kind: 'reason', n: step.forecast.reason_options.length });

    for (let first = true; ; first = false) {
      if (!first && !machine.advancePhase()) break;
      const p = machine.phase();
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
        continue;
      }

      if (els.some(e => e.startsWith('basket_'))) {        // раскладка по одной + «вернуть»
        const train = role('train_core');
        if (!train.length) errors.push(step.id + ': в банке нет train_core');
        train.forEach((img, i) => {
          j('basket_assign', { img: img.id, basket: img.class });
          if (i === 0) {                                   // undo не наказуем (правило 7)
            j('basket_undo', {});
            j('basket_assign', { img: img.id, basket: img.class });
          }
        });
      }

      if (p.probe_set) {                                   // показанные вердикты — в журнал
        for (const pid of p.probe_set) {
          const img = bankIndex.byId.get(pid);
          if (!img) { errors.push(`probe_set: ${pid} нет в банке`); continue; }
          j('probe_result', { img: pid,
            label: img.expected_flip ? otherClass(img.class) : img.class,
            conf: 88, margin: 0.05 });
          // ребёнок замечает уверенный флип — отметка «она ошиблась!» (план-правок п.4)
          if (img.expected_flip) j('mistake_mark', { img: pid });
        }
      }

      if (els.includes('btn_pick') && step.type === 'trainer_act') {   // ловушки/добор по одной
        const pool = step.images_from_role ? role(step.images_from_role) : role('trap');
        if (!pool.length) errors.push(step.id + ': пустой пул для btn_pick');
        pool.forEach((img, i) => {
          j('trap_add', { img: img.id });
          if (i === 0) { j('trap_undo', {}); j('trap_add', { img: img.id }); }
        });
      }

      if (els.some(e => /^frag[1-9]$/.test(e))) {
        if (!p.slot) errors.push(`${step.id}.${p.id}: frag-такт без slot`);
        else j('frag_pick', { slot: p.slot, frag: 1 });
      }

      if (els.includes('free_text'))
        j('free_text_set', { text: 'она смотрит не на того, на кого надо' });

      if (els.some(e => /^opt[1-9]$/.test(e))) {
        const spec = optLists[optPhase++];
        if (!spec) errors.push(`${step.id}.${p.id}: opt-такт без соответствующего спека`);
        else if (spec.kind === 'choice')
          acked.push({ ack: 'commit', type: 'choice', step: step.id,
                       data: { option: step.version.choice.correct } });
        else j('forecast_pick', { field: spec.kind === 'predict' ? 'predict' : 'reason',
                                  option: step.forecast.expected[spec.kind === 'predict' ? 'predict' : 'reason'] });
      }

      if (els.includes('btn_commit')) {
        if (step.version && !acked.some(a => a.type === 'version' && a.step === step.id))
          acked.push({ ack: 'commit', type: 'version', step: step.id,
                       data: { slots: { ...payload.version.slots }, text: payload.version.free_text } });
        else if (step.forecast)
          acked.push({ ack: 'commit', type: 'forecast', step: step.id,
                       data: { ...payload.forecast } });
      }

      if (els.includes('btn_check') && !p.probe_set) {
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
    }
  };

  // проход: шаг → такты → следующий шаг (advanceStepAcked — после «ack» из acked-списка)
  walkStep(machine.step());
  while (machine.advanceStepAcked()) walkStep(machine.step());

  // пост-условия эталонного прохода — то, что обязано быть в конце занятия
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(machine.done, 'машина не дошла до done');
  const hasVersion = steps.some(s => s.version);
  const hasForecast = steps.some(s => s.forecast);
  const hasMeasure = steps.some(s => s.measure);
  const hasFinal = steps.some(s => s.type === 'final_card');
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
  if (hasFinal) need(payload.best_trap !== null, 'лучшая ловушка не отмечена');
  need(acked.filter(a => a.ack === 'gate_enter').length ===
       steps.filter(s => s.gate).length, 'не все гейты пройдены acked gate_enter');

  return { ok: errors.length === 0, errors, journal, acked, payload, visited };
}
