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
echo "── тесты серверного контура §4.1 ──"
python3 -m unittest discover -s server
echo "✅ CI-набор зелёный"
