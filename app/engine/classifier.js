/* Нода ImageClassifier (ТЗ-демка-з1 §1.1): примеры 2 классов → kNN (мгновенно) →
 * {метка, уверенность}. Параметры — ЗАМОРОЖЕННЫЕ из bank.frozen_params (пилот §6):
 * эмбеддер MediaPipe ImageEmbedder (models/mobilenet_v3_small_embedder.tflite),
 * комбинированное расстояние 0.65·(1−cosE)+0.35·(1−cosP) (ветки как v5.html:597–660),
 * k — двухступенчатое правило {small, large, min_class_size_for_large},
 * метка — ГОЛОСОВАНИЕМ top-k (как пилот run_pilot.knn / v5) — пороги пилота считались
 * голосованием, argmin d̄ на тех же данных даёт другие замеры (план-правок 17.07 п.1);
 * уверенность — живая: conf = 100·sigmoid((d̄_проигравшего − d̄_победителя)/T),
 * сверка с пилотом на реальных фичах — pilot/dump_parity.py + parity.test.mjs.
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

/* ---------- чистый kNN голосованием (зеркало pilot/run_pilot.py knn) ---------- */

/** Вердикт по фичам f против примеров [{class, f}] — БЕЗ DOM/состояния (parity-тест
 * гоняет её на реальных фичах пилота). Метка: голосование top-k общего списка расстояний
 * (ничья достаётся классу ближайшего соседа — как порядок вставки dict в пилоте);
 * уверенность: d̄-маржа проигравший−победитель, conf = 100·sigmoid(margin/T). */
export function knnClassify(f, examples, { classIds, K, W, T }) {
  const counts = {};
  for (const ex of examples) counts[ex.class] = (counts[ex.class] || 0) + 1;
  const present = classIds.filter(c => counts[c]);
  if (present.length < 2) {
    // один класс в примерах — честный ответ без сравнения (крайний случай, в занятии не бывает)
    return { label: present[0], conf: 50, margin: 0, dists: {} };
  }
  const minClass = Math.min(...present.map(c => counts[c]));
  const kBase = typeof K === 'number' ? K
    : (minClass >= K.min_class_size_for_large ? K.large : K.small);
  const all = examples.map(ex => ({
    cls: ex.class,
    d: W.embed * (1 - dot(f.emb, ex.f.emb)) + W.pixel * (1 - dot(f.pix, ex.f.pix)),
  }));
  all.sort((a, b) => a.d - b.d);
  const top = all.slice(0, Math.min(kBase, all.length));
  const votes = new Map();   // порядок вставки = порядок соседей по близости (как dict пилота)
  for (const x of top) votes.set(x.cls, (votes.get(x.cls) || 0) + 1);
  let label = null, best = -1;
  for (const [cls, n] of votes) if (n > best) { best = n; label = cls; }
  const dists = {};   // class -> d̄ до k ближайших примеров ЭТОГО класса (для уверенности)
  for (const cls of present) {
    const ds = all.filter(x => x.cls === cls).map(x => x.d);   // уже по возрастанию
    const k = Math.min(kBase, ds.length);
    dists[cls] = ds.slice(0, k).reduce((s, d) => s + d, 0) / k;
  }
  const loser = present.filter(c => c !== label).sort((a, b) => dists[a] - dists[b])[0];
  const margin = dists[loser] - dists[label];
  const conf = Math.round(100 / (1 + Math.exp(-margin / T)));
  return { label, conf, margin, dists };
}

/** Подпись состава (версии) модели/раскладки: FNV-1a по отсортированным парам img:class.
 * Замер обязан хранить, НА ЧЁМ он сделан — stale-«Было» после переразметки/restore
 * инвалидируется сравнением подписей (план-правок 17.07 п.3, Codex D1–D2). */
export function compositionSig(pairs) {
  const s = pairs.map(p => p.img + ':' + p.class).sort().join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

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

    /** Версия состава обученной модели: {n, sig} — уходит в журнал с каждым замером. */
    modelInfo() {
      return { n: examples.length, sig: compositionSig(examples) };
    },

    /** Вердикт {label, conf, margin, dists}: метка — голосованием top-k (как пилот),
     * уверенность — по d̄-маржам замороженной формулы (§6). */
    classify(imgId) {
      if (!examples.length) return null;
      return knnClassify(featureOf(imgId), examples,
                         { classIds: bankIndex.classIds, K, W, T });
    },

    /** Замер на наборе ids: сколько вердиктов совпало с классом банка.
     * details — подписи КАЖДОЙ ошибки для честного экрана замера (план-правок п.3). */
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
