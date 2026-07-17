#!/usr/bin/env node
/* Калибровка шкалы уверенности (план-правок 17.07, фаза 0.5): собрать маржи клиентского
 * kNN по сценариям занятия на РЕАЛЬНЫХ фичах пилота (parity-fixture.json) и проверить,
 * что кусочно-линейная шкала banка (frozen_params.confidence_scale) даёт заданный спектр:
 * чистые 85–95, спорные 55–75, потолок 95. Пилотный порог «флип ≥75%» остаётся
 * legacy-проверкой СЫРОЙ маржи (margin ≥ T·ln3 = 0.033), не экранного процента.
 *
 * Сценарии (train-состав → замеряемые картинки):
 *   clean     — R1 (16 train) → normal-пробы (модель права, фон совпадает)
 *   conflict  — R1 → conflict-пробы (флипы «тайной приметы» — драматургия R1)
 *   traps     — R2 (train+8 ловушек) → holdout (модель починена)
 *   noise25   — R1 с 25% перепутанных меток (4 из 16) → normal+holdout
 *   noise50   — R1 с 50% перепутанных меток (8 из 16) → normal+holdout
 *   imbalance — слом 12/4 из прогона 17.07 (4 собаки размечены котами) → holdout
 *
 * Запуск: node pilot/calibrate_scale.mjs   (пишет pilot/calibration-report.md)
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { knnClassify, scaleConf } from '../app/engine/classifier.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, 'parity-fixture.json'), 'utf-8'));
const BANK = JSON.parse(fs.readFileSync(
  path.join(HERE, '../content/z1-kot/bank.json'), 'utf-8'));

const ANCHORS = BANK.frozen_params.confidence_scale.anchors;
const T = FX.params.T;
const LEGACY = T * Math.log(3);   // сырая маржа, эквивалентная conf 75 пилотной сигмоиды

const f32 = a => Float32Array.from(a);
const feat = id => ({ emb: f32(FX.features[id].emb), pix: f32(FX.features[id].pix) });
const cls = id => FX.images[id].class;
const byRole = r => Object.keys(FX.images).filter(id => FX.images[id].role === r);

const model = (ids, relabel = {}) =>
  ids.map(id => ({ class: relabel[id] || cls(id), f: feat(id) }));

function run(examples, probeIds) {
  return probeIds.map(id => {
    const v = knnClassify(feat(id), examples,
      { classIds: FX.classes, K: FX.params.k, W: FX.params.weights, T, scale: ANCHORS });
    const sig = Math.round(100 / (1 + Math.exp(-v.margin / T)));
    return { id, ok: v.label === cls(id), margin: v.margin, conf: v.conf, sigmoid: sig };
  });
}

const train = byRole('train');
const traps = byRole('trap');
const cats = train.filter(id => cls(id) === 'cat');
const dogs = train.filter(id => cls(id) === 'dog');
const flip = id => (cls(id) === 'cat' ? 'dog' : 'cat');
const relabelOf = ids => Object.fromEntries(ids.map(id => [id, flip(id)]));

const scenarios = [
  ['clean', model(train), byRole('normal')],
  ['conflict', model(train), byRole('conflict')],
  ['traps', model(train.concat(traps)), byRole('holdout')],
  ['noise25', model(train, relabelOf([cats[0], cats[1], dogs[0], dogs[1]])),
    byRole('normal').concat(byRole('holdout'))],
  ['noise50', model(train, relabelOf(cats.slice(0, 4).concat(dogs.slice(0, 4)))),
    byRole('normal').concat(byRole('holdout'))],
  ['imbalance', model(train, relabelOf(dogs.slice(0, 4))), byRole('holdout')],
];

const fmt = n => (typeof n === 'number' ? n.toFixed(3) : String(n));
const lines = [];
const say = s => { lines.push(s); console.log(s); };

say('# Калибровка шкалы уверенности — отчёт (фаза 0.5, по реальным фичам пилота)');
say('');
say('Шкала банка (кусочно-линейная, монотонная): ' + JSON.stringify(ANCHORS) +
    ', потолок ' + ANCHORS[ANCHORS.length - 1][1] + '.');
say('Legacy-порог пилота «флип ≥75%» = сырая маржа ≥ T·ln3 = ' + LEGACY.toFixed(4) + '.');
say('');

let allOk = true;
const check = (name, cond, detail) => {
  say((cond ? '- ✅ ' : '- ❌ ') + name + (detail ? ' — ' + detail : ''));
  if (!cond) allOk = false;
};

for (const [name, examples, probes] of scenarios) {
  const rs = run(examples, probes);
  say('## ' + name);
  say('');
  say('| img | верно | маржа | conf (шкала) | conf (старая сигмоида) |');
  say('|---|---|---|---|---|');
  for (const r of rs)
    say(`| ${r.id} | ${r.ok ? '✓' : '✗'} | ${fmt(r.margin)} | ${r.conf} | ${r.sigmoid} |`);
  say('');
}

say('## Проверки спектра и legacy-порога');
say('');
{
  const clean = run(model(train), byRole('normal'));
  check('чистые в 85–95', clean.every(r => r.conf >= 85 && r.conf <= 95),
    clean.map(r => r.conf).join(', '));
  // спорные = |маржа| ниже legacy-порога (голоса и d̄ почти вничью) — по ВСЕМ сценариям;
  // уверенный флип (маржа выше порога) спорным не является: высокая уверенность в ошибке —
  // честная драматургия «тайной приметы», не дефект шкалы
  const disput = scenarios.flatMap(([, ex, pr]) => run(ex, pr))
    .filter(r => Math.abs(r.margin) <= LEGACY);
  check('спорные (|маржа| ≤ legacy-порога) в 25–75', disput.length > 0 &&
    disput.every(r => r.conf >= 25 && r.conf <= 75),
    disput.map(r => r.conf).join(', '));
  check('потолок 95: ни один сценарий не превышает', scenarios.every(([, ex, pr]) =>
    run(ex, pr).every(r => r.conf <= 95)));
  const flips = run(model(train), byRole('conflict'));
  check('legacy: все 8 пилотных флипов держат сырую маржу ≥ ' + LEGACY.toFixed(4),
    flips.every(r => !r.ok && r.margin >= LEGACY),
    flips.map(r => fmt(r.margin)).join(', '));
  const probesAll = [];
  for (let m = 0; m <= 0.4; m += 0.005) probesAll.push(scaleConf(m, ANCHORS));
  check('шкала монотонна на [0, 0.4]',
    probesAll.every((v, i) => i === 0 || v >= probesAll[i - 1]));
  check('зеркало отрицательных маржей: scaleConf(-m) = 100 - scaleConf(m)',
    Math.abs(scaleConf(-0.02, ANCHORS) - (100 - scaleConf(0.02, ANCHORS))) < 1e-9);
}
say('');
say(allOk ? '**Итог: все проверки калибровки зелёные.**'
          : '**Итог: есть КРАСНЫЕ проверки — шкалу не выкатывать.**');

fs.writeFileSync(path.join(HERE, 'calibration-report.md'), lines.join('\n') + '\n');
console.log('\n→ pilot/calibration-report.md');
process.exit(allOk ? 0 : 1);
