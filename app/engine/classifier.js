/* Нода ImageClassifier (ТЗ-демка-з1 §1.1): примеры 2 классов → kNN (мгновенно) →
 * {метка, уверенность}. Параметры — ЗАМОРОЖЕННЫЕ из bank.frozen_params (пилот §6):
 * эмбеддер MediaPipe ImageEmbedder (models/mobilenet_v3_small_embedder.tflite),
 * комбинированное расстояние 0.65·(1−cosE)+0.35·(1−cosP) (ветки как v5.html:597–660),
 * k — двухступенчатое правило {small, large, min_class_size_for_large},
 * уверенность — живая: conf = 100·sigmoid((d̄_проигравшего − d̄_победителя)/T).
 *
 * Два режима:
 *  - real: эмбеддинг+пиксели из картинок банка (assets/), эмбеддер грузится в warmup()
 *    ФОНОМ (restore ≤3 c: кнопки «Научить»/проверка активируются по готовности);
 *  - demo (?demo=1, e2e/CI): фикс-фичи, синтезированные из МЕТАДАННЫХ банка (bg/class/id),
 *    без сети и wasm — детерминизм. bg доминирует над class (это и есть «тайная примета»):
 *    коробка, обученная на однородном train_core, флипает конфликтные картинки уверенно,
 *    а после ловушек чинится — поведение занятия воспроизводится на любом банке. */

const DEF = {
  k: { small: 3, large: 5, min_class_size_for_large: 10 },
  weights: { embed: 0.65, pixel: 0.35 },
  T: 0.03,
};

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

/* ---------- demo-фичи: детерминированный синтез из метаданных ---------- */

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
 * Границы considered, не подобраны: c < a ⇒ до ловушек kNN «выучивает фон» (флипы R1);
 * c > a/√3 (+запас на hash-шум ~1/√DIM) ⇒ после ловушек класс перевешивает даже когда своих ловушек в k-соседях
 * меньше k (тест-вариант: 2 ловушки на класс при k=3). */
function demoFeature(img) {
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

/* ---------- классификатор ---------- */

export function createClassifier({ bankIndex, assetsBase = '', demo = false, vendorBase = '' } = {}) {
  const frozen = bankIndex.bank.frozen_params || {};
  const K = frozen.k || DEF.k;
  const W = frozen.weights || DEF.weights;
  const T = DEF.T;   // T зафиксирован строкой confidence_map (§6): числом не дублируется в банке

  const features = new Map();   // imgId -> {emb, pix}
  let examples = [];            // [{img, class, f}]
  let ready = demo;             // demo готов сразу; real — после warmup()
  let warmErr = null;
  const readyWaiters = [];

  async function warmup(onProgress = () => {}) {
    if (ready) { onProgress(1); return; }
    try {
      onProgress(0.05);
      const { ImageEmbedder, FilesetResolver } = await import(vendorBase + 'vendor/mediapipe/vision_bundle.mjs');
      const vision = await FilesetResolver.forVisionTasks(vendorBase + 'vendor/mediapipe/wasm');
      const opt = (d) => ({
        baseOptions: { modelAssetPath: vendorBase + 'models/mobilenet_v3_small_embedder.tflite', delegate: d },
        quantize: false,
      });
      let embedder;
      try { embedder = await ImageEmbedder.createFromOptions(vision, opt('GPU')); }
      catch (e) { embedder = await ImageEmbedder.createFromOptions(vision, opt('CPU')); }
      onProgress(0.4);
      const extract = makeRealExtractor(embedder);
      const imgs = bankIndex.bank.images;
      for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i];
        const el = await loadImage(assetsBase + img.src);
        features.set(img.id, extract(el));
        onProgress(0.4 + 0.6 * (i + 1) / imgs.length);
      }
      ready = true;
    } catch (e) {
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

  const combined = (a, b) => W.embed * (1 - dot(a.emb, b.emb)) + W.pixel * (1 - dot(a.pix, b.pix));

  return {
    get ready() { return ready; },
    get error() { return warmErr; },
    warmup,
    whenReady() {
      return ready ? Promise.resolve() : new Promise(res => readyWaiters.push(res));
    },

    /** Обучить на примерах [{img, class}] — мгновенный kNN (просто копим фичи). */
    train(list) {
      examples = list.map(x => ({ img: x.img, class: x.class, f: featureOf(x.img) }));
      return examples.length;
    },
    exampleCount: () => examples.length,

    /** Вердикт {label, conf, dists} по замороженной формуле уверенности (§6). */
    classify(imgId) {
      if (!examples.length) return null;
      const f = featureOf(imgId);
      const counts = {};
      for (const ex of examples) counts[ex.class] = (counts[ex.class] || 0) + 1;
      const classIds = bankIndex.classIds.filter(c => counts[c]);
      if (classIds.length < 2) {
        // один класс в примерах — честный ответ без сравнения (крайний случай, в занятии не бывает)
        return { label: classIds[0], conf: 50, dists: {} };
      }
      const minClass = Math.min(...classIds.map(c => counts[c]));
      // k из frozen_params: либо двухступенчатое правило-объект, либо фикс-число (тест-вариант)
      const kBase = typeof K === 'number' ? K
        : (minClass >= K.min_class_size_for_large ? K.large : K.small);
      const dists = {};   // class -> d̄ до k ближайших примеров ЭТОГО класса
      for (const cls of classIds) {
        const ds = examples.filter(ex => ex.class === cls)
          .map(ex => combined(f, ex.f)).sort((a, b) => a - b);
        const k = Math.min(kBase, ds.length);
        dists[cls] = ds.slice(0, k).reduce((s, d) => s + d, 0) / k;
      }
      const sorted = classIds.slice().sort((a, b) => dists[a] - dists[b]);
      const win = sorted[0], lose = sorted[1];
      const conf = Math.round(100 / (1 + Math.exp(-(dists[lose] - dists[win]) / T)));
      return { label: win, conf, dists };
    },

    /** Замер на наборе ids: сколько вердиктов совпало с классом банка. */
    measure(ids) {
      let score = 0;
      const details = [];
      for (const id of ids) {
        const img = bankIndex.byId.get(id);
        const v = this.classify(id);
        const okOne = !!v && v.label === img.class;
        if (okOne) score += 1;
        details.push({ img: id, label: v && v.label, conf: v && v.conf, ok: okOne });
      }
      return { score, of: ids.length, details };
    },
  };
}
