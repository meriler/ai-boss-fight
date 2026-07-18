#!/usr/bin/env python3
"""Сверка «тень против файлов» (ТЗ-платформа-v3 §4.2, критерий готовности M1).

Источник правды — JSON-файлы; тень (SQLite) обязана совпадать с ними ПОЛНОСТЬЮ:
  - каждый lesson-state-<run>.json == state, собранный из строк тени (deep-equal);
  - каждый lesson-save-<run>-seat<N>.json == строка snapshot тени;
  - указатель lesson-current.json == meta.current_run;
  - в обе стороны: run/снапшот только в файлах ИЛИ только в тени = расхождение.

Запуск:  python3 check_db_parity.py [data_dir] [--db path]
  data_dir по умолчанию — $WS_TELE_DIR или /var/lib/ws-tele;
  путь тени — --db, иначе $LESSON_DB (как в сервисе), иначе <data_dir>/lesson.db.
Выход: 0 — ноль расхождений; 1 — расхождения (напечатаны); 2 — тень не найдена.

NB: гонять на ЖИВОМ сервисе можно (тень и файлы пишутся под одним локом в одной
мутации), но скрипт читает их не атомарно — при активных детях возможен ложный
транзиент. Канонический прогон — после тестов/репетиции, в тишине."""
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lesson_db  # noqa: E402


def _diff_paths(a, b, path='', out=None, limit=8):
    """Первые limit путей, где a != b — чтобы расхождение было видно глазами."""
    if out is None:
        out = []
    if len(out) >= limit:
        return out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b), key=str):
            if k not in a:
                out.append('%s.%s: только в тени' % (path, k))
            elif k not in b:
                out.append('%s.%s: только в файле' % (path, k))
            else:
                _diff_paths(a[k], b[k], '%s.%s' % (path, k), out, limit)
            if len(out) >= limit:
                return out
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append('%s: длина файла %d ≠ тени %d' % (path, len(a), len(b)))
            return out
        for i, (x, y) in enumerate(zip(a, b)):
            _diff_paths(x, y, '%s[%d]' % (path, i), out, limit)
            if len(out) >= limit:
                return out
    elif a != b:
        out.append('%s: файл %r ≠ тень %r' % (path, a, b))
    return out


def check(data_dir, db_path):
    """Список расхождений (пусто = parity OK). Бросает FileNotFoundError без тени."""
    if not os.path.exists(db_path):
        raise FileNotFoundError(db_path)
    con = sqlite3.connect(db_path)
    problems = []

    file_states, file_snaps = {}, {}
    for name in sorted(os.listdir(data_dir)):
        m_state = lesson_db.STATE_RE.match(name)
        m_snap = lesson_db.SAVE_RE.match(name) if not m_state else None
        if not m_state and not m_snap:
            continue
        try:
            with open(os.path.join(data_dir, name), encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:   # noqa: BLE001 — битый JSON = диагностированное
            # расхождение, а не traceback скрипта (закалка 18.07, medium)
            problems.append('%s: файл НЕЧИТАЕМ (%r) — parity неопределим' % (name, e))
            continue
        if m_state:
            file_states[m_state.group(1)] = data
        else:
            file_snaps[(m_snap.group(1), m_snap.group(2))] = data

    db_run_set = set(lesson_db.db_runs(con))
    for run_id in sorted(set(file_states) | db_run_set):
        if run_id not in file_states:
            problems.append('run %s: есть в тени, нет файла lesson-state' % run_id)
            continue
        if run_id not in db_run_set:
            problems.append('run %s: есть файл lesson-state, нет в тени' % run_id)
            continue
        rebuilt = lesson_db.rebuild_state(con, run_id)
        if rebuilt != file_states[run_id]:
            for d in _diff_paths(file_states[run_id], rebuilt, 'state'):
                problems.append('run %s: %s' % (run_id, d))

    db_snap_set = set(lesson_db.db_snapshot_keys(con))
    for key in sorted(set(file_snaps) | db_snap_set):
        run_id, seat = key
        tag = 'snapshot %s/seat%s' % key
        if key not in file_snaps:
            problems.append('%s: есть в тени, нет файла' % tag)
            continue
        if key not in db_snap_set:
            problems.append('%s: есть файл, нет в тени' % tag)
            continue
        rebuilt = lesson_db.rebuild_snapshot(con, run_id, seat)
        if rebuilt != file_snaps[key]:
            for d in _diff_paths(file_snaps[key], rebuilt, 'snap'):
                problems.append('%s: %s' % (tag, d))

    # Указатель current: различаем «файла нет» (легально до первого запуска) и «файл
    # есть, но нечитаем/битый». Раньше оба случая давали cur_file=None — битый указатель
    # при пустом meta.current_run проходил зелёным (Codex-ревью 18.07, находка 2).
    cur_db = lesson_db.db_current_run(con)
    cur_path = os.path.join(data_dir, 'lesson-current.json')
    if not os.path.exists(cur_path):
        if cur_db is not None:
            problems.append('current_run: файла-указателя нет, в тени %r' % cur_db)
    else:
        try:
            with open(cur_path, encoding='utf-8') as f:
                data = json.load(f)
            if not isinstance(data, dict):
                raise ValueError('не JSON-объект: %s' % type(data).__name__)
            cur_file = data.get('run_id')
        except Exception as e:   # noqa: BLE001
            problems.append('current_run: lesson-current.json НЕЧИТАЕМ (%r) — '
                            'parity указателя неопределим, это расхождение' % e)
        else:
            if cur_file != cur_db:
                problems.append('current_run: файл %r ≠ тень %r' % (cur_file, cur_db))

    con.close()
    return problems


def main(argv):
    args, db_path, i = [], None, 1
    while i < len(argv):
        if argv[i] == '--db' and i + 1 < len(argv):
            db_path = argv[i + 1]
            i += 2
        else:
            args.append(argv[i])
            i += 1
    data_dir = args[0] if args else (os.environ.get('WS_TELE_DIR') or '/var/lib/ws-tele')
    if db_path is None:
        db_path = lesson_db.db_path_from_env(data_dir) or os.path.join(data_dir, 'lesson.db')
    try:
        problems = check(data_dir, db_path)
    except FileNotFoundError:
        print('⛔ тень не найдена: %s (LESSON_DB не включён или сервис не стартовал?)' % db_path)
        return 2
    n_runs = len([n for n in os.listdir(data_dir) if lesson_db.STATE_RE.match(n)])
    n_snaps = len([n for n in os.listdir(data_dir) if lesson_db.SAVE_RE.match(n)])
    if problems:
        print('⛔ РАСХОЖДЕНИЯ тени и файлов (%d):' % len(problems))
        for p in problems:
            print('  - ' + p)
        return 1
    print('✅ parity OK: runs %d, снапшотов %d, расхождений 0 (%s)' % (n_runs, n_snaps, db_path))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
