#!/usr/bin/env python3
"""Stateful-контур занятия фазы 0 (ТЗ-демка-з1 §4.1) — расширение tele.py, НЕ переписывание.

Новые ручки (маршрутизацию делает tele.py):
  POST /save            — снапшот seat-save (порядок по (writer_generation, rev), не по времени)
  GET  /restore?seat=N  — согласованное представление: снапшот + поверх acked-коммиты (склейка на СЕРВЕРЕ)
  POST /commit          — acked-действия: version/choice/forecast/captcha/gate_enter/step_enter
                          (op_id-дедуп, epoch-гард, single-writer)
  GET  /sync?seat=N&cursor=C — поллинг ~5 c; курсор — монотонный event_seq, НЕ timestamp
  POST /chat, /react    — чат тренажёра и кнопка-реакция (тоже под single-writer)
  POST /host/gate       — старт занятия (run_id + чистый lesson-state), current_step, гейт-коды,
                          резервный блок, ручная фиксация N
  POST /host/reveal     — открыть разгадку (только при N/N)
  POST /host/override   — «раскрыть без отвалившегося» (лог обязателен)
  POST /host/reset_version — сброс ОБОИХ коммитов seat + epoch+1 (ретрай не воскресит версию)

Конкурентность — single-writer: ВСЕ мутации lesson-state идут под одним глобальным локом
(threading.Lock) + атомарная запись tmp→rename. Append-only контракт /tele НЕ трогается,
session-<date>.json (sess_start/sess_stop) НЕ трогается — контур живёт в СВОИХ файлах:
  lesson-current.json           — указатель на текущий run_id
  lesson-state-<run_id>.json    — живое состояние запуска (гейты, коммиты, reveal, чат, ops)
  lesson-save-<run_id>-seat<N>.json — последний снапшот /save по seat

Один живой писатель на seat: пара (client_instance_id, writer_generation); перехват
«Продолжить здесь» = /save с takeover=true → сервер атомарно даёт generation+1; запрос от
старой generation на ЛЮБОЙ мутирующей ручке — отказ {"error": "other_tab"}."""
import json
import os
import random
import threading
import time

MAX_CHAT_LEN = 500
MAX_OPS = 5000          # ledger дедупа: страховка от распухания (занятие — сотни коммитов)


def _now_ms():
    return int(time.time() * 1000)


def _blank_state(run_id, lesson_id):
    return {
        'run_id': run_id,
        'lesson_id': lesson_id,
        'created': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'event_seq': 0,          # монотонный курсор /sync — НЕ timestamp (§4.1)
        'current_step': None,    # канонический шаг занятия (последний открытый ведущим)
        'reserve_active': 'none',
        'gates': {},             # step -> {code, code_shown, arrived: [seat...]}
        'commits': {},           # seat -> step -> type -> {data, ts, op_id, late?}
        'seats': {},             # seat -> {epoch, instance, generation, version_status, acked_step}
        'reveal': {},            # step -> {open, payload_rev, anon_versions, n_set, override}
        'chat': [],              # [{seq, seat, step, text, ts}]
        'reactions': [],         # [{seq, seat, step, ts}]
        'ops': {},               # op_id -> результат (идемпотентность /commit)
        'op_order': [],          # порядок op_id для подрезки ledger'а
        'log': [],               # host-действия: override, reset_version, fix_n, start
        'steps_meta': [],        # снимок шагов занятия для дашборда (кладёт кнопка старта):
                                 # [{id, type, label, gate, has_version, timebox}] — данные, не код
    }


def _seat_rec(state, seat):
    return state['seats'].setdefault(str(seat), {
        'epoch': 0, 'instance': None, 'generation': 0,
        'version_status': 'none', 'acked_step': None,
    })


def _reveal_rec(state, step):
    return state['reveal'].setdefault(step, {
        'open': False, 'payload_rev': 0, 'anon_versions': [],
        'n_set': None, 'override': None,
    })


def _ev(state):
    state['event_seq'] += 1
    return state['event_seq']


class LessonStore:
    """Хранилище состояния занятия. Все мутации — через with_state() под глобальным локом."""

    def __init__(self, data_dir):
        self.dir = data_dir
        self.lock = threading.Lock()
        self._cache = {}          # run_id -> state (в памяти; файл — durability)

    # ---- файлы ----
    def _cur_path(self):
        return os.path.join(self.dir, 'lesson-current.json')

    def _state_path(self, run_id):
        return os.path.join(self.dir, 'lesson-state-%s.json' % run_id)

    def _save_path(self, run_id, seat):
        return os.path.join(self.dir, 'lesson-save-%s-seat%s.json' % (run_id, seat))

    def _write_atomic(self, path, obj):
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False)
        os.replace(tmp, path)

    # ---- текущий запуск ----
    def current_run(self):
        try:
            with open(self._cur_path(), encoding='utf-8') as f:
                return json.load(f).get('run_id')
        except Exception:
            return None

    def _load_state(self, run_id):
        if run_id in self._cache:
            return self._cache[run_id]
        try:
            with open(self._state_path(run_id), encoding='utf-8') as f:
                st = json.load(f)
        except Exception:
            st = None
        if st is not None:
            self._cache[run_id] = st
        return st

    def start_run(self, lesson_id, steps_meta=None):
        """Кнопка старта на дашборде: новый run_id (<date>-<n>) и ЧИСТЫЙ lesson-state.
        Повторный запуск в тот же день = новый n; старый файл остаётся архивом (§4.1).
        steps_meta — снимок шагов занятия для панели дашборда (сервер контент не читает)."""
        with self.lock:
            date = time.strftime('%Y-%m-%d')
            n = 1
            while os.path.exists(self._state_path('%s-%d' % (date, n))):
                n += 1
            run_id = '%s-%d' % (date, n)
            st = _blank_state(run_id, lesson_id)
            if isinstance(steps_meta, list):
                st['steps_meta'] = [
                    {'id': str(s.get('id', '')), 'type': str(s.get('type', '')),
                     'label': str(s.get('label', ''))[:60], 'gate': s.get('gate'),
                     'has_version': bool(s.get('has_version')), 'timebox': s.get('timebox')}
                    for s in steps_meta[:40] if isinstance(s, dict) and s.get('id')]
            st['log'].append({'op': 'start', 'lesson_id': lesson_id, 'ts': _now_ms()})
            self._cache[run_id] = st
            self._write_atomic(self._state_path(run_id), st)
            self._write_atomic(self._cur_path(), {'run_id': run_id})
            return run_id

    def with_state(self, run_id, fn):
        """Выполнить мутацию/чтение состояния под глобальным локом + атомарно записать.
        fn(state) -> (status, resp, dirty). run_id=None → текущий запуск."""
        with self.lock:
            rid = run_id or self.current_run()
            if not rid:
                return 409, {'ok': False, 'error': 'no_run'}
            if run_id and run_id != self.current_run():
                # запрос из прошлого прогона (репетиция утром → урок вечером): не пишем в архив
                return 409, {'ok': False, 'error': 'stale_run', 'run_id': self.current_run()}
            st = self._load_state(rid)
            if st is None:
                return 409, {'ok': False, 'error': 'no_run'}
            status, resp, dirty = fn(st)
            if dirty:
                self._write_atomic(self._state_path(rid), st)
            return status, resp

    # ---- снапшоты /save ----
    def view(self):
        """Глубокая копия состояния текущего запуска для рендера дашборда (читатель
        не должен трогать кэш вне лока)."""
        with self.lock:
            rid = self.current_run()
            if not rid:
                return None
            st = self._load_state(rid)
            return json.loads(json.dumps(st)) if st is not None else None

    def read_snapshot(self, run_id, seat):
        try:
            with open(self._save_path(run_id, seat), encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return None

    def write_snapshot(self, run_id, seat, snap):
        self._write_atomic(self._save_path(run_id, seat), snap)


# ==================== single-writer / epoch ====================

def _check_writer(state, seat, instance, generation, claim=True):
    """Один живой писатель на seat (§1.1). Возвращает (ok, err_resp|None).
    Свободный seat занимается первым пришедшим инстансом (claim); дальше право
    подтверждается парой (instance, generation) — чужая пара получает other_tab."""
    rec = _seat_rec(state, seat)
    if rec['instance'] is None:
        if not claim:
            return False, {'ok': False, 'error': 'other_tab', 'writer_generation': rec['generation']}
        rec['instance'] = instance
        rec['generation'] = max(1, int(generation or 1))
        return True, None
    if rec['instance'] == instance and rec['generation'] == int(generation or 0):
        return True, None
    return False, {'ok': False, 'error': 'other_tab', 'writer_generation': rec['generation']}


# ==================== /save ====================

def api_save(store, body):
    seat = str(body.get('seat', ''))
    instance = str(body.get('client_instance_id', ''))
    generation = body.get('writer_generation', 0)
    rev = body.get('rev')
    if not seat or not instance or not isinstance(rev, int):
        return 400, {'ok': False, 'error': 'bad_request'}

    def fn(state):
        rec = _seat_rec(state, seat)
        if body.get('takeover'):
            # атомарный перехват «Продолжить здесь»: generation+1, право у нового инстанса
            rec['instance'] = instance
            rec['generation'] += 1
            _ev(state)
        else:
            ok, err = _check_writer(state, seat, instance, generation)
            if not ok:
                return 409, err, False
        gen = rec['generation']
        snap = store.read_snapshot(state['run_id'], seat)
        old = (snap.get('writer_generation', 0), snap.get('rev', -1)) if snap else (-1, -1)
        if (gen, rev) < old:
            return 409, {'ok': False, 'error': 'stale', 'accepted_rev': old[1],
                         'writer_generation': gen}, False
        if (gen, rev) > old:   # равный (gen, rev) — идемпотентный повтор, ok/no-op
            store.write_snapshot(state['run_id'], seat, {
                'seat': seat, 'run_id': state['run_id'],
                'writer_generation': gen, 'rev': rev,
                'lesson_id': body.get('lesson_id'),
                'state': body.get('state'), 'payload': body.get('payload'),
                'ts': body.get('ts', _now_ms()),
            })
        return 200, {'ok': True, 'accepted_rev': rev, 'writer_generation': gen,
                     'epoch': rec['epoch'], 'run_id': state['run_id']}, True

    return store.with_state(body.get('run_id'), fn)


# ==================== /restore ====================

def api_restore(store, seat):
    """Согласованное представление — склейку делает СЕРВЕР: последний снапшот /save
    + поверх авторитетные acked-коммиты seat из lesson-state (§4.1). F5 в окне
    «/commit принят, дебаунс-сейв не доехал» НЕ откатывает принятую версию/гейт."""
    seat = str(seat)

    def fn(state):
        snap = store.read_snapshot(state['run_id'], seat) or {}
        rec = _seat_rec(state, seat)
        acked = state['commits'].get(seat, {})
        return 200, {
            'ok': True,
            'run_id': state['run_id'],
            'lesson_id': state['lesson_id'],
            'writer_generation': rec['generation'],
            'epoch': rec['epoch'],
            'server_rev': snap.get('rev', 0),
            'state': snap.get('state'),
            'payload': snap.get('payload'),
            'acked': acked,                      # авторитетный слой ПОВЕРХ payload
            'acked_step': rec['acked_step'],
            'current_step': state['current_step'],
            'version_status': rec['version_status'],
        }, False

    return store.with_state(None, fn)


# ==================== /commit ====================

COMMIT_TYPES = ('version', 'choice', 'forecast', 'captcha', 'gate_enter', 'step_enter')


def _first_gate_arrivals(state):
    """N для reveal-lock: seats с успешным gate_enter на момент фиксации (§4.1).
    Гарантированные no-show в N не попадают и reveal не блокируют."""
    seats = []
    for gate in state['gates'].values():
        for s in gate.get('arrived', []):
            if s not in seats:
                seats.append(s)
    return seats


def api_commit(store, body):
    seat = str(body.get('seat', ''))
    instance = str(body.get('client_instance_id', ''))
    generation = body.get('writer_generation', 0)
    op_id = str(body.get('op_id', ''))
    ctype = body.get('type')
    step = str(body.get('step', ''))
    payload = body.get('payload') or {}
    if not seat or not instance or not op_id or ctype not in COMMIT_TYPES or not step:
        return 400, {'ok': False, 'error': 'bad_request'}

    def fn(state):
        # порядок гардов: writer → epoch → дедуп. Epoch ДО дедупа: залипший ретрай
        # отменённого коммита обязан получить отказ, а не сохранённый старый результат.
        ok, err = _check_writer(state, seat, instance, generation)
        if not ok:
            return 409, err, False
        rec = _seat_rec(state, seat)
        if int(body.get('epoch', 0)) != rec['epoch']:
            return 409, {'ok': False, 'error': 'stale_epoch', 'epoch': rec['epoch']}, False
        if op_id in state['ops']:
            return 200, dict(state['ops'][op_id], replay=True), False

        result = {'ok': True, 'type': ctype, 'step': step}

        if ctype == 'gate_enter':
            gate = state['gates'].setdefault(step, {'code': None, 'code_shown': False, 'arrived': []})
            if gate['code'] is not None:
                if str(payload.get('code', '')) != str(gate['code']):
                    return 409, {'ok': False, 'error': 'bad_code'}, False   # не в ledger: новая попытка = новый op
            if seat not in gate['arrived']:
                gate['arrived'].append(seat)
                _ev(state)
            rec['acked_step'] = step

        elif ctype == 'step_enter':
            rec['acked_step'] = step
            _ev(state)

        else:   # version / choice / forecast / captcha — приватные коммиты
            seat_commits = state['commits'].setdefault(seat, {})
            step_commits = seat_commits.setdefault(step, {})
            entry = {'data': payload, 'ts': _now_ms(), 'op_id': op_id}
            if ctype == 'version':
                rev_rec = _reveal_rec(state, step)
                if rev_rec['n_set'] is None:
                    # фиксация состава N на момент ПЕРВОГО version_committed шага
                    rev_rec['n_set'] = _first_gate_arrivals(state)
                    state['log'].append({'op': 'fix_n', 'step': step, 'auto': True,
                                         'n_set': list(rev_rec['n_set']), 'ts': _now_ms()})
                late = (seat not in rev_rec['n_set']) or rev_rec['open'] or bool(rev_rec['override'])
                if late:
                    entry['late'] = True
                    result['late'] = True
                    if rev_rec['open']:
                        # доклейка поздней версии в анонимную подборку (payload_rev+1)
                        rev_rec['anon_versions'].append(payload)
                        rev_rec['payload_rev'] += 1
                rec['version_status'] = 'committed'
            step_commits[ctype] = entry
            _ev(state)

        state['ops'][op_id] = result
        state['op_order'].append(op_id)
        if len(state['op_order']) > MAX_OPS:
            for old in state['op_order'][:len(state['op_order']) - MAX_OPS]:
                state['ops'].pop(old, None)
            state['op_order'] = state['op_order'][-MAX_OPS:]
        return 200, result, True

    return store.with_state(body.get('run_id'), fn)


# ==================== /sync ====================

def api_sync(store, seat, cursor):
    seat = str(seat)
    try:
        cursor = int(cursor or 0)
    except ValueError:
        cursor = 0

    def fn(state):
        rec = _seat_rec(state, seat)
        rec['last_sync'] = _now_ms()   # только в памяти (dirty=False): лампа «нет связи» на дашборде
        reveal = {}
        for step, r in state['reveal'].items():
            item = {'open': r['open'], 'payload_rev': r['payload_rev']}
            if r['open']:
                item['anon_versions'] = r['anon_versions']
            reveal[step] = item
        gates = {}
        for step, g in state['gates'].items():
            gates[step] = {'code': g['code'] if g.get('code_shown') else None,
                           'arrived': g['arrived']}
        chat_delta = [m for m in state['chat'] if m['seq'] > cursor]
        return 200, {
            'ok': True,
            'run_id': state['run_id'],
            'next_cursor': state['event_seq'],
            'current_step': state['current_step'],
            'reserve_active': state['reserve_active'],
            'reveal': reveal,
            'gate': gates,
            'seat': {'version_status': rec['version_status'], 'epoch': rec['epoch'],
                     'writer_generation': rec['generation']},
            'chat_delta': chat_delta,
            'reactions_count': len(state['reactions']),
        }, False

    return store.with_state(None, fn)


# ==================== /chat, /react ====================

def api_chat(store, body):
    seat = str(body.get('seat', ''))
    text = str(body.get('text', ''))[:MAX_CHAT_LEN]
    if not seat or not text.strip():
        return 400, {'ok': False, 'error': 'bad_request'}

    def fn(state):
        ok, err = _check_writer(state, seat, str(body.get('client_instance_id', '')),
                                body.get('writer_generation', 0))
        if not ok:
            return 409, err, False
        seq = _ev(state)
        state['chat'].append({'seq': seq, 'seat': seat, 'step': str(body.get('step', '')),
                              'text': text, 'ts': _now_ms()})
        return 200, {'ok': True, 'seq': seq}, True

    return store.with_state(body.get('run_id'), fn)


def api_react(store, body):
    seat = str(body.get('seat', ''))
    if not seat:
        return 400, {'ok': False, 'error': 'bad_request'}

    def fn(state):
        ok, err = _check_writer(state, seat, str(body.get('client_instance_id', '')),
                                body.get('writer_generation', 0))
        if not ok:
            return 409, err, False
        seq = _ev(state)
        state['reactions'].append({'seq': seq, 'seat': seat,
                                   'step': str(body.get('step', '')), 'ts': _now_ms()})
        return 200, {'ok': True, 'seq': seq}, True

    return store.with_state(body.get('run_id'), fn)


# ==================== host-ручки (за basic auth nginx, Referer-гард в tele.py) ====================

def _ready_seats(state, step):
    """Готовность к reveal = ОБА acked-коммита шага: version И choice (§4.1)."""
    ready = []
    for seat, steps in state['commits'].items():
        sc = steps.get(step, {})
        if 'version' in sc and 'choice' in sc:
            ready.append(seat)
    return ready


def api_host_gate(store, body):
    action = body.get('action')
    if action == 'start':
        lesson_id = str(body.get('lesson_id', '') or 'z1-kot')
        run_id = store.start_run(lesson_id, steps_meta=body.get('steps'))
        return 200, {'ok': True, 'run_id': run_id}

    def fn(state):
        if action == 'step':
            state['current_step'] = str(body.get('step', ''))
            _ev(state)
            return 200, {'ok': True, 'current_step': state['current_step']}, True
        if action == 'code':
            step = str(body.get('step', ''))
            gate = state['gates'].setdefault(step, {'code': None, 'code_shown': False, 'arrived': []})
            if 'code' in body:
                gate['code'] = str(body['code'])
            if 'show' in body:
                gate['code_shown'] = bool(body['show'])
            _ev(state)
            return 200, {'ok': True, 'gate': gate}, True
        if action == 'reserve':
            which = body.get('which')
            if which not in ('none', 'talk', 'trainer'):
                return 400, {'ok': False, 'error': 'bad_request'}, False
            state['reserve_active'] = which
            _ev(state)
            return 200, {'ok': True, 'reserve_active': which}, True
        if action == 'fix_n':
            step = str(body.get('step', ''))
            rec = _reveal_rec(state, step)
            rec['n_set'] = _first_gate_arrivals(state)
            state['log'].append({'op': 'fix_n', 'step': step, 'auto': False,
                                 'n_set': list(rec['n_set']), 'ts': _now_ms()})
            _ev(state)
            return 200, {'ok': True, 'n_set': rec['n_set']}, True
        return 400, {'ok': False, 'error': 'bad_action'}, False

    return store.with_state(body.get('run_id'), fn)


def _anon_versions(state, step):
    """Анонимная подборка: тексты версий БЕЗ имён/мест, в перемешанном порядке."""
    versions = []
    for _seat, steps in state['commits'].items():
        v = steps.get(step, {}).get('version')
        if v:
            versions.append(v['data'])
    random.shuffle(versions)
    return versions


def api_host_reveal(store, body):
    step = str(body.get('step', ''))
    if not step:
        return 400, {'ok': False, 'error': 'bad_request'}

    def fn(state):
        rec = _reveal_rec(state, step)
        if rec['open']:
            return 200, {'ok': True, 'already': True}, False
        n_set = rec['n_set'] if rec['n_set'] is not None else _first_gate_arrivals(state)
        ready = _ready_seats(state, step)
        missing = [s for s in n_set if s not in ready]
        if missing and not rec['override']:
            return 409, {'ok': False, 'error': 'not_ready', 'missing': missing,
                         'ready': ready, 'n_set': n_set}, False
        rec['open'] = True
        rec['anon_versions'] = _anon_versions(state, step)
        rec['payload_rev'] += 1
        _ev(state)
        return 200, {'ok': True, 'n': len(ready), 'of': len(n_set)}, True

    return store.with_state(body.get('run_id'), fn)


def api_host_override(store, body):
    step = str(body.get('step', ''))
    seat_missing = [str(s) for s in body.get('seat_missing', [])]
    if not step:
        return 400, {'ok': False, 'error': 'bad_request'}

    def fn(state):
        rec = _reveal_rec(state, step)
        rec['override'] = {'seat_missing': seat_missing, 'ts': _now_ms()}
        state['log'].append({'op': 'override', 'step': step,
                             'seat_missing': seat_missing, 'ts': _now_ms()})
        rec['open'] = True
        rec['anon_versions'] = _anon_versions(state, step)
        rec['payload_rev'] += 1
        _ev(state)
        return 200, {'ok': True}, True

    return store.with_state(body.get('run_id'), fn)


def api_host_reset_version(store, body):
    """«Я не то нажал!»: снимает ОБА коммита (version И choice), декрементирует готовность
    reveal-lock, инкрементирует epoch — залипший ретрай старого коммита отклоняется по epoch.
    Активна ТОЛЬКО до reveal."""
    seat = str(body.get('seat', ''))
    step = str(body.get('step', ''))
    if not seat or not step:
        return 400, {'ok': False, 'error': 'bad_request'}

    def fn(state):
        rec = _reveal_rec(state, step)
        if rec['open']:
            return 409, {'ok': False, 'error': 'already_revealed'}, False
        seat_rec = _seat_rec(state, seat)
        step_commits = state['commits'].get(seat, {}).get(step, {})
        step_commits.pop('version', None)
        step_commits.pop('choice', None)
        seat_rec['epoch'] += 1
        seat_rec['version_status'] = 'reset'
        state['log'].append({'op': 'reset_version', 'seat': seat, 'step': step, 'ts': _now_ms()})
        _ev(state)
        return 200, {'ok': True, 'epoch': seat_rec['epoch']}, True

    return store.with_state(body.get('run_id'), fn)


# ==================== HTTP-глю (вызывается из tele.py) ====================

POST_HANDLERS = {
    '/save': api_save,
    '/commit': api_commit,
    '/chat': api_chat,
    '/react': api_react,
    '/host/gate': api_host_gate,
    '/host/reveal': api_host_reveal,
    '/host/override': api_host_override,
    '/host/reset_version': api_host_reset_version,
}


def handle_post(store, path, body):
    handler = POST_HANDLERS.get(path)
    if handler is None:
        return 404, {'ok': False, 'error': 'not_found'}
    return handler(store, body)


def handle_get(store, path, q):
    """q — dict из parse_qs (значения-списки)."""
    one = lambda k, d='': (q.get(k) or [d])[0]
    if path == '/restore':
        if not one('seat'):
            return 400, {'ok': False, 'error': 'bad_request'}
        return api_restore(store, one('seat'))
    if path == '/sync':
        if not one('seat'):
            return 400, {'ok': False, 'error': 'bad_request'}
        return api_sync(store, one('seat'), one('cursor', '0'))
    return 404, {'ok': False, 'error': 'not_found'}
