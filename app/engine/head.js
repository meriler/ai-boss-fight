/* EngineCore «head» (ТЗ-платформа-v3 §2.1–2.2, Р20): обучаемая голова TM-типа —
 * математика Teachable Machine (softmax-голова = мультиклассовая логистическая
 * регрессия поверх замороженного эмбеддера), свой детерминированный код БЕЗ tfjs.
 *
 * Детерминизм абсолютный по построению (пилот-док §8.2):
 *  - init W=0, b=0 — сид не нужен;
 *  - full-batch GD без shuffle, фиксированный cap эпох (ранней остановки нет);
 *  - канонизация состава сортировкой по img id ВНУТРИ train() — модель есть функция
 *    МНОЖЕСТВА примеров, не порядка укладки (согласовано с compositionSig);
 *  - Float64-циклы без SIMD → бит-в-бит одинаково в Node и браузере (оба V8).
 *
 * Гиперпараметры — только из банка (frozen_params.engines.head); DEF_HEAD — кандидаты
 * H1, зафиксированные ДО прогона пилота (пилот-R1-параметры §8.1–8.4). */

import { scaleConf } from './knn.js';

export const DEF_HEAD = {
  feat_scale_pix: 1.0,      // заход 3 пилота H1: паритет веток (0.7338 = √(0.35/0.65) недовешивал pix)
  epochs: 1000,
  lr: 0.5,
  l2: 0.0002,                // только W, не b
  class_balance: true,      // веса примеров ∝ n_total/(C·n_class)
  min_per_class: 3,         // UI-гейт «положи хотя бы 3 в каждую корзину» (не пилот)
  T: 0.4,                   // температура спектра и порога (T·ln3); калибруется пилотом — как T=0.03 у kNN
};

/** x = concat(emb, s·pix) — Float64. Пиксельная ветка (фоночувствительность, несущая
 * методики З1) входит с коэффициентом feat_scale_pix — замороженная ручка пилота H1. */
export function headFeature(f, s) {
  const x = new Float64Array(f.emb.length + f.pix.length);
  for (let i = 0; i < f.emb.length; i++) x[i] = f.emb[i];
  for (let i = 0; i < f.pix.length; i++) x[f.emb.length + i] = s * f.pix[i];
  return x;
}

function softmaxInPlace(z) {
  let m = -Infinity;
  for (let i = 0; i < z.length; i++) if (z[i] > m) m = z[i];
  let sum = 0;
  for (let i = 0; i < z.length; i++) { z[i] = Math.exp(z[i] - m); sum += z[i]; }
  for (let i = 0; i < z.length; i++) z[i] /= sum;
  return z;
}

/** Пошаговый тренер головы (И3, честная полоска эпох): та же математика, что trainHead,
 * но эпохи считаются порциями step(n) — UI зовёт их между кадрами и рисует РЕАЛЬНЫЙ
 * прогресс, интерфейс не замирает. Детерминизм не тронут: арифметика и порядок циклов
 * идентичны монолитному train — веса бит-в-бит совпадают (тест в engine-contract). */
export function createHeadTrainer(examples, classIds, hyper = {}) {
  const H = { ...DEF_HEAD, ...hyper };
  const list = [...examples].sort((a, b) => (a.img < b.img ? -1 : a.img > b.img ? 1 : 0));
  const present = classIds.filter(c => list.some(ex => ex.class === c));
  const C = classIds.length;
  if (!list.length || present.length < 2) {
    // честный «не обучена» (в занятии не бывает): нет эпох, модель сразу готова
    return { total: 0, get epoch() { return 0; }, get done() { return true; },
             step: () => 0, model: () => ({ W: null, b: null, classIds, present, hyper: H }) };
  }
  const xs = list.map(ex => headFeature(ex.f, H.feat_scale_pix));
  const D = xs[0].length;
  const yi = list.map(ex => classIds.indexOf(ex.class));
  // class_balance: вес примера ∝ n_total/(C_present·n_class) — дисбаланс (Лаборатория 12/2)
  // чинится в loss, не подкраской результата (Р14)
  const counts = new Array(C).fill(0);
  for (const y of yi) counts[y] += 1;
  const wEx = yi.map(y => H.class_balance ? list.length / (present.length * counts[y]) : 1);
  const wSum = wEx.reduce((a, b) => a + b, 0);

  const W = [];
  for (let c = 0; c < C; c++) W.push(new Float64Array(D));
  const b = new Float64Array(C);
  const gW = [];
  for (let c = 0; c < C; c++) gW.push(new Float64Array(D));
  const gB = new Float64Array(C);
  const z = new Float64Array(C);

  let ep = 0;
  const epochOnce = () => {
    for (let c = 0; c < C; c++) { gW[c].fill(0); gB[c] = 0; }
    for (let n = 0; n < xs.length; n++) {
      const x = xs[n];
      for (let c = 0; c < C; c++) {
        let s = b[c];
        const Wc = W[c];
        for (let i = 0; i < D; i++) s += Wc[i] * x[i];
        z[c] = s;
      }
      softmaxInPlace(z);
      for (let c = 0; c < C; c++) {
        const dz = (z[c] - (c === yi[n] ? 1 : 0)) * wEx[n];
        const gc = gW[c];
        for (let i = 0; i < D; i++) gc[i] += dz * x[i];
        gB[c] += dz;
      }
    }
    for (let c = 0; c < C; c++) {
      const Wc = W[c], gc = gW[c];
      for (let i = 0; i < D; i++) Wc[i] -= H.lr * (gc[i] / wSum + H.l2 * Wc[i]);
      b[c] -= H.lr * (gB[c] / wSum);
    }
  };

  return {
    total: H.epochs,
    get epoch() { return ep; },
    get done() { return ep >= H.epochs; },
    /** Прогнать до n эпох, вернуть фактический счётчик. */
    step(n = 1) {
      const end = Math.min(H.epochs, ep + n);
      while (ep < end) { epochOnce(); ep += 1; }
      return ep;
    },
    model: () => ({ W, b, classIds, present, dim: D, hyper: H }),
  };
}

/** Обучение головы: examples [{img, class, f:{emb,pix}}] → {W (C×D, Float64Array[]), b,
 * classIds, dim, hyper}. Чистая функция состава: канонизация сортировкой по img id.
 * Монолитная обёртка над createHeadTrainer — CI/walk/parity зовут её синхронно. */
export function trainHead(examples, classIds, hyper = {}) {
  const tr = createHeadTrainer(examples, classIds, hyper);
  if (tr.total) tr.step(tr.total);
  return tr.model();
}

/** Вердикт головы: {label, conf, margin (сырой logit-разрыв top−second), spectrum
 * softmax(logit/T), logits}. conf — шкала банка (anchors) по сырой марже; без шкалы —
 * сигмоида margin/T (порог пилота H1: флип ≥75% ⇔ margin ≥ T·ln3). */
export function headClassify(f, model, { scale } = {}) {
  const H = model.hyper;
  if (!model.W) {
    const only = model.present && model.present[0];
    return { label: only || null, conf: 50, margin: 0, spectrum: {}, logits: {} };
  }
  const x = headFeature(f, H.feat_scale_pix);
  const C = model.classIds.length;
  const z = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    let s = model.b[c];
    const Wc = model.W[c];
    for (let i = 0; i < x.length; i++) s += Wc[i] * x[i];
    z[c] = s;
  }
  // метка и маржа — только по классам, присутствовавшим в обучении
  const idx = model.present.map(c => model.classIds.indexOf(c));
  let top = idx[0], second = null;
  for (const c of idx) if (z[c] > z[top]) top = c;
  for (const c of idx) if (c !== top && (second === null || z[c] > z[second])) second = c;
  const margin = second === null ? 0 : z[top] - z[second];
  const sp = new Float64Array(idx.length);
  for (let i = 0; i < idx.length; i++) sp[i] = z[idx[i]] / H.T;
  softmaxInPlace(sp);
  const spectrum = {};
  for (let i = 0; i < idx.length; i++) spectrum[model.classIds[idx[i]]] = sp[i];
  const logits = {};
  for (const c of idx) logits[model.classIds[c]] = z[c];
  const conf = scale ? scaleConf(margin, scale)
                     : Math.round(100 / (1 + Math.exp(-margin / H.T)));
  return { label: model.classIds[top], conf, margin, spectrum, logits };
}

/** Подпись весов (FNV-1a по байтам Float64 W и b) — для parity-head-фикстуры:
 * «два train = бит-в-бит одни веса» проверяется сравнением этой строки. */
export function weightsSig(model) {
  if (!model.W) return 'untrained';
  let h = 0x811c9dc5;
  const eat = (buf) => {
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  };
  for (const Wc of model.W) eat(Wc);
  eat(model.b);
  return (h >>> 0).toString(36);
}
