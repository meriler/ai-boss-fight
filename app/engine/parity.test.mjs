/* Parity клиентского kNN с ПИЛОТОМ на реальных фичах (план-правок 17.07 п.1).
 * Фикстура pilot/parity-fixture.json (dump_parity.py, venv пилота): реальные фичи
 * пилотных картинок + вердикты python-kNN (голосование top-k, d̄-маржа, T=0.03)
 * на сценариях R1 (train → conflict/normal/strange/holdout) и R2 (train+trap → holdout).
 * Клиентский knnClassify обязан дать ТЕ ЖЕ метки и маржи (float-эпсилон) — иначе
 * клиент разошёлся с порогами пилота (баг интеграции, который чинил этот пакет). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { knnClassify } from './classifier.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, '../../pilot/parity-fixture.json'), 'utf-8'));

const f32 = a => Float32Array.from(a);   // клиент считает на Float32Array — так же и тут
const featureOf = id => ({ emb: f32(FX.features[id].emb), pix: f32(FX.features[id].pix) });

const models = {};
for (const [name, ids] of Object.entries(FX.models))
  models[name] = ids.map(id => ({ class: FX.images[id].class, f: featureOf(id) }));

test('parity: клиентский kNN повторяет пилот на всех сценариях (метки и маржи)', () => {
  assert.ok(FX.cases.length >= 20, 'фикстура подозрительно мала');
  for (const c of FX.cases) {
    const v = knnClassify(featureOf(c.img), models[c.model],
      { classIds: FX.classes, K: FX.params.k, W: FX.params.weights, T: FX.params.T });
    assert.equal(v.label, c.label,
      `${c.model}/${c.img} (${c.role}): метка ${v.label} ≠ пилотной ${c.label}`);
    // фичи фикстуры общие, но клиент — float32, питон — float64: дельта скалярных
    // произведений ~1e-4 на 1024 измерениях; маржи банка ≥3e-3 — на порядок больше
    assert.ok(Math.abs(v.margin - c.margin) < 5e-4,
      `${c.model}/${c.img}: маржа ${v.margin} против пилотной ${c.margin}`);
    assert.ok(Math.abs(v.conf - c.conf) <= 1.5,
      `${c.model}/${c.img}: conf ${v.conf} против пилотного ${c.conf.toFixed(1)}`);
  }
});

test('parity: пилотная драматургия — флипы conflict R1, чистые normal, holdout R2', () => {
  const byCase = (model, role) => FX.cases.filter(c => c.model === model && c.role === role);
  const flips = byCase('R1', 'conflict')
    .filter(c => c.label !== FX.images[c.img].class).length;
  assert.equal(flips, 8, 'эталон: 8/8 флипов конфликтных на R1');
  for (const c of byCase('R1', 'normal'))
    assert.equal(c.label, FX.images[c.img].class, `normal ${c.img} должен быть верным`);
  const hold = byCase('R2', 'holdout').filter(c => c.label === FX.images[c.img].class).length;
  assert.equal(hold, 4, 'эталон: holdout после ловушек 4/4');
});
