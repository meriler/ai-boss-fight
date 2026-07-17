#!/usr/bin/env python3
"""Фикстура parity-сверки клиентского kNN с пилотным (план-правок 17.07 п.1).

Клиент обязан классифицировать ГОЛОСОВАНИЕМ top-k — как пилот/v5: пороги пилота
считались голосованием, argmin d̄ на тех же данных даёт другие замеры (баг интеграции,
пойман экспериментом на реальных фичах). Этот скрипт фиксирует эталон: реальные фичи
пилотных картинок (512px, тот же препроцессинг, что run_pilot.py) + вердикты
python-kNN на КАЖДОМ сценарии занятия:
  R1 (train) -> conflict / normal / pseudo_strange / holdout;
  R2 (train+trap) -> holdout.

Фичи в фикстуре ОКРУГЛЕНЫ до 6 знаков, и вердикты питона считаются на округлённых —
JS-тест (app/engine/parity.test.mjs) сходится до float-эпсилона без своего эмбеддера.

Запуск (venv пилота):  pilot/.venv.nosync/bin/python pilot/dump_parity.py
Выход: pilot/parity-fixture.json (коммитится: CI гоняет parity без питона/mediapipe).
"""
import json
import math
import os
from pathlib import Path

HERE = Path(__file__).parent
os.environ.setdefault("PILOT_IMAGES_DIR", "images512")
os.environ.setdefault("PILOT_MANIFEST", "manifest512.json")

import run_pilot as rp  # noqa: E402  (импорт после env: он читает PILOT_*)

W_EMB, W_PIX = 0.65, 0.35   # замороженные веса банка (frozen_params)
T = 0.03                    # confidence_map замороженного банка (в run_pilot дефолт 0.06 — тут T банка)


def knn(train, f, counts):
    """Копия run_pilot.knn с T параметром (та же математика: голосование top-k + d̄-маржа)."""
    k = 5 if min(counts.values()) >= 10 else 3
    dists = []
    for t in train:
        ed = 1 - float(sum(a * b for a, b in zip(f[0], t["emb"])))
        pd = 1 - float(sum(a * b for a, b in zip(f[1], t["pix"])))
        dists.append({"cls": t["cls"], "d": W_EMB * ed + W_PIX * pd})
    dists.sort(key=lambda x: x["d"])
    top = dists[:k]
    votes = {}
    for x in top:
        votes[x["cls"]] = votes.get(x["cls"], 0) + 1
    label = max(votes, key=votes.get)
    dmean = {}
    for cls in counts:
        cd = sorted(x["d"] for x in dists if x["cls"] == cls)[:k]
        dmean[cls] = sum(cd) / len(cd)
    loser = min((c for c in counts if c != label), key=lambda c: dmean[c])
    margin = dmean[loser] - dmean[label]
    conf = 100.0 / (1.0 + math.exp(-margin / T))
    return {"label": label, "conf": conf, "margin": margin, "k": k}


def main():
    man = json.loads((HERE / os.environ["PILOT_MANIFEST"]).read_text())
    imgs = {i["id"]: i for i in man["images"]}
    images_dir = HERE / os.environ["PILOT_IMAGES_DIR"]

    feats = {}
    for i in man["images"]:
        emb, pix = rp.features(images_dir / i["file"])
        feats[i["id"]] = ([round(float(x), 6) for x in emb],
                          [round(float(x), 6) for x in pix])

    def build(ids):
        train = [{"cls": imgs[i]["class"], "emb": feats[i][0], "pix": feats[i][1]} for i in ids]
        counts = {}
        for t in train:
            counts[t["cls"]] = counts.get(t["cls"], 0) + 1
        return train, counts

    by_role = {}
    for i in man["images"]:
        by_role.setdefault(i["role"], []).append(i["id"])

    train_ids = by_role["train"]
    trap_ids = by_role["trap"]
    scenarios = {
        "R1": (train_ids, ["conflict", "normal", "pseudo_strange", "holdout"]),
        "R2": (train_ids + trap_ids, ["holdout"]),
    }

    cases = []
    for model_name, (model_ids, roles) in scenarios.items():
        train, counts = build(model_ids)
        for role in roles:
            for pid in by_role.get(role, []):
                v = knn(train, feats[pid], counts)
                cases.append({"model": model_name, "img": pid, "role": role,
                              "label": v["label"], "conf": v["conf"],
                              "margin": v["margin"], "k": v["k"]})

    out = {
        "comment": "эталон parity клиентского kNN (голосование top-k) с пилотом — dump_parity.py",
        "params": {"k": {"small": 3, "large": 5, "min_class_size_for_large": 10},
                   "weights": {"embed": W_EMB, "pixel": W_PIX}, "T": T},
        "classes": man["classes"],
        "models": {"R1": train_ids, "R2": train_ids + trap_ids},
        "images": {i["id"]: {"class": i["class"], "role": i["role"]} for i in man["images"]},
        "features": {pid: {"emb": f[0], "pix": f[1]} for pid, f in feats.items()},
        "cases": cases,
    }
    path = HERE / "parity-fixture.json"
    path.write_text(json.dumps(out, ensure_ascii=False))
    flips = sum(1 for c in cases if c["model"] == "R1" and c["role"] == "conflict"
                and c["label"] != imgs[c["img"]]["class"])
    hold2 = sum(1 for c in cases if c["model"] == "R2" and c["role"] == "holdout"
                and c["label"] == imgs[c["img"]]["class"])
    print(f"cases={len(cases)} conflict_flips_R1={flips}/8 holdout_R2={hold2}/4 -> {path}")


if __name__ == "__main__":
    main()
