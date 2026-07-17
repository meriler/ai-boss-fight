# app/ — модульный клиент фазы 0 (вариант Б-лайт: vanilla ES-модули, без сборки)

Спека: vault `itmo/ai-school/01-воркшоп/ТЗ-демка-з1.md` (§0 развилка, §1.1 движок,
§4.1 сетевой контракт). v5.html НЕ трогается — рабочий артефакт воркшопа, страховка отката.

## core/ — ядро (чистые модули, работают и в браузере, и в Node — CI гоняет их же)

- `manifest.js` — загрузка + нормализация манифеста: у каждого шага появляются `phases[]`
  (сахар одного такта и типовые формулы разворачиваются), `limitCount` на такт.
- `machine.js` — машина состояний из манифеста. Переход ШАГА/гейта — acked по построению
  (машина возвращает требование `{ack: gate_enter|step_enter}`, advance — после ack);
  переход такта — локальный (`phase_enter` в журнал).
- `reducer.js` — ЕДИНЫЙ редьюсер журнала (14 типов, словарь закрыт): живое применение
  и replay при restore — одна функция.
- `journal.js` — локальный буфер-журнал: монотонный rev, persist в localStorage,
  стартовый rev нового инстанса = max(server_rev, local_rev)+1.
- `save.js` — seat-save (дебаунс ~1 с) + restore: серверная склейка (`/restore`) +
  replay журнала; takeover «Продолжить здесь» (generation+1, буфер с нуля).
- `acked.js` — транспорт acked-действий (`/commit`): op_id стабилен в ретраях и
  переживает F5 (localStorage-очередь), epoch-гард, статусы «Отправляю…»/«нет связи».
- `poll.js` — поллинг `/sync` ~5 с, курсор — серверный event_seq, стейл-ответы отбрасываются.
- `tele.js` — TELE-перенос из v5.html:483–536 (контракт /tele не менялся): буфер в
  localStorage, досылка, beacon на pagehide.
- `walk.js` — эталонная проходимость: синтетический проход занятия по манифесту
  (identity-agnostic). Используется валидатором в CI и страницей `z1.html?demo=1`.
- `core.test.mjs` — тесты ядра: `node --test 'app/**/*.test.mjs'`.

## engine/ — нода ImageClassifier (§1.1, параметры заморожены пилотом §6)

- `classifier.js` — kNN на комбинированном cos-расстоянии; параметры из `bank.frozen_params`
  (эмбеддер/k/веса/формула уверенности). Два режима: real (MediaPipe ImageEmbedder,
  warmup ФОНОМ — restore ≤3 c) и demo (`?demo=1`: фикс-фичи из метаданных банка bg/class/id,
  без wasm — детерминизм e2e; веса направлений считаны, не подобраны — см. шапку файла).
- `classifier.test.mjs` — драматургия занятия на ОБОИХ банках: флипы R1 уверенные (≥75),
  R2 чинится ловушками, детерминизм.

## screens/ — детские экраны (§2, компоненты 1–10)

- `app.js` — оркестратор: boot → restore → машина; acked-вход в шаги/гейты, клампинг
  «не перепоказывать сделанное», single-writer (instanceId в sessionStorage, takeover),
  догоняющий (catchup), сброс версии ведущим, резервный блок.
- `phases.js` — рендерер тактов по elements[] манифеста (identity-agnostic): корзины
  (drag + tap), подача по одной, версия-конструктор, капча, прогноз, финал-карточка.
  Три зоны коробки «вход → обучение → выход» видимы во всех режимах (правило 9).
- `overlays.js` — «Застрял» (подсказки l1/l2/l3-restore, вне лимита ≤5), буфер «предскажи»,
  кнопка-реакция, чат, статус-пилюля, модалки. Видимость — по overlays[] такта.
- `dom.js`, `style.css` — виджеты и клейморфизм-стили (узкая колонка ≤640, touch ≥44 px).

## Страницы

- `/z1.html` — ДЕТСКИЙ КЛИЕНТ: `?ws=1&seat=N` (+`&demo=1` — фикс-эмбеддинги,
  `&variant=_test-variant` — тестовый манифест, критерий фазы 0).
- `/z1-core.html` — харнесс ядра без экранов (проходимость+restore-раунд в браузере).

## Сервер

`server/lesson_state.py` — stateful-контур §4.1 (save/restore/commit/sync/chat/react/host),
маршрутизация в `server/tele.py` (контракты /tele, /dash, sess_start/stop не тронуты);
`server/dash_lesson.py` — панель занятия §5 на /dash (аддитивно). Локальный запуск для
e2e: env `WS_TELE_DIR` + `WS_TELE_PORT` + `WS_STATIC_DIR` (раздаёт статику — одна origin).
Тесты: `python3 -m unittest discover -s server`. Деплой: scp tele.py+telemetry_model.py+
lesson_state.py+dash_lesson.py на aeza:/opt/ws-tele/ + restart ws-tele (docstring tele.py).

## E2E

`e2e/e2e-z1.mjs` — e2e-must ТЗ §9 (самодостаточный: сам спавнит сервер): полный tap-проход
до artifact_saved, reveal-lock на 2 клиентах + дашборд (замок/override/лог), 3 F5-точки
с restore ≤3 c без перепоказа, DOM-чеки конституции на каждом экране, полный проход
тест-варианта ТЕМ ЖЕ кодом. `e2e/shots-z1.mjs <outdir>` — скриншоты ключевых экранов.
