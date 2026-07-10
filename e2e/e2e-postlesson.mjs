async (page) => {
  const log = [];
  const ok = (name, cond) => log.push((cond ? 'PASS ' : 'FAIL ') + name);
  const vis = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel);
  const waitVis = (sel, t = 30000) => page.waitForFunction((s) => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel, { timeout: t });
  const waitStep = (sub, t = 60000) => page.waitForFunction((s) => { const c = document.querySelector('#stepcard'); return c && !c.classList.contains('hidden') && document.querySelector('#scTitle').textContent.includes(s); }, sub, { timeout: t });
  const demo = (d) => page.evaluate((x) => { window.__demo = x; }, d);
  const tele = () => page.evaluate(() => { // TELE в module scope — читаем автосейв из localStorage
    const d = Object.keys(localStorage).filter(k => k.startsWith('tele_')).map(k => JSON.parse(localStorage.getItem(k))).sort((a, b) => new Date(b.started) - new Date(a.started))[0];
    return d ? d.events : [];
  });

  const doCard = async (d, retries = 3) => {
    await demo(d);
    await page.waitForFunction(() => !document.querySelector('#ckShot').classList.contains('hidden'), null, { timeout: 30000 });
    await page.waitForTimeout(400); // пара тиков classify с новым __demo
    await page.click('#ckShot');
    await page.waitForFunction(() => !document.querySelector('#ckNext').classList.contains('hidden') || !document.querySelector('#ckRetry').classList.contains('hidden'), null, { timeout: 30000 });
    const invalid = await page.evaluate(() => !document.querySelector('#ckRetry').classList.contains('hidden'));
    if (invalid) {
      if (retries <= 0) return 'INVALID-STUCK';
      await page.click('#ckRetry');
      return doCard(d, retries - 1);
    }
    return page.evaluate(() => document.querySelector('#ckverdict').textContent + ' | next:' + document.querySelector('#ckNext').textContent);
  };

  try {
    await page.goto('http://localhost:8642/v4.html?demo=1&ws=1&debug=1');
    await page.click('#start');
    await waitVis('#seat', 90000);
    ok('WS: экран номера места после загрузки', true);
    await page.evaluate(() => { document.querySelectorAll('#seatgrid button')[4].click(); });

    // ---- Раунд 1: сбор ----
    await waitStep('Научим ИИ ладони');
    await demo({ cls: 0, size: 1.0, present: true });
    await page.click('#scGo');
    await waitStep('6 ладоней собрано');
    ok('t1a: 6 больших ладоней собраны гейтом', true);
    await page.click('#scGo'); // «Дальше» → интро t1b
    await waitStep('Теперь кулаки');
    await demo({ cls: 1, size: 0.3, present: true });
    await page.click('#scGo');
    await waitStep('ИИ обучен');
    ok('t1b: 6 маленьких кулаков собраны', true);
    await page.click('#scGo'); // → проверка R1

    // ---- Проверка R1: 2 «как учили» + пробник ----
    const c1 = await doCard({ cls: 0, size: 1.0, present: true });
    ok('R1 карточка 1 (ладонь большая): ' + c1, c1.includes('Верно'));
    await page.click('#ckNext');
    const c2 = await doCard({ cls: 1, size: 0.3, present: true });
    ok('R1 карточка 2 (кулак маленький): ' + c2, c2.includes('Верно'));
    await page.click('#ckNext');
    const c3 = await doCard({ cls: 0, size: 0.3, present: true }); // пробник: ладонь ИЗДАЛЕКА
    ok('R1 пробник сломался (ждём ошибку/метание): ' + c3, !c3.includes('Верно') && c3.includes('Почему'));
    await page.click('#ckNext'); // «Почему?! 🤔»

    // ---- Гипотеза (WS) ----
    await waitVis('#hypo');
    ok('WS: экран гипотезы ДО вариантов', await vis('#hypo') && !(await vis('#guess')));
    await page.click('#hypoNext');
    ok('гипотеза: пустой ввод блокируется', await vis('#hypo'));
    const toastOk = await page.evaluate(() => { const t = document.querySelector('#toast'); return getComputedStyle(t).zIndex === '30' && t.style.opacity === '1' && t.textContent.includes('догадку'); });
    ok('тост виден ПОВЕРХ экрана (z-index 30, показан текст блокировки)', toastOk);
    const masked1 = await page.evaluate(() => document.querySelector('#hypotext').classList.contains('masked'));
    await page.click('#hypoEye');
    const masked2 = await page.evaluate(() => document.querySelector('#hypotext').classList.contains('masked'));
    ok('гипотеза: маскировка по умолчанию, 👁 снимает', masked1 && !masked2);
    await page.fill('#hypotext', 'мне кажется он смотрел на размер руки');
    await page.click('#hypoNext');
    await waitVis('#guess');
    ok('гипотеза: текст принят → экран вариантов', true);

    // ---- Варианты ----
    const nOpts = await page.evaluate(() => document.querySelectorAll('#guessbtns .choice').length);
    ok('угадайка: 5 вариантов (=' + nOpts + ')', nOpts === 5);
    await page.locator('#guessbtns .choice', { hasText: 'Камера' }).click(); // magic-выбор

    // ---- Замок (WS) ----
    await waitVis('#lock');
    ok('WS: замок после выбора, разгадка скрыта', await vis('#lock') && !(await vis('#reveal')));
    await page.fill('#lockcode', '11');
    await page.click('#lockNext');
    ok('замок: неверный код не открывает', await vis('#lock'));
    await page.fill('#lockcode', '22'); await page.click('#lockNext');
    await page.fill('#lockcode', '33'); await page.click('#lockNext'); // код ОПРОСА не подходит к замку
    const throttled = await page.evaluate(() => document.querySelector('#lockNext').disabled);
    ok('замок: троттлинг после 3 неверных (disabled=' + throttled + ')', throttled === true);
    await page.waitForTimeout(1700);
    await page.fill('#lockcode', '4712');
    await page.click('#lockNext');
    await waitVis('#reveal');
    const revTitle = await page.evaluate(() => document.querySelector('#revtitle').textContent);
    ok('замок: 4712 открыл разгадку, реакция по категории magic: «' + revTitle + '»', revTitle.includes('разгадк'));
    const nThumbs = await page.evaluate(() => document.querySelectorAll('#gal canvas').length);
    ok('разгадка: галерея примеров R1 (=' + nThumbs + ')', nThumbs === 12);

    // ---- Выбор починки ----
    await page.click('#fixBtn');
    await waitVis('#fixpick');
    const nFix = await page.evaluate(() => document.querySelectorAll('#fixbtns .choice').length);
    ok('починка: экран выбора, 3 варианта', nFix === 3);
    await page.locator('#fixbtns .choice', { hasText: 'Ещё таких же' }).click();
    ok('починка: неверный выбор → подводка, экран остался', (await vis('#fixpick')) && (await vis('#fixhint')));
    await page.waitForTimeout(500); // дебаунс fixPick 400мс — человек столько думает, тест нет
    await page.locator('#fixbtns .choice', { hasText: 'Наоборот' }).click();
    await waitStep('Маленькие ладони');
    const t2aTitle = await page.evaluate(() => document.querySelector('#scTitle').textContent);
    ok('починка: верный выбор → сразу интро t2a («' + t2aTitle + '»)', true);

    // ---- Починка данными ----
    await demo({ cls: 0, size: 0.3, present: true });
    await page.click('#scGo');
    await waitStep('большие кулаки', 60000);
    await demo({ cls: 1, size: 1.0, present: true });
    await page.click('#scGo');
    await waitStep('Починка готова');
    ok('t2a+t2b: контрпримеры собраны', true);
    await page.click('#scGo'); // → проверка R2

    // ---- Проверка R2 (4 карточки), возможен fix_retry цикл ----
    const r2cards = [
      { cls: 0, size: 1.0, present: true }, { cls: 1, size: 0.3, present: true },
      { cls: 0, size: 0.3, present: true }, { cls: 1, size: 1.0, present: true },
    ];
    for (let round = 0; round < 2; round++) {
      let correct = 0;
      for (let i = 0; i < r2cards.length; i++) {
        const v = await doCard(r2cards[i]);
        if (v.includes('Верно')) correct++;
        log.push('  R2.' + (i + 1) + ': ' + v);
        await page.click('#ckNext');
      }
      ok('R2 прогон ' + (round + 1) + ': верно ' + correct + '/4', correct >= 2);
      await page.waitForTimeout(600);
      const retry = await page.evaluate(() => { const c = document.querySelector('#stepcard'); return c && !c.classList.contains('hidden') && document.querySelector('#scTitle').textContent.includes('путается'); });
      if (!retry) break;
      log.push('  fix_retry: ИИ ещё путается → добор (проверяем ветку заодно)');
      await page.click('#scGo');
      await waitStep('Чиним: маленькие ладони'); // нейтральный титул после restore
      await demo({ cls: 0, size: 0.25, present: true });
      await page.click('#scGo');
      await waitStep('большие кулаки');
      await demo({ cls: 1, size: 1.1, present: true });
      await page.click('#scGo');
      await waitStep('Починка готова');
      await page.click('#scGo');
    }

    // ---- Финал (WS: заперт до опроса) ----
    await waitVis('#final');
    const lockState = await page.evaluate(() => ({
      cert: document.querySelector('#fCert').classList.contains('hidden'),
      survey: !document.querySelector('#fSurvey').classList.contains('hidden'),
      title: document.querySelector('#ftitle').textContent,
    }));
    ok('финал: «' + lockState.title + '», сертификат заперт, кнопка опроса видна', lockState.cert && lockState.survey);

    // ---- Опрос по коду 33 ----
    await page.click('#fSurvey');
    await waitVis('#survey');
    await page.fill('#svtext', '4712'); await page.click('#svNext'); // код ЗАМКА не подходит к опросу
    const stillCode = await page.evaluate(() => document.querySelector('#svstep').textContent.includes('Код'));
    ok('опрос: код замка не открывает опрос', stillCode);
    await page.fill('#svtext', '33'); await page.click('#svNext');
    for (let q = 0; q < 3; q++) {
      await page.fill('#svtext', 'тестовый ответ ' + (q + 1));
      await page.click('#svNext');
      await page.waitForTimeout(200);
    }
    await waitVis('#final');
    const unlocked = await page.evaluate(() => !document.querySelector('#fCert').classList.contains('hidden'));
    ok('опрос пройден → финал разблокирован (сертификат виден)', unlocked);

    // ---- Телеметрия ----
    const ev = await tele();
    const types = ev.map(e => e.type);
    const hyp = ev.filter(e => e.type === 'hypothesis');
    const guesses = ev.filter(e => e.type === 'guess');
    const fixes = ev.filter(e => e.type === 'fix_choice');
    const attempts = ev.filter(e => e.type === 'reveal_attempt');
    ok('TELE: hypothesis один, с текстом', hyp.length === 1 && hyp[0].text.includes('размер'));
    ok('TELE: guess ровно один, choice=camera cat=magic correct=false',
      guesses.length === 1 && guesses[0].choice === 'camera' && guesses[0].cat === 'magic' && guesses[0].correct === false);
    ok('TELE: reveal_attempt ×3 + reveal_unlock', attempts.length === 3 && types.includes('reveal_unlock'));
    ok('TELE: fix_choice attempt1 неверный, attempt2 верный',
      fixes.length === 2 && fixes[0].attempt === 1 && fixes[0].correct === false && fixes[1].attempt === 2 && fixes[1].correct === true);
    ok('TELE: нет кадров/эмбеддингов в событиях', !ev.some(e => 'img' in e || 'emb' in e || 'pix' in e || 'frame' in e));

    // ===== пост-урок (смок-фиксы 10.07): сертификат → лаборатория → проверка-выход → игра → финал =====
    const dlP = page.waitForEvent('download');
    await page.click('#fCert');
    const dl = await dlP;
    await dl.saveAs('/private/tmp/claude-501/-Users-meriler-cc-vault/c4a032ba-16f9-48e7-ac2a-f3ce48efe28d/scratchpad/cert-e2e.png');
    ok('сертификат: файл скачан', true);
    await page.click('#fLab');
    await page.waitForFunction(() => { const c = document.querySelector('#stepcard'); return c && !c.classList.contains('hidden') && document.querySelector('#scTitle').textContent.includes('Лаборатория'); });
    ok('лаборатория: онбординг-карточка при первом входе', true);
    await page.waitForTimeout(400); await page.click('#scGo');
    await page.waitForFunction(() => !document.querySelector('#bottom').classList.contains('hidden'));
    const labUi = await page.evaluate(() => ({ game: !document.querySelector('#toGame').disabled, fin: !document.querySelector('#toFinalRow').classList.contains('hidden') }));
    ok('лаборатория: «Игра» активна, «Финал» виден', labUi.game && labUi.fin);
    const diag = await page.evaluate(() => { const b = document.querySelector('#toCheck'); const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, vp: { w: innerWidth, h: innerHeight }, disabled: b.disabled, topEl: top ? (top.id || top.tagName + '.' + top.className) : 'null', isBtn: top === b }; });
    log.push('  diag toCheck: ' + JSON.stringify(diag));
    try { await page.click('#toCheck', { timeout: 5000 }); }
    catch (e) { log.push('  click failed: ' + e.message.split('\n')[0] + ' → fallback evaluate'); await page.evaluate(() => document.querySelector('#toCheck').click()); }
    await page.waitForFunction(() => !document.querySelector('#ckExit').classList.contains('hidden'));
    await page.click('#ckExit');
    await page.waitForTimeout(300);
    ok('свободная проверка: «← В лабораторию» выходит', await page.evaluate(() => document.querySelector('#checkui').classList.contains('hidden') && !document.querySelector('#bottom').classList.contains('hidden')));
    await page.click('#toGame');
    await page.waitForTimeout(800);
    const gameUi = await page.evaluate(() => ({ btns: !document.querySelector('#gameBtns').classList.contains('hidden'), all: ['gCert','gLab','gFinal','again'].every(id => !!document.querySelector('#'+id)) }));
    ok('игра: панель Ещё раз/Сертификат/Лаборатория/Финал', gameUi.btns && gameUi.all);
    await page.click('#gFinal');
    await page.waitForFunction(() => !document.querySelector('#final').classList.contains('hidden'));
    ok('игра → «Финал» возвращает в хаб', true);
    ok('unlocked персистится (localStorage)', await page.evaluate(() => localStorage.getItem('ws_unlocked') === '1'));
    log.push('события: ' + [...new Set(types)].join(','));
    return log.join('\n');
  } catch (e) {
    log.push('EXCEPTION: ' + e.message);
    try { log.push('screens: ' + await page.evaluate(() => [...document.querySelectorAll('.screen,#stepcard,#checkui')].filter(x => !x.classList.contains('hidden')).map(x => x.id).join(','))); } catch (_) {}
    return log.join('\n');
  }
}
