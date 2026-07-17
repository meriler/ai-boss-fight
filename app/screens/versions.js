/* Экраны развития — версии состава обучения (ТЗ-платформа-v3 §3.1, остаток дорожки А):
 *  - В-1 полка версий: лента-чипы в зоне обучения. На тактах с интерактивами задания
 *    чипы ПАССИВНЫ ВСЕГДА (0 из лимита ≤5); тап доступен только на «спокойных» экранах
 *    (reveal_view, card_view) — и там полка входит в счёт лимита ОДНИМ интерактивом
 *    (весь блок — одна кнопка, карточка версии листается в модалке);
 *  - В-1 карточка версии: состав словами, когда научена, её замер, одна кнопка «Назад»;
 *  - В-2 «черновик ≠ учёное»: расхождение sig корзин с sig активной версии — активный чип
 *    приглушён, бейдж «в корзинах уже по-другому», единственное действие — «Научить»;
 *  - В-5 рост ячейками: два ряда одних holdout-миниатюр (было/стало), стрелки на
 *    изменившихся, счёт — подписью (линза П4: результат показом, число подписью).
 * Веса нигде не хранятся: версия = состав, модель пересобирается train() (§3.1). */

import { h, bigBtn, kidText } from './dom.js';
import { compositionSig } from '../engine/classifier.js';
import { activeStableModel } from '../core/reducer.js';

const SHELF_CAP = 9;   // кап полки: лента показывает последние 9, счётчик честный (§3.1)

/** Примеры обучения из текущего состояния корзин+ловушек (то, что заморозит «Научить»). */
export function trainExamples(ctx) {
  const ex = ctx.payload.baskets.map(b => ({ img: b.img, class: b.basket }));
  for (const t of ctx.payload.traps) {
    const img = ctx.bankIndex.byId.get(t);
    if (img) ex.push({ img: t, class: img.class });
  }
  return ex;
}

/** Состав словами для train_commit.counts: {classId: n, traps: n}. */
export function countsOf(ctx) {
  const counts = { traps: ctx.payload.traps.length };
  for (const b of ctx.payload.baskets) counts[b.basket] = (counts[b.basket] || 0) + 1;
  return counts;
}

/** counts по готовому composition («Научить без фотки» В-6: состав не из корзин). */
export function countsFromComposition(ctx, composition) {
  const traps = new Set(ctx.payload.traps);
  const counts = { traps: 0 };
  for (const c of composition || []) {
    if (traps.has(c.img)) counts.traps += 1;
    else counts[c.class] = (counts[c.class] || 0) + 1;
  }
  return counts;
}

/** Версия, по которой коробка думает СЕЙЧАС: sig фактически обученной модели;
 * до готовности эмбеддера — последняя стабильная (её и пересоберёт restore). */
function activeSig(ctx) {
  if (ctx.classifier.ready && ctx.classifier.exampleCount())
    return ctx.classifier.modelInfo().sig;
  const stable = activeStableModel(ctx.payload);
  return stable ? stable.sig : (ctx.payload.model ? ctx.payload.model.sig : null);
}

/** В-2: черновик ≠ учёное — состав корзин/ловушек разошёлся с активной версией. */
export function isDraft(ctx) {
  const m = ctx.payload.model;
  if (!m) return false;
  return compositionSig(trainExamples(ctx)) !== m.sig;
}

/** Состав словами: из counts версии («Коты: 8 · Собаки: 8 · ловушки: 4»),
 * фолбэк — подсчёт по composition, совсем без данных — «картинок: n». */
function compositionWords(ctx, rec) {
  const parts = [];
  let counts = rec.counts;
  if (!counts && (rec.composition || []).length) {
    counts = {};
    for (const c of rec.composition) counts[c.class] = (counts[c.class] || 0) + 1;
  }
  if (counts) {
    for (const cls of ctx.bankIndex.bank.classes || [])
      if (counts[cls.id]) parts.push(cls.label + ': ' + counts[cls.id]);
    if (counts.traps) parts.push('ловушки: ' + counts.traps);
  }
  return parts.length ? parts.join(' · ') : 'картинок: ' + rec.n;
}

/** Замер этой версии (по sig): показанный счёт из payload.measures, если он её. */
function measureOfVersion(ctx, rec) {
  const m = ctx.payload.measures;
  for (const key of ['after', 'before'])
    if (m[key] && m[key].model_sig === rec.sig) return m[key];
  return null;
}

/* ---------- В-1: полка версий ---------- */

/** Лента-чипы версий. tappable=true — только «спокойные» экраны (reveal_view, card_view):
 * весь блок = ОДНА кнопка (вход в счёт лимита), открывает карточку активной версии. */
export function versionShelf(ctx, { tappable = false } = {}) {
  const hist = ctx.payload.model_history || [];
  if (!hist.length) return null;
  const shown = hist.slice(-SHELF_CAP);
  const act = activeSig(ctx);
  const draft = isDraft(ctx);
  const chips = shown.map(rec => {
    const isActive = rec.sig === act;
    return h('span', {
      class: 'vchip' + (isActive ? ' vchip-active' : '') +
             (rec.volatile ? ' vchip-volatile' : '') +
             (isActive && draft ? ' vchip-draft' : ''),
    }, 'v' + rec.version + ' · ' + rec.n + (rec.volatile ? ' 📷' : ''));
  });
  const rows = [
    hist.length > SHELF_CAP ? h('span', { class: 'vshelf-more' }, '…ещё ' + (hist.length - SHELF_CAP)) : null,
    ...chips,
  ];
  const badge = draft ? h('div', { class: 'vshelf-badge', 'data-kid': '1' },
    'В корзинах уже по-другому — коробка думает по-старому') : null;
  if (!tappable) {
    return h('div', { class: 'vshelf' }, h('div', { class: 'row vshelf-row' }, ...rows), badge);
  }
  const shelf = h('div', {
    class: 'vshelf vshelf-tap', id: 'version_shelf', role: 'button', tabindex: '0',
    onclick: () => openVersionCard(ctx),
  }, h('div', { class: 'row vshelf-row' }, ...rows), badge);
  return shelf;
}

/* ---------- В-1: карточка версии (модалка с листанием, одна кнопка «Назад») ---------- */

export function openVersionCard(ctx, startIdx) {
  const hist = ctx.payload.model_history || [];
  if (!hist.length) return;
  let idx = startIdx != null ? startIdx : hist.length - 1;
  const show = () => {
    const rec = hist[idx];
    const act = activeSig(ctx);
    const measured = measureOfVersion(ctx, rec);
    const when = rec.ts ? new Date(rec.ts).toLocaleTimeString('ru-RU',
      { hour: '2-digit', minute: '2-digit' }) : null;
    const body = [
      h('div', { class: 'modal-title', 'data-kid': '1' },
        'Версия v' + rec.version + (rec.sig === act ? ' — активная' : '')),
      kidText(compositionWords(ctx, rec)),
      when ? kidText('Научена в ' + when, { small: true }) : null,
      rec.volatile ? kidText('📷 С твоей фоткой — в проверки не идёт', { small: true }) : null,
      measured ? kidText('Её проверка: ' + measured.score + ' из ' + measured.of, { small: true })
               : kidText('Эту версию ещё не проверяли', { small: true }),
      kidText('Каждый раз, когда учишь коробку, — новая версия', { small: true }),
    ];
    const nav = [];
    if (hist.length > 1) {
      nav.push(bigBtn('‹', () => { idx -= 1; show(); },
        { kind: 'ghost', id: 'vcard_prev', disabled: idx === 0 }));
      nav.push(bigBtn('›', () => { idx += 1; show(); },
        { kind: 'ghost', id: 'vcard_next', disabled: idx === hist.length - 1 }));
    }
    nav.push(bigBtn('Назад', () => ctx.overlays.closeModal(), { kind: 'secondary', id: 'vcard_back' }));
    body.push(h('div', { class: 'modal-actions' }, ...nav));
    ctx.overlays.openModal(...body);
  };
  show();
}

/* ---------- В-5: рост ячейками ---------- */

/** Совпадают ли наборы двух замеров (details по img): сравнение честно только
 * на одном holdout-наборе (§3.1). */
export function sameMeasureSet(before, after) {
  const a = (before.details || []).map(d => d.img);
  const b = (after.details || []).map(d => d.img);
  return a.length > 0 && a.length === b.length && a.every((img, i) => img === b[i]);
}

/** Два ряда одних holdout-миниатюр: что говорила старая версия, что говорит новая;
 * стрелки на изменившихся; счёт — подписью (П4). */
export function growthCells(ctx, before, after) {
  const classOne = id => {
    const c = ctx.bankIndex.classById.get(id);
    return (c && (c.label_one || c.label)) || id || '?';
  };
  const cell = (d) => {
    const img = ctx.bankIndex.byId.get(d.img);
    return h('div', { class: 'gcell ' + (d.ok ? 'gcell-ok' : 'gcell-bad') },
      img ? h('img', { class: 'gcell-pic', src: ctx.assetsBase + img.src, alt: '' }) : null,
      h('span', { class: 'gcell-mark' }, d.ok ? '✓' : '✗'),
      h('span', { class: 'gcell-label' }, d.label ? classOne(d.label) : '—'));
  };
  const rowOf = (m, cap) => h('div', { class: 'growthrow' },
    h('div', { class: 'growthcap' },
      h('span', { class: 'growthcap-name', 'data-kid': '1' }, cap),
      h('span', { class: 'growthcap-score' }, m.score + ' из ' + m.of)),
    h('div', { class: 'growthcells' }, ...(m.details || []).map(cell)));
  const arrows = h('div', { class: 'growtharrows' },
    ...(after.details || []).map((d, i) => {
      const b = (before.details || [])[i];
      const changed = b && (b.ok !== d.ok || b.label !== d.label);
      return h('span', { class: 'growtharrow' + (changed ? ' on' : '') }, changed ? '↓' : ' ');
    }));
  return h('div', { class: 'growth', id: 'growth' },
    rowOf(before, 'Было'), arrows, rowOf(after, 'Стало'));
}
