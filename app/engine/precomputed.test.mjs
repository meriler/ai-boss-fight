/* Готовые фичи банка (features.bin/.json от tools/precompute-features.mjs) — не просто
 * «файл читается», а: урок на них даёт ТЕ ЖЕ исходы, что задуманы. Смысл теста — поймать
 * момент, когда кто-то перегенерил банк и забыл пересчитать фичи, или пересчитал их другим
 * путём и тихо сдвинул калибровку (тогда кульминация урока — перелом после ловушек —
 * рассыпется молча, а увидим мы это только на живых детях).
 *
 * Гоняем НАСТОЯЩИЙ путь рантайма: fetch подменён на чтение с диска, дальше работает тот же
 * loadPrecomputed, что в браузере, — вместе со всеми его сверками банка. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createHash } from 'node:crypto';
import { indexBank } from '../core/manifest.js';
import { createEngine } from './index.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const LESSON = path.join(HERE, '../../content/z1-kot');
const BANK = JSON.parse(fs.readFileSync(path.join(LESSON, 'bank.json'), 'utf-8'));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(LESSON, 'lesson.json'), 'utf-8'));
const META = JSON.parse(fs.readFileSync(path.join(LESSON, 'features.json'), 'utf-8'));
const BIN = fs.readFileSync(path.join(LESSON, META.bin));

const ids = BANK.images.map(i => i.id);
const byId = new Map(BANK.images.map(i => [i.id, i]));
const roleIds = role => BANK.images.filter(i => i.role === role).map(i => i.id);
const probeSet = (() => {
  for (const step of MANIFEST.lesson.steps || [])
    for (const ph of step.phases || [])
      if (Array.isArray(ph.probe_set) && ph.probe_set.length) return ph.probe_set;
  throw new Error('в манифесте нет probe_set');
})();

/** fetch → файлы урока. Возвращает restore(). */
function mockFetch(overrides = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const name = String(u).split('/').pop();
    if (name in overrides) {
      const v = overrides[name];
      if (v === null) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => v, arrayBuffer: async () => v };
    }
    const file = path.join(LESSON, name);
    if (!fs.existsSync(file)) return { ok: false, status: 404 };
    const b = fs.readFileSync(file);
    return { ok: true, status: 200,
             json: async () => JSON.parse(b.toString('utf-8')),
             arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  };
  return () => { globalThis.fetch = real; };
}

function engineOn(engineId) {
  return createEngine({ bankIndex: indexBank(BANK), engine: engineId, demo: false,
                        assetsBase: 'assets/', featuresBase: '' });
}

test('метаданные фич описывают именно этот банк', () => {
  assert.equal(META.format, 'f32-emb-pix-v1');
  assert.equal(META.bank, BANK.id);
  assert.equal(META.params_rev, BANK.frozen_params.params_rev,
    'фичи считались на другой ревизии параметров банка — пересчитай: node tools/precompute-features.mjs');
  assert.equal(META.count, ids.length);
  assert.deepEqual(META.order, ids, 'порядок картинок в фичах разошёлся с банком');
  assert.equal(BIN.length, ids.length * (META.dim_emb + META.dim_pix) * 4);
  assert.equal(META.dim_emb, 1024);
  assert.equal(META.dim_pix, 1024);
  assert.match(META.bin, /^features-[0-9a-f]{12}\.bin$/, 'имя файла фич без хэша — кеш склеит выпуски');
  assert.equal(createHash('sha256').update(BIN).digest('hex'), META.bin_sha256,
    'хэш файла фич не сходится с метаданными');
});

test('sha картинок сходятся — фичи посчитаны по ТЕКУЩИМ файлам', () => {
  const bad = BANK.images.filter(img => {
    const sha = createHash('sha256')
      .update(fs.readFileSync(path.join(LESSON, 'assets', img.src))).digest('hex').slice(0, 16);
    return META.images[img.id]?.sha !== sha;
  }).map(i => i.id);
  assert.deepEqual(bad, [], 'картинки менялись после подсчёта фич: ' + bad.join(', ')
    + ' — пересчитай: node tools/precompute-features.mjs');
});

test('прогрев берёт готовые фичи и не трогает MediaPipe', async () => {
  const restore = mockFetch();
  try {
    const eng = engineOn('head');
    const seen = [];
    await eng.warmup(p => seen.push(p));
    assert.ok(eng.ready, 'движок не готов после прогрева');
    assert.equal(eng.featureSource, 'precomputed');
    assert.ok(seen.length >= 2 && seen[seen.length - 1] === 1, 'прогресс не доехал до 100%');
  } finally { restore(); }
});

test('чужие фичи не принимаются молча (иначе тихо поедет калибровка)', async () => {
  const restore = mockFetch({ 'features.json': { ...META, params_rev: (META.params_rev ?? 0) + 1 } });
  try {
    const eng = engineOn('head');
    await assert.rejects(() => eng.warmup(() => {}));   // MediaPipe в Node недоступен → падение
    assert.match(String(eng.error && eng.error.message), /params_rev/,
      'причина отказа от готовых фич потерялась — сбой будет нечитаем');
  } finally { restore(); }
});

/* --- негативные: файл нужной длины, но содержимое испорчено. Раньше такие проходили
 *     как валидные, и движок молча учился на мусоре (находка Codex-ревью 28.07) --- */

const corrupt = (fill) => {
  const b = Buffer.alloc(BIN.length, fill);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

test('битый файл фич той же длины отвергается (внутри NaN)', async () => {
  const restore = mockFetch({ [META.bin]: corrupt(0xff) });
  try {
    const eng = engineOn('head');
    await assert.rejects(() => eng.warmup(() => {}));
    assert.match(String(eng.error && eng.error.message), /хэш|не-число/,
      'подменённый файл прошёл как валидный');
  } finally { restore(); }
});

test('подменённые размеры веток отвергаются (0/2048 сходится по длине)', async () => {
  const restore = mockFetch({ 'features.json': { ...META, dim_emb: 0, dim_pix: 2048 } });
  try {
    const eng = engineOn('head');
    await assert.rejects(() => eng.warmup(() => {}));
    assert.match(String(eng.error && eng.error.message), /размеры/);
  } finally { restore(); }
});

test('HTML вместо метаданных не ломает загрузку молча', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200,
    json: async () => { throw new SyntaxError('Unexpected token <'); },
    arrayBuffer: async () => new ArrayBuffer(0) });
  try {
    const eng = engineOn('head');
    await assert.rejects(() => eng.warmup(() => {}));
    assert.ok(eng.error, 'ошибка не сохранилась');
  } finally { globalThis.fetch = real; }
});

test('нет метаданных → честный отказ, а не тихая готовность', async () => {
  const restore = mockFetch({ 'features.json': null });
  try {
    const eng = engineOn('head');
    await assert.rejects(() => eng.warmup(() => {}));
    assert.ok(!eng.ready, 'движок объявил себя готовым без фич');
  } finally { restore(); }
});

test('после неудачи повтор с исправным файлом чинит и не тащит старую причину', async () => {
  const eng = engineOn('head');
  let restore = mockFetch({ [META.bin]: corrupt(0x00) });
  try { await assert.rejects(() => eng.warmup(() => {})); } finally { restore(); }
  assert.ok(!eng.ready);

  restore = mockFetch();
  try {
    await eng.warmup(() => {});
    assert.ok(eng.ready, 'повтор не поднял движок на исправном файле');
    assert.equal(eng.featureSource, 'precomputed');
    assert.equal(eng.precomputedError, null, 'осталась причина от прошлой неудачи');
  } finally { restore(); }
});

for (const engineId of ['head', 'knn']) {
  test(`урок на готовых фичах: перелом после ловушек (${engineId})`, async () => {
    const restore = mockFetch();
    try {
      const eng = engineOn(engineId);
      await eng.warmup(() => {});

      const train = roleIds('train_core').map(id => ({ img: id, class: byId.get(id).class }));
      eng.train(train);
      const before = eng.measure(probeSet);

      const traps = roleIds('trap').map(id => ({ img: id, class: byId.get(id).class }));
      eng.train(train.concat(traps));
      const after = eng.measure(probeSet);

      const tricky = m => m.details.filter(d => byId.get(d.img)?.expected_flip === true);
      const trickyOk = m => tricky(m).filter(d => d.ok).length;

      assert.equal(before.of, probeSet.length);
      assert.ok(after.score > before.score,
        `общий счёт не вырос: ${before.score} → ${after.score} (${engineId}) — кульминация урока мертва`);
      assert.ok(trickyOk(after) > trickyOk(before),
        `на хитрых не вырос: ${trickyOk(before)} → ${trickyOk(after)} из ${tricky(after).length} (${engineId})`);
      assert.ok(after.score >= 8,
        `после ловушек ${after.score}/${after.of} — ниже порога прохождения 8/10 (${engineId})`);
      console.log(`  ${engineId}: общий ${before.score}→${after.score} из ${after.of}, `
        + `хитрые ${trickyOk(before)}→${trickyOk(after)} из ${tricky(after).length}`);
    } finally { restore(); }
  });
}
