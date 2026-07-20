/* Рендерер ТАКТОВ (ТЗ-демка-з1 §1.1: такт — сущность манифеста; §2 — компоненты 1–9).
 * Идентичность занятия не знает: всё из manifest/bank (элементы такта, тексты, картинки,
 * классы корзин). Диспетчеризация по type шага + elements[] такта. Правила:
 *  - подача картинок ПО ОДНОЙ (лимит ≤5 на такт держит уже манифест, DOM это зеркалит);
 *  - «вернуть» (undo) — не наказуем: только журнал, флага помощи не вешает (правило 7);
 *  - три зоны коробки «вход → обучение → выход» видимы во всех режимах trainer_act
 *    (правило 9): пустая зона приглушена, не спрятана;
 *  - F5 не перепоказывает сделанное: показанные вердикты/замеры берутся из payload. */

import { h, bigBtn, imgCard, kidText, verdictCard, scoreCard, btnLabelFrom, confWord } from './dom.js';
import { compositionSig } from '../engine/classifier.js';
import { trainExamples, countsOf, countsFromComposition, versionShelf, growthCells,
         sameMeasureSet } from './versions.js';
import { stableComposition, trainAlreadyCommitted, activeStableModel } from '../core/reducer.js';

const role = (ctx, r) => ctx.bankIndex.byRole.get(r) || [];

/** Такт добавления ловушек в шаге починки/добора. В акте 2 (traps_from_bank) ловушки
 * РАЗМЕЧАЮТСЯ в корзины (И4-Т B: данные = картинка + метка, кладёт ребёнок) — это такт
 * с basket_*; в резерве-доборе (images_from_role) — прежний btn_pick «эта!». Все
 * lookup'ы «где добирать картинки» ходят через этот хелпер. */
const trapsPhaseOf = (step) => step.traps_from_bank
  ? step.phases.find(p => (p.elements || []).some(e => e.startsWith('basket_')))
  : step.phases.find(p => (p.elements || []).includes('btn_pick'));

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

/** Identity-хвост модели для журнала: {engine, params_rev?} из modelInfo() — sig считается
 * по СОСТАВУ и одинаков у разных движков, различает модели пара sig+engine (§3.1,
 * Codex-ревью 18.07 п.4–5). params_rev опускается, если банк его не несёт (старая форма). */
const engineTag = (mi) => ({ engine: mi.engine,
  ...(mi.params_rev != null ? { params_rev: mi.params_rev } : {}) });

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

/* ---------- зоны коробки ---------- */

function zones(ctx, step, { input, box, output }) {
  const zone = (name, title, content, active) =>
    h('section', { class: 'zone zone-' + name + (active ? ' zone-active' : ''), 'data-zone': name },
      h('div', { class: 'zone-title' }, title),
      h('div', { class: 'zone-body' }, ...[content].flat().filter(Boolean)));
  // зона коробки — не пустая полка: маскот (коробку ВИДНО, а не только слово)
  // + альбом, ЧЕМ она научена (миниатюры корзин — обучение видимо и правдоподобно)
  // + полка версий В-1 (пассивная: на тактах с интерактивами задания чипы не тапаются —
  // 0 из лимита ≤5; несёт и бейдж В-2 «в корзинах уже по-другому»)
  const boxBody = [boxMascot(), ...[box.content].flat().filter(Boolean), boxAlbum(ctx),
                   versionShelf(ctx, { tappable: false })];
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

/** Обучение с ЧЕСТНОЙ полоской эпох (И3-Т + Codex-ревью И3, находка 3): head считает
 * эпохи порциями (trainAsync, между порциями — yield), полоска показывает ФАКТИЧЕСКИЙ
 * счётчик — интерфейс не замирает и никакой фикс-добавки времени нет: полоска живёт
 * ровно столько, сколько считается градиентный спуск. kNN мгновенен и полоски не
 * получает — мгновенность и есть видимая разница движков (решение владельца 18.07).
 * dataset.trainbar на #screen — машинный след для e2e (в demo эпохи долетают за кадр). */
async function trainWithProgress(ctx, examples, opts) {
  const boxEl = document.querySelector('.zone-box');
  boxEl && boxEl.classList.add('learning');
  let bar = null, fill = null, label = null;
  if (ctx.classifier.engineId === 'head') {
    fill = h('div', { class: 'trainbar-fill' });
    label = h('div', { class: 'trainbar-label' }, 'коробка учится…');
    bar = h('div', { class: 'trainbar' }, label, h('div', { class: 'trainbar-track' }, fill));
    const host = boxEl && boxEl.querySelector('.zone-body');
    if (host) host.append(bar);
    document.getElementById('screen').dataset.trainbar = '1';
  }
  // opts.shouldPublish — guard места запуска (закалка 18.07, critical «публикация
  // в чужое состояние»): движок сам не публикует модель, если место ушло (null)
  const n = await ctx.classifier.trainAsync(examples, (ep, total) => {
    if (!bar || !total) return;
    if (!document.contains(bar)) {
      // поллинг-ререндер мог пересобрать зону — вернуть полоску на место
      const host2 = document.querySelector('.zone-box .zone-body');
      if (host2) host2.append(bar);
    }
    fill.style.width = Math.round(100 * ep / total) + '%';
    label.textContent = 'коробка учится… эпоха ' + ep + ' из ' + total;
  }, opts);
  const boxNow = document.querySelector('.zone-box');
  boxNow && boxNow.classList.remove('learning');
  if (bar) bar.remove();
  return n;
}

/** Откат движка к активной стабильной версии payload — на случай, когда публикация
 * обучения прошла guard движка, но место ушло в самое узкое окно (между microtask'ами):
 * движок не должен остаться обученным составу, которого нет в журнале. */
function retrainToPayload(ctx) {
  const stable = stableModelOf(ctx);
  ctx.classifier.train(stable ? stable.composition : []);
}
const stableModelOf = (ctx) => {
  const m = activeStableModel(ctx.payload);
  return m && (m.composition || []).length ? m : null;
};

function boxStatus(ctx) {
  const n = ctx.classifier.exampleCount();
  if (!ctx.classifier.ready)
    return ctx.classifier.error ? 'Коробка не загрузилась'
                                : (ctx.ui.restoring || 'Коробка вспоминает…');
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
        // role=button обязан отвечать на Enter/Space (закалка 18.07, major «клавиатура»)
        onkeydown: (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); assign(bid); }
        },
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

/** Ответ ребёнка на «Коробка права?» — журнал + телеметрия внимательности (И3-Т п.8).
 * correct — совпал ли ответ с фактом; модель не меняет, mistakes пополняет редьюсер. */
function judgeProbe(ctx, imgId, verdict, sawMistake, wasWrong) {
  ctx.j('probe_judgement', { img: imgId, saw_mistake: sawMistake, correct: sawMistake === wasWrong });
  ctx.tele.push('probe_judgement', { img: imgId, saw_mistake: sawMistake,
                                     correct: sawMistake === wasWrong,
                                     label: verdict.label, was_wrong: wasWrong });
  ctx.render();
}

function countsByClass(ctx) {
  const out = {};
  for (const b of ctx.payload.baskets) out['n_' + b.basket] = (out['n_' + b.basket] || 0) + 1;
  return out;
}

function trainPhase(ctx, step, phase) {
  ctx.local.reactionOk = false;   // до обучения «Получилось!» безусловна — не показываем
  // обучение одному классу — не обучение (закалка 18.07, major «обучить одним классом»):
  // оба движка вернули бы единственную метку с 50%, а экран врал бы «Знает картинок: N».
  // Кнопка заперта с детским объяснением, пока в составе нет хотя бы двух классов
  const examplesNow = trainExamples(ctx);
  const classesNow = new Set(examplesNow.map(e => e.class));
  const missingClasses = classesNow.size < 2;
  const classWords = (ctx.bankIndex.bank.classes || [])
    .map(c => (c.label || c.id).toLowerCase());
  const btn = bigBtn('Научить!', async (ev) => {
    ev.currentTarget.disabled = true;
    const examples = trainExamples(ctx);
    if (new Set(examples.map(e => e.class)).size < 2) { ctx.render(); return; }
    // F5 сразу после «Научить» (Codex-ревью И3, находка 2): train_commit уже в журнале,
    // а phase_enter следующего такта не успел — restore возвращает на этот такт.
    // Повторный тап того же состава тем же движком НЕ плодит новую версию: модель
    // пересобирается (тот же детерминированный результат), но в журнал не пишется.
    // Исключение — эксперимент «проверить другую раскладку»: там «Научить» всегда
    // морозит НОВУЮ версию (полка растёт, строка «это версия 2»), даже если ребёнок
    // разложил идентично v1 — sig совпадает, но это осознанное обучение, не F5-повтор
    const dup = !(ctx.payload.experiments || {})[step.id]
      && trainAlreadyCommitted(ctx.payload, compositionSig(examples), ctx.classifier.engineId);
    // guard МЕСТА запуска (закалка 18.07, critical): и переход, и ПУБЛИКАЦИЯ модели/
    // train_commit принадлежат месту клика — reset, вход в резерв или смена такта
    // за время счёта эпох отменяют всё целиком, а не только переход
    const place = ctx.guarded(() => true);
    const go = ctx.guarded(() => ctx.advancePhase());
    const n = await trainWithProgress(ctx, examples, { shouldPublish: () => place() === true });
    if (n == null) return;                       // место ушло до публикации — движок не тронут
    if (place() !== true) { retrainToPayload(ctx); return; }   // узкое окно после публикации
    if (!dup) {
      // «Научить» — журнальный факт (фаза 0.5): состав замораживается в версию v1/v2/…;
      // restore после F5 переобучает модель из composition последней версии ЕЁ ЖЕ движком
      // (identity §3.1: состав+engine+params_rev — Codex-ревью 18.07, находки 4/5).
      // counts/engine/params_rev — аддитивные поля V2
      const version = ((ctx.payload.model && ctx.payload.model.version) || 0) + 1;
      const mi = ctx.classifier.modelInfo();
      const sig = mi.sig;
      ctx.j('train_commit', { version, sig, n, composition: examples,
                              counts: countsOf(ctx), ...engineTag(mi) });
      ctx.tele.push(step.mode === 'rails' ? 'trained' : 'retrained',
                    { n, version, sig, engine: mi.engine, params_rev: mi.params_rev });
    }
    go();
  }, { id: 'btn_train' });
  if (missingClasses) {
    btn.disabled = true;   // modelGate не подключаем: недостаток классов сильнее готовности
  } else ctx.modelGate(btn);
  const box = [kidText(boxStatus(ctx), { small: true })];
  if (missingClasses)
    box.push(h('div', { class: 'one-class-note', 'data-kid': '1', id: 'one_class_note' },
      'Нужны и ' + classWords.join(', и ') + ' — добавь картинки другой корзины!'));
  box.push(btn);
  if (missingClasses) {
    // путь из тупика: «Хватит, проверяем» с одноклассовым набором привёл сюда —
    // без возврата к подаче ребёнок был бы заперт на запертой кнопке
    const trapsPhase = trapsPhaseOf(step);
    const pool = step.images_from_role ? role(ctx, step.images_from_role) : role(ctx, 'trap');
    const restN = pool.filter(i => !ctx.payload.traps.includes(i.id)).length;
    if (trapsPhase && restN > 0)
      box.push(bigBtn('Добрать картинок', () => ctx.jumpToPhase(step.id, trapsPhase.id),
        { kind: 'secondary', id: 'btn_more_traps' }));
  }
  // «Разложить заново» (В-3): ТОЛЬКО до первого обучения — после первого train_commit
  // переукладка идёт по рельсам (ловушки) или через эксперимент после reveal (В-4).
  // Двухтактно (конституция п.7: необратимое = выбор → крупное подтверждение)
  const basketsPhase = step.phases.find(p => (p.elements || []).some(e => e.startsWith('basket_')));
  if (hasEl(phase, 'btn_relayout') && basketsPhase && !ctx.payload.model) {
    box.push(bigBtn('Разложить заново', () => {
      ctx.overlays.openModal(
        h('div', { class: 'modal-title', 'data-kid': '1' }, 'Разложить всё заново?'),
        kidText('Корзины опустеют — разложишь с первой картинки'),
        h('div', { class: 'modal-actions' },
          bigBtn('Да, заново', ctx.guarded(() => {
            ctx.overlays.closeModal();
            ctx.j('baskets_clear', {});
            ctx.tele.push('baskets_cleared', { step: step.id });
            ctx.jumpToPhase(step.id, basketsPhase.id);
          }), { id: 'btn_confirm_relayout' }),
          bigBtn('Назад', () => ctx.overlays.closeModal(), { kind: 'secondary', id: 'btn_cancel_confirm' })));
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
  // ИЛИ без ответа «Коробка права?» (вопрос обязателен — F5 его не обходит, И3-Т п.8)
  const lkey = 'probeptr_' + step.id + '_' + phase.id;
  if (ctx.local[lkey] == null) {
    let firstOpen = ids.findIndex(id => !(id in ctx.payload.probes)
      || !((ctx.payload.probe_judgements || {})[id]));
    if (firstOpen < 0) firstOpen = ids.length;
    // F5 между ответом «Коробка права?» и «Дальше» (Codex-ревью И3, минор 3): не глотать
    // подтверждение/разбор — если следующая проверка ещё не начата (вердикта нет), встаём
    // на последний отвеченный вердикт (экран «Записано…»/акцент), «Дальше» продолжит ленту.
    // Если вердикт следующей уже показан — ребёнок точно жал «Дальше», не откатываем
    if (firstOpen > 0 && (firstOpen === ids.length || !(ids[firstOpen] in ctx.payload.probes)))
      firstOpen -= 1;
    ctx.local[lkey] = firstOpen;
  }
  const ptr = ctx.local[lkey];
  const current = ids[ptr];
  const img = current && ctx.bankIndex.byId.get(current);
  // вердикт другой identity модели (движок/params сменились) — не показываем как текущий
  const verdict = current && verdictOfLiveModel(ctx, current);
  const judged = current && verdict && (ctx.payload.probe_judgements || {})[current];

  const input = [];
  if (img) {
    input.push(h('div', { class: 'feedcount' }, 'проверка ' + (ptr + 1) + ' из ' + ids.length));
    input.push(imgCard(ctx.assetsBase + img.src, { big: true, id: 'img_current' }));
  } else input.push(kidText('Все проверки пройдены!'));

  const checkBtn = hasEl(phase, 'btn_check') && img && !verdict && bigBtn('Проверить', () => {
    const v = ctx.classifier.classify(current);
    if (!v) return;
    const mi = ctx.classifier.modelInfo();
    ctx.j('probe_result', { img: current, label: v.label, conf: v.conf, margin: v.margin,
                            ...engineTag(mi) });
    ctx.tele.push('probe', { img: current, label: v.label, conf: v.conf,
                             engine: mi.engine, params_rev: mi.params_rev });
    ctx.render();
  }, { id: 'btn_check' });
  if (checkBtn) ctx.modelGate(checkBtn);

  const out = [];
  if (verdict) {
    out.push(verdictCard('Это ' + classLabel(ctx, verdict.label) + '!', verdict.conf, { margin: verdict.margin }));
    const wasWrong = !!img && verdict.label !== img.class;
    if (!judged) {
      // ОБЯЗАТЕЛЬНЫЙ вопрос на каждом вердикте (И3-Т п.8, решение владельца): ребёнок
      // судит сам ДО подсказок экрана — телеметрия внимательности; «Дальше» заперта.
      // Идемпотентность (Codex-ревью И3, минор 2): обе кнопки гаснут с ПЕРВОГО тапа —
      // двойной тап или быстрый тап по второй кнопке не перезаписывает ответ и не
      // дублирует телеметрию (второй клик прилетает в уже отсоединённый узел)
      const answer = (saw) => (ev) => {
        ev.currentTarget.parentElement.querySelectorAll('button')
          .forEach(b => { b.disabled = true; });
        if ((ctx.payload.probe_judgements || {})[current]) return;
        judgeProbe(ctx, current, verdict, saw, wasWrong);
      };
      out.push(kidText('Коробка права?'));
      out.push(h('div', { class: 'row' },
        bigBtn('Права', answer(false), { kind: 'secondary', id: 'btn_right' }),
        bigBtn('Ошиблась!', answer(true), { kind: 'secondary', id: 'btn_mistake' })));
    } else {
      // акцент на ошибке — ПОСЛЕ ответа ребёнка (иначе он подсказывал бы ответ):
      // драматургия «уверена — и ошибается» видна без голоса ведущего
      if (wasWrong) {
        const { word } = confWord(verdict.conf);
        out.push(h('div', { class: 'verdict-alert', 'data-kid': '1' },
          verdict.conf >= 75 ? 'Стоп… она ' + word + ' — и ошибается!'
                             : 'Она ошиблась — и сама сомневалась'));
      }
      out.push(kidText(judged.saw_mistake ? 'Записано: ты считаешь — ошиблась'
                                          : 'Записано: ты считаешь — права', { small: true }));
    }
  } else if (img) out.push(kidText('Жми «Проверить» — что скажет коробка?', { small: true }));
  // «Получилось!» — только когда результат есть И ребёнок ответил на вопрос
  ctx.local.reactionOk = !!(verdict && judged);

  const nextBtn = hasEl(phase, 'btn_next') && bigBtn('Дальше', () => {
    if (current) { ctx.local[lkey] = ptr + 1; ctx.render(); return; }
    // эксперимент «проверить другую раскладку»: пробы пройдены → назад к разгадке,
    // такты версии не перепоказываются (version/choice давно закоммичены)
    if ((ctx.payload.experiments || {})[step.id] && step.reveal) {
      ctx.jumpToPhase(step.id, step.phases[step.phases.length - 1].id);
      return;
    }
    ctx.advancePhase();
  }, { id: 'btn_next', disabled: !!current && !(verdict && judged) });

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

/* Разметка ловушек В КОРЗИНЫ (И4-Т B): в акте 2 ребёнок сам кладёт «кота-на-улице» в
 * корзину «Коты» — как в акте 1, но метка ловушки известна из банка. Кладёт РЕБЁНОК,
 * банк подтверждает: верная корзина → «Кот на улице — метка „кот" ✓», ловушка идёт в
 * обучение. Не в ту корзину → мягкая поправка (учим метке, не фону), ловушка не
 * добавляется. Ядро урока: данные = картинка + МЕТКА, а не «покажи картинку — ответ
 * машина узнает сама». Картинка — display-only (клик по корзине), поэтому НЕ в elements
 * и не входит в лимит ≤5: basket×2 + skip + next + undo = 5. Сохранены «по одной»,
 * undo, «Пропустить», «Хватит — проверяем» (≥1 ловушка). */
function trapBasketsFeed(ctx, step, phase) {
  const pool = step.images_from_role ? shuffledRole(ctx, step.images_from_role) : shuffledRole(ctx, 'trap');
  const added = new Set(ctx.payload.traps);
  const skipped = new Set(ctx.payload.trap_skips || []);
  // очередь: сперва невиданные, потом пропущенные (доступны в цикле добора)
  const rest = [...pool.filter(i => !added.has(i.id) && !skipped.has(i.id)),
                ...pool.filter(i => !added.has(i.id) && skipped.has(i.id))];
  const lkey = 'trapptr_' + step.id;
  const nkey = 'trapnote_' + step.id;
  const ptr = rest.length ? (ctx.local[lkey] || 0) % rest.length : 0;
  const current = rest.length ? rest[ptr] : null;
  const addedInPool = pool.filter(i => added.has(i.id)).length;
  const canStop = addedInPool >= 1;
  const baskets = (phase.elements || []).filter(e => e.startsWith('basket_'))
    .map(e => e.slice('basket_'.length));

  const place = (basket) => {
    if (!current) return;
    if (basket === current.class) {
      ctx.local[nkey] = { img: current.id, ok: true };
      ctx.j('trap_add', { img: current.id });
      ctx.tele.push('trap_added', { img: current.id, basket, correct: true });
    } else {
      // положил не в ту корзину — не добавляем, поправляем по МЕТКЕ (не по фону)
      ctx.local[nkey] = { img: current.id, ok: false };
      ctx.tele.push('trap_misplaced', { img: current.id, basket, truth: current.class });
    }
    ctx.render();
  };
  const clearNote = () => { ctx.local[nkey] = null; };

  const input = [];
  if (current) {
    input.push(h('div', { class: 'feedcount' }, 'размечено ' + addedInPool + ' из ' + pool.length));
    // display-only (клик по корзине, не drag) → не интерактив, вне лимита ≤5
    const card = imgCard(ctx.assetsBase + current.src, { big: true, id: 'img_current' });
    card.dataset.img = current.id;   // e2e/дебаг: какая ловушка в подаче
    input.push(card);
    input.push(kidText((current.caption ? current.caption + '. ' : '') +
      'В какую корзину?', { small: true }));
  } else {
    input.push(kidText('Все ' + pool.length + ' ловушек размечены!'));
  }
  // подтверждение/поправка последней раскладки (метка — из банка)
  const note = ctx.local[nkey];
  if (note) {
    const nimg = ctx.bankIndex.byId.get(note.img);
    if (note.ok)
      input.push(h('div', { class: 'trap-confirm', 'data-kid': '1' },
        '✓ ' + (nimg && nimg.caption ? nimg.caption : 'Картинка') +
        ' — метка «' + classOne(ctx, nimg ? nimg.class : '') + '»'));
    else if (nimg)
      input.push(h('div', { class: 'trap-correct', 'data-kid': '1' },
        'Приглядись: это ' + (nimg.caption || classOne(ctx, nimg.class)) +
        ' — её метка «' + classOne(ctx, nimg.class) + '», положи в «' + classLabel(ctx, nimg.class) + '»'));
  }
  const basketRow = h('div', { class: 'row baskets' },
    ...baskets.map(bid => {
      const el = h('div', {
        class: 'basket', id: 'basket_' + bid, role: 'button', tabindex: '0',
        onclick: () => place(bid),
        onkeydown: (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); place(bid); }
        },
      },
        h('div', { class: 'basket-lid' }),
        h('div', { class: 'basket-label' }, classLabel(ctx, bid)),
        h('div', { class: 'basket-count' },
          String(pool.filter(i => added.has(i.id) && i.class === bid).length)));
      return el;
    }));
  input.push(basketRow);

  const controls = h('div', { class: 'row' });
  if (hasEl(phase, 'btn_skip') && current)
    controls.append(bigBtn('Пропустить', () => {
      clearNote();
      ctx.j('trap_skip', { img: current.id });
      ctx.tele.push('trap_skipped', { img: current.id });
      ctx.local[lkey] = ptr + 1;
      ctx.render();
    }, { kind: 'ghost', id: 'btn_skip' }));
  if (hasEl(phase, 'btn_undo'))
    controls.append(bigBtn('Вернуть', () => {
      if (!ctx.payload.traps.length) return;
      clearNote();
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
    output: { content: kidText('Разметил — и научи заново', { small: true }), active: false },
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
 * изменений / хуже. beforeValid=false → сравнивать не с чем (stale-«Было»).
 * Сравнение честно только на ОДНОМ holdout-наборе (В-5, §3.1) — иначе null,
 * экран показывает «состав проверок менялся» и последний счёт. */
function measureOutcome(before, after, beforeValid) {
  if (!after) return null;
  if (!before || !beforeValid) return null;
  if (before.details && after.details && !sameMeasureSet(before, after)) return null;
  if (after.score > before.score) return 'Коробка стала работать лучше!';
  if (after.score === before.score && after.score === after.of) return 'Держит идеал — все ответы верные!';
  if (after.score === before.score) return 'Пока без изменений — можно добрать картинок';
  return 'Стало хуже — так бывает, можно добрать картинок';
}

/** Замер «после» честен только для ТЕКУЩЕЙ версии модели: после добора/переобучения
 * старый счёт принадлежит прошлой версии — его инвалидируем и меряем заново (фаза 0.5).
 * sig — подпись СОСТАВА (одна у всех движков): при смене движка на том же составе замер
 * тоже stale — сверяем и engine (identity §3.1, Codex-ревью 18.07). */
function afterIsStale(ctx, m) {
  const live = ctx.payload.model;
  if (!m.after || !live) return false;
  if (m.after.model_sig && live.sig !== m.after.model_sig) return true;
  if (m.after.engine && (live.engine || 'knn') !== m.after.engine) return true;
  // полная identity модели (§3.1, закалка 18.07): обновились frozen_params банка —
  // старый замер сделан другой функцией, показывать его как текущий нечестно
  if (m.after.params_rev != null && live.params_rev != null
      && live.params_rev !== m.after.params_rev) return true;
  return false;
}

/** Пара «Было → Стало» честна, только если «до» снят той же identity, что «после»:
 * та же раскладка (baskets_sig), тот же движок, те же params_rev (закалка 18.07 —
 * раньше финальная карточка не проверяла даже engine). */
function beforePairValid(ctx, m) {
  if (!m.before) return false;
  if (m.before.baskets_sig && m.before.baskets_sig !== basketsSig(ctx)) return false;
  if (m.before.engine && m.after && m.after.engine
      && m.before.engine !== m.after.engine) return false;
  if (m.before.params_rev != null && m.after && m.after.params_rev != null
      && m.before.params_rev !== m.after.params_rev) return false;
  return true;
}

/** Показанный вердикт пробы принадлежит модели, которой сделан: смена движка или
 * params_rev (fallback, ?engine=, обновление банка) делает его чужим — экран честно
 * предлагает проверить заново, а не выдаёт старый ответ за текущий (закалка 18.07). */
function verdictOfLiveModel(ctx, imgId) {
  const v = ctx.payload.probes[imgId];
  if (!v) return null;
  const live = ctx.payload.model;
  if (!live) return v;
  if (v.engine && (live.engine || 'knn') !== v.engine) return null;
  if (v.params_rev != null && live.params_rev != null && live.params_rev !== v.params_rev) return null;
  return v;
}

function measurePhase(ctx, step, phase) {
  const m = ctx.payload.measures;
  const out = [];
  if (m.after && !afterIsStale(ctx, m)) {
    // stale-«Было»: раскладка корзин менялась после замера «до» (restore/переразметка) —
    // старый счёт сделан ДРУГОЙ моделью, сравнивать нечестно (Codex D1–D2). Разные движки
    // или params_rev «до»/«после» — тоже разные модели (identity §3.1), сравнение прячем
    const beforeValid = beforePairValid(ctx, m);
    // сравнение честно только на одном holdout-наборе (В-5, §3.1); у старых записей
    // details может не быть — тогда набор неизвестен, показываем по-старому парой счётов
    const setKnown = !!(m.before && m.before.details && m.after.details);
    const sameSet = setKnown ? sameMeasureSet(m.before, m.after) : null;
    if (m.before && beforeValid && setKnown && sameSet) {
      // В-5: рост показом — два ряда одних holdout-миниатюр (было/стало), стрелки
      // на изменившихся, счёт — подписью (линза П4)
      out.push(growthCells(ctx, m.before, m.after));
      const errs = measureErrors(ctx, m.after);
      if (errs.length) out.push(h('div', { class: 'score-errors' },
        ...errs.map(t => h('div', { class: 'score-err', 'data-kid': '1' }, '✗ ' + t))));
    } else {
      if (m.before && beforeValid && setKnown && !sameSet)
        out.push(kidText('Состав проверок менялся — показываем последнюю', { small: true }));
      if (m.before && beforeValid && (!setKnown || sameSet)) out.push(scoreCard(m.before.score, m.before.of, 'Было'));
      if (m.before && !beforeValid)
        out.push(kidText('Раскладка менялась — старый замер не в счёт', { small: true }));
      out.push(scoreCard(m.after.score, m.after.of, 'Стало', { errors: measureErrors(ctx, m.after) }));
    }
    const outcome = measureOutcome(m.before, m.after, beforeValid);
    if (outcome) out.push(kidText(outcome, { small: true }));
    // цикл добора (фаза 0.5, стык с паттерном r2): замер слабее порога и остались
    // невзятые ловушки → назад к подаче, добрать и переучить (версия состава вырастет)
    const passN = parseInt(String(step.measure.pass).split('/')[0], 10) || m.after.of;
    // остаточная ошибка (решение владельца, откат порога 3/4): замер ПРОШЁЛ (score ≥ pass),
    // но не идеален (score < of) → разговорная строка, ведущий разбирает голосом «почему 3, а не 4».
    // При идеале (score == of) не показываем; данные — measure.residual_talk с {score}/{of}.
    if (step.measure.residual_talk && m.after.score >= passN && m.after.score < m.after.of)
      out.push(kidText(step.measure.residual_talk
        .replaceAll('{score}', m.after.score).replaceAll('{of}', m.after.of),
        { small: true }));
    const trapsPhase = trapsPhaseOf(step);
    const pool = step.images_from_role ? role(ctx, step.images_from_role) : role(ctx, 'trap');
    const restN = pool.filter(i => !ctx.payload.traps.includes(i.id)).length;
    const row = h('div', { class: 'row' });
    if (m.after.score < passN && trapsPhase && restN > 0)
      row.append(bigBtn('Добрать ловушки', () => {
        ctx.tele.push('traps_more', { step: step.id, rest: restN, score: m.after.score });
        ctx.jumpToPhase(step.id, trapsPhase.id);
      }, { id: 'btn_more_traps' }));
    // advancePhase || finishStep: у резерва (r2) замер — ПОСЛЕДНИЙ такт шага, без
    // finishStep «Дальше» не выходила из резерва (фикс-заход «ядро», рядом с п.6)
    row.append(bigBtn('Дальше', () => ctx.advancePhase() || ctx.finishStep(), { id: 'btn_check',
      kind: (m.after.score < passN && trapsPhase && restN > 0) ? 'secondary' : 'primary' }));
    out.push(row);
  } else {
    if (m.after && afterIsStale(ctx, m))
      out.push(kidText('Состав обучения менялся — проверь коробку заново', { small: true }));
    if (m.before) out.push(scoreCard(m.before.score, m.before.of, 'Было до ловушек'));
    // В-6 анти-тупик volatile (§3.1): канонический замер требует стабильной модели
    // (measure.requires_stable_model — дефолт true, иначе невоспроизводим после F5).
    // Активная версия с фоткой → одна фраза + одно действие, тупика нет (конституция п.5)
    const requiresStable = !step.measure || step.measure.requires_stable_model !== false;
    const live = ctx.payload.model;
    if (requiresStable && live && live.volatile) {
      out.push(kidText('Твоя фотка не идёт в проверку — научи коробку без неё'));
      const btn6 = bigBtn('Научить без фотки', async (ev) => {
        ev.currentTarget.disabled = true;
        const composition = stableComposition(live.composition);
        // guard места запуска — как у «Научить!» (закалка 18.07, critical): публикация
        // модели и train_commit отменяются целиком, если место ушло за время обучения
        const place = ctx.guarded(() => true);
        const go = ctx.guarded(() => ctx.render());   // не-volatile версия активна — замер открылся
        const n = await trainWithProgress(ctx, composition, { shouldPublish: () => place() === true });
        if (n == null) return;
        if (place() !== true) { retrainToPayload(ctx); return; }
        const version = live.version + 1;
        const mi = ctx.classifier.modelInfo();
        const sig = mi.sig;
        ctx.j('train_commit', { version, sig, n, composition,
                                counts: countsFromComposition(ctx, composition),
                                ...engineTag(mi) });
        ctx.tele.push('retrained', { n, version, sig, engine: mi.engine, params_rev: mi.params_rev });
        go();
      }, { id: 'btn_train_stable' });
      ctx.modelGate(btn6);
      out.push(btn6);
    } else {
      // замер ПО КНОПКЕ (И4-Т D): осознанный эксперимент «изменил данные → проверил
      // гипотезу» на ТЕХ ЖЕ картинках, что проба акта 1 — не автомагия
      const btn = bigBtn('Проверить на тех же ' + step.measure.holdout.length + ' картинках', () => {
        const r = ctx.classifier.measure(step.measure.holdout);
        const mi = ctx.classifier.modelInfo();
        ctx.j('measure_result', { phase: 'after', score: r.score, of: r.of, details: r.details,
                                  model_n: mi.n, model_sig: mi.sig, baskets_sig: basketsSig(ctx),
                                  ...engineTag(mi) });
        ctx.tele.push('measure', { phase: 'after', score: r.score, of: r.of, model_sig: mi.sig,
                                   engine: mi.engine, params_rev: mi.params_rev });
        ctx.render();
      }, { id: 'btn_check' });
      ctx.modelGate(btn);
      out.push(btn);
    }
  }
  return zones(ctx, step, {
    input: { content: kidText('Те же ' + step.measure.holdout.length + ' картинки, что в пробе', { small: true }), active: false },
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

/** «← Назад» по тактам версии (И3-Т п.2, фидбек #24): журнальный прыжок на предыдущий
 * такт шага. Только ДО acked-коммита версии (места вызова это гарантируют) — после
 * коммита ввод не перепоказывается. Лимиты ≤5 держатся: back добавляется на тактах
 * с ≤4 интерактивами. */
function backBtn(ctx, step, phase) {
  const idx = step.phases.findIndex(p => p.id === phase.id);
  if (idx <= 0) return null;
  const prev = step.phases[idx - 1];
  return bigBtn('← Назад', () => ctx.jumpToPhase(step.id, prev.id),
    { kind: 'ghost', id: 'btn_back' });
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
    h('div', { class: 'col' }, ...btns),
    slotIdx > 1 ? backBtn(ctx, step, phase) : null);
}

function freeTextPhase(ctx, step, phase) {
  const input = h('input', { class: 'kinput', id: 'free_text', maxlength: '120',
    placeholder: 'Допиши своими словами (не обязательно)' });
  if (ctx.payload.version.free_text) input.value = ctx.payload.version.free_text;
  return h('div', { class: 'taskcard private' },
    h('div', { class: 'private-mark' }, '🔒 видно только тебе'),
    kidText(versionSentence(ctx, step)),
    input,
    h('div', { class: 'row' },
      backBtn(ctx, step, phase),
      bigBtn('Дальше', () => {
        const text = input.value.trim();
        // очистка — тоже правка (закалка 18.07, минор): пустое поле при непустом
        // сохранённом тексте журналируется, старый текст не воскресает после F5
        if (text !== (ctx.payload.version.free_text || '')) ctx.j('free_text_set', { text });
        ctx.advancePhase();
      }, { id: 'btn_skip' })));
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
  // «← Назад» до отправки версии (И3-Т п.2): у прогноза свои такты — back только у версии
  if (!isForecast) body.push(backBtn(ctx, step, phase));
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
  // «крупно — один раз» (И3-Т п.4, фидбек #27): первый визит на такт разгадки показывает
  // иллюстрацию большой; повторные заходы (возврат после эксперимента/проб) — миниатюрой,
  // чтобы не выглядело дублем. Визит держит счётчик render() (_posVisit) — поллинг-
  // ререндеры того же визита картинку не сжимают; начатый эксперимент — признак
  // повтора, переживающий F5 (локальные флаги перезагрузка стирает)
  const revisit = !!(ctx.payload.experiments || {})[step.id];
  const vkey = 'reveal_big_visit_' + step.id;
  if (!revisit && ctx.local[vkey] == null && !ctx.local['reveal_seen_' + step.id])
    ctx.local[vkey] = ctx.local._posVisit;
  const firstView = !revisit && ctx.local[vkey] === ctx.local._posVisit;
  // ревизия порядка (И3-Т п.10, фидбек #25): сначала СЛОВА разгадки, потом иллюстрация,
  // потом версии группы — раньше картинка шла до текста и читалась «подписью не к тому»
  const body = [h('div', { class: 'reveal-title', 'data-kid': '1' }, 'Разгадка!')];
  if (r.text) body.push(kidText(r.text));
  for (const c of r.cards || []) body.push(imgCard(ctx.assetsBase + c, { big: firstView }));
  if (r.show_anon_versions && info && (info.anon_versions || []).length) {
    body.push(h('div', { class: 'anon-title', 'data-kid': '1' }, 'Версии группы (без имён):'));
    body.push(h('div', { class: 'anonlist' },
      ...info.anon_versions.map(v => h('div', { class: 'anonitem' },
        (v && (v.readable || v.text)) || 'версия из фрагментов'))));
  }
  // полка версий В-1: reveal_view — «спокойный» экран, тап по полке открывает карточку
  // версии (полка = один интерактив в счёте лимита ≤5)
  body.push(versionShelf(ctx, { tappable: true }));
  // «Проверить другую раскладку» (фаза 0.5): замок уже открыт (version/choice закоммичены),
  // эксперимент настоящий — раскладка с нуля, «Научить» даст новую версию состава,
  // пробы прогоняются заново, потом возврат сюда же. Двухтактно (В-4, конституция п.7):
  // сброс раскладки и показанных проб необратим — кнопка → крупное подтверждение
  const basketsPhase = step.phases.find(p => (p.elements || []).some(e => e.startsWith('basket_')));
  if (hasEl(phase, 'btn_next'))
    body.push(bigBtn('Дальше', () => ctx.advancePhase() || ctx.finishStep(), { id: 'btn_next' }));
  if (basketsPhase && ctx.commitDone('choice', step.id))
    body.push(bigBtn('Проверить другую раскладку', () => {
      ctx.overlays.openModal(
        h('div', { class: 'modal-title', 'data-kid': '1' }, 'Раскладка и проверки начнутся заново — точно?'),
        kidText('Версии на полке сохранятся', { small: true }),
        h('div', { class: 'modal-actions' },
          bigBtn('Да, проверить', ctx.guarded(() => {
            ctx.overlays.closeModal();
            ctx.j('experiment_start', { step: step.id });
            ctx.tele.push('experiment_start', { step: step.id });
            // указатели лент проб — с чистого листа (вердикты обнулены experiment_start)
            for (const k of Object.keys(ctx.local)) if (k.startsWith('probeptr_')) delete ctx.local[k];
            ctx.jumpToPhase(step.id, basketsPhase.id);
          }), { id: 'btn_confirm_experiment' }),
          bigBtn('Назад', () => ctx.overlays.closeModal(), { kind: 'secondary', id: 'btn_cancel_confirm' })));
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
  const done = verdictOfLiveModel(ctx, f.img);
  const out = [];
  ctx.local.reactionOk = !!done;   // «Получилось!» — только после фактического результата
  if (img) out.push(imgCard(ctx.assetsBase + img.src, { id: 'img_current' }));
  if (done) {
    out.push(verdictCard('Это ' + classLabel(ctx, done.label) + '!', done.conf, { margin: done.margin }));
    // «прогноз сбылся» — деривация из payload (вердикт + выбранный predict + expected),
    // а не локальный флаг вкладки: восстановленный экран самодостаточен после F5
    // (закалка 18.07, major «результат прогноза терялся»)
    const matchPredict = optionMatchesLabel(ctx, f, ctx.payload.forecast.predict, done.label);
    out.push(kidText(matchPredict ? 'Твой прогноз сбылся!' : 'Коробка ответила иначе — интересно почему?'));
    if (hasEl(phase, 'btn_next'))
      out.push(bigBtn('Дальше', () => ctx.advancePhase() || ctx.finishStep(), { id: 'btn_next' }));
  } else {
    const btn = bigBtn('Проверяем!', () => {
      const v = ctx.classifier.classify(f.img);
      if (!v) return;
      ctx.j('probe_result', { img: f.img, label: v.label, conf: v.conf, margin: v.margin,
                              ...engineTag(ctx.classifier.modelInfo()) });
      // совпадение прогноза: выбранная опция predict → класс. Опции — данные; сопоставление
      // делаем по индексу против фактической метки через expected (валидатор гарантирует поля).
      const matchPredict = optionMatchesLabel(ctx, f, ctx.payload.forecast.predict, v.label);
      const matchReason = ctx.payload.forecast.reason === f.expected.reason;
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
    const b = bigBtn(opt, () => {
      if (answered != null) return;
      ctx.j('quiz_answer', { card: card.id, answer: i });
      ctx.tele.push('quiz_click', { card: card.id, answer: i, correct: i === card.correct });
      ctx.render();
      setTimeout(ctx.guarded(() => ctx.advancePhase() || ctx.finishStep()), ctx.demo ? 250 : 900);
    }, { kind, id: 'quizopt' + i });
    // отвеченная карточка: варианты — подсветка разбора, не живые кнопки (закалка 18.07,
    // major «кнопки-пустышки»): не фокусируются и не тапаются, после F5 — тоже
    if (answered != null) { b.disabled = true; b.classList.add('quizopt-done'); }
    return b;
  })));
  if (answered != null) {
    body.push(kidText(answered === card.correct ? 'Верно!' : 'Правильный ответ подсвечен', { small: true }));
    // разговорный резерв (И4-Т F): короткая реакция + одна фраза-объяснение +
    // «Обсуди с ведущим, почему» — немой проход держит смысл без голоса ведущего
    if (card.explain) body.push(kidText(card.explain, { small: true }));
    if (step.talk_note) body.push(h('div', { class: 'talk-note', 'data-kid': '1' }, step.talk_note));
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
  // поле действия видно ДО того, как понадобится (линза П5, решение владельца 17.07):
  // панель чата показана заранее в неактивном виде — не появляется «из ниоткуда»
  const chatPreview = (hint) => h('div', { class: 'chatpanel chatpanel-preview' },
    h('div', { class: 'row' },
      h('input', { class: 'chatinput', disabled: true, placeholder: hint }),
      bigBtn('Отправить', null, { kind: 'secondary', disabled: true })));
  if (!started) {
    body.push(kidText('Сначала подумай молча — потом этот чат откроется', { small: true }));
    body.push(bigBtn('Начать думать (' + (step.think_sec || 30) + ' сек)', () => {
      ctx.local[key] = Date.now();
      ctx.render();
      // таймер принадлежит месту запуска (закалка 18.07, минор): ушли с такта
      // (резерв, reset, переход) — гаснет сам и НЕ рендерит чужой экран через 30 с
      const alive = ctx.guarded(() => true);
      const tick = setInterval(() => {
        if (alive() !== true) { clearInterval(tick); return; }
        const left = thinkSec - Math.floor((Date.now() - ctx.local[key]) / 1000);
        const el = document.getElementById('think_left');
        if (el) el.textContent = left > 0 ? String(left) : '';
        if (left <= 0) { clearInterval(tick); ctx.local[key + '_done'] = true; ctx.render(); }
      }, 300);
    }, { id: 'btn_think' }));
    body.push(chatPreview('Чат откроется после ' + (step.think_sec || 30) + ' сек'));
  } else if (!ctx.local[key + '_done'] && (Date.now() - started) / 1000 < thinkSec) {
    body.push(h('div', { class: 'thinktimer' }, h('span', { id: 'think_left' },
      String(Math.max(0, thinkSec - Math.floor((Date.now() - started) / 1000))))));
    body.push(kidText('Подумай молча…', { small: true }));
    body.push(chatPreview('Чат откроется — подумай молча'));
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
    // без изменений / хуже; stale-«Было» — сравнения нет. Пара валидна только при
    // полной identity (раскладка + движок + params_rev — закалка 18.07)
    const beforeValid = beforePairValid(ctx, m);
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
      // полка версий В-1: card_view — «спокойный» экран, тап открывает карточку версии
      versionShelf(ctx, { tappable: true }),
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
      // финал занятия (И4-Т E): только празднование сделанного — «что дальше»/next_block
      // убран решением владельца (допродавать ребёнку запертыми делами неэтично)
      return h('div', { class: 'taskcard finalcard finaldone' },
        h('div', { class: 'reveal-title', 'data-kid': '1' }, 'Дело №1 раскрыто ✓'),
        kidText('Ты детектив данных!'),
        kidText(ctx.payload.best_trap ? 'Лучшая ловушка отмечена — её увидят родители'
                                      : 'Ловушек не было', { small: true }),
        bigBtn('Закрыть дело №1', () => ctx.finishFinal(), { id: 'btn_next' }));
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
  // финал целиком закрывается на такте best_trap (И4-Т E): next_block удалён
  return null;
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
    // корзины: в шаге починки (traps_from_bank) — разметка ловушек (И4-Т B);
    // иначе — раскладка train_core акта 1
    if (hasRe(phase, /^basket_/))
      return (step.traps_from_bank ? trapBasketsFeed : basketsFeed)(ctx, step, phase);
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
