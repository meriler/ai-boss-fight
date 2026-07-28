/* Предподсчёт фич банка (Safari-фикс 28.07): «как коробка видит картинку» считается
 * ЗДЕСЬ, один раз, а не в браузере каждого ребёнка. В рантайме остаётся обучение
 * (kNN/head) — оно и есть предмет урока.
 *
 * Почему так: MediaPipe гоняет вход через WebGL ВСЕГДА, независимо от делегата
 * (bindTextureToStream в vision_bundle) — CPU-делегат от графики не спасает. В Safari 26
 * это давало плавающий «Error creating texture name» на первой же картинке; изолированно
 * (diag.html) те же вызовы проходят, в уроке — нет. Перед классом на чужих ноутбуках
 * ловить плавающий GL-баг нечем, поэтому графика убрана из рантайма целиком.
 *
 * Числа обязаны совпасть с тем, что считал браузер: считаем ТЕМ ЖЕ кодом
 * (app/engine/features.js → makeRealExtractor) в настоящем браузере, а не питоном
 * и не своей копией препроцессинга.
 *
 * Запуск:  node tools/precompute-features.mjs [--lesson content/z1-kot] [--browser webkit|chromium]
 * Выход:   <lesson>/features.bin   — Float32 [emb(1024) pix(1024)] × N в порядке манифеста
 *          <lesson>/features.json  — метаданные + sha256 каждой картинки (защита от рассинхрона)
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// playwright живёт в e2e/node_modules — второй копии не заводим
const { webkit, chromium } = createRequire(path.join(ROOT, 'e2e/'))('playwright-core');

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const lessonDir = argOf('lesson', 'content/z1-kot');
const browserName = argOf('browser', 'webkit');
const PORT = Number(argOf('port', '8931'));
const delegate = (argOf('delegate', 'CPU') || 'CPU').toUpperCase();

const lessonAbs = path.resolve(ROOT, lessonDir);
const bank = JSON.parse(fs.readFileSync(path.join(lessonAbs, 'bank.json'), 'utf-8'));
const images = bank.images || [];
if (!images.length) throw new Error('в банке нет картинок: ' + lessonDir);

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);

// --- статика (тот же корень, что у прода: пути в банке относительны assets/) ---
const server = spawn(process.execPath, ['-e', `
  const http=require('http'), fs=require('fs'), path=require('path'), url=require('url');
  const TYPES={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json',
               '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.wasm':'application/wasm','.tflite':'application/octet-stream'};
  http.createServer((req,res)=>{
    const root=${JSON.stringify(ROOT)};
    const p=path.resolve(root, '.' + decodeURIComponent(url.parse(req.url).pathname));
    if(p!==root && !p.startsWith(root+path.sep)){res.writeHead(403);res.end('no');return;}
    fs.readFile(p,(e,b)=>{ if(e){res.writeHead(404);res.end('no');return;}
      res.writeHead(200,{'Content-Type':TYPES[path.extname(p)]||'application/octet-stream'}); res.end(b); });
  }).listen(${PORT}, '127.0.0.1');
`], { stdio: 'ignore' });

const stop = () => { try { server.kill(); } catch (_) {} };
process.on('exit', stop);

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/${lessonDir}/bank.json`); if (r.ok) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('локальный сервер не поднялся');
}

// chrome = системный Chrome (нужен, когда у playwright нет своей сборки под версию)
const br = (browserName === 'chromium' || browserName === 'chrome') ? chromium : webkit;
const launchOpts = browserName === 'chrome' ? { channel: 'chrome' } : {};

(async () => {
  await waitServer();
  const browser = await br.launch(launchOpts);
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push('pageerror: ' + e.message));
  // делегат форсируем через query (features.js читает location.search): предподсчёт
  // должен быть воспроизводим, а не зависеть от того, что выберет машина сборки
  await page.goto(`http://127.0.0.1:${PORT}/?delegate=${delegate}`);

  console.log(`движок: ${browserName}, делегат: ${delegate}, картинок: ${images.length}, банк: ${bank.id} (params_rev ${bank.frozen_params?.params_rev})`);

  const out = await page.evaluate(async ({ lessonDir, port }) => {
    const base = `http://127.0.0.1:${port}/`;
    const [{ indexBank }, { createFeatureSource }] = await Promise.all([
      import(base + 'app/core/manifest.js'),
      import(base + 'app/engine/features.js'),
    ]);
    const bank = await (await fetch(base + lessonDir + '/bank.json')).json();
    const bankIndex = indexBank(bank);
    // ТОТ ЖЕ путь, что в проде: MediaPipe, CPU-делегат (детерминизм), тот же кроп и нормализация
    const src = createFeatureSource({
      bankIndex,
      assetsBase: base + lessonDir + '/assets/',   // как в app.js:54
      vendorBase: base,
      demo: false,
      // КРИТИЧНО: путь к готовым фичам заведомо несуществующий. Иначе генератор
      // прочитает СВОЙ ЖЕ прошлый features.bin и «пересчёт» тихо вернёт старые числа —
      // после смены картинок это выдало бы фичи от прежнего банка (поймано 28.07).
      featuresBase: base + 'заведомо-нет-такой-папки/',
    });
    const t0 = performance.now();
    await src.warmup(() => {});
    const ms = Math.round(performance.now() - t0);
    const res = {};
    for (const img of bank.images) {
      const f = src.featureOf(img.id);
      res[img.id] = { emb: Array.from(f.emb), pix: Array.from(f.pix) };
    }
    return { res, ms, source: src.source };
  }, { lessonDir, port: PORT });

  await browser.close();
  stop();

  if (out.source !== 'mediapipe')
    throw new Error(`фичи посчитаны источником «${out.source}», а нужен живой MediaPipe`);

  // --- сериализация ---
  const first = out.res[images[0].id];
  const dimEmb = first.emb.length, dimPix = first.pix.length;
  const buf = Buffer.alloc(images.length * (dimEmb + dimPix) * 4);
  let off = 0;
  const meta = { format: 'f32-emb-pix-v1', bank: bank.id, params_rev: bank.frozen_params?.params_rev ?? null,
                 dim_emb: dimEmb, dim_pix: dimPix, count: images.length,
                 generated_by: `precompute-features.mjs (${browserName}, delegate ${delegate})`, order: [], images: {} };
  for (const img of images) {
    const f = out.res[img.id];
    if (!f || f.emb.length !== dimEmb || f.pix.length !== dimPix) throw new Error('битая фича: ' + img.id);
    for (const v of f.emb) { buf.writeFloatLE(v, off); off += 4; }
    for (const v of f.pix) { buf.writeFloatLE(v, off); off += 4; }
    meta.order.push(img.id);
    const file = path.join(lessonAbs, 'assets', img.src);
    meta.images[img.id] = { src: img.src, sha: sha256(file) };
  }
  if (off !== buf.length) throw new Error('размер не сошёлся');

  // имя файла с хэшем содержимого: браузерный кеш не склеит новый .json со старым .bin
  const binSha = createHash('sha256').update(buf).digest('hex');
  meta.bin = `features-${binSha.slice(0, 12)}.bin`;
  meta.bin_sha256 = binSha;

  for (const f of fs.readdirSync(lessonAbs))            // прежние выпуски не копим
    if (/^features(-[0-9a-f]{12})?\.bin$/.test(f) && f !== meta.bin)
      fs.unlinkSync(path.join(lessonAbs, f));
  fs.writeFileSync(path.join(lessonAbs, meta.bin), buf);
  fs.writeFileSync(path.join(lessonAbs, 'features.json'), JSON.stringify(meta, null, 1) + '\n');

  console.log(`посчитано за ${out.ms} мс`);
  console.log(`${meta.bin}  ${(buf.length / 1024).toFixed(0)} КБ  (${images.length} × ${dimEmb}+${dimPix} float32)`);
  console.log(`features.json ${images.length} записей с sha картинок`);
  if (logs.length) console.log('лог страницы:\n  ' + logs.slice(0, 10).join('\n  '));
})().catch(e => { stop(); console.error('ОШИБКА:', e.message); process.exit(1); });
