#!/usr/bin/env python3
"""SQLite-тень lesson-state (ТЗ-платформа-v3 §4.2, шаг M1 — dual-write).

Тень пишется РЯДОМ с JSON-файлами на каждой мутации; ИСТОЧНИК ЧТЕНИЯ НЕ МЕНЯЕТСЯ
(это M2, отдельное решение владельца). Правила шага M1:
  - включение — env-флаг LESSON_DB (=1 → <data_dir>/lesson.db, иначе — явный путь);
    флага нет → тень выключена, поведение фазы 0 байт-в-байт;
  - все обращения к SQLite идут под тем же глобальным Lock LessonStore, одна
    транзакция на мутацию (state + снапшоты этой мутации вместе);
  - ЛЮБАЯ ошибка тени глотается с логом в stderr — файлы остаются источником
    правды, детский контур не замечает;
  - зеркалирование — полной перезаписью строк run'а: каждая dirty-мутация кладёт
    ВСЁ состояние run'а заново (сотни строк — миллисекунды для 30 детей), поэтому
    тень самовосстанавливается после любого пропущенного/сбойного зеркала;
  - при старте сервиса тень догоняет уже лежащие на диске файлы (backfill) —
    parity чист с первой минуты, старые прогоны не «висят» расхождениями.

Сверка «тень против файлов» — check_db_parity.py (использует rebuild_* отсюда).
"""
import json
import os
import re
import sqlite3
import sys

SCHEMA_VERSION = 2   # v2: snapshot.suspended (позиция основной машины при уходе в резерв)

# Точная форма state фазы 0 (_blank_state в lesson_state.py). Новый ключ в state
# без правки тени → лог-ошибка тени + расхождение в parity, НЕ молчаливая потеря.
STATE_KEYS = {
    'run_id', 'lesson_id', 'created', 'event_seq', 'current_step', 'reserve_active',
    'gates', 'commits', 'seats', 'reveal', 'chat', 'reactions', 'ops', 'op_order',
    'log', 'steps_meta',
}
SEAT_KEYS = {'epoch', 'instance', 'generation', 'version_status', 'acked_step', 'last_sync'}

TABLES = ('gate', 'seat', 'commit_group', 'commit_rec', 'reveal', 'chat_msg',
          'reaction', 'op_ledger')   # чистятся полной перезаписью run'а (+session отдельно)

DDL = """
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS session (
  run_id TEXT PRIMARY KEY, lesson_id TEXT, created TEXT,
  event_seq INTEGER NOT NULL, current_step TEXT, reserve_active TEXT NOT NULL,
  steps_meta TEXT NOT NULL, log TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gate (
  run_id TEXT NOT NULL, step TEXT NOT NULL, code TEXT, code_shown INTEGER NOT NULL,
  arrived TEXT NOT NULL, PRIMARY KEY (run_id, step));
CREATE TABLE IF NOT EXISTS seat (
  run_id TEXT NOT NULL, seat TEXT NOT NULL, epoch INTEGER NOT NULL,
  instance TEXT, generation INTEGER NOT NULL, version_status TEXT NOT NULL,
  acked_step TEXT, last_sync INTEGER, PRIMARY KEY (run_id, seat));
CREATE TABLE IF NOT EXISTS commit_group (
  run_id TEXT NOT NULL, seat TEXT NOT NULL, step TEXT NOT NULL,
  PRIMARY KEY (run_id, seat, step));
CREATE TABLE IF NOT EXISTS commit_rec (
  run_id TEXT NOT NULL, seat TEXT NOT NULL, step TEXT NOT NULL, type TEXT NOT NULL,
  data TEXT NOT NULL, ts INTEGER NOT NULL, op_id TEXT NOT NULL, late INTEGER,
  PRIMARY KEY (run_id, seat, step, type));
CREATE TABLE IF NOT EXISTS reveal (
  run_id TEXT NOT NULL, step TEXT NOT NULL, open INTEGER NOT NULL,
  payload_rev INTEGER NOT NULL, anon_versions TEXT NOT NULL, n_set TEXT, override TEXT,
  PRIMARY KEY (run_id, step));
CREATE TABLE IF NOT EXISTS chat_msg (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, seat TEXT NOT NULL, step TEXT NOT NULL,
  text TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (run_id, seq));
CREATE TABLE IF NOT EXISTS reaction (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, seat TEXT NOT NULL, step TEXT NOT NULL,
  ts INTEGER NOT NULL, PRIMARY KEY (run_id, seq));
CREATE TABLE IF NOT EXISTS op_ledger (
  run_id TEXT NOT NULL, op_id TEXT NOT NULL, pos INTEGER NOT NULL, result TEXT NOT NULL,
  PRIMARY KEY (run_id, op_id));
CREATE TABLE IF NOT EXISTS snapshot (
  run_id TEXT NOT NULL, seat TEXT NOT NULL, rev INTEGER NOT NULL,
  writer_generation INTEGER NOT NULL, lesson_id TEXT, state TEXT NOT NULL,
  payload TEXT NOT NULL, ts INTEGER, suspended TEXT, PRIMARY KEY (run_id, seat));
"""

SAVE_RE = re.compile(r'^lesson-save-(.+)-seat([^-]+)\.json$')
STATE_RE = re.compile(r'^lesson-state-(.+)\.json$')


def _j(obj):
    return json.dumps(obj, ensure_ascii=False)


def db_path_from_env(data_dir):
    """env-флаг M1: LESSON_DB=1 → <data_dir>/lesson.db; иначе значение — явный путь.
    Пусто/нет → тень выключена (None)."""
    v = (os.environ.get('LESSON_DB') or '').strip()
    if not v:
        return None
    if v.lower() in ('1', 'on', 'true', 'yes'):
        return os.path.join(data_dir, 'lesson.db')
    return v


def open_shadow(path):
    """Shadow или None. Ошибка открытия глотается с логом — сервис живёт на файлах."""
    try:
        return Shadow(path)
    except Exception as e:   # noqa: BLE001 — тень не имеет права ронять контур занятия
        print('[lesson_db] тень НЕ открылась (%r) — работаем без неё, файлы = правда: %r'
              % (path, e), file=sys.stderr)
        return None


class Shadow:
    """Обёртка над SQLite-файлом тени. ВСЕ вызовы — под глобальным Lock LessonStore
    (поэтому check_same_thread=False безопасен: конкурентного доступа нет по построению)."""

    def __init__(self, path):
        self.path = path
        self.errors = 0
        self.con = sqlite3.connect(path, check_same_thread=False)
        self.con.execute('PRAGMA journal_mode=WAL')
        self.con.execute('PRAGMA busy_timeout=5000')
        self.con.execute('PRAGMA synchronous=NORMAL')
        cur = self.con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").fetchone()
        if cur:
            row = self.con.execute("SELECT v FROM meta WHERE k='schema_version'").fetchone()
            if row and row[0] != str(SCHEMA_VERSION):
                # тень — производные данные: другую версию схемы честно пересобираем с нуля
                print('[lesson_db] схема тени %s ≠ %s — пересоздаю (данные тени производные)'
                      % (row[0], SCHEMA_VERSION), file=sys.stderr)
                with self.con:
                    for t in TABLES + ('session', 'snapshot', 'meta'):
                        self.con.execute('DROP TABLE IF EXISTS %s' % t)
        with self.con:
            self.con.executescript(DDL)
            self.con.execute('INSERT OR REPLACE INTO meta VALUES (?,?)',
                             ('schema_version', str(SCHEMA_VERSION)))

    def _log_err(self, where, e):
        self.errors += 1
        print('[lesson_db] ошибка тени в %s (глотаю, файлы — источник правды): %r'
              % (where, e), file=sys.stderr)

    # ---- зеркало мутации: одна транзакция на state + снапшоты этой мутации ----
    def mirror_mutation(self, state, snaps=(), set_current=None):
        """state=None → зеркалим только снапшоты. Никогда не бросает; возвращает
        True/False — вызывающий обязан знать исход: state самовосстановится следующей
        полной перезаписью run'а, а снапшоты полная перезапись НЕ трогает, их при
        провале нужно удержать до успешного зеркала (Codex-ревью 18.07, находка 1)."""
        try:
            with self.con:
                if state is not None:
                    self._replace_run(state)
                for run_id, seat, snap in snaps:
                    self._put_snapshot(run_id, seat, snap)
                if set_current:
                    self.con.execute('INSERT OR REPLACE INTO meta VALUES (?,?)',
                                     ('current_run', set_current))
            return True
        except Exception as e:   # noqa: BLE001
            self._log_err('mirror_mutation', e)
            return False

    def _replace_run(self, st):
        unknown = set(st) - STATE_KEYS
        if unknown:
            # форма state уехала от схемы тени: пишем что знаем, но кричим в лог —
            # parity это расхождение тоже поймает (guard от молчаливой потери поля)
            raise ValueError('state несёт неизвестные тени ключи: %s' % sorted(unknown))
        rid = st['run_id']
        con = self.con
        for t in TABLES:
            con.execute('DELETE FROM %s WHERE run_id=?' % t, (rid,))
        con.execute('INSERT OR REPLACE INTO session VALUES (?,?,?,?,?,?,?,?)',
                    (rid, st['lesson_id'], st['created'], st['event_seq'],
                     st['current_step'], st['reserve_active'],
                     _j(st['steps_meta']), _j(st['log'])))
        for step, g in st['gates'].items():
            con.execute('INSERT INTO gate VALUES (?,?,?,?,?)',
                        (rid, step, g['code'], int(bool(g['code_shown'])), _j(g['arrived'])))
        for seat, rec in st['seats'].items():
            unknown = set(rec) - SEAT_KEYS
            if unknown:
                raise ValueError('seat-запись несёт неизвестные ключи: %s' % sorted(unknown))
            con.execute('INSERT INTO seat VALUES (?,?,?,?,?,?,?,?)',
                        (rid, seat, rec['epoch'], rec['instance'], rec['generation'],
                         rec['version_status'], rec['acked_step'], rec.get('last_sync')))
        for seat, steps in st['commits'].items():
            for step, types in steps.items():
                con.execute('INSERT INTO commit_group VALUES (?,?,?)', (rid, seat, step))
                for ctype, entry in types.items():
                    con.execute('INSERT INTO commit_rec VALUES (?,?,?,?,?,?,?,?)',
                                (rid, seat, step, ctype, _j(entry['data']), entry['ts'],
                                 entry['op_id'], 1 if entry.get('late') else None))
        for step, r in st['reveal'].items():
            con.execute('INSERT INTO reveal VALUES (?,?,?,?,?,?,?)',
                        (rid, step, int(bool(r['open'])), r['payload_rev'],
                         _j(r['anon_versions']),
                         None if r['n_set'] is None else _j(r['n_set']),
                         None if r['override'] is None else _j(r['override'])))
        for m in st['chat']:
            con.execute('INSERT INTO chat_msg VALUES (?,?,?,?,?,?)',
                        (rid, m['seq'], m['seat'], m['step'], m['text'], m['ts']))
        for m in st['reactions']:
            con.execute('INSERT INTO reaction VALUES (?,?,?,?,?)',
                        (rid, m['seq'], m['seat'], m['step'], m['ts']))
        for pos, op_id in enumerate(st['op_order']):
            # op_order и ops подрезаются вместе (MAX_OPS) — рассинхрон невозможен;
            # если он всё же случится, пропуск строки честно всплывёт в parity
            if op_id in st['ops']:
                con.execute('INSERT INTO op_ledger VALUES (?,?,?,?)',
                            (rid, op_id, pos, _j(st['ops'][op_id])))

    def _put_snapshot(self, run_id, seat, snap):
        # suspended: SQL NULL = ключа в файле НЕТ (старые снапшоты до v2); JSON-строка
        # (включая 'null') = ключ есть — parity восстанавливает файл байт-в-байт
        self.con.execute('INSERT OR REPLACE INTO snapshot VALUES (?,?,?,?,?,?,?,?,?)',
                         (run_id, seat, snap['rev'], snap['writer_generation'],
                          snap['lesson_id'], _j(snap['state']), _j(snap['payload']),
                          snap.get('ts'),
                          _j(snap['suspended']) if 'suspended' in snap else None))

    # ---- backfill при старте: тень догоняет файлы на диске ----
    def backfill(self, data_dir, current_run=None):
        """Однократно при создании LessonStore: зеркалим ВСЕ lesson-state-*.json и
        lesson-save-*.json, лежащие на диске (старые прогоны, довключение флага на
        живых данных). Битый файл — лог и пропуск, не падение сервиса."""
        try:
            names = sorted(os.listdir(data_dir))
        except Exception as e:   # noqa: BLE001
            self._log_err('backfill.listdir', e)
            return
        for name in names:
            m = STATE_RE.match(name)
            if m:
                try:
                    with open(os.path.join(data_dir, name), encoding='utf-8') as f:
                        st = json.load(f)
                    self.mirror_mutation(st)
                except Exception as e:   # noqa: BLE001
                    self._log_err('backfill(%s)' % name, e)
                continue
            m = SAVE_RE.match(name)
            if m:
                try:
                    with open(os.path.join(data_dir, name), encoding='utf-8') as f:
                        snap = json.load(f)
                    self.mirror_mutation(None, [(m.group(1), m.group(2), snap)])
                except Exception as e:   # noqa: BLE001
                    self._log_err('backfill(%s)' % name, e)
        if current_run:
            self.mirror_mutation(None, [], set_current=current_run)


# ==================== чтение тени (ТОЛЬКО parity/тесты — рантайм читает файлы!) ====================

def rebuild_state(con, run_id):
    """Собрать state-словарь из строк тени — форма 1-в-1 c lesson-state-<run>.json.
    None, если run в тени нет."""
    row = con.execute('SELECT lesson_id, created, event_seq, current_step, reserve_active,'
                      ' steps_meta, log FROM session WHERE run_id=?', (run_id,)).fetchone()
    if row is None:
        return None
    st = {
        'run_id': run_id, 'lesson_id': row[0], 'created': row[1], 'event_seq': row[2],
        'current_step': row[3], 'reserve_active': row[4],
        'gates': {}, 'commits': {}, 'seats': {}, 'reveal': {}, 'chat': [], 'reactions': [],
        'ops': {}, 'op_order': [], 'log': json.loads(row[6]), 'steps_meta': json.loads(row[5]),
    }
    for step, code, shown, arrived in con.execute(
            'SELECT step, code, code_shown, arrived FROM gate WHERE run_id=?', (run_id,)):
        st['gates'][step] = {'code': code, 'code_shown': bool(shown),
                             'arrived': json.loads(arrived)}
    for seat, epoch, inst, gen, vs, acked, last_sync in con.execute(
            'SELECT seat, epoch, instance, generation, version_status, acked_step, last_sync'
            ' FROM seat WHERE run_id=?', (run_id,)):
        rec = {'epoch': epoch, 'instance': inst, 'generation': gen,
               'version_status': vs, 'acked_step': acked}
        if last_sync is not None:
            rec['last_sync'] = last_sync
        st['seats'][seat] = rec
    for seat, step in con.execute(
            'SELECT seat, step FROM commit_group WHERE run_id=?', (run_id,)):
        st['commits'].setdefault(seat, {})[step] = {}
    for seat, step, ctype, data, ts, op_id, late in con.execute(
            'SELECT seat, step, type, data, ts, op_id, late FROM commit_rec WHERE run_id=?',
            (run_id,)):
        entry = {'data': json.loads(data), 'ts': ts, 'op_id': op_id}
        if late:
            entry['late'] = True
        st['commits'].setdefault(seat, {}).setdefault(step, {})[ctype] = entry
    for step, opened, prev, anon, n_set, override in con.execute(
            'SELECT step, open, payload_rev, anon_versions, n_set, override FROM reveal'
            ' WHERE run_id=?', (run_id,)):
        st['reveal'][step] = {
            'open': bool(opened), 'payload_rev': prev, 'anon_versions': json.loads(anon),
            'n_set': None if n_set is None else json.loads(n_set),
            'override': None if override is None else json.loads(override)}
    for seq, seat, step, text, ts in con.execute(
            'SELECT seq, seat, step, text, ts FROM chat_msg WHERE run_id=? ORDER BY seq',
            (run_id,)):
        st['chat'].append({'seq': seq, 'seat': seat, 'step': step, 'text': text, 'ts': ts})
    for seq, seat, step, ts in con.execute(
            'SELECT seq, seat, step, ts FROM reaction WHERE run_id=? ORDER BY seq', (run_id,)):
        st['reactions'].append({'seq': seq, 'seat': seat, 'step': step, 'ts': ts})
    for op_id, result in con.execute(
            'SELECT op_id, result FROM op_ledger WHERE run_id=? ORDER BY pos', (run_id,)):
        st['ops'][op_id] = json.loads(result)
        st['op_order'].append(op_id)
    return st


def rebuild_snapshot(con, run_id, seat):
    row = con.execute('SELECT rev, writer_generation, lesson_id, state, payload, ts, suspended'
                      ' FROM snapshot WHERE run_id=? AND seat=?', (run_id, seat)).fetchone()
    if row is None:
        return None
    snap = {'seat': seat, 'run_id': run_id, 'writer_generation': row[1], 'rev': row[0],
            'lesson_id': row[2], 'state': json.loads(row[3]), 'payload': json.loads(row[4]),
            'ts': row[5]}
    if row[6] is not None:   # SQL NULL = ключа в файле не было (снапшот до v2)
        snap['suspended'] = json.loads(row[6])
    return snap


def db_runs(con):
    return [r[0] for r in con.execute('SELECT run_id FROM session')]


def db_snapshot_keys(con):
    return [(r[0], r[1]) for r in con.execute('SELECT run_id, seat FROM snapshot')]


def db_current_run(con):
    row = con.execute("SELECT v FROM meta WHERE k='current_run'").fetchone()
    return row[0] if row else None
