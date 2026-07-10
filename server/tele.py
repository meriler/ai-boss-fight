#!/usr/bin/env python3
"""Приёмник телеметрии демки воркшопа + дашборд наблюдателя.

POST /tele  — дампы от демки (за nginx location=/tele, без auth, POST-only ≤256КБ) → JSONL по дате.
GET  /dash  — дашборд для Алексея/Насти (за nginx basic auth): «кому помочь сейчас» + рубрика после.

Приватность: IP не пишем (и nginx access_log off), имена детей НЕ приезжают с устройств —
локальный маппинг /var/lib/ws-tele/seats.json (кладёт генератор персональных ссылок).
Дизайн дашборда: ревью Codex 10.07 — действие важнее статуса, красные вверх, легенда свёрнута.

Деплой: scp server/{tele.py,telemetry_model.py} aeza:/opt/ws-tele/ && ssh aeza systemctl restart ws-tele
Данные: /var/lib/ws-tele/YYYY-MM-DD.jsonl (owner bots, TTL 45д через tmpfiles.d)."""
import html, json, os, re, threading, time
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from telemetry_model import parse_lines, dedupe, build_children, fmt_r, cut, stage_label

DIR = '/var/lib/ws-tele'
MAX = 262144
MSK = timezone(timedelta(hours=3))
_lock = threading.Lock()  # append из потоков — сериализуем, чтобы строки JSONL не перемешивались


def valid(d):
    """Минимальная схема: мусорный JSON не должен травить рубрику (ревью Codex 10.07)."""
    if not isinstance(d, dict): return False
    if not isinstance(d.get('sid'), str) or not (1 <= len(d['sid']) <= 64): return False
    ev = d.get('events')
    if not isinstance(ev, list) or len(ev) > 3000: return False
    if not all(isinstance(e, dict) and isinstance(e.get('type'), str) for e in ev): return False
    return True


class H(BaseHTTPRequestHandler):
    timeout = 15  # медленный клиент не должен вешать обработчик

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX:
            self.send_response(413); self.end_headers(); return
        try:
            raw = self.rfile.read(n)
            d = json.loads(raw)
        except Exception:
            self.send_response(400); self.end_headers(); return
        if not valid(d):
            self.send_response(400); self.end_headers(); return
        rec = {'recv': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'data': d}
        fn = os.path.join(DIR, time.strftime('%Y-%m-%d') + '.jsonl')
        with _lock, open(fn, 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        self.send_response(204); self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        if u.path.rstrip('/') != '/dash':          # /tele — только POST; наружу торчит лишь /dash (за basic auth)
            self.send_response(404); self.end_headers(); return
        q = parse_qs(u.query)
        date = (q.get('date') or [''])[0]
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date):   # строгий формат — не путь к файлу
            date = time.strftime('%Y-%m-%d')
        body = render_dash(date, demo='demo' in q, review='review' in (q.get('view') or [])).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def esc(s):
    return html.escape(str(s if s is not None else '—'))


DONE_STAGES = ('опрос готов', 'сертификат', 'финал', 'лаборатория', 'игра')


def render_dash(date, demo=False, review=False):
    """Дашборд наблюдателя: сначала «кому помочь», потом всё остальное (ревью Codex 10.07)."""
    fn = os.path.join(DIR, date + '.jsonl')
    lines = open(fn, encoding='utf-8').readlines() if os.path.exists(fn) else []
    raws, bad = parse_lines(lines)
    dumps = dedupe(raws, include_demo=demo)
    names = {}
    try:  # место→имя из заявок (кладёт генератор персональных ссылок; наружу имена не уходят)
        with open(os.path.join(DIR, 'seats.json'), encoding='utf-8') as f:
            names = {str(k): v for k, v in json.load(f).items()}
    except Exception:
        pass
    kids = build_children(dumps, names)
    now = datetime.now(MSK)
    seen_all = [k['last_seen'] for k in kids if k['last_seen']]
    last = max(seen_all) if seen_all else None

    def rel(t):
        if not t: return '—'
        s = int((now - t).total_seconds())
        return t.astimezone(MSK).strftime('%H:%M:%S') + ' · ' + (f'{s} сек назад' if s < 120 else f'{s // 60} мин назад')

    def who(k):
        return (k['name'] + f" (место {k['seat']})") if k['name'] else f"место {k['seat']}"

    def status(k):
        """(эмодзи, МЕТКА-действие, приоритет 0=красный, причина для блока помощи)."""
        if k.get('mixed'):
            return ('⚠️', 'ДВЕ СЕССИИ', 0, 'на этом месте две одновременные сессии — похоже, ссылку переслали; выясни, кто второй')
        if k['stage'] in DONE_STAGES:
            return ('🏁', 'ГОТОВО', 3, '')
        if not k['last_seen']:
            return ('🔴', 'НУЖНА ПОМОЩЬ', 0, 'данных нет — похоже, не открыл свою ссылку')
        s = (now - k['last_seen']).total_seconds()
        if s < 120: return ('🟢', 'РАБОТАЕТ', 2, '')
        if s < 300: return ('🟡', 'ПОДОЖДАТЬ', 1, 'притих — думает или перерыв')
        if s < 1800: return ('🔴', 'НУЖНА ПОМОЩЬ', 0, f'нет активности {int(s // 60)} мин, остановился на «{stage_label(k["stage"])}»')
        # >30 мин — сессия дохлая (закрыл/старый тест): не пугать «нужна помощь» (смок Алексея 10.07)
        return ('⚪', 'НЕАКТИВЕН', 4, '')

    kids_s = sorted(kids, key=lambda k: (status(k)[2], str(k['seat'])))
    reds = [k for k in kids_s if status(k)[2] == 0]

    # баннер: действие важнее зелёного успеха
    if not dumps:
        banner = ('<div class="big warn">📭 За ' + esc(date) + ' данных пока нет</div>'
                  '<p>Сервер жив (страница отвечает). До старта занятия пусто — это нормально. '
                  'Если занятие уже идёт — проверь, что дети открыли свои ссылки (план Б — в пакете ведущего).</p>')
    else:
        n_idle = sum(1 for k in kids_s if status(k)[2] == 4)
        n_act = len(kids) - n_idle
        idle_txt = f' · неактивных: {n_idle}' if n_idle else ''
        if reds:
            banner = (f'<div class="big warn">⚠️ Детей в работе: {n_act} · <b>нужна помощь: {len(reds)}</b>{idle_txt} · '
                      f'последняя запись {rel(last)}</div>')
        else:
            banner = (f'<div class="big ok">✅ Всё спокойно · детей в работе: {n_act}{idle_txt} · последняя запись {rel(last)}'
                      + (f' · ⚠️ битых строк: {bad}' if bad else '') + '</div>')

    helpb = ''.join(
        f'<div class="red"><b>🔴 {esc(who(k))}</b> — {esc(status(k)[3])}<br>'
        f'<span class="act">→ окликни голосом или напиши в личку</span></div>'
        for k in reds)
    if dumps and not helpb:
        helpb = '<p class="note">🟢 Сейчас помощь никому не нужна.</p>'

    live = ''.join(
        f"<tr class='p{status(k)[2]}'><td><b>{esc(who(k))}</b></td>"
        f"<td>{status(k)[0]} <b>{esc(status(k)[1])}</b></td><td>{esc(stage_label(k['stage']))}</td>"
        f"<td>{esc(rel(k['last_seen']))}</td>"
        f"<td class='note'>{'💥 поломка была' if k['broke'] else ''}"
        f"{(' · ' + str(k['restarts']) + ' перезап.') if k['restarts'] else ''}</td></tr>"
        for k in kids_s)

    fin = sum(1 for k in kids if k['stage'] in DONE_STAGES)
    broke = sum(1 for k in kids if k['broke'])
    noseat = sum(1 for k in kids if isinstance(k['seat'], str) and str(k['seat']).startswith('?'))
    summary = (f'Итог: дошли до финала {fin} из {len(kids)} · поломка сработала у {broke} из {len(kids)} · '
               f'без персональной ссылки: {noseat}')
    rub = ''.join(
        f"<tr><td>{esc(k['seat'])}{(' · ' + esc(k['name'])) if k['name'] else ''}</td><td>{esc(stage_label(k['stage']))}</td><td>{esc(cut(k['hyp']))}</td>"
        f"<td>{esc(k['guessCat'])}</td><td>{esc(k['fixChosen'])}</td>"
        f"<td>{esc(fmt_r(k['r1']))}→{esc(fmt_r(k['r2']))}</td><td>{esc(k['klass'])}</td></tr>"
        for k in kids_s)
    texts = ''.join(
        f"<h4>{esc(who(k))}</h4><p>гипотеза: {esc(k['hyp'])}</p>"
        + ''.join(f"<p>{i + 1}. {esc(s)}</p>" for i, s in enumerate(k['survey']))
        for k in kids if k['survey'] or (k['hyp'] != '—' and not str(k['hyp']).startswith('🤷')))
    texts_block = f'<h2>Полные тексты</h2>{texts}' if texts else ''

    return f"""<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15">
<title>Воркшоп · {esc(date)}</title><style>
body{{background:#f5f7fa;color:#1a2330;font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px;max-width:1100px}}
.big{{font-size:19px;font-weight:800;padding:12px 16px;border-radius:12px;margin-bottom:12px}}
.ok{{background:#e8f7ee;border:1px solid #35b46a}}.warn{{background:#fdeaea;border:1px solid #d64545}}
.red{{background:#fff;border:2px solid #d64545;border-radius:12px;padding:10px 14px;margin:8px 0;font-size:16px}}
.red .act{{color:#b83232;font-weight:700}}
table{{border-collapse:collapse;width:100%;margin:10px 0 24px;background:#fff;border-radius:10px}}
td,th{{padding:8px 10px;border-bottom:1px solid #e2e7ee;text-align:left;font-size:15px}}
th{{color:#66738a;font-size:13px;text-transform:uppercase}}
tr.p0 td{{background:#fdeaea}}tr.p1 td{{background:#fdf6e3}}tr.p4 td{{color:#9aa5b8}}
h2{{margin:20px 0 4px}}h4{{margin:14px 0 2px;color:#2557d6}}
p{{margin:4px 0;color:#3a4560}}a{{color:#2557d6}}details{{margin:14px 0}}summary{{cursor:pointer;font-weight:800;font-size:16px}}
.note{{color:#66738a;font-size:13px}}</style></head><body>
{banner}
{helpb}
<h2>Все дети <span class="note">(красные сверху · страница сама обновляется каждые 15 сек)</span></h2>
<table><tr><th>кто</th><th>что делать</th><th>стадия</th><th>активность</th><th></th></tr>{live or '<tr><td colspan=5>—</td></tr>'}</table>
<details><summary>Что означают статусы</summary><p>
🔴 НУЖНА ПОМОЩЬ — нет активности &gt;5 мин или не открыл ссылку → окликни/напиши ·
🟡 ПОДОЖДАТЬ — притих 2–5 мин (думает, перерыв) ·
🟢 РАБОТАЕТ — активен &lt;2 мин ·
🏁 ГОТОВО — дошёл до финала ·
⚪ НЕАКТИВЕН — тишина &gt;30 мин (закрыл вкладку / старый тест), в «нужна помощь» не считается.<br>
💥 «поломка была» — его ИИ обманулся на проверке: это ЦЕЛЬ урока, хорошо! Если 💥 нет у большинства — с механикой что-то не так.
Номер у этапа — порядок в уроке (01 старт → 15 опрос готов). «Перезап.» — перезагрузки страницы (много = проблемы камеры/сети). «?·xxxx» — зашёл не по своей ссылке.</p></details>
<p class="note">дата: <a href="?date={esc(date)}{'&demo=1' if demo else ''}">{esc(date)}</a>
 · <a href="?{'demo=1' if not demo else ''}">{'показать' if not demo else 'скрыть'} demo-сессии</a> (боты-тесты)</p>
<details{' open' if review else ''}><summary>📋 Рубрика и ответы детей — смотреть ПОСЛЕ занятия</summary>
<p><b>{esc(summary)}</b></p>
<table><tr><th>кто</th><th>дошёл до</th><th>гипотеза</th><th>guess</th><th>починка</th><th>до→после</th><th>клетка (предв.)</th></tr>{rub}</table>
{texts_block}
<p class="note">Клетки — предварительные: тексты размечаются руками по кодбуку (rubric.py).</p>
</details></body></html>"""


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8236), H).serve_forever()
