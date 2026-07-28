/* FeatureSource «image-embedder» (ТЗ-платформа-v3 §2.2): warmup эмбеддера, фичи картинок
 * банка и demo-синтез — вынос из classifier.js без правок математики. Фичи ортогональны
 * решающей логике (kNN/head): любой EngineCore ест {emb, pix} отсюда.
 *
 * Два режима:
 *  - real: эмбеддинг+пиксели из картинок банка (assets/), эмбеддер MediaPipe ImageEmbedder
 *    (models/mobilenet_v3_small_embedder.tflite) грузится в warmup() ФОНОМ (restore ≤3 c);
 *  - demo (?demo=1, e2e/CI): фикс-фичи, синтезированные из МЕТАДАННЫХ банка (bg/class/id),
 *    без сети и wasm — детерминизм. bg доминирует над class (это и есть «тайная примета»). */

// FNV-1a → [0,1): стабильный хэш строки, никакого Math.random (детерминизм e2e)
function hash01(str, salt = 0) {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h >>> 0) % 100000) / 100000;
}

function unitVec(dim, seedStr, salt) {
  const v = new Float32Array(dim);
  let n = 0;
  for (let i = 0; i < dim; i++) { v[i] = hash01(seedStr, salt + i * 7 + 1) - 0.5; n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

/** Фикс-фича картинки банка: направление bg (вес a=0.9) + направление class (c=0.62) +
 * личный джиттер id (0.12). Направления — независимые hash-вектора (≈ортогональны).
 * Границы considered, не подобраны: c < a ⇒ до ловушек движок «выучивает фон» (флипы R1);
 * c > a/√3 (+запас на hash-шум ~1/√DIM) ⇒ после ловушек класс перевешивает даже когда своих ловушек в k-соседях
 * меньше k (тест-вариант: 2 ловушки на класс при k=3). */
export function demoFeature(img) {
  const DIM = 256;   // hash-вектора «ортогональны» с шумом ~1/√DIM: 24 давало ±0.3 и ломало поля
  const bg = unitVec(DIM, 'bg:' + (img.bg || ''), 11);
  const cls = unitVec(DIM, 'class:' + img.class, 37);
  const jit = unitVec(DIM, 'id:' + img.id, 73);
  const v = new Float32Array(DIM);
  let n = 0;
  for (let i = 0; i < DIM; i++) { v[i] = bg[i] * 0.9 + cls[i] * 0.62 + jit[i] * 0.12; n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return { emb: v, pix: v };
}

/* ---------- реальные фичи: перенос grabFeature из v5.html ---------- */

async function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('картинка не загрузилась: ' + url));
    im.src = url;
  });
}

function makeRealExtractor(embedder) {
  const fcv = document.createElement('canvas'); fcv.width = 224; fcv.height = 224;
  const fx = fcv.getContext('2d');
  const pcv = document.createElement('canvas'); pcv.width = 32; pcv.height = 32;
  const pxc = pcv.getContext('2d', { willReadFrequently: true });
  return (imgEl) => {
    const s = Math.min(imgEl.naturalWidth || imgEl.width, imgEl.naturalHeight || imgEl.height);
    const sx = ((imgEl.naturalWidth || imgEl.width) - s) / 2;
    const sy = ((imgEl.naturalHeight || imgEl.height) - s) / 2;
    fx.drawImage(imgEl, sx, sy, s, s, 0, 0, 224, 224);
    const e = embedder.embed(fcv).embeddings[0].floatEmbedding;
    let ne = 0; for (let i = 0; i < e.length; i++) ne += e[i] * e[i];
    ne = Math.sqrt(ne) || 1;
    const emb = new Float32Array(e.length);
    for (let i = 0; i < e.length; i++) emb[i] = e[i] / ne;
    pxc.imageSmoothingEnabled = true;
    pxc.drawImage(imgEl, sx, sy, s, s, 0, 0, 32, 32);
    const d = pxc.getImageData(0, 0, 32, 32).data, pix = new Float32Array(1024);
    let m = 0;
    for (let i = 0; i < 1024; i++) { const g = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114; pix[i] = g; m += g; }
    m /= 1024;
    let v = 0;
    for (let i = 0; i < 1024; i++) { pix[i] -= m; v += pix[i] * pix[i]; }
    const nrm = Math.sqrt(v) || 1;
    for (let i = 0; i < 1024; i++) pix[i] /= nrm;   // единичная длина → dot = честный cos (урок v5)
    return { emb, pix };
  };
}

/** Источник фич банка: warmup (real — эмбеддер+прогрев всех картинок; demo — мгновенно),
 * featureOf(imgId) — {emb, pix}. Контракт готовности тот же, что был у classifier. */
export function createFeatureSource({ bankIndex, assetsBase = '', demo = false, vendorBase = '',
                                      featuresBase = null } = {}) {
  const features = new Map();   // imgId -> {emb, pix}
  let ready = demo;             // demo готов сразу; real — после warmup()
  let warmErr = null;
  let precomputedErr = null;    // почему не взяли готовые фичи (диагностика аварийного пути)
  let source = demo ? 'demo' : null;   // чем реально посчитаны фичи: precomputed | mediapipe | demo
  // фичи лежат рядом с bank.json (assetsBase = <lesson>/assets/ — см. app.js)
  const featBase = featuresBase != null ? featuresBase : String(assetsBase).replace(/assets\/?$/, '');
  let attempts = 0;             // счётчик warmup-попыток (cache-busting повторного импорта)
  let warmInflight = null;      // single-flight: двойной тап «Попробовать ещё раз» не
                                // плодит параллельные прогревы (хвост ревью 19.07, п.4)
  const MAX_WARM_ATTEMPTS = 5;  // кап cache-bust ретраев: каждый — повторная закачка
                                // wasm-бандла; дальше честно отдаём последнюю ошибку
  const readyWaiters = [];

  function warmup(onProgress = () => {}) {
    if (ready) { onProgress(1); return Promise.resolve(); }
    if (warmInflight) return warmInflight;
    if (attempts >= MAX_WARM_ATTEMPTS) {
      return Promise.reject(warmErr || new Error('прогрев: попытки исчерпаны'));
    }
    warmInflight = doWarmup(onProgress).finally(() => { warmInflight = null; });
    return warmInflight;
  }

  /** Готовые фичи банка (tools/precompute-features.mjs): features.json + features.bin.
   * Основной путь с 28.07 — в рантайме нет ни WASM, ни WebGL, ни модели (−13 МБ и −класс
   * Safari-сбоев «Error creating texture name»). Возвращает false, если файлов нет или они
   * не от этого банка — тогда прогрев честно уходит на MediaPipe (аварийный путь).
   * Молча принять чужие фичи нельзя: это тихо сдвинет калибровку урока. */
  const DIM_EMB = 1024;   // MobileNet V3 small
  const DIM_PIX = 1024;   // пиксельная ветка 32×32 grayscale

  async function sha256Hex(buf) {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null;   // http:// без TLS
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function loadPrecomputed(onProgress) {
    const meta = await fetch(featBase + 'features.json').then(r => {
      if (!r.ok) throw new Error('features.json: HTTP ' + r.status);
      return r.json();
    });
    const bank = bankIndex.bank;
    const ids = (bank.images || []).map(i => i.id);
    const paramsRev = (bank.frozen_params || {}).params_rev ?? null;
    const mismatch =
      meta.format !== 'f32-emb-pix-v1' ? 'формат ' + meta.format
      : meta.bank !== bank.id ? `банк ${meta.bank} ≠ ${bank.id}`
      : (meta.params_rev ?? null) !== paramsRev ? `params_rev ${meta.params_rev} ≠ ${paramsRev}`
      : meta.count !== ids.length ? `картинок ${meta.count} ≠ ${ids.length}`
      : !Array.isArray(meta.order) || meta.order.join(',') !== ids.join(',') ? 'порядок картинок разошёлся'
      // размеры веток фиксированы форматом: иначе пара вроде 0/2048 пройдёт по общей длине,
      // а движок молча получит пустой эмбеддинг и «выучит» мусор
      : meta.dim_emb !== DIM_EMB || meta.dim_pix !== DIM_PIX
        ? `размеры ${meta.dim_emb}/${meta.dim_pix} ≠ ${DIM_EMB}/${DIM_PIX}`
      : typeof meta.bin !== 'string' || !meta.bin ? 'в метаданных нет имени файла фич'
      : null;
    if (mismatch) throw new Error('готовые фичи не от этого банка: ' + mismatch);

    onProgress(0.15);
    // имя файла содержит хэш содержимого — старый .bin из кеша не склеится с новым .json
    const buf = await fetch(featBase + meta.bin).then(r => {
      if (!r.ok) throw new Error(meta.bin + ': HTTP ' + r.status);
      return r.arrayBuffer();
    });
    const stride = DIM_EMB + DIM_PIX;
    const need = ids.length * stride * 4;
    if (buf.byteLength !== need) throw new Error(`${meta.bin}: ${buf.byteLength} байт вместо ${need}`);

    // содержимое той же длины может быть побитым (обрыв, кеш, подмена) — сверяем хэш.
    // Без crypto.subtle (страница по http://) проверка недоступна: тогда полагаемся на
    // длину и на проверку конечности ниже
    const sha = await sha256Hex(buf);
    if (sha && meta.bin_sha256 && sha !== meta.bin_sha256)
      throw new Error(`${meta.bin}: содержимое не совпало с хэшем из метаданных`);

    const all = new Float32Array(buf);
    for (let i = 0; i < all.length; i++) {
      if (!Number.isFinite(all[i])) throw new Error(`${meta.bin}: не-число в позиции ${i}`);
    }

    features.clear();
    for (let i = 0; i < ids.length; i++) {
      const at = i * stride;
      features.set(ids[i], {
        emb: all.subarray(at, at + DIM_EMB),
        pix: all.subarray(at + DIM_EMB, at + stride),
      });
      if ((i & 7) === 0) onProgress(0.15 + 0.85 * (i + 1) / ids.length);
    }
    onProgress(1);
  }

  async function doWarmup(onProgress) {
    warmErr = null;         // повторная попытка (retryWarmup) — с чистого листа
    precomputedErr = null;  // иначе после успеха getter показывал бы прошлую неудачу
    attempts += 1;
    try {
      onProgress(0.05);
      try {
        await loadPrecomputed(onProgress);
        source = 'precomputed';
        ready = true;
        return;                        // MediaPipe не нужен: ни импорта, ни wasm, ни GL
      } catch (e) {
        precomputedErr = e;            // не роняем прогрев: ниже честная попытка MediaPipe
        features.clear();
      }
      // упавший import() браузер кэширует в module map НАВСЕГДА — повторный import
      // того же URL возвращает старую ошибку без сети. «Попробовать ещё раз» обязан
      // реально повторить загрузку → повторные попытки идут с cache-busting query
      // (закалка 18.07, critical embedder: рабочий путь восстановления)
      const bust = attempts > 1 ? '?retry=' + attempts : '';
      const { ImageEmbedder, FilesetResolver } = await import(vendorBase + 'vendor/mediapipe/vision_bundle.mjs' + bust);
      const vision = await FilesetResolver.forVisionTasks(vendorBase + 'vendor/mediapipe/wasm');
      const opt = (d) => ({
        baseOptions: { modelAssetPath: vendorBase + 'models/mobilenet_v3_small_embedder.tflite', delegate: d },
        quantize: false,
      });
      // Делегат: GPU быстрее, но на части машин (наблюдение: Safari) он СОЗДАЁТСЯ
      // успешно и падает уже на первом embed(). Прежний откат ловил только ошибку
      // создания — такой сбой уходил в «модель не загрузилась» без попытки CPU.
      // Теперь откат покрывает и вычисление: словили ошибку на картинке — закрываем
      // GPU-эмбеддер (иначе течёт память при ретраях) и повторяем прогрев на CPU.
      // ?delegate=CPU|GPU — диагностический форс (в Node-тестах location нет)
      const qs = typeof location !== 'undefined' ? location.search : '';
      const forced = (new URLSearchParams(qs).get('delegate') || '').toUpperCase();
      const order = forced === 'CPU' ? ['CPU'] : forced === 'GPU' ? ['GPU'] : ['GPU', 'CPU'];

      const imgs = bankIndex.bank.images;
      // порядок прогрева: сначала обучающие (без них не нажать «Научить»), потом
      // остальные роли — ребёнок доходит до проб позже, а старт становится быстрее
      const order1 = imgs.filter(i => i.role === 'train_core');
      const rest = imgs.filter(i => i.role !== 'train_core');
      const queue = order1.concat(rest);

      let lastErr = null;
      for (const delegate of order) {
        let embedder = null;
        try {
          embedder = await ImageEmbedder.createFromOptions(vision, opt(delegate));
          onProgress(0.4);
          const extract = makeRealExtractor(embedder);
          features.clear();
          for (let i = 0; i < queue.length; i++) {
            const img = queue[i];
            const el = await loadImage(assetsBase + img.src);
            try {
              features.set(img.id, extract(el));
            } catch (e) {
              e.message = `делегат ${delegate}, картинка ${img.id}: ` + e.message;
              throw e;
            }
            onProgress(0.4 + 0.6 * (i + 1) / queue.length);
          }
          lastErr = null;
          // фичи уже в Map — эмбеддер больше не нужен, а держит WASM/WebGL до закрытия
          // вкладки (на слабых машинах это заметно; и лишний живой GL-контекст в Safari)
          try { embedder && embedder.close && embedder.close(); } catch (_) {}
          break;                       // прогрев прошёл целиком
        } catch (e) {
          lastErr = e;
          try { embedder && embedder.close && embedder.close(); } catch (_) { /* уже мёртв */ }
          features.clear();            // частичные фичи от упавшего делегата не годятся
        }
      }
      if (lastErr) throw lastErr;
      source = 'mediapipe';
      ready = true;
    } catch (e) {
      // аварийный путь тоже упал — в причине держим ОБЕ: почему не взяли готовые фичи
      // и почему не смог MediaPipe (иначе первая теряется и сбой нечитаем)
      // причина отказа от готовых фич идёт ПЕРВОЙ: это основной путь, и именно она
      // объясняет, почему машина вообще полезла в MediaPipe (хвост обрезается экраном)
      if (precomputedErr) e.message = `готовые фичи: ${precomputedErr.message} | ` + e.message;
      warmErr = e;
      throw e;
    } finally {
      readyWaiters.splice(0).forEach(fn => fn());
    }
  }

  function featureOf(imgId) {
    if (demo) {
      if (!features.has(imgId)) {
        const img = bankIndex.byId.get(imgId);
        if (!img) throw new Error('нет картинки в банке: ' + imgId);
        features.set(imgId, demoFeature(img));
      }
      return features.get(imgId);
    }
    const f = features.get(imgId);
    if (!f) throw new Error('фичи ' + imgId + ' не готовы (warmup не завершён)');
    return f;
  }

  return {
    get ready() { return ready; },
    get error() { return warmErr; },
    get attempts() { return attempts; },   // диагностика + тесты single-flight/капа
    get source() { return source; },       // precomputed | mediapipe | demo — в телеметрию
    get precomputedError() { return precomputedErr; },
    warmup,
    /** Резолвится и при ошибке warmup (закалка 18.07): потребитель ОБЯЗАН проверить
     * ready — ожидание «до готовности» при мёртвом эмбеддере было бы вечным зависанием,
     * а разблокировать кнопки по одному лишь резолву нельзя. */
    whenReady() {
      return (ready || warmErr) ? Promise.resolve()
        : new Promise(res => readyWaiters.push(res));
    },
    featureOf,
  };
}
