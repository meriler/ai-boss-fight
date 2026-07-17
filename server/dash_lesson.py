#!/usr/bin/env python3
"""Панель занятия фазы 0 на дашборде /dash (ТЗ-демка-з1 §5) — АДДИТИВНЫЙ блок,
существующие секции воркшопа не трогаются (DoD п.10).

Glanceable (конституция п.10): очередь «кому помочь» крупно → reveal-lock → гейты →
поимённая таблица → прогресс по шагам → резерв → чат. Ведущий НЕ видит «правильно/
неправильно» до reveal — только факт коммита и текст версии (правило §5).

Host-действия — кнопками через fetch POST /host/* (та же страница /dash за basic auth,
Referer-гард проходит). Данные шагов занятия сервер не читает из content/ — их снимок
(steps_meta) кладёт кнопка «Запустить» при старте (fetch lesson.json на клиенте дашборда)."""
import html
import json
import time
from datetime import datetime, timedelta


def esc(s):
    return html.escape(str(s if s is not None else '—'))


def _now_ms():
    return int(time.time() * 1000)


OFFLINE_MS = 60 * 1000        # нет поллинга >60 c → «нет связи» (§4.1)
STUCK_FRESH_MIN = 10          # «жал застрял» показываем, если было в последние N минут


def _tele_per_seat(dumps):
    """Из дампов /tele за день: последние stuck_pressed и максимальный уровень подсказки."""
    per = {}
    for d in dumps:
        seat = str(d.get('seat') or '')
        if not seat or seat == 'None':
            continue
        try:
            t0 = datetime.fromisoformat(str(d.get('started')).replace('Z', '+00:00'))
        except Exception:
            continue
        rec = per.setdefault(seat, {'stuck_last': None, 'stuck_step': '', 'hint_max': 0})
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
    return per


def _fmt_measure(payload):
    m = (payload or {}).get('measures') or {}
    b, a = m.get('before'), m.get('after')
    fmt = lambda x: ('%s/%s' % (x['score'], x['of'])) if isinstance(x, dict) and x else '—'
    if not b and not a:
        return '—'
    return fmt(b) + ' → ' + fmt(a)


def _version_cell(step_commits):
    v = (step_commits or {}).get('version')
    c = (step_commits or {}).get('choice')
    if not v and not c:
        return ''
    txt = ''
    if v:
        data = v.get('data') or {}
        txt = data.get('readable') or data.get('text') or 'версия из фрагментов'
        if v.get('late'):
            txt += ' · late'
    parts = ['✓ версия' if v else '', '✓ выбор' if c else '']
    head = ' · '.join(p for p in parts if p)
    return head + ('<br><span class="note">' + esc(txt) + '</span>' if txt else '')


def _forecast_cell(step_commits):
    f = (step_commits or {}).get('forecast')
    if not f:
        return ''
    data = f.get('data') or {}
    return '✓ прогноз' + ('<br><span class="note">' + esc(data.get('readable', '')) + '</span>'
                          if data.get('readable') else '')


def render_lesson_panel(store, dumps, names, session_live):
    state = store.view()
    js = """<script>
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
  await zAct('/host/reset_version', {step, seat});
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
    const L = {gate: 'гейт', cards_quiz: 'квиз', trainer_act: 'коробка',
               talk_chat: 'разговор', final_card: 'карточка дела'};
    steps = m.lesson.steps.map(s => ({id: s.id, type: s.type,
      label: (L[s.type] || s.type) + (s.mode ? ' · ' + s.mode : ''),
      gate: s.gate ? s.gate.kind : null, has_version: !!s.version, timebox: s.timebox_min}));
  } catch (e) { /* контент недоступен серверу дашборда — панель обойдётся без порядка шагов */ }
  await zAct('/host/gate', {action: 'start', lesson_id: lesson, steps});
}
</script>"""

    if state is None:
        return (js + '<h2>🎓 Занятие (демка З1)</h2>'
                '<div class="lesson-start">Запуск занятия создаст чистый run '
                '(репетиция утром → урок вечером = разные run, §4.1): '
                '<input id="zlesson" value="z1-kot" style="width:140px"> '
                '<button onclick="zStartLesson()">▶ Запустить занятие</button></div>')

    now = _now_ms()
    steps_meta = state.get('steps_meta') or []
    meta_by_id = {s['id']: s for s in steps_meta}
    seats_state = state.get('seats') or {}
    commits = state.get('commits') or {}
    tele = _tele_per_seat(dumps)
    all_seats = sorted(set(list(names.keys()) + list(seats_state.keys())),
                       key=lambda s: (not str(s).isdigit(), int(s) if str(s).isdigit() else 0, str(s)))

    def seat_name(s):
        n = names.get(str(s))
        return (esc(n) + ' (место ' + esc(s) + ')') if n else ('место ' + esc(s))

    def offline(s):
        rec = seats_state.get(str(s)) or {}
        ls = rec.get('last_sync')
        return bool(rec.get('instance')) and (not ls or now - ls > OFFLINE_MS)

    out = [js, '<h2>🎓 Занятие: ' + esc(state.get('lesson_id')) + ' · run ' + esc(state.get('run_id')) +
           '</h2>']
    out.append('<p class="note">текущий шаг: <b>' + esc(state.get('current_step') or 'не открыт') +
               '</b> · <input id="zlesson" value="' + esc(state.get('lesson_id') or 'z1-kot') +
               '" style="width:110px"> <button onclick="if(confirm(\'Новый запуск? Текущий run уйдёт в архив.\'))zStartLesson()">▶ Запустить заново</button></p>')

    # ---- 1. очередь «кому помочь» — топ-кейс КРУПНО ----
    queue = []
    now_dt = datetime.now().astimezone()
    for s in all_seats:
        t = tele.get(str(s)) or {}
        if t.get('stuck_last'):
            age_min = (now_dt - t['stuck_last']).total_seconds() / 60
            if age_min <= STUCK_FRESH_MIN:
                queue.append((0, s, 'жал «застрял» на шаге %s, %d мин назад' %
                              (t.get('stuck_step') or '?', max(0, int(age_min)))))
        if offline(s):
            queue.append((1, s, 'нет связи — поллинг молчит больше минуты'))
    queue.sort()
    if queue:
        out.append('<div class="red"><b>🆘 ' + seat_name(queue[0][1]) + '</b> — ' + esc(queue[0][2]) +
                   '<br><span class="act">→ подойди голосом</span></div>')
        for _, s, why in queue[1:4]:
            out.append('<div class="org"><b>' + seat_name(s) + '</b> — ' + esc(why) + '</div>')
    elif session_live:
        out.append('<p class="note">🟢 в занятии помощь сейчас никому не нужна</p>')

    # ---- 2. reveal-lock по шагам с версией ----
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
        missing_js = json.dumps(missing)
        if rec.get('open'):
            out.append('<div class="lesson-lock">🔓 <b>' + esc(step) + '</b>: разгадка ОТКРЫТА' +
                       (' (override)' if rec.get('override') else '') + '</div>')
            continue
        lock_txt = ('🔒 <b>' + esc(step) + '</b>: ' + str(len(ready)) + '/' +
                    (str(len(n_of)) if n_set is not None else '?— состав не зафиксирован'))
        btns = []
        if n_set is not None and not missing and len(n_of) > 0:
            btns.append('<button onclick="zReveal(\'' + esc(step) + '\')">🔓 Раскрыть</button>')
        else:
            btns.append('<button disabled title="активна при N/N">🔓 Раскрыть</button>')
            if missing:
                btns.append('<button class="warnbtn" onclick=\'zOverride("' + esc(step) + '", ' +
                            missing_js + ')\'>Раскрыть без отвалившегося</button>')
        btns.append('<button onclick="zAct(\'/host/gate\', {action: \'fix_n\', step: \'' +
                    esc(step) + '\'})">Зафиксировать состав сейчас</button>')
        miss_txt = ''
        if missing:
            miss_txt = ('<br><span class="note">ждём: ' +
                        ', '.join(seat_name(s) + (' 📴' if offline(s) else '') for s in missing) + '</span>')
        out.append('<div class="lesson-lock">' + lock_txt + ' ' + ' '.join(btns) + miss_txt + '</div>')

    # ---- 3. гейты ----
    gate_steps = [s for s in steps_meta if s.get('gate')] or \
                 [{'id': g, 'gate': 'code'} for g in (state.get('gates') or {})]
    roster_n = len(names) or len(all_seats)
    grows = []
    for s in gate_steps:
        gid = s['id']
        g = (state.get('gates') or {}).get(gid) or {}
        arrived = g.get('arrived') or []
        code = g.get('code')
        grows.append('<div class="lesson-gate"><b>' + esc(gid) + '</b> (' + esc(s.get('gate')) + '): ' +
                     '<b>' + str(len(arrived)) + ' из ' + str(roster_n) + '</b> перешли' +
                     (' · код: <b class="gatecode">' + esc(code) + '</b>' if code is not None else '') +
                     ' <input id="gcode_' + esc(gid) + '" placeholder="код" style="width:70px">' +
                     '<button onclick="zGateCode(\'' + esc(gid) + '\')">задать</button>' +
                     ' <button onclick="zAct(\'/host/gate\', {action: \'step\', step: \'' + esc(gid) +
                     '\'})">→ сделать текущим</button></div>')
    if grows:
        out.append('<h3>Гейты</h3>' + ''.join(grows))

    # ---- 4. поимённая таблица ----
    rows = []
    for s in all_seats:
        rec = seats_state.get(str(s)) or {}
        snap = store.read_snapshot(state['run_id'], s) or {}
        payload = snap.get('payload') or {}
        t = tele.get(str(s)) or {}
        step_now = rec.get('acked_step') or snap.get('state') or '—'
        label = meta_by_id.get(step_now, {}).get('label', '')
        sc = commits.get(str(s)) or {}
        vcell = fcell = ''
        for st_id, st_commits in sc.items():
            vcell = vcell or _version_cell(st_commits)
            fcell = fcell or _forecast_cell(st_commits)
        reacts = sum(1 for r in (state.get('reactions') or []) if str(r.get('seat')) == str(s))
        reset_btn = ''
        for step in version_steps:
            r = (state.get('reveal') or {}).get(step) or {}
            if not r.get('open') and 'version' in (sc.get(step) or {}):
                reset_btn = ('<button onclick=\'zResetVersion("' + esc(step) + '", "' + esc(s) +
                             '")\'>сбросить версию</button>')
        conn = '📴 нет связи' if offline(s) else ('🟢' if rec.get('instance') else '—')
        rows.append('<tr><td><b>' + seat_name(s) + '</b></td><td>' + esc(step_now) +
                    (' <span class="note">' + esc(label) + '</span>' if label else '') + '</td>' +
                    '<td>' + esc(_fmt_measure(payload)) + '</td>' +
                    '<td>' + (_version_cell_safe(vcell)) + '</td>' +
                    '<td>' + (fcell or '') + '</td>' +
                    '<td>' + (('ур.' + str(t['hint_max'])) if t.get('hint_max') else '') + '</td>' +
                    '<td>' + (str(reacts) if reacts else '') + '</td>' +
                    '<td>' + conn + ' ' + reset_btn + '</td></tr>')
    out.append('<h3>Дети в занятии</h3><table><tr><th>кто</th><th>шаг</th><th>замер</th>'
               '<th>версия</th><th>прогноз</th><th>помощь</th><th>👍</th><th>связь</th></tr>' +
               (''.join(rows) or '<tr><td colspan=8>—</td></tr>') + '</table>'
               '<p class="note">до reveal видно только ФАКТ коммита и текст — без «верно/неверно» '
               '(не подтверждать верный ответ, пока все не записали)</p>')

    # ---- 5. прогресс по шагам ----
    if steps_meta:
        cells = []
        for s in steps_meta:
            here = [x for x in all_seats if (seats_state.get(str(x)) or {}).get('acked_step') == s['id']]
            cur = ' lesson-cur' if state.get('current_step') == s['id'] else ''
            cells.append('<div class="lesson-stepcell' + cur + '"><div class="note">' + esc(s['id']) +
                         '</div><div>' + esc(s.get('label') or s.get('type')) + '</div><b>' +
                         ('·'.join(str(x) for x in here) if here else ' ') + '</b></div>')
        out.append('<h3>Прогресс по блокам</h3><div class="lesson-strip">' + ''.join(cells) +
                   '</div><p class="note">в ячейке — номера мест, чей последний подтверждённый шаг этот</p>')

    # ---- 6. резерв ----
    ra = state.get('reserve_active') or 'none'
    def rbtn(which, label):
        cur = ' style="font-weight:900;border-width:2px"' if ra == which else ''
        return ('<button' + cur + ' onclick="zAct(\'/host/gate\', {action: \'reserve\', which: \'' +
                which + '\'})">' + label + '</button>')
    out.append('<h3>Резервный блок</h3><p>' + rbtn('none', 'выключен') + ' ' +
               rbtn('talk', '🗣 разговорный (r1)') + ' ' + rbtn('trainer', '📦 тренажёрный добор (r2)') +
               ' <span class="note">сейчас: ' + esc(ra) + '</span></p>')

    # ---- 7. чат ----
    chat = (state.get('chat') or [])[-30:]
    if chat:
        out.append('<h3>Чат тренажёра</h3><div class="lesson-chat">' + ''.join(
            '<div><b>' + seat_name(m.get('seat')) + ':</b> ' + esc(m.get('text')) + '</div>'
            for m in chat) + '</div>')

    # ---- лог host-действий (override обязан быть виден — DoD п.4) ----
    log = [l for l in (state.get('log') or []) if l.get('op') in ('override', 'reset_version', 'fix_n')]
    if log:
        out.append('<details><summary>Лог действий ведущего (' + str(len(log)) + ')</summary>' + ''.join(
            '<p class="note">' + esc(l.get('op')) + ' · шаг ' + esc(l.get('step', '')) +
            (' · без мест: ' + esc(','.join(l.get('seat_missing', []))) if l.get('op') == 'override' else '') +
            (' · место ' + esc(l.get('seat')) if l.get('op') == 'reset_version' else '') + '</p>'
            for l in log) + '</details>')

    return ('<div class="lesson-panel">' + ''.join(out) + '</div>'
            '<style>.lesson-panel{background:#fff;border:2px solid #2557d6;border-radius:12px;'
            'padding:12px 16px;margin:14px 0}'
            '.lesson-panel h2{margin:4px 0 8px}.lesson-panel h3{margin:14px 0 4px}'
            '.lesson-lock{background:#eef3ff;border-radius:10px;padding:8px 12px;margin:6px 0;font-size:16px}'
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
            '.lesson-start{font-size:16px}</style>')


def _version_cell_safe(vcell):
    return vcell or ''
