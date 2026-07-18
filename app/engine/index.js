/* EngineAdapter (ТЗ-платформа-v3 §2.2): единый конверт над сменными движками —
 * FeatureSource (features.js) × EngineCore (knn.js | head.js) × Calibration (шкала банка).
 *
 * Реестр закрытый: knn (движок фазы 0, дефолт и fallback — не удаляется) и head
 * (обучаемая голова TM-типа, Р20 — детям только после гейта §6: валидатор пускает
 * движок в манифест лишь когда он есть в frozen_params.engines банка).
 * Гиперпараметры — ТОЛЬКО из банка (frozen_params); дефолты в коде — кандидаты пилота.
 *
 * Контракт (поля фазы 0 сохранены — screens/* работают с любым движком):
 *   ready, error, warmup(onProgress), whenReady(), engineId,
 *   train(list) → n (синхронно, оба движка «мгновенны» — конституция п.6),
 *   exampleCount(), modelInfo() → {n, sig, engine},
 *   classify(imgId) → {label, conf, margin, spectrum, ...},
 *   measure(ids) → {score, of, details}. */

import { createFeatureSource } from './features.js';
import { knnClassify, knnSpectrum, compositionSig } from './knn.js';
import { trainHead, createHeadTrainer, headClassify, DEF_HEAD } from './head.js';

const DEF_KNN = {
  k: { small: 3, large: 5, min_class_size_for_large: 10 },
  weights: { embed: 0.65, pixel: 0.35 },
  T: 0.03,
};

export const ENGINE_IDS = ['knn', 'head'];

/** Движки, которым можно доверить детей на ЭТОМ банке: kNN пилотирован фазой 0
 * (pilot_status: frozen — про него), остальные — только из frozen_params.engines
 * (появляются там после своего мини-пилота §6). Ключ, которого нет в реестре кода
 * (опечатка в банке), отклоняется здесь же — иначе он прошёл бы в createEngine и
 * уронил boot вместо честного отката на kNN (закалка 18.07, major 15). */
export function allowedEngines(bank) {
  const extra = Object.keys((bank.frozen_params && bank.frozen_params.engines) || {});
  return ['knn', ...extra.filter(e => e !== 'knn' && ENGINE_IDS.includes(e))];
}

export function createEngine({ bankIndex, assetsBase = '', demo = false, vendorBase = '',
                               engine = 'knn' } = {}) {
  if (!ENGINE_IDS.includes(engine)) throw new Error('неизвестный движок: ' + engine);
  const frozen = bankIndex.bank.frozen_params || {};
  // ревизия frozen_params банка — часть identity модели (ТЗ-платформа-v3 §3.1):
  // модель = чистая функция (состав, engine, params_rev); уходит в train_commit/
  // probe_result/measure_result и телеметрию. Старый банк без params_rev → frozen_at
  const paramsRev = frozen.params_rev != null ? frozen.params_rev : (frozen.frozen_at || null);
  const src = createFeatureSource({ bankIndex, assetsBase, demo, vendorBase });

  let composition = [];        // [{img, class}] — состав активной версии
  let headModel = null;        // только для engine=head

  // --- калибровка/параметры по движку (Calibration — данные банка, §2.3) ---
  const knnParams = {
    K: frozen.k || DEF_KNN.k,
    W: frozen.weights || DEF_KNN.weights,
    T: DEF_KNN.T,   // T зафиксирован строкой confidence_map (§6): числом не дублируется в банке
    scale: (frozen.confidence_scale && frozen.confidence_scale.anchors) || null,
  };
  const headBank = (frozen.engines && frozen.engines.head) || {};
  const headHyper = { ...DEF_HEAD, ...headBank };
  const headScale = (headBank.confidence_scale && headBank.confidence_scale.anchors) || null;

  function classifyFeature(f) {
    if (engine === 'head') {
      if (!headModel) return null;
      return headClassify(f, headModel, { scale: headScale });
    }
    const examples = composition.map(p => ({ class: p.class, f: src.featureOf(p.img) }));
    const v = knnClassify(f, examples,
      { classIds: bankIndex.classIds, ...knnParams });
    v.spectrum = knnSpectrum(v.dists, knnParams.T);
    return v;
  }

  return {
    get ready() { return src.ready; },
    get error() { return src.error; },
    warmup: src.warmup,
    whenReady: src.whenReady,
    engineId: engine,

    /** Обучить на примерах [{img, class}]. kNN — копим фичи; head — детерминированная
     * логрегрессия (полносвязный слой, full-batch GD, канонизация состава внутри). */
    train(list) {
      composition = list.map(x => ({ img: x.img, class: x.class }));
      if (engine === 'head') {
        const examples = composition.map(p => ({ img: p.img, class: p.class,
                                                 f: src.featureOf(p.img) }));
        headModel = trainHead(examples, bankIndex.classIds, headHyper);
      } else {
        for (const p of composition) src.featureOf(p.img);   // прогрев кэша (как раньше)
      }
      return composition.length;
    },
    /** Обучение с ЧЕСТНЫМ прогрессом (И3, Codex-ревью: полоска = реальная работа):
     * head считает эпохи порциями ~12 мс с yield'ом между ними — интерфейс жив,
     * onProgress(epoch, total) получает фактический счётчик, никакой фикс-добавки
     * времени. Веса бит-в-бит совпадают с train() того же состава (тот же цикл,
     * лишь нарезанный по времени; тест в engine-contract). kNN мгновенен — эквивалент
     * train(), onProgress не зовётся (полоска — видимая разница движков). Модель и
     * состав публикуются АТОМАРНО по завершении: до конца обучения classify/modelInfo
     * отвечают прежней версией. shouldPublish — guard МЕСТА ЗАПУСКА (закалка 18.07,
     * critical 2): за время счёта эпох ребёнок мог уйти (reset, резерв, смена такта) —
     * тогда результат НЕ публикуется вовсе (возврат null), движок остаётся прежней
     * версией и никакой train_commit писать нельзя. */
    async trainAsync(list, onProgress, { shouldPublish } = {}) {
      if (engine !== 'head') {
        if (shouldPublish && !shouldPublish()) return null;
        return this.train(list);
      }
      const examples = list.map(p => ({ img: p.img, class: p.class, f: src.featureOf(p.img) }));
      const tr = createHeadTrainer(examples, bankIndex.classIds, headHyper);
      const CHUNK_MS = 12;   // бюджет порции — меньше кадра, полоска дышит
      while (!tr.done) {
        const t0 = Date.now();
        while (!tr.done && Date.now() - t0 < CHUNK_MS) tr.step(25);
        if (onProgress) onProgress(tr.epoch, tr.total);
        if (!tr.done) await new Promise(r => setTimeout(r, 0));
      }
      if (shouldPublish && !shouldPublish()) return null;
      headModel = tr.model();
      composition = list.map(x => ({ img: x.img, class: x.class }));
      return composition.length;
    },
    exampleCount: () => composition.length,

    /** Identity обученной модели: {n, sig, engine, params_rev} — уходит в журнал с
     * замерами (§3.1: sig — подпись СОСТАВА, одна для всех движков; различает модели
     * пара sig+engine). Веса НЕ хранятся: движок — чистая функция состава. */
    modelInfo() {
      return { n: composition.length, sig: compositionSig(composition), engine,
               params_rev: paramsRev,
               // head: число эпох GD — для честной анимации обучения (И3-Т, решение
               // владельца: полоска эпох у head; kNN мгновенен — без анимации)
               ...(engine === 'head' ? { epochs: headHyper.epochs } : {}) };
    },

    /** Вердикт {label, conf, margin, spectrum, ...}: сырой скор движка (kNN — d̄-маржа,
     * head — logit-маржа) → калиброванная шкала банка → экранный conf. */
    classify(imgId) {
      if (!composition.length) return null;
      return classifyFeature(src.featureOf(imgId));
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
