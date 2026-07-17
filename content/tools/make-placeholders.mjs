#!/usr/bin/env node
/* Плейсхолдер-ассеты: создаёт 1×1 PNG для каждого img/src/карточки манифеста, которых
 * ещё нет в content/<занятие>/assets/ (валидатор требует существования файлов — §1.2).
 * Реальные картинки (пилот §6 + генерация image-bridge §7 п.2а) кладутся ПОВЕРХ теми же
 * именами. Использование: node content/tools/make-placeholders.mjs [content/z1-kot ...] */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const CONTENT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const PNG1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNiYGBgAAAABQAB' +
  'h6FO1AAAAABJRU5ErkJggg==', 'base64');

const dirs = process.argv.slice(2).map(a => path.resolve(a));
const targets = dirs.length ? dirs
  : fs.readdirSync(CONTENT).map(d => path.join(CONTENT, d))
      .filter(d => fs.existsSync(path.join(d, 'lesson.json')));

for (const dir of targets) {
  const lesson = JSON.parse(fs.readFileSync(path.join(dir, 'lesson.json'), 'utf-8')).lesson;
  const bank = JSON.parse(fs.readFileSync(path.join(dir, 'bank.json'), 'utf-8'));
  const rels = new Set();
  for (const step of [...lesson.steps, ...(lesson.reserve_steps || [])]) {
    for (const c of step.cards || []) rels.add(c.img);
    for (const c of step.reveal?.cards || []) rels.add(c);
    for (const c of step.next_block?.cards || []) rels.add(c);
  }
  for (const img of bank.images) rels.add(img.src);
  let made = 0;
  for (const rel of rels) {
    const p = path.join(dir, 'assets', rel);
    if (fs.existsSync(p)) continue;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, PNG1X1);
    made += 1;
  }
  console.log(`${path.basename(dir)}: ассетов ${rels.size}, создано плейсхолдеров ${made}`);
}
