// UI-МАТРИЦА хаб-навигации (14.07): систематическая проверка панели #wsnav, замков зон,
// возвратов «Урок», альбома из разных входов, полигона, пробела, тупиков. Аудит — файл v5.html НЕ меняем.
async (page) => {
  const log = [];
  const ok = (name, cond) => log.push((cond ? 'PASS ' : 'FAIL ') + name);
  const vis = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel);
  const waitVis = (sel, t = 30000) => page.waitForFunction((s) => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel, { timeout: t });
  const waitStep = (sub, t = 60000) => page.waitForFunction((s) => { const c = document.querySelector('#stepcard'); return c && !c.classList.contains('hidden') && document.querySelector('#scTitle').textContent.includes(s); }, sub, { timeout: t });
  const demo = (d) => page.evaluate((x) => { window.__demo = x; }, d);
  const nav = (id) => page.evaluate((z) => { document.querySelector(`#wsnav button[data-nav="${z}"]`)?.click(); }, id);
  const dots = () => page.evaluate(() => document.querySelectorAll('#gdots i.on').length);
  const toast = () => page.evaluate(() => { const t = document.querySelector('#toast'); return t && t.style.opacity === '1' ? t.textContent : ''; });
  const navVisible = () => vis('#wsnav');
  // панель #wsnav переключается ватчером раз в 700мс — ждём «оседания» до ~1.6с, а не мгновенного кадра
  const waitNav = (want, t = 1800) => page.waitForFunction((w) => { const e = document.querySelector('#wsnav'); return (!!e && !e.classList.contains('hidden')) === w; }, want, { timeout: t }).then(() => true).catch(() => false);
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
    await page.goto('http://localhost:8642/v5.html?demo=1&ws=1&seat=91');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.click('#start');
    await waitStep('Научим ИИ ладони', 90000);
    await waitVis('#wsnav', 5000);
    ok('панель видна на карточке урока (стартовая)', await navVisible());

    // === БЛОК 1: замки зон на карточке урока (клик по запертой зоне = тост, экран не ломается) ===
    await nav('album');
    await page.waitForTimeout(300);
    ok('запертый альбом с карточки: тост «замок», карточка урока цела', /🔒/.test(await toast()) && await vis('#stepcard') && !(await vis('#hub')));
    await nav('shoot');
    await page.waitForTimeout(300);
    ok('запертая съёмка с карточки: тост, карточка цела', /🔒/.test(await toast()) && await vis('#stepcard'));

    // === БЛОК 2: пауза урока из сбора, замки на хабе, возврат «Урок», рост точек ===
    await demo({ cls: 0, size: 1.0, present: true });
    await page.click('#scGo');
    await page.waitForFunction(() => document.querySelectorAll('#gdots i.on').length >= 2, null, { timeout: 30000 });
    ok('панель видна во время сбора (gteach)', await navVisible());
    await nav('hub'); await waitVis('#hub');
    ok('из сбора ушли на базу', true);
    const dotsAtPause = await dots();
    await page.waitForTimeout(2500);
    ok('на базе сбор стоит (точки не растут)', (await dots()) === dotsAtPause);
    // замки с хаба
    await nav('album');
    ok('альбом до разгадки заперт (остались на базе, тост)', await vis('#hub') && !(await vis('#labgal')) && /🔒/.test(await toast()));
    await nav('shoot');
    ok('съёмка до финала заперта (тост, на базе)', await vis('#hub') && /🔒/.test(await toast()));
    await nav('range');
    ok('полигон до финала заперт (на базе)', await vis('#hub'));
    await nav('prize');
    ok('награды до финала заперты (на базе)', await vis('#hub'));
    // исследовательский: двойной клик по панели не ломает
    await nav('hub'); await nav('hub'); await page.waitForTimeout(200);
    ok('двойной клик hub не сломал базу', await vis('#hub'));
    await nav('lesson');
    await page.waitForFunction(() => document.querySelectorAll('#gdots i.on').length >= 6, null, { timeout: 40000 });
    ok('«Урок» вернул в сбор — точки дорастают до 6', true);

    // === БЛОК 3: продвижение до gcheck + проверка замера (панель прячется/отказывает, замер не рвётся) ===
    await waitStep('6 ладоней собрано'); await page.click('#scGo');
    await waitStep('Теперь кулаки'); await demo({ cls: 1, size: 0.3, present: true }); await page.click('#scGo');
    await waitStep('ИИ обучен'); await page.click('#scGo');
    await page.waitForFunction(() => !document.querySelector('#ckShot').classList.contains('hidden'), null, { timeout: 30000 });
    ok('панель видна в проверке (gcheck, фаза ready)', await navVisible());
    // ручной замер карточки 1 + попытка ухода в хаб во время замера (чисто через UI: v5 — ES-модуль,
    // внутренние функции недоступны из evaluate). Клик ЗАМЕРИТЬ → замер идёт; панель прячется ватчером;
    // клик по кнопке hub панели во время замера → guard отказывает (тост «идёт замер»), замер целый.
    await demo({ cls: 0, size: 1.0, present: true });
    await page.waitForFunction(() => !document.querySelector('#ckShot').classList.contains('hidden'), null, { timeout: 30000 });
    await page.waitForTimeout(400);
    await page.click('#ckShot');   // старт замера (COUNT_STEP=700, отсчёт 2→1 → hold — суммарно >2с)
    const hidDuring = await waitNav(false, 1500);
    ok('панель прячется во время замера (count/hold)', hidDuring);
    const guard = await page.evaluate(() => { document.querySelector('#wsnav button[data-nav="hub"]')?.click();   // жмём hub даже если панель уже скрыта
      const t = document.querySelector('#toast'); return { hub: !document.querySelector('#hub').classList.contains('hidden'), ck: !document.querySelector('#checkui').classList.contains('hidden'), toast: t.style.opacity === '1' ? t.textContent : '' }; });
    ok('во время замера уход в хаб отклонён (остались в проверке, тост «идёт замер»)', !guard.hub && guard.ck && /замер/i.test(guard.toast));
    await page.waitForFunction(() => !document.querySelector('#ckNext').classList.contains('hidden') || !document.querySelector('#ckRetry').classList.contains('hidden'), null, { timeout: 30000 });
    const inv1 = await page.evaluate(() => !document.querySelector('#ckRetry').classList.contains('hidden'));
    ok('замер завершился вердиктом несмотря на отказанный уход', true);
    if (inv1) { await page.click('#ckRetry'); await doCard({ cls: 0, size: 1.0, present: true }); }
    await page.click('#ckNext');
    // карточки 2 и 3 обычным путём
    await doCard({ cls: 1, size: 0.3, present: true }); await page.click('#ckNext');
    await doCard({ cls: 0, size: 0.3, present: true }); await page.click('#ckNext');

    // === БЛОК 4: экраны урока (гипотеза→угадайка→замок→разгадка), панель + возврат «Урок» ===
    await waitVis('#hypo');
    ok('панель видна на экране гипотезы', await navVisible());
    await nav('hub'); await waitVis('#hub');
    await nav('lesson'); await waitVis('#hypo');
    ok('«Урок» вернул РОВНО на гипотезу', await vis('#hypo'));
    await page.fill('#hypotext', 'размер'); await page.click('#hypoNext');
    await waitVis('#guess');
    await page.locator('#guessbtns .choice', { hasText: 'размер' }).click();
    await waitVis('#lock');
    ok('панель видна на экране замка', await navVisible());
    await page.fill('#lockcode', '4712'); await page.click('#lockNext');
    await waitVis('#reveal');
    ok('панель видна на разгадке', await navVisible());

    // === БЛОК 5: альбом после разгадки (read-only), возврат из оверлея на разгадку ===
    await nav('hub'); await waitVis('#hub');
    await nav('album'); await waitVis('#labgal');
    ok('альбом открылся после разгадки', await vis('#labgal'));
    await page.click('#labgalClose'); await waitVis('#hub');
    ok('закрытие альбома-оверлея вернуло на базу (вход из плитки хаба)', await vis('#hub') && !(await vis('#labgal')));
    await nav('lesson'); await waitVis('#reveal');
    ok('«Урок» вернул на разгадку', await vis('#reveal'));

    // === БЛОК 6: дожать до финала ===
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
    ok('панель видна на финале', await navVisible());

    // === БЛОК 7: опрос — панель скрыта, пробел не работает как «продолжить» ===
    await page.click('#fSurvey');
    await waitVis('#survey');
    ok('панель скрыта в опросе', !(await navVisible()));
    await page.fill('#svtext', '33'); await page.click('#svNext');
    for (let i = 0; i < 3; i++) { await page.fill('#svtext', 'ответ ' + i); await page.click('#svNext'); await page.waitForTimeout(200); }
    await waitVis('#final');

    // === БЛОК 8: пост-финал — все зоны открыты ===
    await nav('hub'); await waitVis('#hub');
    const lockedTiles = await page.evaluate(() => document.querySelectorAll('#hubtiles .tile.locked').length);
    ok('после финала+кода все зоны открыты (0 замков)', lockedTiles === 0);

    // === БЛОК 9: пробел на хабе = «Продолжить урок» → финал (якорь пуст, урок пройден) ===
    await page.keyboard.press('Space');
    await waitVis('#final', 8000);
    ok('пробел на базе → «Продолжить урок» → финал (не мёртвый)', await vis('#final'));

    // === БЛОК 10: альбом из финала (#fAlbum) — оверлей, закрытие возвращает на финал ===
    await page.click('#fAlbum'); await waitVis('#labgal');
    ok('альбом с финала открылся оверлеем', await vis('#labgal') && await vis('#final'));
    // пробел в альбоме = закрыть, не клик сквозь. Уводим фокус с кнопки #fAlbum (иначе Space нативно
    // жмёт её). Даём 700мс «осесть» (стереть недавний общий дебаунс пробела с ckShot).
    await page.waitForTimeout(700);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    const d1 = await page.evaluate(() => ({ labgal: !document.querySelector('#labgal').classList.contains('hidden'), final: !document.querySelector('#final').classList.contains('hidden') }));
    ok('пробел в альбоме (одно нажатие) закрыл оверлей, под ним финал | ' + JSON.stringify(d1), !d1.labgal && d1.final);
    if (d1.labgal) { await page.click('#labgalClose'); await waitVis('#final', 5000); }   // подстраховка для продолжения матрицы

    // === БЛОК 11: съёмка (train) — своя панель, альбом из съёмки, возврат ===
    await nav('hub'); await waitVis('#hub');
    await nav('shoot');
    await page.waitForTimeout(500);
    const onboard = await page.evaluate(() => { const c = document.querySelector('#stepcard'); return c && !c.classList.contains('hidden'); });
    if (onboard) await page.click('#scGo');
    await page.waitForFunction(() => { const b = document.querySelector('#bottom'); return b && !b.classList.contains('hidden'); }, null, { timeout: 10000 });
    const navHidTrain = await waitNav(false);   // ватчер прячет панель в train в течение 700мс
    ok('в съёмке (train) панель #wsnav скрыта, своя bottom видна', navHidTrain && await vis('#bottom'));
    // альбом из съёмки (#toGallery), «Назад» возвращает в съёмку
    await page.click('#toGallery'); await waitVis('#labgal');
    ok('альбом из съёмки открылся', await vis('#labgal'));
    await page.click('#labgalClose');
    await page.waitForFunction(() => { const b = document.querySelector('#bottom'); return b && !b.classList.contains('hidden') && document.querySelector('#labgal').classList.contains('hidden'); }, null, { timeout: 8000 });
    ok('«Назад» из альбома съёмки вернул в съёмку', await vis('#bottom') && !(await vis('#labgal')));

    // === БЛОК 12: из съёмки на базу (#toHub) → «Продолжить урок» → финал (пустой якорь, не тупик) ===
    await page.click('#toHub'); await waitVis('#hub');
    ok('«База» из съёмки вернула на хаб', await vis('#hub'));
    await page.click('#hubGo'); await waitVis('#final', 8000);
    ok('база из съёмки: «Продолжить урок» → финал (не тупик)', await vis('#final'));

    // === БЛОК 13: полигон — панель видна на замерах и итоге, «Хватит» → итог → «На базу» ===
    await nav('hub'); await waitVis('#hub');
    await nav('range');
    await page.waitForFunction(() => !document.querySelector('#checkui').classList.contains('hidden'), null, { timeout: 15000 });
    await page.waitForTimeout(600);
    ok('панель видна на полигоне (между замерами)', await navVisible());
    await doCard({ cls: 0, size: 1.0, present: true }); await page.click('#ckNext');
    ok('панель видна на полигоне после 1-го замера', await waitNav(true));
    await doCard({ cls: 1, size: 0.3, present: true }); await page.click('#ckNext');
    await page.waitForTimeout(300);
    await page.click('#ckExit'); // «Хватит — к итогу»
    await waitVis('#result');
    ok('итог полигона показан, панель видна', await vis('#result') && await navVisible());
    await page.locator('#rsbtns button', { hasText: 'На базу' }).click();
    await waitVis('#hub');
    ok('из итога полигона «На базу» → хаб', await vis('#hub'));

    return log.join('\n');
  } catch (e) {
    log.push('EXCEPTION: ' + e.message);
    try { log.push('screens: ' + await page.evaluate(() => [...document.querySelectorAll('.screen,#stepcard,#checkui,#labgal,#hub')].filter(x => !x.classList.contains('hidden')).map(x => x.id).join(','))); } catch (_) {}
    return log.join('\n');
  }
}
