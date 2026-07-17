#!/usr/bin/env bash
# Локальный прогон того же набора, что content-ci (GitHub Actions): валидатор обоих
# манифестов + эталонная проходимость + тесты ядра + тесты сервера. Гонять перед пушем
# и при любой правке content/.
set -e
cd "$(dirname "$0")"
[ -d content/node_modules ] || (cd content && npm install --no-audit --no-fund)
echo "── валидатор + эталонная проходимость (оба манифеста) ──"
node content/validate.mjs
echo "── тесты клиент-ядра ──"
node --test 'app/**/*.test.mjs'
echo "── калибровка шкалы уверенности (спектр + legacy-порог, фаза 0.5) ──"
node pilot/calibrate_scale.mjs > /dev/null && echo "✓ шкала: чистые 85–95, спорные ≤75, потолок 95, legacy-флипы держатся"
echo "── мини-пилот §6 обучаемой головы (гейт H1, дорожка Б) ──"
node pilot/run_head_pilot.mjs > /dev/null && echo "✓ head: флипы 8/8, лже-странные 0, обычные 8/8, holdout после ловушек 4/4, живость шкалы"
echo "── тесты серверного контура §4.1 ──"
python3 -m unittest discover -s server
echo "✅ CI-набор зелёный"
