# e2e-прогоны демки v4 (без камеры, через ?demo=1)

Проверяют полный флоу v4.html после любой правки — синтетический кадр управляется `window.__demo`.

```bash
cd ai-school-workshop && python3 -m http.server 8642 &   # демка на localhost:8642
cd e2e && npm i playwright-core                            # один раз (браузер берётся из кэша playwright-MCP)
node run-e2e.mjs e2e-ws.mjs     # воркшоп-путь (?ws=1): гипотеза, замок, коды, телеметрия — 33 ассерта
node run-e2e.mjs e2e-home.mjs   # self-paced путь: без гипотезы/замка, выбор починки — 10 ассертов
```

Ожидаемо: все строки PASS. Chromium берётся из `~/Library/Caches/ms-playwright/chromium-1223` (переменная EXE в run-e2e.mjs).
