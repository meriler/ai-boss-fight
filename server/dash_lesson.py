#!/usr/bin/env python3
"""Панель занятия фазы 0 — ГЛАВНЫЙ экран /dash (заход И3-Д, план итерации 3 18.07):
«один экран — одна задача». Активен run → страница показывает ТОЛЬКО контур занятия
(воркшоп v5 — за ссылкой «архив», собирает tele.py); нет run → большая кнопка запуска.

Иерархия сверху вниз: статус-строка (run · текущий шаг · «шаг вперёд» · мелко
«запустить заново») → блок «СЕЙЧАС» (очередь помощи, замки reveal, ТЕКУЩИЙ гейт с кодом
крупно) → одна таблица детей Кто·Связь·Шаг·Замер·Версия·Прогноз·Помощь·👍 (проблемные
наверху) → свёртки (неактивные гейты, прогресс, резерв, чат, лог, легенда «как читать»).
Каждый статус — цвет + иконка + слово, не только цвет.

Ведущий НЕ видит «правильно/неправильно» до reveal — только факт коммита и текст (§5).
Host-действия — кнопками fetch POST /host/* (страница за basic auth, Referer-гард).
Контракты ручек НЕ меняются — файл чисто рендерный (DoD И3-Д)."""
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

RESERVE_LABELS = {'none': 'выключен', 'talk': '🗣 разговорный (r1)', 'trainer': '📦 тренажёрный добор (r2)'}


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
            '<button onclick="zGateCode(\'' + esc(gid) + '\')">задать</button>')


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
        bits.append('<button onclick="zAct(\'/host/gate\', {action: \'step\', step: \'' + esc(nxt) +
                    '\'})">→ шаг вперёд: ' + esc(nxt) +
                    ((' · ' + esc(nxt_label)) if nxt_label else '') + '</button>')
    elif step_ids and cur == step_ids[-1]:
        bits.append('<span class="note">последний шаг</span>')
    bits.append('<span class="restart"><input id="zlesson" value="' +
                esc(state.get('lesson_id') or 'z1-kot') + '" style="width:110px"> '
                '<button onclick="if(confirm(\'Новый запуск? Текущий run уйдёт в архив.\'))'
                'zStartLesson()">▶ Запустить заново</button></span>')
    out.append('<div class="statusline">' + ' '.join(bits) + '</div>')

    # ================= блок «СЕЙЧАС»: только активное =================
    now_parts = []

    # ---- очередь «кому помочь» — топ-кейс КРУПНО ----
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
        missing_js = json.dumps(missing)
        if rec.get('open'):
            now_parts.append('<div class="lesson-lock">🔓 <b>' + esc(step) + '</b>: разгадка ОТКРЫТА' +
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
                         (_gate_controls(gid) if s.get('gate') == 'code' else '') +
                         ' <button onclick="zAct(\'/host/gate\', {action: \'step\', step: \'' + esc(gid) +
                         '\'})">→ сделать текущим</button></div>')
        out.append('<details' + (' open' if cur is None else '') + '><summary>⛩ Остальные гейты (' +
                   str(len(other_gates)) + ')</summary>' + ''.join(grows) + '</details>')

    # ---- ОДНА таблица детей: Кто·Связь·Шаг·Замер·Версия·Прогноз·Помощь·👍,
    #      проблемные наверху (паттерн «красные сверху», И3-Д п.2) ----
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
                reset_btn = (' <button onclick=\'zResetVersion("' + esc(step) + '", "' + esc(s) +
                             '")\'>сбросить версию</button>')
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
        if offline(s):
            conn = '📴 НЕТ СВЯЗИ'
            prio = min(prio, 1)
        elif rec.get('instance'):
            conn = '🟢 на связи'
        else:
            conn = '⚪ не открывал'
            prio = min(prio, 2)
        rows.append((prio,
                     (not str(s).isdigit(), int(s) if str(s).isdigit() else 0, str(s)),
                     '<tr class="zr' + str(prio) + '"><td><b>' + seat_name(s) + '</b></td>' +
                     '<td>' + conn + '</td>' +
                     '<td>' + esc(step_now) +
                     (' <span class="note">' + esc(label) + '</span>' if label else '') + '</td>' +
                     '<td>' + esc(_fmt_measure(payload)) + '</td>' +
                     '<td>' + (vcell or '') + reset_btn + '</td>' +
                     '<td>' + (fcell or '') + '</td>' +
                     '<td>' + ' · '.join(help_bits) + '</td>' +
                     '<td>' + (str(reacts) if reacts else '') + '</td></tr>'))
    rows.sort(key=lambda r: (r[0], r[1]))
    out.append('<h3>Дети в занятии</h3><table><tr>'
               '<th title="имя и место из ростера">кто</th>'
               '<th title="🟢 на связи · 📴 нет связи (поллинг молчит >60 сек) · ⚪ не открывал ссылку">связь</th>'
               '<th title="последний подтверждённый шаг ребёнка">шаг</th>'
               '<th title="проверка знаний: до обучения → после">замер</th>'
               '<th title="✓ — записал версию/выбор; текст виден, «верно/неверно» — нет до reveal">версия</th>'
               '<th title="✓ — записал прогноз">прогноз</th>'
               '<th title="🆘 сам нажал «застрял» · ур.N — глубина подсказок">помощь</th>'
               '<th title="сколько раз нажал «получилось!»">👍</th></tr>' +
               (''.join(r[2] for r in rows) or '<tr><td colspan=8>—</td></tr>') + '</table>'
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
                         ('·'.join(str(x) for x in here) if here else ' ') + '</b></div>')
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

    # легенда «как читать панель» — свёртка + тултипы в заголовках колонок (И3-Д п.4)
    out.append(
        '<details><summary>ℹ️ Как читать панель</summary><p>'
        '<b>СЕЙЧАС</b> — только то, что требует действия: очередь помощи, замки разгадки, текущий гейт.<br>'
        '<b>Связь:</b> 🟢 на связи — устройство шлёт синк · 📴 НЕТ СВЯЗИ — поллинг молчит больше минуты '
        '(вкладка закрыта / интернет) · ⚪ не открывал — по ссылке ещё не заходили.<br>'
        '<b>Помощь:</b> 🆘 застрял — ребёнок сам нажал кнопку «застрял» → подойди · '
        'ур.N — до какой по глубине подсказки дошёл (ур.2 — сильная).<br>'
        '<b>Замер:</b> «0/4 → 3/4» — проверка до обучения → после.<br>'
        '<b>Версия/Прогноз:</b> ✓ — ребёнок записал; до «Раскрыть» видно только факт и текст, '
        'БЕЗ «верно/неверно» — не подтверждай верный ответ, пока все не записали.<br>'
        '<b>👍</b> — сколько раз нажал «получилось!».<br>'
        '<b>Гейт:</b> «N из M перешли» — сколько из ростера прошло шаг-гейт; код гейта называешь вслух.<br>'
        '<b>Замок 🔒/🔓:</b> «Раскрыть» откроется при N/N записавших; отвалившегося можно обойти '
        'красной кнопкой (попадёт в лог).<br>'
        'Цвет строки дублируется словом: красная — 🆘 застрял, оранжевая — 📴 нет связи, '
        'жёлтая — ⚪ не открывал.</p></details>')

    return '<div class="lesson-panel">' + ''.join(out) + '</div>' + _STYLE
