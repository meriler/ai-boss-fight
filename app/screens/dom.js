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

/** Вердикт коробки: метка класса + живой процент уверенности (полоска). */
export function verdictCard(labelText, conf) {
  return h('div', { class: 'verdict' },
    h('div', { class: 'verdict-label', 'data-kid': '1' }, labelText),
    h('div', { class: 'confbar' },
      h('div', { class: 'confbar-fill', style: 'width:' + Math.max(4, conf) + '%' })),
    h('div', { class: 'verdict-conf' }, 'уверена на ' + conf + '%'));
}

/** Счёт замера «X из Y» крупно. */
export function scoreCard(score, of, caption) {
  return h('div', { class: 'scorecard' },
    caption ? h('div', { class: 'score-cap', 'data-kid': '1' }, caption) : null,
    h('div', { class: 'score-big' }, score + ' из ' + of));
}

/** Вытащить «фразу-кнопку» из текста такта: 'Готов? Жми «Моя версия!»' → 'Моя версия!'.
 * Данные манифеста задают слова кнопки; фолбэка достаточно нейтрального. */
export function btnLabelFrom(text, fallback) {
  const m = /«([^»]+)»/.exec(text || '');
  return m ? m[1] : fallback;
}
