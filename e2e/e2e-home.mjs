async (page) => {
  const log = [];
  const ok = (name, cond) => log.push((cond ? 'PASS ' : 'FAIL ') + name);
  const vis = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel);
  const waitVis = (sel, t = 30000) => page.waitForFunction((s) => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel, { timeout: t });
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
    return page.evaluate(() => document.querySelector('#ckverdict').textContent);
  };
  try {
    // ===== self-paced (без ?ws): гипотезы и замка НЕТ, выбор починки ЕСТЬ =====
    await page.goto('http://localhost:8642/v4.html?demo=1&debug=1');
    await page.click('#start');
    // seat НЕ должен появиться — сразу интро t1a
    await waitStep('Научим ИИ ладони', 90000);
    ok('дом: без экрана места, сразу урок', !(await vis('#seat')));
    await demo({ cls: 0, size: 1.0, present: true });
    await page.click('#scGo');
    await waitStep('6 ладоней собрано');
    await page.click('#scGo');
    await waitStep('Теперь кулаки');
    await demo({ cls: 1, size: 0.3, present: true });
    await page.click('#scGo');
    await waitStep('ИИ обучен');
    await page.click('#scGo');
    await doCard({ cls: 0, size: 1.0, present: true }); await page.click('#ckNext');
    await doCard({ cls: 1, size: 0.3, present: true }); await page.click('#ckNext');
    const probe = await doCard({ cls: 0, size: 0.3, present: true });
    ok('дом: пробник сломался (' + probe.trim() + ')', !probe.includes('Верно'));
    await page.click('#ckNext'); // «Почему?!»
    await page.waitForTimeout(400);
    ok('дом: БЕЗ гипотезы — сразу варианты', (await vis('#guess')) && !(await vis('#hypo')));
    const nOpts = await page.evaluate(() => document.querySelectorAll('#guessbtns .choice').length);
    ok('дом: 5 вариантов', nOpts === 5);
    await page.locator('#guessbtns .choice', { hasText: 'РАЗМЕР' }).click(); // правильный
    await page.waitForTimeout(300);
    ok('дом: БЕЗ замка — сразу разгадка', (await vis('#reveal')) && !(await vis('#lock')));
    const revTitle = await page.evaluate(() => document.querySelector('#revtitle').textContent);
    ok('дом: правильный выбор → «' + revTitle + '»', revTitle.includes('угадал'));
    await page.click('#fixBtn');
    await waitVis('#fixpick');
    ok('дом: выбор починки есть и дома', true);
    await page.locator('#fixbtns .choice', { hasText: 'переснять' }).click();
    await page.waitForTimeout(500); // дебаунс fixPick
    await page.locator('#fixbtns .choice', { hasText: 'таких же' }).click(); // 2-я ошибка
    const shown = await page.evaluate(() => ({ hint: document.querySelector('#fixhint').textContent, btn: document.querySelector('#fixbtns button') ? document.querySelector('#fixbtns button').textContent : '' }));
    ok('дом: после 2-й ошибки показан правильный ход + кнопка «' + shown.btn + '»', shown.hint.includes('наоборот') && shown.btn.includes('Чинить'));
    await page.click('#fixbtns button');
    await waitStep('Чиним: маленькие ладони');
    ok('дом: после показа — нейтральный интро t2a (не «Точно!»)', true);
    // телеметрия: fix_choice с двумя ошибками. Автосейв троттлится 1.5с — ждём границу
    // и толкаем следующее событие (клик «Начали» → task_start → _save запишет всю ленту)
    await page.waitForTimeout(1700);
    await demo({ cls: 0, size: 0.3, present: true });
    await page.click('#scGo');
    await page.waitForTimeout(400);
    const ev = await page.evaluate(() => {
      const d = Object.keys(localStorage).filter(k => k.startsWith('tele_')).map(k => JSON.parse(localStorage.getItem(k))).sort((a, b) => new Date(b.started) - new Date(a.started))[0];
      return d ? d.events : [];
    });
    const fixes = ev.filter(e => e.type === 'fix_choice');
    ok('дом TELE: fix_choice ×2, оба неверные, hypothesis отсутствует',
      fixes.length === 2 && fixes.every(f => !f.correct) && !ev.some(e => e.type === 'hypothesis') && !ev.some(e => e.type === 'reveal_unlock'));

    // ===== смок лаборатории (регрессия): финал недоступен без урока? Лаборатория из финала — не проверяем полный путь, смок кнопок train =====
    return log.join('\n');
  } catch (e) {
    log.push('EXCEPTION: ' + e.message);
    try { log.push('screens: ' + await page.evaluate(() => [...document.querySelectorAll('.screen,#stepcard,#checkui')].filter(x => !x.classList.contains('hidden')).map(x => x.id).join(','))); } catch (_) {}
    return log.join('\n');
  }
}
