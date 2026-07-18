#!/usr/bin/env python3
"""Тесты живых тревог воркшоп-контура на главной панели занятия (dash_lesson,
Codex-ревью И3 п.4): boot_dead / две сессии / тишина 5 мин / серия неверных кодов
гейта / невалидные кадры / перезапуски — видны в блоке «СЕЙЧАС» и в таблице;
ребёнок со сломанной загрузкой НЕ выглядит «🟢 на связи»; мёртвые сессии (тишина
>30 мин — старые тесты) тревог не поднимают.

Чистый рендер: FakeStore + синтетические дампы через telemetry_model.dedupe —
HTTP-сервер не нужен. Запуск: python3 -m unittest discover -s server"""
import os
import sys
import time
import unittest
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dash_lesson  # noqa: E402
from telemetry_model import dedupe  # noqa: E402

NOW = datetime.now().astimezone()


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%S%z')


def dump(sid, seat, events, last_ago_s=10, dur_s=600, recv_ago_s=0, recv_first_ago_s=None):
    """Сырые записи /tele одного sid; клиентские часы синхронны с серверными.
    last_ago_s — сколько секунд назад случилось ПОСЛЕДНЕЕ событие (управляет last_seen).
    recv_first_ago_s — добавить раннюю запись того же sid (окно приёма для mixed-детекта)."""
    recv = NOW - timedelta(seconds=recv_ago_s)
    started = recv - timedelta(seconds=dur_s)
    max_t = (dur_s - last_ago_s) * 1000
    evs = [dict(e) for e in events] or [{'type': 'seat'}]
    for i, e in enumerate(evs):
        e.setdefault('t', min(max_t, i * 1000))
    evs[-1]['t'] = max_t
    d = {'sid': sid, 'seat': seat, 'ws': 1, 'demo': True,
         'started': iso(started),
         'now': started.timestamp() * 1000 + dur_s * 1000,
         'events': evs}
    recs = [{'recv': iso(recv), 'data': d}]
    if recv_first_ago_s is not None:
        recs.insert(0, {'recv': iso(NOW - timedelta(seconds=recv_first_ago_s)),
                        'data': {**d, 'events': evs[:1]}})
    return recs


class FakeStore:
    """Минимальный интерфейс LessonStore для чистого рендера панели."""

    def __init__(self, seats=None):
        self.state = {'run_id': 'r-test', 'lesson_id': 'z1-kot', 'current_step': 's2',
                      'steps_meta': [], 'seats': seats or {}, 'commits': {},
                      'reveal': {}, 'gates': {}, 'reserve_active': 'none',
                      'reactions': [], 'chat': [], 'log': []}

    def view(self):
        return self.state

    def read_snapshot(self, run_id, seat):
        return {}


def online_seat():
    """Живой контур занятия: вкладка открыта и поллит /sync."""
    return {'instance': 'i1', 'last_sync': int(time.time() * 1000), 'acked_step': 's2'}


def render(raws, seats):
    dumps = dedupe(raws, include_demo=True)
    return dash_lesson.render_lesson_panel(FakeStore(seats), dumps, {'1': 'Тест-А'}, True)


class TestWsAlarms(unittest.TestCase):
    def test_boot_dead_overrides_online(self):
        # поллинг /sync жив (был бы «🟢 на связи»), но телеметрия говорит boot_fail
        # без boot_ok — ребёнок со сломанной загрузкой не должен выглядеть «на связи»
        # «на связи»/«💥» живут и в тултипах-легенде — статус ребёнка проверяем по ЯЧЕЙКЕ
        html = render(dump('sA', 1, [{'type': 'boot_fail'}], last_ago_s=30),
                      {'1': online_seat()})
        self.assertIn('<td>💥 загрузка не встала', html)
        self.assertNotIn('<td>🟢 на связи', html)
        self.assertIn('boot_fail без boot_ok', html)          # причина — в блоке «СЕЙЧАС»

    def test_boot_ok_after_fail_clears(self):
        html = render(dump('sA', 1, [{'type': 'boot_fail'}, {'type': 'boot_ok'}], last_ago_s=30),
                      {'1': online_seat()})
        self.assertNotIn('<td>💥', html)
        self.assertIn('<td>🟢 на связи', html)

    def test_mixed_sessions_and_restarts(self):
        # два sid на одном месте с пересечением окон приёма >60 c → «две сессии»;
        # второй sid — это же и «1 перезап.» в колонке связи
        raws = (dump('sA', 1, [{'type': 'seat'}], last_ago_s=20, recv_ago_s=100,
                     recv_first_ago_s=300)
                + dump('sB', 1, [{'type': 'seat'}], last_ago_s=15, recv_ago_s=90,
                       recv_first_ago_s=280))
        html = render(raws, {'1': online_seat()})
        self.assertIn('⚠️ две сессии', html)
        self.assertIn('1 перезап.', html)
        self.assertIn('ссылку переслали', html)

    def test_silence_5min(self):
        html = render(dump('sA', 1, [{'type': 'seat'}], last_ago_s=360),
                      {'1': online_seat()})
        self.assertIn('😶 тишина 6 мин', html)
        self.assertIn('событий телеметрии нет', html)

    def test_gate_code_fail_series(self):
        evs = [{'type': 'gate_enter', 'ok': False}] * 3
        html = render(dump('sA', 1, evs, last_ago_s=20), {'1': online_seat()})
        self.assertIn('🔢 3 неверных кода', html)
        # успешный вход обрывает серию — тревоги нет
        evs_ok = evs + [{'type': 'gate_enter', 'ok': True}]
        html2 = render(dump('sB', 1, evs_ok, last_ago_s=20), {'1': online_seat()})
        self.assertNotIn('неверных кода', html2)

    def test_invalid_frames_tail(self):
        evs = [{'type': 'sample'}] + [{'type': 'shot_invalid', 'why': 'blur'}] * 4
        html = render(dump('sA', 1, evs, last_ago_s=20), {'1': online_seat()})
        self.assertIn('🚫 кадры не выходят', html)
        self.assertIn('4 невалидных кадра подряд', html)

    def test_dead_session_raises_nothing(self):
        # тишина >30 мин: сессия мёртвая (старый тест) — даже boot_fail не кричит
        html = render(dump('sA', 1, [{'type': 'boot_fail'}], last_ago_s=2000, dur_s=2400),
                      {'1': online_seat()})
        self.assertNotIn('<td>💥', html)
        self.assertNotIn('😶 тишина 33 мин', html)
        self.assertIn('🟢 СПОКОЙНО', html)


if __name__ == '__main__':
    unittest.main()
