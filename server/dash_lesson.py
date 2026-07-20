#!/usr/bin/env python3
"""Панель занятия фазы 0 — ГЛАВНЫЙ экран /dash (заход И3-Д, план итерации 3 18.07):
«один экран — одна задача». Активен run → страница показывает ТОЛЬКО контур занятия
(воркшоп v5 — за ссылкой «архив», собирает tele.py); нет run → большая кнопка запуска.

Иерархия сверху вниз: статус-строка (run · текущий шаг · «шаг вперёд» · мелко
«запустить заново») → блок «СЕЙЧАС» (очередь помощи, замки reveal, ТЕКУЩИЙ гейт с кодом
крупно) → одна таблица детей Кто·Связь·Шаг·Замер·Версия·Прогноз·Помощь·👍 (проблемные
наверху) → свёртки (неактивные гейты, прогресс, резерв, чат, лог, легенда «как читать»).
Каждый статус — цвет + иконка + слово, не только цвет.

Живые тревоги воркшоп-контура (Codex-ревью И3 п.4) — из телеметрии /tele через
telemetry_model.build_children: boot_dead (загрузка не встала), mixed (две одновременные
сессии), тишина 5+ мин при живой вкладке, серия неверных кодов (гейта — из tele-событий
gate_enter, разгадки — lock_fails v5), серия невалидных кадров, перезапуски страницы.
Красные тревоги перекрывают колонку «связь» (ребёнок со сломанной загрузкой не выглядит
«на связи»), оранжевые идут в «помощь», все — в очередь блока «СЕЙЧАС». Сессии с
тишиной >30 мин тревог не поднимают (старые тесты — то же правило, что в архиве v5).

Ведущий НЕ видит «правильно/неправильно» до reveal — только факт коммита и текст (§5).
Host-действия — кнопками fetch POST /host/* (страница за basic auth, Referer-гард).
Контракты ручек НЕ меняются — файл чисто рендерный (DoD И3-Д)."""
import html
import json
import time
from datetime import datetime, timedelta

from telemetry_model import build_children


def esc(s):
    return html.escape(str(s if s is not None else '—'))


def jsval(obj):
    """Данные → inline-JS внутри HTML-атрибута onclick (закалка 18.07, critical XSS).
    json.dumps даёт корректный JS-литерал (строки в двойных кавычках, спецсимволы
    \\-эскейплены), html.escape поверх закрывает выход из самого атрибута (&quot;
    и &#x27; вместо кавычек, &lt;/&gt; вместо угловых — «</script>» внутри данных
    не рвёт разметку). ВСЕ подстановки данных в onclick — только через эту функцию;
    html.escape без json.dumps НЕДОСТАТОЧЕН (не эскейпит выход из JS-строки)."""
    return html.escape(json.dumps(obj, ensure_ascii=False), quote=True)


def _now_ms():
    return int(time.time() * 1000)


OFFLINE_MS = 60 * 1000        # нет поллинга >60 c → «нет связи» (§4.1)
STUCK_FRESH_MIN = 10          # «жал застрял» показываем, если было в последние N минут
WS_SILENCE_S = 300            # 5 мин тишины телеметрии при живой вкладке → тревога
WS_DEAD_S = 1800              # >30 мин тишины — сессия мёртвая (старый тест), тревоги гасим
GATE_FAILS_ALERT = 3          # серия неверных кодов гейта подряд → тревога

RESERVE_LABELS = {'none': 'выключен', 'talk': '🗣 разговорный (r1)', 'trainer': '📦 тренажёрный добор (r2)'}


def _tele_per_seat(dumps):
    """Из дампов /tele за день: последние stuck_pressed, максимальный уровень подсказки
    и серия неверных кодов гейта подряд (gate_enter ok:false без последующего ok:true —
    live-сигнал «перебирает код», Codex-ревью И3 п.4)."""
    per = {}
    for d in dumps:
        seat = str(d.get('seat') or '')
        if not seat or seat == 'None':
            continue
        try:
            t0 = datetime.fromisoformat(str(d.get('started')).replace('Z', '+00:00'))
        except Exception:
            continue
        rec = per.setdefault(seat, {'stuck_last': None, 'stuck_step': '', 'hint_max': 0,
                                    'gate_fails': 0})
        series = 0
        for e in d.get('events', []):
            if not isinstance(e, dict):
                continue
            ts = t0 + timedelta(milliseconds=e.get('t', 0))
            if e.get('type') == 'stuck_pressed':
                if rec['stuck_last'] is None or ts > rec['stuck_last']:
                    rec['stuck_last'] = ts
                    rec['stuck_step'] = str(e.get('step', ''))
            elif e.get('type') == 'hint':
                rec['hint_max'] = max(rec['hint_max'], int(e.get('level', 1) or 1))
            elif e.get('type') == 'gate_enter':
                series = 0 if e.get('ok') else series + 1
        rec['gate_fails'] = max(rec['gate_fails'], series)
    return per


def _ws_kids(dumps, names):
    """Дети воркшоп-агрегации (telemetry_model.build_children) по строке-месту:
    источник живых тревог boot_dead / mixed / тишина / invalid-кадры / перезапуски.
    Ошибка агрегации не должна ронять панель — тогда тревог просто нет."""
    try:
        return {str(k['seat']): k for k in build_children(dumps, names)}
    except Exception:
        return {}


def _ws_alarms(k, gate_fails, now_dt):
    """Живые тревоги воркшоп-контура для ребёнка k (Codex-ревью И3 п.4): список
    [(prio, слово-для-таблицы, причина-для-«СЕЙЧАС»)], prio 0 — красное (перекрывает
    «на связи»), 1 — оранжевое. >30 мин тишины — сессия мёртвая (старый тест), тревог
    нет (то же правило, что в архивном дашборде v5)."""
    out = []
    if gate_fails >= GATE_FAILS_ALERT:
        out.append((1, '🔢 %d неверных кода' % gate_fails,
                    'подряд %d неверных кодов гейта — назови код голосом ещё раз' % gate_fails))
    if not k or not k.get('last_seen'):
        return out
    s = (now_dt - k['last_seen']).total_seconds()
    if s >= WS_DEAD_S:
        return []
    if k.get('boot_dead'):
        out.insert(0, (0, '💥 загрузка не встала',
                       'boot_fail без boot_ok — страница/модель не поднялась, помоги переоткрыть'))
    if k.get('mixed'):
        out.insert(0, (0, '⚠️ две сессии',
                       'две одновременные сессии на месте — похоже, ссылку переслали'))
    if s >= WS_SILENCE_S:
        out.append((1, '😶 тишина %d мин' % int(s // 60),
                    'событий телеметрии нет %d мин — вкладка жива, но ничего не происходит' % int(s // 60)))
    if k.get('lock_fails', 0) >= 5:
        out.append((1, '🔢 подбирает код',
                    '%d неверных вводов кода разгадки подряд' % k['lock_fails']))
    if k.get('inv_tail', 0) >= 4:
        out.append((1, '🚫 кадры не выходят',
                    '%d невалидных кадра подряд — не может собрать пример' % k['inv_tail']))
    return out


def _dict(v):
    """Кривой payload/снапшот (массив, строка, null) не должен ронять рендер панели
    (закалка 18.07, high 8) — любое «ожидали словарь» приводится к пустому словарю."""
    return v if isinstance(v, dict) else {}


def _fmt_measure(payload):
    m = _dict(_dict(payload).get('measures'))
    b, a = m.get('before'), m.get('after')
    fmt = lambda x: ('%s/%s' % (x.get('score'), x.get('of'))) if isinstance(x, dict) and x else '—'
    if not b and not a:
        return '—'
    return fmt(b) + ' → ' + fmt(a)


def _version_cell(step_commits):
    sc = _dict(step_commits)
    v, c = _dict(sc.get('version')), sc.get('choice')
    if not v and not c:
        return ''
    txt = ''
    if v:
        data = _dict(v.get('data'))
        txt = data.get('readable') or data.get('text') or 'версия из фрагментов'
        if v.get('late'):
            txt = str(txt) + ' · late'
    parts = ['✓ версия' if v else '', '✓ выбор' if c else '']
    head = ' · '.join(p for p in parts if p)
    return head + ('<br><span class="note">' + esc(txt) + '</span>' if txt else '')


def _forecast_cell(step_commits):
    f = _dict(_dict(step_commits).get('forecast'))
    if not f:
        return ''
    data = _dict(f.get('data'))
    return '✓ прогноз' + ('<br><span class="note">' + esc(data.get('readable', '')) + '</span>'
                          if data.get('readable') else '')


def _hlp(tip, right=False):
    """«?»-affordance у заголовка колонки: держит ВТОРИЧНУЮ расшифровку значков
    (progressive disclosure, ui-ux-pro-max) — ведущий читает основной смысл колонки
    словом в шапке, а символьную легенду открывает по желанию (hover / tap-focus),
    а не глазами в потоке урока. Правые колонки — right=True (тултип открывается влево,
    не за край). Текст эскейпится (та же XSS-дисциплина панели)."""
    return ('<span class="zhelp' + (' zr' if right else '') + '" tabindex="0" role="button"'
            ' aria-label="' + esc(tip) + '"><span aria-hidden="true">?</span>'
            '<span class="ztip">' + esc(tip) + '</span></span>')


_JS = """<script>
async function zPost(path, body) {
  const r = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'},
                              body: JSON.stringify(body)});
  return r.json().catch(() => ({}));
}
async function zAct(path, body) { await zPost(path, body); location.reload(); }
async function zReveal(step) {
  const j = await zPost('/host/reveal', {step});
  if (!j.ok && j.error === 'not_ready') {
    alert('Замок закрыт: ждём ' + j.missing.map(s => 'место ' + s).join(', ') +
          '. Раскрыть без них — отдельной красной кнопкой (уйдёт в лог).');
  }
  location.reload();
}
async function zOverride(step, missing) {
  if (!confirm('Раскрыть БЕЗ: ' + missing.map(s => 'место ' + s).join(', ') +
               '? Действие попадёт в лог занятия.')) return;
  await zAct('/host/override', {step, seat_missing: missing});
}
async function zResetVersion(step, seat) {
  if (!confirm('Сбросить версию места ' + seat + '? Ребёнок соберёт её заново.')) return;
  // op_id рождается ОДИН раз на логический сброс (хвост ревью 19.07, п.4): если ответ
  // потерялся и ведущий кликнул снова, повтор несёт ТОТ ЖЕ op_id — сервер отвечает
  // replay без второго инкремента epoch. Ключ чистится только после дошедшего ответа.
  const key = 'zreset-' + step + '-' + seat;
  let op = null;
  try { op = sessionStorage.getItem(key); } catch (e) {}
  if (!op) {
    op = 'reset-' + (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
    try { sessionStorage.setItem(key, op); } catch (e) {}
  }
  const j = await zPost('/host/reset_version', {step, seat, op_id: op});
  if (j && (j.ok || j.error === 'already_revealed')) {
    try { sessionStorage.removeItem(key); } catch (e) {}
  }
  location.reload();
}
async function zGateCode(step) {
  const code = document.getElementById('gcode_' + step).value.trim();
  await zAct('/host/gate', {action: 'code', step, code, show: true});
}
async function zStartLesson() {
  const lesson = (document.getElementById('zlesson').value || 'z1-kot').trim();
  let steps = [];
  try {
    const m = await (await fetch('/content/' + lesson + '/lesson.json')).json();
    const L = {gate: 'гейт', slide: 'слайд', cards_quiz: 'квиз', trainer_act: 'коробка',
               talk_chat: 'разговор', final_card: 'карточка дела'};
    steps = m.lesson.steps.map(s => ({id: s.id, type: s.type,
      label: (L[s.type] || s.type) + (s.mode ? ' · ' + s.mode : ''),
      gate: s.gate ? s.gate.kind : null, has_version: !!s.version, timebox: s.timebox_min}));
  } catch (e) { /* контент недоступен серверу дашборда — панель обойдётся без порядка шагов */ }
  await zAct('/host/gate', {action: 'start', lesson_id: lesson, steps});
}
</script>"""

_STYLE = ('<style>.lesson-panel{background:#fff;border:2px solid #2557d6;border-radius:12px;'
          'padding:12px 16px;margin:14px 0}'
          '.lesson-panel h2{margin:4px 0 8px}.lesson-panel h3{margin:14px 0 4px}'
          '.statusline{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:4px 0}'
          '.statusline .restart{margin-left:auto;opacity:.8;font-size:13px}'
          '.znow{background:#f2f6ff;border:1px solid #b9c9ec;border-radius:12px;padding:10px 12px;margin:10px 0}'
          '.znowttl{font-size:12px;font-weight:900;letter-spacing:2px;color:#2557d6;margin-bottom:6px}'
          '.lesson-lock{background:#fff;border:1px solid #c9d3e0;border-radius:10px;padding:8px 12px;margin:6px 0;font-size:16px}'
          '.gate-now{background:#fff;border:2px solid #2557d6;border-radius:10px;padding:8px 12px;margin:6px 0;font-size:16px}'
          '.gatecode-big{font-size:42px;font-weight:900;letter-spacing:6px;line-height:1.2}'
          '.lesson-gate{padding:4px 0;font-size:15px}'
          '.gatecode{font-size:22px;letter-spacing:2px}'
          '.lesson-strip{display:flex;gap:6px;flex-wrap:wrap}'
          '.lesson-stepcell{border:1px solid #c9d3e0;border-radius:8px;padding:4px 8px;font-size:13px;min-width:74px}'
          '.lesson-stepcell.lesson-cur{border:2px solid #2557d6;background:#eef3ff}'
          '.lesson-chat{max-height:180px;overflow-y:auto;font-size:14px}'
          '.warnbtn{border-color:#d64545 !important;color:#b83232 !important;background:#fdeaea !important}'
          '.lesson-panel button{font-size:13px;padding:4px 10px;border-radius:8px;'
          'border:1px solid #2557d6;background:#eef3ff;color:#2557d6;cursor:pointer}'
          '.lesson-panel button:disabled{opacity:.45;cursor:default}'
          '.lesson-panel tr.zr0 td{background:#fdeaea}'
          '.lesson-panel tr.zr1 td{background:#fbeedd}'
          '.lesson-panel tr.zr2 td{background:#fdf6e3}'
          # обёртка таблицы: широкую таблицу (8 колонок) на узком экране скроллим внутри
          # блока, а не рвём страницу (ui-ux-pro-max §Responsive — table horizontal-scroll)
          '.ztable-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}'
          # тултип-«?» на заголовке колонки: вторичная расшифровка значков (progressive
          # disclosure) — hover мышью, focus по tap на планшете; сам смысл колонки словом
          '.zhelp{display:inline-flex;align-items:center;justify-content:center;width:15px;'
          'height:15px;margin-left:5px;border-radius:50%;background:#c9d3e0;color:#fff;'
          'font-size:11px;font-weight:700;cursor:help;position:relative;vertical-align:middle;'
          'text-transform:none;letter-spacing:normal}'
          '.zhelp:hover,.zhelp:focus{background:#2557d6;outline:2px solid #2557d6;outline-offset:1px}'
          '.zhelp .ztip{display:none;position:absolute;z-index:30;top:20px;left:-6px;width:250px;'
          'background:#1a2330;color:#fff;font-weight:400;font-size:12px;line-height:1.45;'
          'letter-spacing:normal;text-transform:none;text-align:left;padding:8px 11px;'
          'border-radius:8px;box-shadow:0 6px 20px rgba(15,23,42,.28);white-space:normal}'
          '.zhelp.zr .ztip{left:auto;right:-6px}'
          '.zhelp:hover .ztip,.zhelp:focus .ztip{display:block}'
          '.lesson-start{font-size:16px;margin:8px 0}'
          '.lesson-panel .lesson-startbtn{font-size:17px !important;font-weight:900;'
          'padding:10px 22px !important;background:#2557d6 !important;color:#fff !important}'
          '</style>')


def _gate_counts(state, gid, names):
    """Счётчик гейта — ТОЛЬКО по ростеру: тест-вкладка/чужое место не даёт «6 из 5»
    (план-правок п.8); места вне ростера — отдельным хвостом, не в дроби."""
    g = (state.get('gates') or {}).get(gid) or {}
    arrived = g.get('arrived') or []
    if names:
        in_roster = [a for a in arrived if str(a) in names]
        extra_n = len(arrived) - len(in_roster)
    else:
        in_roster, extra_n = arrived, 0
    return g, in_roster, (' (+%d вне списка)' % extra_n if extra_n else '')


def _gate_controls(gid):
    return (' <input id="gcode_' + esc(gid) + '" placeholder="код" style="width:70px">' +
            '<button onclick="zGateCode(' + jsval(gid) + ')">задать</button>')


def _host_btn(label, path, body, cls=''):
    """Кнопка host-действия: данные в onclick — ТОЛЬКО через jsval (XSS-канон панели)."""
    return ('<button' + ((' class="' + cls + '"') if cls else '') +
            ' onclick="zAct(' + jsval(path) + ', ' + jsval(body) + ')">' + label + '</button>')


def _child_row(s, state, store, seats_state, commits, tele, wskids, seat_alarms,
               meta_by_id, version_steps, seat_name, offline, now_dt):
    """Одна строка таблицы «Дети в занятии»: (prio, sort_key, html). Вынесена из
    render_lesson_panel, чтобы кривые данные одного места не гасили всю панель
    (закалка 18.07, high 8) — вызывается в try."""
    rec = _dict(seats_state.get(str(s)))
    snap = _dict(store.read_snapshot(state['run_id'], s))
    payload = _dict(snap.get('payload'))
    t = _dict(tele.get(str(s)))
    step_now = rec.get('acked_step') or snap.get('state') or '—'
    if not isinstance(step_now, str):   # state в снапшоте бывает объектом машины
        step_now = str(_dict(step_now).get('step') or '—')
    label = _dict(meta_by_id.get(step_now)).get('label', '')
    sc = _dict(commits.get(str(s)))
    vcell = fcell = ''
    for _st_id, st_commits in sc.items():
        vcell = vcell or _version_cell(st_commits)
        fcell = fcell or _forecast_cell(st_commits)
    reacts = sum(1 for r in (state.get('reactions') or [])
                 if isinstance(r, dict) and str(r.get('seat')) == str(s))
    reset_btn = ''
    for step in version_steps:
        r = _dict(_dict(state.get('reveal')).get(step))
        if not r.get('open') and 'version' in _dict(sc.get(step)):
            reset_btn = (' <button onclick="zResetVersion(' + jsval(step) + ', ' +
                         jsval(str(s)) + ')">сбросить версию</button>')
    # статус = цвет строки + иконка + слово (не только цвет); приоритет задаёт сортировку
    prio = 3
    help_bits = []
    if t.get('stuck_last'):
        age_min = (now_dt - t['stuck_last']).total_seconds() / 60
        if age_min <= STUCK_FRESH_MIN:
            help_bits.append('🆘 застрял (шаг %s, %d мин)' %
                             (esc(t.get('stuck_step') or '?'), max(0, int(age_min))))
            prio = 0
    if t.get('hint_max'):
        help_bits.append('ур.' + str(t['hint_max']))
    # живые тревоги воркшоп-контура (Codex-ревью И3 п.4): ребёнок со сломанной
    # загрузкой / двумя сессиями не должен выглядеть «на связи» — красные тревоги
    # перекрывают колонку связи, оранжевые идут в «помощь»
    alarms = seat_alarms.get(str(s)) or []
    hard = [a for a in alarms if a[0] == 0]
    for _p, word, _why in (a for a in alarms if a[0] != 0):
        help_bits.append(esc(word))
    if alarms:
        prio = min(prio, min(a[0] for a in alarms))
    wk = _dict(wskids.get(str(s)))
    if hard:
        conn = ' · '.join(esc(w) for _p, w, _why in hard)
    elif offline(s):
        conn = '📴 НЕТ СВЯЗИ'
        prio = min(prio, 1)
    elif rec.get('instance'):
        conn = '🟢 на связи'
    else:
        conn = '⚪ не открывал'
        prio = min(prio, 2)
    if wk.get('restarts'):
        conn += ' · %d перезап.' % wk['restarts']
    return (prio,
            (not str(s).isdigit(), int(s) if str(s).isdigit() else 0, str(s)),
            '<tr class="zr' + str(prio) + '"><td><b>' + seat_name(s) + '</b></td>' +
            '<td>' + conn + '</td>' +
            '<td>' + esc(step_now) +
            (' <span class="note">' + esc(label) + '</span>' if label else '') + '</td>' +
            '<td>' + esc(_fmt_measure(payload)) + '</td>' +
            '<td>' + (vcell or '') + reset_btn + '</td>' +
            '<td>' + (fcell or '') + '</td>' +
            '<td>' + ' · '.join(help_bits) + '</td>' +
            '<td>' + (str(reacts) if reacts else '') + '</td></tr>')


def render_lesson_panel(store, dumps, names, session_live):
    state = store.view()

    if state is None:
        # нет активного run → большая кнопка запуска и ничего лишнего (И3-Д п.1)
        return (_JS + '<div class="lesson-panel"><h2>🎓 Занятие (демка З1)</h2>'
                '<div class="lesson-start">Запуск занятия создаст чистый run '
                '(репетиция утром → урок вечером = разные run, §4.1):<br>'
                '<input id="zlesson" value="z1-kot" style="width:140px"> '
                '<button class="lesson-startbtn" onclick="zStartLesson()">▶ ЗАПУСТИТЬ ЗАНЯТИЕ</button>'
                '</div></div>' + _STYLE)

    now = _now_ms()
    steps_meta = state.get('steps_meta') or []
    meta_by_id = {s['id']: s for s in steps_meta}
    seats_state = state.get('seats') or {}
    commits = state.get('commits') or {}
    tele = _tele_per_seat(dumps)
    wskids = _ws_kids(dumps, names)   # живые тревоги воркшоп-контура (Codex-ревью И3 п.4)
    all_seats = sorted(set(list(names.keys()) + list(seats_state.keys())),
                       key=lambda s: (not str(s).isdigit(), int(s) if str(s).isdigit() else 0, str(s)))

    def seat_name(s):
        n = names.get(str(s))
        return (esc(n) + ' (место ' + esc(s) + ')') if n else ('место ' + esc(s))

    def offline(s):
        rec = seats_state.get(str(s)) or {}
        ls = rec.get('last_sync')
        return bool(rec.get('instance')) and (not ls or now - ls > OFFLINE_MS)

    cur = state.get('current_step')
    out = [_JS, '<h2>🎓 Занятие: ' + esc(state.get('lesson_id')) + ' · run ' +
           esc(state.get('run_id')) + '</h2>']

    # ---- статус-строка: текущий шаг · «шаг вперёд» · мелко «запустить заново» ----
    cur_label = meta_by_id.get(cur, {}).get('label', '')
    bits = ['текущий шаг: <b>' + esc(cur or 'не открыт') + '</b>' +
            (' <span class="note">' + esc(cur_label) + '</span>' if cur_label else '')]
    step_ids = [s['id'] for s in steps_meta]
    nxt = None
    if step_ids:
        if cur in step_ids:
            i = step_ids.index(cur)
            nxt = step_ids[i + 1] if i + 1 < len(step_ids) else None
        else:
            nxt = step_ids[0]
    if nxt:
        nxt_label = meta_by_id.get(nxt, {}).get('label', '')
        bits.append(_host_btn('→ шаг вперёд: ' + esc(nxt) +
                              ((' · ' + esc(nxt_label)) if nxt_label else ''),
                              '/host/gate', {'action': 'step', 'step': nxt}))
    elif step_ids and cur == step_ids[-1]:
        bits.append('<span class="note">последний шаг</span>')
    bits.append('<span class="restart"><input id="zlesson" value="' +
                esc(state.get('lesson_id') or 'z1-kot') + '" style="width:110px"> '
                '<button onclick="if(confirm(\'Новый запуск? Текущий run уйдёт в архив.\'))'
                'zStartLesson()">▶ Запустить заново</button></span>')
    out.append('<div class="statusline">' + ' '.join(bits) + '</div>')

    # ================= блок «СЕЙЧАС»: только активное =================
    now_parts = []

    # ---- очередь «кому помочь» — топ-кейс КРУПНО (включая живые тревоги
    #      воркшоп-контура: boot_dead, две сессии, тишина, коды, кадры) ----
    queue = []
    now_dt = datetime.now().astimezone()
    seat_alarms = {}
    for s in all_seats:
        t = tele.get(str(s)) or {}
        seat_alarms[str(s)] = _ws_alarms(wskids.get(str(s)), t.get('gate_fails', 0), now_dt)
        if t.get('stuck_last'):
            age_min = (now_dt - t['stuck_last']).total_seconds() / 60
            if age_min <= STUCK_FRESH_MIN:
                queue.append((0, s, 'жал «застрял» на шаге %s, %d мин назад' %
                              (t.get('stuck_step') or '?', max(0, int(age_min)))))
        for prio_a, _word, why in seat_alarms[str(s)]:
            queue.append((prio_a, s, why))
        if offline(s):
            queue.append((1, s, 'нет связи — поллинг молчит больше минуты'))
    queue.sort(key=lambda q: (q[0], str(q[1]), q[2]))
    if queue:
        now_parts.append('<div class="red"><b>🆘 ' + seat_name(queue[0][1]) + '</b> — ' +
                         esc(queue[0][2]) + '<br><span class="act">→ подойди голосом</span></div>')
        for _, s, why in queue[1:4]:
            now_parts.append('<div class="org"><b>' + seat_name(s) + '</b> — ' + esc(why) + '</div>')
    else:
        now_parts.append('<p class="note">🟢 СПОКОЙНО — помощь сейчас никому не нужна</p>')

    # ---- замки reveal по шагам с версией ----
    version_steps = [s['id'] for s in steps_meta if s.get('has_version')] or list(state.get('reveal', {}).keys())
    for step in version_steps:
        rec = (state.get('reveal') or {}).get(step) or {}
        n_set = rec.get('n_set')
        ready = []
        for s, st_c in commits.items():
            sc = st_c.get(step) or {}
            if 'version' in sc and 'choice' in sc:
                ready.append(s)
        n_of = n_set if n_set is not None else []
        missing = [s for s in n_of if s not in ready]
        if rec.get('open'):
            now_parts.append('<div class="lesson-lock">🔓 <b>' + esc(step) + '</b>: разгадка ОТКРЫТА' +
                             (' (override)' if rec.get('override') else '') + '</div>')
            continue
        lock_txt = ('🔒 <b>' + esc(step) + '</b>: ' + str(len(ready)) + '/' +
                    (str(len(n_of)) if n_set is not None else '?— состав не зафиксирован'))
        btns = []
        if n_set is not None and not missing and len(n_of) > 0:
            btns.append('<button onclick="zReveal(' + jsval(step) + ')">🔓 Раскрыть</button>')
        else:
            btns.append('<button disabled title="активна при N/N">🔓 Раскрыть</button>')
            if missing:
                btns.append('<button class="warnbtn" onclick="zOverride(' + jsval(step) + ', ' +
                            jsval(missing) + ')">Раскрыть без отвалившегося</button>')
        btns.append(_host_btn('Зафиксировать состав сейчас',
                              '/host/gate', {'action': 'fix_n', 'step': step}))
        miss_txt = ''
        if missing:
            miss_txt = ('<br><span class="note">ждём: ' +
                        ', '.join(seat_name(s) + (' 📴' if offline(s) else '') for s in missing) + '</span>')
        now_parts.append('<div class="lesson-lock">' + lock_txt + ' ' + ' '.join(btns) + miss_txt + '</div>')

    # ---- ТЕКУЩИЙ гейт — с кодом крупно; неактивные гейты уходят в свёртку ниже ----
    gate_steps = [s for s in steps_meta if s.get('gate')] or \
                 [{'id': g, 'gate': 'code'} for g in (state.get('gates') or {})]
    roster_n = len(names) or len(all_seats)
    cur_gate = next((s for s in gate_steps if s['id'] == cur), None)
    if cur_gate:
        gid = cur_gate['id']
        g, in_roster, extra_txt = _gate_counts(state, gid, names)
        code = g.get('code')
        big = ('<div class="gate-now">⛩ Текущий гейт <b>' + esc(gid) + '</b> (' +
               esc(cur_gate.get('gate')) + '): <b>' + str(len(in_roster)) + ' из ' + str(roster_n) +
               '</b> перешли' + extra_txt)
        if cur_gate.get('gate') == 'code':
            big += (('<div class="gatecode-big">' + esc(code) + '</div>'
                     '<span class="note">код называешь вслух — сам детям не показывается</span>')
                    if code is not None else
                    '<br><span class="note">код не задан:</span>' + _gate_controls(gid))
            if code is not None:
                big += _gate_controls(gid)
        big += '</div>'
        now_parts.append(big)

    out.append('<div class="znow"><div class="znowttl">СЕЙЧАС</div>' + ''.join(now_parts) + '</div>')

    # ---- свёртка: остальные гейты (открыта, пока ведущий не открыл первый шаг —
    #      сразу после запуска тут задаётся код входного гейта) ----
    other_gates = [s for s in gate_steps if s['id'] != cur]
    if other_gates:
        grows = []
        for s in other_gates:
            gid = s['id']
            g, in_roster, extra_txt = _gate_counts(state, gid, names)
            code = g.get('code')
            grows.append('<div class="lesson-gate"><b>' + esc(gid) + '</b> (' + esc(s.get('gate')) + '): ' +
                         '<b>' + str(len(in_roster)) + ' из ' + str(roster_n) + '</b> перешли' + extra_txt +
                         (' · код: <b class="gatecode">' + esc(code) + '</b>' if code is not None else '') +
                         (_gate_controls(gid) if s.get('gate') == 'code' else '') + ' ' +
                         _host_btn('→ сделать текущим', '/host/gate',
                                   {'action': 'step', 'step': gid}) + '</div>')
        out.append('<details' + (' open' if cur is None else '') + '><summary>⛩ Остальные гейты (' +
                   str(len(other_gates)) + ')</summary>' + ''.join(grows) + '</details>')

    # ---- ОДНА таблица детей: Кто·Связь·Шаг·Замер·Версия·Прогноз·Помощь·👍,
    #      проблемные наверху (паттерн «красные сверху», И3-Д п.2) ----
    rows = []
    for s in all_seats:
        try:
            rows.append(_child_row(s, state, store, seats_state, commits, tele, wskids,
                                   seat_alarms, meta_by_id, version_steps, seat_name,
                                   offline, now_dt))
        except Exception as e:   # noqa: BLE001 — одна кривая строка не гасит панель (high 8)
            rows.append((0, (True, 0, str(s)),
                         '<tr class="zr0"><td><b>' + seat_name(s) + '</b></td>'
                         '<td colspan=7 class="note">строка не отрисовалась: ' +
                         esc(e) + '</td></tr>'))
    rows.sort(key=lambda r: (r[0], r[1]))
    out.append('<h3>Дети в занятии</h3><div class="ztable-wrap"><table><tr>'
               '<th>кто' + _hlp('Имя и место из ростера занятия.') + '</th>'
               '<th>связь' + _hlp(
                   '🟢 на связи — устройство шлёт синк · 📴 нет связи — поллинг молчит больше '
                   '60 сек (вкладка закрыта / нет интернета) · ⚪ не открывал — по ссылке ещё '
                   'не заходили · 💥 загрузка не встала · ⚠️ две сессии — ссылку переслали · '
                   '«N перезап.» — сколько раз перезагружал страницу (много = проблемы сети).') + '</th>'
               '<th>шаг' + _hlp('Последний подтверждённый шаг ребёнка.') + '</th>'
               '<th>замер' + _hlp('Проверка знаний до обучения → после (например 0/4 → 3/4).') + '</th>'
               '<th>версия' + _hlp(
                   '✓ — ребёнок записал версию/выбор. Текст виден, но «верно/неверно» скрыто '
                   'до «Раскрыть» — не подтверждай верный ответ, пока все не записали.') + '</th>'
               '<th>прогноз' + _hlp('✓ — ребёнок записал прогноз до проверки.', right=True) + '</th>'
               '<th>помощь' + _hlp(
                   '🆘 сам нажал «застрял» — подойди · ур.N — до какой глубины подсказки дошёл '
                   '(ур.2 сильная) · 😶 тишина 5+ мин · 🔢 серия неверных кодов · '
                   '🚫 серия невалидных кадров.', right=True) + '</th>'
               '<th>👍' + _hlp('Сколько раз ребёнок нажал «получилось!».', right=True) + '</th></tr>' +
               (''.join(r[2] for r in rows) or '<tr><td colspan=8>—</td></tr>') + '</table></div>'
               '<p class="note">до reveal видно только ФАКТ коммита и текст — без «верно/неверно» '
               '(не подтверждать верный ответ, пока все не записали)</p>')

    # ---- свёртки: прогресс · резерв · чат · лог · легенда (И3-Д п.3-4) ----
    if steps_meta:
        cells = []
        for s in steps_meta:
            here = [x for x in all_seats if (seats_state.get(str(x)) or {}).get('acked_step') == s['id']]
            cur_cls = ' lesson-cur' if cur == s['id'] else ''
            cells.append('<div class="lesson-stepcell' + cur_cls + '"><div class="note">' + esc(s['id']) +
                         '</div><div>' + esc(s.get('label') or s.get('type')) + '</div><b>' +
                         ('·'.join(esc(x) for x in here) if here else ' ') + '</b></div>')
        out.append('<details><summary>📊 Прогресс по блокам</summary><div class="lesson-strip">' +
                   ''.join(cells) + '</div><p class="note">в ячейке — номера мест, чей последний '
                   'подтверждённый шаг этот</p></details>')

    ra = state.get('reserve_active') or 'none'
    def rbtn(which, label):
        cur_style = ' style="font-weight:900;border-width:2px"' if ra == which else ''
        return ('<button' + cur_style + ' onclick="zAct(\'/host/gate\', {action: \'reserve\', which: \'' +
                which + '\'})">' + label + '</button>')
    out.append('<details' + (' open' if ra != 'none' else '') + '><summary>🧰 Резервный блок — сейчас: ' +
               esc(RESERVE_LABELS.get(ra, ra)) + '</summary><p>' + rbtn('none', 'выключен') + ' ' +
               rbtn('talk', '🗣 разговорный (r1)') + ' ' + rbtn('trainer', '📦 тренажёрный добор (r2)') +
               '</p></details>')

    chat = (state.get('chat') or [])[-30:]
    if chat:
        out.append('<details><summary>💬 Чат тренажёра (' + str(len(chat)) + ')</summary>'
                   '<div class="lesson-chat">' + ''.join(
                       '<div><b>' + seat_name(m.get('seat')) + ':</b> ' + esc(m.get('text')) + '</div>'
                       for m in chat) + '</div></details>')

    # лог host-действий (override обязан быть виден — DoD п.4)
    log = [l for l in (state.get('log') or []) if l.get('op') in ('override', 'reset_version', 'fix_n')]
    if log:
        out.append('<details><summary>Лог действий ведущего (' + str(len(log)) + ')</summary>' + ''.join(
            '<p class="note">' + esc(l.get('op')) + ' · шаг ' + esc(l.get('step', '')) +
            (' · без мест: ' + esc(','.join(l.get('seat_missing', []))) if l.get('op') == 'override' else '') +
            (' · место ' + esc(l.get('seat')) if l.get('op') == 'reset_version' else '') + '</p>'
            for l in log) + '</details>')

    # свёрнутая справка «как читать панель»: расшифровка значков переехала в «?» на
    # заголовках колонок (progressive disclosure, ui-ux-pro-max) — здесь остаётся только
    # компактный фолбэк для того, что НЕ привязано к одной колонке (цвет строк, замок, гейт).
    # Свёрнута по умолчанию, ведущий открывает при желании, а не читает в потоке урока.
    out.append(
        '<details><summary>ℹ️ Как читать панель</summary><p class="note">'
        'Значки в таблице расшифрованы прямо в шапке — наведи (или нажми) на «?» рядом с названием колонки.<br>'
        '<b>Цвет строки = слово рядом:</b> красная — 🆘 застрял, оранжевая — 📴 нет связи, '
        'жёлтая — ⚪ не открывал. Цвет только дублирует статус, ориентируйся на слово.<br>'
        '<b>СЕЙЧАС</b> вверху — только то, что требует действия: кому подойти, замок разгадки '
        '🔒/🔓 (откроется при N/N записавших; отвалившегося обходишь красной кнопкой — уйдёт в лог), '
        'текущий гейт (код называешь вслух, детям он не показывается).</p></details>')

    return '<div class="lesson-panel">' + ''.join(out) + '</div>' + _STYLE
