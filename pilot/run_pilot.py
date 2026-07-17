#!/usr/bin/env python3
"""Пилот ловушек R1 (ТЗ-демка-з1 §6).

Воспроизводит препроцессинг и kNN v5.html (строки 592-656) байт-в-байт по формулам:
  - эмбеддинг: центральный квадрат -> 224x224 RGB -> MediaPipe ImageEmbedder
    (models/mobilenet_v3_small_embedder.tflite) -> L2-нормализация;
  - пиксели: центральный квадрат -> 32x32 (сглаживание) -> grayscale
    (0.299R+0.587G+0.114B) -> минус среднее -> L2-нормализация;
  - расстояние: w_emb*(1-cosE) + w_pix*(1-cosP);
  - k: 5 если min(примеров на класс) >= 10, иначе 3 (правило v5).

Уверенность (семейство зафиксировано в пилот-R1-параметры.md §5):
  conf = 100 * sigmoid((d_mean_проигравшего - d_mean_победителя) / T),
  d_mean_c — среднее расстояние до k ближайших примеров класса c.

Пороги §6 п.3: конфликтные 8/8 флипов; лже-странные 0 ложных; обычные 100%;
holdout ПОСЛЕ ловушек 4/4; уверенность на нужных флипах >= 75%.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image as PILImage
import mediapipe as mp
from mediapipe.tasks import python as mpp
from mediapipe.tasks.python import vision

HERE = Path(__file__).parent
MODEL = HERE.parent / "models" / "mobilenet_v3_small_embedder.tflite"
import os
IMAGES = HERE / os.environ.get("PILOT_IMAGES_DIR", "images")
MANIFEST_NAME = os.environ.get("PILOT_MANIFEST", "manifest.json")
WEIGHT_POINTS = [(0.65, 0.35), (1.0, 0.0)]
T_CONF = float(sys.argv[1]) if len(sys.argv) > 1 else 0.06

_embedder = vision.ImageEmbedder.create_from_options(
    vision.ImageEmbedderOptions(base_options=mpp.BaseOptions(model_asset_path=str(MODEL)))
)


def features(path: Path):
    im = PILImage.open(path).convert("RGB")
    w, h = im.size
    s = min(w, h)
    box = ((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s)
    sq = im.crop(box)
    # ветка эмбеддинга: 224x224
    a224 = np.asarray(sq.resize((224, 224), PILImage.BILINEAR), dtype=np.uint8)
    r = _embedder.embed(mp.Image(image_format=mp.ImageFormat.SRGB, data=a224))
    emb = np.asarray(r.embeddings[0].embedding, dtype=np.float64)
    emb /= (np.linalg.norm(emb) or 1.0)
    # пиксельная ветка: 32x32 grayscale, mean-subtract, L2
    a32 = np.asarray(sq.resize((32, 32), PILImage.BILINEAR), dtype=np.float64)
    g = a32[:, :, 0] * 0.299 + a32[:, :, 1] * 0.587 + a32[:, :, 2] * 0.114
    g = g.flatten()
    g -= g.mean()
    g /= (np.linalg.norm(g) or 1.0)
    return emb, g


def knn(train, f, w_emb, w_pix, counts):
    k = 5 if min(counts.values()) >= 10 else 3
    dists = []
    for t in train:
        ed = 1 - float(np.dot(f[0], t["emb"]))
        pd = 1 - float(np.dot(f[1], t["pix"]))
        dists.append({"cls": t["cls"], "d": w_emb * ed + w_pix * pd, "id": t["id"]})
    dists.sort(key=lambda x: x["d"])
    top = dists[:k]
    votes = {}
    for x in top:
        votes[x["cls"]] = votes.get(x["cls"], 0) + 1
    label = max(votes, key=votes.get)
    # живая уверенность: средние расстояния до k ближайших КАЖДОГО класса
    dmean = {}
    for cls in counts:
        cd = sorted(x["d"] for x in dists if x["cls"] == cls)[:k]
        dmean[cls] = sum(cd) / len(cd)
    loser = min((c for c in counts if c != label), key=lambda c: dmean[c])
    conf = 100.0 / (1.0 + math.exp(-(dmean[loser] - dmean[label]) / T_CONF))
    return {"label": label, "conf": conf, "k": k, "nn": top[0]["id"],
            "vote": votes[label] / k, "dmean": dmean}


def main():
    man = json.loads((HERE / MANIFEST_NAME).read_text())
    imgs = {i["id"]: i for i in man["images"]}
    feats = {i["id"]: features(IMAGES / i["file"]) for i in man["images"]}

    def build(train_ids):
        train = [{"id": i, "cls": imgs[i]["class"], "emb": feats[i][0], "pix": feats[i][1]}
                 for i in train_ids]
        counts = {}
        for t in train:
            counts[t["cls"]] = counts.get(t["cls"], 0) + 1
        return train, counts

    train_ids = [i["id"] for i in man["images"] if i["role"] == "train"]
    trap_ids = [i["id"] for i in man["images"] if i["role"] == "trap"]

    report = {"T_conf": T_CONF, "points": {}}
    for w_emb, w_pix in WEIGHT_POINTS:
        key = f"{w_emb}/{w_pix}"
        R1, c1 = build(train_ids)
        R2, c2 = build(train_ids + trap_ids)
        res = {"checks": {}, "details": {}}

        def run(ids, model, counts):
            return {i: knn(model, feats[i], w_emb, w_pix, counts) for i in ids}

        conflict = [i["id"] for i in man["images"] if i["role"] == "conflict"]
        normal = [i["id"] for i in man["images"] if i["role"] == "normal"]
        strange = [i["id"] for i in man["images"] if i["role"] == "pseudo_strange"]
        holdout = [i["id"] for i in man["images"] if i["role"] == "holdout"]

        r_conf = run(conflict, R1, c1)
        r_norm = run(normal, R1, c1)
        r_str = run(strange, R1, c1)
        r_hold_before = run(holdout, R1, c1)
        r_hold_after = run(holdout, R2, c2)
        r_train_self = run(train_ids, R1, c1)  # sanity: обучающие сами на себе

        flips = sum(1 for i in conflict if r_conf[i]["label"] == imgs[i]["flip_to"])
        false_flips = sum(1 for i in strange if r_str[i]["label"] != imgs[i]["class"])
        normal_ok = sum(1 for i in normal if r_norm[i]["label"] == imgs[i]["class"])
        hold_after_ok = sum(1 for i in holdout if r_hold_after[i]["label"] == imgs[i]["class"])
        hold_before_ok = sum(1 for i in holdout if r_hold_before[i]["label"] == imgs[i]["class"])
        flip_confs = [round(r_conf[i]["conf"], 1) for i in conflict
                      if r_conf[i]["label"] == imgs[i]["flip_to"]]
        min_flip_conf = min(flip_confs) if flip_confs else None

        res["checks"] = {
            "conflict_flips": f"{flips}/8", "conflict_pass": flips == 8,
            "false_flips": false_flips, "strange_pass": false_flips == 0,
            "normal": f"{normal_ok}/8", "normal_pass": normal_ok == 8,
            "holdout_after": f"{hold_after_ok}/4", "holdout_pass": hold_after_ok == 4,
            "holdout_before_info": f"{hold_before_ok}/4",
            "min_flip_conf": min_flip_conf,
            "conf_pass": (min_flip_conf is not None and min_flip_conf >= 75.0 and flips == 8),
        }
        res["checks"]["ALL_PASS"] = all(res["checks"][x] for x in
                                        ("conflict_pass", "strange_pass", "normal_pass",
                                         "holdout_pass", "conf_pass"))
        res["details"] = {
            "conflict": {i: {"label": r_conf[i]["label"], "want": imgs[i]["flip_to"],
                             "conf": round(r_conf[i]["conf"], 1), "nn": r_conf[i]["nn"]}
                         for i in conflict},
            "normal": {i: {"label": r_norm[i]["label"], "conf": round(r_norm[i]["conf"], 1)}
                       for i in normal},
            "strange": {i: {"label": r_str[i]["label"], "conf": round(r_str[i]["conf"], 1)}
                        for i in strange},
            "holdout_before": {i: {"label": r_hold_before[i]["label"],
                                   "conf": round(r_hold_before[i]["conf"], 1)} for i in holdout},
            "holdout_after": {i: {"label": r_hold_after[i]["label"],
                                  "conf": round(r_hold_after[i]["conf"], 1)} for i in holdout},
            "train_self_errors": [i for i in train_ids
                                  if r_train_self[i]["label"] != imgs[i]["class"]],
        }
        report["points"][key] = res

    out = HERE / "report.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1))
    for key, res in report["points"].items():
        print(f"=== weights {key} ===")
        for name, val in res["checks"].items():
            print(f"  {name}: {val}")
    print(f"\nreport -> {out}")


if __name__ == "__main__":
    main()
