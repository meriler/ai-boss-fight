#!/usr/bin/env python3
"""Агрегатор рубрики воркшопа (CLI): JSONL телеметрии → markdown-таблица фактов по каждому ребёнку.

Использование (СТРОГО ОДИН ДЕНЬ ЗА ПРОГОН — тот же seat в другой день = другой ребёнок):
  ssh aeza 'cat /var/lib/ws-tele/2026-07-13.jsonl' | python3 rubric.py
  python3 rubric.py путь/к/2026-07-15.jsonl
  ... --include-demo        # для прогона на e2e-данных (иначе demo:true отсеивается)
Многодневный вход не падает, но режется по датам приёма (отдельная таблица на день)
с предупреждением — склейка разных детей по одному seat невозможна (аудит+Codex 10.07).

Веб-вариант той же таблицы: https://ws.meriler.cc/dash (basic auth). Логика — telemetry_model.py.

Правила (план доводки §3.1 + ТЗ «Агрегация в рубрику»):
- дедуп: на sid берётся самый полный дамп; РЕБЁНОК = seat (F5 плодит sid, сессии склеиваются);
- фильтры: demo:true — вон (кроме --include-demo); ws:true обязателен; seat:null — UNSEATED;
- «не оценено»: assessed:false (nogate) / outcome no_break|inconclusive;
- TELEMETRY_LOST: ранний обрыв — НЕ путать с «не досидел».

КОДБУК словесной оси (разметка руками, автоклетка — предварительная):
- «назвал причину про данные» = текст гипотезы содержит причину из мира данных/признаков:
  ✅ «показывал только большие ладони», «он запомнил размер», «мало разных примеров», «смотрел на фон»
  ❌ «камера плохая», «ИИ тупой», «не знаю», междометия/мусор
- конфликт текста и выбора варианта: ТЕКСТ ГЛАВНЕЕ (он был раньше и без подсказок);
- dontknow=true — честное «не знал» (лучше мусора, клетка «не понял» по словесной оси);
- «частично сам» (fix_choice верный со 2-й попытки) — считается «сам» с пометкой ±;
- спорные строки размечают ДВОЕ (Алексей + Клава), расхождения обсуждаются.
"""
import glob, sys
from telemetry_model import (parse_lines, dedupe, build_children, cut, fmt_r,
                             split_by_date, fmt_stages, fmt_hw)


def report_day(raws, include_demo):
    dumps = dedupe(raws, include_demo)
    kids = build_children(dumps)

    hdr = ['seat', 'дошёл до', 'гипотеза', 'guess', 'починка', 'застр.', 'до→после', 'опрос',
           'фазы, мин', 'железо', 'клетка рубрики']
    print('| ' + ' | '.join(hdr) + ' |')
    print('|' + '---|' * len(hdr))
    for k in kids:
        inv_txt = (' · кадры✗ ' + '/'.join(f'{w}:{n}' for w, n in k['inv'].items())) if k['inv'] else ''
        row = [
            str(k['seat']) if k['seat'] is not None else '?',
            k['stage'], cut(k['hyp']), k['guessCat'], k['fixChosen'],
            str(k['stuck']) + (f' · замок✗{k["lock_fails"]}' if k['lock_fails'] else '') + inv_txt,
            f"{fmt_r(k['r1'])}→{fmt_r(k['r2'])}",
            ' · '.join(cut(s, 40) for s in k['survey']) or '—',
            fmt_stages(k['stage_min']), fmt_hw(k),
            k['klass'] + (' · 🎓 серт' if k['cert'] else '') + (f" · {k['restarts']} перезап." if k['restarts'] else ''),
        ]
        print('| ' + ' | '.join(x.replace('|', '/') for x in row) + ' |')
    print(f"\nсессий после фильтров: {len(dumps)} · детей (seat): {len(kids)}")
    broke = sum(1 for k in kids if k['broke'])
    print(f"поломка пробника у детей: {broke}/{len(kids)}")

    # операционка по группе — «уложились ли» и «потянуло ли железо» (аудит 10.07)
    if kids:
        print('\n## Операционка по группе')
        for ph in ('сбор', 'проверка', 'разбор', 'починка', 'опрос'):
            vals = sorted(k['stage_min'][ph] for k in kids if k['stage_min'].get(ph) is not None)
            if vals:
                print(f"- {ph}: медиана {vals[len(vals) // 2]} мин (min {vals[0]} · max {vals[-1]}, n={len(vals)})")
        durs = sorted(k['dur_min'] for k in kids if k['dur_min'])
        if durs:
            print(f"- длительность сессии: медиана {durs[len(durs) // 2]} мин · max {durs[-1]}")
        fps = sorted(k['fps_min'] for k in kids if k['fps_min'] is not None)
        if fps:
            print(f"- fps: худший {fps[0]} · медианный-худший {fps[len(fps) // 2]}")
        camd = [k for k in kids if k['cam_drops']]
        if camd:
            print(f"- дропы камеры у {len(camd)} детей: " + ', '.join(f"seat {k['seat']}×{k['cam_drops']}" for k in camd))

    texts = [k for k in kids if (k['hyp'] not in ('—',) and not k['hyp'].startswith('🤷')) or k['survey']]
    if texts:
        print('\n## Полные тексты (разметка руками по кодбуку — см. шапку скрипта)')
        for k in texts:
            print(f"\n**seat {k['seat']}** · гипотеза: {k['hyp']}")
            for i, s in enumerate(k['survey']):
                print(f"  {i + 1}. {s}")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    include_demo = '--include-demo' in sys.argv
    lines = []
    if args:
        for p in args:
            for fn in glob.glob(p):
                lines += open(fn, encoding='utf-8').readlines()
    else:
        lines = sys.stdin.readlines()
    raws, bad = parse_lines(lines)
    if bad:
        print(f'⚠️ пропущено битых строк JSONL: {bad}', file=sys.stderr)
    by_date = split_by_date(raws)
    if len(by_date) > 1:
        print(f"**⚠️ Вход содержит {len(by_date)} дат приёма ({', '.join(sorted(by_date))}) — "
              f"один seat в разные дни это РАЗНЫЕ дети. Таблицы ниже раздельные, по дню.**\n")
    for date in sorted(by_date):
        if len(by_date) > 1:
            print(f"\n# {date}\n")
        report_day(by_date[date], include_demo)


if __name__ == '__main__':
    main()
