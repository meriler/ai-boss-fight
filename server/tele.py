#!/usr/bin/env python3
"""Приёмник телеметрии демки воркшопа + дашборд наблюдателя.

POST /tele  — дампы от демки (за nginx location=/tele, без auth, POST-only ≤256КБ) → JSONL по дате.
GET  /dash  — дашборд для Алексея/Насти (за nginx basic auth): «кому помочь сейчас» + рубрика после.

Приватность: IP не пишем (и nginx access_log off), имена детей НЕ приезжают с устройств —
локальный маппинг /var/lib/ws-tele/seats.json (кладёт генератор персональных ссылок).
Дизайн дашборда: ревью Codex 10.07 — действие важнее статуса, красные вверх, легенда свёрнута.

Стейтфул-контур занятия фазы 0 (ТЗ-демка-з1 §4.1) — lesson_state.py: /save /restore /commit
/sync /chat /react /host/* (маршрутизация ниже, вся логика и файлы состояния — в модуле;
контракты /tele, /dash, sess_start/sess_stop НЕ меняются, DoD п.10).

Деплой: scp server/{tele.py,telemetry_model.py,lesson_state.py,dash_lesson.py} aeza:/opt/ws-tele/ && ssh aeza systemctl restart ws-tele
Данные: /var/lib/ws-tele/YYYY-MM-DD.jsonl (owner bots, TTL 45д через tmpfiles.d)."""
import html, json, mimetypes, os, re, threading, time
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from telemetry_model import (parse_lines, dedupe, build_children, fmt_r, cut, stage_label,
                             roster_child, fmt_stages, fmt_hw)
import lesson_state
import dash_lesson

DIR = os.environ.get('WS_TELE_DIR', '/var/lib/ws-tele')   # env — для локального теста
PORT = int(os.environ.get('WS_TELE_PORT', '8236'))
# ТОЛЬКО локальный e2e/разработка: раздать статику демки этим же сервером (одна origin для
# z1.html + /sync + /dash). На проде НЕ выставлять — статику отдаёт nginx (/var/www/ws).
STATIC_DIR = os.environ.get('WS_STATIC_DIR')
MAX = 262144
MSK = timezone(timedelta(hours=3))
_lock = threading.Lock()  # append из потоков — сериализуем, чтобы строки JSONL не перемешивались
# Персональная ссылка на актуальную демку. ДУБЛЬ константы из бота (itmo/ai-school-bot/workshop.py
# WS_DEMO_URL) — сервисы разные (/opt/ws-tele на Aeza vs бот), импортировать неоткуда. При смене
# демки (v5→v6) править В ОБОИХ местах. Параметры ?ws=1&seat=N обязательны (телеметрия по seat).
WS_DEMO_URL = 'https://ws.meriler.cc/v5.html?ws=1&seat={seat}'
LESSON_STORE = lesson_state.LessonStore(DIR)   # стейтфул-контур занятия (§4.1), файлы в DIR


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
        u = urlparse(self.path)
        if u.path.rstrip('/') == '/dash':          # админ-действия дашборда (за nginx basic auth)
            return self._admin()
        if u.path in lesson_state.POST_HANDLERS:   # стейтфул-контур занятия (§4.1)
            return self._lesson_post(u)
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

    def _lesson_post(self, u):
        """POST-ручки контура занятия. /host/* — за nginx basic auth, плюс тот же дешёвый
        CSRF-гард по Referer, что у _admin (вызовы идут со страницы дашборда)."""
        if u.path.startswith('/host/') and '/dash' not in (self.headers.get('Referer') or ''):
            return self._json(403, {'ok': False, 'error': 'forbidden'})
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX:
            return self._json(413, {'ok': False, 'error': 'too_large'})
        try:
            body = json.loads(self.rfile.read(n))
            assert isinstance(body, dict)
        except Exception:
            return self._json(400, {'ok': False, 'error': 'bad_json'})
        status, resp = lesson_state.handle_post(LESSON_STORE, u.path, body)
        return self._json(status, resp)

    def _json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _admin(self):
        """Управление с дашборда (запрос Алексея 10.07): сброс данных дня (в архив, не удаление),
        скрытие сессий места, переименование мест. Всё за basic auth /dash; дешёвый CSRF-гард —
        Referer с нашего дашборда."""
        ref = self.headers.get('Referer') or ''
        if '/dash' not in ref:
            self.send_response(403); self.end_headers(); return
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > 8192:
            self.send_response(413); self.end_headers(); return
        q = parse_qs(self.rfile.read(n).decode('utf-8', 'replace'))
        act = (q.get('act') or [''])[0]
        date = (q.get('date') or [''])[0]
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date):
            date = time.strftime('%Y-%m-%d')
        fn = os.path.join(DIR, date + '.jsonl')
        extra = ''   # хвост к Location: &added=N (выдали место) / &taken=N (место занято)
        with _lock:
            if act == 'reset_day' and os.path.exists(fn):
                # не удаляем — уводим в архив рядом (вернуть = переименовать обратно)
                os.rename(fn, fn + '.bak-' + time.strftime('%H%M%S'))
                hid = os.path.join(DIR, 'hidden-' + date + '.json')
                if os.path.exists(hid):
                    os.remove(hid)
            elif act == 'hide':
                sids = [s for s in (q.get('sids') or [''])[0].split(',')
                        if re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', s)]
                if sids:
                    hid = os.path.join(DIR, 'hidden-' + date + '.json')
                    cur = []
                    try:
                        with open(hid, encoding='utf-8') as f:
                            cur = json.load(f)
                    except Exception:
                        pass
                    with open(hid, 'w', encoding='utf-8') as f:
                        json.dump(sorted(set(cur) | set(sids)), f)
            elif act in ('sess_start', 'sess_stop'):
                # маркеры занятия (просьба Алексея, прогон 13.07): по ним будут резаться отчёты.
                # Отдельный файл, НЕ строки в JSONL — parse_lines/рубрика их не видят и не травятся.
                sf = os.path.join(DIR, 'session-' + date + '.json')
                cur = {}
                try:
                    with open(sf, encoding='utf-8') as f:
                        cur = json.load(f)
                except Exception:
                    pass
                if not isinstance(cur, dict):
                    cur = {}
                now_iso = datetime.now(MSK).strftime('%Y-%m-%dT%H:%M:%S')
                if act == 'sess_start':
                    cur = {'start': now_iso}   # новый старт открывает новое окно (прежний стоп сброшен)
                else:
                    cur['stop'] = now_iso
                with open(sf + '.tmp', 'w', encoding='utf-8') as f:
                    json.dump(cur, f)
                os.replace(sf + '.tmp', sf)    # атомарно: читатель не увидит полузаписанный файл
            elif act == 'rename':
                seat = (q.get('seat') or [''])[0]
                name = (q.get('name') or [''])[0].strip()[:60]
                if re.fullmatch(r'\d{1,2}', seat):
                    sf = os.path.join(DIR, 'seats.json')
                    cur = {}
                    try:
                        with open(sf, encoding='utf-8') as f:
                            cur = {str(k): v for k, v in json.load(f).items()}
                    except Exception:
                        pass
                    if name:
                        cur[seat] = name
                    else:
                        cur.pop(seat, None)   # пустое имя = убрать место из ростера
                    with open(sf, 'w', encoding='utf-8') as f:
                        json.dump(cur, f, ensure_ascii=False)
            elif act == 'add_seat':
                # ручное добавление участника: имя + свободное место → готовая ссылка на демку.
                # Кейс — ребёнок подтвердил после рассылки (прецедент Гульнара 15.07): раньше
                # приходилось руками гонять ws_broadcast.py на Aeza, теперь — прямо с дашборда.
                name = (q.get('name') or [''])[0].strip()[:60]
                req = (q.get('seat') or [''])[0].strip()
                used = used_seats(date)
                seat = None
                if not req:                                # авто — минимальный свободный
                    seat = next_free_seat(used)
                elif re.fullmatch(r'\d{1,2}', req):        # ручной номер (только цифры → безопасно в Location)
                    if req in used:
                        extra = '&taken=' + req            # занято — покажем ошибку
                    else:
                        seat = int(req)
                # нечисловой ввод места молча игнорим (поле подписано «пусто = авто»)
                if seat is not None:
                    sf = os.path.join(DIR, 'seats.json')
                    cur = {}
                    try:
                        with open(sf, encoding='utf-8') as f:
                            cur = {str(k): v for k, v in json.load(f).items()}
                    except Exception:
                        pass
                    cur[str(seat)] = name or ('место ' + str(seat))   # имя в ростер (как бот)
                    with open(sf, 'w', encoding='utf-8') as f:
                        json.dump(cur, f, ensure_ascii=False)
                    extra = '&added=' + str(seat)
        self.send_response(303)
        self.send_header('Location', '/dash?date=' + date + extra)
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ('/restore', '/sync'):        # контур занятия (§4.1): чтение по seat
            status, resp = lesson_state.handle_get(LESSON_STORE, u.path, parse_qs(u.query))
            return self._json(status, resp)
        if u.path.rstrip('/') != '/dash':          # /tele — только POST; наружу торчит лишь /dash (за basic auth)
            if STATIC_DIR:                         # локальный e2e: одна origin для статики и API
                return self._static(u.path)
            self.send_response(404); self.end_headers(); return
        q = parse_qs(u.query)
        date = (q.get('date') or [''])[0]
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date):   # строгий формат — не путь к файлу
            date = time.strftime('%Y-%m-%d')
        added = (q.get('added') or [''])[0]
        added = added if re.fullmatch(r'\d{1,2}', added) else ''
        taken = (q.get('taken') or [''])[0]
        taken = taken if re.fullmatch(r'\d{1,2}', taken) else ''
        body = render_dash(date, demo='demo' in q, review='review' in (q.get('view') or []),
                           added=added, taken=taken).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _static(self, path):
        """Раздача файлов демки в локальном e2e (STATIC_DIR). Прод-путь не задет: без env — 404."""
        rel = path.lstrip('/') or 'index.html'
        full = os.path.realpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(os.path.realpath(STATIC_DIR) + os.sep) or not os.path.isfile(full):
            self.send_response(404); self.end_headers(); return
        ctype = mimetypes.guess_type(full)[0] or 'application/octet-stream'
        if full.endswith('.mjs'):
            ctype = 'application/javascript'       # прецедент ws.meriler.cc: без этого модуль мёртв
        with open(full, 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def esc(s):
    return html.escape(str(s if s is not None else '—'))


DONE_STAGES = ('опрос готов', 'сертификат', 'финал', 'лаборатория', 'игра')


def load_session(date):
    """Окно занятия из session-<date>.json: (start, stop, auto). Старт без стопа старше 2 часов
    считается закрытым в start+2ч (автофиниш) — «забыли нажать ⏹» не растягивает отчёт на весь день."""
    try:
        with open(os.path.join(DIR, 'session-' + date + '.json'), encoding='utf-8') as f:
            s = json.load(f)
        def _p(v):
            return datetime.strptime(v, '%Y-%m-%dT%H:%M:%S').replace(tzinfo=MSK) if v else None
        start, stop, auto = _p(s.get('start')), _p(s.get('stop')), False
        if start and not stop and datetime.now(MSK) - start > timedelta(hours=2):
            stop, auto = start + timedelta(hours=2), True
        return start, stop, auto
    except Exception:
        return None, None, False


def used_seats(date):
    """Занятые цифровые места на дату: ключи seats.json ∪ места из живых дампов дня.
    Нужно, чтобы ручная выдача места не столкнулась ни с ростером, ни с уже сидящим ребёнком
    (иначе на месте окажутся две сессии — mixed). Возвращает set строк-номеров."""
    used = set()
    try:
        with open(os.path.join(DIR, 'seats.json'), encoding='utf-8') as f:
            used |= {str(k) for k in json.load(f)}
    except Exception:
        pass
    try:
        fn = os.path.join(DIR, date + '.jsonl')
        if os.path.exists(fn):
            raws, _ = parse_lines(open(fn, encoding='utf-8').readlines())
            for k in build_children(dedupe(raws, include_demo=True), {}):
                if str(k.get('seat', '')).isdigit():
                    used.add(str(k['seat']))
    except Exception:
        pass
    return used


def next_free_seat(used):
    """Минимальный свободный номер места ≥1 (мест мало — линейный перебор дешёв)."""
    i = 1
    while str(i) in used:
        i += 1
    return i


def render_session(date):
    """Строка-пульт «▶ старт / ⏹ финиш» под баннером: маркеры окна занятия для резки отчётов."""
    start, stop, auto = load_session(date)
    hm = lambda t: t.astimezone(MSK).strftime('%H:%M')
    frm = ('<form method="post" style="display:inline;margin-left:10px">'
           '<input type="hidden" name="date" value="' + esc(date) + '">')
    if not start:
        body = ('занятие не начато' + frm +
                '<button name="act" value="sess_start">▶ Старт занятия</button></form>')
    elif not stop:
        body = ('🟢 занятие идёт с <b>' + hm(start) + '</b> (автофиниш через 2 ч)' + frm +
                '<button name="act" value="sess_stop" onclick="return confirm(\'Завершить занятие? Маркер попадёт в отчёт.\')">⏹ Финиш</button></form>')
    else:
        body = ('⏹ занятие: <b>' + hm(start) + '–' + hm(stop) + '</b>' + (' (автофиниш)' if auto else '') + frm +
                '<button name="act" value="sess_start" onclick="return confirm(\'Начать НОВОЕ окно занятия? Прежние метки затрутся.\')">▶ Старт заново</button></form>')
    return ('<div class="sess">🎬 ' + body +
            '<span class="note" style="margin-left:8px">метки старт/финиш — для резки отчёта по времени урока</span></div>')


def render_admin(date, kids_s):
    """Блок «⚙️ Управление». Отдельной функцией без f-строк с бэкслешами в выражениях —
    Aeza на py3.10, где это SyntaxError (прод лежал в рестарт-лупе 10.07)."""
    rows = []
    for k in kids_s:
        row = ('<form method="post" style="margin:4px 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
               '<input type="hidden" name="date" value="' + esc(date) + '">'
               '<b style="min-width:120px">место ' + esc(k['seat']) + '</b>')
        if str(k['seat']).isdigit():
            row += ('<input type="hidden" name="seat" value="' + esc(k['seat']) + '">'
                    '<input name="name" value="' + (esc(k['name']) if k['name'] else '') + '" placeholder="имя" style="width:150px">'
                    '<button name="act" value="rename">💾 имя</button>')
        if k['sids']:
            row += ('<input type="hidden" name="sids" value="' + esc(','.join(k['sids'])) + '">'
                    '<button name="act" value="hide" onclick="return confirm(\'Скрыть сессии места '
                    + esc(k['seat']) + ' с дашборда?\')">🗑 скрыть сессии (' + str(len(k['sids'])) + ')</button>')
        else:
            row += '<span class="note">дампов нет</span>'
        rows.append(row + '</form>')
    add = ('<form method="post" style="margin:4px 0 10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
           '<input type="hidden" name="date" value="' + esc(date) + '">'
           '<b style="min-width:120px">➕ новое место</b>'
           '<input name="name" placeholder="имя ребёнка" style="width:150px">'
           '<input name="seat" placeholder="место (пусто = авто)" style="width:150px" '
           'title="Пусто — система возьмёт минимальный свободный номер">'
           '<button name="act" value="add_seat">🔗 выдать ссылку</button></form>')
    return ('<details><summary>⚙️ Управление (добавить · сброс · скрытие · имена)</summary>'
            '<p class="note">«Новое место» — добавить участника вручную и получить готовую ссылку на демку '
            'со свободным местом (ссылка появится вверху дашборда). Скрытие убирает сессии только с '
            'дашборда (файл цел); сброс дня уводит файл в архив рядом. Имя пустым = убрать место из ростера.</p>'
            + add + '<hr style="border:none;border-top:1px solid #e2e7ee;margin:8px 0">'
            + ''.join(rows) +
            '<form method="post" style="margin:10px 0 4px"><input type="hidden" name="date" value="' + esc(date) + '">'
            '<button name="act" value="reset_day" onclick="return confirm(\'Убрать ВСЕ данные за ' + esc(date) +
            ' в архив? Дашборд станет пустым.\')">🗑 Сбросить весь день ' + esc(date) + ' (в архив)</button></form>'
            '</details>')


def render_link_block(date, added, taken):
    """Плашка под баннером после ручной выдачи места: готовая ссылка на демку + кнопка «копировать»
    (added), либо ошибка «место занято» (taken). Пусто — если ни того, ни другого."""
    if taken:
        return ('<div class="linkbox err">⚠️ Место <b>' + esc(taken) + '</b> занято или задано неверно — '
                'выбери другой номер или оставь поле пустым (тогда система возьмёт свободное).'
                ' <a href="?date=' + esc(date) + '">убрать</a></div>')
    if not added:
        return ''
    link = WS_DEMO_URL.format(seat=added)
    name = ''
    try:
        with open(os.path.join(DIR, 'seats.json'), encoding='utf-8') as f:
            name = str(json.load(f).get(str(added), ''))
    except Exception:
        pass
    who = (esc(name) + ', место ' + esc(added)) if name else ('место ' + esc(added))
    # navigator.clipboard требует https — дашборд за TLS (ws.meriler.cc), работает. Фолбэк — ручное
    # выделение: поле readonly, по клику выделяется целиком.
    return ('<div class="linkbox ok2">✅ Место выдано: <b>' + who + '</b>. Ссылка на демку — скопируй и '
            'отправь ребёнку:<br>'
            '<input id="lnk" readonly value="' + esc(link) + '" onclick="this.select()" '
            'style="width:100%;max-width:640px;margin:6px 0;padding:7px 9px;font-size:14px;'
            'border:1px solid #35b46a;border-radius:8px">'
            '<button onclick="navigator.clipboard.writeText(document.getElementById(\'lnk\').value);'
            'this.textContent=\'скопировано ✓\'">📋 копировать</button> '
            '<a href="?date=' + esc(date) + '" style="margin-left:8px">убрать</a></div>')


def render_dash(date, demo=False, review=False, added='', taken=''):
    """Дашборд наблюдателя: сначала «кому помочь», потом всё остальное (ревью Codex 10.07)."""
    fn = os.path.join(DIR, date + '.jsonl')
    lines = open(fn, encoding='utf-8').readlines() if os.path.exists(fn) else []
    raws, bad = parse_lines(lines)
    dumps = dedupe(raws, include_demo=demo)
    try:  # скрытые с дашборда сессии (кнопка 🗑 в «Управлении») — из файла не удаляются
        with open(os.path.join(DIR, 'hidden-' + date + '.json'), encoding='utf-8') as f:
            hidden = set(json.load(f))
        dumps = [d for d in dumps if str(d.get('sid')) not in hidden]
    except Exception:
        pass
    names = {}
    try:  # место→имя из заявок (кладёт генератор персональных ссылок; наружу имена не уходят)
        with open(os.path.join(DIR, 'seats.json'), encoding='utf-8') as f:
            names = {str(k): v for k, v in json.load(f).items()}
    except Exception:
        pass
    kids = build_children(dumps, names)
    now = datetime.now(MSK)
    # маркер занятия: тревоги «нужна помощь» и ростер «кто не открыл ссылку» имеют смысл ТОЛЬКО
    # когда занятие идёт (нажат «▶ Старт»). До старта дети штатно ещё не подключены, живой пинг
    # может быть от соседней сессии/теста — не поднимаем панику крупным красным (просьба Алексея 15.07).
    s_start, s_stop, _ = load_session(date)
    session_live = bool(s_start) and not s_stop
    # ростер: места из seats.json, от которых нет НИ ОДНОГО дампа — «не открыл ссылку».
    # Показываем только пока занятие ЖИВОЕ: до старта пустые места не красим красным.
    if session_live:
        have = {str(k['seat']) for k in kids}
        kids += [roster_child(s, n) for s, n in names.items() if str(s) not in have]
    seen_all = [k['last_seen'] for k in kids if k['last_seen']]
    last = max(seen_all) if seen_all else None

    def rel(t):
        if not t: return '—'
        s = int((now - t).total_seconds())
        return t.astimezone(MSK).strftime('%H:%M:%S') + ' · ' + (f'{s} сек назад' if s < 120 else f'{s // 60} мин назад')

    def who(k):
        return (k['name'] + f" (место {k['seat']})") if k['name'] else f"место {k['seat']}"

    def status(k):
        """(эмодзи, МЕТКА-действие, приоритет 0=красный, причина для блока помощи).
        Приоритеты: 0 красный · 1 оранжевый БУКСУЕТ · 2 жёлтый · 3 зелёный · 4 готово · 5 неактивен.
        Красный по тишине/загрузке ВЫШЕ оранжевого: буксует = активен, но не продвигается."""
        if not k['last_seen']:
            return ('🔴', 'НУЖНА ПОМОЩЬ', 0, 'данных нет — похоже, не открыл свою ссылку')
        if k['stage'] in DONE_STAGES and not k.get('mixed'):
            return ('🏁', 'ГОТОВО', 4, '')   # дошедший до финала остаётся 🏁 и после закрытия вкладки
        s = (now - k['last_seen']).total_seconds()
        if s >= 1800:
            # >30 мин тишины — сессия дохлая (закрыл/старый тест): НЕАКТИВЕН гасит ЛЮБОЙ статус,
            # включая mixed/boot_dead — старые тесты не должны кричать красным (смоки Алексея 10.07 ×2)
            return ('⚪', 'НЕАКТИВЕН', 5, '')
        if k.get('mixed'):
            return ('⚠️', 'ДВЕ СЕССИИ', 0, 'на этом месте две одновременные сессии — похоже, ссылку переслали; выясни, кто второй')
        if k.get('boot_dead'):
            return ('🔴', 'НУЖНА ПОМОЩЬ', 0, 'камера или загрузка не встала — помоги переподключить (камера занята звонком?)')
        if s >= 300:
            return ('🔴', 'НУЖНА ПОМОЩЬ', 0, f'нет активности {int(s // 60)} мин, остановился на «{stage_label(k["stage"])}»')
        # буксует = свежая активность, но упёрся: гейт держит / перебирает код замка / серия
        # невалидных кадров (аудит 10.07: раньше такой ребёнок выглядел зелёным «РАБОТАЕТ»)
        why_stuck = ''
        if k.get('stuck_last') and (now - k['stuck_last']).total_seconds() < 180:
            why_stuck = f'застрял на гейте («{stage_label(k["stage"])}»)'
        elif k.get('lock_fails', 0) >= 5:
            why_stuck = f'подбирает код разгадки ({k["lock_fails"]} неверных) — код 4712 называет только ведущий после гипотез'
        elif k.get('inv_tail', 0) >= 4:
            why_stuck = f'{k["inv_tail"]} невалидных кадра подряд — не может собрать пример'
        if why_stuck:
            return ('🟠', 'БУКСУЕТ', 1, why_stuck)
        if s < 120: return ('🟢', 'РАБОТАЕТ', 3, '')
        return ('🟡', 'ПОДОЖДАТЬ', 2, 'притих — думает или перерыв')

    kids_s = sorted(kids, key=lambda k: (status(k)[2], str(k['seat'])))
    # до старта занятия тревоги гасим — красный/оранжевый не всплывают крупно (просьба Алексея 15.07)
    reds = [k for k in kids_s if status(k)[2] == 0] if session_live else []
    oranges = [k for k in kids_s if status(k)[2] == 1] if session_live else []

    # баннер: действие важнее зелёного успеха
    if not dumps:
        banner = ('<div class="big warn">📭 За ' + esc(date) + ' данных пока нет</div>'
                  '<p>Сервер жив (страница отвечает). До старта занятия пусто — это нормально. '
                  'Если занятие уже идёт — проверь, что дети открыли свои ссылки (план Б — в пакете ведущего).</p>')
    elif not session_live:
        # занятие не начато: спокойный баннер, без «нужна помощь» крупным красным
        n_present = sum(1 for k in kids_s if k['last_seen'] and (now - k['last_seen']).total_seconds() < 1800)
        act_txt = f' · сейчас активны: {n_present}' if n_present else ''
        banner = (f'<div class="big ok">🎬 Занятие не начато — тревоги «нужна помощь» включатся после «▶ Старт занятия». '
                  f'В ростере детей: {len(names)}{act_txt} · последняя запись {rel(last)}</div>')
    else:
        n_idle = sum(1 for k in kids_s if status(k)[2] == 5)
        n_act = len(kids) - n_idle
        idle_txt = f' · неактивных: {n_idle}' if n_idle else ''
        org_txt = f' · <b>буксуют: {len(oranges)}</b>' if oranges else ''
        if reds or oranges:
            banner = (f'<div class="big warn">⚠️ Детей в работе: {n_act} · <b>нужна помощь: {len(reds)}</b>{org_txt}{idle_txt} · '
                      f'последняя запись {rel(last)}</div>')
        else:
            banner = (f'<div class="big ok">✅ Всё спокойно · детей в работе: {n_act}{idle_txt} · последняя запись {rel(last)}'
                      + (f' · ⚠️ битых строк: {bad}' if bad else '') + '</div>')

    helpb = ''.join(
        f'<div class="red"><b>🔴 {esc(who(k))}</b> — {esc(status(k)[3])}<br>'
        f'<span class="act">→ окликни голосом или напиши в личку</span></div>'
        for k in reds) + ''.join(
        f'<div class="org"><b>🟠 {esc(who(k))}</b> — {esc(status(k)[3])}<br>'
        f'<span class="act2">→ активен, но не продвигается — предложи помощь голосом</span></div>'
        for k in oranges)
    if dumps and not helpb:
        helpb = ('<p class="note">🎬 Занятие не начато — блок «нужна помощь» появится после старта.</p>'
                 if not session_live else '<p class="note">🟢 Сейчас помощь никому не нужна.</p>')

    live = ''.join(
        f"<tr class='p{status(k)[2]}'><td><b>{esc(who(k))}</b></td>"
        f"<td>{status(k)[0]} <b>{esc(status(k)[1])}</b></td><td>{esc(stage_label(k['stage']))}</td>"
        f"<td>{esc(rel(k['last_seen']))}</td>"
        f"<td class='note'>{'💥 поломка была' if k['broke'] else ''}"
        f"{(' · ' + str(k['restarts']) + ' перезап.') if k['restarts'] else ''}</td></tr>"
        for k in kids_s)

    real = [k for k in kids if not k.get('roster_only')]   # ростер-строки — только для live-таблицы
    fin = sum(1 for k in real if k['stage'] in DONE_STAGES)
    broke = sum(1 for k in real if k['broke'])
    noseat = sum(1 for k in real if isinstance(k['seat'], str) and str(k['seat']).startswith('?'))
    # медианы времён фаз по группе — «где буксуют» для доводки между прогонами (аудит 10.07)
    med = {}
    for ph in ('сбор', 'проверка', 'разбор', 'починка', 'опрос'):
        vals = sorted(k['stage_min'][ph] for k in real if k.get('stage_min', {}).get(ph) is not None)
        if vals:
            med[ph] = vals[len(vals) // 2]
    med_txt = (' · ⏱ медианы фаз, мин: ' + ' · '.join(f'{p} {v}' for p, v in med.items())) if med else ''
    summary = (f'Итог: дошли до финала {fin} из {len(real)} · поломка сработала у {broke} из {len(real)} · '
               f'без персональной ссылки: {noseat}{med_txt}')
    rub = ''.join(
        f"<tr><td>{esc(k['seat'])}{(' · ' + esc(k['name'])) if k['name'] else ''}</td><td>{esc(stage_label(k['stage']))}</td><td>{esc(cut(k['hyp']))}</td>"
        f"<td>{esc(k['guessCat'])}</td><td>{esc(k['fixChosen'])}</td>"
        f"<td>{esc(fmt_r(k['r1']))}→{esc(fmt_r(k['r2']))}</td><td>{esc(k['klass'])}{' · 🎓 серт' if k.get('cert') else ''}</td>"
        f"<td class='note'>{esc(fmt_stages(k.get('stage_min')))}</td><td class='note'>{esc(fmt_hw(k))}</td></tr>"
        for k in kids_s if not k.get('roster_only'))
    texts = ''.join(
        f"<h4>{esc(who(k))}</h4><p>гипотеза: {esc(k['hyp'])}</p>"
        + ''.join(f"<p>{i + 1}. {esc(s)}</p>" for i, s in enumerate(k['survey']))
        for k in kids if k['survey'] or (k['hyp'] != '—' and not str(k['hyp']).startswith('🤷')))
    texts_block = f'<h2>Полные тексты</h2>{texts}' if texts else ''
    admin = render_admin(date, kids_s)
    sess = render_session(date)
    linkblk = render_link_block(date, added, taken)
    try:   # панель занятия фазы 0 (§5) — аддитивно, ломаться молча не должна и не должна ронять дашборд.
        # Дампы — ВКЛЮЧАЯ demo (e2e/репетиция ходят с ?demo=1, их stuck/hint панель обязана видеть)
        lesson_dumps = dedupe(raws, include_demo=True)
        lesson_panel = dash_lesson.render_lesson_panel(LESSON_STORE, lesson_dumps, names, session_live)
    except Exception as e:
        lesson_panel = '<p class="note">панель занятия недоступна: %s</p>' % esc(e)

    return f"""<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15">
<title>Воркшоп · {esc(date)}</title><style>
body{{background:#f5f7fa;color:#1a2330;font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px;max-width:1100px}}
.big{{font-size:19px;font-weight:800;padding:12px 16px;border-radius:12px;margin-bottom:12px}}
.ok{{background:#e8f7ee;border:1px solid #35b46a}}.warn{{background:#fdeaea;border:1px solid #d64545}}
.red{{background:#fff;border:2px solid #d64545;border-radius:12px;padding:10px 14px;margin:8px 0;font-size:16px}}
.red .act{{color:#b83232;font-weight:700}}
.org{{background:#fff;border:2px solid #e08a2e;border-radius:12px;padding:10px 14px;margin:8px 0;font-size:16px}}
.org .act2{{color:#b06a1a;font-weight:700}}
table{{border-collapse:collapse;width:100%;margin:10px 0 24px;background:#fff;border-radius:10px}}
td,th{{padding:8px 10px;border-bottom:1px solid #e2e7ee;text-align:left;font-size:15px}}
th{{color:#66738a;font-size:13px;text-transform:uppercase}}
tr.p0 td{{background:#fdeaea}}tr.p1 td{{background:#fbeedd}}tr.p2 td{{background:#fdf6e3}}tr.p5 td{{color:#9aa5b8}}
h2{{margin:20px 0 4px}}h4{{margin:14px 0 2px;color:#2557d6}}
p{{margin:4px 0;color:#3a4560}}a{{color:#2557d6}}details{{margin:14px 0}}summary{{cursor:pointer;font-weight:800;font-size:16px}}
.note{{color:#66738a;font-size:13px}}
.sess{{background:#fff;border:1px solid #c9d3e0;border-radius:12px;padding:9px 14px;margin:0 0 12px;font-size:15px}}
.sess button,.linkbox button{{font-size:14px;padding:5px 12px;border-radius:8px;border:1px solid #2557d6;background:#eef3ff;color:#2557d6;cursor:pointer;font-weight:700}}
.linkbox{{background:#fff;border:1px solid #c9d3e0;border-radius:12px;padding:11px 14px;margin:0 0 12px;font-size:15px}}
.linkbox.ok2{{border:2px solid #35b46a;background:#eefaf1}}.linkbox.err{{border:2px solid #d64545;background:#fdeaea}}</style></head><body>
{banner}
{linkblk}
{sess}
{lesson_panel}
{helpb}
<h2>Все дети <span class="note">(красные сверху · страница сама обновляется каждые 15 сек)</span></h2>
<table><tr><th>кто</th><th>что делать</th><th>стадия</th><th>активность</th><th></th></tr>{live or '<tr><td colspan=5>—</td></tr>'}</table>
<details><summary>Что означают статусы</summary><p>
🔴 НУЖНА ПОМОЩЬ — нет активности &gt;5 мин, не открыл ссылку или не встала камера → окликни/напиши ·
🟠 БУКСУЕТ — активен, но упёрся (гейт держит / подбирает код / серия невалидных кадров) → предложи помощь ·
🟡 ПОДОЖДАТЬ — притих 2–5 мин (думает, перерыв) ·
🟢 РАБОТАЕТ — активен &lt;2 мин ·
🏁 ГОТОВО — дошёл до финала ·
⚪ НЕАКТИВЕН — тишина &gt;30 мин (закрыл вкладку / старый тест), в «нужна помощь» не считается.<br>
💥 «поломка была» — его ИИ обманулся на проверке: это ЦЕЛЬ урока, хорошо! Если 💥 нет у большинства — с механикой что-то не так.
Номер у этапа — порядок в уроке (01 старт → 15 опрос готов). «Перезап.» — перезагрузки страницы (много = проблемы камеры/сети). «?·xxxx» — зашёл не по своей ссылке.</p></details>
<p class="note">дата: <a href="?date={esc(date)}{'&demo=1' if demo else ''}">{esc(date)}</a>
 · <a href="?{'demo=1' if not demo else ''}">{'показать' if not demo else 'скрыть'} demo-сессии</a> (боты-тесты)</p>
{admin}
<details{' open' if review else ''}><summary>📋 Рубрика и ответы детей — смотреть ПОСЛЕ занятия</summary>
<p><b>{esc(summary)}</b></p>
<table><tr><th>кто</th><th>дошёл до</th><th>гипотеза</th><th>guess</th><th>починка</th><th>до→после</th><th>клетка (предв.)</th><th>фазы, мин</th><th>железо</th></tr>{rub}</table>
{texts_block}
<p class="note">Клетки — предварительные: тексты размечаются руками по кодбуку (rubric.py).</p>
</details></body></html>"""


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
