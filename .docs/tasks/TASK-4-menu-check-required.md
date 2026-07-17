---
task: TASK-4
status: todo
priority: high
wave: 4
depends_on: [TASK-3]
---

# TASK-4: Обязательная проверка меню без выхода

**Статус**: todo
**Приоритет**: high
**Волна**: 4
**Зависит от**: TASK-3

## Описание
«🔍 Проверить» ведёт в обязательную короткую проверку `startGuidedCheck(2, menuRequired)`, где выход `#ckExit` СКРЫТ (иначе существующая optional-ветка по `GUIDE.outcome` даёт выход до замера — C2). Завершение 4 карточек обновляет `res2`, пишет `MENU.best=betterRes(...)`, апгрейдит outcome без деградации (ранг `partial<fixed`: апгрейд можно, даунгрейд нельзя) и ведёт на финал. После проверки menu-цикл закрыт: счётчик наборов сброшен, повторный вход с финала снова доступен. Покрывает мини-ТЗ v1.1 п.4 (проверка обязательна на деле, F3/C2) и п.5 в части `MENU.best` (C3).

## Контекст
### Документация для изучения
- `/Users/meriler/cc/vault/itmo/ai-school/01-воркшоп/дизайн-потренировать-ещё.md` — «Мини-ТЗ v1.1» п.4 (выход из цикла ВСЕГДА через короткую проверку; флаг `menuRequired` прячет `#ckExit`; только завершение 4 карточек ведёт на финал; «тихого» выхода со стухшим счётом не существует), п.5 (`bestRes2 = max(baseline, все menu-проверки)`; outcome не деградирует); капканы **F3** (выход без проверки = стухший счёт/сертификат), **C2** (`startGuidedCheck` при существующем `GUIDE.outcome` показывает `#ckExit` — выход ДО замера), **C3** (один `GUIDE.res2` перезаписывается; без `best` ребёнок с 4/4 добавит данных, получит 2/4 → регресс).

### Файлы для изучения
- `v5.html:1184-1193` — `startGuidedCheck(round)`: строка `:1190` `const optional=round===2&&!!GUIDE.outcome;` и `:1191-1192` — текст/видимость `#ckExit`. Сюда добавить параметр `menuRequired`, при котором `optional=false` (выход скрыт).
- `v5.html:1309-1330` — `finishGuidedCheck(correct,total)`: ветка `round===2` (:1322-1329) — сейчас при `correct>=3||fixTries>=1` ставит `outcome=fixed/partial` и `showFinal()`, иначе инкремент `fixTries` и retry. Для menu-проверки нужна отдельная ветка без retry-цикла: обновить `res2`, `best`, апгрейд outcome, `showFinal`.
- `v5.html:1323` — `GUIDE.res2={correct,total}`; `v5.html:1324` — установка `outcome`.
- `v5.html:922` — `MENU` (`best`, `baseline`, `taps`, `cycleSets` из TASK-3); `betterRes` (TASK-1).
- `v5.html:1653-1698` — `showFinal()`: читает `GUIDE.outcome/res2/res1` (печать лучшего счёта — TASK-5, здесь только корректно обновить состояние перед вызовом).
- `v5.html:2025` — `$('#scExit')` и `:2041` `$('#fMore')` — соседние обработчики выхода (для понимания, где НЕ должно быть «тихого» выхода в menu-проверке).

## Что сделать
### Изменить файлы
- [ ] `v5.html` — `#menuCheck` («🔍 Проверить») из TASK-2/3: обработчик → `startGuidedCheck(2, /*menuRequired*/true)` (доступен только при `cycleSets>=1`).
- [ ] `v5.html` — `startGuidedCheck(round, menuRequired)`: добавить параметр; строку `:1190` заменить на `const optional=round===2&&!!GUIDE.outcome&&!menuRequired;` — при `menuRequired` `#ckExit` скрыт всегда (C2). Запомнить флаг в `CHK` (например `CHK.menuRequired=!!menuRequired`), чтобы `finishGuidedCheck` знал про menu-проверку.
- [ ] `v5.html` — в `finishGuidedCheck` ветке `round===2` (:1322): если `CHK.menuRequired` → отдельная логика БЕЗ fix_retry-цикла:
  - `GUIDE.res2={correct,total}`;
  - `MENU.best=betterRes(MENU.best,{correct,total})` (C3: сохраняем пик);
  - апгрейд outcome без деградации: `newO=correct>=3?'fixed':'partial'`; ранг `{partial:1,fixed:2}`; `if(rank[newO]>rank[GUIDE.outcome])GUIDE.outcome=newO;` (fixed→partial запрещён);
  - закрыть цикл: `MENU.cycleSets=0`, `MENU.pending=false` (флаг незакрытого цикла для автосейва TASK-6), `MENU.lastCheckAt=MENU.taps.length` (маркер для реплики TASK-5 — каноничное имя, согласовано);
  - `showFinal();`
  - обычная (не-menu) ветка round 2 — без изменений (retry-цикл сохраняется).
- [ ] `v5.html` — убедиться, что в menu-проверке нет ни одной кнопки, ведущей на финал мимо завершения 4 карточек (`#ckExit` скрыт; «тихого» выхода нет — F3).
- [ ] `e2e/e2e-menu.mjs` — нарастить сценарий: обязательная проверка, отсутствие выхода, апгрейд/не-деградация outcome.

## TDD-якорь
### Тесты до кода
- [ ] `e2e/e2e-menu.mjs` — `ok('menu-проверка: #ckExit скрыт (нет выхода до замера)', ...)`: после клика «🔍 Проверить» на первом кадре проверки `#ckExit` имеет класс `hidden` (в отличие от свободной проверки лаборатории, где он виден — C2).
- [ ] `e2e/e2e-menu.mjs` — `ok('завершение 4 карточек ведёт на финал', ...)`: пройти 4 карточки menu-проверки через `doCard` (хелпер как в postlesson, кадры по `CHK.cards[idx]`), после 4-й → `#final` видим, `res2` обновлён.
- [ ] `e2e/e2e-menu.mjs` — `ok('outcome не деградирует: fixed остаётся fixed при 2/4', ...)`: вход в меню с `outcome==='fixed'`, набор + menu-проверка, где скормлено 2/4 верных → `page.evaluate(()=>window.__guideOutcome?...)` / читать через доступный debug-хук: `GUIDE.outcome` остался `'fixed'` (не упал в `partial`).
- [ ] `e2e/e2e-menu.mjs` — `ok('outcome апгрейдит partial→fixed при 4/4', ...)`: вход с `outcome==='partial'`, menu-проверка 4/4 → `GUIDE.outcome==='fixed'`.
- [ ] `e2e/e2e-menu.mjs` — `ok('MENU.best держит пик', ...)`: baseline `res2` например `{correct:3,total:4}`, menu-проверка даёт `{correct:2,total:4}` → `window.MENU.best.correct===3` (лучший, не текущий).
- [ ] `e2e/e2e-menu.mjs` — `ok('после проверки повторный вход с финала доступен', ...)`: после возврата на финал `#fMore` снова открывает меню (`MENU.cycleSets===0`, `#menuToFinal` снова видна при 0 наборов нового цикла).
- [ ] Стиль — как `e2e-postlesson.mjs` (`doCard`/`ok`/`waitVis`). Запуск: `python3 -m http.server 8642` + `cd e2e && node run-e2e.mjs e2e-menu.mjs`.

## Acceptance Criteria
- [ ] `startGuidedCheck(2,true)` скрывает `#ckExit` — выхода из menu-проверки нет (C2, F3).
- [ ] Только завершение 4 карточек ведёт на финал; «тихого» выхода со стухшим счётом не существует (F3).
- [ ] После проверки: `res2` обновлён, `MENU.best=betterRes(...)` держит пик, outcome апгрейдится (partial→fixed) но не деградирует (fixed→partial запрещён) (C3, п.4/5).
- [ ] Menu-цикл закрыт после проверки: `cycleSets` сброшен, повторный вход с финала снова доступен.
- [ ] Обычная (не-menu) ветка round 2 в `finishGuidedCheck` не изменилась — fix_retry-цикл базового урока цел.

## Верификация
```bash
cd ~/cc/code/itmo/ai-school-workshop && python3 -m http.server 8642 &
cd e2e && node run-e2e.mjs e2e-menu.mjs        # все PASS
node run-e2e.mjs e2e-postlesson.mjs             # регресс: fix_retry-ветка базового урока — PASS
```

## Технические заметки
- **C2 (техкапкан).** `startGuidedCheck` (:1190) при уже существующем `GUIDE.outcome` (а на входе в меню он всегда есть — fixed/partial) выставляет `optional=true` и показывает `#ckExit` — ребёнок выйдет в финал ДО замера. Флаг `menuRequired` давит эту ветку: `optional=…&&!menuRequired`.
- **C3 (техкапкан).** Один `GUIDE.res2` перезаписывается каждой проверкой, финал и сертификат читают его. Без `MENU.best` ребёнок с 4/4 добавит данных, получит 2/4 → «Почти починил» в заголовке и регресс в сертификате. `best=betterRes(best,res2)` фиксирует пик; печать лучшего — TASK-5.
- **Ранг outcome.** `{partial:1, fixed:2}`. Апгрейд разрешён (`newRank>oldRank`), даунгрейд — нет. `no_break`/`inconclusive` в меню не заходят (eligibility TASK-2), поэтому в ранге не участвуют.
- **Retry-цикл только для базового урока.** Ветка `else{ GUIDE.fixTries++; … }` (:1325-1328) остаётся для НЕ-menu round 2. Menu-проверка финализирует сразу (лимит наборов уже отработал в меню — второго «добора внутри проверки» не нужно).
- **Маркер цикла для TASK-5 (имя зафиксировано).** `MENU.lastCheckAt` — индекс в `MENU.taps` на момент закрытия цикла. Тапы только что закрытого цикла = `MENU.taps.slice(<значение маркера ДО этой проверки>)` — реплика «добавил разного/похожего» в TASK-5 читает именно их. Начальное значение 0 (объявить в TASK-1-объекте не нужно — достаточно `MENU.lastCheckAt??0` при чтении).

## Definition of Done
- [ ] Тесты написаны ДО кода и проходят
- [ ] Код написан и работает
- [ ] Существующие e2e не сломаны
- [ ] Нет новых console-ошибок в demo-прогоне
