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

/** Уверенность словами поверх КАЛИБРОВАННОГО процента (фаза 0.5): conf уже прошёл
 * кусочно-линейную шкалу банка (scaleConf) — чистые 85–95, спорные 55–75, потолок 95.
 * Ступени по калиброванному проценту: <75 «сомневается» (ниже пилотного порога флипа) ·
 * <90 «уверена» · дальше «очень уверена». Слово остаётся главным (детский экран),
 * процент — уточнение без ложной точности сигмоиды. */
export function confWord(conf) {
  const level = conf < 75 ? 1 : conf < 90 ? 2 : 3;
  return { level, word: ['сомневается', 'уверена', 'очень уверена'][level - 1] };
}

/** Вердикт коробки: метка класса + слово + калиброванный процент (полоска = процент). */
export function verdictCard(labelText, conf, { margin } = {}) {
  const { word } = confWord(conf);
  return h('div', { class: 'verdict' },
    h('div', { class: 'verdict-label', 'data-kid': '1' }, labelText),
    h('div', { class: 'confbar' },
      h('div', { class: 'confbar-fill', style: 'width:' + Math.max(0, Math.min(100, conf)) + '%' })),
    h('div', { class: 'verdict-conf' }, 'коробка ' + word + ' — ' + Math.round(conf) + '%'));
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
