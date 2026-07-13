// Скриншоты ключевых экранов v5 (проверка правок demo-polish-15-07). Запуск: node run-e2e.mjs shots-demo.mjs
async (page) => {
  const log = [];
  const OUT = '/private/tmp/claude-501/-Users-meriler-cc-vault/76e257ae-ad97-4cdb-b63f-4a560bc65f29/scratchpad/shots';
  const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); log.push('shot ' + name); };
  const waitStep = (sub, t = 60000) => page.waitForFunction((s) => { const c = document.querySelector('#stepcard'); return c && !c.classList.contains('hidden') && document.querySelector('#scTitle').textContent.includes(s); }, sub, { timeout: t });
  const demo = (d) => page.evaluate((x) => { window.__demo = x; }, d);
  const doCard = async (d, retries = 3) => {
    await demo(d);
    await page.waitForFunction(() => !document.querySelector('#ckShot').classList.contains('hidden'), null, { timeout: 30000 });
    await page.waitForTimeout(400);
    await page.click('#ckShot');
    await page.waitForFunction(() => !document.querySelector('#ckNext').classList.contains('hidden') || !document.querySelector('#ckRetry').classList.contains('hidden'), null, { timeout: 30000 });
    const invalid = await page.evaluate(() => !document.querySelector('#ckRetry').classList.contains('hidden'));
    if (invalid) { if (retries <= 0) return 'INVALID-STUCK'; await page.click('#ckRetry'); return doCard(d, retries - 1); }
    return 'ok';
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://localhost:8642/v5.html?demo=1&ws=1&seat=96');
  await shot('01-intro');
  await page.click('#start');
  await waitStep('Научим ИИ ладони');
  await demo({ cls: 0, size: 1.0, present: true });
  await page.click('#scGo');
  // вспышка-«щёлк»: форсим показ, чтобы проверить вёрстку
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const el = document.querySelector('#shotfx'); el.style.animation = 'none'; el.style.opacity = '0.9'; });
  await shot('02-gteach-flash');
  await page.evaluate(() => { const el = document.querySelector('#shotfx'); el.style.animation = ''; el.style.opacity = ''; });
  await waitStep('6 ладоней собрано');
  await page.click('#scGo');
  await waitStep('Теперь кулаки');
  await demo({ cls: 1, size: 0.3, present: true });
  await page.click('#scGo');
  await waitStep('ИИ обучен');
  await page.click('#scGo');
  await doCard({ cls: 0, size: 1.0, present: true }); await page.click('#ckNext');
  await doCard({ cls: 1, size: 0.3, present: true }); await page.click('#ckNext');
  await doCard({ cls: 0, size: 0.3, present: true });
  await page.click('#ckNext'); // «Почему?!»
  await page.waitForFunction(() => !document.querySelector('#hypo').classList.contains('hidden'));
  await shot('03-hypo');
  await page.fill('#hypotext', 'он смотрит на размер');
  await page.click('#hypoNext');
  await page.waitForFunction(() => !document.querySelector('#guess').classList.contains('hidden'));
  await shot('04-guess-VARIANTS');
  await page.locator('#guessbtns .choice', { hasText: 'размер' }).click();
  await page.waitForFunction(() => !document.querySelector('#lock').classList.contains('hidden'));
  await shot('05-lock');
  await page.fill('#lockcode', '4712');
  await page.click('#lockNext');
  await page.waitForFunction(() => !document.querySelector('#reveal').classList.contains('hidden'));
  await shot('06-reveal');
  await page.click('#fixBtn');
  await page.waitForFunction(() => !document.querySelector('#fixpick').classList.contains('hidden'));
  await shot('07-fixpick');
  await page.locator('#fixbtns .choice', { hasText: 'Наоборот' }).click();
  await waitStep('Маленькие ладони');
  await shot('08-t2a-intro-ALBOM');
  await demo({ cls: 0, size: 0.3, present: true });
  await page.click('#scGo');
  await waitStep('большие кулаки');
  await shot('09-t2b-intro-ALBOM');
  return log.join('\n');
}
