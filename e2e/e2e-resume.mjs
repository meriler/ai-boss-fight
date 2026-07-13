async (page) => {
  // Тест F5-устойчивости: собрать данные R1 → перезагрузить страницу →
  // «Продолжить с места» → датасет восстановлен → дойти до финала.
  const log = [];
  const ok = (name, cond) => log.push((cond ? 'PASS ' : 'FAIL ') + name);
  const vis = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel);
  const waitVis = (sel, t = 30000) => page.waitForFunction((s) => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel, { timeout: t });
  const waitStep = (sub, t = 90000) => page.waitForFunction((s) => { const c = document.querySelector('#stepcard'); return c && !c.classList.contains('hidden') && document.querySelector('#scTitle').textContent.includes(s); }, sub, { timeout: t });
  const demo = (d) => page.evaluate((x) => { window.__demo = x; }, d);
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

  try {
    await page.goto('http://localhost:8642/v5.html?demo=1&ws=1&seat=97');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    ok('чистый старт: кнопки resume НЕТ', !(await vis('#resume')));
    await page.click('#start');

    // Сбор R1
    await waitStep('Научим ИИ ладони');
    await demo({ cls: 0, size: 1.0, present: true });
    await page.click('#scGo');
    await waitStep('6 ладоней собрано');
    await page.click('#scGo');
    await waitStep('Теперь кулаки');
    await demo({ cls: 1, size: 0.3, present: true });
    await page.click('#scGo');
    await waitStep('ИИ обучен');
    const saved = await page.evaluate(() => { const s = localStorage.getItem('ws_save_97'); return s ? JSON.parse(s).ms : null; });
    ok('после сбора R1 сейв записан (ms=' + saved + ')', saved === 'r1');

    // === F5 ===
    await page.reload();
    await waitVis('#intro');
    ok('после F5: кнопка «Продолжить» видна', await vis('#resume'));
    await page.click('#resume');
    await page.waitForFunction(() => { const c = document.querySelector('#stepcard'); return c && !c.classList.contains('hidden') && document.querySelector('#scTitle').textContent.includes('возвращением'); }, null, { timeout: 90000 });
    const restored = await page.evaluate(() => ({ n: (window.KNN ? -1 : 0) }));
    const cnt = await page.evaluate(() => document.querySelector('#scText').textContent);
    ok('восстановление: карточка «С возвращением» (' + cnt.slice(0, 40) + '…)', cnt.includes('целы'));

    // Проверка R1 заново → гипотеза → финал (сокращённо)
    await page.click('#scGo');
    await doCard({ cls: 0, size: 1.0, present: true }); await page.click('#ckNext');
    await doCard({ cls: 1, size: 0.3, present: true }); await page.click('#ckNext');
    await doCard({ cls: 0, size: 0.3, present: true }); await page.click('#ckNext');
    await waitVis('#hypo');
    ok('после восстановления путь продолжается (гипотеза)', true);
    await page.fill('#hypotext', 'размер'); await page.click('#hypoNext');
    await waitVis('#guess');
    await page.locator('#guessbtns .choice', { hasText: 'размер' }).click();
    await waitVis('#lock');
    await page.fill('#lockcode', '4712'); await page.click('#lockNext');
    await waitVis('#reveal');
    const ms2 = await page.evaluate(() => JSON.parse(localStorage.getItem('ws_save_97')).ms);
    ok('веха после разгадки: ' + ms2, ms2 === 'revealed');

    // === F5 на разгадке ===
    await page.reload();
    await waitVis('#intro');
    await page.click('#resume');
    await waitVis('#reveal', 90000);
    ok('F5 на разгадке → resume приводит на разгадку', true);
    const nThumbs = await page.evaluate(() => document.querySelectorAll('#gal canvas').length);
    ok('галерея после восстановления живая (' + nThumbs + ' примеров)', nThumbs === 12);
    return log.join('\n');
  } catch (e) {
    return log.join('\n') + '\nEXCEPTION: ' + e.message;
  }
}
