/* Тесты фикс-захода «ядро» (аудит Codex 18.07): заморозка прав в acked-операциях,
 * владелец записей журнала, идентичность вкладки (Web Locks), claim-only takeover,
 * сериализация поллинга, restoreTo внутри шага, done после F5, резерв в walk,
 * производные mistakes при эксперименте. Каждый тест до фикса был красным. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { normalizeLesson, indexBank, phaseSemantics } from './manifest.js';
import { reduce, initialPayload } from './reducer.js';
import { createMachine } from './machine.js';
import { createJournal } from './journal.js';
import { createSeatSave, claimInstanceId } from './save.js';
import { createAcked } from './acked.js';
import { createPoll } from './poll.js';
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

/* ---------- critical 1: заморозка прав в acked-операции ---------- */

test('acked critical 1: generation/epoch заморожены при создании — ретрай после сброса несёт старые', async () => {
  let epoch = 0, gen = 1;
  const bodies = [];
  let first = true;
  const fetchFn = async (u, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (first) { first = false; throw new Error('сеть упала'); }
    // сервер после /host/reset_version: старый epoch → терминальный отказ
    return { ok: false, status: 409, json: async () => ({ ok: false, error: 'stale_epoch', epoch: 1 }) };
  };
  const a = createAcked({ seat: '1', runId: 'r1', instanceId: 'A',
                          getGeneration: () => gen, getEpoch: () => epoch,
                          storage: memStorage(), retryMs: [1], fetchFn });
  const pr = a.commit('version', 's2', { slots: { 1: 1 } });
  pr.catch(() => {});                    // отказ ожидаем ниже, не как unhandled
  epoch = 1; gen = 2;                    // сброс ведущим ПОКА операция в полёте
  await assert.rejects(pr, /stale_epoch/, 'операция отменённой эпохи — терминальный отказ');
  assert.equal(bodies.length, 2);
  // ключевая заморозка: ретрай НЕ подобрал свежие права — иначе обошёл бы stale_epoch
  // и воскресил отменённый коммит (до фикса тут было epoch:1, generation:2)
  assert.equal(bodies[1].epoch, 0, 'ретрай несёт epoch создания операции');
  assert.equal(bodies[1].writer_generation, 1, 'ретрай несёт generation создания операции');
  assert.equal(bodies[1].client_instance_id, 'A');
});

test('acked critical 1: resendPending после F5 шлёт замороженные права из storage', async () => {
  const storage = memStorage();
  storage.setItem('z1_acked_pending', JSON.stringify([
    { op_id: 'op-old', type: 'version', step: 's2', data: {},
      instance: 'OLD', generation: 3, epoch: 7 },
  ]));
  const bodies = [];
  const fetchFn = async (u, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const a = createAcked({ seat: '1', runId: 'r1', instanceId: 'NEW',
                          getGeneration: () => 5, getEpoch: () => 9,
                          storage, retryMs: [1], fetchFn });
  await a.resendPending();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].client_instance_id, 'OLD');
  assert.equal(bodies[0].writer_generation, 3);
  assert.equal(bodies[0].epoch, 7);
  assert.equal(bodies[0].op_id, 'op-old');
});

test('acked: clearPending чистит очередь и storage (takeover новой вкладки)', async () => {
  const storage = memStorage();
  storage.setItem('k', JSON.stringify([{ op_id: 'x', type: 'version', step: 's2', data: {} }]));
  const a = createAcked({ seat: '1', runId: 'r1', instanceId: 'A', storageKey: 'k',
                          getGeneration: () => 1, getEpoch: () => 0, storage,
                          fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) });
  a.clearPending();
  assert.equal(JSON.parse(storage.getItem('k')).length, 0);
  await a.resendPending();               // ничего не шлёт (очередь пуста)
  assert.equal(a.pendingCount(), 0);
});

/* ---------- critical 4: владелец записей журнала ---------- */

test('журнал critical 4: чужой хвост (другой instance/generation) не реплеится, rev не переиспользуется', () => {
  const storage = memStorage();
  const jA = createJournal({ storage, owner: { inst: 'A', gen: 1 } });
  jA.append('trap_add', { img: 'x' });                       // rev 1, владелец A/1
  // вкладка B после takeover (generation 2) — тот же localStorage браузера
  const jB = createJournal({ storage, owner: { inst: 'B', gen: 2 } }).load();
  assert.equal(jB.entries().length, 0, 'хвост старого писателя не реплеится поверх новой базы');
  assert.equal(jB.append('trap_add', { img: 'y' }).rev, 2, 'счётчик продолжен — rev чужих записей не переиспользуется');
  // свой хвост после F5 той же вкладки — реплеится
  const jB2 = createJournal({ storage, owner: { inst: 'B', gen: 2 } }).load();
  assert.equal(jB2.entries().length, 1);
  assert.equal(jB2.entries()[0].args.img, 'y');
  // тот же instance, но СТАРАЯ generation (запись до takeover) — не реплеится
  const jA2 = createJournal({ storage, owner: { inst: 'A', gen: 2 } }).load();
  assert.equal(jA2.entries().length, 0);
  // записи старого формата (без владельца) — консервативно не реплеятся, но двигают счётчик
  storage.setItem('legacy', JSON.stringify({ counter: 0, entries: [
    { type: 'trap_add', args: {}, rev: 7 }] }));
  const jC = createJournal({ storage, storageKey: 'legacy', owner: { inst: 'C', gen: 1 } }).load();
  assert.equal(jC.entries().length, 0);
  assert.equal(jC.maxRev(), 7);
});

test('журнал: без owner (легаси-вызов) поведение прежнее — всё реплеится', () => {
  const storage = memStorage();
  createJournal({ storage }).append('trap_add', { img: 'x' });
  const j = createJournal({ storage }).load();
  assert.equal(j.entries().length, 1);
});

/* ---------- critical «две вкладки»: идентичность вкладки через Web Locks ---------- */

const fakeLocksHeld = () => {
  const held = new Set();
  return {
    held,
    request(name, opts, cb) {
      if (held.has(name)) return Promise.resolve(cb(null));  // ifAvailable: лок занят
      held.add(name);
      return Promise.resolve(cb({ name }));                  // держим (в тесте — навсегда)
    },
  };
};

test('две вкладки critical: дубль с тем же sessionStorage берёт НОВЫЙ instanceId (Web Locks)', async () => {
  const locks = fakeLocksHeld();
  const tabA = memStorage();
  const idA = await claimInstanceId({ storage: tabA, key: 'k', locks });
  assert.ok(idA, 'первая вкладка получила id');
  // дубль вкладки: sessionStorage СКОПИРОВАН, лок id A держит живая вкладка A
  // (retry укорочен: в проде ретраи пережидают отложенный release лока при reload)
  const tabB = memStorage();
  tabB.setItem('k', tabA.getItem('k'));
  const idB = await claimInstanceId({ storage: tabB, key: 'k', locks,
                                      retry: { attempts: 2, delayMs: 1 } });
  assert.notEqual(idB, idA, 'два живых документа не считаются одним писателем');
  assert.ok(locks.held.has('z1_tab_' + idB), 'дубль держит лок своего id');
  assert.equal(JSON.parse(tabB.getItem('k')).id, idB, 'дубль запомнил СВОЙ id на свой F5');
});

test('две вкладки: F5 той же вкладки (лок отпущен) — тот же instanceId', async () => {
  const locks1 = fakeLocksHeld();
  const store = memStorage();
  const id1 = await claimInstanceId({ storage: store, key: 'k', locks: locks1 });
  // закрытие/перезагрузка вкладки отпускает лок → новый документ той же вкладки
  const locks2 = fakeLocksHeld();
  const id2 = await claimInstanceId({ storage: store, key: 'k', locks: locks2 });
  assert.equal(id2, id1, 'F5 той же вкладки — тот же писатель (single-writer §1.1)');
});

test('две вкладки: без Web Locks API поведение прежнее (доверяем sessionStorage)', async () => {
  const store = memStorage();
  store.setItem('k', JSON.stringify({ id: 'saved-id' }));
  assert.equal(await claimInstanceId({ storage: store, key: 'k', locks: null }), 'saved-id');
});

/* ---------- critical 3: claim-only takeover ---------- */

test('takeover critical 3: claim-only — payload перехватчика НЕ уходит, журнал сброшен до server_rev', async () => {
  const calls = [];
  let generation = 1;
  const fetchFn = async (u, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, status: 200,
             json: async () => ({ ok: true, writer_generation: 4, epoch: 2, server_rev: 11 }) };
  };
  const j = createJournal({ storage: memStorage() });
  j.initRev(20);
  j.append('trap_add', { img: 'x' });    // неподтверждённый хвост перехватчика (rev 21)
  const s = createSeatSave({ seat: '3', runId: 'r1', lessonId: 'z1', instanceId: 'B',
    getGeneration: () => generation, setGeneration: g => { generation = g; },
    getEpoch: () => 0,
    getState: () => 's2', getPayload: () => ({ big: 'buffer' }), journal: j, fetchFn });
  const resp = await s.takeover();
  assert.equal(resp.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].takeover, true);
  assert.equal(calls[0].payload, undefined, 'буфер перехватчика не становится серверной базой');
  assert.equal(calls[0].state, undefined);
  assert.equal(calls[0].rev, undefined);
  assert.equal(generation, 4, 'generation сервера принят');
  assert.equal(j.entries().length, 0, 'локальный хвост сброшен');
  assert.equal(j.maxRev(), 11, 'счётчик начат от server_rev');
});

test('/save несёт epoch и suspended (critical 2 + п.7)', async () => {
  const calls = [];
  const fetchFn = async (u, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, accepted_rev: 1, writer_generation: 1 }) };
  };
  const j = createJournal({ storage: memStorage() });
  j.append('trap_add', { img: 'x' });
  const s = createSeatSave({ seat: '3', runId: 'r1', lessonId: 'z1', instanceId: 'A',
    getGeneration: () => 1, setGeneration: () => {}, getEpoch: () => 3,
    getState: () => 'r2', getPayload: () => ({}),
    getSuspended: () => ({ step: 's2', phase: 'baskets' }), journal: j, fetchFn });
  await s.flushNow();
  assert.equal(calls[0].epoch, 3, 'снапшот несёт epoch — сервер отклонит задержанный сейв после сброса');
  assert.deepEqual(calls[0].suspended, { step: 's2', phase: 'baskets' },
    'позиция основной машины при уходе в резерв — в снапшоте');
});

/* ---------- пп.9–10: сериализация поллинга + токен поколения ---------- */

test('poll п.9: один inflight-запрос — второй tick при живом первом не стартует', async () => {
  const pend = [];
  const fetchFn = () => new Promise(res => pend.push(res));
  const updates = [];
  const poll = createPoll({ seat: '1', intervalMs: 1e9, onUpdate: r => updates.push(r), fetchFn });
  poll.start();                          // tick 1 в полёте
  poll.tickNow();                        // до фикса тут стартовал второй запрос
  poll.tickNow();
  assert.equal(pend.length, 1, 'в полёте ровно один запрос');
  pend[0]({ ok: true, json: async () => ({ next_cursor: 5 }) });
  await new Promise(r => setImmediate(r));
  assert.equal(updates.length, 1);
  assert.equal(poll.cursor, 5);
  poll.stop();
});

test('poll п.10: ответ, прилетевший после stop(), отброшен токеном поколения', async () => {
  const pend = [];
  const fetchFn = () => new Promise(res => pend.push(res));
  const updates = [];
  const poll = createPoll({ seat: '1', intervalMs: 1e9, onUpdate: r => updates.push(r), fetchFn });
  poll.start();
  assert.equal(pend.length, 1);
  poll.stop();                           // other_tab / takeover: поллинг остановлен
  pend[0]({ ok: true, json: async () => ({ next_cursor: 9, chat_delta: [{ seq: 9 }] }) });
  await new Promise(r => setImmediate(r));
  assert.equal(updates.length, 0, 'устаревшее представление не применилось после stop');
  assert.equal(poll.cursor, 0);
});

/* ---------- п.8/п.18/п.5: машина ---------- */

test('машина п.8: restoreTo вне текущего шага — ошибка (межшаговый переход только acked)', () => {
  const norm = normalizeLesson(Z1);
  const m = createMachine(norm);
  m.jumpTo('s2');
  m.restoreTo('s2.train');               // внутри шага — законно
  assert.equal(m.position().phase, 'train');
  m.jumpTo('s6');
  assert.throws(() => m.restoreTo('s2.train'), /вне текущего шага/);
});

test('машина п.18: jumpTo с неизвестной фазой — ошибка, не молчаливая фаза 0', () => {
  const m = createMachine(normalizeLesson(Z1));
  assert.throws(() => m.jumpTo('s2', 'нет_такой_фазы'), /нет такта/);
  m.jumpTo('s2');                        // без фазы — старт шага, как раньше
  assert.equal(m.position().phaseIndex, 0);
});

test('машина п.5: restoreDone — F5 после финала не перепоказывает последний шаг', () => {
  const m = createMachine(normalizeLesson(Z1));
  m.restoreDone();
  assert.equal(m.done, true);
  assert.deepEqual(m.position(), { done: true });
});

/* ---------- п.16: эксперимент чистит производные mistakes ---------- */

test('редьюсер п.16: experiment_start убирает mistakes сброшенных проб', () => {
  const p = initialPayload();
  reduce(p, { type: 'probe_result', args: { img: 'p1', label: 'cat', conf: 80, margin: 0.04 } });
  reduce(p, { type: 'probe_judgement', args: { img: 'p1', saw_mistake: true, correct: true } });
  reduce(p, { type: 'mistake_mark', args: { img: 'p2' } });   // легаси-отметка БЕЗ записи пробы
  reduce(p, { type: 'probe_result', args: { img: 'p2', label: 'dog', conf: 70, margin: 0.02 } });
  assert.deepEqual(p.mistakes, ['p1', 'p2']);
  reduce(p, { type: 'experiment_start', args: { step: 's2' } });
  assert.deepEqual(p.probes, {});
  assert.deepEqual(p.probe_judgements, {});
  assert.deepEqual(p.mistakes, [], 'ошибки принадлежали сброшенным вердиктам — ушли вместе с ними');
});

/* ---------- п.11/п.17: walk — одна семантика, резерв посреди шага ---------- */

test('walk п.11: две семантики на такте — ошибка walk (общий классификатор с рендером)', () => {
  const norm = normalizeLesson(Z1);
  const probe = norm.steps.find(s => s.type === 'trainer_act').phases.find(p => p.probe_set);
  assert.deepEqual(phaseSemantics(probe), ['probe']);
  const mutated = JSON.parse(JSON.stringify(norm));
  mutated.stepById = norm.stepById;      // Map не переживает JSON — walk им не пользуется
  const mp = mutated.steps.find(s => s.type === 'trainer_act').phases.find(p => p.probe_set);
  mp.elements = [...mp.elements, 'btn_train'];
  const res = walkLesson(mutated, indexBank(Z1BANK));
  assert.ok(res.errors.some(e => e.includes('экранных семантик')), res.errors.join('; '));
});

test('walk п.17: резерв входит ПОСРЕДИ шага и возвращается acked-восстановлением', () => {
  const res = walkLesson(normalizeLesson(Z1), indexBank(Z1BANK), { includeReserve: true });
  assert.deepEqual(res.errors, []);
  for (const rid of ['r1', 'r2'])
    assert.ok(res.visited.includes(rid), 'резерв ' + rid + ' пройден');
  // резервы НЕ дописаны в конец: после них walk вернулся и дошёл до последнего шага
  const lastMain = normalizeLesson(Z1).steps.at(-1).id;
  assert.equal(res.visited.at(-1), lastMain,
    'последним посещён финальный основной шаг (до фикса резервы были хвостом)');
  const iR = res.visited.indexOf('r1');
  assert.ok(iR > 0 && iR < res.visited.length - 1, 'резерв посещён посреди маршрута');
  // возврат — через acked step_enter приостановленного шага (как exitReserve клиента)
  const resume = res.acked.find(a => a.ack === 'step_enter' && a.resume);
  assert.ok(resume, 'возврат из резерва без acked-восстановления недопустим');
  assert.equal(resume.step, res.visited[iR - 1], 'возврат в тот шаг, посреди которого ушли');
});
