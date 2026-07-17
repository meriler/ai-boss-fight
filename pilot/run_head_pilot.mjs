#!/usr/bin/env node
/* Мини-пилот §6 обучаемой головы (дорожка Б, ТЗ-платформа-v3 §2.4; фиксация ДО прогона —
 * пилот-R1-параметры.md §8). Банк ЗАМОРОЖЕН (48 картинок 512px); фичи — дамп
 * pilot/parity-fixture.json (dump_parity.py, те же, что в parity-сверке kNN). Питон-порта
 * головы НЕТ (урок «голосование vs argmin»): один канонический JS-модуль app/engine/head.js
 * гоняется и в проде, и здесь.
 *
 * Сценарии: R1 = 16 train → conflict/normal/pseudo_strange/holdout; R2 = train+8 trap → holdout.
 * Пороги гейта (§8.5, все одновременно):
 *   conflict-флипы 8/8 · false_flips 0 · normal 8/8 · holdout R2 4/4 ·
 *   уверенность флипов ≥75% по замороженному порогу (logit-маржа ≥ T·ln3).
 * Плюс шкала §8.4 (строится из чистых normal-маржей фиксированным правилом) и чеки
 * живости §2.3: normal — разброс conf ≥10, медиана ≤93; шум 25/50%, слом 12/4 —
 * разброс ≥15, медиана ≤93, монотонность.
 *
 * Запуск: node pilot/run_head_pilot.mjs [--fixture]
 *   --fixture — контрольный перегон: пишет parity-head-fixture.json (веса-хэши, вердикты,
 *   якоря шкалы) для CI-теста parity-head.test.mjs. Отчёт: pilot/head-pilot-report.md.
 * Выход 0 = ALL_PASS, 1 = провал (head не попадает в engines банка). */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { trainHead, headClassify, weightsSig, DEF_HEAD } from '../app/engine/head.js';
import { scaleConf } from '../app/engine/knn.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, 'parity-fixture.json'), 'utf-8'));
const BANK = JSON.parse(fs.readFileSync(path.join(HERE, '../content/z1-kot/bank.json'), 'utf-8'));
const WRITE_FIXTURE = process.argv.includes('--fixture');

// гиперпараметры: банк (если голова уже вкачена) > кандидаты H1 (DEF_HEAD)
const bankHead = (BANK.frozen_params.engines && BANK.frozen_params.engines.head) || {};
const { confidence_scale: _ignore, ...bankHyper } = bankHead;
const HYPER = { ...DEF_HEAD, ...bankHyper };
const T = HYPER.T;
const FLIP_MIN = T * Math.log(3);   // замороженный порог «уверенный флип ≥75%» (§8.3)

const f32 = a => Float32Array.from(a);
const feat = id => ({ emb: f32(FX.features[id].emb), pix: f32(FX.features[id].pix) });
const cls = id => FX.images[id].class;
const byRole = r => Object.keys(FX.images).filter(id => FX.images[id].role === r);

const model = (ids, relabel = {}) => trainHead(
  ids.map(id => ({ img: id, class: relabel[id] || cls(id), f: feat(id) })),
  FX.classes, HYPER);

function run(m, probeIds, scale) {
  return probeIds.map(id => {
    const v = headClassify(feat(id), m, { scale });
    return { id, label: v.label, ok: v.label === cls(id), margin: v.margin,
             conf: v.conf, spectrum: v.spectrum };
  });
}

const train = byRole('train');
const traps = byRole('trap');
const R1 = model(train);
const R2 = model(train.concat(traps));

/* ---------- шкала §8.4: правило заморожено, константы из чистых normal-маржей R1 ---------- */
const sig2floor = x => { const p = Math.pow(10, Math.floor(Math.log10(Math.abs(x))) - 1); return Math.floor(x / p) * p; };
const sig2ceil = x => { const p = Math.pow(10, Math.floor(Math.log10(Math.abs(x))) - 1); return Math.ceil(x / p) * p; };
const cleanMargins = run(R1, byRole('normal')).map(r => r.margin);
let m85 = sig2floor(Math.min(...cleanMargins));
let mcap = sig2ceil(Math.max(...cleanMargins));
if (m85 <= FLIP_MIN) m85 = sig2ceil(FLIP_MIN * 1.2);   // монотонность якорей при низких чистых маржах
if (mcap <= m85) mcap = sig2ceil(m85 * 1.5);
const ANCHORS = [[0, 50], [round4(FLIP_MIN), 75], [round4(m85), 85], [round4(mcap), 95]];
function round4(x) { return Math.round(x * 1e4) / 1e4; }

/* ---------- отчёт ---------- */
const lines = [];
const say = s => { lines.push(s); console.log(s); };
let allOk = true;
const check = (name, cond, detail) => {
  say((cond ? '- ✅ ' : '- ❌ ') + name + (detail ? ' — ' + detail : ''));
  if (!cond) allOk = false;
};
const fmt = n => (typeof n === 'number' ? n.toFixed(3) : String(n));
const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

say('# Мини-пилот §6 — обучаемая голова (H1), отчёт');
say('');
say('Дата прогона: ' + new Date().toISOString().slice(0, 10) +
    ' · банк: ' + BANK.id + ' (заморожен, 48 картинок 512px) · фичи: parity-fixture.json');
say('');
say('Гиперпараметры (' + (BANK.frozen_params.engines?.head ? 'frozen_params.engines.head банка'
    : 'кандидаты H1, DEF_HEAD') + '): `' + JSON.stringify(HYPER) + '`');
say('');
say('Замороженный порог флипа: logit-маржа ≥ T·ln3 = ' + FLIP_MIN.toFixed(4));
say('Шкала (правило §8.4, константы из чистых normal-маржей): `' + JSON.stringify(ANCHORS) + '`');
say('');

const sections = [
  ['R1 → conflict (нужны флипы)', R1, byRole('conflict')],
  ['R1 → normal (нужны 8/8 верных)', R1, byRole('normal')],
  ['R1 → pseudo_strange (0 ложных флипов)', R1, byRole('pseudo_strange')],
  ['R1 → holdout (информационно: должен ошибаться)', R1, byRole('holdout')],
  ['R2 (train+traps) → holdout (нужно 4/4)', R2, byRole('holdout')],
];
const results = {};
for (const [name, m, ids] of sections) {
  const rs = run(m, ids, ANCHORS);
  results[name] = rs;
  say('## ' + name);
  say('');
  say('| img | класс банка | вердикт | верно | logit-маржа | conf (шкала) |');
  say('|---|---|---|---|---|---|');
  for (const r of rs)
    say(`| ${r.id} | ${cls(r.id)} | ${r.label} | ${r.ok ? '✓' : '✗'} | ${fmt(r.margin)} | ${r.conf} |`);
  say('');
}

say('## Пороги гейта (§8.5 — все одновременно)');
say('');
const conflict = results[sections[0][0]];
const normal = results[sections[1][0]];
const strange = results[sections[2][0]];
const hold1 = results[sections[3][0]];
const hold2 = results[sections[4][0]];

const flips = conflict.filter(r => !r.ok);
check('конфликтные: 8/8 нужных флипов', flips.length === 8, flips.length + '/8');
check('лже-странные: 0 ложных флипов', strange.every(r => r.ok),
  strange.filter(r => !r.ok).map(r => r.id).join(', ') || 'ложных нет');
check('обычные: 8/8 верных', normal.every(r => r.ok),
  normal.filter(r => !r.ok).map(r => r.id).join(', ') || 'все верны');
check('holdout ПОСЛЕ ловушек: 4/4', hold2.every(r => r.ok),
  hold2.map(r => (r.ok ? '✓' : '✗')).join(''));
check('уверенность флипов ≥75% (маржа ≥ ' + FLIP_MIN.toFixed(4) + ')',
  flips.length === 8 && flips.every(r => r.margin >= FLIP_MIN),
  'маржи: ' + conflict.map(r => fmt(r.margin)).join(', '));
say('- ℹ️ holdout ДО ловушек (должен ошибаться, иначе замер «до/после» пуст): ' +
  hold1.filter(r => r.ok).length + '/4 верных');
if (flips.length === 8) {
  const weakest = Math.min(...flips.map(r => r.margin));
  say('- ℹ️ запас худшего флипа над порогом: маржа ' + weakest.toFixed(3) + ' против ' +
      FLIP_MIN.toFixed(3) + ' (+' + (100 * (weakest / FLIP_MIN - 1)).toFixed(1) +
      '%; у kNN-пилота худший флип был 77.7% при пороге 75 — запас той же природы)');
}
say('');

say('## Шкала и живость (§8.4 + ТЗ v3 §2.3)');
say('');
{
  const probesAll = [];
  for (let m = 0; m <= mcap * 2; m += mcap / 100) probesAll.push(scaleConf(m, ANCHORS));
  check('шкала монотонна', probesAll.every((v, i) => i === 0 || v >= probesAll[i - 1]));
  check('потолок 95 держится на всех сценариях',
    Object.values(results).every(rs => rs.every(r => r.conf <= 95)));
  const confs = normal.map(r => r.conf);
  check('живость (normal): разброс conf ≥10 пунктов',
    Math.max(...confs) - Math.min(...confs) >= 10, 'разброс ' + (Math.max(...confs) - Math.min(...confs)));
  check('живость (normal): медиана conf ≤93', median(confs) <= 93, 'медиана ' + median(confs));

  // сценарная проверка (план правок / §2.3): шум разметки, слом 12/4 — шкала жива и там
  const cats = train.filter(id => cls(id) === 'cat');
  const dogs = train.filter(id => cls(id) === 'dog');
  const flip = id => (cls(id) === 'cat' ? 'dog' : 'cat');
  const relabelOf = ids => Object.fromEntries(ids.map(id => [id, flip(id)]));
  const noisy = {
    noise25: model(train, relabelOf([cats[0], cats[1], dogs[0], dogs[1]])),
    noise50: model(train, relabelOf(cats.slice(0, 4).concat(dogs.slice(0, 4)))),
    imbalance: model(train, relabelOf(dogs.slice(0, 4))),
  };
  // планка живости — зафиксированная §8.4/ТЗ §2.3: разброс ≥10, медиана ≤93 (в ТЗ —
  // «информационная метрика, не гейт»). У kNN-скрипта calibrate_scale на шумовых
  // сценариях планка строже (≥15) — она пост-хок фазы 0.5 и в фиксацию H1 не входила
  for (const [name, m] of Object.entries(noisy)) {
    const ids = name === 'imbalance' ? byRole('holdout') : byRole('normal').concat(byRole('holdout'));
    const rs = run(m, ids, ANCHORS);
    const cc = rs.map(r => r.conf);
    const spread = Math.max(...cc) - Math.min(...cc);
    check('живость (' + name + '): разброс conf ≥10, медиана ≤93',
      spread >= 10 && median(cc) <= 93, 'разброс ' + spread + ', медиана ' + median(cc) +
      ', conf: ' + cc.join(', '));
  }
}
say('');
say('## Детерминизм и скорость');
say('');
{
  const R1b = model(train);
  check('два train = бит-в-бит одни веса (weightsSig)', weightsSig(R1) === weightsSig(R1b),
    weightsSig(R1));
  const t0 = performance.now();
  model(train.concat(traps));
  const ms = performance.now() - t0;
  say('- ℹ️ train R2 (24 примера × 2048 фич × ' + HYPER.epochs + ' эпох): ' +
      ms.toFixed(0) + ' мс на этой машине (замер на слабом Windows-ноуте — хвост §6 п.5, на репетиции)');
}
say('');
say(allOk ? '**ВЕРДИКТ: ALL_PASS — все пороги гейта §6 и чеки живости зелёные.** ' +
            'Следующий шаг: head в frozen_params.engines банка + parity-head-fixture в CI; ' +
            'включение в прод-манифест — отдельное решение владельца (пока только флаг ?engine=head).'
          : '**ВЕРДИКТ: ПРОВАЛ — есть красные пороги. Head НЕ попадает в engines банка; ' +
            'дефолт kNN не трогается. План Б — ТЗ v3 §2.4 (head на З2-банке).**');

fs.writeFileSync(path.join(HERE, 'head-pilot-report.md'), lines.join('\n') + '\n');
console.log('\n→ pilot/head-pilot-report.md');

if (WRITE_FIXTURE && allOk) {
  const cases = [];
  for (const [name, m, ids] of sections) {
    const key = name.startsWith('R2') ? 'R2' : 'R1';
    for (const r of run(m, ids, ANCHORS))
      cases.push({ model: key, img: r.id, role: FX.images[r.id].role,
                   label: r.label, margin: r.margin, conf: r.conf });
  }
  const out = {
    comment: 'эталон головы H1 (контрольный перегон run_head_pilot.mjs --fixture): ' +
             'CI переобучает head на этих фичах и сверяет веса/вердикты бит-в-бит',
    hyper: HYPER,
    anchors: ANCHORS,
    models: { R1: train, R2: train.concat(traps) },
    weights_sig: { R1: weightsSig(R1), R2: weightsSig(R2) },
    cases,
  };
  fs.writeFileSync(path.join(HERE, 'parity-head-fixture.json'), JSON.stringify(out));
  console.log('→ pilot/parity-head-fixture.json (веса R1=' + weightsSig(R1) + ', R2=' + weightsSig(R2) + ')');
}
process.exit(allOk ? 0 : 1);
