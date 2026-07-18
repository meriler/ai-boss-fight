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
set -euo pipefail   # pipefail обязателен: тесты идут через "| tail", без него провал маскируется (Codex-ревью 18.07, находка 5)
cd "$(dirname "$0")"
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1

echo "── ворота M0: тесты серверного контура ──"
python3 -m unittest discover -s server -q 2>&1 | tail -2

# -- занятость: ДВА сигнала (Codex-ревью 18.07, находка 3) --
#  (а) mtime файлов занятия/телеметрии (мутации, дошедшие до диска);
#  (б) /busy сервиса — last_activity В ПАМЯТИ: /sync поллинга детей файлов не трогает,
#      по одному mtime активные вкладки невидимы. Старый сервис без /busy → 404, сигнал (а) остаётся.
busy_check() {
  local BUSY LA
  BUSY=$(ssh aeza 'find /var/lib/ws-tele -maxdepth 1 \( -name "lesson-*.json" -o -name "*.jsonl" \) -mmin -15 2>/dev/null | head -5')
  if [ -n "$BUSY" ]; then
    echo "⛔ файлы занятия менялись меньше 15 минут назад:"; echo "$BUSY"; return 1
  fi
  LA=$(ssh aeza 'curl -s http://127.0.0.1:8236/busy' | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("no-endpoint"); raise SystemExit
la=d.get("last_activity_s")
print("idle" if la is None or la > 900 else "busy %.0f" % la)' 2>/dev/null || echo 'no-endpoint')
  case "$LA" in
    busy*) echo "⛔ /busy: активность контура занятия ${LA#busy } сек назад (поллинг /sync живых вкладок)"; return 1;;
    no-endpoint) echo "   (/busy недоступен — старый сервис; полагаюсь на mtime-проверку)";;
  esac
  return 0
}

echo "── проверка занятости №1 (mtime файлов + /busy сервиса) ──"
if ! busy_check && [ "$FORCE" != 1 ]; then
  echo "   Рестарт посреди занятия запрещён. Уверен, что никого нет → ./deploy-server.sh --force"
  exit 1
fi

# -- maintenance-пауза: мутации отвечают 503 до снятия флага; закрывает TOCTOU между
#    проверкой занятости и tar (клиенты ретраят сами — offline-паттерн acked.js).
#    trap гарантирует снятие флага при ЛЮБОМ исходе скрипта (иначе сервис заперт навсегда)
echo "── maintenance-пауза приёма мутаций ──"
trap 'ssh aeza "rm -f /var/lib/ws-tele/maintenance.flag" 2>/dev/null' EXIT
ssh aeza 'touch /var/lib/ws-tele/maintenance.flag'

echo "── проверка занятости №2 (после паузы — не проскочила ли мутация в окно TOCTOU) ──"
# 17 c > таймаута обработчика (15 c): даже запрос, начавший читать тело ДО флага,
# к началу tar гарантированно завершился или умер по таймауту (закалка 18.07, critical 4;
# на новом коде флаг проверяется после чтения тела, но деплой обязан быть безопасен
# и поверх СТАРОГО кода, который ещё крутится в момент выкладки)
sleep 17
if ! busy_check && [ "$FORCE" != 1 ]; then
  echo "⛔ В окно между проверкой и паузой проскочила активность — деплой отменён (флаг снят trap-ом)."
  exit 1
fi

echo "── pre-deploy tar data-dir (M0; мутации на паузе — снимок консистентен) ──"
ssh aeza 'mkdir -p /var/backups/ws-tele &&
  tar -czf /var/backups/ws-tele/pre-deploy-$(date +%Y%m%d-%H%M%S).tar.gz -C /var/lib --exclude ws-tele/maintenance.flag ws-tele &&
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
ssh aeza 'rm -f /var/lib/ws-tele/maintenance.flag'   # пауза больше не нужна (trap — страховка)
sleep 2

echo "── смоук ──"
CODE=$(ssh aeza 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8236/dash')
[ "$CODE" = 200 ] && echo "✓ /dash отвечает 200" || { echo "⛔ /dash: $CODE"; ssh aeza 'journalctl -u ws-tele -n 20 --no-pager'; exit 1; }
ssh aeza 'test -s /var/lib/ws-tele/lesson.db' && echo "✓ тень создана (/var/lib/ws-tele/lesson.db)" || { echo "⛔ lesson.db не появился"; exit 1; }
ssh aeza 'cd /opt/ws-tele && python3 check_db_parity.py /var/lib/ws-tele'
echo "✅ серверный контур выкачен, тень M1 активна ($(date +%H:%M:%S))"
