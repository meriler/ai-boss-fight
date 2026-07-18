/* Тесты закалки движков (финальный аудит 18.07, отчёт screens): guard публикации
 * обучения (trainAsync не пишет модель в чужое состояние) и закрытый реестр
 * allowedEngines (опечатка в frozen_params не валит boot). До фикса — красные. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { indexBank } from '../core/manifest.js';
import { createEngine, allowedEngines } from './index.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const read = p => JSON.parse(fs.readFileSync(path.join(HERE, '../../content', p), 'utf-8'));
const BANK = read('z1-kot/bank.json');

const listOf = (bi, roles) => {
  const list = [];
  for (const r of roles) for (const img of bi.byRole.get(r) || []) list.push({ img: img.id, class: img.class });
  return list;
};

/* ---------- critical (screens 2): публикация обучения только через guard ---------- */

test('trainAsync critical: shouldPublish=false — модель и состав НЕ публикуются (head)', async () => {
  const bi = indexBank(BANK);
  const eng = createEngine({ bankIndex: bi, demo: true, engine: 'head' });
  const v1 = listOf(bi, ['train_core']);
  eng.train(v1);
  const before = eng.modelInfo();
  const verdictBefore = eng.classify(v1[0].img);
  // обучение стартовало, но за время счёта эпох ребёнок ушёл (reset/резерв/смена такта):
  // guard места запуска запрещает публикацию — движок обязан остаться прежней версией
  const v2 = listOf(bi, ['train_core', 'trap']);
  const n = await eng.trainAsync(v2, null, { shouldPublish: () => false });
  assert.equal(n, null, 'отменённое обучение не отчитывается числом примеров');
  const after = eng.modelInfo();
  assert.equal(after.sig, before.sig, 'sig состава не изменился');
  assert.equal(after.n, before.n, 'счётчик примеров не изменился');
  const verdictAfter = eng.classify(v1[0].img);
  assert.equal(verdictAfter.label, verdictBefore.label, 'classify отвечает прежней моделью');
  assert.equal(verdictAfter.conf, verdictBefore.conf);
  // а с разрешённой публикацией тот же вызов честно обучает
  const n2 = await eng.trainAsync(v2, null, { shouldPublish: () => true });
  assert.equal(n2, v2.length);
  assert.notEqual(eng.modelInfo().sig, before.sig);
});

test('trainAsync critical: shouldPublish=false — kNN-путь тоже не мутирует состав', async () => {
  const bi = indexBank(BANK);
  const eng = createEngine({ bankIndex: bi, demo: true, engine: 'knn' });
  const v1 = listOf(bi, ['train_core']);
  eng.train(v1);
  const before = eng.modelInfo();
  const n = await eng.trainAsync(listOf(bi, ['train_core', 'trap']), null,
                                 { shouldPublish: () => false });
  assert.equal(n, null);
  assert.equal(eng.modelInfo().sig, before.sig);
  assert.equal(eng.exampleCount(), v1.length);
});

/* ---------- major (screens 15): реестр отклоняет неизвестные ключи банка ---------- */

test('allowedEngines major: неизвестный ключ frozen_params.engines не пускается в fallback-цепочку', () => {
  const bankTypo = JSON.parse(JSON.stringify(BANK));
  bankTypo.frozen_params = bankTypo.frozen_params || {};
  bankTypo.frozen_params.engines = { ...(bankTypo.frozen_params.engines || {}), heade: { epochs: 1 } };
  const allowed = allowedEngines(bankTypo);
  assert.ok(!allowed.includes('heade'),
    'опечатка в банке не должна дойти до createEngine и уронить boot вместо отката на kNN');
  assert.ok(allowed.includes('knn'), 'kNN — всегда в реестре');
  // штатные ключи по-прежнему проходят
  const allowedOk = allowedEngines(BANK);
  for (const e of allowedOk) assert.ok(['knn', 'head'].includes(e));
});
