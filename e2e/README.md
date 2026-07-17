# e2e-прогоны демки v4 (без камеры, через ?demo=1)

Проверяют полный флоу v4.html после любой правки — синтетический кадр управляется `window.__demo`.

```bash
cd ai-school-workshop && python3 -m http.server 8642 &   # демка на localhost:8642
cd e2e && npm i playwright-core                            # один раз (браузер берётся из кэша playwright-MCP)
node run-e2e.mjs e2e-ws.mjs     # воркшоп-путь (?ws=1): гипотеза, замок, коды, телеметрия — 33 ассерта
node run-e2e.mjs e2e-home.mjs   # self-paced путь: без гипотезы/замка, выбор починки — 10 ассертов
```

Ожидаемо: все строки PASS. Chromium берётся из `~/Library/Caches/ms-playwright/chromium-1223` (переменная EXE в run-e2e.mjs).

## e2e-z1 (демка З1, фаза 0)

```bash
cd e2e && node e2e-z1.mjs        # самодостаточный: сам спавнит server/tele.py со статикой
node shots-z1.mjs /tmp           # скриншоты ключевых экранов (визуальная проверка)
```
Покрытие — e2e-must ТЗ-демка-з1 §9: полный tap-проход `?ws=1&seat=N` → artifact_saved;
reveal-lock на 2 клиентах + дашборд (замок до N/N, override с подтверждением и логом);
3 F5-точки (посреди раскладки / «коммит есть, reveal нет» / после R2) с restore ≤3 с
и без перепоказа сделанного; DOM-чеки конституции (≤5 интерактивов, тексты ≤120,
touch ≥44 px) на каждом детском экране; полный проход `_test-variant` ТЕМ ЖЕ кодом (DoD п.2).
