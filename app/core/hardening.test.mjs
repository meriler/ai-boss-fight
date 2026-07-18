/* Тесты закалки клиента (финальный аудит 18.07, отчёты merged/screens): миграция
 * legacy-журналов и acked-опов без identity, Web Locks fail-safe, takeover не стирает
 * чужой offline-хвост. Каждый тест до фикса был красным. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createJournal } from './journal.js';
import { createAcked } from './acked.js';
import { claimInstanceId } from './save.js';

const memStorage = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null),
           setItem: (k, v) => m.set(k, String(v)),
           removeItem: k => m.delete(k) };
};

/* ---------- critical (merged 2): rolling deploy — legacy-журнал без inst/gen ---------- */

test('журнал critical: legacy-записи без владельца УСЫНОВЛЯЮТСЯ, прогресс не теряется', () => {
  const storage = memStorage();
  // журнал старого JS (до фикса «владелец записей»): counter+entries без inst/gen
  storage.setItem('z1_journal', JSON.stringify({ counter: 3, entries: [
    { type: 'basket_assign', args: { img: 'i1', basket: 'cat' }, rev: 2, ts: 1 },
    { type: 'trap_add', args: { img: 'i2' }, rev: 3, ts: 2 },
  ] }));
  const j = createJournal({ storage, owner: { inst: 'NEW', gen: 1 } }).load();
  assert.equal(j.entries().length, 2, 'накопленный хвост старого формата не отброшен');
  assert.ok(j.entries().every(e => e.inst === 'NEW' && e.gen === 1),
    'усыновление: legacy-записи проштампованы текущим владельцем');
  // после усыновления второй load ТОГО ЖЕ владельца видит хвост (проштамповка сохранена)
  const j2 = createJournal({ storage, owner: { inst: 'NEW', gen: 1 } }).load();
  assert.equal(j2.entries().length, 2);
  // а ЧУЖОЙ владелец (takeover) по-прежнему не реплеит его
  const j3 = createJournal({ storage, owner: { inst: 'OTHER', gen: 2 } }).load();
  assert.equal(j3.entries().length, 0, 'усыновление не размывает изоляцию поколений');
  assert.equal(j3.maxRev(), 3, 'rev усыновлённых записей двигает счётчик');
});

/* ---------- high (merged 3): legacy acked-оп без identity не берёт свежие права ---------- */

test('acked high: legacy-оп мигрирует к правам НА МОМЕНТ загрузки, ретрай не подбирает свежий epoch', async () => {
  const storage = memStorage();
  // очередь старого JS: op без instance/generation/epoch
  storage.setItem('z1_acked_pending', JSON.stringify([
    { op_id: 'op-legacy', type: 'version', step: 's2', data: {} },
  ]));
  let epoch = 0, gen = 1;
  const bodies = [];
  let epochBumped;
  const bumped = new Promise(r => { epochBumped = r; });
  const fetchFn = async (u, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) {
      // /host/reset_version ПОКА оп в ретрае: свежие права не должны достаться старому
      // опу — иначе он обошёл бы stale_epoch и воскресил отменённый коммит
      epoch = 5; gen = 4;
      epochBumped();
      throw new Error('сеть упала');
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const a = createAcked({ seat: '1', runId: 'r1', instanceId: 'NEW',
                          getGeneration: () => gen, getEpoch: () => epoch,
                          storage, retryMs: [1], fetchFn });
  const pr = a.resendPending();
  await bumped;
  await pr;
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].epoch, 0, 'ретрай несёт epoch момента миграции, не свежий');
  assert.equal(bodies[1].writer_generation, 1, 'ретрай несёт generation момента миграции');
  // миграция персистится: в storage оп лежит уже с identity
  const stored = JSON.parse(storage.getItem('z1_acked_pending'));
  assert.equal(stored.length, 0, 'подтверждённый оп ушёл из очереди');
});

test('acked high: мигрированный legacy-оп переживает второй F5 с ТЕМИ ЖЕ правами', async () => {
  const storage = memStorage();
  storage.setItem('z1_acked_pending', JSON.stringify([
    { op_id: 'op-legacy', type: 'version', step: 's2', data: {} },
  ]));
  // первый заход: сеть лежит совсем — оп остаётся в очереди, но уже мигрированный.
  // Первая попытка падает, дальше запрос висит вечно (без таймеров — event loop свободен)
  let firstTried;
  const tried = new Promise(r => { firstTried = r; });
  let calls1 = 0;
  const a1 = createAcked({ seat: '1', runId: 'r1', instanceId: 'INST1',
                           getGeneration: () => 2, getEpoch: () => 3,
                           storage, retryMs: [1], fetchFn: () => {
                             calls1 += 1;
                             if (calls1 === 1) { firstTried(); return Promise.reject(new Error('offline')); }
                             return new Promise(() => {});   // «вечный» офлайн без таймеров
                           } });
  a1.resendPending();
  await tried;
  await new Promise(r => setImmediate(r));
  const stored = JSON.parse(storage.getItem('z1_acked_pending'));
  assert.equal(stored[0].epoch, 3, 'identity заморожена в storage при первом заходе');
  assert.equal(stored[0].generation, 2);
  assert.equal(stored[0].instance, 'INST1');
  // второй заход (уже с другими текущими правами) шлёт замороженные
  const bodies = [];
  const a2 = createAcked({ seat: '1', runId: 'r1', instanceId: 'INST2',
                           getGeneration: () => 9, getEpoch: () => 9,
                           storage, retryMs: [1], fetchFn: async (u, opts) => {
                             bodies.push(JSON.parse(opts.body));
                             return { ok: true, status: 200, json: async () => ({ ok: true }) };
                           } });
  await a2.resendPending();
  assert.equal(bodies[0].epoch, 3, 'второй F5: оп сохранил права первой миграции');
  assert.equal(bodies[0].writer_generation, 2);
  assert.equal(bodies[0].client_instance_id, 'INST1');
});

/* ---------- critical (merged 6): Web Locks fail-open → fail-safe ---------- */

test('Web Locks critical: сбой API — НЕ считаем лок захваченным (дубли получают разные id)', async () => {
  const store = memStorage();
  store.setItem('k', JSON.stringify({ id: 'shared-id' }));
  const brokenLocks = { request: () => Promise.reject(new Error('SecurityError')) };
  const id = await claimInstanceId({ storage: store, key: 'k', locks: brokenLocks,
                                     retry: { attempts: 1, delayMs: 1 } });
  assert.notEqual(id, 'shared-id',
    'fail-safe: при сломанном Lock API сохранённый id не переиспользуется — дубль вкладки не станет тем же писателем');
  assert.ok(id, 'новый id выдан');
});

test('Web Locks: request бросает синхронно — тоже fail-safe, boot не падает', async () => {
  const store = memStorage();
  store.setItem('k', JSON.stringify({ id: 'shared-id' }));
  const throwingLocks = { request: () => { throw new Error('boom'); } };
  const id = await claimInstanceId({ storage: store, key: 'k', locks: throwingLocks,
                                     retry: { attempts: 1, delayMs: 1 } });
  assert.ok(id && id !== 'shared-id');
});

/* ---------- high (merged 5): takeover не уничтожает чужой offline-хвост ---------- */

test('takeover high: journal.reset нового владельца не стирает записи старого из storage', () => {
  const storage = memStorage();
  const jOld = createJournal({ storage, owner: { inst: 'OLD', gen: 1 } });
  jOld.append('trap_add', { img: 'x' });          // честный несинхронизированный хвост
  jOld.append('basket_assign', { img: 'y', basket: 'cat' });
  // новая вкладка перехватывает: её журнал сбрасывается, но ЧУЖОЙ хвост в общем
  // localStorage — не её собственность и физически не уничтожается
  const jNew = createJournal({ storage, owner: { inst: 'NEW', gen: 2 } }).load();
  jNew.reset(10);
  const disk = JSON.parse(storage.getItem('z1_journal'));
  const oldLeft = (disk.entries || []).filter(e => e.inst === 'OLD');
  assert.equal(oldLeft.length, 2, 'offline-хвост старого писателя жив в storage после takeover-reset');
  assert.equal(jNew.entries().length, 0, 'свой буфер нового писателя пуст');
  assert.equal(jNew.maxRev(), 10, 'счётчик начат от server_rev');
  // и наоборот: свои записи reset честно убирает
  jNew.append('trap_add', { img: 'z' });
  jNew.reset(20);
  const disk2 = JSON.parse(storage.getItem('z1_journal'));
  assert.ok(!(disk2.entries || []).some(e => e.inst === 'NEW'), 'свои записи сброшены');
  assert.equal((disk2.entries || []).filter(e => e.inst === 'OLD').length, 2);
});
