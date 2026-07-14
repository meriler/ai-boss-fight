Вердикт: `changes_requested`. Сам каркас хаба нормальный, обычный guided-флоу не сломан. Перед занятием нужны три небольших блока правок. Без них editable-альбом и post-final дообучение могут рассинхронизировать модель.

## 1. Что осталось из прежних 12 пунктов

Закрыты: 1, 2, 4, 5, 6, 7, 8, 10.

- Пункт 2 закрыт: `stepCard` сохраняет DOM и callback, зонный онбординг якорь не перезаписывает.
- Пункт 7 закрыт: `gateMs/stuckMs` сбрасываются, `hub` не входит в `LIVE_STATES`. Старое визуальное сглаживание может прожить несколько кадров, но сбор не продолжает.
- Пункт 3 закрыт частично. `shoot/range` заблокированы при сохранённом `gcheck`, но editable-альбом и `prize` остались доступны в post-final `gteach/gcheck`. Удаление между карточками меняет модель внутри одного `CHK`, а удаление во время `t2a/t2b` не уменьшает `GUIDE.task.got` и точки. [v5.html:1008](/Users/meriler/cc/code/itmo/ai-school-workshop/v5.html:1008), [v5.html:1503](/Users/meriler/cc/code/itmo/ai-school-workshop/v5.html:1503)
- В пункте 9 `navResumeLesson()` сделан правильно: семантические функции при возврате не вызываются. Повторный `goFinal()` из `prize` допустим как телеметрический шум: агрегатор берёт последний `final_summary`. Но сама зона наград способна затереть якорь. После `prize` виден обычный `final`, он входит в `NAV_SCREENS`, и следующий `navToHub()` сохраняет финал вместо незавершённого `gteach/gcheck`. [v5.html:949](/Users/meriler/cc/code/itmo/ai-school-workshop/v5.html:949), [v5.html:1018](/Users/meriler/cc/code/itmo/ai-school-workshop/v5.html:1018), [v5.html:1638](/Users/meriler/cc/code/itmo/ai-school-workshop/v5.html:1638)
- Пункты 11 и 12 не закрыты: stage дашборда немонотонный, fallback R1 всё ещё принимает `round:0` без `guided:true`. [telemetry_model.py:77](/Users/meriler/cc/code/itmo/ai-school-workshop/server/telemetry_model.py:77), [telemetry_model.py:276](/Users/meriler/cc/code/itmo/ai-school-workshop/server/telemetry_model.py:276)

Есть ещё гонка: после нажатия `ckShot` панель скрывается только ближайшим 700-мс ватчером. За это время открытый альбом можно нажать; `navToHub()` откажет из-за `count/hold`, но `navGo()` не проверяет отказ и всё равно продолжит открытие зоны. [v5.html:1014](/Users/meriler/cc/code/itmo/ai-school-workshop/v5.html:1014), [v5.html:1047](/Users/meriler/cc/code/itmo/ai-school-workshop/v5.html:1047), [v5.html:1155](/Users/meriler/cc/code/itmo/ai-school-workshop/v5.html:1155)

## 2. `state='hub'`, F5 и телеметрия

Сам `hub` учтён нормально: классификация и `tickCheck` не работают, Space имеет отдельный приоритет, stage badge показывает «база», камера продолжает контролироваться. Неучтённых циклов по `state` не нашёл.

F5 на базе с возвратом в безопасную веху приемлем. Точный хаб восстанавливать не надо. Оговорки старые:

- кадры незаконченного `t1a` не сохранены до `task_done:t1b`;
- `resumeFlow()` на `final/revealed` повторно пишет соответствующие события;
- после `fixdata` альбом в карточке доступен, но плитка может снова считаться закрытой, потому что `NAV.revealSeen` не восстанавливается.

Дашборд всё ещё отравляется: после `final` свободный `sample` показывает «сбор данных», а `check_done` из полигона показывает «проверка». Это чинить до занятия, если ведущий смотрит на дашборд.

## 3. Что пропущено в удалении

Главный рассинхрон находится не внутри нового `delExample`, а во второй ветке удаления. Кнопка `⌫` в «Съёмке» всё ещё напрямую вызывает `KNN.delLast()` и `THUMBS.pop()`. Она не сбрасывает кэши, не перевыбирает `certFrame` и не сохраняет изменение. [v5.html:2057](/Users/meriler/cc/code/itmo/ai-school-workshop/v5.html:2057)

Ещё четыре дыры:

- post-final добавление через `addExample()` тоже не сохраняется;
- удаление последней карточки не переживёт F5: `saveMilestone()` отказывается сохранять пустой `KNN.ex`, а `loadSave()` не принимает пустой снимок; [v5.html:791](/Users/meriler/cc/code/itmo/ai-school-workshop/v5.html:791)
- `applySave()` не сверяет `counts`, число меток в `KNN.ex` и длины `THUMBS`; [v5.html:822](/Users/meriler/cc/code/itmo/ai-school-workshop/v5.html:822)
- полигон требует лишь один пример, хотя обычная проверка требует по пять каждого класса. После удаления одного класса он остаётся открыт. [v5.html:1004](/Users/meriler/cc/code/itmo/ai-school-workshop/v5.html:1004), [v5.html:1134](/Users/meriler/cc/code/itmo/ai-school-workshop/v5.html:1134)

`allRounds` и индексы в `buildGallery()` сделаны правильно. `certFrame` внутри нового `delExample()` тоже перевыбирается правильно.

## 4. Что делать

До занятия:

1. Пока `NAV.lesson.kind` равен `gteach` или `gcheck`, запретить все мутирующие зоны. `prize` либо тоже блокировать, либо показывать как отдельный zone-view, который не попадает в `NAV_SCREENS`.
2. Сделать `navToHub()` возвращающим успех и прекращать `navGo()` после отказа. При старте `count` синхронно вызывать `navRender(true)`.
3. Провести лабораторный `⌫` через `delExample`, сохранять post-final добавления и удаления, запретить удаление ниже рабочего минимума либо поддержать пустой сейв.
4. Добавить runtime-guard в `startCheck()` и сделать stage дашборда монотонным.

После этих правок: SHIP.

Утренний смок:

- post-final `t2a/t2b` и `gcheck`, затем попытки открыть альбом, съёмку, полигон и награды;
- клик по панели сразу после `ЗАМЕРИТЬ`;
- удаление через альбом и `⌫`, затем немедленный F5;
- удаление всех примеров одного класса и попытка открыть полигон;
- Space по цепочке `labgal`, `hub`, `checkui`, `stepcard`;
- stage после `final`, затем `sample` и свободного `check_done`.

111 проверок арифметически сходятся, но текущий `e2e-hub` не покрывает эти ветки. В этой read-only среде прогон браузера не запускался; синтаксис сценариев проверен.
RC=0
