/* Легаси-фасад движка (нода ImageClassifier фазы 0). Реализация разрезана на слои
 * ТЗ-платформа-v3 §2.2: features.js (FeatureSource) × knn.js / head.js (EngineCore) ×
 * калибровка банка; фабрика адаптеров — index.js (createEngine). Этот модуль сохраняет
 * старые импорты (screens/*, тесты, pilot/calibrate_scale.mjs): createClassifier =
 * createEngine с дефолтным движком kNN; чистые функции — реэкспорт. */

export { knnClassify, scaleConf, compositionSig } from './knn.js';
export { createEngine, allowedEngines, ENGINE_IDS } from './index.js';
import { createEngine } from './index.js';

export function createClassifier(opts = {}) {
  return createEngine(opts);
}
