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

## Страница

`/z1.html` — харнесс ядра: `?demo=1` — проходимость+restore-раунд в браузере;
`&variant=_test-variant` — тестовый манифест (критерий фазы 0). Детские экраны —
следующие пункты ТЗ (§7.5–6), сюда доложатся как `app/screens/` поверх ядра.

## Сервер

`server/lesson_state.py` — stateful-контур §4.1 (save/restore/commit/sync/chat/react/host),
маршрутизация в `server/tele.py` (контракты /tele, /dash, sess_start/stop не тронуты).
Тесты: `python3 -m unittest discover -s server`. Деплой: scp tele.py+telemetry_model.py+
lesson_state.py на aeza:/opt/ws-tele/ + restart ws-tele (docstring tele.py).
