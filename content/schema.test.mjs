/* Негативные фикстуры схемы и инвариантов валидатора (аудит ядра 18.07, пп.8, 11–15, 17):
 * дыры, через которые битый контент проходил CI и ломал живой клиент. Каждый кейс —
 * реальный манифест z1-kot с ОДНОЙ мутацией; до фикса схемы/валидатора кейс проходил
 * зелёным (красные-без-фикса тесты).
 *
 * Запуск: node --test content/*.test.mjs (входит в ci.sh). */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const vLesson = ajv.compile(readJson(path.join(HERE, 'schema/lesson.schema.json')));

const base = () => JSON.parse(JSON.stringify(readJson(path.join(HERE, 'z1-kot/lesson.json'))));
const trainerStep = m => m.lesson.steps.find(s => s.type === 'trainer_act' && s.measure);

/* ---------- слой (а): JSON Schema ---------- */

test('схема: реальные манифесты валидны (санити после ужесточения)', () => {
  for (const v of ['z1-kot', '_test-variant'])
    assert.ok(vLesson(readJson(path.join(HERE, v, 'lesson.json'))),
      v + ': ' + JSON.stringify((vLesson.errors || []).slice(0, 3)));
});

test('схема п.13: опечатка смыслового поля (measur) больше не проходит', () => {
  const m = base();
  const s = trainerStep(m);
  s.measur = s.measure;          // опечатка: walk решил бы, что замера нет
  delete s.measure;
  assert.ok(!vLesson(m), 'measur вместо measure обязан быть ошибкой схемы');
});

test('схема п.13: неизвестное поле шага отклоняется (unevaluatedProperties)', () => {
  const m = base();
  m.lesson.steps[0].mystery_field = 1;
  assert.ok(!vLesson(m));
});

test('схема п.12: ручные phases у derived-типов запрещены', () => {
  for (const type of ['cards_quiz', 'final_card', 'gate', 'slide', 'talk_chat']) {
    const m = base();
    const s = m.lesson.steps.find(x => x.type === type);
    assert.ok(s, 'в z1-kot есть шаг типа ' + type);
    s.phases = [{ id: 'manual', elements: [], overlays: [] }];
    assert.ok(!vLesson(m), type + ' с ручными phases обязан падать (отменяет derived-формулу)');
  }
});

test('схема п.12: сахар elements верхнего уровня запрещён (в т.ч. у trainer_act)', () => {
  for (const type of ['cards_quiz', 'trainer_act']) {
    const m = base();
    const s = m.lesson.steps.find(x => x.type === type);
    s.elements = ['btn_next'];
    assert.ok(!vLesson(m), type + ' с top-level elements обязан падать');
  }
});

test('схема: reserveStep с kind/title остаётся валидным (не пере-ужесточили)', () => {
  const m = base();
  assert.ok(vLesson(m));
  delete m.lesson.reserve_steps[0].kind;   // а вот без kind — падает
  assert.ok(!vLesson(m));
});

/* ---------- слой (б): инварианты валидатора — через настоящий validate.mjs ----------
 * Мутированный манифест кладётся во временный каталог; bank.json и assets/ —
 * симлинки на реальные (валидатору нужны файлы картинок). */

function runValidator(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z1schema-'));
  const m = base();
  mutate(m);
  fs.writeFileSync(path.join(dir, 'lesson.json'), JSON.stringify(m));
  fs.symlinkSync(path.join(HERE, 'z1-kot/bank.json'), path.join(dir, 'bank.json'));
  fs.symlinkSync(path.join(HERE, 'z1-kot/assets'), path.join(dir, 'assets'));
  try {
    execFileSync('node', [path.join(HERE, 'validate.mjs'), dir], { encoding: 'utf-8' });
    return { ok: true, out: '' };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('валидатор п.8: hints.restore_to в другой шаг — ошибка', () => {
  const r = runValidator(m => { m.lesson.hints['s6.traps'].restore_to = 's2.train'; });
  assert.ok(!r.ok && r.out.includes('указывает другой шаг'), r.out.slice(0, 400));
});

test('валидатор п.14: дубль phase id внутри шага — ошибка', () => {
  const r = runValidator(m => {
    const s = trainerStep(m);
    s.phases[1].id = s.phases[0].id;
  });
  assert.ok(!r.ok && r.out.includes('дубль id такта'), r.out.slice(0, 400));
});

test('валидатор п.11: две экранные семантики на такте — ошибка', () => {
  const r = runValidator(m => {
    // пробы + «Научить» на одном такте: живой рендер показал бы только пробы,
    // кнопка обучения была бы недоступна детям (пример из аудита)
    const s = m.lesson.steps.find(x => x.type === 'trainer_act');
    const probe = s.phases.find(p => p.probe_set);
    probe.elements.push('btn_train');
  });
  assert.ok(!r.ok && r.out.includes('экранных семантик'), r.out.slice(0, 400));
});

test('валидатор п.15: btn_commit прогноза последним тактом — ошибка', () => {
  const r = runValidator(m => {
    const s = trainerStep(m);   // s6: forecast
    // выкинуть все такты после forecast_commit
    const i = s.phases.findIndex(p => (p.elements || []).includes('btn_commit'));
    s.phases = s.phases.slice(0, i + 1);
  });
  assert.ok(!r.ok && r.out.includes('post-commit'), r.out.slice(0, 400));
});

test('валидатор п.17: два резерва одного kind — ошибка', () => {
  const r = runValidator(m => {
    const talk = m.lesson.reserve_steps.find(s => s.kind === 'talk');
    m.lesson.reserve_steps.push({ ...JSON.parse(JSON.stringify(talk)), id: 'r1dup' });
  });
  assert.ok(!r.ok && r.out.includes('ровно один'), r.out.slice(0, 400));
});
