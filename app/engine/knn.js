/* EngineCore «knn» (ТЗ-платформа-v3 §2.2): чистая математика kNN голосованием top-k —
 * зеркало pilot/run_pilot.py, параметры ЗАМОРОЖЕНЫ пилотом §6 (bank.frozen_params).
 * Перенос из classifier.js без правок математики (parity-тест сторожит совпадение
 * с пилотом на реальных фичах). Здесь же compositionSig и шкала conf (scaleConf). */

export function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

/** Калиброванная уверенность (фаза 0.5): кусочно-линейная монотонная шкала по опорным
 * точкам [[margin, conf%], ...] банка (frozen_params.confidence_scale.anchors, выведены
 * из маржей пилота — pilot/calibrate_scale.mjs). Сигмоида T=0.03 насыщалась (медиана ≈97%);
 * шкала держит спектр: чистые 85–95, спорные 55–75, потолок = последняя точка (95).
 * Отрицательная маржа (голоса против d̄) — зеркально ниже 50. Сырая маржа остаётся
 * в вердикте: legacy-порог пилота «флип ≥75%» проверяется ПО НЕЙ, не по проценту. */
export function scaleConf(margin, anchors) {
  if (margin < 0) return 100 - scaleConf(-margin, anchors);
  let [pm, pc] = anchors[0];
  if (margin <= pm) return pc;
  for (let i = 1; i < anchors.length; i++) {
    const [m, c] = anchors[i];
    if (margin <= m) return Math.round(pc + (c - pc) * (margin - pm) / (m - pm));
    [pm, pc] = [m, c];
  }
  return pc;   // за последней точкой — потолок
}

/** Вердикт по фичам f против примеров [{class, f}] — БЕЗ DOM/состояния (parity-тест
 * гоняет её на реальных фичах пилота). Метка: голосование top-k общего списка расстояний
 * (ничья достаётся классу ближайшего соседа — как порядок вставки dict в пилоте);
 * уверенность: d̄-маржа проигравший−победитель; conf — калиброванная шкала scale
 * (anchors), без неё — пилотная сигмоида 100·sigmoid(margin/T) (parity-сверка). */
export function knnClassify(f, examples, { classIds, K, W, T, scale }) {
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
  const conf = scale ? scaleConf(margin, scale)
                     : Math.round(100 / (1 + Math.exp(-margin / T)));
  return { label, conf, margin, dists };
}

/** Спектр kNN (§2.3): синтетический softmax(−d̄_c/T) по d̄ классов — гладкая функция
 * фичи, сумма 1; для двух классов согласован с пилотной сигмоидой той же T. */
export function knnSpectrum(dists, T) {
  const keys = Object.keys(dists);
  if (!keys.length) return {};
  const zs = keys.map(c => -dists[c] / T);
  const zmax = Math.max(...zs);
  const es = zs.map(z => Math.exp(z - zmax));
  const sum = es.reduce((a, b) => a + b, 0);
  const out = {};
  keys.forEach((c, i) => { out[c] = es[i] / sum; });
  return out;
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
