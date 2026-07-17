#!/usr/bin/env bash
# Деплой СЕРВЕРНОГО контура занятия (tele.py + lesson_state + SQLite-тень M1) на Aeza
# (/opt/ws-tele, systemd ws-tele, 127.0.0.1:8236). Клиентскую статику НЕ трогает —
# она едет отдельно через ./deploy-ws.sh.
#
# M0 из ТЗ-платформа-v3 §4.2 — ворота каждого шага миграции:
#   1) локальные тесты серверного контура (контракт §4.1 + тень M1) — зелёные или стоп;
#   2) проверка «сервис не занят» (свежие мутации файлов занятия/телеметрии);
#   3) pre-deploy tar data-dir (/var/backups/ws-tele, ретенция 14);
#   4) выкладка + restart + смоук (/dash отвечает, тень создана, parity чист).
#
# Использование: ./deploy-server.sh            (обычный путь)
#                ./deploy-server.sh --force    (пропустить проверку занятости — осознанно!)
set -e
cd "$(dirname "$0")"
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1

echo "── ворота M0: тесты серверного контура ──"
python3 -m unittest discover -s server -q 2>&1 | tail -2

echo "── проверка занятости (мутации файлов занятия/телеметрии за последние 15 мин) ──"
BUSY=$(ssh aeza 'find /var/lib/ws-tele -maxdepth 1 \( -name "lesson-*.json" -o -name "*.jsonl" \) -mmin -15 2>/dev/null | head -5')
if [ -n "$BUSY" ] && [ "$FORCE" != 1 ]; then
  echo "⛔ Похоже, сервис ЗАНЯТ — эти файлы менялись меньше 15 минут назад:"
  echo "$BUSY"
  echo "   Рестарт посреди занятия запрещён. Уверен, что никого нет → ./deploy-server.sh --force"
  exit 1
fi

echo "── pre-deploy tar data-dir (M0) ──"
ssh aeza 'mkdir -p /var/backups/ws-tele &&
  tar -czf /var/backups/ws-tele/pre-deploy-$(date +%Y%m%d-%H%M%S).tar.gz -C /var/lib ws-tele &&
  ls -t /var/backups/ws-tele | tail -n +15 | while read f; do rm -f "/var/backups/ws-tele/$f"; done &&
  ls -t /var/backups/ws-tele | head -3'

echo "── env-флаг тени M1 (drop-in LESSON_DB=1; откат = удалить drop-in) ──"
ssh aeza 'mkdir -p /etc/systemd/system/ws-tele.service.d &&
  printf "[Service]\nEnvironment=LESSON_DB=1\n" > /etc/systemd/system/ws-tele.service.d/lesson-db.conf &&
  systemctl daemon-reload'

echo "── выкладка server/ ──"
scp -q server/tele.py server/telemetry_model.py server/lesson_state.py server/lesson_db.py \
    server/check_db_parity.py server/dash_lesson.py server/rubric.py aeza:/opt/ws-tele/
ssh aeza 'systemctl restart ws-tele'
sleep 2

echo "── смоук ──"
CODE=$(ssh aeza 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8236/dash')
[ "$CODE" = 200 ] && echo "✓ /dash отвечает 200" || { echo "⛔ /dash: $CODE"; ssh aeza 'journalctl -u ws-tele -n 20 --no-pager'; exit 1; }
ssh aeza 'test -s /var/lib/ws-tele/lesson.db' && echo "✓ тень создана (/var/lib/ws-tele/lesson.db)" || { echo "⛔ lesson.db не появился"; exit 1; }
ssh aeza 'cd /opt/ws-tele && python3 check_db_parity.py /var/lib/ws-tele'
echo "✅ серверный контур выкачен, тень M1 активна ($(date +%H:%M:%S))"
