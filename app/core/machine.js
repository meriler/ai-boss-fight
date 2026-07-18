/* Машина состояний занятия (ТЗ-демка-з1 §1.1): генерится из манифеста, шаги → такты.
 * Чистый модуль без DOM/сети — используется клиентом, эталонной проходимостью (CI)
 * и демо-режимом ?demo=1.
 *
 * Разделение авторитетов:
 *  - переход ШАГА и гейт — acked-действия по построению (/commit: step_enter/gate_enter);
 *    машина их не выполняет сама, а ВОЗВРАЩАЕТ требование {ack: 'gate_enter'|'step_enter'} —
 *    транспорт (acked.js) обязан получить подтверждение сервера до advance;
 *  - переход ТАКТА внутри шага — локальный, пишется в журнал (phase_enter). */

export function createMachine(normalized, { onJournal } = {}) {
  const steps = normalized.steps;
  let si = 0, pi = 0, done = false;

  const emit = (type, args) => { if (onJournal) onJournal(type, args); };

  const api = {
    get done() { return done; },
    step() { return done ? null : steps[si]; },
    phase() { return done ? null : steps[si].phases[pi]; },
    position() {
      return done ? { done: true }
        : { done: false, step: steps[si].id, phase: steps[si].phases[pi].id,
            stepIndex: si, phaseIndex: pi, of: steps.length };
    },

    /** Что нужно, чтобы ВОЙТИ в шаг i: гейт (если объявлен) или обычный step_enter.
     * Оба — acked по построению (§1.1/§4.1), клиент ждёт ack сервера. */
    entryRequirement(i = si) {
      const s = steps[i];
      return s.gate ? { ack: 'gate_enter', step: s.id, kind: s.gate.kind }
                    : { ack: 'step_enter', step: s.id };
    },

    /** Переход к следующему такту внутри шага; false — тактов больше нет. */
    advancePhase() {
      if (done) return false;
      if (pi + 1 >= steps[si].phases.length) return false;
      pi += 1;
      emit('phase_enter', { phase: steps[si].phases[pi].id });
      return true;
    },

    /** Переход к следующему шагу — вызывать ТОЛЬКО после ack сервера на entryRequirement. */
    advanceStepAcked() {
      if (done) return false;
      if (si + 1 >= steps.length) { done = true; return false; }
      si += 1; pi = 0;
      emit('phase_enter', { phase: steps[si].phases[0].id });
      return true;
    },

    /** Восстановление позиции после restore: acked-шаг с сервера + такт из журнала.
     * Неизвестный phaseId — ошибка (аудит 18.07, п.18): молчаливый откат к фазе 0
     * прятал бы битую позицию; явный откат делает вызывающий код (catch → jumpTo(step)). */
    jumpTo(stepId, phaseId) {
      const i = steps.findIndex(s => s.id === stepId);
      if (i < 0) throw new Error('jumpTo: нет шага ' + stepId);
      let p = 0;
      if (phaseId) {
        p = steps[i].phases.findIndex(ph => ph.id === phaseId);
        if (p < 0) throw new Error('jumpTo: нет такта ' + stepId + '.' + phaseId);
      }
      si = i;
      pi = p;
      done = false;
    },

    /** Восстановление завершённого занятия (снапшот state='done'): F5 после финала
     * не перепоказывает последний шаг (аудит 18.07, п.5). */
    restoreDone() { done = true; },

    /** Контрольная точка подсказки уровня 3: 'stepId.phaseId' из hints.restore_to.
     * ТОЛЬКО внутри текущего шага (аудит 18.07, п.8): межшаговый переход обязан идти
     * через acked step_enter/gate_enter — валидатор требует того же от контента. */
    restoreTo(anchor) {
      const [stepId, phaseId] = String(anchor).split('.');
      if (!done && steps[si] && steps[si].id !== stepId)
        throw new Error('restoreTo: ' + anchor + ' вне текущего шага ' + steps[si].id +
                        ' — межшаговый переход только через acked entry');
      api.jumpTo(stepId, phaseId);
      emit('phase_enter', { phase: steps[si].phases[pi].id });
    },
  };
  return api;
}
