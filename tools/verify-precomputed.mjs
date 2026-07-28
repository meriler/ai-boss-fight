/* Сверка готовых фич с живым расчётом MediaPipe В БРАУЗЕРЕ (приёмка предподсчёта 28.07).
 * Тест precomputed.test.mjs проверяет исходы урока на файле; здесь — что сам файл
 * побитово повторяет то, что считал браузер до перехода. Разошлось хоть на одну картинку —
 * значит предподсчёт делался другим путём, и калибровка урока поедет.
 *
 * Запуск: node tools/verify-precomputed.mjs [--lesson content/z1-kot] [--browser webkit] */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const { webkit, chromium } = createRequire(path.join(ROOT, 'e2e/'))('playwright-core');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const lessonDir = argOf('lesson', 'content/z1-kot');
const browserName = argOf('browser', 'webkit');
const PORT = Number(argOf('port', '8932'));

const server = spawn(process.execPath, ['-e', `
  const http=require('http'), fs=require('fs'), path=require('path'), url=require('url');
  const T={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json',
           '.jpg':'image/jpeg','.png':'image/png','.wasm':'application/wasm'};
  http.createServer((q,s)=>{ const root=${JSON.stringify(ROOT)};
    const p=path.resolve(root, '.' + decodeURIComponent(url.parse(q.url).pathname));
    if(p!==root && !p.startsWith(root+path.sep)){s.writeHead(403);s.end('no');return;}
    fs.readFile(p,(e,b)=>{ if(e){s.writeHead(404);s.end('no');return;}
      s.writeHead(200,{'Content-Type':T[path.extname(p)]||'application/octet-stream'}); s.end(b); }); }).listen(${PORT}, '127.0.0.1');
`], { stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch (_) {} };
process.on('exit', stop);

const br = (browserName === 'chromium' || browserName === 'chrome') ? chromium : webkit;
const launchOpts = browserName === 'chrome' ? { channel: 'chrome' } : {};

(async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/${lessonDir}/bank.json`)).ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  const browser = await br.launch(launchOpts);
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/?delegate=CPU`);

  const out = await page.evaluate(async ({ lessonDir, port }) => {
    const base = `http://127.0.0.1:${port}/`;
    const [{ indexBank }, { createFeatureSource }] = await Promise.all([
      import(base + 'app/core/manifest.js'), import(base + 'app/engine/features.js'),
    ]);
    const bank = await (await fetch(base + lessonDir + '/bank.json')).json();
    const bankIndex = indexBank(bank);
    const mk = featuresBase => createFeatureSource({
      bankIndex, assetsBase: base + lessonDir + '/assets/', vendorBase: base, featuresBase });

    const pre = mk(base + lessonDir + '/');
    await pre.warmup(() => {});
    const live = mk(base + 'нет-такой-папки/');      // готовые фичи не найдутся → MediaPipe
    await live.warmup(() => {});

    const diffs = [];
    for (const img of bank.images) {
      const a = pre.featureOf(img.id), b = live.featureOf(img.id);
      let maxE = 0, maxP = 0;
      for (let i = 0; i < a.emb.length; i++) maxE = Math.max(maxE, Math.abs(a.emb[i] - b.emb[i]));
      for (let i = 0; i < a.pix.length; i++) maxP = Math.max(maxP, Math.abs(a.pix[i] - b.pix[i]));
      diffs.push({ id: img.id, maxE, maxP });
    }
    return { source_pre: pre.source, source_live: live.source, diffs };
  }, { lessonDir, port: PORT });

  await browser.close(); stop();

  const worstE = out.diffs.reduce((a, b) => (b.maxE > a.maxE ? b : a));
  const worstP = out.diffs.reduce((a, b) => (b.maxP > a.maxP ? b : a));
  const exact = out.diffs.filter(d => d.maxE === 0 && d.maxP === 0).length;

  console.log(`источники: готовые=${out.source_pre}, живой=${out.source_live} (${browserName})`);
  console.log(`совпало побитово: ${exact} из ${out.diffs.length}`);
  console.log(`худшее расхождение: emb ${worstE.maxE.toExponential(2)} (${worstE.id}), `
            + `pix ${worstP.maxP.toExponential(2)} (${worstP.id})`);

  if (out.source_pre !== 'precomputed' || out.source_live !== 'mediapipe') {
    console.error('ОШИБКА: сверялись не те источники'); process.exit(1);
  }
  if (exact !== out.diffs.length) {
    console.error('ОШИБКА: готовые фичи разошлись с живым расчётом — пересчитай тем же браузером/делегатом');
    process.exit(1);
  }
  console.log('✅ готовые фичи побитово равны живому расчёту');
})().catch(e => { stop(); console.error('ОШИБКА:', e.message); process.exit(1); });
