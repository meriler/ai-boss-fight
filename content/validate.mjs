#!/usr/bin/env node
/* Валидатор манифеста занятия (ТЗ-демка-з1 §1.2; инварианты — аннекс
 * ТЗ-демка-з1-схема-манифеста §3, пп.1–11). Гоняется в CI при каждой правке content/
 * и руками при работе с контентом:
 *
 *   node content/validate.mjs                 # все занятия в content/
 *   node content/validate.mjs content/z1-kot  # одно занятие
 *
 * Три слоя: (а) JSON Schema 2020-12 (форма — lesson/bank), (б) инварианты сверх схемы
 * (ссылочная целостность, лимит ≤5 на такт, роли банка, ассеты, оба резерва, hints),
 * (в) эталонная проходимость (инвариант 10) — скриптовый проход занятия до done ТЕМ ЖЕ
 * кодом машины/редьюсера, что живой клиент (app/core), с проверкой каждого действия
 * журнала по journal.schema.json. Exit 1 при любой ошибке; warnings не валят. */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { normalizeLesson, indexBank } from '../app/core/manifest.js';
import { walkLesson } from '../app/core/walk.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const LIMIT = 5;   // конституция: ≤5 одновременных интерактивов («Застрял» — вне лимита)

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const vLesson = ajv.compile(readJson(path.join(HERE, 'schema/lesson.schema.json')));
const vBank = ajv.compile(readJson(HERE + '/schema/bank.schema.json'));
const vJournal = ajv.compile(readJson(HERE + '/schema/journal.schema.json'));

function schemaErrors(validate, data, label) {
  if (validate(data)) return [];
  return (validate.errors || []).slice(0, 20)
    .map(e => `${label} схема: ${e.instancePath || '/'} ${e.message}`);
}

function checkManifestDir(dir) {
  const errors = [], warnings = [];
  const err = m => errors.push(m), warn = m => warnings.push(m);

  const manifest = readJson(path.join(dir, 'lesson.json'));
  const bank = readJson(path.join(dir, 'bank.json'));

  // (а) форма
  errors.push(...schemaErrors(vLesson, manifest, 'lesson'));
  errors.push(...schemaErrors(vBank, bank, 'bank'));
  if (errors.length) return { errors, warnings };   // дальше нужен валидный каркас

  if (manifest.lesson.bank !== bank.id)
    err(`lesson.bank=${manifest.lesson.bank} ≠ bank.id=${bank.id}`);

  const norm = normalizeLesson(manifest);
  const bi = indexBank(bank);
  const allSteps = [...norm.steps, ...norm.reserve];

  // — инвариант 3: банк — роли не пересекаются, минимумы, классы
  const seenIds = new Set();
  for (const img of bank.images) {
    if (seenIds.has(img.id)) err(`банк: дубль id картинки ${img.id} (роли не пересекаются)`);
    seenIds.add(img.id);
    if (!bi.classById.has(img.class))
      err(`банк: у ${img.id} класс ${img.class} вне classes`);
  }
  if ((bi.byRole.get('holdout') || []).length < 4)
    err(`банк: отложенный набор (holdout) должен быть ≥4, сейчас ${(bi.byRole.get('holdout') || []).length}`);

  const needImg = (id, role, where) => {
    const img = bi.byId.get(id);
    if (!img) err(`${where}: картинки ${id} нет в банке`);
    else if (img.role !== role) err(`${where}: ${id} имеет роль ${img.role}, ждали ${role}`);
  };

  for (const step of allSteps) {
    // — инвариант 1: лимит ≤5 на КАЖДЫЙ такт (включая развёрнутый сахар и формулы)
    for (const p of step.phases) {
      if (p.limitCount > LIMIT)
        err(`${step.id}.${p.id}: ${p.limitCount} одновременных интерактивов > ${LIMIT}`);
      if (p.card && p.card.multi && p.card.cells > 4)
        warn(`${step.id}.${p.id}: сетка ${p.card.cells} ячеек — осознанное исключение владельца?`);
    }

    // — инвариант 2: ссылочная целостность элементов
    const optLists = [];
    if (step.version) optLists.push({ name: 'version.choice.options', n: step.version.choice.options.length });
    if (step.forecast) optLists.push(
      { name: 'forecast.predict_options', n: step.forecast.predict_options.length },
      { name: 'forecast.reason_options', n: step.forecast.reason_options.length });
    let optPhase = 0;
    for (const p of step.phases) {
      for (const el of p.elements) {
        const mBasket = el.match(/^basket_(.+)$/);
        if (mBasket && !bi.classById.has(mBasket[1]))
          err(`${step.id}.${p.id}: ${el} — класса ${mBasket[1]} нет в bank.classes`);
        const mFrag = el.match(/^frag([1-9])$/);
        if (mFrag) {
          if (!p.slot) err(`${step.id}.${p.id}: frag-такт обязан нести slot`);
          else {
            const slots = step.version?.template?.slots;
            if (!slots || !slots[p.slot - 1])
              err(`${step.id}.${p.id}: slot ${p.slot} вне version.template.slots`);
            else if (+mFrag[1] > slots[p.slot - 1].length)
              err(`${step.id}.${p.id}: ${el} > ${slots[p.slot - 1].length} фрагментов слота ${p.slot}`);
          }
        }
      }
      const opts = p.elements.filter(e => /^opt[1-9]$/.test(e));
      if (opts.length) {
        const spec = optLists[optPhase++];   // маппинг по порядку тактов: choice → predict → reason
        if (!spec) err(`${step.id}.${p.id}: opt-такт без соответствующего спека options`);
        else {
          const maxN = Math.max(...opts.map(e => +e.slice(3)));
          if (maxN > spec.n) err(`${step.id}.${p.id}: opt${maxN} > ${spec.n} вариантов ${spec.name}`);
          if (opts.length !== spec.n) warn(`${step.id}.${p.id}: тактов-опций ${opts.length} ≠ ${spec.n} в ${spec.name}`);
        }
      }
      if (p.probe_set) for (const id of p.probe_set) needImg(id, 'probe', `${step.id}.${p.id}.probe_set`);
    }

    // — инвариант 3 (продолжение): ссылки шага в банк
    if (step.measure) for (const id of step.measure.holdout) needImg(id, 'holdout', `${step.id}.measure.holdout`);
    if (step.forecast) needImg(step.forecast.img, 'forecast', `${step.id}.forecast.img`);
    if (step.traps_from_bank && !(bi.byRole.get('trap') || []).length)
      err(`${step.id}: traps_from_bank, а роли trap в банке нет`);
    if (step.images_from_role && !(bi.byRole.get(step.images_from_role) || []).length)
      err(`${step.id}: images_from_role=${step.images_from_role}, а таких картинок в банке нет`);

    // — инвариант 4: у version.choice ровно один correct в границах
    if (step.version) {
      const c = step.version.choice;
      if (!Number.isInteger(c.correct) || c.correct < 0 || c.correct >= c.options.length)
        err(`${step.id}: version.choice.correct=${c.correct} вне границ options (${c.options.length})`);
    }

    // — инвариант 6: рантайм-множество кандидатов ⇒ подача one_by_one
    if (step.type === 'final_card' && step.action === 'mark_best_trap'
        && step.presentation !== 'one_by_one')
      err(`${step.id}: final_card mark_best_trap обязан объявлять presentation: one_by_one`);
  }

  // — инвариант 5: catchup у каждого шага (двойная страховка к схеме) + тексты ≤120
  for (const step of allSteps) {
    if (!step.catchup) err(`${step.id}: нет catchup`);
    else if (step.catchup.length > 120) err(`${step.id}: catchup длиннее 120 симв`);
    for (const p of step.phases)
      if (p.text && p.text.length > 120) err(`${step.id}.${p.id}: text длиннее 120 симв`);
  }
  for (const [k, v] of Object.entries(norm.ui))
    if (String(v).length > 120) err(`ui_texts.${k}: длиннее 120 симв`);

  // — инвариант 7: все img/src/карточки существуют в assets/ (включая небанковые)
  const assets = [];
  for (const step of allSteps) {
    for (const card of step.cards || []) assets.push([card.img, `${step.id}.cards.${card.id}`]);
    if (step.reveal) for (const c of step.reveal.cards) assets.push([c, `${step.id}.reveal`]);
    if (step.next_block) for (const c of step.next_block.cards) assets.push([c, `${step.id}.next_block`]);
  }
  for (const img of bank.images) assets.push([img.src, `банк.${img.id}`]);
  for (const [rel, where] of assets) {
    if (!fs.existsSync(path.join(dir, 'assets', rel)))
      err(`${where}: файла assets/${rel} нет (недостающий ассет — §7 п.2а)`);
  }

  // — инвариант 8: присутствуют ОБА резерва (правило 12)
  const kinds = new Set(norm.reserve.map(s => s.kind));
  if (!kinds.has('talk') || !kinds.has('trainer'))
    err(`резервы: нужны ОБА (talk И trainer), есть только [${[...kinds]}]`);

  // — инвариант 9: hints резолвятся в реальные шаги/такты
  const phaseKeys = new Set();
  for (const s of allSteps) for (const p of s.phases) phaseKeys.add(`${s.id}.${p.id}`);
  for (const [key, hint] of Object.entries(norm.hints)) {
    if (!phaseKeys.has(key)) err(`hints: ключ ${key} не резолвится в шаг.такт`);
    if (!phaseKeys.has(hint.restore_to)) err(`hints.${key}: restore_to=${hint.restore_to} не резолвится`);
  }

  // — инвариант 11: frozen ⇒ параметры (схема) — ссылки в банк уже проверены выше

  // — инвариант 10: эталонная проходимость (основной путь + путь с резервами)
  for (const includeReserve of [false, true]) {
    const res = walkLesson(norm, bi, { includeReserve });
    const tag = includeReserve ? 'проходимость (с резервами)' : 'проходимость';
    for (const e of res.errors) err(`${tag}: ${e}`);
    for (const entry of res.journal)
      if (!vJournal(entry))
        err(`${tag}: запись журнала ${entry.type} не проходит journal.schema: ` +
            (vJournal.errors || []).map(x => x.message).join('; '));
  }

  return { errors, warnings };
}

// ---- CLI ----
const args = process.argv.slice(2);
const dirs = args.length
  ? args.map(a => path.resolve(a))
  : fs.readdirSync(HERE)
      .map(d => path.join(HERE, d))
      .filter(d => fs.existsSync(path.join(d, 'lesson.json')));

if (!dirs.length) { console.error('нет манифестов (content/*/lesson.json)'); process.exit(1); }

let failed = false;
for (const dir of dirs) {
  const name = path.basename(dir);
  try {
    const { errors, warnings } = checkManifestDir(dir);
    for (const w of warnings) console.log(`  ⚠ ${name}: ${w}`);
    if (errors.length) {
      failed = true;
      console.error(`✗ ${name}: ${errors.length} ошибок`);
      for (const e of errors) console.error(`    - ${e}`);
    } else {
      console.log(`✓ ${name}: схема + инварианты + эталонная проходимость OK` +
                  (warnings.length ? ` (${warnings.length} warn)` : ''));
    }
  } catch (e) {
    failed = true;
    console.error(`✗ ${name}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
