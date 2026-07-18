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
  POST /host/reveal     — открыть разгадку (только при N/N, непустой состав)
  POST /host/override   — «раскрыть без отвалившегося» (лог обязателен)
  POST /host/reset_version — сброс ОБОИХ коммитов seat + epoch+1 (ретрай не воскресит версию)

Конкурентность — single-writer: ВСЕ мутации lesson-state идут под одним глобальным локом,
но критическая секция короткая — только память + сериализация (закалка 18.07, high 6):
файловый I/O идёт ВНЕ глобального лока под отдельным _io_lock с порядковыми номерами
(поздний писатель не затирает ранним), SQLite-тень — асинхронно из очереди в своём потоке.
Порядок записи одной мутации: lesson-state → снапшоты (закалка 18.07, critical 3 —
сбой между ними оставляет СТАРЫЙ снапшот при новом state, что чинится ретраем клиента,
а не «новый payload при старых epoch/writer»). Append-only контракт /tele НЕ трогается,
session-<date>.json (sess_start/sess_stop) НЕ трогается — контур живёт в СВОИХ файлах:
  lesson-current.json           — указатель на текущий run_id
  lesson-state-<run_id>.json    — живое состояние запуска (гейты, коммиты, reveal, чат, ops)
  lesson-save-<run_id>-seat<N>.json — последний снапшот /save по seat

Один живой писатель на seat: пара (client_instance_id, writer_generation); перехват
«Продолжить здесь» = /save с takeover=true → сервер атомарно даёт generation+1 (повтор
того же инстанса идемпотентен — generation не растёт); запрос от старой generation на
ЛЮБОЙ мутирующей ручке — отказ {"error": "other_tab"}."""
import json
import os
import queue
import random
import re
import threading
import time

import lesson_db   # SQLite-тень M1 (ТЗ-платформа-v3 §4.2): dual-write, чтение — из файлов

MAX_CHAT_LEN = 500
# ledger дедупа: страховка от распухания. Обрезка = окно повторного исполнения очень
# старого ретрая (закалка 18.07, high 4) — потолок поднят так, чтобы целое занятие
# (сотни коммитов на 8-30 детей) заведомо помещалось без обрезки.
MAX_OPS = 20000
# Квоты на seat (закалка 18.07, принятый риск 3: полный rate-limit слой не строим —
# публичный вход лимитирует nginx; здесь — дешёвые предохранители от распухания state)
MAX_CHAT_PER_SEAT = 200
MAX_REACT_PER_SEAT = 300
MAX_STEPS_PER_SEAT = 64

# Валидация идентификаторов на ГРАНИЦЕ API (закалка 18.07, critical XSS + квоты):
# seat — только числа ростера; step — id шага занятия; произвольные строки в state
# не попадают. Рендер дашборда ДОПОЛНИТЕЛЬНО эскейпит всё (defense in depth).
_SEAT_RE = re.compile(r'^\d{1,3}$')
_STEP_RE = re.compile(r'^[A-Za-z0-9_.:-]{1,40}$')
MAX_INSTANCE_LEN = 64
MAX_OP_ID_LEN = 80


def _now_ms():
    return int(time.time() * 1000)


def _valid_seat(seat):
    return bool(_SEAT_RE.fullmatch(seat))


def _valid_step(step):
    return bool(_STEP_RE.fullmatch(step))


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
        'ops': {},               # op_id -> результат+отпечаток (идемпотентность /commit и др.)
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


def _op_replay(state, op_id, seat, ctype, step):
    """Дедуп-леджер сверяет ОТПЕЧАТОК операции (закалка 18.07, high 4): коллизия op_id
    с другим (seat, type, step) — это не replay, а потеря новой мутации → явный отказ.
    Возвращает (has_entry, response|None): (True, resp) — честный replay,
    (True, 409-resp) — конфликт, (False, None) — op новый."""
    prev = state['ops'].get(op_id)
    if prev is None:
        return False, None
    if prev.get('seat') is not None and \
            (prev.get('seat'), prev.get('type'), prev.get('step')) != (seat, ctype, step):
        return True, (409, {'ok': False, 'error': 'op_conflict'})
    return True, (200, dict(prev, replay=True))


def _op_record(state, op_id, result):
    """Записать результат операции в ledger + подрезать хвост."""
    state['ops'][op_id] = result
    state['op_order'].append(op_id)
    if len(state['op_order']) > MAX_OPS:
        for old in state['op_order'][:len(state['op_order']) - MAX_OPS]:
            state['ops'].pop(old, None)
        state['op_order'] = state['op_order'][-MAX_OPS:]


class LessonStore:
    """Хранилище состояния занятия. Все мутации — через with_state(): память под глобальным
    self.lock (короткая критическая секция), файлы — под _io_lock вне его, тень — из очереди
    в фоновом потоке (_shadow_worker)."""

    def __init__(self, data_dir, db_path=None):
        self.dir = data_dir
        self.lock = threading.Lock()       # память состояния (короткая секция)
        self._io_lock = threading.Lock()   # порядок файловых записей
        self._cache = {}          # run_id -> state (в памяти; файл — durability)
        self._snap_cache = {}     # (run_id, seat) -> последний снапшот (память впереди диска
                                  # на время I/O — ordering-решения /save читают отсюда)
        self._cur = None          # кэш указателя current run (файл — источник при старте)
        self._cur_loaded = False
        # порядковые номера записей: поздний файловый писатель не затирается ранним
        self._state_seq, self._state_written = {}, {}
        self._snap_seq, self._snap_written = {}, {}
        # последняя активность контура (любой /save|/commit|/sync|/restore…) — В ПАМЯТИ:
        # /sync файлов не трогает (last_sync — dirty=False), поэтому busy-проверка деплоя
        # по mtime файлов живых детей не видит; ручка /busy отдаёт этот таймстемп
        # (Codex-ревью 18.07, находка 3)
        self.last_activity = None
        # SQLite-тень M1: dual-write на мутациях, ЧТЕНИЕ ОСТАЁТСЯ ИЗ ФАЙЛОВ (M2 — отдельно).
        # Флага нет → тень выключена, поведение фазы 0 байт-в-байт. Ошибки тени глотаются.
        # Зеркалится АСИНХРОННО из очереди (закалка 18.07, high 6): SQLite и его
        # busy_timeout больше не сидят в критической секции запросов детей.
        self._pend_snaps = []     # снапшоты текущей мутации (под self.lock, до постановки в очередь)
        self._shadow_pending = []  # снапшоты, чьё зеркало провалилось (владелец — worker-поток)
        self._shadow_q = queue.Queue(maxsize=10000)
        self._shadow_thread = None
        path = db_path if db_path is not None else lesson_db.db_path_from_env(data_dir)
        self.shadow = lesson_db.open_shadow(path) if path else None
        if self.shadow:
            self.shadow.backfill(data_dir, current_run=self.current_run())
            self._shadow_thread = threading.Thread(target=self._shadow_worker, daemon=True)
            self._shadow_thread.start()

    # ---- файлы ----
    def _cur_path(self):
        return os.path.join(self.dir, 'lesson-current.json')

    def _state_path(self, run_id):
        return os.path.join(self.dir, 'lesson-state-%s.json' % run_id)

    def _save_path(self, run_id, seat):
        return os.path.join(self.dir, 'lesson-save-%s-seat%s.json' % (run_id, seat))

    def _write_atomic_str(self, path, data):
        # ПРИНЯТЫЙ РИСК фазы 0 (аудит 18.07, medium 1): fsync файла/каталога не делаем —
        # при power loss возможна потеря хвоста. Тень + pre-deploy tar достаточны.
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(data)
        os.replace(tmp, path)

    def _write_atomic(self, path, obj):
        self._write_atomic_str(path, json.dumps(obj, ensure_ascii=False))

    # ---- текущий запуск ----
    def current_run(self):
        if self._cur_loaded:
            return self._cur
        try:
            with open(self._cur_path(), encoding='utf-8') as f:
                self._cur = json.load(f).get('run_id')
        except Exception:
            self._cur = None
        self._cur_loaded = True
        return self._cur

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
        steps_meta — снимок шагов занятия для панели дашборда (сервер контент не читает).
        Редкая host-операция: файлы пишутся прямо под локом, без выноса в I/O-секцию."""
        with self.lock:
            self.last_activity = time.time()
            date = time.strftime('%Y-%m-%d')
            n = 1
            while os.path.exists(self._state_path('%s-%d' % (date, n))):
                n += 1
            run_id = '%s-%d' % (date, n)
            st = _blank_state(run_id, lesson_id)
            if isinstance(steps_meta, list):
                st['steps_meta'] = [
                    {'id': str(s.get('id', ''))[:40], 'type': str(s.get('type', ''))[:40],
                     'label': str(s.get('label', ''))[:60], 'gate': s.get('gate'),
                     'has_version': bool(s.get('has_version')), 'timebox': s.get('timebox')}
                    for s in steps_meta[:40] if isinstance(s, dict) and s.get('id')]
            st['log'].append({'op': 'start', 'lesson_id': lesson_id, 'ts': _now_ms()})
            # кэш снапшотов прежних run'ов больше не нужен (они архив) — не копим память
            self._snap_cache = {k: v for k, v in self._snap_cache.items() if k[0] == run_id}
            self._cache[run_id] = st
            state_str = json.dumps(st, ensure_ascii=False)
            self._write_atomic_str(self._state_path(run_id), state_str)
            self._write_atomic(self._cur_path(), {'run_id': run_id})
            self._cur, self._cur_loaded = run_id, True
            self._state_seq[run_id] = self._state_written[run_id] = 1
            self._shadow_enqueue(state_str, [], run_id)
            return run_id

    def with_state(self, run_id, fn):
        """Выполнить мутацию/чтение состояния: память — под глобальным локом, файлы —
        вне его (см. докстринг модуля). fn(state) -> (status, resp, dirty).
        run_id=None → текущий запуск. Сбой файловой записи → память откатывается
        перечтением с диска (кэш сбрасывается), исключение уходит клиенту (ретрай)."""
        with self.lock:
            self.last_activity = time.time()
            rid = run_id or self.current_run()
            if not rid:
                return 409, {'ok': False, 'error': 'no_run'}
            if run_id and run_id != self.current_run():
                # запрос из прошлого прогона (репетиция утром → урок вечером): не пишем в архив
                return 409, {'ok': False, 'error': 'stale_run', 'run_id': self.current_run()}
            st = self._load_state(rid)
            if st is None:
                return 409, {'ok': False, 'error': 'no_run'}
            try:
                status, resp, dirty = fn(st)
            except BaseException:
                # мутация могла частично изменить память: откат = сброс кэша (перечтение файла)
                self._drop_run_caches(rid)
                self._pend_snaps = []
                raise
            snaps, self._pend_snaps = self._pend_snaps, []
            if not dirty and not snaps:
                return status, resp
            state_str = None
            sseq = 0
            if dirty:
                state_str = json.dumps(st, ensure_ascii=False)   # согласованная копия под локом
                self._state_seq[rid] = sseq = self._state_seq.get(rid, 0) + 1
            snap_items = []
            for r, seat, snap in snaps:
                key = (r, seat)
                self._snap_seq[key] = self._snap_seq.get(key, 0) + 1
                snap_items.append((key, self._snap_seq[key],
                                   json.dumps(snap, ensure_ascii=False), snap))
        # ---- вне self.lock: файловый I/O; порядок мутации: state → снапшоты (critical 3) ----
        try:
            with self._io_lock:
                if dirty and sseq > self._state_written.get(rid, 0):
                    self._write_atomic_str(self._state_path(rid), state_str)
                    self._state_written[rid] = sseq
                for key, q_seq, snap_str, _snap in snap_items:
                    if q_seq > self._snap_written.get(key, 0):
                        self._write_atomic_str(self._save_path(*key), snap_str)
                        self._snap_written[key] = q_seq
        except BaseException:
            with self.lock:
                self._drop_run_caches(rid)   # память впереди файла — откат к диску
            raise
        self._shadow_enqueue(state_str, [(k[0], k[1], snap) for k, _q, _s, snap in snap_items],
                             self.current_run())
        return status, resp

    def _drop_run_caches(self, rid):
        """Откат памяти run'а к диску (вызывается под self.lock)."""
        self._cache.pop(rid, None)
        for key in [k for k in self._snap_cache if k[0] == rid]:
            self._snap_cache.pop(key, None)

    # ---- SQLite-тень: очередь + фоновый поток (закалка 18.07, high 6) ----
    def _shadow_enqueue(self, state_str, snaps, current_run):
        if not self.shadow:
            return
        try:
            self._shadow_q.put_nowait((state_str, snaps, current_run))
        except queue.Full:   # тень безнадёжно отстала: state самовосстановится следующим зеркалом
            self.shadow._log_err('enqueue', RuntimeError('очередь тени переполнена — элемент пропущен'))

    def _shadow_worker(self):
        """Единственный поток, трогающий SQLite после backfill: «свой лок» тени — сам поток.
        Провал зеркала: state самовосстановится следующей dirty-мутацией (полная перезапись
        строк run'а), снапшоты удерживаются в _shadow_pending до успеха (Codex-ревью 18.07,
        находка 1); каждый проход чинит и meta.current_run (закалка 18.07, high 9)."""
        while True:
            try:
                item = self._shadow_q.get(timeout=1.0)
            except queue.Empty:
                # тишина — шанс дослать удержанные снапшоты без ожидания новой мутации
                if self._shadow_pending and \
                        self.shadow.mirror_mutation(None, self._shadow_pending,
                                                    set_current=self.current_run()):
                    self._shadow_pending = []
                continue
            if item is None:
                self._shadow_q.task_done()
                return
            state_str, snaps, current = item
            try:
                state = json.loads(state_str) if state_str else None
                batch = self._shadow_pending + list(snaps)
                if self.shadow.mirror_mutation(state, batch, set_current=current):
                    self._shadow_pending = []
                else:
                    last = {}   # дедуп по (run, seat): при мёртвой тени очередь не растёт
                    for run_id, seat, snap in batch:
                        last[(run_id, seat)] = snap
                    self._shadow_pending = [(r, s, sn) for (r, s), sn in last.items()]
            except Exception as e:   # noqa: BLE001 — worker не имеет права умереть
                self.shadow._log_err('shadow_worker', e)
            finally:
                self._shadow_q.task_done()

    def shadow_drain(self, timeout=5.0):
        """Дождаться, пока очередь тени опустеет (тесты, parity, SIGTERM деплоя).
        True — дренаж успел; удержанные из-за ошибок снапшоты могут остаться в
        _shadow_pending (это не «не успел», а «тень мертва»)."""
        if not self.shadow:
            return True
        q = self._shadow_q
        end = time.time() + timeout
        with q.all_tasks_done:
            while q.unfinished_tasks:
                left = end - time.time()
                if left <= 0:
                    return False
                q.all_tasks_done.wait(left)
        return True

    def close(self):
        """Штатная остановка (SIGTERM деплоя, тесты): дренаж тени + стоп worker'а."""
        if self.shadow:
            self.shadow_drain(3.0)
            if self._shadow_thread and self._shadow_thread.is_alive():
                self._shadow_q.put(None)
                self._shadow_thread.join(timeout=3.0)
            try:
                self.shadow.con.close()
            except Exception:   # noqa: BLE001
                pass

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
        """Память-впереди-диска: ordering-решения /save обязаны видеть снапшот,
        который ещё едет в I/O-секции (иначе гонка на коротком локе)."""
        key = (run_id, str(seat))
        if key in self._snap_cache:
            return self._snap_cache[key]
        try:
            with open(self._save_path(run_id, seat), encoding='utf-8') as f:
                snap = json.load(f)
        except Exception:
            return None
        self._snap_cache[key] = snap
        return snap

    def write_snapshot(self, run_id, seat, snap):
        """Вызывается ИЗ fn под self.lock: кладёт снапшот в память и в очередь записи
        текущей мутации (файл запишет with_state в I/O-секции ПОСЛЕ state)."""
        self._snap_cache[(run_id, str(seat))] = snap
        self._pend_snaps.append((run_id, str(seat), snap))


# ==================== single-writer / epoch ====================

def _check_writer(state, seat, instance, generation, claim=True):
    """Один живой писатель на seat (§1.1). Возвращает (ok, err_resp|None, claim_prev).
    Свободный seat занимается первым пришедшим инстансом (claim); дальше право
    подтверждается парой (instance, generation) — чужая пара получает other_tab.
    claim_prev — прежняя пара (instance, generation), если claim только что случился:
    обработчик ОБЯЗАН откатить его через _unclaim при любом последующем отказе
    (закалка 18.07, high 5 — иначе неудачный запрос занимает seat в памяти
    при dirty=False и блокирует настоящую вкладку)."""
    rec = _seat_rec(state, seat)
    if rec['instance'] is None:
        if not claim:
            return False, {'ok': False, 'error': 'other_tab',
                           'writer_generation': rec['generation']}, None
        prev = (rec['instance'], rec['generation'])
        rec['instance'] = instance
        rec['generation'] = max(1, int(generation or 1))
        return True, None, prev
    if rec['instance'] == instance and rec['generation'] == int(generation or 0):
        return True, None, None
    return False, {'ok': False, 'error': 'other_tab',
                   'writer_generation': rec['generation']}, None


def _unclaim(state, seat, claim_prev):
    """Откат свежего claim'а при отказе мутации (см. _check_writer)."""
    if claim_prev is not None:
        rec = _seat_rec(state, seat)
        rec['instance'], rec['generation'] = claim_prev


def _check_epoch(body, rec):
    """Epoch-гард мутаций. Возвращает (ok, warning|None).
    'epoch' в теле → строгое сравнение. Ключа НЕТ → старый клиент (rolling deploy,
    аудит merged 18.07, critical 2): принимаем с warning, но ТОЛЬКО пока у seat
    epoch=0 — после /host/reset_version легаси-снапшот с отменённой версией
    по-прежнему отклоняется (критерий critical «reset» важнее совместимости)."""
    if 'epoch' in body:
        try:
            return int(body.get('epoch')) == rec['epoch'], None
        except (TypeError, ValueError):
            return False, None
    if rec['epoch'] == 0:
        return True, 'no_epoch_legacy'
    return False, None


# ==================== /save ====================

def api_save(store, body):
    seat = str(body.get('seat', ''))
    instance = str(body.get('client_instance_id', ''))
    generation = body.get('writer_generation', 0)
    rev = body.get('rev')
    if not _valid_seat(seat) or not instance or len(instance) > MAX_INSTANCE_LEN:
        return 400, {'ok': False, 'error': 'bad_request'}
    takeover = bool(body.get('takeover'))
    if not takeover and not isinstance(rev, int):
        return 400, {'ok': False, 'error': 'bad_request'}
    # типы полей снапшота: кривое тело не должно позже ронять рендер дашборда
    # (закалка 18.07, high 8) — отсекаем на границе
    if body.get('payload') is not None and not isinstance(body.get('payload'), dict):
        return 400, {'ok': False, 'error': 'bad_request'}
    if body.get('suspended') is not None and not isinstance(body.get('suspended'), dict):
        return 400, {'ok': False, 'error': 'bad_request'}
    if body.get('state') is not None and not isinstance(body.get('state'), (str, dict)):
        return 400, {'ok': False, 'error': 'bad_request'}

    def fn(state):
        rec = _seat_rec(state, seat)
        if takeover:
            # CLAIM-ONLY перехват «Продолжить здесь» (аудит ядра 18.07, critical 3):
            # атомарно generation+1 и право новому инстансу, но payload перехватчика НЕ
            # принимается — базой новой generation остаётся последний серверный снапшот.
            # Клиент после ok перезагружается и честно едет от /restore.
            # ПРИНЯТЫЙ РИСК фазы 0 (аудит 18.07, high 2, решение координатора 1):
            # takeover доступен любому, знающему seat — seat-ссылка И ЕСТЬ credential
            # (ростер раздаёт ведущий), аккаунтов нет by design (student_id — фаза 1).
            # Здесь закрыта только ИДЕМПОТЕНТНОСТЬ: повтор того же инстанса не
            # поднимает generation (ответы параллельных ретраев сходятся).
            snap = store.read_snapshot(state['run_id'], seat) or {}
            if rec['instance'] == instance:
                return 200, {'ok': True, 'writer_generation': rec['generation'],
                             'epoch': rec['epoch'], 'server_rev': snap.get('rev', 0),
                             'run_id': state['run_id'], 'replay': True}, False
            rec['instance'] = instance
            rec['generation'] += 1
            _ev(state)
            return 200, {'ok': True, 'writer_generation': rec['generation'],
                         'epoch': rec['epoch'], 'server_rev': snap.get('rev', 0),
                         'run_id': state['run_id']}, True
        ok, err, claim_prev = _check_writer(state, seat, instance, generation)
        if not ok:
            return 409, err, False
        # epoch-гард снапшота (аудит ядра 18.07, critical 2): /save, собранный до
        # /host/reset_version, не должен записаться после сброса и вернуть отменённую
        # версию. Легаси-клиент без epoch (rolling deploy) — см. _check_epoch
        ep_ok, warning = _check_epoch(body, rec)
        if not ep_ok:
            _unclaim(state, seat, claim_prev)
            return 409, {'ok': False, 'error': 'stale_epoch', 'epoch': rec['epoch']}, False
        gen = rec['generation']
        snap = store.read_snapshot(state['run_id'], seat)
        old = (snap.get('writer_generation', 0), snap.get('rev', -1)) if snap else (-1, -1)
        if (gen, rev) < old:
            _unclaim(state, seat, claim_prev)
            return 409, {'ok': False, 'error': 'stale', 'accepted_rev': old[1],
                         'writer_generation': gen}, False
        # равный (gen, rev): обычно идемпотентный повтор (no-op), НО state и suspended
        # живут ВНЕ журнала — 'done' и вход/выход резерва не двигают rev (аудит 18.07,
        # п.5/п.7). Их изменение при том же rev — новая веха, снапшот перезаписывается.
        # ВПЕРЁД-ОНЛИ (аудит merged 18.07, critical 1): 'done' — терминальная веха,
        # запоздалый повтор той же rev с ранним state не откатывает её и payload
        changed = (gen, rev) == old and snap is not None and (
            snap.get('state') != body.get('state')
            or snap.get('suspended') != body.get('suspended'))
        if changed and snap.get('state') == 'done' and body.get('state') != 'done':
            # dirty=True: свежий claim (если был) уходит в файл, снапшот НЕ трогаем
            resp = {'ok': True, 'accepted_rev': rev, 'writer_generation': gen,
                    'epoch': rec['epoch'], 'run_id': state['run_id'],
                    'ignored': 'done_is_final'}
            return 200, resp, True
        if (gen, rev) > old or changed:
            store.write_snapshot(state['run_id'], seat, {
                'seat': seat, 'run_id': state['run_id'],
                'writer_generation': gen, 'rev': rev,
                'epoch': rec['epoch'],   # штамп эпохи: /restore отличает доreset-снапшот
                'lesson_id': body.get('lesson_id'),
                'state': body.get('state'), 'payload': body.get('payload'),
                'suspended': body.get('suspended'),
                'ts': body.get('ts', _now_ms()),
            })
        resp = {'ok': True, 'accepted_rev': rev, 'writer_generation': gen,
                'epoch': rec['epoch'], 'run_id': state['run_id']}
        if warning:
            resp['warning'] = warning
        return 200, resp, True

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
        stale_snapshot = bool(snap) and snap.get('epoch', 0) != rec['epoch']
        if stale_snapshot:
            # Снапшот собран ДО /host/reset_version (закалка 18.07, critical 2):
            # отменённая версия не должна вернуться базой после F5. server_rev
            # сохраняем (порядок (gen, rev) жив, журнал клиента едет дальше),
            # содержимое НЕ отдаём — до первого пост-reset /save база пустая.
            snap = {'rev': snap.get('rev', 0),
                    'writer_generation': snap.get('writer_generation', 0)}
        acked = state['commits'].get(seat, {})
        resp = {
            'ok': True,
            'run_id': state['run_id'],
            'lesson_id': state['lesson_id'],
            'writer_generation': rec['generation'],
            'epoch': rec['epoch'],
            'server_rev': snap.get('rev', 0),
            'state': snap.get('state'),
            'payload': snap.get('payload'),
            'suspended': snap.get('suspended'),   # позиция основной машины при уходе в резерв
            'acked': acked,                      # авторитетный слой ПОВЕРХ payload
            'acked_step': rec['acked_step'],
            'current_step': state['current_step'],
            'version_status': rec['version_status'],
        }
        if stale_snapshot:
            resp['snapshot_stale'] = True
        return 200, resp, False

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
    if not _valid_seat(seat) or not instance or len(instance) > MAX_INSTANCE_LEN \
            or not op_id or len(op_id) > MAX_OP_ID_LEN \
            or ctype not in COMMIT_TYPES or not _valid_step(step) \
            or not isinstance(payload, dict):
        return 400, {'ok': False, 'error': 'bad_request'}

    def fn(state):
        # порядок гардов: writer → epoch → дедуп. Epoch ДО дедупа: залипший ретрай
        # отменённого коммита обязан получить отказ, а не сохранённый старый результат.
        ok, err, claim_prev = _check_writer(state, seat, instance, generation)
        if not ok:
            return 409, err, False
        rec = _seat_rec(state, seat)
        ep_ok, _warning = _check_epoch(body, rec)
        if not ep_ok:
            _unclaim(state, seat, claim_prev)
            return 409, {'ok': False, 'error': 'stale_epoch', 'epoch': rec['epoch']}, False
        has_entry, replay = _op_replay(state, op_id, seat, ctype, step)
        if has_entry:
            _unclaim(state, seat, claim_prev)
            return replay[0], replay[1], False

        result = {'ok': True, 'seat': seat, 'type': ctype, 'step': step}

        if ctype == 'gate_enter':
            gate = state['gates'].setdefault(step, {'code': None, 'code_shown': False, 'arrived': []})
            if gate['code'] is not None:
                if str(payload.get('code', '')) != str(gate['code']):
                    _unclaim(state, seat, claim_prev)
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
            if step not in seat_commits and len(seat_commits) >= MAX_STEPS_PER_SEAT:
                _unclaim(state, seat, claim_prev)
                return 429, {'ok': False, 'error': 'quota'}, False
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

        _op_record(state, op_id, result)
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
    step = str(body.get('step', ''))
    op_id = str(body.get('op_id', ''))   # опционально (дедуп ретраев, закалка high 3)
    if not _valid_seat(seat) or not text.strip() or len(op_id) > MAX_OP_ID_LEN \
            or (step and not _valid_step(step)):
        return 400, {'ok': False, 'error': 'bad_request'}

    def fn(state):
        ok, err, claim_prev = _check_writer(state, seat, str(body.get('client_instance_id', '')),
                                            body.get('writer_generation', 0))
        if not ok:
            return 409, err, False
        rec = _seat_rec(state, seat)
        # epoch и op_id — опциональные гарды (закалка 18.07, high 3): старый клиент их
        # не шлёт (rolling deploy) — принимаем как раньше; новый — дедуп и отсев
        # задержанных запросов отменённой эпохи
        ep_ok, _w = _check_epoch(body, rec)
        if not ep_ok:
            _unclaim(state, seat, claim_prev)
            return 409, {'ok': False, 'error': 'stale_epoch', 'epoch': rec['epoch']}, False
        if op_id:
            has_entry, replay = _op_replay(state, op_id, seat, 'chat', step)
            if has_entry:
                _unclaim(state, seat, claim_prev)
                return replay[0], replay[1], False
        if sum(1 for m in state['chat'] if m['seat'] == seat) >= MAX_CHAT_PER_SEAT:
            _unclaim(state, seat, claim_prev)
            return 429, {'ok': False, 'error': 'quota'}, False
        seq = _ev(state)
        state['chat'].append({'seq': seq, 'seat': seat, 'step': step,
                              'text': text, 'ts': _now_ms()})
        if op_id:
            _op_record(state, op_id, {'ok': True, 'seat': seat, 'type': 'chat',
                                      'step': step, 'seq': seq})
        return 200, {'ok': True, 'seq': seq}, True

    return store.with_state(body.get('run_id'), fn)


def api_react(store, body):
    seat = str(body.get('seat', ''))
    step = str(body.get('step', ''))
    op_id = str(body.get('op_id', ''))
    if not _valid_seat(seat) or len(op_id) > MAX_OP_ID_LEN \
            or (step and not _valid_step(step)):
        return 400, {'ok': False, 'error': 'bad_request'}

    def fn(state):
        ok, err, claim_prev = _check_writer(state, seat, str(body.get('client_instance_id', '')),
                                            body.get('writer_generation', 0))
        if not ok:
            return 409, err, False
        rec = _seat_rec(state, seat)
        ep_ok, _w = _check_epoch(body, rec)
        if not ep_ok:
            _unclaim(state, seat, claim_prev)
            return 409, {'ok': False, 'error': 'stale_epoch', 'epoch': rec['epoch']}, False
        if op_id:
            has_entry, replay = _op_replay(state, op_id, seat, 'react', step)
            if has_entry:
                _unclaim(state, seat, claim_prev)
                return replay[0], replay[1], False
        if sum(1 for r in state['reactions'] if r['seat'] == seat) >= MAX_REACT_PER_SEAT:
            _unclaim(state, seat, claim_prev)
            return 429, {'ok': False, 'error': 'quota'}, False
        seq = _ev(state)
        state['reactions'].append({'seq': seq, 'seat': seat, 'step': step, 'ts': _now_ms()})
        if op_id:
            _op_record(state, op_id, {'ok': True, 'seat': seat, 'type': 'react',
                                      'step': step, 'seq': seq})
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
        lesson_id = str(body.get('lesson_id', '') or 'z1-kot')[:64]
        run_id = store.start_run(lesson_id, steps_meta=body.get('steps'))
        return 200, {'ok': True, 'run_id': run_id}

    def fn(state):
        if action == 'step':
            step = str(body.get('step', ''))
            if not _valid_step(step):
                return 400, {'ok': False, 'error': 'bad_request'}, False
            state['current_step'] = step
            _ev(state)
            return 200, {'ok': True, 'current_step': state['current_step']}, True
        if action == 'code':
            step = str(body.get('step', ''))
            if not _valid_step(step):
                return 400, {'ok': False, 'error': 'bad_request'}, False
            gate = state['gates'].setdefault(step, {'code': None, 'code_shown': False, 'arrived': []})
            if 'code' in body:
                gate['code'] = str(body['code'])[:16]
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
            if not _valid_step(step):
                return 400, {'ok': False, 'error': 'bad_request'}, False
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
    if not _valid_step(step):
        return 400, {'ok': False, 'error': 'bad_request'}

    def fn(state):
        rec = _reveal_rec(state, step)
        if rec['open']:
            return 200, {'ok': True, 'already': True}, False
        n_set = rec['n_set'] if rec['n_set'] is not None else _first_gate_arrivals(state)
        if not n_set:
            # пустой состав (никто не прошёл гейт) — reveal бессмыслен; UI кнопку
            # блокирует, сервер прямой запрос отклоняет (закалка 18.07, medium 3)
            return 409, {'ok': False, 'error': 'empty_n'}, False
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
    seat_missing = [str(s) for s in body.get('seat_missing', [])][:40]
    if not _valid_step(step) or not all(_valid_seat(s) for s in seat_missing):
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
    Активна ТОЛЬКО до reveal. Повтор с тем же op_id (потерянный ответ, двойной клик) —
    replay без второго инкремента epoch (закалка 18.07, high 1)."""
    seat = str(body.get('seat', ''))
    step = str(body.get('step', ''))
    op_id = str(body.get('op_id', ''))   # опционально: старый дашборд его не шлёт
    if not _valid_seat(seat) or not _valid_step(step) or len(op_id) > MAX_OP_ID_LEN:
        return 400, {'ok': False, 'error': 'bad_request'}

    def fn(state):
        if op_id:
            has_entry, replay = _op_replay(state, op_id, seat, 'reset_version', step)
            if has_entry:
                return replay[0], replay[1], False
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
        result = {'ok': True, 'epoch': seat_rec['epoch']}
        if op_id:
            _op_record(state, op_id, dict(result, seat=seat, type='reset_version', step=step))
        return 200, result, True

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
