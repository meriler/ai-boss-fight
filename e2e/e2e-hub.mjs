// Хаб-навигация «База» (14.07): пауза/возврат урока, замки зон, полигон, editable-альбом + персист удаления.
async (page) => {
  const log = [];
  const ok = (name, cond) => log.push((cond ? 'PASS ' : 'FAIL ') + name);
  const vis = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel);
  const waitVis = (sel, t = 30000) => page.waitForFunction((s) => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel, { timeout: t });
  const waitStep = (sub, t = 60000) => page.waitForFunction((s) => { const c = document.querySelector('#stepcard'); return c && !c.classList.contains('hidden') && document.querySelector('#scTitle').textContent.includes(s); }, sub, { timeout: t });
  const demo = (d) => page.evaluate((x) => { window.__demo = x; }, d);
  const nav = (id) => page.evaluate((z) => { document.querySelector(`#wsnav button[data-nav="${z}"]`)?.click(); }, id);
  const dots = () => page.evaluate(() => document.querySelectorAll('#gdots i.on').length);
  const doCard = async (d, retries = 3) => {
    await demo(d);
    await page.waitForFunction(() => !document.querySelector('#ckShot').classList.contains('hidden'), null, { timeout: 30000 });
    await page.waitForTimeout(400);
    await page.click('#ckShot');
    await page.waitForFunction(() => !document.querySelector('#ckNext').classList.contains('hidden') || !document.querySelector('#ckRetry').classList.contains('hidden'), null, { timeout: 30000 });
    const invalid = await page.evaluate(() => !document.querySelector('#ckRetry').classList.contains('hidden'));
    if (invalid) { if (retries <= 0) return 'INVALID-STUCK'; await page.click('#ckRetry'); return doCard(d, retries - 1); }
    return page.evaluate(() => document.querySelector('#ckverdict').textContent);
  };

  try {
    await page.goto('http://localhost:8642/v5.html?demo=1&ws=1&seat=94');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.click('#start');
    await waitStep('Научим ИИ ладони', 90000);
    await waitVis('#wsnav', 5000);   // панель поднимает интервал-ватчер (700мс)
    ok('нав-панель видна на карточке урока', true);

    // ---- пауза урока из сбора и возврат ----
    await demo({ cls: 0, size: 1.0, present: true });
    await page.click('#scGo'); // сбор t1a пошёл
    await page.waitForFunction(() => document.querySelectorAll('#gdots i.on').length >= 2, null, { timeout: 30000 });
    await nav('hub');
    await waitVis('#hub');
    ok('из сбора ушли на базу (хаб виден)', true);
    const dotsAtPause = await dots();
    await page.waitForTimeout(2500); // на базе сбор НЕ идёт
    ok('на базе сбор стоит (точки не растут)', (await dots()) === dotsAtPause);
    // замки до разгадки
    await nav('album');
    ok('альбом до разгадки заперт (остались на базе)', await vis('#hub') && !(await vis('#labgal')));
    await nav('shoot');
    ok('съёмка до финала заперта', await vis('#hub'));
    await nav('lesson');
    await page.waitForFunction(() => document.querySelectorAll('#gdots i.on').length >= 6, null, { timeout: 40000 });
    ok('«Урок» вернул в сбор — точки дорастают до 6', true);

    // ---- дожать урок до разгадки ----
    await waitStep('6 ладоней собрано'); await page.click('#scGo');
    await waitStep('Теперь кулаки'); await demo({ cls: 1, size: 0.3, present: true }); await page.click('#scGo');
    await waitStep('ИИ обучен'); await page.click('#scGo');
    await doCard({ cls: 0, size: 1.0, present: true }); await page.click('#ckNext');
    await doCard({ cls: 1, size: 0.3, present: true }); await page.click('#ckNext');
    await doCard({ cls: 0, size: 0.3, present: true }); await page.click('#ckNext');
    await waitVis('#hypo');
    await page.fill('#hypotext', 'размер'); await page.click('#hypoNext');
    await waitVis('#guess');
    await page.locator('#guessbtns .choice', { hasText: 'размер' }).click();
    await waitVis('#lock');
    await page.fill('#lockcode', '4712'); await page.click('#lockNext');
    await waitVis('#reveal');

    // ---- альбом открылся после разгадки (read-only) ----
    await nav('hub'); await waitVis('#hub');
    await nav('album'); await waitVis('#labgal');
    const nDel = await page.evaluate(() => document.querySelectorAll('#labgalrows .crd-del').length);
    ok('альбом после разгадки открыт, но read-only (✕ нет)', nDel === 0);
    await page.click('#labgalClose');
    await nav('lesson');
    ok('«Урок» вернул на разгадку', await vis('#reveal'));

    // ---- дожать до финала + опрос ----
    await page.click('#fixBtn');
    await waitVis('#fixpick');
    await page.locator('#fixbtns .choice', { hasText: 'Наоборот' }).click();
    await waitStep('Маленькие ладони'); await demo({ cls: 0, size: 0.3, present: true }); await page.click('#scGo');
    await waitStep('большие кулаки'); await demo({ cls: 1, size: 1.0, present: true }); await page.click('#scGo');
    await waitStep('Починка готова'); await page.click('#scGo');
    await doCard({ cls: 0, size: 1.0, present: true }); await page.click('#ckNext');
    await doCard({ cls: 1, size: 0.3, present: true }); await page.click('#ckNext');
    await doCard({ cls: 0, size: 0.3, present: true }); await page.click('#ckNext');
    await doCard({ cls: 1, size: 1.0, present: true }); await page.click('#ckNext');
    await waitVis('#final');
    await page.click('#fSurvey');
    await waitVis('#survey');
    ok('нав-панель скрыта в опросе', !(await vis('#wsnav')));
    await page.fill('#svtext', '33'); await page.click('#svNext');
    for (let i = 0; i < 3; i++) { await page.fill('#svtext', 'ответ ' + i); await page.click('#svNext'); await page.waitForTimeout(200); }
    await waitVis('#final');

    // ---- зоны открыты после финала+кода ----
    await nav('hub'); await waitVis('#hub');
    const lockedTiles = await page.evaluate(() => document.querySelectorAll('#hubtiles .tile.locked').length);
    ok('после финала+кода все зоны открыты', lockedTiles === 0);

    // ---- полигон: 2 «как учили» + рандом + итог ----
    await nav('range');
    await page.waitForFunction(() => !document.querySelector('#checkui').classList.contains('hidden'), null, { timeout: 15000 });
    await page.waitForTimeout(600);   // cktarget перерисовывается следующим кадром rAF
    const t1 = await page.evaluate(() => document.querySelector('#cktarget').textContent);
    ok('полигон задание 1 — ладонь БОЛЬШАЯ (как учили): ' + t1, /ладонь/i.test(t1) && /БОЛЬШАЯ/.test(t1));
    await doCard({ cls: 0, size: 1.0, present: true }); await page.click('#ckNext');
    await page.waitForTimeout(400);
    const t2 = await page.evaluate(() => document.querySelector('#cktarget').textContent);
    ok('полигон задание 2 — кулак маленький (как учили): ' + t2, /кулак/i.test(t2) && /маленький/i.test(t2));
    await doCard({ cls: 1, size: 0.3, present: true }); await page.click('#ckNext');
    await page.waitForTimeout(400);
    const t3 = await page.evaluate(() => document.querySelector('#cktarget').textContent);
    ok('полигон задание 3 существует (рандом, без лимита): ' + t3, t3.length > 3);
    await page.click('#ckExit'); // «Хватит — к итогу»
    await waitVis('#result');
    ok('итог полигона показан', true);
    await page.locator('#rsbtns button', { hasText: 'На базу' }).click();
    await waitVis('#hub');
    ok('из итога вернулись на базу', true);

    // ---- альбом editable: два тапа ✕ удаляют карточку; персист после F5 ----
    await nav('album'); await waitVis('#labgal');
    const before = await page.evaluate(() => document.querySelectorAll('#labgalrows canvas').length);
    await page.evaluate(() => { const x = document.querySelector('#labgalrows .crd-del'); x.click(); x.click(); });
    await page.waitForTimeout(1600); // дебаунс-персист
    const after = await page.evaluate(() => document.querySelectorAll('#labgalrows canvas').length);
    ok(`альбом: карточка удалена двумя тапами (${before}→${after})`, after === before - 1);
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#resume').classList.contains('hidden'));
    await page.click('#resume');
    await page.waitForFunction(() => !document.querySelector('#final').classList.contains('hidden'), null, { timeout: 90000 });
    const galN = await page.evaluate(() => { document.querySelector('#fAlbum').click();
      return document.querySelectorAll('#labgalrows canvas').length; });
    ok(`удаление пережило F5 (${galN} карточек, не ${before})`, galN === after);

    return log.join('\n');
  } catch (e) {
    log.push('EXCEPTION: ' + e.message);
    try { log.push('screens: ' + await page.evaluate(() => [...document.querySelectorAll('.screen,#stepcard,#checkui')].filter(x => !x.classList.contains('hidden')).map(x => x.id).join(','))); } catch (_) {}
    return log.join('\n');
  }
}
