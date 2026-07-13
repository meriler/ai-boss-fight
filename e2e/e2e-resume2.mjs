// Дополнительные resume-сценарии (ревью Codex 14.07, п.13): краевые случаи автосейва.
// Техника: доводим демку до вехи r1 (реальный сейв), затем МУТИРУЕМ сейв в localStorage
// и проверяем, куда приводит «Продолжить с места» / «Поехали».
async (page) => {
  const log = [];
  const ok = (name, cond) => log.push((cond ? 'PASS ' : 'FAIL ') + name);
  const waitStep = (sub, t = 60000) => page.waitForFunction((s) => { const c = document.querySelector('#stepcard'); return c && !c.classList.contains('hidden') && document.querySelector('#scTitle').textContent.includes(s); }, sub, { timeout: t });
  const demo = (d) => page.evaluate((x) => { window.__demo = x; }, d);
  const KEY = 'ws_save_95';
  const getSave = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), KEY);
  const putSave = (s) => page.evaluate(({ k, v }) => localStorage.setItem(k, JSON.stringify(v)), { k: KEY, v: s });

  try {
    // ---- заготовка: реальный сейв вехи r1 ----
    await page.goto('http://localhost:8642/v5.html?demo=1&ws=1&seat=95');
    await page.click('#start');
    await waitStep('Научим ИИ ладони', 90000);
    await demo({ cls: 0, size: 1.0, present: true });
    await page.click('#scGo');
    await waitStep('6 ладоней собрано');
    await page.click('#scGo');
    await waitStep('Теперь кулаки');
    await demo({ cls: 1, size: 0.3, present: true });
    await page.click('#scGo');
    await waitStep('ИИ обучен');
    const base = await getSave();
    ok('заготовка: сейв r1 записан', !!base && base.ms === 'r1' && base.ex.length === 12);

    // ---- 1. «Поехали» поверх старого сейва: первая веха ПЕРЕЗАПИСЫВАЕТ слот (без ранг-защиты) ----
    await putSave({ ...base, ms: 'revealed', g: { ...base.g, guessKey: 'size', guessCat: 'data-right' } });
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#resume').classList.contains('hidden'));
    await page.click('#start'); // сознательный новый старт, НЕ «Продолжить»
    await waitStep('Научим ИИ ладони', 90000);
    await demo({ cls: 0, size: 1.0, present: true });
    await page.click('#scGo');
    await waitStep('6 ладоней собрано');
    await page.click('#scGo');
    await waitStep('Теперь кулаки');
    await demo({ cls: 1, size: 0.3, present: true });
    await page.click('#scGo');
    await waitStep('ИИ обучен');
    const s1 = await getSave();
    ok('fresh-start поверх revealed: веха стала r1, не revealed (нет телепорта на разгадку)', !!s1 && s1.ms === 'r1' && !s1.g.guessCat);

    // ---- 2. fixdata с провальным первым res2 → всегда повтор проверки R2, не ложный финал ----
    await putSave({ ...s1, ms: 'fixdata', g: { ...s1.g, res1: { correct: 2, total: 3 }, res2: { correct: 1, total: 4 }, guessKey: 'size', guessCat: 'data-right', fixChosen: 'self', fixTries: 1 } });
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#resume').classList.contains('hidden'));
    await page.click('#resume');
    await waitStep('С возвращением', 90000);
    const t2 = await page.evaluate(() => document.querySelector('#scText').textContent);
    ok('fixdata+провальный res2: карточка «Проверим починку», НЕ финал «Почти починил»', t2.includes('Проверим починку'));
    const ft = await page.evaluate(() => !document.querySelector('#final').classList.contains('hidden'));
    ok('fixdata+провальный res2: экран финала скрыт', !ft);

    // ---- 3. final/no_break (res2 нет) → сразу финал, без прогона по R1 ----
    await putSave({ ...s1, ms: 'final', g: { ...s1.g, res1: { correct: 3, total: 3 }, res2: null, outcome: 'no_break' } });
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#resume').classList.contains('hidden'));
    await page.click('#resume');
    await page.waitForFunction(() => !document.querySelector('#final').classList.contains('hidden'), null, { timeout: 90000 });
    const title = await page.evaluate(() => document.querySelector('#ftitle').textContent);
    ok('final/no_break: финал сразу («ИИ не обманулся»), не повтор R1', title.includes('не обманулся'));

    // ---- 4. битый сейв (обрезанный base64) → тихий чистый старт, не «❌ Не загрузилось» ----
    const broken = { ...s1, ms: 'revealed' };
    broken.ex = broken.ex.map((x, i) => i === 0 ? { ...x, e: x.e.slice(0, 7) } : x); // 7 б64-символов → 5 байт, не кратно 4
    await putSave(broken);
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#resume').classList.contains('hidden'));
    await page.click('#resume');
    await waitStep('Научим ИИ ладони', 90000);
    ok('битый сейв: чистый старт урока (карточка t1a), без краха boot', true);
    const cleared = await getSave();
    ok('битый сейв: слот очищен', !cleared);

    // ---- 5. протухший ts (будущее время) → сейв игнорируется ----
    await putSave({ ...s1, ts: Date.now() + 8 * 3600e3 });
    await page.reload();
    await page.waitForTimeout(600);
    const rv = await page.evaluate(() => !document.querySelector('#resume').classList.contains('hidden'));
    ok('ts из будущего: кнопки «Продолжить» нет', !rv);

    return log.join('\n');
  } catch (e) {
    log.push('EXCEPTION: ' + e.message);
    try { log.push('screens: ' + await page.evaluate(() => [...document.querySelectorAll('.screen,#stepcard,#checkui')].filter(x => !x.classList.contains('hidden')).map(x => x.id).join(','))); } catch (_) {}
    return log.join('\n');
  }
}
