#!/usr/bin/env python3
"""Общая логика агрегации телеметрии воркшопа: JSONL → «дети» (по seat).

Единственный источник правды для CLI (rubric.py) и веб-морды (/dash в tele.py) —
тонкие интерфейсы поверх этих функций (ревью Codex 10.07). Кодбук разметки — в rubric.py.
"""
import json, re
from datetime import datetime, timedelta, timezone

STAGE_HUMAN = {'boot_ok': 'загрузился', 'seat': 'сел', 'guide_start': 'старт урока',
               'task_start': 'сбор данных', 'sample': 'сбор данных', 'task_done': 'сбор данных',
               'card': 'проверка', 'check_done': 'проверка', 'break_shown': 'поломка',
               'hypothesis': 'гипотеза', 'guess': 'угадайка', 'reveal_attempt': 'замок',
               'reveal_unlock': 'разгадка', 'reveal_shown': 'разгадка', 'fix_start': 'починка',
               'fix_choice': 'починка', 'fix_retry': 'починка', 'probe_retry': 'повтор проверки',
               'final': 'финал', 'final_summary': 'финал', 'survey_open': 'опрос',
               'survey_answer': 'опрос', 'survey_done': 'опрос готов', 'cert_made': 'сертификат',
               'lab_entered': 'лаборатория', 'game_played': 'игра'}


def parse_lines(lines):
    """Строки JSONL → (сырые записи, число битых строк)."""
    raws, bad = [], 0
    for l in lines:
        if not l.strip():
            continue
        try:
            raws.append(json.loads(l))
        except Exception:
            bad += 1
    return raws, bad


def dedupe(raws, include_demo=False, ws_only=True):
    """Записи → дампы по sid (самый полный побеждает; при равенстве — поздний по порядку чтения).

    Попутно каждому дампу пишется окно приёма его sid: _recv_first/_recv_last (по серверным часам) —
    для детекта одновременных сессий одного места (шаринг ссылки; Codex 10.07)."""
    dumps, spans = {}, {}
    for r in raws:
        d = r.get('data', r)
        if not isinstance(d, dict) or 'sid' not in d:
            continue
        if d.get('demo') and not include_demo:
            continue
        if ws_only and not d.get('ws'):
            continue
        d['_recv'] = r.get('recv')
        t = _parse_iso(r.get('recv'))
        if t:
            a, b = spans.get(d['sid'], (t, t))
            spans[d['sid']] = (min(a, t), max(b, t))
        old = dumps.get(d['sid'])
        if not old or len(d.get('events', [])) >= len(old.get('events', [])):
            dumps[d['sid']] = d
    for sid, d in dumps.items():
        d['_recv_first'], d['_recv_last'] = spans.get(sid, (None, None))
    return list(dumps.values())


# порядок этапов урока (просьба Алексея 10.07: «загрузился» и «опрос» несравнимы без номера)
STAGE_ORDER = {'загрузился': 1, 'сел': 2, 'старт урока': 3, 'сбор данных': 4, 'проверка': 5,
               'поломка': 6, 'гипотеза': 7, 'угадайка': 8, 'замок': 9, 'разгадка': 10,
               'починка': 11, 'повтор проверки': 12, 'финал': 13, 'опрос': 14, 'опрос готов': 15,
               'сертификат': 16, 'лаборатория': 16, 'игра': 16, 'итог': 16}


def stage_label(stage):
    n = STAGE_ORDER.get(stage)
    return f'{n:02d} · {stage}' if n else stage


def ev(events, t):
    return [e for e in events if e.get('type') == t]


def last_stage(events):
    for e in reversed(events):
        h = STAGE_HUMAN.get(e.get('type'))
        if h:
            return h
    return '—'


def cut(s, n=80):
    s = (s or '').replace('\n', ' ').strip()
    return s[:n] + ('…' if len(s) > n else '')


def cell(fs, fixes):
    """Предварительная клетка рубрики (тексты размечаются руками — кодбук в rubric.py)."""
    if not fs:
        return '⚠️ нет final_summary'
    if not fs.get('assessed', True):
        return 'не оценено (nogate)'
    if fs.get('outcome') in ('no_break', 'inconclusive'):
        return f"не оценено ({fs.get('outcome')})"
    cat = fs.get('guessCat'); chosen = fs.get('fixChosen')
    partial = any(f.get('attempt') == 2 and f.get('correct') for f in fixes)
    did = chosen == 'self'
    said = cat in ('data-right', 'data-generic', 'specific-wrong')
    mark = '±' if (did and partial) else ''
    if did and said: return f'Понял{mark} (предв.)'
    if did: return f'Сделал, но не понял{mark} (предв.)'
    if said: return 'Сказал, но не сделал (предв.)'
    return 'Не понял (предв.)'


def _parse_iso(s):
    try:
        s = (s or '').replace('Z', '+00:00')
        s = re.sub(r'([+-]\d{2})(\d{2})$', r'\1:\2', s)  # '+0300' → '+03:00': fromisoformat до py3.11 иначе падает
        return datetime.fromisoformat(s)
    except Exception:
        return None


def last_seen(d):
    """Время последней РЕАЛЬНОЙ активности сессии, aware-datetime или None.

    Не время приёма: досланный при resend старый дамп прилетает «сейчас», но его последняя
    активность — в прошлом. Возраст считаем по клиентским часам (now − started − max(t)) —
    одна пара часов, смещение времени на устройстве сокращается; recv — верхняя граница/fallback."""
    recv = _parse_iso(d.get('_recv'))
    if not recv:
        return None
    try:
        started = _parse_iso(d.get('started'))
        cnow = d.get('now')
        if started and isinstance(cnow, (int, float)):
            max_t = max((e.get('t', 0) for e in d.get('events', [])), default=0)
            started_ms = started.timestamp() * 1000
            stale_ms = max(0.0, float(cnow) - started_ms - max_t)  # возраст последнего события на момент отправки
            return recv - timedelta(milliseconds=stale_ms)
    except Exception:
        pass
    return recv


def _ev_time(d, t_ms):
    """Абсолютное время события с офсетом t_ms — та же пара клиентских часов, что в last_seen():
    recv − (now − started − t). Нет now/started (старые дампы) → None."""
    recv = _parse_iso(d.get('_recv'))
    if not recv:
        return None
    try:
        started = _parse_iso(d.get('started'))
        cnow = d.get('now')
        if started and isinstance(cnow, (int, float)) and isinstance(t_ms, (int, float)):
            stale = max(0.0, float(cnow) - started.timestamp() * 1000 - float(t_ms))
            return recv - timedelta(milliseconds=stale)
    except Exception:
        pass
    return None


def _first_t(events, types):
    if isinstance(types, str):
        types = (types,)
    for e in events:
        if e.get('type') in types and isinstance(e.get('t'), (int, float)):
            return e['t']
    return None


# фазы урока для таймингов: дельты между first-occurrence якорями (аудит 10.07 — «где буксуют»
# между прогонами 13.07→15.07 было нечем измерить). Пропущенный якорь → фаза не считается.
_PHASES = [('сбор', 'guide_start', 'card'),
           ('проверка', 'card', ('break_shown', 'no_break', 'inconclusive')),
           ('разбор', ('break_shown', 'no_break', 'inconclusive'), 'fix_start'),  # гипотеза+угадайка+замок+разгадка
           ('починка', 'fix_start', 'final'),
           ('опрос', 'final', 'survey_done')]


def stage_times(events):
    """Минуты на фазах урока (по главной сессии). Отрицательные/битые дельты пропускаются."""
    out = {}
    for name, a, b in _PHASES:
        ta, tb = _first_t(events, a), _first_t(events, b)
        if ta is not None and tb is not None and tb > ta:
            out[name] = round((tb - ta) / 60000, 1)
    return out


def _invalid_tail(events):
    """Сколько shot_invalid подряд в ХВОСТЕ событий (perf-heartbeat пропускаем, любой другой
    тип обрывает серию) — live-сигнал «не может собрать кадр прямо сейчас»."""
    n = 0
    for e in reversed(events):
        t = e.get('type')
        if t == 'perf':
            continue
        if t == 'shot_invalid':
            n += 1
        else:
            break
    return n


def _lock_fails(events):
    """Неудачные вводы кода разгадки БЕЗ последующего успеха — в ТОЙ ЖЕ сессии (старый unlock
    с другого F5 не должен маскировать текущий перебор — Codex 10.07)."""
    if ev(events, 'reveal_unlock') or ev(events, 'reveal_shown'):
        return 0
    ns = [e.get('n') for e in ev(events, 'reveal_attempt') if isinstance(e.get('n'), (int, float))]
    return int(max(ns)) if ns else 0


def _boot_dead(sessions, raw_recv):
    """Последняя ПРИНЯТАЯ сессия места упала на загрузке и не поднялась (boot_fail без
    последующего boot_ok). Retry с успехом в той же/новой сессии снимает флаг (Codex 10.07)."""
    latest = max(sessions, key=raw_recv)
    dead = False
    for e in latest['events']:
        if e.get('type') == 'boot_fail':
            dead = True
        elif e.get('type') == 'boot_ok':
            dead = False
    return dead


def _fps_stats(events):
    vals = sorted(v for v in (e.get('fps') for e in ev(events, 'perf')) if isinstance(v, (int, float)))
    if not vals:
        return None, None
    return int(vals[0]), int(vals[len(vals) // 2])


def build_children(dumps, names=None):
    """Дампы → список «детей» (группировка по seat поверх sid — F5 плодит sid).

    Безместные (seat=null) НЕ сливаются в одну кучу: это разные люди — каждая
    сессия отдельной строкой «?·xxxx» (вопрос Алексея 10.07).
    names: {"5": "Серёжа К."} — локальный маппинг место→имя (seats.json на сервере;
    телеметрия с устройств остаётся псевдонимной, имя присоединяется только при чтении)."""
    names = names or {}
    by_seat = {}
    for d in dumps:
        key = d.get('seat')
        if key is None:
            key = '?·' + str(d.get('sid'))[:4]
        by_seat.setdefault(key, []).append(d)
    out = []
    for seat in sorted(by_seat, key=lambda s: (isinstance(s, str), str(s))):
        sessions = by_seat[seat]
        with_final = [d for d in sessions if ev(d['events'], 'final_summary')]
        # выбор ТОЛЬКО по raw серверному приёму (_recv): клиентские часы для склейки не годятся
        # (Codex P0 10.07); client-derived время — только для статуса живости
        far_past = datetime.min.replace(tzinfo=timezone.utc)
        raw_recv = lambda d: _parse_iso(d.get('_recv')) or far_past
        main_d = max(with_final, key=raw_recv) if with_final \
            else max(sessions, key=lambda d: (raw_recv(d), len(d['events'])))
        # детект «двое на одном месте»: окна приёма двух sid пересекаются дольше 60с (шаринг ссылки)
        mixed = False
        for i in range(len(sessions)):
            for j in range(i + 1, len(sessions)):
                a, b = sessions[i], sessions[j]
                if not (a.get('_recv_first') and b.get('_recv_first')):
                    continue
                lo = max(a['_recv_first'], b['_recv_first'])
                hi = min(a['_recv_last'], b['_recv_last'])
                if (hi - lo).total_seconds() > 60:
                    mixed = True
        events = main_d['events']
        fss = ev(events, 'final_summary')
        fs = fss[-1] if fss else None
        hyp = (ev(events, 'hypothesis') or [None])[-1]
        fixes = ev(events, 'fix_choice')
        surv = ev(events, 'survey_answer')
        seen = max((t for t in (last_seen(d) for d in sessions) if t), default=None)
        # r1/r2: из final_summary; НЕТ final_summary («не досидел») → fallback из последнего
        # check_done ленты — иначе у недосидевших теряется точность раунда 1 (аудит 10.07)
        if fs:
            r1, r2 = fs.get('r1'), fs.get('r2')
        else:
            def _cd(rounds):
                for e in reversed(events):
                    if e.get('type') == 'check_done' and e.get('round') in rounds \
                            and isinstance(e.get('correct'), int) and isinstance(e.get('total'), int):
                        return {'correct': e['correct'], 'total': e['total']}
                return None
            r1, r2 = _cd((0, 1)), _cd((2,))
        # агрегаты по ВСЕМ сессиям места: невалидные кадры (какой гейт душит), дропы камеры, артефакт
        inv = {}
        for d in sessions:
            for e in ev(d['events'], 'shot_invalid'):
                w = e.get('why') or '?'
                inv[w] = inv.get(w, 0) + 1
        cam_drops = sum(len(ev(d['events'], 'cam_drop')) for d in sessions)
        cert = any(ev(d['events'], 'cert_made') for d in sessions)
        # session-scoped (главная сессия): железо, тайминги, буксование — старый F5 не должен искажать
        fps_min, fps_med = _fps_stats(events)
        stuck_last = max((t for t in (_ev_time(d, (ev(d['events'], 'gate_stuck') or [{}])[-1].get('t'))
                                      for d in sessions) if t), default=None)
        if isinstance(seat, str) and seat.startswith('?'):
            klass = 'без места (открыл не по своей ссылке)'
        elif not fs and len(events) <= 3:
            klass = 'TELEMETRY_LOST (ранний обрыв)'
        elif not fs:
            klass = f'не досидел (стадия: {last_stage(events)})'
        else:
            klass = cell(fs, fixes)
        out.append({
            'seat': seat, 'name': names.get(str(seat), ''),
            'stage': last_stage(events), 'last_seen': seen,
            'hyp': ('🤷 не знаю' if hyp and hyp.get('dontknow') else (hyp or {}).get('text') or '—'),
            'guessCat': (fs or {}).get('guessCat') or '—',
            'fixChosen': ((fs or {}).get('fixChosen') or '—') + (f" ({len(fixes)} поп.)" if fixes else ''),
            'stuck': len(ev(events, 'gate_stuck')),
            'r1': r1, 'r2': r2,
            'survey': [s.get('text', '') for s in surv],
            'klass': klass + (' · ⚠️ данные смешаны (две одновременные сессии)' if mixed else ''),
            'mixed': mixed, 'restarts': len(sessions) - 1,
            'broke': bool(ev(events, 'break_shown')),
            # аудит 10.07: операционка и live-сигналы буксования
            'inv': inv, 'inv_tail': _invalid_tail(events), 'lock_fails': _lock_fails(events),
            'stuck_last': stuck_last, 'cam_drops': cam_drops, 'cert': cert,
            'boot_dead': _boot_dead(sessions, raw_recv),
            'os': main_d.get('os') or '?', 'mobile': bool(main_d.get('mobile')),
            'fps_min': fps_min, 'fps_med': fps_med,
            'stage_min': stage_times(events),
            'dur_min': round(max((e.get('t', 0) for e in events), default=0) / 60000, 1),
            'roster_only': False,
        })
    return out


def roster_child(seat, name):
    """Синтетическая строка ростера: место роздано (seats.json), но НИ ОДНОГО дампа не пришло.
    Только для live-таблицы «кому помочь» — в рубрику/итоги не включать (roster_only)."""
    try:
        seat = int(seat)
    except (TypeError, ValueError):
        pass
    return {'seat': seat, 'name': name or '', 'stage': '—', 'last_seen': None, 'hyp': '—',
            'guessCat': '—', 'fixChosen': '—', 'stuck': 0, 'r1': None, 'r2': None, 'survey': [],
            'klass': 'не открыл ссылку', 'mixed': False, 'restarts': 0, 'broke': False,
            'inv': {}, 'inv_tail': 0, 'lock_fails': 0, 'stuck_last': None, 'cam_drops': 0,
            'cert': False, 'boot_dead': False, 'os': '?', 'mobile': False,
            'fps_min': None, 'fps_med': None, 'stage_min': {}, 'dur_min': 0, 'roster_only': True}


def split_by_date(raws):
    """Сырые записи → {дата приёма: [записи]}. Один seat в разные дни — РАЗНЫЕ дети:
    dedupe/build_children дат не знают, поэтому многодневный вход режем ДО них (Codex 10.07)."""
    by = {}
    for r in raws:
        t = _parse_iso(r.get('recv'))
        by.setdefault(t.date().isoformat() if t else 'без даты', []).append(r)
    return by


def fmt_r(r):
    return f"{r['correct']}/{r['total']}" if r else '—'


def fmt_stages(sm):
    return ' · '.join(f'{k} {v}' for k, v in sm.items()) if sm else '—'


def fmt_hw(k):
    fps = f"fps {k['fps_min']}–{k['fps_med']}" if k['fps_min'] is not None else 'fps —'
    return (k['os'] + ('·моб' if k['mobile'] else '') + ' · ' + fps
            + (f" · 📷×{k['cam_drops']}" if k['cam_drops'] else ''))
