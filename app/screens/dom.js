/* DOM-хелперы детских экранов: короткий createElement + типовые виджеты.
 * Дизайн — клейморфизм (мягкие крупные формы, радиусы 16–24, толстые границы),
 * счётные правила конституции соблюдаются в вёрстке: touch ≥44px (кнопки ≥56px),
 * тексты детского UI ≤2 строк (лимит 120 симв держит валидатор манифеста). */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v === 'boolean') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Большая детская кнопка (высота ≥56px из CSS). kind: primary|secondary|ghost|danger */
export function bigBtn(label, onclick, { kind = 'primary', id, disabled = false } = {}) {
  return h('button', { class: 'kbtn kbtn-' + kind, id, disabled, onclick }, label);
}

/** Карточка-картинка (assets); interactive=false — просто показ, не интерактив. */
export function imgCard(src, { alt = '', big = false, draggable = false, onclick, id } = {}) {
  const img = h('img', { src, alt, draggable: draggable ? 'true' : 'false', class: 'imgpic' });
  return h('div', {
    class: 'imgcard' + (big ? ' imgcard-big' : '') + (onclick || draggable ? ' imgcard-tap' : ''),
    id, tabindex: onclick ? '0' : null, role: onclick ? 'button' : null, onclick,
  }, img);
}

/** Текст такта/инструкция (детский, ≤2 строк — лимит держит валидатор). */
export function kidText(text, { small = false } = {}) {
  return h('div', { class: 'kidtext' + (small ? ' kidtext-small' : ''), 'data-kid': '1' }, text || '');
}

/** Уверенность СЛОВАМИ (план-правок 17.07 п.2): маржи насыщают sigmoid при T=0.03 —
 * проценты дают ложную точность (медиана ≈97%). До перекалибровки — три ступени по маржам:
 * <0.033 (пилотный порог conf 75) «сомневается» · <0.12 «уверена» · дальше «очень уверена».
 * Старые записи журнала без margin — фолбэк по conf теми же порогами (75 / 98 ≙ 0.033 / 0.115). */
export function confWord(conf, margin) {
  const level = margin != null
    ? (margin < 0.033 ? 1 : margin < 0.12 ? 2 : 3)
    : (conf < 75 ? 1 : conf < 98 ? 2 : 3);
  return { level, word: ['сомневается', 'уверена', 'очень уверена'][level - 1] };
}

/** Вердикт коробки: метка класса + уверенность словами (полоска — по ступени, не процент). */
export function verdictCard(labelText, conf, { margin } = {}) {
  const { level, word } = confWord(conf, margin);
  return h('div', { class: 'verdict' },
    h('div', { class: 'verdict-label', 'data-kid': '1' }, labelText),
    h('div', { class: 'confbar' },
      h('div', { class: 'confbar-fill', style: 'width:' + [33, 66, 100][level - 1] + '%' })),
    h('div', { class: 'verdict-conf' }, 'коробка ' + word));
}

/** Счёт замера «X из Y» крупно + наглядный ряд ячеек ✓/✗ (по одной на картинку набора).
 * errors — подписи конкретных ошибок под ячейками («на картинке кот — сказала „собака“»). */
export function scoreCard(score, of, caption, { errors = [] } = {}) {
  const cells = Array.from({ length: of }, (_, i) =>
    h('span', { class: 'scorecell ' + (i < score ? 'ok' : 'bad') }, i < score ? '✓' : '✗'));
  return h('div', { class: 'scorecard' },
    caption ? h('div', { class: 'score-cap', 'data-kid': '1' }, caption) : null,
    h('div', { class: 'scorecells' }, ...cells),
    h('div', { class: 'score-big' }, score + ' из ' + of),
    errors.length ? h('div', { class: 'score-errors' },
      ...errors.map(t => h('div', { class: 'score-err', 'data-kid': '1' }, '✗ ' + t))) : null);
}

/** Вытащить «фразу-кнопку» из текста такта: 'Готов? Жми «Моя версия!»' → 'Моя версия!'.
 * Данные манифеста задают слова кнопки; фолбэка достаточно нейтрального. */
export function btnLabelFrom(text, fallback) {
  const m = /«([^»]+)»/.exec(text || '');
  return m ? m[1] : fallback;
}
