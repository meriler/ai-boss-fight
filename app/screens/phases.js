/* Рендерер ТАКТОВ (ТЗ-демка-з1 §1.1: такт — сущность манифеста; §2 — компоненты 1–9).
 * Идентичность занятия не знает: всё из manifest/bank (элементы такта, тексты, картинки,
 * классы корзин). Диспетчеризация по type шага + elements[] такта. Правила:
 *  - подача картинок ПО ОДНОЙ (лимит ≤5 на такт держит уже манифест, DOM это зеркалит);
 *  - «вернуть» (undo) — не наказуем: только журнал, флага помощи не вешает (правило 7);
 *  - три зоны коробки «вход → обучение → выход» видимы во всех режимах trainer_act
 *    (правило 9): пустая зона приглушена, не спрятана;
 *  - F5 не перепоказывает сделанное: показанные вердикты/замеры берутся из payload. */

import { h, bigBtn, imgCard, kidText, verdictCard, scoreCard, btnLabelFrom } from './dom.js';
import { compositionSig } from '../engine/classifier.js';

const role = (ctx, r) => ctx.bankIndex.byRole.get(r) || [];

/** Класс словом в ед. числе для подписей ошибок («кот», «собака»): bank.classes[].label_one,
 * фолбэк — label корзины. */
const classOne = (ctx, id) => {
  const c = ctx.bankIndex.classById.get(id);
  return (c && (c.label_one || c.label)) || id;
};

/** Подпись раскладки корзин СЕЙЧАС — сверяется с baskets_sig замера (stale-«Было»). */
export function basketsSig(ctx) {
  return compositionSig(ctx.payload.baskets.map(b => ({ img: b.img, class: b.basket })));
}

/* Детерминированная перемешка подачи (сид = seat + роль): банк хранит картинки
 * классами подряд — без перемешки ребёнок жмёт одну корзину 8 раз не глядя.
 * Свой порядок на seat (не спишешь у соседа), стабильный между рендерами и F5. */
function shuffledRole(ctx, r) {
  const list = [...role(ctx, r)];
  let s = 2166136261 >>> 0;
  const seed = String(ctx.seat) + ':' + r;
  for (let i = 0; i < seed.length; i++) s = ((s ^ seed.charCodeAt(i)) * 16777619) >>> 0;
  for (let i = list.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) >>> 0;
    const j = s % (i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}
const classLabel = (ctx, id) => {
  const c = ctx.bankIndex.classById.get(id);
  return c ? c.label : id;
};
const hasEl = (p, name) => (p.elements || []).includes(name);
const hasRe = (p, re) => (p.elements || []).some(e => re.test(e));

/* ---------- общее: сборка примеров и обучение ---------- */

export function trainExamples(ctx) {
  const ex = ctx.payload.baskets.map(b => ({ img: b.img, class: b.basket }));
  for (const t of ctx.payload.traps) {
    const img = ctx.bankIndex.byId.get(t);
    if (img) ex.push({ img: t, class: img.class });
  }
  return ex;
}

/* ---------- зоны коробки ---------- */

function zones(ctx, step, { input, box, output }) {
  const zone = (name, title, content, active) =>
    h('section', { class: 'zone zone-' + name + (active ? ' zone-active' : ''), 'data-zone': name },
      h('div', { class: 'zone-title' }, title),
      h('div', { class: 'zone-body' }, ...[content].flat().filter(Boolean)));
  // зона коробки — не пустая полка: маскот (коробку ВИДНО, а не только слово)
  // + альбом, ЧЕМ она научена (миниатюры корзин — обучение видимо и правдоподобно)
  const boxBody = [boxMascot(), ...[box.content].flat().filter(Boolean), boxAlbum(ctx)];
  return h('div', { class: 'zones' },
    zone('in', 'Картинки — вход', input.content, input.active),
    zone('box', 'Коробка — учится', boxBody, box.active),
    zone('out', 'Ответ — выход', output.content, output.active));
}

function boxMascot({ big = false } = {}) {
  return h('img', { class: 'box-mascot' + (big ? ' box-mascot-big' : ''),
                    src: 'assets/box-mascot.png', alt: 'обучаемая коробка' });
}

/** Альбом обучения: чем наполнены корзины (раскладка + ловушки), сгруппировано по классам. */
function boxAlbum(ctx) {
  const groups = new Map();
  const add = (classId, imgId) => {
    if (!groups.has(classId)) groups.set(classId, []);
    groups.get(classId).push(imgId);
  };
  for (const b of ctx.payload.baskets) add(b.basket, b.img);
  for (const imgId of ctx.payload.traps || []) {
    const img = ctx.bankIndex.byId.get(imgId);
    if (img) add(img.class, imgId);
  }
  if (!groups.size) return null;
  const MAXTHUMBS = 8;
  const rows = [];
  for (const [classId, imgs] of groups) {
    const cls = ctx.bankIndex.classById.get(classId);
    rows.push(h('div', { class: 'box-album-row' },
      h('span', { class: 'box-album-label' }, (cls ? cls.label : classId) + ' · ' + imgs.length),
      ...imgs.slice(-MAXTHUMBS).map(id => {
        const img = ctx.bankIndex.byId.get(id);
        return img ? h('img', { class: 'box-album-thumb', src: ctx.assetsBase + img.src, alt: '' }) : null;
      }).filter(Boolean),
      imgs.length > MAXTHUMBS ? h('span', { class: 'box-album-more' }, '+' + (imgs.length - MAXTHUMBS)) : null));
  }
  return h('div', { class: 'box-album' }, ...rows);
}

function boxStatus(ctx) {
  const n = ctx.classifier.exampleCount();
  if (!ctx.classifier.ready) return ctx.ui.restoring || 'Коробка вспоминает…';
  return n ? ('Знает картинок: ' + n) : 'Пока ничему не научена';
}

/* ---------- ленты подачи по одной ---------- */

function basketsFeed(ctx, step, phase) {
  const list = shuffledRole(ctx, 'train_core');
  const assigned = {};
  for (const b of ctx.payload.baskets) assigned[b.img] = b.basket;
  const current = list.find(i => !(i.id in assigned));
  const doneN = ctx.payload.baskets.length;

  const baskets = (phase.elements || []).filter(e => e.startsWith('basket_'))
    .map(e => e.slice('basket_'.length));

  const assign = (basket) => {
    if (!current) return;
    ctx.j('basket_assign', { img: current.id, basket });
    ctx.render();
  };

  const input = [];
  if (current) {
    input.push(h('div', { class: 'feedcount' }, 'картинка ' + (doneN + 1) + ' из ' + list.length));
    const card = imgCard(ctx.assetsBase + current.src, { big: true, draggable: true, id: 'img_current' });
    card.dataset.img = current.id;   // e2e/дебаг: какая картинка сейчас в подаче (порядок перемешан)
    card.querySelector('img').addEventListener('dragstart', ev => {
      ev.dataTransfer.setData('text/plain', current.id);
      ev.dataTransfer.effectAllowed = 'move';
    });
    input.push(card);
  } else {
    input.push(kidText('Всё разложено! Жми «Дальше»'));
  }
  const basketRow = h('div', { class: 'row baskets' },
    ...baskets.map(bid => {
      const el = h('div', {
        class: 'basket', id: 'basket_' + bid, role: 'button', tabindex: '0',
        onclick: () => assign(bid),
      },
        h('div', { class: 'basket-lid' }),
        h('div', { class: 'basket-label' }, classLabel(ctx, bid)),
        h('div', { class: 'basket-count' }, String(ctx.payload.baskets.filter(b => b.basket === bid).length)));
      el.addEventListener('dragover', ev => { ev.preventDefault(); el.classList.add('over'); });
      el.addEventListener('dragleave', () => el.classList.remove('over'));
      el.addEventListener('drop', ev => { ev.preventDefault(); el.classList.remove('over'); assign(bid); });
      return el;
    }));
  input.push(basketRow);
  const controls = h('div', { class: 'row' });
  if (hasEl(phase, 'btn_undo'))
    controls.append(bigBtn('Вернуть', () => {
      if (!ctx.payload.baskets.length) return;
      ctx.j('basket_undo', {});
      ctx.tele.push('basket_undo', { step: step.id });
      ctx.render();
    }, { kind: 'ghost', id: 'btn_undo', disabled: !ctx.payload.baskets.length }));
  if (hasEl(phase, 'btn_next'))
    controls.append(bigBtn('Дальше', () => {
      ctx.tele.push('basket_done', countsByClass(ctx));
      ctx.advancePhase();
    }, { id: 'btn_next', disabled: !!current }));
  input.push(controls);

  return zones(ctx, step, {
    input: { content: input, active: true },
    box: { content: kidText(boxStatus(ctx), { small: true }), active: false },
    output: { content: kidText('Здесь коробка будет отвечать', { small: true }), active: false },
  });
}

function countsByClass(ctx) {
  const out = {};
  for (const b of ctx.payload.baskets) out['n_' + b.basket] = (out['n_' + b.basket] || 0) + 1;
  return out;
}

function trainPhase(ctx, step, phase) {
  ctx.local.reactionOk = false;   // до обучения «Получилось!» безусловна — не показываем
  const btn = bigBtn('Научить!', async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    const boxEl = document.querySelector('.zone-box');
    boxEl && boxEl.classList.add('learning');
    const examples = trainExamples(ctx);
    const n = ctx.classifier.train(examples);
    // «Научить» — журнальный факт (фаза 0.5): состав замораживается в версию v1/v2/…;
    // restore после F5 переобучает модель из composition последней версии
    const version = ((ctx.payload.model && ctx.payload.model.version) || 0) + 1;
    const sig = ctx.classifier.modelInfo().sig;
    ctx.j('train_commit', { version, sig, n, composition: examples });
    ctx.tele.push(step.mode === 'rails' ? 'trained' : 'retrained', { n, version, sig });
    setTimeout(() => {
      boxEl && boxEl.classList.remove('learning');
      ctx.advancePhase();
    }, ctx.demo ? 150 : 900);
  }, { id: 'btn_train' });
  ctx.modelGate(btn);
  const box = [kidText(boxStatus(ctx), { small: true }), btn];
  // «Разложить заново» (фаза 0.5): элемент манифеста btn_relayout — раскладка с нуля
  // и возврат на такт корзин; версию состава не трогает (замораживает только «Научить»)
  const basketsPhase = step.phases.find(p => (p.elements || []).some(e => e.startsWith('basket_')));
  if (hasEl(phase, 'btn_relayout') && basketsPhase) {
    box.push(bigBtn('Разложить заново', () => {
      ctx.j('baskets_clear', {});
      ctx.tele.push('baskets_cleared', { step: step.id });
      ctx.jumpToPhase(step.id, basketsPhase.id);
    }, { kind: 'ghost', id: 'btn_relayout', disabled: !ctx.payload.baskets.length }));
  }
  return zones(ctx, step, {
    input: { content: kidText('Картинки разложены', { small: true }), active: false },
    box: { content: box, active: true },
    output: { content: kidText('Сейчас научится…', { small: true }), active: false },
  });
}

function probeFeed(ctx, step, phase) {
  const ids = phase.probe_set || [];
  // указатель ленты: после F5 встаёт на первую картинку БЕЗ показанного вердикта
  const lkey = 'probeptr_' + step.id + '_' + phase.id;
  if (ctx.local[lkey] == null) {
    const firstOpen = ids.findIndex(id => !(id in ctx.payload.probes));
    ctx.local[lkey] = firstOpen < 0 ? ids.length : firstOpen;
  }
  const ptr = ctx.local[lkey];
  const current = ids[ptr];
  const img = current && ctx.bankIndex.byId.get(current);
  const verdict = current && ctx.payload.probes[current];

  const input = [];
  if (img) {
    input.push(h('div', { class: 'feedcount' }, 'проверка ' + (ptr + 1) + ' из ' + ids.length));
    input.push(imgCard(ctx.assetsBase + img.src, { big: true, id: 'img_current' }));
  } else input.push(kidText('Все проверки пройдены!'));

  const checkBtn = hasEl(phase, 'btn_check') && img && !verdict && bigBtn('Проверить', () => {
    const v = ctx.classifier.classify(current);
    if (!v) return;
    ctx.j('probe_result', { img: current, label: v.label, conf: v.conf, margin: v.margin });
    ctx.tele.push('probe', { img: current, label: v.label, conf: v.conf });
    ctx.render();
  }, { id: 'btn_check' });
  if (checkBtn) ctx.modelGate(checkBtn);

  const out = [];
  if (verdict) {
    out.push(verdictCard('Это ' + classLabel(ctx, verdict.label) + '!', verdict.conf, { margin: verdict.margin }));
    // отметка «она ошиблась!» — НАБЛЮДЕНИЕ ребёнка (план-правок п.4): сам решает, был ли
    // ответ верным; модель не меняет, уходит в телеметрию и карточку дела. Авто-спойлера нет.
    const marked = (ctx.payload.mistakes || []).includes(current);
    if (marked) out.push(kidText('Записано: коробка тут ошиблась!', { small: true }));
    else out.push(bigBtn('Она ошиблась!', () => {
      ctx.j('mistake_mark', { img: current });
      ctx.tele.push('mistake_marked', { img: current, label: verdict.label,
                                        was_wrong: !!img && verdict.label !== img.class });
      ctx.render();
    }, { kind: 'ghost', id: 'btn_mistake' }));
  } else if (img) out.push(kidText('Жми «Проверить» — что скажет коробка?', { small: true }));
  ctx.local.reactionOk = !!verdict;   // «Получилось!» — только когда на такте есть результат

  const nextBtn = hasEl(phase, 'btn_next') && bigBtn('Дальше', () => {
    if (current) { ctx.local[lkey] = ptr + 1; ctx.render(); return; }
    // эксперимент «проверить другую раскладку»: пробы пройдены → назад к разгадке,
    // такты версии не перепоказываются (version/choice давно закоммичены)
    if ((ctx.payload.experiments || {})[step.id] && step.reveal) {
      ctx.jumpToPhase(step.id, step.phases[step.phases.length - 1].id);
      return;
    }
    ctx.advancePhase();
  }, { id: 'btn_next', disabled: !!current && !verdict });

  return zones(ctx, step, {
    input: { content: input, active: !!img },
    box: { content: kidText(boxStatus(ctx), { small: true }), active: false },
    output: { content: [...out, h('div', { class: 'row' }, checkBtn || null, nextBtn || null)], active: true },
  });
}

/* Подача ловушек — НАСТОЯЩИЙ выбор (план-правок фаза 0.5): подмножество по одной —
 * «Добавить в обучение» / «Пропустить», досрочный выход «Хватит, проверяем» (≥1 ловушка).
 * Пропущенные не пропадают: очередь ставит их в конец, в цикле добора (слабый замер →
 * «Добрать ловушки») они приходят снова. Подпись — caption банка + честное объяснение. */
function trapsFeed(ctx, step, phase) {
  const pool = step.images_from_role ? shuffledRole(ctx, step.images_from_role) : shuffledRole(ctx, 'trap');
  const added = new Set(ctx.payload.traps);
  const skipped = new Set(ctx.payload.trap_skips || []);
  // очередь: сперва невиданные, потом пропущенные (они доступны и в доборе)
  const rest = [...pool.filter(i => !added.has(i.id) && !skipped.has(i.id)),
                ...pool.filter(i => !added.has(i.id) && skipped.has(i.id))];
  const lkey = 'trapptr_' + step.id;
  const ptr = rest.length ? (ctx.local[lkey] || 0) % rest.length : 0;
  const current = rest.length ? rest[ptr] : null;
  // считаем только добавленное ИЗ ПУЛА этого шага (в доборе r2 payload.traps уже несёт ловушки s6)
  const addedInPool = pool.filter(i => added.has(i.id)).length;
  const canStop = addedInPool >= 1;

  const input = [];
  if (current) {
    input.push(h('div', { class: 'feedcount' }, 'добавлено ' + addedInPool + ' из ' + pool.length));
    const card = imgCard(ctx.assetsBase + current.src, { big: true, id: 'img_current' });
    card.dataset.img = current.id;   // e2e/дебаг: какая ловушка в подаче
    input.push(card);
    input.push(kidText((current.caption ? current.caption + '. ' : '') +
      'Коробка таких ещё не видела', { small: true }));
  } else {
    input.push(kidText('Все ' + pool.length + ' ловушек в коробке!'));
  }
  const controls = h('div', { class: 'row' });
  if (hasEl(phase, 'btn_pick') && current)
    controls.append(bigBtn('Добавить в обучение', () => {
      ctx.j('trap_add', { img: current.id });
      ctx.tele.push('trap_added', { img: current.id });
      ctx.render();
    }, { id: 'btn_pick' }));
  if (hasEl(phase, 'btn_skip') && current)
    controls.append(bigBtn('Пропустить', () => {
      ctx.j('trap_skip', { img: current.id });
      ctx.tele.push('trap_skipped', { img: current.id });
      ctx.local[lkey] = ptr + 1;   // дальше по очереди; по кругу — пока не «Хватит»
      ctx.render();
    }, { kind: 'ghost', id: 'btn_skip' }));
  if (hasEl(phase, 'btn_undo'))
    controls.append(bigBtn('Вернуть', () => {
      if (!ctx.payload.traps.length) return;
      ctx.j('trap_undo', {});
      ctx.tele.push('basket_undo', { step: step.id });
      ctx.render();
    }, { kind: 'ghost', id: 'btn_undo', disabled: !ctx.payload.traps.length }));
  if (hasEl(phase, 'btn_next') && (canStop || !current))
    controls.append(bigBtn(current ? 'Хватит, проверяем' : 'Дальше', () => {
      ctx.tele.push('traps_done', { added: addedInPool, of: pool.length, stopped_early: !!current });
      ctx.advancePhase();
    }, { id: 'btn_next', kind: current ? 'secondary' : 'primary' }));
  input.push(controls);

  return zones(ctx, step, {
    input: { content: input, active: true },
    box: { content: kidText(boxStatus(ctx), { small: true }), active: false },
    output: { content: kidText('После новых картинок — научи заново', { small: true }), active: false },
  });
}

/** Подписи ошибок замера: «на картинке кот — коробка сказала „собака“» (план-правок п.3). */
function measureErrors(ctx, m) {
  return (m.details || []).filter(d => !d.ok).map(d => {
    const img = ctx.bankIndex.byId.get(d.img);
    return 'на картинке ' + (img ? classOne(ctx, img.class) : '?') +
      ' — коробка сказала «' + (d.label ? classOne(ctx, d.label) : '?') + '»';
  });
}

/** Честный итог замера по факту (план-правок п.3/п.6): лучше / держит идеал / без
 * изменений / хуже. beforeValid=false → сравнивать не с чем (stale-«Было»). */
function measureOutcome(before, after, beforeValid) {
  if (!after) return null;
  if (!before || !beforeValid) return null;
  if (after.score > before.score) return 'Коробка починилась!';
  if (after.score === before.score && after.score === after.of) return 'Держит идеал — все ответы верные!';
  if (after.score === before.score) return 'Пока без изменений — можно добрать картинок';
  return 'Стало хуже — так бывает, можно добрать картинок';
}

/** Замер «после» честен только для ТЕКУЩЕЙ версии состава: после добора/переобучения
 * старый счёт принадлежит прошлой версии — его инвалидируем и меряем заново (фаза 0.5). */
function afterIsStale(ctx, m) {
  return !!(m.after && m.after.model_sig && ctx.payload.model
            && ctx.payload.model.sig !== m.after.model_sig);
}

function measurePhase(ctx, step, phase) {
  const m = ctx.payload.measures;
  const out = [];
  if (m.after && !afterIsStale(ctx, m)) {
    // stale-«Было»: раскладка корзин менялась после замера «до» (restore/переразметка) —
    // старый счёт сделан ДРУГОЙ моделью, сравнивать нечестно (Codex D1–D2)
    const beforeValid = !!m.before && (!m.before.baskets_sig || m.before.baskets_sig === basketsSig(ctx));
    if (m.before && beforeValid) out.push(scoreCard(m.before.score, m.before.of, 'Было'));
    if (m.before && !beforeValid)
      out.push(kidText('Раскладка менялась — старый замер не в счёт', { small: true }));
    out.push(scoreCard(m.after.score, m.after.of, 'Стало', { errors: measureErrors(ctx, m.after) }));
    const outcome = measureOutcome(m.before, m.after, beforeValid);
    if (outcome) out.push(kidText(outcome, { small: true }));
    // цикл добора (фаза 0.5, стык с паттерном r2): замер слабее порога и остались
    // невзятые ловушки → назад к подаче, добрать и переучить (версия состава вырастет)
    const passN = parseInt(String(step.measure.pass).split('/')[0], 10) || m.after.of;
    const trapsPhase = step.phases.find(p => (p.elements || []).includes('btn_pick'));
    const pool = step.images_from_role ? role(ctx, step.images_from_role) : role(ctx, 'trap');
    const restN = pool.filter(i => !ctx.payload.traps.includes(i.id)).length;
    const row = h('div', { class: 'row' });
    if (m.after.score < passN && trapsPhase && restN > 0)
      row.append(bigBtn('Добрать ловушки', () => {
        ctx.tele.push('traps_more', { step: step.id, rest: restN, score: m.after.score });
        ctx.jumpToPhase(step.id, trapsPhase.id);
      }, { id: 'btn_more_traps' }));
    row.append(bigBtn('Дальше', () => ctx.advancePhase(), { id: 'btn_check',
      kind: (m.after.score < passN && trapsPhase && restN > 0) ? 'secondary' : 'primary' }));
    out.push(row);
  } else {
    if (m.after && afterIsStale(ctx, m))
      out.push(kidText('Состав обучения менялся — проверь коробку заново', { small: true }));
    if (m.before) out.push(scoreCard(m.before.score, m.before.of, 'Было до ловушек'));
    const btn = bigBtn('Проверить коробку', () => {
      const r = ctx.classifier.measure(step.measure.holdout);
      const mi = ctx.classifier.modelInfo();
      ctx.j('measure_result', { phase: 'after', score: r.score, of: r.of, details: r.details,
                                model_n: mi.n, model_sig: mi.sig, baskets_sig: basketsSig(ctx) });
      ctx.tele.push('measure', { phase: 'after', score: r.score, of: r.of, model_sig: mi.sig });
      ctx.render();
    }, { id: 'btn_check' });
    ctx.modelGate(btn);
    out.push(btn);
  }
  return zones(ctx, step, {
    input: { content: kidText('Проверяем на НОВЫХ картинках', { small: true }), active: false },
    box: { content: kidText(boxStatus(ctx), { small: true }), active: false },
    output: { content: out, active: true },
  });
}

/* ---------- версия и прогноз ---------- */

function versionSentence(ctx, step) {
  const t = step.version.template;
  const parts = [];
  let n = 0;
  for (const chunk of t.lead.split('___')) {
    parts.push(chunk);
    if (n < t.slots.length) {
      const pick = ctx.payload.version.slots[n + 1];
      parts.push(pick != null ? '«' + t.slots[n][pick] + '»' : '___');
      n += 1;
    }
  }
  return parts.join('');
}

function fragPhase(ctx, step, phase) {
  const slotIdx = phase.slot;
  const frags = step.version.template.slots[slotIdx - 1] || [];
  const picked = ctx.payload.version.slots[slotIdx];
  const btns = frags.map((f, i) => bigBtn(f, (ev) => {
    ev.currentTarget.parentElement.querySelectorAll('button').forEach(b => { b.disabled = true; });
    ctx.j('frag_pick', { slot: slotIdx, frag: i });
    setTimeout(ctx.guarded(() => ctx.advancePhase()), 250);
  }, { kind: picked === i ? 'primary' : 'secondary', id: 'frag' + (i + 1) }));
  return h('div', { class: 'taskcard private' },
    h('div', { class: 'private-mark' }, '🔒 видно только тебе'),
    kidText(versionSentence(ctx, step)),
    h('div', { class: 'col' }, ...btns));
}

function freeTextPhase(ctx, step, phase) {
  const input = h('input', { class: 'kinput', id: 'free_text', maxlength: '120',
    placeholder: 'Допиши своими словами (не обязательно)' });
  if (ctx.payload.version.free_text) input.value = ctx.payload.version.free_text;
  return h('div', { class: 'taskcard private' },
    h('div', { class: 'private-mark' }, '🔒 видно только тебе'),
    kidText(versionSentence(ctx, step)),
    input,
    bigBtn('Дальше', () => {
      const text = input.value.trim();
      if (text) ctx.j('free_text_set', { text });
      ctx.advancePhase();
    }, { id: 'btn_skip' }));
}

function commitPhase(ctx, step, phase) {
  const isForecast = !step.version || (ctx.commitDone('version', step.id) && step.forecast);
  const label = btnLabelFrom(phase.text, isForecast ? 'Мой прогноз!' : 'Моя версия!');
  const body = [];
  if (!isForecast) {
    body.push(h('div', { class: 'private-mark' }, '🔒 видно только тебе'));
    body.push(kidText(versionSentence(ctx, step)));
    if (ctx.payload.version.free_text) body.push(kidText('+ ' + ctx.payload.version.free_text, { small: true }));
  } else {
    const f = step.forecast;
    body.push(kidText('Прогноз: ' + (f.predict_options[ctx.payload.forecast.predict] || '—')));
    body.push(kidText('Почему: ' + (f.reason_options[ctx.payload.forecast.reason] || '—'), { small: true }));
  }
  const btn = bigBtn(label, async (ev) => {
    ev.currentTarget.disabled = true;
    const go = ctx.guarded(() => ctx.advancePhase());
    try {
      if (isForecast) {
        const f = step.forecast;
        const data = { ...ctx.payload.forecast,
          readable: (f.predict_options[ctx.payload.forecast.predict] || '') + ' — ' +
                    (f.reason_options[ctx.payload.forecast.reason] || '') };
        await ctx.commit('forecast', data);
        ctx.tele.push('forecast_committed', { img: f.img, predict: data.predict, reason: data.reason });
      } else {
        const data = {
          slots: { ...ctx.payload.version.slots },
          text: ctx.payload.version.free_text,
          readable: versionSentence(ctx, step) +
            (ctx.payload.version.free_text ? ' + ' + ctx.payload.version.free_text : ''),
        };
        await ctx.commit('version', data);
        ctx.tele.push('version_committed', { template_parts: data.slots, text: data.text });
      }
      go();
    } catch (e) {
      ev.currentTarget.disabled = false;   // терминальный отказ (reset/epoch) — обработает sync
    }
  }, { id: 'btn_commit' });
  body.push(btn);
  return h('div', { class: 'taskcard private' }, ...body);
}

function optSpec(step, phase) {
  const lists = [];
  if (step.version) lists.push({ kind: 'choice', options: step.version.choice.options });
  if (step.forecast) lists.push(
    { kind: 'predict', options: step.forecast.predict_options },
    { kind: 'reason', options: step.forecast.reason_options });
  const optPhases = step.phases.filter(p => (p.elements || []).some(e => /^opt[1-9]$/.test(e)));
  return lists[optPhases.findIndex(p => p.id === phase.id)];
}

function optPhase(ctx, step, phase) {
  const spec = optSpec(step, phase);
  if (!spec) return kidText('…');
  const body = [];
  if (spec.kind === 'predict' && hasEl(phase, 'img_current')) {
    const img = ctx.bankIndex.byId.get(step.forecast.img);
    if (img) body.push(imgCard(ctx.assetsBase + img.src, { big: true, id: 'img_current' }));
  }
  const picked = spec.kind === 'choice' ? null : ctx.payload.forecast[spec.kind];
  body.push(h('div', { class: 'col' }, ...spec.options.map((opt, i) =>
    bigBtn(opt, async (ev) => {
      // вся группа гаснет с первого тапа: второй коммит проталкивал бы reveal мимо замка
      const group = ev.currentTarget.parentElement.querySelectorAll('button');
      group.forEach(b => { b.disabled = true; });
      if (spec.kind === 'choice') {
        const go = ctx.guarded(() => ctx.advancePhase());
        try {
          await ctx.commit('choice', { option: i, correct: i === step.version.choice.correct });
          ctx.tele.push('version_choice', { option: i, correct: i === step.version.choice.correct });
          go();
        } catch (e) { group.forEach(b => { b.disabled = false; }); }
      } else {
        ctx.j('forecast_pick', { field: spec.kind, option: i });
        setTimeout(ctx.guarded(() => ctx.advancePhase()), 250);
      }
    }, { kind: picked === i ? 'primary' : 'secondary', id: 'opt' + (i + 1) }))));
  return h('div', { class: 'taskcard' + (spec.kind === 'choice' ? ' private' : '') }, ...body);
}

function waitingPhase(ctx, step, phase) {
  return h('div', { class: 'taskcard waiting' },
    h('div', { class: 'waitspin' }),
    kidText(ctx.ui.waiting || 'Принято — ждём остальных'));
}

function revealPhase(ctx, step, phase) {
  const r = step.reveal || {};
  const info = ctx.revealInfo(step.id);
  const body = [h('div', { class: 'reveal-title', 'data-kid': '1' }, 'Разгадка!')];
  for (const c of r.cards || []) body.push(imgCard(ctx.assetsBase + c, { big: true }));
  if (r.text) body.push(kidText(r.text));
  if (r.show_anon_versions && info && (info.anon_versions || []).length) {
    body.push(h('div', { class: 'anon-title', 'data-kid': '1' }, 'Версии группы (без имён):'));
    body.push(h('div', { class: 'anonlist' },
      ...info.anon_versions.map(v => h('div', { class: 'anonitem' },
        (v && (v.readable || v.text)) || 'версия из фрагментов'))));
  }
  // «Проверить другую раскладку» (фаза 0.5): замок уже открыт (version/choice закоммичены),
  // эксперимент настоящий — раскладка с нуля, «Научить» даст новую версию состава,
  // пробы прогоняются заново, потом возврат сюда же
  const basketsPhase = step.phases.find(p => (p.elements || []).some(e => e.startsWith('basket_')));
  if (hasEl(phase, 'btn_next'))
    body.push(bigBtn('Дальше', () => ctx.advancePhase() || ctx.finishStep(), { id: 'btn_next' }));
  if (basketsPhase && ctx.commitDone('choice', step.id))
    body.push(bigBtn('Проверить другую раскладку', () => {
      ctx.j('experiment_start', { step: step.id });
      ctx.tele.push('experiment_start', { step: step.id });
      // указатели лент проб — с чистого листа (вердикты обнулены experiment_start)
      for (const k of Object.keys(ctx.local)) if (k.startsWith('probeptr_')) delete ctx.local[k];
      ctx.jumpToPhase(step.id, basketsPhase.id);
    }, { kind: 'secondary', id: 'btn_experiment' }));
  if (!ctx.local['reveal_seen_' + step.id]) {
    ctx.local['reveal_seen_' + step.id] = true;
    ctx.tele.push('reveal_seen', { step: step.id });
  }
  return h('div', { class: 'taskcard revealcard' }, ...body);
}

function forecastRun(ctx, step, phase) {
  const f = step.forecast;
  const img = ctx.bankIndex.byId.get(f.img);
  const done = ctx.payload.probes[f.img];
  const out = [];
  ctx.local.reactionOk = !!done;   // «Получилось!» — только после фактического результата
  if (img) out.push(imgCard(ctx.assetsBase + img.src, { id: 'img_current' }));
  if (done) {
    out.push(verdictCard('Это ' + classLabel(ctx, done.label) + '!', done.conf, { margin: done.margin }));
    const matchPredict = ctx.local['fr_match_' + step.id];
    if (matchPredict != null)
      out.push(kidText(matchPredict ? 'Твой прогноз сбылся!' : 'Коробка ответила иначе — интересно почему?'));
    if (hasEl(phase, 'btn_next'))
      out.push(bigBtn('Дальше', () => ctx.advancePhase() || ctx.finishStep(), { id: 'btn_next' }));
  } else {
    const btn = bigBtn('Проверяем!', () => {
      const v = ctx.classifier.classify(f.img);
      if (!v) return;
      ctx.j('probe_result', { img: f.img, label: v.label, conf: v.conf, margin: v.margin });
      const predictedClass = f.expected && ctx.payload.forecast.predict === f.expected.predict;
      // совпадение прогноза: выбранная опция predict → класс. Опции — данные; сопоставление
      // делаем по индексу против фактической метки через expected (валидатор гарантирует поля).
      const matchPredict = optionMatchesLabel(ctx, f, ctx.payload.forecast.predict, v.label);
      const matchReason = ctx.payload.forecast.reason === f.expected.reason;
      ctx.local['fr_match_' + step.id] = matchPredict;
      ctx.tele.push('forecast_result', { match_predict: matchPredict, match_reason: matchReason });
      ctx.render();
    }, { id: 'btn_check' });
    ctx.modelGate(btn);
    out.push(btn);
  }
  return zones(ctx, step, {
    input: { content: kidText('Картинка-проба', { small: true }), active: false },
    box: { content: kidText(boxStatus(ctx), { small: true }), active: false },
    output: { content: out, active: true },
  });
}

/** Совпал ли выбранный predict-вариант с фактической меткой: сопоставление через
 * expected: если фактическая метка == классу картинки, «верный» вариант = expected.predict. */
function optionMatchesLabel(ctx, forecast, pickedOption, label) {
  const img = ctx.bankIndex.byId.get(forecast.img);
  if (!img || pickedOption == null) return false;
  const correctOption = forecast.expected.predict;
  return label === img.class ? pickedOption === correctOption : pickedOption !== correctOption;
}

/* ---------- квизы ---------- */

function quizCard(ctx, step, phase) {
  const card = phase.card;
  if (card.multi) return captchaCard(ctx, step, phase, card);
  const answered = ctx.payload.quiz[card.id];
  const body = [
    h('div', { class: 'quiz-title', 'data-kid': '1' }, card.title),
    imgCard(ctx.assetsBase + card.img, { big: true }),
  ];
  body.push(h('div', { class: 'row' }, ...card.options.map((opt, i) => {
    let kind = 'secondary';
    if (answered != null) kind = i === card.correct ? 'primary' : (i === answered ? 'danger' : 'ghost');
    return bigBtn(opt, () => {
      if (answered != null) return;
      ctx.j('quiz_answer', { card: card.id, answer: i });
      ctx.tele.push('quiz_click', { card: card.id, answer: i, correct: i === card.correct });
      ctx.render();
      setTimeout(ctx.guarded(() => ctx.advancePhase() || ctx.finishStep()), ctx.demo ? 250 : 900);
    }, { kind, id: 'quizopt' + i });
  })));
  if (answered != null) {
    body.push(kidText(answered === card.correct ? 'Верно!' : 'Правильный ответ подсвечен', { small: true }));
    // ручной выход с уже отвеченной карточки: авто-переход по setTimeout живёт только
    // в момент клика — после F5 или повторного входа в резерв без этой кнопки тупик;
    // guarded — чтобы не гоняться с авто-таймером свежего ответа
    body.push(bigBtn('Дальше', ctx.guarded(() => ctx.advancePhase() || ctx.finishStep()),
      { id: 'btn_next', kind: 'secondary' }));
  }
  return h('div', { class: 'taskcard quizcard' }, ...body);
}

function captchaCard(ctx, step, phase, card) {
  const cells = ctx.payload.captcha[card.id] || [];
  const committed = ctx.commitDone('captcha', step.id);
  const showRevealText = committed && step.reveal_text;
  if (showRevealText) {
    return h('div', { class: 'taskcard revealcard' },
      h('div', { class: 'reveal-title', 'data-kid': '1' }, 'Сюрприз!'),
      kidText(step.reveal_text),
      bigBtn('Дальше', () => ctx.advancePhase() || ctx.finishStep(), { id: 'btn_next' }));
  }
  const cols = Math.ceil(Math.sqrt(card.cells));
  const rows = Math.ceil(card.cells / cols);
  const grid = h('div', { class: 'capgrid', style: 'grid-template-columns:repeat(' + cols + ',1fr)' },
    ...Array.from({ length: card.cells }, (_, i) => {
      const x = (i % cols) / (cols - 1 || 1) * 100;
      const y = Math.floor(i / cols) / (rows - 1 || 1) * 100;
      return h('button', {
        class: 'capcell' + (cells.includes(i) ? ' on' : ''),
        id: 'cell' + i,
        style: `background-image:url('${ctx.assetsBase + card.img}');` +
               `background-size:${cols * 100}% ${rows * 100}%;background-position:${x}% ${y}%`,
        onclick: () => { ctx.j('captcha_toggle', { card: card.id, cell: i }); ctx.render(); },
      }, h('span', { class: 'capcheck' }, '✓'));
    }));
  const btn = bigBtn('Готово!', async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      await ctx.commit('captcha', { card: card.id, cells: cells.slice() });
      ctx.tele.push('captcha_commit', { cells: cells.slice() });
      ctx.render();
    } catch (e) { ev.currentTarget.disabled = false; }
  }, { id: 'btn_commit', disabled: !cells.length });
  return h('div', { class: 'taskcard quizcard' },
    h('div', { class: 'quiz-title', 'data-kid': '1' }, card.title),
    grid, btn);
}

/* ---------- talk_chat ---------- */

function talkPhase(ctx, step, phase) {
  const key = 'think_' + step.id;
  // F5 не должен заставлять думать и писать заново: своё сообщение этого шага
  // уже есть в серверном чате → сразу панель + «Дальше» (Codex-находка 8)
  if (!ctx.local['chat_sent_' + step.id] &&
      ctx.chatLog.some(m => String(m.seat) === String(ctx.seat) && m.step === step.id)) {
    ctx.local['chat_sent_' + step.id] = true;
    ctx.local[key] = 1;
    ctx.local[key + '_done'] = true;
  }
  const started = ctx.local[key];
  const thinkSec = ctx.demo ? Math.min(2, step.think_sec || 30) : (step.think_sec || 30);
  const body = [h('div', { class: 'quiz-title', 'data-kid': '1' }, step.prompt || '')];
  if (!started) {
    body.push(kidText('Сначала подумай молча — потом откроется чат, куда напечатать', { small: true }));
    body.push(bigBtn('Начать думать (' + (step.think_sec || 30) + ' сек)', () => {
      ctx.local[key] = Date.now();
      ctx.render();
      const tick = setInterval(() => {
        const left = thinkSec - Math.floor((Date.now() - ctx.local[key]) / 1000);
        const el = document.getElementById('think_left');
        if (el) el.textContent = left > 0 ? String(left) : '';
        if (left <= 0) { clearInterval(tick); ctx.local[key + '_done'] = true; ctx.render(); }
      }, 300);
    }, { id: 'btn_think' }));
  } else if (!ctx.local[key + '_done'] && (Date.now() - started) / 1000 < thinkSec) {
    body.push(h('div', { class: 'thinktimer' }, h('span', { id: 'think_left' },
      String(Math.max(0, thinkSec - Math.floor((Date.now() - started) / 1000))))));
    body.push(kidText('Подумай молча…', { small: true }));
  } else {
    body.push(ctx.overlays.buildChatPanel(ctx));
    if (ctx.local['chat_sent_' + step.id])
      body.push(bigBtn('Дальше', () => ctx.advancePhase() || ctx.finishStep(), { id: 'btn_next', kind: 'secondary' }));
  }
  return h('div', { class: 'taskcard talkcard' }, ...body);
}

/* ---------- финал: карточка дела ---------- */

function findRevealStep(ctx) {
  return ctx.normalized.steps.find(s => s.reveal);
}

const razWord = (n) => (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) ? 'раза' : 'раз';

function finalPhase(ctx, step, phase) {
  if (phase.id === 'card_view') {
    if (!ctx.local['card_opened']) {
      ctx.local['card_opened'] = true;
      ctx.tele.push('card_opened', {});
    }
    const m = ctx.payload.measures;
    const rstep = findRevealStep(ctx);
    const assisted = ctx.overlays.assisted();
    // итог ПО ФАКТУ, не безусловный успех (план-правок п.6): лучше / держит идеал /
    // без изменений / хуже; stale-«Было» — сравнения нет
    const beforeValid = !!m.before && (!m.before.baskets_sig || m.before.baskets_sig === basketsSig(ctx));
    const outcome = measureOutcome(m.before, m.after, beforeValid);
    const mistakes = (ctx.payload.mistakes || []).length;
    // версии состава обучения (фаза 0.5): сколько раз коробку учили и на скольких картинках
    const hist = ctx.payload.model_history || [];
    const lastErrors = m.after ? measureErrors(ctx, m.after) : [];
    return h('div', { class: 'taskcard finalcard' },
      h('div', { class: 'reveal-title', 'data-kid': '1' }, 'Карточка дела №1'),
      h('div', { class: 'factrow' }, 'Точность коробки: ',
        h('b', {}, ((m.before && beforeValid) ? m.before.score : '—') + ' → ' +
          (m.after ? m.after.score : '—') + (m.after ? ' из ' + m.after.of : ''))),
      outcome ? h('div', { class: 'factrow' }, 'Итог: ', h('b', {}, outcome)) : null,
      hist.length ? h('div', { class: 'factrow' }, 'Учил коробку: ',
        h('b', {}, hist.length + ' ' + razWord(hist.length) + ' (состав v' +
          hist[hist.length - 1].version + ', картинок: ' + hist[hist.length - 1].n + ')')) : null,
      lastErrors.length ? h('div', { class: 'factrow' }, 'Ошибки последней проверки: ',
        h('span', {}, ...lastErrors.map(t => h('div', { class: 'facterr' }, '✗ ' + t)))) : null,
      rstep ? h('div', { class: 'factrow' }, 'Твоя версия: ', h('b', {}, versionSentence(ctx, rstep))) : null,
      ctx.payload.version.free_text ? h('div', { class: 'factrow' }, '«' + ctx.payload.version.free_text + '»') : null,
      rstep && rstep.reveal.text ? h('div', { class: 'factrow' }, 'Разгадка: ', h('b', {}, rstep.reveal.text)) : null,
      h('div', { class: 'factrow' }, 'Ловушек добавил: ', h('b', {}, String(ctx.payload.traps.length))),
      mistakes ? h('div', { class: 'factrow' }, 'Ты заметил ошибок коробки: ', h('b', {}, String(mistakes))) : null,
      assisted ? h('div', { class: 'factrow assisted' }, 'Прошёл с помощью — можно повторить чисто!') : null,
      bigBtn('Дальше', () => ctx.advancePhase(), { id: 'btn_next' }));
  }
  if (phase.id === 'best_trap') {
    const traps = ctx.payload.traps;
    if (!traps.length || ctx.payload.best_trap) {
      return h('div', { class: 'taskcard' },
        kidText(ctx.payload.best_trap ? 'Лучшая ловушка отмечена!' : 'Ловушек не было'),
        bigBtn('Дальше', () => ctx.advancePhase(), { id: 'btn_next' }));
    }
    const lkey = 'bestptr';
    const ptr = (ctx.local[lkey] || 0) % traps.length;
    const img = ctx.bankIndex.byId.get(traps[ptr]);
    return h('div', { class: 'taskcard' },
      h('div', { class: 'quiz-title', 'data-kid': '1' }, 'Отметь свою лучшую ловушку'),
      // критерий выбора + «зачем» (план-правок п.6): выбор осмысленный, не слепой
      kidText('Какая лучше всего запутывала старую коробку?', { small: true }),
      kidText('Лучшая ловушка попадёт в карточку дела — её увидят родители', { small: true }),
      h('div', { class: 'feedcount' }, 'ловушка ' + (ptr + 1) + ' из ' + traps.length),
      img ? imgCard(ctx.assetsBase + img.src, { big: true, id: 'img_current' }) : null,
      h('div', { class: 'row' },
        bigBtn('Эта!', () => {
          ctx.j('best_trap_pick', { img: traps[ptr] });
          ctx.tele.push('best_trap_marked', { img: traps[ptr] });
          ctx.render();
        }, { id: 'btn_pick' }),
        bigBtn('Дальше', () => { ctx.local[lkey] = ptr + 1; ctx.render(); }, { kind: 'secondary', id: 'btn_next' })));
  }
  // next_block: «что дальше» — контент, не прайс; у каждой карточки — подпись из манифеста
  const cards = (step.next_block && step.next_block.cards) || [];
  const captions = (step.next_block && step.next_block.captions) || [];
  return h('div', { class: 'taskcard' },
    h('div', { class: 'quiz-title', 'data-kid': '1' }, 'Что дальше'),
    ...cards.map((c, i) => h('div', { class: 'nextcard' },
      imgCard(ctx.assetsBase + c),
      captions[i] ? kidText(captions[i], { small: true }) : null)),
    bigBtn('Закрыть дело №1', () => ctx.finishFinal(), { id: 'btn_next' }));
}

/* ---------- слайд «для поговорить» (тип шага slide, фаза 0.5) ---------- */

/** Слайд: title/text/img/caption + одна кнопка. Осознанное расширение реестра типов —
 * «слайды для поговорить» в любом месте занятия (пример капчи перед s5). Стилизацию
 * несёт сам ассет (пример капчи — пререндеренный мокап диалога); рамка «скриншота»
 * у картинки слайда — общая, из CSS (.slide-pic). */
function slideCard(ctx, step) {
  return h('div', { class: 'taskcard slidecard' },
    step.title ? h('div', { class: 'slide-title', 'data-kid': '1' }, step.title) : null,
    step.img ? h('div', { class: 'slide-pic' }, imgCard(ctx.assetsBase + step.img, { big: true })) : null,
    step.text ? kidText(step.text) : null,
    step.caption ? kidText(step.caption, { small: true }) : null,
    bigBtn('Дальше', () => ctx.advancePhase() || ctx.finishStep(), { id: 'btn_next' }));
}

/* ---------- диспетчер ---------- */

export function renderPhase(ctx) {
  const step = ctx.machine.step();
  const phase = ctx.machine.phase();
  if (!step || !phase) return null;
  // «Получилось!» не безусловна: такты с отложенным результатом (пробы, прогноз)
  // перезаписывают флаг — оверлей появляется только при фактическом результате
  ctx.local.reactionOk = true;

  if (step.type === 'slide') return slideCard(ctx, step);
  if (step.type === 'cards_quiz') return quizCard(ctx, step, phase);
  if (step.type === 'talk_chat') return talkPhase(ctx, step, phase);
  if (step.type === 'final_card') return finalPhase(ctx, step, phase);
  if (step.type === 'trainer_act') {
    if (phase.probe_set) return probeFeed(ctx, step, phase);
    if (hasRe(phase, /^basket_/)) return basketsFeed(ctx, step, phase);
    if (hasEl(phase, 'btn_pick')) return trapsFeed(ctx, step, phase);
    if (hasEl(phase, 'btn_train')) return trainPhase(ctx, step, phase);
    if (hasRe(phase, /^frag[1-9]$/)) return fragPhase(ctx, step, phase);
    if (hasEl(phase, 'free_text')) return freeTextPhase(ctx, step, phase);
    if (hasEl(phase, 'btn_commit')) return commitPhase(ctx, step, phase);
    if (hasRe(phase, /^opt[1-9]$/)) return optPhase(ctx, step, phase);
    // такт разгадки — структурно: последний такт шага с reveal (id — свободные данные)
    if (step.reveal && step.phases[step.phases.length - 1].id === phase.id)
      return revealPhase(ctx, step, phase);
    // генерик «карточка текста + Дальше» — интро и связки, объявленные данными манифеста;
    // с маскотом: коробку в интро ВИДНО, а не только называем словом
    if ((phase.elements || []).length && (phase.elements || []).every(e => e === 'btn_next'))
      return h('div', { class: 'taskcard introcard' },
        boxMascot({ big: true }),
        kidText(phase.text || ''),
        bigBtn('Дальше', () => ctx.advancePhase() || ctx.finishStep(), { id: 'btn_next' }));
    if (hasEl(phase, 'btn_check') && step.forecast &&
        step.phases.filter(p => (p.elements || []).includes('btn_commit')).length &&
        ctx.commitDone('forecast', step.id)) return forecastRun(ctx, step, phase);
    if (hasEl(phase, 'btn_check') && step.measure) return measurePhase(ctx, step, phase);
    if (!(phase.elements || []).length) return waitingPhase(ctx, step, phase);
  }
  return kidText(phase.text || '…');
}
