#!/usr/bin/env python3
"""Тесты stateful-контура занятия (ТЗ-демка-з1 §4.1) — через НАСТОЯЩИЙ HTTP-сервер tele.py
(ephemeral-порт, WS_TELE_DIR во временной папке): op_id-дедуп, writer_generation-takeover,
event_seq-курсор, серверная склейка /restore, epoch при reset_version, single-writer под
конкуренцией, порядок снапшотов (writer_generation, rev), stale_run, гейт-коды —
и нетронутость контракта /tele + sess_start/sess_stop (DoD п.10).

Запуск: python3 -m unittest discover -s server -v"""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.request
import urllib.error

TMP = tempfile.mkdtemp(prefix='ws-tele-test-')
os.environ['WS_TELE_DIR'] = TMP
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import tele  # noqa: E402  (DIR уже смотрит в TMP)
from http.server import ThreadingHTTPServer  # noqa: E402

SRV = ThreadingHTTPServer(('127.0.0.1', 0), tele.H)
PORT = SRV.server_address[1]
threading.Thread(target=SRV.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d' % PORT
DASH_REF = {'Referer': BASE + '/dash'}   # CSRF-гард host-ручек (как у _admin)


def req(method, path, body=None, headers=None):
    """(status, dict|bytes). JSON-тело — если body dict."""
    data = json.dumps(body).encode() if isinstance(body, dict) else body
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(r) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read()
        status = e.code
    try:
        return status, json.loads(raw)
    except Exception:
        return status, raw


def start_run(lesson_id='z1-kot'):
    st, resp = req('POST', '/host/gate', {'action': 'start', 'lesson_id': lesson_id},
                   headers=DASH_REF)
    assert st == 200, resp
    return resp['run_id']


def commit(run_id, seat, ctype, step, payload=None, op_id=None, instance='inst-%s',
           generation=1, epoch=0):
    body = {'seat': seat, 'run_id': run_id, 'client_instance_id': instance % seat
            if '%s' in instance else instance,
            'writer_generation': generation, 'epoch': epoch,
            'op_id': op_id or ('op-%s-%s-%s' % (seat, ctype, step)),
            'type': ctype, 'step': step, 'payload': payload or {}}
    return req('POST', '/commit', body)


class TestTeleContractUntouched(unittest.TestCase):
    """Риск 6 ТЗ / DoD п.10: /tele и session-<date>.json живут как жили."""

    def test_tele_post_writes_jsonl(self):
        st, _ = req('POST', '/tele', {'sid': 'testsid1', 'events': [{'type': 'seat'}]})
        self.assertEqual(st, 204)
        import time
        fn = os.path.join(TMP, time.strftime('%Y-%m-%d') + '.jsonl')
        with open(fn, encoding='utf-8') as f:
            rows = [json.loads(x) for x in f]
        self.assertTrue(any(r['data']['sid'] == 'testsid1' for r in rows))

    def test_sess_start_separate_file(self):
        st, _ = req('POST', '/dash', b'act=sess_start&date=2026-01-01',
                    headers={'Referer': BASE + '/dash',
                             'Content-Type': 'application/x-www-form-urlencoded'})
        self.assertIn(st, (200, 303))   # urllib сам проходит 303-редирект на /dash
        with open(os.path.join(TMP, 'session-2026-01-01.json'), encoding='utf-8') as f:
            self.assertIn('start', json.load(f))
        # lesson-контур маркеры окна НЕ трогает: файлы разные
        self.assertFalse(os.path.exists(os.path.join(TMP, 'lesson-state-2026-01-01.json')))


class TestMaintenancePause(unittest.TestCase):
    """Maintenance-пауза деплоя (Codex-ревью 18.07, находка 3): флаг-файл есть → мутации 503,
    чтение живёт; /busy отдаёт памятную активность контура (мимо mtime файлов)."""

    def tearDown(self):
        try:
            os.remove(tele.MAINT_FLAG)
        except FileNotFoundError:
            pass

    def test_flag_pauses_mutations_reads_alive(self):
        run = start_run()
        with open(tele.MAINT_FLAG, 'w') as f:
            f.write('deploy')
        st, resp = req('POST', '/save', {
            'seat': '77', 'run_id': run, 'client_instance_id': 'M',
            'writer_generation': 1, 'epoch': 0, 'lesson_id': 'z1-kot',
            'state': {}, 'payload': {}, 'rev': 1, 'ts': 1})
        self.assertEqual(st, 503)
        self.assertEqual(resp['error'], 'maintenance')
        st, _ = commit(run, '77', 'gate_enter', 's1')
        self.assertEqual(st, 503)
        st, view = req('GET', '/restore?seat=77')     # чтение живёт
        self.assertEqual(st, 200)
        st, view = req('GET', '/sync?seat=77')
        self.assertEqual(st, 200)
        st, busy = req('GET', '/busy')
        self.assertTrue(busy['maintenance'])
        os.remove(tele.MAINT_FLAG)
        st, resp = req('POST', '/save', {              # флаг снят — мутации вернулись
            'seat': '77', 'run_id': run, 'client_instance_id': 'M',
            'writer_generation': 1, 'epoch': 0, 'lesson_id': 'z1-kot',
            'state': {}, 'payload': {}, 'rev': 1, 'ts': 1})
        self.assertEqual(st, 200)

    def test_busy_sees_in_memory_sync(self):
        """/sync файлов не трогает (last_sync — только память) — /busy обязан его видеть."""
        start_run()
        st, busy0 = req('GET', '/busy')
        self.assertEqual(st, 200)
        req('GET', '/sync?seat=42')                    # чисто-памятная активность
        st, busy = req('GET', '/busy')
        self.assertIsNotNone(busy['last_activity_s'])
        self.assertLess(busy['last_activity_s'], 5)
        self.assertFalse(busy['maintenance'])


class TestSaveRestore(unittest.TestCase):
    def test_restore_is_server_side_merge(self):
        """Склейка на СЕРВЕРЕ: F5 в окне «коммит принят, дебаунс-сейв не доехал»
        не откатывает принятую версию (§4.1 /restore)."""
        run = start_run()
        st, resp = req('POST', '/save', {
            'seat': '3', 'run_id': run, 'client_instance_id': 'A',
            'writer_generation': 1, 'epoch': 0, 'lesson_id': 'z1-kot',
            'state': {'step': 's2', 'phase': 'version_commit'},
            'payload': {'baskets': [{'img': 't1', 'basket': 'cat'}]},
            'rev': 7, 'ts': 1})
        self.assertEqual(st, 200)
        self.assertEqual(resp['accepted_rev'], 7)
        # коммит ПОСЛЕ снапшота — в снапшоте его нет
        st, resp = commit(run, '3', 'version', 's2', {'slots': {'1': 1}}, instance='A')
        self.assertEqual(st, 200, resp)
        st, view = req('GET', '/restore?seat=3')
        self.assertEqual(st, 200)
        self.assertEqual(view['server_rev'], 7)
        self.assertEqual(view['payload']['baskets'][0]['img'], 't1')
        self.assertIn('version', view['acked'].get('s2', {}))   # склейка: acked поверх снапшота
        self.assertEqual(view['run_id'], run)
        self.assertEqual(view['writer_generation'], 1)
        self.assertEqual(view['epoch'], 0)

    def test_snapshot_order_by_generation_rev(self):
        """Порядок по (writer_generation, rev), НЕ по времени прихода: задержанный rev=4
        не откатывает принятый rev=5; равный rev — идемпотентный no-op."""
        run = start_run()
        base = {'seat': '4', 'run_id': run, 'client_instance_id': 'A',
                'writer_generation': 1, 'epoch': 0, 'lesson_id': 'z1-kot', 'state': {}, 'ts': 1}
        st, r = req('POST', '/save', dict(base, rev=5, payload={'v': 5}))
        self.assertEqual((st, r['accepted_rev']), (200, 5))
        st, r = req('POST', '/save', dict(base, rev=4, payload={'v': 4}))   # сетевое переупорядочивание
        self.assertEqual(st, 409)
        self.assertEqual(r['error'], 'stale')
        self.assertEqual(r['accepted_rev'], 5)
        st, r = req('POST', '/save', dict(base, rev=5, payload={'v': 5}))   # повтор — ок, no-op
        self.assertEqual((st, r['ok']), (200, True))
        st, view = req('GET', '/restore?seat=4')
        self.assertEqual(view['payload'], {'v': 5})

    def test_stale_run_rejected(self):
        """Репетиция утром → урок вечером: вкладка старого прогона не пишет в новый."""
        run_old = start_run()
        body = {'seat': '9', 'run_id': run_old, 'client_instance_id': 'A',
                'writer_generation': 1, 'epoch': 0, 'lesson_id': 'z1-kot',
                'state': {}, 'payload': {}, 'rev': 1, 'ts': 1}
        st, _ = req('POST', '/save', body)
        self.assertEqual(st, 200)
        start_run()                                   # новый запуск того же занятия
        st, r = req('POST', '/save', dict(body, rev=2))
        self.assertEqual(st, 409)
        self.assertEqual(r['error'], 'stale_run')
        st, view = req('GET', '/restore?seat=9')      # restore смотрит в НОВЫЙ чистый run
        self.assertEqual(st, 200)
        self.assertIsNone(view['payload'])
        self.assertEqual(view['server_rev'], 0)


class TestSaveEpochGuard(unittest.TestCase):
    def test_delayed_snapshot_after_reset_rejected(self):
        """Аудит ядра 18.07, critical 2: /save несёт epoch; задержанный снапшот,
        собранный ДО /host/reset_version, не записывается после сброса и не
        возвращает отменённую версию."""
        run = start_run()
        body = {'seat': '11', 'run_id': run, 'client_instance_id': 'E',
                'writer_generation': 1, 'epoch': 0, 'lesson_id': 'z1-kot',
                'state': 's2', 'payload': {'version': {'slots': {'1': 1}}},
                'rev': 5, 'ts': 1}
        st, r = req('POST', '/save', body)
        self.assertEqual(st, 200, r)
        # ведущий сбрасывает версию → epoch 1
        st, r = req('POST', '/host/reset_version', {'seat': '11', 'step': 's2'},
                    headers=DASH_REF)
        self.assertEqual((st, r['epoch']), (200, 1))
        # задержанный снапшот старой эпохи (в нём ещё отменённая версия) — отказ
        st, r = req('POST', '/save', dict(body, rev=6))
        self.assertEqual((st, r['error']), (409, 'stale_epoch'))
        self.assertEqual(r['epoch'], 1)
        # снапшот без epoch вовсе (гипотетический старый клиент) — тоже отказ
        legacy = dict(body, rev=7)
        del legacy['epoch']
        st, r = req('POST', '/save', legacy)
        self.assertEqual((st, r['error']), (409, 'stale_epoch'))
        # свежий снапшот новой эпохи (версия уже вычищена клиентом) — принят
        st, r = req('POST', '/save', dict(body, rev=8, epoch=1,
                                          payload={'version': {'slots': {}}}))
        self.assertEqual(st, 200, r)

    def test_done_state_written_at_same_rev(self):
        """Аудит 18.07, п.5: state='done' не двигает rev (вне журнала) — веха финала
        обязана перезаписать снапшот при том же (generation, rev), иначе F5 после
        финала перепоказывает последний шаг."""
        run = start_run()
        body = {'seat': '13', 'run_id': run, 'client_instance_id': 'D',
                'writer_generation': 1, 'epoch': 0, 'lesson_id': 'z1-kot',
                'state': 's8', 'payload': {'p': 1}, 'rev': 4, 'ts': 1}
        st, r = req('POST', '/save', body)
        self.assertEqual(st, 200, r)
        st, r = req('POST', '/save', dict(body, state='done'))   # тот же rev, новая веха
        self.assertEqual(st, 200, r)
        st, view = req('GET', '/restore?seat=13')
        self.assertEqual(view['state'], 'done')
        # полный идемпотентный повтор (ничего не изменилось) — по-прежнему no-op
        st, r = req('POST', '/save', dict(body, state='done'))
        self.assertEqual(st, 200, r)

    def test_suspended_roundtrip(self):
        """Аудит 18.07, п.7: позиция основной машины при уходе в резерв хранится
        в снапшоте и возвращается из /restore — F5 внутри резерва не теряет фазу."""
        run = start_run()
        body = {'seat': '12', 'run_id': run, 'client_instance_id': 'S',
                'writer_generation': 1, 'epoch': 0, 'lesson_id': 'z1-kot',
                'state': 'r2', 'payload': {},
                'suspended': {'step': 's2', 'phase': 'baskets'}, 'rev': 2, 'ts': 1}
        st, r = req('POST', '/save', body)
        self.assertEqual(st, 200, r)
        st, view = req('GET', '/restore?seat=12')
        self.assertEqual(view['suspended'], {'step': 's2', 'phase': 'baskets'})
        # выход из резерва: снапшот без suspended — поле очищено
        st, r = req('POST', '/save', dict(body, rev=3, state='s2', suspended=None))
        self.assertEqual(st, 200, r)
        st, view = req('GET', '/restore?seat=12')
        self.assertIsNone(view['suspended'])


class TestWriterTakeover(unittest.TestCase):
    def test_single_writer_and_takeover(self):
        run = start_run()
        a = {'seat': '5', 'run_id': run, 'client_instance_id': 'tabA',
             'writer_generation': 1, 'epoch': 0, 'lesson_id': 'z1-kot',
             'state': {}, 'payload': {'from': 'A'}, 'rev': 3, 'ts': 1}
        st, _ = req('POST', '/save', a)
        self.assertEqual(st, 200)
        # вторая вкладка без takeover — отказ на ЛЮБОЙ мутирующей ручке
        b = dict(a, client_instance_id='tabB', payload={'from': 'B'}, rev=1)
        st, r = req('POST', '/save', b)
        self.assertEqual((st, r['error']), (409, 'other_tab'))
        st, r = req('POST', '/chat', {'seat': '5', 'run_id': run, 'step': 's7',
                                      'text': 'привет', 'client_instance_id': 'tabB',
                                      'writer_generation': 1})
        self.assertEqual((st, r['error']), (409, 'other_tab'))
        # «Продолжить здесь» — атомарный CLAIM-ONLY takeover (аудит 18.07, critical 3):
        # generation+1, но payload перехватчика НЕ пишется — базой остаётся серверный
        # снапшот A (буфер старой вкладки не должен стать базой новой generation)
        st, r = req('POST', '/save', {'seat': '5', 'run_id': run,
                                      'client_instance_id': 'tabB', 'takeover': True})
        self.assertEqual(st, 200, r)
        self.assertEqual(r['writer_generation'], 2)
        self.assertEqual(r['server_rev'], 3)          # клиент чистит журнал до server_rev
        st, view = req('GET', '/restore?seat=5')
        self.assertEqual(view['payload'], {'from': 'A'})   # база — снапшот, не буфер B
        # дальше B пишет сам: снапшот новой generation принят даже с меньшим rev, (2,1) > (1,3)
        st, r = req('POST', '/save', dict(b, writer_generation=2))
        self.assertEqual(st, 200, r)
        st, view = req('GET', '/restore?seat=5')
        self.assertEqual(view['payload'], {'from': 'B'})
        # старая вкладка потеряла право на ВСЁ: save, commit, react
        st, r = req('POST', '/save', dict(a, rev=4))
        self.assertEqual((st, r['error']), (409, 'other_tab'))
        self.assertEqual(r['writer_generation'], 2)   # вкладке сообщают актуальную generation
        st, r = commit(run, '5', 'version', 's2', instance='tabA', generation=1)
        self.assertEqual((st, r['error']), (409, 'other_tab'))
        st, r = req('POST', '/react', {'seat': '5', 'run_id': run, 'step': 's2',
                                       'client_instance_id': 'tabA', 'writer_generation': 1})
        self.assertEqual((st, r['error']), (409, 'other_tab'))
        # новая вкладка работает
        st, r = commit(run, '5', 'version', 's2', instance='tabB', generation=2)
        self.assertEqual(st, 200, r)


class TestCommitDedupAndEpoch(unittest.TestCase):
    def test_op_id_dedup(self):
        """Потерянный HTTP-ответ + автоповтор НЕ плодит второй коммит/декремент reveal-lock."""
        run = start_run()
        st, r1 = commit(run, '1', 'gate_enter', 's1', op_id='op-gate-1')
        self.assertEqual(st, 200)
        self.assertNotIn('replay', r1)
        st, r2 = commit(run, '1', 'gate_enter', 's1', op_id='op-gate-1')   # ретрай
        self.assertEqual(st, 200)
        self.assertTrue(r2['replay'])
        st, sync = req('GET', '/sync?seat=1&cursor=0')
        self.assertEqual(sync['gate']['s1']['arrived'].count('1'), 1)      # не задвоился

    def test_epoch_guard_after_reset_version(self):
        """/host/reset_version: epoch+1 — залипший ретрай старого коммита отклоняется,
        отменённая версия НЕ воскресает (проверка epoch идёт ДО дедупа op_id)."""
        run = start_run()
        commit(run, '2', 'gate_enter', 's1')
        st, _ = commit(run, '2', 'version', 's2', {'slots': {'1': 2}}, op_id='op-v-orig')
        self.assertEqual(st, 200)
        st, _ = commit(run, '2', 'choice', 's2', {'option': 1})
        self.assertEqual(st, 200)
        st, r = req('POST', '/host/reset_version', {'seat': '2', 'step': 's2'},
                    headers=DASH_REF)
        self.assertEqual(st, 200)
        self.assertEqual(r['epoch'], 1)
        st, sync = req('GET', '/sync?seat=2&cursor=0')
        self.assertEqual(sync['seat']['version_status'], 'reset')
        self.assertEqual(sync['seat']['epoch'], 1)
        # залипший ретрай СТАРОГО коммита (тот же op_id, старый epoch) — отказ, не replay
        st, r = commit(run, '2', 'version', 's2', {'slots': {'1': 2}},
                       op_id='op-v-orig', epoch=0)
        self.assertEqual((st, r['error']), (409, 'stale_epoch'))
        st, view = req('GET', '/restore?seat=2')
        self.assertNotIn('version', view['acked'].get('s2', {}))           # не воскресла
        # честный повторный коммит с актуальным epoch — принимается
        st, r = commit(run, '2', 'version', 's2', {'slots': {'1': 3}},
                       op_id='op-v-new', epoch=1)
        self.assertEqual(st, 200, r)

    def test_gate_code_check(self):
        run = start_run()
        st, _ = req('POST', '/host/gate', {'action': 'code', 'step': 's1', 'code': '33'},
                    headers=DASH_REF)
        self.assertEqual(st, 200)
        st, r = commit(run, '6', 'gate_enter', 's1', {'code': '99'}, op_id='op-bad')
        self.assertEqual((st, r['error']), (409, 'bad_code'))
        st, r = commit(run, '6', 'gate_enter', 's1', {'code': '33'}, op_id='op-good')
        self.assertEqual(st, 200)
        # код в /sync скрыт, пока ведущий не «показал»
        st, sync = req('GET', '/sync?seat=6&cursor=0')
        self.assertIsNone(sync['gate']['s1']['code'])
        req('POST', '/host/gate', {'action': 'code', 'step': 's1', 'show': True},
            headers=DASH_REF)
        st, sync = req('GET', '/sync?seat=6&cursor=0')
        self.assertEqual(sync['gate']['s1']['code'], '33')


class TestRevealLock(unittest.TestCase):
    def test_lock_n_fixation_late_and_override(self):
        run = start_run()
        for seat in ('1', '2'):
            commit(run, seat, 'gate_enter', 's1')
        # первый version фиксирует N = [1, 2]
        st, _ = commit(run, '1', 'version', 's2', {'text': 'фон!'})
        self.assertEqual(st, 200)
        st, _ = commit(run, '1', 'choice', 's2', {'option': 1})
        self.assertEqual(st, 200)
        # reveal заперт: у seat 2 нет ОБОИХ коммитов
        st, r = req('POST', '/host/reveal', {'step': 's2'}, headers=DASH_REF)
        self.assertEqual((st, r['error']), (409, 'not_ready'))
        self.assertEqual(r['missing'], ['2'])
        # версия без choice — всё ещё заперт (готовность = ОБА коммита, §4.1)
        commit(run, '2', 'version', 's2', {'text': 'уши'})
        st, r = req('POST', '/host/reveal', {'step': 's2'}, headers=DASH_REF)
        self.assertEqual(st, 409)
        commit(run, '2', 'choice', 's2', {'option': 0})
        st, r = req('POST', '/host/reveal', {'step': 's2'}, headers=DASH_REF)
        self.assertEqual(st, 200, r)
        st, sync = req('GET', '/sync?seat=1&cursor=0')
        self.assertTrue(sync['reveal']['s2']['open'])
        self.assertEqual(len(sync['reveal']['s2']['anon_versions']), 2)
        rev_before = sync['reveal']['s2']['payload_rev']
        # поздний коммит (seat 3 вне зафиксированного N): late + доклейка payload_rev+1
        commit(run, '3', 'gate_enter', 's1')
        st, r = commit(run, '3', 'version', 's2', {'text': 'поздняя'})
        self.assertEqual(st, 200)
        self.assertTrue(r.get('late'))
        st, sync = req('GET', '/sync?seat=1&cursor=0')
        self.assertEqual(sync['reveal']['s2']['payload_rev'], rev_before + 1)
        self.assertEqual(len(sync['reveal']['s2']['anon_versions']), 3)

    def test_override_logged(self):
        run = start_run()
        for seat in ('1', '2'):
            commit(run, seat, 'gate_enter', 's1')
        commit(run, '1', 'version', 's2', {'text': 'v'})
        commit(run, '1', 'choice', 's2', {'option': 1})
        # seat 2 отвалился → override с явным списком + лог
        st, r = req('POST', '/host/override', {'step': 's2', 'seat_missing': ['2']},
                    headers=DASH_REF)
        self.assertEqual(st, 200)
        st, sync = req('GET', '/sync?seat=1&cursor=0')
        self.assertTrue(sync['reveal']['s2']['open'])
        with open(os.path.join(TMP, 'lesson-state-%s.json' % run), encoding='utf-8') as f:
            state = json.load(f)
        self.assertTrue(any(e['op'] == 'override' and e['seat_missing'] == ['2']
                            for e in state['log']))

    def test_host_routes_need_dash_referer(self):
        st, r = req('POST', '/host/reveal', {'step': 's2'})   # без Referer
        self.assertEqual(st, 403)


class TestSyncCursor(unittest.TestCase):
    def test_event_seq_cursor_monotonic(self):
        """Курсор — монотонный event_seq, НЕ timestamp: события с равными ts не теряются,
        дельта отдаётся строго по seq > cursor."""
        run = start_run()
        st, s0 = req('GET', '/sync?seat=1&cursor=0')
        c0 = s0['next_cursor']
        # два сообщения «в один момент» — seq всё равно различит
        for txt in ('раз', 'два'):
            st, r = req('POST', '/chat', {'seat': '1', 'run_id': run, 'step': 's7',
                                          'text': txt, 'client_instance_id': 'X',
                                          'writer_generation': 1})
            self.assertEqual(st, 200, r)
        st, s1 = req('GET', '/sync?seat=1&cursor=%d' % c0)
        self.assertEqual([m['text'] for m in s1['chat_delta']], ['раз', 'два'])
        self.assertGreater(s1['next_cursor'], c0)
        # применённый курсор → дельта пуста; старый курсор → дельта отдаётся заново
        st, s2 = req('GET', '/sync?seat=1&cursor=%d' % s1['next_cursor'])
        self.assertEqual(s2['chat_delta'], [])
        st, s3 = req('GET', '/sync?seat=1&cursor=%d' % c0)
        self.assertEqual(len(s3['chat_delta']), 2)

    def test_current_step_and_reserve(self):
        run = start_run()
        req('POST', '/host/gate', {'action': 'step', 'step': 's6'}, headers=DASH_REF)
        req('POST', '/host/gate', {'action': 'reserve', 'which': 'trainer'}, headers=DASH_REF)
        st, sync = req('GET', '/sync?seat=1&cursor=0')
        self.assertEqual(sync['current_step'], 's6')          # точка входа догоняющего (§1.1)
        self.assertEqual(sync['reserve_active'], 'trainer')


class TestConcurrency(unittest.TestCase):
    def test_single_writer_lock_под_конкуренцией(self):
        """8 клиентов молотят мутации параллельно — состояние консистентно, файл валиден."""
        run = start_run()
        errors = []

        def child(seat):
            try:
                st, r = commit(run, seat, 'gate_enter', 's1', op_id='op-c-%s' % seat)
                assert st == 200, r
                st, r = req('POST', '/react', {'seat': seat, 'run_id': run, 'step': 's2',
                                               'client_instance_id': 'inst-%s' % seat,
                                               'writer_generation': 1})
                assert st == 200, r
                st, r = req('POST', '/save', {'seat': seat, 'run_id': run,
                                              'client_instance_id': 'inst-%s' % seat,
                                              'writer_generation': 1, 'epoch': 0, 'lesson_id': 'z1-kot',
                                              'state': {}, 'payload': {'seat': seat},
                                              'rev': 1, 'ts': 1})
                assert st == 200, r
            except Exception as e:   # noqa: BLE001
                errors.append('%s: %s' % (seat, e))

        threads = [threading.Thread(target=child, args=(str(i),)) for i in range(1, 9)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        st, sync = req('GET', '/sync?seat=1&cursor=0')
        self.assertEqual(sorted(sync['gate']['s1']['arrived'], key=int),
                         [str(i) for i in range(1, 9)])
        self.assertEqual(sync['reactions_count'], 8)
        with open(os.path.join(TMP, 'lesson-state-%s.json' % run), encoding='utf-8') as f:
            state = json.load(f)                               # атомарная запись не побилась
        self.assertEqual(state['event_seq'], sync['next_cursor'])


if __name__ == '__main__':
    unittest.main()
