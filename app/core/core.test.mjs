/* Тесты клиент-ядра (node --test app): журнал+rev, restore через ЕДИНЫЙ редьюсер,
 * машина состояний из манифеста, стабильность op_id в ретраях acked-транспорта.
 * Браузерного API нет — модули ядра чистые, storage/fetch инжектятся. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { normalizeLesson, indexBank } from './manifest.js';
import { reduce, initialPayload, replay, basketsByImg } from './reducer.js';
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
  m.restoreTo('s2.train');                                   // контрольная точка hint l3
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
