// Скриншот КАЖДОГО уникального экрана З1 (step|phase|entry) — для ревью интерфейса.
// Универсальный драйвер по образцу driveLesson из e2e-z1.mjs. Разово, на удаление.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = process.argv[2] || '/tmp/shots-all';
mkdirSync(OUT, { recursive: true });
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PORT = 8600 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'z1shots-'));
writeFileSync(path.join(dataDir, 'seats.json'), JSON.stringify({ 1: 'Тест-А', 2: 'Тест-Б' }));
const server = spawn('python3', [path.join(ROOT, 'server/tele.py')], {
  env: { ...process.env, WS_TELE_DIR: dataDir, WS_TELE_PORT: String(PORT), WS_STATIC_DIR: ROOT }, stdio: 'ignore' });
process.on('exit', () => { try { server.kill(); } catch (e) {} });
for (let i = 0; ; i++) { try { if ((await fetch(BASE + '/dash')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 200)); if (i > 50) process.exit(1); }
const host = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Referer: BASE + '/dash' }, body: JSON.stringify(b) }).then(r => r.json());
await host('/host/gate', { action: 'start', lesson_id: 'z1-kot' });
await host('/host/gate', { action: 'code', step: 's1', code: '4712', show: true });

const rawMan = JSON.parse(readFileSync(path.join(ROOT, 'content/z1-kot/lesson.json'), 'utf-8')).lesson;
const man = { lesson: rawMan, stepById: Object.fromEntries(rawMan.steps.map(s => [s.id, s])) };
const bank = JSON.parse(readFileSync(path.join(ROOT, 'content/z1-kot/bank.json'), 'utf-8'));
const trainById = Object.fromEntries(bank.images.map(i => [i.id, i]));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const mk = async (seat) => {
  const c = await browser.newContext({ viewport: { width: 640, height: 980 } });
  const p = await c.newPage();
  p.setDefaultTimeout(20000);
  await p.goto(`${BASE}/z1.html?ws=1&demo=1&seat=${seat}`);
  return p;
};
const state = (p) => p.evaluate(() => {
  const s = document.getElementById('screen');
  return { step: s.dataset.step || '', phase: s.dataset.phase || '',
           entry: s.dataset.entry === '1', done: s.dataset.done === '1' };
});
const clickIf = async (p, sel) => {
  const el = await p.$(sel);
  if (!el) return false;
  const usable = await el.evaluate(e => !e.disabled && !e.closest('[inert]') && e.getClientRects().length > 0);
  if (!usable) return false;
  for (let a = 0; a < 3; a++) {
    const t = a === 0 ? el : await p.$(sel);
    if (!t) return false;
    try { await t.click({ timeout: 4000 }); return true; } catch (e) { await new Promise(r => setTimeout(r, 200)); }
  }
  return true;
};

let shotN = 0;
const seen = new Set();
async function maybeShot(p, st, tag) {
  const key = st.done ? 'done' : st.step + '|' + st.phase + '|' + (st.entry ? 'entry' : 'in');
  if (seen.has(tag + key)) return;
  seen.add(tag + key);
  shotN += 1;
  await new Promise(r => setTimeout(r, 350));   // дать догрузиться картинкам
  const name = String(shotN).padStart(2, '0') + '-' + (st.done ? 'done' : (st.step + '-' + (st.entry ? 'entry' : st.phase)));
  await p.screenshot({ path: path.join(OUT, name + '.png') });
  console.log('shot', name);
}

async function drive(p, { stopWhen, tag = '' } = {}) {
  for (let guard = 0; guard < 900; guard++) {
    const st = await state(p);
    await maybeShot(p, st, tag);
    if (st.done) return st;
    if (stopWhen && stopWhen(st)) return st;
    const step = man.stepById[st.step];

    if (st.entry) {
      if (step && step.gate && step.gate.kind === 'code') {
        if (await p.$('#gate_code')) { await p.fill('#gate_code', '4712'); await clickIf(p, '#btn_gate'); }
      } else if (step && step.gate) await clickIf(p, '#btn_gate');
      await new Promise(r => setTimeout(r, 150));
      continue;
    }
    if (!step) { await new Promise(r => setTimeout(r, 150)); continue; }

    if (step.type === 'cards_quiz') {
      const card = (step.cards || []).find(c => 'card_' + c.id === st.phase);
      if (card && card.multi) {
        if (await p.$('#btn_next')) await clickIf(p, '#btn_next');
        else {
          const on = await p.evaluate(() => [...document.querySelectorAll('.capcell.on')].length);
          if (on < card.correct.length) await clickIf(p, '#cell' + card.correct[on]);
          else await clickIf(p, '#btn_commit');
        }
      } else if (card) await clickIf(p, '#quizopt' + card.correct);
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    if (step.type === 'talk_chat') {
      if (await clickIf(p, '#btn_next')) { await new Promise(r => setTimeout(r, 200)); continue; }
      if (await clickIf(p, '#btn_think')) { await new Promise(r => setTimeout(r, 2500)); continue; }
      if (await p.$('#chat_input')) {
        await p.fill('#chat_input', 'она не думает — она сравнивает картинки');
        await clickIf(p, '#btn_chat_send');
        await p.waitForSelector('#btn_next', { timeout: 10000 }).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 200));
      continue;
    }

    if (step.type === 'final_card') {
      if (!await clickIf(p, '#btn_pick')) if (!await clickIf(p, '#btn_next')) await clickIf(p, '#btn_done');
      await new Promise(r => setTimeout(r, 250));
      continue;
    }

    // trainer_act — по элементам такта
    const phase = (step.phases || []).find(ph => ph.id === st.phase);
    if (!phase) { await new Promise(r => setTimeout(r, 150)); continue; }
    const els = phase.elements || [];

    if (els.some(e => e.startsWith('basket_'))) {
      const imgId = await p.$eval('#img_current', el => el.dataset.img).catch(() => null);
      const img = imgId && trainById[imgId];
      if (img) await clickIf(p, '#basket_' + img.class);
      else await clickIf(p, '#btn_next');
    } else if (els.includes('btn_pick')) {
      if (!await clickIf(p, '#btn_pick')) await clickIf(p, '#btn_next');
    } else if (els.includes('btn_train')) {
      await clickIf(p, '#btn_train');
      await new Promise(r => setTimeout(r, 700));
    } else if (els.some(e => /^frag[1-9]$/.test(e))) {
      await clickIf(p, '#frag1');
      await new Promise(r => setTimeout(r, 400));
    } else if (els.includes('free_text')) {
      await clickIf(p, '#btn_skip');
    } else if (els.includes('btn_commit')) {
      await clickIf(p, '#btn_commit');
      await new Promise(r => setTimeout(r, 400));
    } else if (els.some(e => /^opt[1-9]$/.test(e))) {
      await clickIf(p, '#opt1');
      await new Promise(r => setTimeout(r, 400));
    } else if (!els.length) {
      await new Promise(r => setTimeout(r, 300));
    } else if (els.includes('btn_check')) {
      if (!await clickIf(p, '#btn_check')) await clickIf(p, '#btn_next');
    } else if (els.includes('btn_next')) {
      await clickIf(p, '#btn_next');
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('drive: лимит шагов; экраны сняты до этого места');
}

const vStep = rawMan.steps.find(s => s.version);
const waitPhase = vStep.phases.find(ph => !(ph.elements || []).length).id;
const A = await mk(1), B = await mk(2);
await drive(A, { tag: 'A', stopWhen: (s) => s.step === vStep.id && s.phase === waitPhase });
await drive(B, { tag: 'B', stopWhen: (s) => s.step === vStep.id && s.phase === waitPhase });
await host('/host/reveal', { step: vStep.id });
await new Promise(r => setTimeout(r, 2500));
await drive(A, { tag: 'A' });
console.log('готово:', shotN, 'экранов →', OUT);
await browser.close();
server.kill();
process.exit(0);
