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


class TestXssEscaping(unittest.TestCase):
    """Аудит сервера 18.07, critical 1 (красный-без-фикса): невалидированный seat/step
    и клиентские тексты не должны исполняться в origin ведущего — ни в HTML-тексте,
    ни внутри onclick-атрибутов (обе разновидности кавычек)."""

    EVIL_SEAT_HTML = '"><img src=x onerror=alert(1)>'   # вырывается из атрибута/тега
    EVIL_SEAT_JS = "9' onmouseover='alert(2)"           # вырывается из onclick='...'
    EVIL_STEP = "s2');alert(3);//"                      # вырывается из JS-строки

    def _store(self):
        st = FakeStore({
            self.EVIL_SEAT_HTML: online_seat(),
            self.EVIL_SEAT_JS: online_seat(),
        })
        for s in (self.EVIL_SEAT_HTML, self.EVIL_SEAT_JS):
            st.state['seats'][s]['acked_step'] = 's1'
        st.state['steps_meta'] = [
            {'id': 's1', 'type': 'gate', 'label': 'гейт', 'gate': 'code'},
            {'id': self.EVIL_STEP, 'type': 'trainer_act', 'label': 'коробка',
             'has_version': True},
        ]
        st.state['commits'] = {self.EVIL_SEAT_HTML: {self.EVIL_STEP: {
            'version': {'data': {'readable': '<script>xss-v</script>'},
                        'ts': 1, 'op_id': 'o1'}}}}
        st.state['reveal'] = {self.EVIL_STEP: {
            'open': False, 'payload_rev': 0, 'anon_versions': [],
            'n_set': [self.EVIL_SEAT_HTML, self.EVIL_SEAT_JS], 'override': None}}
        st.state['chat'] = [{'seq': 1, 'seat': self.EVIL_SEAT_JS, 'step': 's1',
                             'text': '<script>xss-chat</script>', 'ts': 1}]
        st.state['gates'] = {'s1': {'code': '<script>xss-code</script>',
                                    'code_shown': True,
                                    'arrived': [self.EVIL_SEAT_HTML]}}
        st.state['log'] = [{'op': 'reset_version', 'seat': self.EVIL_SEAT_JS,
                            'step': self.EVIL_STEP, 'ts': 1}]
        return st

    def test_payloads_never_reach_dom_raw(self):
        html = dash_lesson.render_lesson_panel(self._store(), [], {}, True)
        self.assertNotIn('<img', html)                        # выход из HTML (сырой тег)
        self.assertNotIn('<script>xss', html)                 # сырой script-тег
        self.assertNotIn("' onmouseover='", html)             # выход из '-атрибута
        self.assertNotIn("');alert(3)", html)                 # выход из JS-строки в onclick
        # пейлоады присутствуют ТОЛЬКО в заэскейпленном (инертном) виде
        self.assertIn('&lt;img src=x', html)


class TestBrokenPayloadSurvives(unittest.TestCase):
    """Аудит сервера 18.07, high: снапшот с payload-массивом/строкой не должен
    ронять рендер всей панели («панель занятия недоступна»)."""

    def test_panel_renders_with_non_dict_payload(self):
        class BadSnapStore(FakeStore):
            def read_snapshot(self, run_id, seat):
                return {'payload': ['не', 'словарь'], 'state': 42}
        store = BadSnapStore({'1': online_seat()})
        html = dash_lesson.render_lesson_panel(store, [], {'1': 'Тест-А'}, True)
        self.assertIn('Тест-А', html)   # панель отрисовалась, ребёнок в таблице


class TestLegendHierarchy(unittest.TestCase):
    """Заход И4-Д (правка G): легенда-простыня «Как читать панель» (5 абзацев в потоке)
    убита — расшифровка значков переехала в «?»-тултипы на заголовках колонок
    (progressive disclosure), внизу осталась только компактная свёрнутая справка про
    не-колоночное (цвет строк, замок, гейт). Основные статусы — словом в ячейке."""

    def _html(self):
        return render(dump('sA', 1, [{'type': 'seat'}], last_ago_s=20), {'1': online_seat()})

    def test_column_headers_have_help_affordance(self):
        html = self._html()
        # у каждой из 8 колонок — «?»-affordance с тултипом-расшифровкой
        self.assertGreaterEqual(html.count('class="zhelp'), 8)
        self.assertIn('<span class="ztip">', html)
        # смысл колонки — словом в самой шапке, «?» стоит рядом
        self.assertIn('связь<span class="zhelp"', html)
        self.assertIn('помощь<span class="zhelp zr"', html)   # правая колонка — тултип влево

    def test_secondary_symbols_decoded_in_tooltip_not_in_flow(self):
        html = self._html()
        # вторичная расшифровка (глубина подсказок, «две сессии») живёт в тултипе-«?»,
        # а не сплошным текстом внизу
        self.assertIn('глубины подсказки', html)
        self.assertIn('ссылку переслали', html)

    def test_legend_essay_collapsed_and_compact(self):
        html = self._html()
        # свёртка сохранена (её открытость переживает reload — e2e sessionStorage),
        # summary по-прежнему «Как читать»
        self.assertIn('<summary>ℹ️ Как читать панель</summary>', html)
        # но эссе-простыни из старых 5 абзацев больше нет: раздел «Замер:»/«Версия/Прогноз:»
        # как отдельные жирные абзацы легенды удалён (расшифровка ушла в «?»)
        self.assertNotIn('<b>Замер:</b>', html)
        self.assertNotIn('<b>Версия/Прогноз:</b>', html)
        # блок легенды короткий — не разросся обратно в простыню
        legend = html.split('Как читать панель</summary>', 1)[1].split('</details>', 1)[0]
        self.assertLess(len(legend), 800)

    def test_wide_table_wrapped_for_horizontal_scroll(self):
        html = self._html()
        # широкую таблицу скроллим внутри блока, а не рвём страницу (ui-ux-pro-max §Responsive)
        self.assertIn('<div class="ztable-wrap"><table>', html)

    def test_help_affordance_markup_wellformed(self):
        # «?»-affordance доступен: focusable (tap на планшете) + aria-label для скринридера,
        # текст тултипа продублирован в aria-label (не только визуальный «?»)
        html = self._html()
        self.assertIn('tabindex="0" role="button" aria-label="', html)
        self.assertIn('<span aria-hidden="true">?</span>', html)


if __name__ == '__main__':
    unittest.main()
