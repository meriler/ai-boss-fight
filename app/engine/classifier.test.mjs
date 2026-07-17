/* Тесты demo-режима классификатора (фикс-фичи из метаданных банка): драматургия З1
 * должна воспроизводиться на ЛЮБОМ банке по его bg/class — коробка «выучивает фон»,
 * флипает конфликтные картинки УВЕРЕННО (порог живой уверенности ≥75, §6 п.3),
 * ловушки чинят замер на отложенном наборе. Гоняется в CI (ci.sh: node --test). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { indexBank } from '../core/manifest.js';
import { createClassifier } from './classifier.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const read = p => JSON.parse(fs.readFileSync(path.join(HERE, '../../content', p), 'utf-8'));

function trainedOn(bank, roles) {
  const bi = indexBank(bank);
  const cls = createClassifier({ bankIndex: bi, demo: true });
  const list = [];
  for (const r of roles) for (const img of bi.byRole.get(r) || []) list.push({ img: img.id, class: img.class });
  cls.train(list);
  return { bi, cls };
}

for (const dir of ['z1-kot', '_test-variant']) {
  const bank = read(dir + '/bank.json');

  test(`${dir}: train_core → конфликтные probe флипают уверенно, обычные верны`, () => {
    const { bi, cls } = trainedOn(bank, ['train_core']);
    for (const p of bi.byRole.get('probe')) {
      const v = cls.classify(p.id);
      if (p.expected_flip) {
        assert.notEqual(v.label, p.class, `${p.id}: ждали флип`);
        assert.ok(v.conf >= 75, `${p.id}: уверенность флипа ${v.conf} < 75 (методический бит §6)`);
      } else {
        assert.equal(v.label, p.class, `${p.id}: обычная картинка должна быть верной`);
      }
    }
  });

  test(`${dir}: замер R1 (до ловушек) на holdout проваливается, R2 (после) проходит`, () => {
    const { bi, cls } = trainedOn(bank, ['train_core']);
    const holdout = (bi.byRole.get('holdout') || []).map(i => i.id);
    const r1 = cls.measure(holdout);
    assert.ok(r1.score < holdout.length, `R1 ${r1.score}/${r1.of} — подвох не сработал`);
    const { cls: cls2 } = trainedOn(bank, ['train_core', 'trap']);
    const r2 = cls2.measure(holdout);
    assert.ok(r2.score >= holdout.length - 1, `R2 ${r2.score}/${r2.of} — ловушки не починили`);
    assert.ok(r2.score > r1.score, 'R2 должен быть лучше R1');
  });

  test(`${dir}: forecast-картинка после починки — верный класс (expected predict)`, () => {
    const { bi, cls } = trainedOn(bank, ['train_core', 'trap']);
    for (const f of bi.byRole.get('forecast') || []) {
      const v = cls.classify(f.id);
      assert.equal(v.label, f.class, `${f.id}: после починки прогноз должен совпасть`);
    }
  });

  test(`${dir}: детерминизм — два прогона дают одинаковые вердикты`, () => {
    const a = trainedOn(bank, ['train_core']);
    const b = trainedOn(bank, ['train_core']);
    for (const p of a.bi.byRole.get('probe')) {
      const va = a.cls.classify(p.id), vb = b.cls.classify(p.id);
      assert.deepEqual({ l: va.label, c: va.conf }, { l: vb.label, c: vb.conf });
    }
  });
}
