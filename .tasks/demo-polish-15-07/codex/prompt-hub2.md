Пятый круг. Хаб-навигация РЕАЛИЗОВАНА в v5 по твоему урезанному плану (out-hub.md, MoSCoW Must + editable-альбом из Should с персистом). Проверь реализацию против собственных находок.

Файлы: `v5_diff_hub.txt` — полный дифф v4(прогон)→v5 текущий (хаб — последняя треть диффа, ищи NAV/navToHub/navResumeLesson/navZones/delExample/buildGallery editable/startCheck endless); `../../../v5.html` — актуальный файл.

Как реализовано (сверь с кодом):
1. NAV.lesson — якорь: снимается в navToHub() ТОЛЬКО если navInLesson() (gteach/gcheck/уроч-stepcard/уроч-экран); stepcard-снимок хранит содержимое+onclick (переигрывание без семантических функций); зоны якорь не трогают. enterLab-онбординг помечен zone:true.
2. navHideAll() прячет всё вручную (screens, stepcard, guide, checkui, labgal, bottom, topEl, bigmsg, ckcount3), camfix не трогает.
3. Уход из gcheck в count/hold запрещён тостом; из game нав нет; stopCollect() на входе в базу; gteach: gateMs/stuckMs=0 на уходе И возврате.
4. Замки: album = revealSeen || (finalSeen&&unlocked/!WS); shoot/prize = finalSeen&&(unlocked||!WS); range = то же + KNN.ex.length>0. При lesson.kind==='gcheck' зоны shoot/range дают отказ (CHK один).
5. Полигон: startCheck → 2 фикс-карточки (big palm, small fist) + navRandCard() бесконечно; ckExit='Хватит — к итогу' → finishCheck (если есть результаты) → showResult + кнопка «На базу» (NAV.rangeFromHub). ckExit блокирован в count/hold.
6. Альбом: buildGallery(gal,allRounds,editable) — editable только с allRounds (индексы!), только albumEditable()=finalSeen&&(unlocked||!WS); delExample атомарный (поиск n-го класса в KNN.ex, splice обоих, counts пересчёт, predCache/smooth сброс, certFrame перевыбор, sample_del, debounce 1.2с saveMilestone('final')); ✕ двухтаповый (arm 2с).
7. cert-гарды на null certFrame (fCert/gCert); reset обнуляет certFrame.
8. navRender: сигнатура-кэш (перерисовка только при смене состояния), синхронный вызов из showScreen, интервал-ватчер 700мс; body.navon → padding-bottom экранов (панель не перехватывает клики — ловили на e2e).
9. Пробел: labgal → hub(▶урок) → checkui → stepcard → …
E2e: 111 PASS (все старые без правок + e2e-hub 17: пауза сбора/возврат, замки до этапов, read-only альбом после разгадки, полигон 2+рандом+итог, удаление карточки+персист после F5).

Вопросы (сжато, по коду):
1. Твои 12 пунктов «где план ломает v5» — какие остались незакрытыми в реализации? Особо: п.9 (повторные вызовы семантических функций при возврате — проверь navResumeLesson и плитку prize→goFinal: goFinal повторно пушит final_summary/final — это существующее поведение gFinal, приемлемо?), п.7 (полунабранные таймеры), п.2/3 (stepCard/CHK конфликты).
2. Новые дыры самого хаба: state='hub' и все места, которые свитчатся по state; F5 на базе (resumeFlow вернёт в веху — ок?); телеметрия stage не отравлена?
3. delExample: найди рассинхрон, который я пропустил (t2a/t2b got-точки? сейв guided-датасета? THUMBS round-фильтры?).
4. Вердикт: SHIP хаба к занятию / что чинить немедленно / что в утренний смок.
