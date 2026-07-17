/* Parity обучаемой головы с её мини-пилотом §6 (H1, пилот-R1-параметры §8).
 * Фикстура pilot/parity-head-fixture.json — контрольный перегон run_head_pilot.mjs
 * --fixture: вердикты всех сценариев + БИТ-В-БИТ подписи весов (weightsSig) моделей
 * R1/R2. Питон-порта головы нет (урок «голосование vs argmin»): и прод, и пилот
 * гоняют ОДИН канонический модуль head.js — тест ловит любой дрейф математики,
 * гиперпараметров банка или канонизации состава. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { trainHead, headClassify, weightsSig, DEF_HEAD } from './head.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, '../../pilot/parity-fixture.json'), 'utf-8'));
const HFX = JSON.parse(fs.readFileSync(path.join(HERE, '../../pilot/parity-head-fixture.json'), 'utf-8'));
const BANK = JSON.parse(fs.readFileSync(path.join(HERE, '../../content/z1-kot/bank.json'), 'utf-8'));

const f32 = a => Float32Array.from(a);
const feat = id => ({ emb: f32(FX.features[id].emb), pix: f32(FX.features[id].pix) });

const models = {};
for (const [name, ids] of Object.entries(HFX.models))
  models[name] = trainHead(
    ids.map(id => ({ img: id, class: FX.images[id].class, f: feat(id) })),
    FX.classes, HFX.hyper);

test('parity-head: банк и фикстура пилота согласованы (гиперпараметры, якоря, DEF)', () => {
  const bh = BANK.frozen_params.engines.head;
  for (const k of ['feat_scale_pix', 'epochs', 'lr', 'l2', 'class_balance', 'min_per_class', 'T']) {
    assert.equal(bh[k], HFX.hyper[k], `банк.${k} разошёлся с фикстурой пилота`);
    assert.equal(DEF_HEAD[k], HFX.hyper[k], `DEF_HEAD.${k} разошёлся с пилотированным банком`);
  }
  assert.deepEqual(bh.confidence_scale.anchors, HFX.anchors,
    'якоря шкалы головы в банке ≠ якорям контрольного перегона');
});

test('parity-head: веса моделей R1/R2 бит-в-бит как в контрольном перегоне', () => {
  assert.equal(weightsSig(models.R1), HFX.weights_sig.R1);
  assert.equal(weightsSig(models.R2), HFX.weights_sig.R2);
});

test('parity-head: вердикты всех сценариев пилота воспроизводятся (метка, маржа, conf)', () => {
  assert.ok(HFX.cases.length >= 28, 'фикстура подозрительно мала');
  for (const c of HFX.cases) {
    const v = headClassify(feat(c.img), models[c.model], { scale: HFX.anchors });
    assert.equal(v.label, c.label, `${c.model}/${c.img} (${c.role}): метка разошлась`);
    assert.ok(Math.abs(v.margin - c.margin) < 1e-9,
      `${c.model}/${c.img}: маржа ${v.margin} ≠ ${c.margin}`);
    assert.equal(v.conf, c.conf, `${c.model}/${c.img}: conf разошёлся`);
  }
});

test('parity-head: пороги гейта §6 держатся на фикстуре (флипы, чистые, holdout)', () => {
  const img = id => FX.images[id];
  const by = (m, r) => HFX.cases.filter(c => c.model === m && c.role === r);
  const flips = by('R1', 'conflict').filter(c => c.label !== img(c.img).class);
  assert.equal(flips.length, 8, 'эталон: 8/8 флипов');
  const thr = HFX.hyper.T * Math.log(3);
  for (const c of flips)
    assert.ok(c.margin >= thr, `${c.img}: маржа флипа ${c.margin} ниже порога ${thr}`);
  for (const c of by('R1', 'normal').concat(by('R1', 'pseudo_strange')))
    assert.equal(c.label, img(c.img).class, `${c.img} обязан быть верным`);
  const hold = by('R2', 'holdout').filter(c => c.label === img(c.img).class);
  assert.equal(hold.length, 4, 'эталон: holdout после ловушек 4/4');
});
