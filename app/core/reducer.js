/* ЕДИНЫЙ редьюсер журнала действий (ТЗ-демка-з1 §1.1, словарь ЗАКРЫТ на 14 типах —
 * аннекс ТЗ-демка-з1-схема-манифеста §2, машинная форма content/schema/journal.schema.json).
 *
 * Одна функция — два входа: живое применение действий ребёнка И replay журнала при restore.
 * Отдельной merge-машинерии нет by design. Payload мутируется копией (структурное шарение
 * не нужно — объёмы детские), неизвестный тип = ошибка (реестр закрыт, эрозия запрещена).
 *
 * ВНЕ редьюсера (не журнал): acked-действия (/commit: version, choice, forecast, captcha,
 * gate_enter, step_enter — авторитет сервер), серверное состояние (/sync: chat, react,
 * reveal, гейты), телеметрия (/tele: hints, stuck). */

/** Пустой payload снапшота (форма же уходит в /save целиком). */
export function initialPayload() {
  return {
    phase: null,                    // текущий такт ВНУТРИ шага (шаг — acked, приходит с сервера)
    baskets: [],                    // журнал раскладки акта 1: [{img, basket}] (порядок = стек undo)
    traps: [],                      // добавленные ловушки акта 2: [img] (тот же undo-паттерн)
    version: { slots: {}, free_text: null },
    quiz: {},                       // {cardId: answer}
    captcha: {},                    // {cardId: [включённые ячейки]}
    forecast: { predict: null, reason: null },
    buffer: [],                     // прогнозы буфера: [{img, predict}]
    best_trap: null,
    probes: {},                     // показанные вердикты: {img: {label, conf, margin}} — F5 не перепоказывает
    measures: { before: null, after: null },   // показанные счёты замеров (+версия состава, детали)
    mistakes: [],                   // пробы, где ребёнок отметил «она ошиблась!» (наблюдение, модель не меняет)
  };
}

/** Применить одно действие журнала {type, args} к payload. Возвращает ТОТ ЖЕ payload. */
export function reduce(payload, action) {
  const { type, args = {} } = action;
  switch (type) {
    case 'phase_enter':
      payload.phase = args.phase;
      break;
    case 'basket_assign':
      payload.baskets.push({ img: args.img, basket: args.basket });
      break;
    case 'basket_undo':
      payload.baskets.pop();
      break;
    case 'trap_add':
      payload.traps.push(args.img);
      break;
    case 'trap_undo':
      payload.traps.pop();
      break;
    case 'frag_pick':
      payload.version.slots[args.slot] = args.frag;
      break;
    case 'free_text_set':
      payload.version.free_text = args.text;
      break;
    case 'quiz_answer':
      payload.quiz[args.card] = args.answer;
      break;
    case 'captcha_toggle': {
      const cells = payload.captcha[args.card] || (payload.captcha[args.card] = []);
      const i = cells.indexOf(args.cell);
      if (i >= 0) cells.splice(i, 1); else cells.push(args.cell);
      break;
    }
    case 'forecast_pick':
      payload.forecast[args.field] = args.option;
      break;
    case 'buffer_predict':
      payload.buffer.push({ img: args.img, predict: args.predict });
      break;
    case 'best_trap_pick':
      payload.best_trap = args.img;
      break;
    case 'probe_result':
      payload.probes[args.img] = { label: args.label, conf: args.conf, margin: args.margin };
      break;
    case 'mistake_mark': {
      // страховка от старых снапшотов: mistakes появился позже initialPayload
      const list = payload.mistakes || (payload.mistakes = []);
      if (!list.includes(args.img)) list.push(args.img);
      break;
    }
    case 'measure_result':
      payload.measures[args.phase] = {
        score: args.score, of: args.of,
        details: args.details || null,                       // подписи каждой ошибки
        model_n: args.model_n, model_sig: args.model_sig,    // версия состава модели
        baskets_sig: args.baskets_sig,                       // раскладка на момент замера (stale-чек «Было»)
      };
      break;
    default:
      throw new Error('неизвестный тип действия журнала: ' + type +
                      ' (словарь закрыт — новый тип только правкой схемы и аннекса)');
  }
  return payload;
}

/** Replay: накатить на payload записи журнала с rev БОЛЬШЕ серверного (правило restore §1.1). */
export function replay(payload, entries, serverRev) {
  const tail = entries.filter(e => e.rev > serverRev).sort((a, b) => a.rev - b.rev);
  for (const e of tail) reduce(payload, e);
  return payload;
}

/** Производные представления (view-хелперы поверх журнальной формы). */
export function basketsByImg(payload) {
  const m = {};
  for (const { img, basket } of payload.baskets) m[img] = basket;
  return m;
}
