async (page) => {
  // Снимает скриншоты ключевых экранов v4 (demo-режим) для слайдов-скелета презентации.
  // Путь повторяет e2e-ws.mjs, но вместо проверок — page.screenshot() в assets/slides/.
  const OUT = process.env.HOME + '/cc/code/itmo/ai-school-workshop/assets/slides/';
  const log = [];
  const vis = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel);
  const waitVis = (sel, t = 30000) => page.waitForFunction((s) => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel, { timeout: t });
  const waitStep = (sub, t = 90000) => page.waitForFunction((s) => { const c = document.querySelector('#stepcard'); return c && !c.classList.contains('hidden') && document.querySelector('#scTitle').textContent.includes(s); }, sub, { timeout: t });
  const demo = (d) => page.evaluate((x) => { window.__demo = x; }, d);
  const shot = async (name) => { await page.screenshot({ path: OUT + name + '.png' }); log.push('SHOT ' + name); };

  const doCard = async (d, retries = 3) => {
    await demo(d);
    await page.waitForFunction(() => !document.querySelector('#ckShot').classList.contains('hidden'), null, { timeout: 30000 });
    await page.waitForTimeout(400);
    await page.click('#ckShot');
    await page.waitForFunction(() => !document.querySelector('#ckNext').classList.contains('hidden') || !document.querySelector('#ckRetry').classList.contains('hidden'), null, { timeout: 30000 });
    const invalid = await page.evaluate(() => !document.querySelector('#ckRetry').classList.contains('hidden'));
    if (invalid) { if (retries <= 0) return 'STUCK'; await page.click('#ckRetry'); return doCard(d, retries - 1); }
    return 'ok';
  };

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('http://localhost:8642/v5.html?demo=1&ws=1');
  await shot('scr-01-intro');
  await page.click('#start');
  await waitVis('#seat', 90000);
  await shot('scr-02-seat');
  await page.evaluate(() => { document.querySelectorAll('#seatgrid button')[4].click(); });

  // Сбор ладоней: скрин в момент работы гейта
  await waitStep('Научим ИИ ладони');
  await shot('scr-03-task-intro');
  await demo({ cls: 0, size: 1.0, present: true });
  await page.click('#scGo');
  await page.waitForTimeout(2200);          // середина сбора: рамка+бары живые
  await shot('scr-04-collect-palm');
  await waitStep('6 ладоней собрано');
  await page.click('#scGo');
  await waitStep('Теперь кулаки');
  await demo({ cls: 1, size: 0.3, present: true });
  await page.click('#scGo');
  await page.waitForTimeout(2200);
  await shot('scr-05-collect-fist');
  await waitStep('ИИ обучен');
  await shot('scr-06-trained');
  await page.click('#scGo');

  // Проверка R1
  await demo({ cls: 0, size: 1.0, present: true });
  await page.waitForFunction(() => !document.querySelector('#ckShot').classList.contains('hidden'), null, { timeout: 30000 });
  await page.waitForTimeout(400);
  await shot('scr-07-check');
  await page.click('#ckShot');
  await page.waitForFunction(() => !document.querySelector('#ckNext').classList.contains('hidden') || !document.querySelector('#ckRetry').classList.contains('hidden'), null, { timeout: 30000 });
  await page.click('#ckNext');
  await doCard({ cls: 1, size: 0.3, present: true });
  await page.click('#ckNext');
  await doCard({ cls: 0, size: 0.3, present: true });   // пробник: ладонь издалека — ломается
  await shot('scr-08-probe-fail');
  await page.click('#ckNext');

  // Гипотеза → варианты → замок → разгадка
  await waitVis('#hypo');
  await shot('scr-09-hypo');
  await page.fill('#hypotext', 'он смотрел на размер');
  await page.click('#hypoNext');
  await waitVis('#guess');
  await shot('scr-10-guess');
  await page.locator('#guessbtns .choice', { hasText: 'размер' }).click();
  await waitVis('#lock');
  await shot('scr-11-lock');
  await page.fill('#lockcode', '4712');
  await page.click('#lockNext');
  await waitVis('#reveal');
  await shot('scr-12-reveal');

  // Починка
  await page.click('#fixBtn');
  await waitVis('#fixpick');
  await shot('scr-13-fixpick');
  await page.waitForTimeout(500);
  await page.locator('#fixbtns .choice', { hasText: 'Наоборот' }).click();
  await waitStep('Маленькие ладони');
  await demo({ cls: 0, size: 0.3, present: true });
  await page.click('#scGo');
  await waitStep('большие кулаки', 90000);
  await demo({ cls: 1, size: 1.0, present: true });
  await page.click('#scGo');
  await waitStep('Починка готова');
  await page.click('#scGo');

  // R2: 4 карточки → финал
  const r2 = [
    { cls: 0, size: 1.0, present: true }, { cls: 1, size: 0.3, present: true },
    { cls: 0, size: 0.3, present: true }, { cls: 1, size: 1.0, present: true },
  ];
  for (const d of r2) {
    await doCard(d);
    const next = await page.evaluate(() => document.querySelector('#ckNext').textContent);
    await page.click('#ckNext');
    if (next.includes('итог') || next.includes('Итог')) break;
  }
  await waitVis('#final', 60000);
  await shot('scr-14-final');

  // Опрос по коду 33
  if (await vis('#fSurvey')) {
    await page.click('#fSurvey');
    await waitVis('#survey');
    await shot('scr-15-survey-code');
    await page.fill('#svtext', '33');
    await page.click('#svNext');
    await page.waitForTimeout(300);
    await shot('scr-16-survey-q1');
  }
  return log.join('\n');
}
