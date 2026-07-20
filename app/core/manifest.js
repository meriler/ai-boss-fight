/* Манифест-интерпретатор, часть 1: загрузка и нормализация (ТЗ-демка-з1 §1.1, §3).
 * Чистый модуль без DOM — им же пользуются валидатор и эталонная проходимость в CI (Node).
 * Идентичность занятия движок не знает: всё занятие — данные lesson.json/bank.json.
 *
 * Нормализация: у КАЖДОГО шага появляется steps[i].phases[] (такты — сущность манифеста):
 *  - trainer_act несёт явные phases[] (требование схемы);
 *  - шаги-«один такт» (gate, talk_chat, final_card) и cards_quiz разворачиваются
 *    в derived-такты по типовым формулам аннекса (ТЗ-демка-з1-схема-манифеста §1.4);
 *  - у каждого такта проставлен limitCount = len(elements)+len(overlays) (или формула
 *    для derived) — первый рубеж лимита ≤5 конституции, считает валидатор. */

/** Типовые формулы limitCount для derived-тактов (аннекс §1.4). */
function quizCardLimit(step, card) {
  const base = card.multi ? card.cells : (card.options ? card.options.length : 0);
  return base + (step.private_commit ? 1 : 0);
}

/** Развернуть шаг в такты. Возвращает массив phases (explicit или derived). */
export function derivePhases(step) {
  if (Array.isArray(step.phases) && step.phases.length) {
    return step.phases.map(p => ({
      ...p,
      elements: p.elements || [],
      overlays: p.overlays || [],
      derived: false,
      limitCount: (p.elements || []).length + (p.overlays || []).length,
    }));
  }
  // сахар одного такта: elements/overlays объявлены на верхнем уровне шага
  if (Array.isArray(step.elements) || Array.isArray(step.overlays)) {
    const elements = step.elements || [], overlays = step.overlays || [];
    return [{ id: 'main', elements, overlays, derived: true,
              limitCount: elements.length + overlays.length }];
  }
  switch (step.type) {
    case 'gate':
      return [{ id: 'gate', elements: [], overlays: [], derived: true, limitCount: 1 }];
    case 'slide':
      // слайд «для поговорить» (фаза 0.5): title/text/img/caption + одна кнопка
      return [{ id: 'main', elements: ['btn_next'], overlays: [], derived: true, limitCount: 1 }];
    case 'cards_quiz':
      return (step.cards || []).map(card => ({
        id: 'card_' + card.id, card, elements: [], overlays: [],
        derived: true, limitCount: quizCardLimit(step, card),
      }));
    case 'talk_chat':
      // панель чата ВСТРОЕНА в экран (после think-таймера) — overlay-иконку не даём:
      // она позволяла обойти «подумай молча» и дублировала панель (Codex-находка 11)
      return [{ id: 'main', elements: ['free_text'], overlays: [],
                derived: true, limitCount: 2 }];
    case 'final_card':
      // карточка дела → «лучшая ловушка» по одной (3 интерактива, аннекс) → закрытие дела.
      // Блок «что дальше»/next_block УБРАН (И4-Т E, решение владельца): допродавать ребёнку
      // запертыми будущими делами неэтично — финал только празднует сделанное.
      return [
        { id: 'card_view', elements: ['btn_next'], overlays: [], derived: true, limitCount: 1 },
        { id: 'best_trap', elements: ['img_current', 'btn_pick', 'btn_next'], overlays: [],
          derived: true, limitCount: 3 },
      ];
    default:
      return [{ id: 'main', elements: [], overlays: [], derived: true, limitCount: 0 }];
  }
}

/** Нормализованное занятие: {lesson, steps, stepById, phaseIndex} — вход движка. */
export function normalizeLesson(rawManifest) {
  const lesson = rawManifest.lesson;
  if (!lesson || !Array.isArray(lesson.steps)) throw new Error('манифест без lesson.steps');
  // постоянные интерактивные элементы состояния (ТЗ-платформа-v3 §1.1) — валидатор
  // считает лимит ≤5 ДО DOM (конституция п.11): на такте разгадки живут тапабельная
  // полка версий + «Проверить другую раскладку», на card_view — тапабельная полка
  const norm = steps => steps.map(s => {
    const phases = derivePhases(s);
    // дубли phase id внутри шага (аудит 18.07, п.14): журнал хранит только ID такта,
    // jumpTo/restore нашли бы всегда ПЕРВЫЙ одноимённый — дубль (включая derived
    // card_<id> из совпавших card.id) отклоняется на нормализации
    const seenPhase = new Set();
    for (const p of phases) {
      if (seenPhase.has(p.id)) throw new Error('дубль id такта: ' + s.id + '.' + p.id);
      seenPhase.add(p.id);
    }
    if (s.reveal && phases.length) phases[phases.length - 1].limitCount += 2;
    if (s.type === 'final_card')
      for (const p of phases) if (p.id === 'card_view') p.limitCount += 1;
    return { ...s, phases };
  });
  const steps = norm(lesson.steps);
  const reserve = norm(lesson.reserve_steps || []);
  const stepById = new Map();
  for (const s of [...steps, ...reserve]) {
    if (stepById.has(s.id)) throw new Error('дубль id шага: ' + s.id);
    stepById.set(s.id, s);
  }
  return { lesson, steps, reserve, stepById,
           ui: lesson.ui_texts || {}, hints: lesson.hints || {} };
}

/** Экранные семантики такта trainer_act — ОБЩИЙ классификатор walk/валидатора
 * (аудит 18.07, п.11): живой рендер выбирает ОДНУ ветку по приоритету, walk раньше
 * исполнял все подходящие независимо — такт с двумя семантиками проходил CI, но
 * часть интерактива была недоступна детям. Валидатор требует ≤1 семантики на такт,
 * walk исполняет ровно её. Вспомогательные элементы (btn_next/btn_undo/btn_skip/
 * btn_relayout/img_current) и оверлеи семантику не несут. */
export function phaseSemantics(phase) {
  const els = phase.elements || [];
  const sem = [];
  if (phase.probe_set) sem.push('probe');
  if (els.some(e => e.startsWith('basket_'))) sem.push('baskets');
  if (els.includes('btn_pick')) sem.push('pick');
  if (els.includes('btn_train')) sem.push('train');
  if (els.some(e => /^frag[1-9]$/.test(e))) sem.push('frag');
  if (els.includes('free_text')) sem.push('free_text');
  if (els.includes('btn_commit')) sem.push('commit');
  if (els.some(e => /^opt[1-9]$/.test(e))) sem.push('opt');
  if (!sem.length && els.includes('btn_check')) sem.push('check');
  return sem;
}

/** Индекс банка: картинки по id и по роли, классы. */
export function indexBank(bank) {
  const byId = new Map(), byRole = new Map();
  for (const img of bank.images || []) {
    byId.set(img.id, img);
    if (!byRole.has(img.role)) byRole.set(img.role, []);
    byRole.get(img.role).push(img);
  }
  return { bank, byId, byRole,
           classIds: (bank.classes || []).map(c => c.id),
           classById: new Map((bank.classes || []).map(c => [c.id, c])) };
}

/** Загрузка манифеста занятия по базовому URL каталога (браузер и Node 18+: fetch). */
export async function loadManifest(baseUrl) {
  const get = async name => {
    const r = await fetch(baseUrl.replace(/\/$/, '') + '/' + name);
    if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
    return r.json();
  };
  const [manifest, bank] = await Promise.all([get('lesson.json'), get('bank.json')]);
  if (manifest.lesson.bank !== bank.id)
    throw new Error(`lesson.bank=${manifest.lesson.bank} ≠ bank.id=${bank.id}`);
  return { normalized: normalizeLesson(manifest), bankIndex: indexBank(bank), manifest, bank };
}
