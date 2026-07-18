#!/usr/bin/env bash
# Локальный прогон того же набора, что content-ci (GitHub Actions): валидатор обоих
# манифестов + эталонная проходимость + тесты ядра + тесты сервера + e2e занятия З1
# В ОБОИХ РЕЖИМАХ ДВИЖКА (kNN и ENGINE=head — Codex-ревью 18.07, находка 7).
# Гонять перед пушем и при любой правке content/.
set -euo pipefail   # pipefail: провал в пайпе с tail не должен маскироваться
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
echo "── e2e занятия З1 — движок kNN (дефолт занятия) ──"
(cd e2e && node e2e-z1.mjs | tail -1)
echo "── e2e занятия З1 — движок head (та же матрица за флагом ?engine=) ──"
(cd e2e && ENGINE=head node e2e-z1.mjs | tail -1)
echo "✅ CI-набор зелёный"
