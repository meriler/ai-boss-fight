/* Conformance-suite EngineAdapter (ТЗ-платформа-v3 §2.2) против КАЖДОГО движка реестра:
 * train-детерминизм, независимость от порядка укладки (канонизация состава), spectrum
 * суммируется в 1, measure согласован с classify, demo-режим обязателен, драматургия
 * занятия (флипы conflict → починка ловушками) воспроизводится на обоих движках.
 * Плюс юниты головы на игрушечных фичах (пилот H1 шаг 1: детерминизм бит-в-бит). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { indexBank } from '../core/manifest.js';
import { createEngine, allowedEngines, ENGINE_IDS } from './index.js';
import { trainHead, createHeadTrainer, headClassify, weightsSig, DEF_HEAD } from './head.js';
import { knnClassify } from './knn.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const read = p => JSON.parse(fs.readFileSync(path.join(HERE, '../../content', p), 'utf-8'));
const BANK = read('z1-kot/bank.json');

function engineOn(bank, engine, roles) {
  const bi = indexBank(bank);
  const eng = createEngine({ bankIndex: bi, demo: true, engine });
  const list = [];
  for (const r of roles) for (const img of bi.byRole.get(r) || []) list.push({ img: img.id, class: img.class });
  eng.train(list);
  return { bi, eng, list };
}

/* ---------- юниты головы: игрушечные фичи ---------- */

const toy = (ax, ay) => ({ emb: Float32Array.from([ax, ay]), pix: Float32Array.from([ax, ay]) });
const TOY = [
  { img: 'a1', class: 'A', f: toy(1, 0.1) },
  { img: 'a2', class: 'A', f: toy(0.9, -0.1) },
  { img: 'a3', class: 'A', f: toy(1.1, 0) },
  { img: 'b1', class: 'B', f: toy(-1, 0.1) },
  { img: 'b2', class: 'B', f: toy(-0.9, 0) },
  { img: 'b3', class: 'B', f: toy(-1.1, -0.1) },
];

test('head: игрушечные фичи — разделимые классы выучиваются, метки верны', () => {
  const m = trainHead(TOY, ['A', 'B']);
  for (const ex of TOY) {
    const v = headClassify(ex.f, m);
    assert.equal(v.label, ex.class, ex.img + ': метка неверна');
    assert.ok(v.margin > 0, ex.img + ': маржа должна быть положительной');
  }
});

test('head: детерминизм — два train бит-в-бит одни веса (weightsSig)', () => {
  const m1 = trainHead(TOY, ['A', 'B']);
  const m2 = trainHead(TOY, ['A', 'B']);
  assert.equal(weightsSig(m1), weightsSig(m2));
  for (let c = 0; c < 2; c++)
    assert.deepEqual([...m1.W[c]], [...m2.W[c]], 'веса класса ' + c + ' разошлись');
});

test('Codex-И3 п.3: createHeadTrainer порциями = trainHead монолитно (бит-в-бит)', () => {
  // честная полоска эпох режет обучение на порции — веса обязаны совпасть с монолитом
  const m1 = trainHead(TOY, ['A', 'B']);
  const tr = createHeadTrainer(TOY, ['A', 'B']);
  while (!tr.done) tr.step(7);   // рваные порции (7 не делит 1000 нацело — проверяем хвост)
  assert.equal(weightsSig(tr.model()), weightsSig(m1));
  assert.equal(tr.epoch, tr.total, 'счётчик эпох дошёл ровно до total');
});

test('Codex-И3 п.3: trainAsync — та же модель, что train(), прогресс реальный и монотонный', async () => {
  const bi = indexBank(BANK);
  const list = [];
  for (const r of ['train_core', 'trap'])
    for (const img of bi.byRole.get(r) || []) list.push({ img: img.id, class: img.class });
  const sync = createEngine({ bankIndex: bi, demo: true, engine: 'head' });
  sync.train(list);
  const async_ = createEngine({ bankIndex: bi, demo: true, engine: 'head' });
  const seen = [];
  const n = await async_.trainAsync(list, (ep, total) => seen.push([ep, total]));
  assert.equal(n, list.length);
  assert.ok(seen.length >= 1, 'onProgress звался');
  assert.ok(seen.every(([ep, total]) => total === DEF_HEAD.epochs && ep <= total),
    'прогресс — фактические эпохи, не проценты времени');
  for (let i = 1; i < seen.length; i++)
    assert.ok(seen[i][0] >= seen[i - 1][0], 'счётчик эпох монотонный');
  assert.equal(seen[seen.length - 1][0], DEF_HEAD.epochs, 'дошёл до последней эпохи');
  // вердикты бит-в-бит: сырые маржи равны как числа на всех картинках банка
  for (const img of bi.bank.images) {
    const a = sync.classify(img.id), b = async_.classify(img.id);
    assert.equal(a.label, b.label, img.id + ': метки разошлись');
    assert.equal(a.margin, b.margin, img.id + ': маржа не бит-в-бит');
  }
  // kNN: trainAsync — эквивалент train(), мгновенен
  const knnE = createEngine({ bankIndex: bi, demo: true, engine: 'knn' });
  assert.equal(await knnE.trainAsync(list), list.length);
  assert.equal(knnE.exampleCount(), list.length);
});

test('head: канонизация — перемешанный порядок укладки даёт бит-в-бит ту же модель', () => {
  const shuffled = [TOY[4], TOY[1], TOY[5], TOY[0], TOY[3], TOY[2]];
  assert.equal(weightsSig(trainHead(TOY, ['A', 'B'])),
               weightsSig(trainHead(shuffled, ['A', 'B'])),
    'модель обязана быть функцией МНОЖЕСТВА примеров, не порядка (§2.1)');
});

test('head: class_balance — дисбаланс 5/1 не задавливает малый класс', () => {
  const imb = [
    { img: 'a1', class: 'A', f: toy(1, 0.3) },
    { img: 'a2', class: 'A', f: toy(0.9, 0.2) },
    { img: 'a3', class: 'A', f: toy(1.1, 0.25) },
    { img: 'a4', class: 'A', f: toy(1, 0.15) },
    { img: 'a5', class: 'A', f: toy(0.95, 0.2) },
    { img: 'b1', class: 'B', f: toy(-1, -0.2) },
  ];
  const m = trainHead(imb, ['A', 'B']);
  const v = headClassify(toy(-0.95, -0.15), m);
  assert.equal(v.label, 'B', 'близкий к единственному B-примеру вход обязан быть B');
});

test('head: один класс в примерах — честный ответ без обучения (не бросает)', () => {
  const m = trainHead(TOY.slice(0, 3), ['A', 'B']);
  assert.equal(m.W, null);
  const v = headClassify(toy(1, 0), m);
  assert.equal(v.label, 'A');
  assert.equal(v.conf, 50);
});

test('head: T только в спектре — сырая маржа от T не зависит', () => {
  const m1 = trainHead(TOY, ['A', 'B'], { T: 1 });
  const m2 = trainHead(TOY, ['A', 'B'], { T: 4 });
  const v1 = headClassify(TOY[0].f, m1);
  const v2 = headClassify(TOY[0].f, m2);
  assert.equal(v1.margin, v2.margin, 'маржа — сырой скор, T её не трогает');
  assert.ok(v2.spectrum[v2.label] < v1.spectrum[v1.label],
    'больший T обязан размягчать спектр');
});

/* ---------- юнит kNN: tie-break голосования (Codex-ревью 18.07, находка 8) ---------- */

test('knn: ничья голосов — вердикт стабилен при любой пермутации состава примеров', () => {
  // K=4, в top-4 по 2 примера каждого класса (2-2): победителя решает tie-break —
  // класс БЛИЖАЙШЕГО соседа (порядок вставки Map = порядок соседей по близости, зеркало
  // dict пилота). Вердикт целиком (label+margin+conf) обязан не зависеть от того,
  // в каком порядке примеры лежали в составе
  const unit = t => Float32Array.from([Math.cos(t), Math.sin(t)]);
  const feat = t => ({ emb: unit(t), pix: unit(t) });
  const examples = [
    { class: 'cat', f: feat(0.10) },   // ближайший к запросу t=0 → tie-break отдаёт cat
    { class: 'dog', f: feat(0.20) },
    { class: 'cat', f: feat(0.30) },
    { class: 'dog', f: feat(0.40) },
  ];
  const opts = { classIds: ['cat', 'dog'], K: 4, W: { embed: 0.65, pixel: 0.35 }, T: 0.03, scale: null };
  const base = knnClassify(feat(0), examples, opts);
  assert.equal(base.label, 'cat', 'при ничьей 2-2 побеждает класс ближайшего соседа');
  const perms = [
    [1, 0, 3, 2], [3, 2, 1, 0], [2, 3, 0, 1], [0, 2, 1, 3], [3, 0, 2, 1],
  ];
  for (const p of perms) {
    const v = knnClassify(feat(0), p.map(i => examples[i]), opts);
    assert.deepEqual({ l: v.label, m: v.margin, c: v.conf },
                     { l: base.label, m: base.margin, c: base.conf },
      'пермутация [' + p + '] изменила вердикт — tie-break зависит от порядка укладки');
  }
});

/* ---------- conformance: единый контракт против каждого движка ---------- */

test('реестр движков закрыт: knn + head; неизвестный движок — ошибка', () => {
  assert.deepEqual(ENGINE_IDS, ['knn', 'head']);
  assert.throws(() => createEngine({ bankIndex: indexBank(BANK), demo: true, engine: 'tfjs' }));
});

test('allowedEngines: kNN всегда; head — только из frozen_params.engines банка', () => {
  const bare = { ...BANK, frozen_params: { ...BANK.frozen_params } };
  delete bare.frozen_params.engines;
  assert.deepEqual(allowedEngines(bare), ['knn']);
  const withHead = { ...BANK,
    frozen_params: { ...BANK.frozen_params, engines: { head: {} } } };
  assert.deepEqual(allowedEngines(withHead), ['knn', 'head']);
});

for (const engine of ENGINE_IDS) {
  test(`${engine}: train-детерминизм — два адаптера дают один sig и одни вердикты`, () => {
    const a = engineOn(BANK, engine, ['train_core']);
    const b = engineOn(BANK, engine, ['train_core']);
    assert.equal(a.eng.modelInfo().sig, b.eng.modelInfo().sig);
    assert.equal(a.eng.modelInfo().engine, engine);
    // identity модели (§3.1): params_rev — ревизия frozen_params банка
    assert.equal(a.eng.modelInfo().params_rev, BANK.frozen_params.params_rev,
      'modelInfo обязан нести params_rev банка');
    for (const p of a.bi.byRole.get('control')) {
      const va = a.eng.classify(p.id), vb = b.eng.classify(p.id);
      assert.deepEqual({ l: va.label, c: va.conf, m: va.margin },
                       { l: vb.label, c: vb.conf, m: vb.margin });
    }
  });

  test(`${engine}: spectrum — сумма 1, непрерывные доли по классам`, () => {
    const { bi, eng } = engineOn(BANK, engine, ['train_core']);
    for (const p of bi.byRole.get('control')) {
      const v = eng.classify(p.id);
      const vals = Object.values(v.spectrum);
      assert.equal(vals.length, 2, p.id + ': спектр по обоим классам');
      const sum = vals.reduce((x, y) => x + y, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, p.id + ': сумма спектра ' + sum);
      assert.ok(vals.every(x => x > 0 && x < 1), p.id + ': доли строго в (0,1) — «никогда не 100»');
      assert.ok(v.spectrum[v.label] >= Math.max(...vals) - 1e-12,
        p.id + ': метка обязана быть классом максимума спектра');
    }
  });

  test(`${engine}: measure согласован с classify (score = сумма ok)`, () => {
    const { bi, eng } = engineOn(BANK, engine, ['train_core', 'trap']);
    const ids = [...bi.byRole.get('control')].map(i => i.id);
    const r = eng.measure(ids);
    let manual = 0;
    for (const id of ids) {
      const v = eng.classify(id);
      if (v.label === bi.byId.get(id).class) manual += 1;
    }
    assert.equal(r.score, manual);
    assert.equal(r.of, ids.length);
    assert.equal(r.details.length, ids.length);
  });

  test(`${engine}: демо-драматургия — флипы conflict-probe до ловушек, починка после`, () => {
    const { bi, eng } = engineOn(BANK, engine, ['train_core']);
    for (const p of bi.byRole.get('control')) {
      const v = eng.classify(p.id);
      if (p.expected_flip) assert.notEqual(v.label, p.class, `${p.id}: ждали флип (${engine})`);
      else assert.equal(v.label, p.class, `${p.id}: обычная должна быть верной (${engine})`);
    }
    const holdout = [...bi.byRole.get('control')].map(i => i.id);
    const r1 = eng.measure(holdout);
    const { eng: eng2 } = engineOn(BANK, engine, ['train_core', 'trap']);
    const r2 = eng2.measure(holdout);
    assert.ok(r1.score < holdout.length, `R1 ${r1.score}/${r1.of} — подвох не сработал (${engine})`);
    assert.ok(r2.score >= holdout.length - 1, `R2 ${r2.score}/${r2.of} — ловушки не починили (${engine})`);
  });

  test(`${engine}: modelInfo/exampleCount и sig не зависят от порядка укладки`, () => {
    const { eng, list } = engineOn(BANK, engine, ['train_core']);
    const rev = [...list].reverse();
    const eng2 = createEngine({ bankIndex: indexBank(BANK), demo: true, engine });
    eng2.train(rev);
    assert.equal(eng.exampleCount(), eng2.exampleCount());
    assert.equal(eng.modelInfo().sig, eng2.modelInfo().sig);
  });
}

test('head: демо-режим — обучение мгновенно по меркам занятия (train ≤ 500 мс)', () => {
  const bi = indexBank(BANK);
  const eng = createEngine({ bankIndex: bi, demo: true, engine: 'head' });
  const list = [...bi.byRole.get('train_core'), ...bi.byRole.get('trap')]
    .map(i => ({ img: i.id, class: i.class }));
  const t0 = performance.now();
  eng.train(list);
  const ms = performance.now() - t0;
  assert.ok(ms < 500, 'train занял ' + ms.toFixed(0) + ' мс');
});
