/* Тесты клиент-ядра (node --test app): журнал+rev, restore через ЕДИНЫЙ редьюсер,
 * машина состояний из манифеста, стабильность op_id в ретраях acked-транспорта.
 * Браузерного API нет — модули ядра чистые, storage/fetch инжектятся. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { normalizeLesson, indexBank } from './manifest.js';
import { reduce, initialPayload, replay, basketsByImg, activeStableModel,
         stableComposition, beforeMeasureHonest, measureBindingIntact,
         trainAlreadyCommitted } from './reducer.js';
import { createMachine } from './machine.js';
import { createJournal } from './journal.js';
import { applyRestore, createSeatSave } from './save.js';
import { createAcked } from './acked.js';
import { walkLesson } from './walk.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const readJson = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf-8'));
const Z1 = readJson('content/z1-kot/lesson.json');
const Z1BANK = readJson('content/z1-kot/bank.json');

const memStorage = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null),
           setItem: (k, v) => m.set(k, String(v)),
           removeItem: k => m.delete(k) };
};

test('редьюсер: undo снимает последнюю раскладку, captcha_toggle туда-обратно', () => {
  const p = initialPayload();
  reduce(p, { type: 'basket_assign', args: { img: 't1', basket: 'cat' } });
  reduce(p, { type: 'basket_assign', args: { img: 't2', basket: 'dog' } });
  reduce(p, { type: 'basket_undo', args: {} });
  assert.deepEqual(basketsByImg(p), { t1: 'cat' });
  reduce(p, { type: 'captcha_toggle', args: { card: 'cap1', cell: 0 } });
  reduce(p, { type: 'captcha_toggle', args: { card: 'cap1', cell: 3 } });
  reduce(p, { type: 'captcha_toggle', args: { card: 'cap1', cell: 0 } });
  assert.deepEqual(p.captcha.cap1, [3]);
  assert.throws(() => reduce(p, { type: 'левый_тип', args: {} }), /словарь закрыт/);
});

test('редьюсер: mistake_mark дедупится, measure_result хранит версию состава и детали', () => {
  const p = initialPayload();
  reduce(p, { type: 'mistake_mark', args: { img: 'p1' } });
  reduce(p, { type: 'mistake_mark', args: { img: 'p1' } });
  reduce(p, { type: 'mistake_mark', args: { img: 'p3' } });
  assert.deepEqual(p.mistakes, ['p1', 'p3']);
  reduce(p, { type: 'measure_result', args: { phase: 'before', score: 1, of: 4,
    details: [{ img: 'h1', label: 'dog', conf: 90, ok: false }],
    model_n: 16, model_sig: 'abc', baskets_sig: 'xyz' } });
  assert.equal(p.measures.before.model_sig, 'abc');
  assert.equal(p.measures.before.baskets_sig, 'xyz');
  assert.equal(p.measures.before.details.length, 1);
  // старый снапшот без mistakes (до расширения словаря) — replay не падает
  const old = initialPayload();
  delete old.mistakes;
  reduce(old, { type: 'mistake_mark', args: { img: 'p2' } });
  assert.deepEqual(old.mistakes, ['p2']);
});

test('редьюсер И3-Т: probe_judgement — обязательный ответ, mistakes пополняется, эксперимент чистит', () => {
  const p = initialPayload();
  // «Права» — в mistakes не попадает, ответ записан
  reduce(p, { type: 'probe_judgement', args: { img: 'p1', saw_mistake: false, correct: true } });
  assert.deepEqual(p.probe_judgements.p1, { saw_mistake: false, correct: true });
  assert.deepEqual(p.mistakes, []);
  // «Ошиблась!» — тот же счётчик карточки дела, что у легаси mistake_mark
  reduce(p, { type: 'probe_judgement', args: { img: 'p2', saw_mistake: true, correct: true } });
  assert.deepEqual(p.mistakes, ['p2']);
  // легаси-алиас mistake_mark живёт рядом (реплей старых журналов)
  reduce(p, { type: 'mistake_mark', args: { img: 'p3' } });
  assert.deepEqual(p.mistakes, ['p2', 'p3']);
  // старый снапшот без probe_judgements — replay не падает
  const old = initialPayload();
  delete old.probe_judgements;
  reduce(old, { type: 'probe_judgement', args: { img: 'p4', saw_mistake: true, correct: false } });
  assert.equal(old.probe_judgements.p4.correct, false);
  // «проверить другую раскладку»: ответы принадлежат вердиктам — обнуляются вместе
  reduce(p, { type: 'probe_result', args: { img: 'p1', label: 'cat', conf: 80, margin: 0.04 } });
  reduce(p, { type: 'experiment_start', args: { step: 's2' } });
  assert.deepEqual(p.probes, {});
  assert.deepEqual(p.probe_judgements, {});
});

test('редьюсер И3-Т: beforeMeasureHonest — «до» не мерится уже починенной моделью (баг #33)', () => {
  const pool = ['t1', 't2', 't3'];
  // модели нет — гейт по exampleCount, функция не запрещает
  assert.equal(beforeMeasureHonest(initialPayload(), pool), true);
  // v1 без ловушек — честное «до»
  const p = initialPayload();
  reduce(p, { type: 'train_commit', args: { version: 1, sig: 'v1', n: 2,
    composition: [{ img: 'c1', class: 'cat' }, { img: 'd1', class: 'dog' }] } });
  assert.equal(beforeMeasureHonest(p, pool), true);
  // модель уже содержит ловушку из пула шага (догоняющий / подсказка l3 / рестарт run):
  // «до» с неё дало бы карточку «3 → 3 из 4» — запрещено
  reduce(p, { type: 'trap_add', args: { img: 't1' } });
  reduce(p, { type: 'train_commit', args: { version: 2, sig: 'v2', n: 3,
    composition: [{ img: 'c1', class: 'cat' }, { img: 'd1', class: 'dog' },
                  { img: 't1', class: 'cat' }] } });
  assert.equal(beforeMeasureHonest(p, pool), false);
  // пустой пул (шаг без починки) — ограничения нет
  assert.equal(beforeMeasureHonest(p, []), true);
});

test('Codex-И3 п.1: measureBindingIntact — отложенный авто-«до» привязан к машине/шагу/версии модели', () => {
  const norm = normalizeLesson(Z1);
  const main = createMachine(norm);
  const measureStep = norm.steps.find(s => s.measure && s.measure.before === 'auto');
  main.jumpTo(measureStep.id);
  const payload = initialPayload();
  reduce(payload, { type: 'train_commit', args: { version: 1, sig: 'v1', n: 1,
    composition: [{ img: 'c1', class: 'cat' }] } });
  const at = (m) => ({ machine: m, stepId: m.done ? null : m.step().id,
                       modelVersion: payload.model ? payload.model.version : null });
  const bind = at(main);   // здесь колбэк планировался (вход в шаг замера)
  assert.ok(measureBindingIntact(bind, at(main)), 'то же место — замер пишется');
  // УХОД В РЕЗЕРВ во время ожидания whenReady: ctx.machine подменяется новой машиной
  // с резервным шагом — колбэк не должен записать «до» в чужой контекст
  const reserve = createMachine({ ...norm, steps: [norm.reserve[0]] });
  assert.ok(!measureBindingIntact(bind, at(reserve)), 'в резерве отложенный замер не пишется');
  // вернулись из резерва — та же главная машина на том же шаге: замер снова законен
  assert.ok(measureBindingIntact(bind, at(main)), 'после возврата из резерва привязка цела');
  // переход шага той же машиной — замер принадлежал прошлому шагу
  main.jumpTo(norm.steps[0].id);
  assert.ok(!measureBindingIntact(bind, at(main)), 'смена шага рвёт привязку');
  main.jumpTo(measureStep.id);
  // новый train_commit за время ожидания — «до» мерило бы другую версию модели
  reduce(payload, { type: 'train_commit', args: { version: 2, sig: 'v2', n: 2,
    composition: [{ img: 'c1', class: 'cat' }, { img: 'd1', class: 'dog' }] } });
  assert.ok(!measureBindingIntact(bind, at(main)), 'смена версии модели рвёт привязку');
});

test('Codex-И3 п.2: trainAlreadyCommitted — F5 после «Научить» не плодит версию того же состава', () => {
  const p = initialPayload();
  assert.equal(trainAlreadyCommitted(p, 'sig1', 'knn'), false, 'до первого обучения дубля нет');
  reduce(p, { type: 'train_commit', args: { version: 1, sig: 'sig1', n: 2, engine: 'knn',
    composition: [{ img: 'c1', class: 'cat' }, { img: 'd1', class: 'dog' }] } });
  assert.equal(trainAlreadyCommitted(p, 'sig1', 'knn'), true,
    'тот же состав тем же движком — уже закоммичен, повторный тап пропускает журнал');
  assert.equal(trainAlreadyCommitted(p, 'sig2', 'knn'), false, 'новый состав — новая версия законна');
  assert.equal(trainAlreadyCommitted(p, 'sig1', 'head'), false,
    'другой движок при том же составе — не дубль (identity §3.1: sig+engine)');
  // запись фазы 0.5 без engine читается как knn
  const old = initialPayload();
  reduce(old, { type: 'train_commit', args: { version: 1, sig: 'x', n: 1,
    composition: [{ img: 'c1', class: 'cat' }] } });
  assert.equal(trainAlreadyCommitted(old, 'x', 'knn'), true, 'дефолт чтения engine — knn');
});

test('редьюсер фазы 0.5: baskets_clear, train_commit (версии), experiment_start, trap_skip', () => {
  const p = initialPayload();
  reduce(p, { type: 'basket_assign', args: { img: 't1', basket: 'cat' } });
  reduce(p, { type: 'basket_assign', args: { img: 't2', basket: 'dog' } });
  reduce(p, { type: 'baskets_clear', args: {} });
  assert.deepEqual(p.baskets, [], '«разложить заново» очищает раскладку');
  reduce(p, { type: 'basket_assign', args: { img: 't1', basket: 'dog' } });
  reduce(p, { type: 'train_commit', args: { version: 1, sig: 'aaa', n: 1,
    composition: [{ img: 't1', class: 'dog' }] } });
  reduce(p, { type: 'train_commit', args: { version: 2, sig: 'bbb', n: 2,
    composition: [{ img: 't1', class: 'dog' }, { img: 'tr1', class: 'cat' }] } });
  assert.equal(p.model.version, 2, 'текущая версия состава — последняя');
  assert.equal(p.model.composition.length, 2);
  assert.deepEqual(p.model_history.map(h => h.sig), ['aaa', 'bbb'], 'история версий копится');
  reduce(p, { type: 'probe_result', args: { img: 'p1', label: 'dog', conf: 88, margin: 0.05 } });
  reduce(p, { type: 'experiment_start', args: { step: 's2' } });
  assert.deepEqual(p.baskets, [], 'эксперимент начинает раскладку с нуля');
  assert.deepEqual(p.probes, {}, 'показанные пробы обнулены — новая модель проверяется честно');
  assert.equal(p.model.version, 2, 'модель остаётся прежней версии до нового «Научить»');
  assert.ok(p.experiments.s2, 'флаг эксперимента переживает F5 (в payload)');
  reduce(p, { type: 'trap_skip', args: { img: 'tr2' } });
  reduce(p, { type: 'trap_skip', args: { img: 'tr2' } });
  assert.deepEqual(p.trap_skips, ['tr2'], 'пропуск ловушки дедупится');
  // старый снапшот без полей фазы 0.5 — replay не падает
  const old = initialPayload();
  delete old.trap_skips; delete old.model_history; delete old.experiments;
  reduce(old, { type: 'trap_skip', args: { img: 'tr1' } });
  reduce(old, { type: 'train_commit', args: { version: 1, sig: 'x', n: 0, composition: [] } });
  reduce(old, { type: 'experiment_start', args: { step: 's2' } });
  assert.ok(old.trap_skips.length === 1 && old.model_history.length === 1 && old.experiments.s2);
});

test('редьюсер V2: train_commit несёт counts/engine/volatile, история хранит composition', () => {
  const p = initialPayload();
  reduce(p, { type: 'train_commit', ts: 1700000001000, args: { version: 1, sig: 'aaa', n: 2,
    composition: [{ img: 't1', class: 'cat' }, { img: 't2', class: 'dog' }],
    counts: { cat: 1, dog: 1, traps: 0 } } });
  assert.equal(p.model.engine, 'knn', 'дефолт чтения engine — knn');
  assert.equal(p.model.volatile, false, 'дефолт volatile — false');
  assert.deepEqual(p.model.counts, { cat: 1, dog: 1, traps: 0 });
  const h = p.model_history[0];
  assert.equal(h.composition.length, 2, 'история хранит состав целиком (переживает переукладку)');
  assert.equal(h.ts, 1700000001000, 'когда научена — для карточки версии');
  // запись фазы 0.5 БЕЗ новых полей реплеится без миграции
  reduce(p, { type: 'train_commit', args: { version: 2, sig: 'bbb', n: 1,
    composition: [{ img: 't1', class: 'dog' }] } });
  assert.equal(p.model.version, 2);
  assert.equal(p.model.counts, null);
});

test('редьюсер V2: activeStableModel — последняя не-volatile версия (анти-тупик В-6)', () => {
  const p = initialPayload();
  assert.equal(activeStableModel(p), null, 'до первого обучения стабильной версии нет');
  reduce(p, { type: 'train_commit', args: { version: 1, sig: 'v1', n: 1,
    composition: [{ img: 't1', class: 'cat' }] } });
  assert.equal(activeStableModel(p).sig, 'v1');
  // версия с фоткой (класс C): активная — volatile, стабильная — прежняя v1
  reduce(p, { type: 'train_commit', args: { version: 2, sig: 'v2vol', n: 2, volatile: true,
    composition: [{ img: 't1', class: 'cat' }, { img: 'local:ph1', class: 'dog' }] } });
  assert.equal(p.model.sig, 'v2vol', 'на полке активная — volatile');
  assert.equal(activeStableModel(p).sig, 'v1', 'restore и замеры идут по стабильной');
  // «Научить без фотки» даёт новую не-volatile — она и становится стабильной
  reduce(p, { type: 'train_commit', args: { version: 3, sig: 'v3', n: 1,
    composition: [{ img: 't1', class: 'cat' }] } });
  assert.equal(activeStableModel(p).sig, 'v3');
  // «Научить без фотки» (В-6): local-примеры класса C отфильтровываются из состава
  assert.deepEqual(
    stableComposition([{ img: 't1', class: 'cat' }, { img: 'local:ph1', class: 'dog' },
                       { img: 'tr1', class: 'dog' }]).map(c => c.img),
    ['t1', 'tr1']);
});

test('журнал: стартовый rev нового инстанса = max(server_rev, local_rev) + 1', () => {
  const j = createJournal({ storage: memStorage() });
  j.append('basket_assign', { img: 't1', basket: 'cat' });   // local rev 1
  j.initRev(10);                                             // server_rev 10 > local
  const e = j.append('basket_undo', {});
  assert.equal(e.rev, 11);
  j.initRev(5);                                              // server МЕНЬШЕ local — не откатывает
  assert.equal(j.append('trap_add', { img: 'tr1' }).rev, 12);
});

test('restore: серверная база + replay журнала с rev > server_rev через ТОТ ЖЕ reduce', () => {
  const storage = memStorage();
  const j = createJournal({ storage });
  // хвост в localStorage: rev 5 уже в серверном снапшоте (дебаунс доехал), rev 6–7 — нет
  storage.setItem('z1_journal', JSON.stringify({ counter: 7, entries: [
    { type: 'basket_assign', args: { img: 't1', basket: 'ПЕРЕЗАПИШЕТ_СЕРВЕР' }, rev: 5, ts: 1 },
    { type: 'basket_assign', args: { img: 't3', basket: 'cat' }, rev: 6, ts: 2 },
    { type: 'trap_add', args: { img: 'tr1' }, rev: 7, ts: 3 },
  ] }));
  const view = { server_rev: 5,
    payload: { ...initialPayload(), baskets: [{ img: 't1', basket: 'cat' }] } };
  const { payload } = applyRestore(view, j);
  // база сервера цела, rev≤5 НЕ переигрывается, rev 6–7 накатились
  assert.deepEqual(payload.baskets,
    [{ img: 't1', basket: 'cat' }, { img: 't3', basket: 'cat' }]);
  assert.deepEqual(payload.traps, ['tr1']);
  assert.equal(j.append('basket_undo', {}).rev, 8);          // счётчик продолжен
});

test('restore: acked-склейка сервера главнее локального снапшота (перепоказа нет)', () => {
  // сервер вернул acked.version — клиент обязан считать версию закоммиченной,
  // даже если payload снапшота её не знает (F5 в окне «коммит принят, сейв не доехал»)
  const view = { server_rev: 3, payload: initialPayload(),
                 acked: { s2: { version: { data: { slots: { 1: 2 } } } } } };
  const j = createJournal({ storage: memStorage() });
  const { view: v } = applyRestore(view, j);
  assert.ok(v.acked.s2.version, 'авторитетный слой acked доступен после склейки');
});

test('машина: манифест z1 → шаги/такты, acked-требования входа, restoreTo', () => {
  const norm = normalizeLesson(Z1);
  const events = [];
  const m = createMachine(norm, { onJournal: (t, a) => events.push([t, a.phase]) });
  assert.equal(m.position().step, 's1');
  assert.deepEqual(m.entryRequirement(), { ack: 'gate_enter', step: 's1', kind: 'code' });
  m.advanceStepAcked();                                      // после ack сервера
  assert.equal(m.position().step, 's1q');
  assert.deepEqual(m.entryRequirement(), { ack: 'step_enter', step: 's1q' });
  m.advanceStepAcked();                                      // s2 — шаг контрольной точки
  m.restoreTo('s2.train');                                   // hint l3 ВНУТРИ текущего шага
  assert.deepEqual(m.position().phase, 'train');
  assert.ok(events.some(([t, p]) => t === 'phase_enter' && p === 'train'));
});

test('walkthrough z1: проходимость до done с валидным журналом', () => {
  const res = walkLesson(normalizeLesson(Z1), indexBank(Z1BANK));
  assert.deepEqual(res.errors, []);
  assert.ok(res.journal.length > 20);
  assert.ok(res.acked.some(a => a.ack === 'commit' && a.type === 'version'));
});

test('acked: op_id стабилен в ретраях, очередь переживает «F5» (resendPending)', async () => {
  const seen = [];
  let fail = 2;
  const fetchFn = async (u, opts) => {
    const body = JSON.parse(opts.body);
    seen.push(body.op_id);
    if (fail > 0) { fail -= 1; throw new Error('сеть упала'); }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const storage = memStorage();
  const a = createAcked({ seat: '3', runId: 'r1', instanceId: 'A',
                          getGeneration: () => 1, getEpoch: () => 0,
                          storage, retryMs: [1, 1], fetchFn });
  await a.commit('version', 's2', { text: 'фон' });
  assert.equal(seen.length, 3);
  assert.ok(seen.every(id => id === seen[0]), 'op_id не меняется между попытками');
  assert.equal(a.pendingCount(), 0);
  // «F5»: неотправленная операция поднимается из storage с ТЕМ ЖЕ op_id
  storage.setItem('z1_acked_pending',
    JSON.stringify([{ op_id: 'op-persist', type: 'choice', step: 's2', data: { option: 1 } }]));
  const b = createAcked({ seat: '3', runId: 'r1', instanceId: 'A',
                          getGeneration: () => 1, getEpoch: () => 0,
                          storage, retryMs: [1], fetchFn });
  await b.resendPending();
  assert.equal(seen[seen.length - 1], 'op-persist');
});

test('seat-save: дебаунс-снапшот, other_tab, takeover сбрасывает буфер', async () => {
  const calls = [];
  let generation = 1;
  const responses = [
    { ok: true, accepted_rev: 2, writer_generation: 1 },
    { ok: false, error: 'other_tab', writer_generation: 2 },
    { ok: true, accepted_rev: 3, writer_generation: 3, server_rev: 3 },
  ];
  const fetchFn = async (u, opts) => {
    calls.push(JSON.parse(opts.body));
    const r = responses.shift();
    return { ok: !r.error, status: r.error ? 409 : 200, json: async () => r };
  };
  const j = createJournal({ storage: memStorage() });
  j.append('basket_assign', { img: 't1', basket: 'cat' });
  j.append('basket_assign', { img: 't2', basket: 'dog' });
  let sawOtherTab = false;
  const s = createSeatSave({ seat: '3', runId: 'r1', lessonId: 'z1-kot', instanceId: 'A',
    getGeneration: () => generation, setGeneration: g => { generation = g; },
    getState: () => ({ step: 's2' }), getPayload: () => ({ x: 1 }), journal: j,
    onOtherTab: () => { sawOtherTab = true; }, fetchFn });
  await s.flushNow();
  assert.equal(calls[0].rev, 2);
  assert.equal(j.entries().length, 0, 'подтверждённое подрезано (accepted_rev=2)');
  j.append('trap_add', { img: 'tr1' });                       // rev 3
  await s.flushNow();                                         // сервер: other_tab
  assert.ok(sawOtherTab);
  await s.takeover();                                         // «Продолжить здесь»
  assert.equal(calls[2].takeover, true);
  assert.equal(generation, 3, 'приняли generation сервера');
  assert.equal(j.entries().length, 0, 'буфер после takeover начат с нуля');
});

test('save_seq: монотонный счётчик вех в каждом /save, нумерация продолжается с серверной', async () => {
  const calls = [];
  const fetchFn = async (u, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, accepted_rev: 0, writer_generation: 1 }) };
  };
  const j = createJournal({ storage: memStorage() });
  const s = createSeatSave({ seat: '3', runId: 'r1', lessonId: 'z1-kot', instanceId: 'A',
    getGeneration: () => 1, setGeneration: () => {},
    getState: () => 's2', getPayload: () => ({}), journal: j,
    initialSaveSeq: 7,                       // из /restore (сервер хранит последнюю веху)
    fetchFn });
  await s.flushNow();
  await s.flushNow();
  assert.equal(calls[0].save_seq, 8, 'первая веха после F5 идёт СЛЕДОМ за серверной');
  assert.equal(calls[1].save_seq, 9, 'каждый /save несёт строго растущий save_seq');
});
