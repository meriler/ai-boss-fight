#!/usr/bin/env python3
"""Агрегатор рубрики воркшопа (CLI): JSONL телеметрии → markdown-таблица фактов по каждому ребёнку.

Использование:
  ssh aeza 'cat /var/lib/ws-tele/2026-07-13.jsonl' | python3 rubric.py
  python3 rubric.py путь/к/*.jsonl
  ... --include-demo        # для прогона на e2e-данных (иначе demo:true отсеивается)

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
from telemetry_model import parse_lines, dedupe, build_children, cut, fmt_r


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
    dumps = dedupe(raws, include_demo)
    kids = build_children(dumps)

    hdr = ['seat', 'дошёл до', 'гипотеза', 'guess', 'починка', 'застр.', 'до→после', 'опрос', 'клетка рубрики']
    print('| ' + ' | '.join(hdr) + ' |')
    print('|' + '---|' * len(hdr))
    for k in kids:
        row = [
            str(k['seat']) if k['seat'] is not None else '?',
            k['stage'], cut(k['hyp']), k['guessCat'], k['fixChosen'], str(k['stuck']),
            f"{fmt_r(k['r1'])}→{fmt_r(k['r2'])}",
            ' · '.join(cut(s, 40) for s in k['survey']) or '—',
            k['klass'] + (f" · {k['restarts']} перезап." if k['restarts'] else ''),
        ]
        print('| ' + ' | '.join(x.replace('|', '/') for x in row) + ' |')
    print(f"\nсессий после фильтров: {len(dumps)} · детей (seat): {len(kids)}")
    broke = sum(1 for k in kids if k['broke'])
    print(f"поломка пробника у детей: {broke}/{len(kids)}")
    texts = [k for k in kids if (k['hyp'] not in ('—',) and not k['hyp'].startswith('🤷')) or k['survey']]
    if texts:
        print('\n## Полные тексты (разметка руками по кодбуку — см. шапку скрипта)')
        for k in texts:
            print(f"\n**seat {k['seat']}** · гипотеза: {k['hyp']}")
            for i, s in enumerate(k['survey']):
                print(f"  {i + 1}. {s}")


if __name__ == '__main__':
    main()
