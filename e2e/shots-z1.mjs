// Скриншоты ключевых экранов З1 для визуальной проверки (разово, на удаление)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = process.argv[2] || '/tmp';
const EXE = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PORT = 8600 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'z1shot-'));
writeFileSync(path.join(dataDir, 'seats.json'), JSON.stringify({ 1: 'Тест-А', 2: 'Тест-Б' }));
const server = spawn('python3', [path.join(ROOT, 'server/tele.py')], {
  env: { ...process.env, WS_TELE_DIR: dataDir, WS_TELE_PORT: String(PORT), WS_STATIC_DIR: ROOT }, stdio: 'ignore' });
process.on('exit', () => { try { server.kill(); } catch (e) {} });
for (let i = 0; ; i++) { try { if ((await fetch(BASE + '/dash')).ok) break; } catch (e) {} await new Promise(r => setTimeout(r, 200)); if (i > 50) process.exit(1); }
const host = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Referer: BASE + '/dash' }, body: JSON.stringify(b) }).then(r => r.json());
await host('/host/gate', { action: 'start', lesson_id: 'z1-kot' });
await host('/host/gate', { action: 'code', step: 's1', code: '4712', show: true });

const man = JSON.parse(readFileSync(path.join(ROOT, 'content/z1-kot/lesson.json'), 'utf-8')).lesson;
const bank = JSON.parse(readFileSync(path.join(ROOT, 'content/z1-kot/bank.json'), 'utf-8'));
const train = bank.images.filter(i => i.role === 'train_core');

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await browser.newPage({ viewport: { width: 640, height: 900 } });
const shot = (name) => p.screenshot({ path: path.join(OUT, 'z1-' + name + '.png'), fullPage: false });
const st = () => p.evaluate(() => ({ ...document.getElementById('screen').dataset }));
const wait = async (pred, t = 20000) => { const t0 = Date.now(); for (;;) { if (pred(await st())) return; if (Date.now() - t0 > t) throw new Error('timeout'); await new Promise(r => setTimeout(r, 120)); } };

await p.goto(BASE + '/z1.html?ws=1&demo=1&seat=1');
await wait(s => s.entry === '1');
await shot('01-gate');
await p.fill('#gate_code', '4712'); await p.click('#btn_gate');
await wait(s => s.phase === 'card_c1');
await shot('02-quiz');
for (const c of man.steps[1].cards) { await p.click('#quizopt' + c.correct); await p.waitForTimeout(500); }
await wait(s => s.phase === 'baskets');
for (let i = 0; i < 5; i++) { await p.click('#basket_' + train[i].class); await p.waitForTimeout(60); }
await shot('03-baskets');
for (let i = 5; i < train.length; i++) { await p.click('#basket_' + train[i].class); await p.waitForTimeout(40); }
await p.click('#btn_next');
await wait(s => s.phase === 'train');
await shot('04-train');
await p.click('#btn_train');
await wait(s => s.phase === 'probe');
await p.click('#btn_check'); await p.waitForTimeout(300);
await shot('05-probe-verdict');
for (let i = 0; i < 40 && (await st()).phase === 'probe'; i++) {
  if (await p.$('#btn_check:not([disabled])')) await p.click('#btn_check').catch(() => {});
  else if (await p.$('#btn_next:not([disabled])')) await p.click('#btn_next').catch(() => {});
  await p.waitForTimeout(150);
}
await wait(s => s.phase === 'version_slot1');
await shot('06-version-slot');
await p.click('#frag3'); await wait(s => s.phase === 'version_slot2');
await p.click('#frag1'); await wait(s => s.phase === 'version_free');
await p.click('#btn_skip'); await wait(s => s.phase === 'version_commit');
await shot('07-version-commit');
await p.click('#btn_commit'); await wait(s => s.phase === 'version_choice');
await shot('08-choice');
await p.click('#opt2'); await wait(s => s.phase === 'waiting');
await p.waitForTimeout(400);
await shot('09-waiting-buffer');
await browser.close(); server.kill();
console.log('shots done →', OUT);
