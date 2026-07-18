#!/usr/bin/env python3
"""Тесты SQLite-тени M1 (ТЗ-платформа-v3 §4.2): dual-write на всех мутациях + parity
«тень против файлов», нетронутость источника чтения (файлы), поведение без флага
(фаза 0 байт-в-байт), глотание ошибок тени, backfill при старте, детект порчи.

Работает с lesson_state НАПРЯМУЮ (api_* — чистые функции над store): HTTP-слой
покрыт test_lesson_state.py и e2e-z1; здесь — контракт хранилища.

Запуск: python3 -m unittest discover -s server -v"""
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import check_db_parity  # noqa: E402
import lesson_db  # noqa: E402
import lesson_state  # noqa: E402


def mk_store(tmp, db=True):
    return lesson_state.LessonStore(
        tmp, db_path=os.path.join(tmp, 'lesson.db') if db else None)


def save(store, seat, rev, run, payload=None, instance=None, gen=1, **kw):
    body = {'seat': seat, 'run_id': run, 'client_instance_id': instance or ('inst-' + seat),
            'writer_generation': gen, 'epoch': 0, 'lesson_id': 'z1-kot',
            'state': {'step': 's2'}, 'payload': payload or {'r': rev}, 'rev': rev, 'ts': 1}
    body.update(kw)
    return lesson_state.api_save(store, body)


def commit(store, seat, ctype, step, run, payload=None, op_id=None,
           instance=None, gen=1, epoch=0):
    return lesson_state.api_commit(store, {
        'seat': seat, 'run_id': run, 'client_instance_id': instance or ('inst-' + seat),
        'writer_generation': gen, 'epoch': epoch,
        'op_id': op_id or ('op-%s-%s-%s' % (seat, ctype, step)),
        'type': ctype, 'step': step, 'payload': payload or {}})


def full_scenario(store):
    """Богатый прогон по ВСЕМ мутирующим ручкам §4.1 — материал для parity.
    Возвращает (run1, run2)."""
    run1 = store.start_run('z1-kot', steps_meta=[
        {'id': 's1', 'type': 'gate', 'label': 'Гейт', 'gate': {'kind': 'code'}},
        {'id': 's2', 'type': 'trainer_act', 'has_version': True}])
    # гейт с кодом, вход двух мест
    lesson_state.api_host_gate(store, {'action': 'code', 'step': 's1', 'code': '33'})
    st, _ = commit(store, '1', 'gate_enter', 's1', run1, {'code': '33'})
    assert st == 200
    st, _ = commit(store, '2', 'gate_enter', 's1', run1, {'code': '33'})
    assert st == 200
    # снапшоты: обычный, идемпотентный повтор, takeover (generation+1)
    assert save(store, '1', 1, run1)[0] == 200
    assert save(store, '1', 2, run1, payload={'baskets': [{'img': 't1', 'basket': 'cat'}]})[0] == 200
    assert save(store, '2', 1, run1)[0] == 200
    assert save(store, '2', 1, run1, instance='B', takeover=True)[0] == 200
    # version+choice+forecast+captcha, дедуп-ретрай
    st, _ = commit(store, '1', 'version', 's2', run1, {'slots': {'1': 2}, 'text': 'фон'})
    assert st == 200
    st, r = commit(store, '1', 'version', 's2', run1, {'slots': {'1': 2}, 'text': 'фон'})
    assert st == 200 and r.get('replay')
    assert commit(store, '1', 'choice', 's2', run1, {'option': 1})[0] == 200
    assert commit(store, '1', 'forecast', 's2', run1, {'picked': 'a'})[0] == 200
    assert commit(store, '1', 'captcha', 's3', run1, {'ok': True})[0] == 200
    # reset_version на отдельном шаге → ПУСТАЯ группа коммитов (краевой случай тени)
    assert commit(store, '2', 'version', 's9', run1, {'text': 'v'}, gen=2, instance='B')[0] == 200
    assert commit(store, '2', 'choice', 's9', run1, {'option': 0}, gen=2, instance='B')[0] == 200
    assert lesson_state.api_host_reset_version(store, {'seat': '2', 'step': 's9'})[0] == 200
    # host: шаг/резерв/fix_n/показ кода
    lesson_state.api_host_gate(store, {'action': 'step', 'step': 's2'})
    lesson_state.api_host_gate(store, {'action': 'reserve', 'which': 'trainer'})
    lesson_state.api_host_gate(store, {'action': 'fix_n', 'step': 's2'})
    lesson_state.api_host_gate(store, {'action': 'code', 'step': 's1', 'show': True})
    # чат и реакции
    assert lesson_state.api_chat(store, {'seat': '1', 'run_id': run1, 'step': 's2',
                                         'text': 'привет', 'client_instance_id': 'inst-1',
                                         'writer_generation': 1})[0] == 200
    assert lesson_state.api_react(store, {'seat': '1', 'run_id': run1, 'step': 's2',
                                          'client_instance_id': 'inst-1',
                                          'writer_generation': 1})[0] == 200
    # reveal: 2-е место доводим до готовности (epoch у него уже 1 после reset)
    assert commit(store, '2', 'version', 's2', run1, {'text': 'уши'},
                  gen=2, instance='B', epoch=1)[0] == 200
    assert commit(store, '2', 'choice', 's2', run1, {'option': 0},
                  gen=2, instance='B', epoch=1)[0] == 200
    st, _ = lesson_state.api_host_reveal(store, {'step': 's2'})
    assert st == 200
    # поздний version после reveal (late + доклейка в anon_versions)
    assert commit(store, '3', 'gate_enter', 's1', run1, {'code': '33'})[0] == 200
    st, r = commit(store, '3', 'version', 's2', run1, {'text': 'поздняя'})
    assert st == 200 and r.get('late')
    # override
    assert lesson_state.api_host_override(store, {'step': 's5', 'seat_missing': ['2']})[0] == 200
    # /sync и /restore — читающие: тень трогать не должны
    assert lesson_state.api_sync(store, '1', 0)[0] == 200
    assert lesson_state.api_restore(store, '1')[0] == 200
    # второй запуск: указатель current переезжает, старый run — архив
    run2 = store.start_run('z1-kot')
    assert save(store, '1', 3, run1)[0] == 409   # stale_run: в архив не пишем
    assert save(store, '4', 1, run2)[0] == 200
    return run1, run2


class TestShadowParity(unittest.TestCase):
    def setUp(self):
        os.environ.pop('LESSON_DB', None)
        self.tmp = tempfile.mkdtemp(prefix='lesson-db-test-')
        self.db = os.path.join(self.tmp, 'lesson.db')
        self._stores = []

    def tearDown(self):
        for s in self._stores:   # закрыть соединения тени — без ResourceWarning в прогоне
            try:
                if s.shadow and s.shadow.con:
                    s.shadow.con.close()
            except Exception:   # noqa: BLE001
                pass

    def _reg(self, store):
        self._stores.append(store)
        return store

    def test_full_scenario_parity_zero(self):
        """Критерий M1: после прогона по всем ручкам — ноль расхождений тени и файлов."""
        store = self._reg(mk_store(self.tmp))
        full_scenario(store)
        problems = check_db_parity.check(self.tmp, self.db)
        self.assertEqual(problems, [])

    def test_read_source_is_files_not_db(self):
        """Жёсткая граница M1/M2: тень испорчена/удалена — ЧТЕНИЕ И МУТАЦИИ живут,
        потому что источник чтения — файлы, а ошибка тени глотается."""
        store = self._reg(mk_store(self.tmp))
        run1, run2 = full_scenario(store)
        store.shadow.con.close()          # имитация смерти тени посреди занятия
        os.remove(self.db)
        st, view = lesson_state.api_restore(store, '4')
        self.assertEqual(st, 200)
        self.assertEqual(view['run_id'], run2)
        self.assertEqual(view['payload'], {'r': 1})
        st, _ = save(store, '4', 2, run2)  # мутация при мёртвой тени — работает
        self.assertEqual(st, 200)
        self.assertGreater(store.shadow.errors, 0)   # ошибка залогирована, не проглочена молча
        st, view = lesson_state.api_restore(store, '4')
        self.assertEqual(view['server_rev'], 2)

    def test_no_flag_no_db_phase0_intact(self):
        """Флага нет → тень выключена: ни lesson.db, ни изменений поведения."""
        store = self._reg(mk_store(self.tmp, db=False))
        full_scenario(store)
        self.assertIsNone(store.shadow)
        self.assertFalse(os.path.exists(self.db))
        self.assertTrue(any(n.startswith('lesson-state-') for n in os.listdir(self.tmp)))

    def test_parity_detects_corruption(self):
        """Сверка не декоративная: подмена байта в тени даёт ненулевые расхождения."""
        store = self._reg(mk_store(self.tmp))
        full_scenario(store)
        con = sqlite3.connect(self.db)
        with con:
            con.execute("UPDATE chat_msg SET text='подменили'")
            con.execute("DELETE FROM snapshot WHERE seat='4'")
        con.close()
        problems = check_db_parity.check(self.tmp, self.db)
        self.assertGreaterEqual(len(problems), 2)
        self.assertTrue(any('chat' in p for p in problems))
        self.assertTrue(any('snapshot' in p for p in problems))

    def test_backfill_catches_up_existing_files(self):
        """Включение флага на живых данных: новый store с тенью догоняет файлы,
        лежащие на диске от прогонов БЕЗ тени (M1 на проде поверх прогонов 17.07)."""
        store0 = self._reg(mk_store(self.tmp, db=False))   # фаза 0: только файлы
        full_scenario(store0)
        store1 = self._reg(mk_store(self.tmp))             # рестарт сервиса уже с LESSON_DB
        self.assertIsNotNone(store1.shadow)
        problems = check_db_parity.check(self.tmp, self.db)
        self.assertEqual(problems, [])

    def test_shadow_selfheals_after_missed_mirror(self):
        """Полная перезапись run'а на каждой dirty-мутации: пропущенное зеркало
        (тень временно умерла) самовосстанавливается следующей мутацией. СНАПШОТЫ
        полная перезапись run'а НЕ трогает — их провалившееся зеркало обязано
        удержать в очереди до успеха (Codex-ревью 18.07, находка 1): /save при
        мёртвой тени раньше оставлял строку snapshot стейлой навсегда."""
        store = self._reg(mk_store(self.tmp))
        run1 = store.start_run('z1-kot')
        commit(store, '1', 'gate_enter', 's1', run1)
        self.assertEqual(save(store, '1', 1, run1)[0], 200)   # снапшот, зеркало успело
        good_con = store.shadow.con
        store.shadow.con = None                          # тень «умерла»
        commit(store, '2', 'gate_enter', 's1', run1)     # зеркало state пропущено
        # /save при мёртвой тени: файл снапшота пишется, зеркало проваливается —
        # снапшот обязан остаться в очереди (два подряд: в тень поедет последний)
        self.assertEqual(save(store, '1', 2, run1, payload={'r': 2})[0], 200)
        self.assertEqual(save(store, '1', 3, run1, payload={'r': 3})[0], 200)
        self.assertGreater(store.shadow.errors, 0)
        self.assertEqual(len(store._pend_snaps), 1)      # дедуп по (run, seat): последний
        store.shadow.con = good_con                      # тень «ожила»
        commit(store, '3', 'gate_enter', 's1', run1)     # re-mirror state + доезд снапшота
        self.assertEqual(store._pend_snaps, [])
        problems = check_db_parity.check(self.tmp, self.db)
        self.assertEqual(problems, [])

    def test_shadow_survives_sqlite_lock(self):
        """Искусственная блокировка SQLite (чужой процесс держит write-lock): мутации
        и чтение живут на файлах, ошибки тени глотаются; после разблокировки следующая
        мутация самовосстанавливает и state, и удержанные снапшоты (находка 8)."""
        store = self._reg(mk_store(self.tmp))
        run1 = store.start_run('z1-kot')
        commit(store, '1', 'gate_enter', 's1', run1)
        store.shadow.con.execute('PRAGMA busy_timeout=100')   # тест не ждёт дефолтные 5 с
        locker = sqlite3.connect(self.db)
        locker.execute('BEGIN IMMEDIATE')                     # write-lock чужой «сессии»
        try:
            st, _ = commit(store, '2', 'gate_enter', 's1', run1)
            self.assertEqual(st, 200)                         # контур жив на файлах
            self.assertEqual(save(store, '2', 1, run1)[0], 200)
            self.assertGreater(store.shadow.errors, 0)
            self.assertEqual(len(store._pend_snaps), 1)       # снапшот удержан до успеха
            st, view = lesson_state.api_restore(store, '2')   # чтение — файлы, тень не нужна
            self.assertEqual(st, 200)
            self.assertEqual(view['server_rev'], 1)
        finally:
            locker.rollback()
            locker.close()
        commit(store, '3', 'gate_enter', 's1', run1)          # разблокировано → re-mirror
        self.assertEqual(store._pend_snaps, [])
        problems = check_db_parity.check(self.tmp, self.db)
        self.assertEqual(problems, [])

    def test_parity_flags_broken_current_pointer(self):
        """Битый lesson-current.json — расхождение, а не ложный зелёный: раньше
        нечитаемый указатель превращался в None и при пустом meta.current_run parity
        проходил (Codex-ревью 18.07, находка 2)."""
        store = self._reg(mk_store(self.tmp))
        full_scenario(store)
        cur = os.path.join(self.tmp, 'lesson-current.json')
        with open(cur, 'w', encoding='utf-8') as f:
            f.write('{оборванный json')
        problems = check_db_parity.check(self.tmp, self.db)
        self.assertTrue(any('НЕЧИТАЕМ' in p for p in problems), problems)
        # «оба пусты» остаётся легальным: нет файла и нет meta — ноль расхождений
        os.remove(cur)
        con = sqlite3.connect(self.db)
        with con:
            con.execute("DELETE FROM meta WHERE k='current_run'")
        con.close()
        problems = check_db_parity.check(self.tmp, self.db)
        self.assertFalse(any('current_run' in p for p in problems), problems)
        # файла нет, а тень указывает на run — расхождение
        con = sqlite3.connect(self.db)
        with con:
            con.execute("INSERT INTO meta VALUES ('current_run', 'ghost-1')")
        con.close()
        problems = check_db_parity.check(self.tmp, self.db)
        self.assertTrue(any('файла-указателя нет' in p for p in problems), problems)

    def test_env_flag_resolution(self):
        self.assertIsNone(lesson_db.db_path_from_env('/x'))
        os.environ['LESSON_DB'] = '1'
        self.assertEqual(lesson_db.db_path_from_env('/x'), '/x/lesson.db')
        os.environ['LESSON_DB'] = '/custom/path.db'
        self.assertEqual(lesson_db.db_path_from_env('/x'), '/custom/path.db')
        os.environ.pop('LESSON_DB', None)


if __name__ == '__main__':
    unittest.main()
