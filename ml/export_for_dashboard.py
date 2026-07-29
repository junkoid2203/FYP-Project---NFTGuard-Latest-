# -*- coding: utf-8 -*-
"""
export_for_dashboard.py — run the NFTGuard detection pipeline on the real data
and export results the dashboard can display.

Writes:
  frontend/ml_results.json   (consumed by the dashboard "ML Detection" view)
  ml/model.joblib            (the trained wash-trading classifier)
"""
import json, glob, os, datetime
from pathlib import Path
import numpy as np, pandas as pd
from sklearn.model_selection import train_test_split, GridSearchCV, cross_val_score
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (confusion_matrix, roc_auc_score,
                             precision_recall_fscore_support, accuracy_score)

ML = Path(__file__).resolve().parent
ROOT = ML.parent

def newest_dataset():
    files = glob.glob(str(ML / "data" / "sales_raw*.csv"))
    if not files:
        raise SystemExit("No sales_raw*.csv found — run collect_sales.py first.")
    return max(files, key=os.path.getmtime)

DATA = newest_dataset()
df = pd.read_csv(DATA)
df["dt"] = pd.to_datetime(df["timestamp"], unit="s")

# ---- clean ----
df = df[df["price_eth"] > 0].dropna(subset=["buyer", "seller", "timestamp"])
df = df.drop_duplicates(subset=["txhash", "tokenId"]).sort_values("dt").reset_index(drop=True)

# ---- features ----
df["pair"] = [tuple(sorted(p)) for p in zip(df["buyer"], df["seller"])]
df["pair_trade_count"] = df["pair"].map(df["pair"].value_counts())
df["is_self_transfer"] = (df["buyer"] == df["seller"]).astype(int)
df["buyer_activity"]  = df["buyer"].map(df["buyer"].value_counts())
df["seller_activity"] = df["seller"].map(df["seller"].value_counts())
df["price_z"] = df.groupby("collection")["price_eth"].transform(
    lambda s: (s - s.mean()) / (s.std(ddof=0) or 1))
df["token_gap_h"] = df.groupby("tokenId")["dt"].diff().dt.total_seconds() / 3600
df["token_gap_h"] = df["token_gap_h"].fillna(df["token_gap_h"].median()).fillna(0)
df["mkt_code"] = df["marketplace"].astype("category").cat.codes

# ---- weak-supervision label ----
df["label_wash"] = ((df["is_self_transfer"] == 1) | (df["pair_trade_count"] >= 3)).astype(int)

# ---- model: GridSearchCV tuning; features exclude the label-defining indicators ----
FEATURES = ["price_eth", "price_z", "buyer_activity", "seller_activity", "token_gap_h", "mkt_code"]
X, y = df[FEATURES].fillna(0.0), df["label_wash"]

# Save the ALL-NUMERIC feature matrix actually fed to the model (a standard ML dataset,
# every column a number — exactly what the algorithm trains on).
_feat = X.copy()
_feat["label_wash"] = y.values
_feat.insert(0, "sale_id", range(1, len(_feat) + 1))
_feat.to_csv(ML / "data" / "ml_features.csv", index=False)
print("wrote numeric feature matrix ->", ML / "data" / "ml_features.csv", _feat.shape)
Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.30, random_state=42, stratify=y)

grid = {"n_estimators": [200, 400], "max_depth": [None, 10, 20], "min_samples_leaf": [1, 3]}
gs = GridSearchCV(RandomForestClassifier(random_state=42, class_weight="balanced"),
                  grid, cv=4, scoring="roc_auc", n_jobs=-1).fit(Xtr, ytr)
clf = gs.best_estimator_
pred, proba = clf.predict(Xte), clf.predict_proba(Xte)[:, 1]
pr, rc, f1, _ = precision_recall_fscore_support(yte, pred, labels=[1], average=None, zero_division=0)
cm = confusion_matrix(yte, pred)
cv = cross_val_score(RandomForestClassifier(**gs.best_params_, random_state=42, class_weight="balanced"),
                     X, y, cv=5, scoring="roc_auc")

metrics = {
    "accuracy": round(float(accuracy_score(yte, pred)), 3),
    "roc_auc":  round(float(roc_auc_score(yte, proba)), 3),
    "precision": round(float(pr[0]), 3),
    "recall":    round(float(rc[0]), 3),
    "f1":        round(float(f1[0]), 3),
    "cv_auc":   round(float(cv.mean()), 3),
    "cv_std":   round(float(cv.std()), 3),
    "train_acc": round(float(clf.score(Xtr, ytr)), 3),
    "test_acc":  round(float(clf.score(Xte, yte)), 3),
    "best_params": gs.best_params_,
    "n_test": int(len(yte)),
    "n_wash": int(df["label_wash"].sum()),
    "n_legit": int((df["label_wash"] == 0).sum()),
}
confusion = {"tn": int(cm[0, 0]), "fp": int(cm[0, 1]), "fn": int(cm[1, 0]), "tp": int(cm[1, 1])}
feat_imp = sorted(zip(FEATURES, clf.feature_importances_), key=lambda t: -t[1])
feat_imp = [[f, round(float(v), 3)] for f, v in feat_imp]

# ---- flagged wash trades (real, verifiable on Etherscan) ----
flagged = df[df["label_wash"] == 1].sort_values(
    ["pair_trade_count", "price_eth"], ascending=False).head(15)
flagged_json = [{
    "collection": r.collection, "tokenId": str(r.tokenId),
    "buyer": r.buyer, "seller": r.seller,
    "price_eth": round(float(r.price_eth), 3),
    "pair_trade_count": int(r.pair_trade_count),
    "is_self_transfer": int(r.is_self_transfer),
    "marketplace": r.marketplace, "txhash": r.txhash,
    "date": r.dt.strftime("%Y-%m-%d"),
} for r in flagged.itertuples()]

# ---- EDA aggregates ----
sot = df.set_index("dt").resample("W")["price_eth"].count()
sales_over_time = [[d.strftime("%Y-%m-%d"), int(c)] for d, c in sot.items()]
cap = float(df["price_eth"].quantile(0.99))
counts, edges = np.histogram(df["price_eth"].clip(upper=cap), bins=20)
price_hist = {"edges": [round(float(e), 2) for e in edges], "counts": [int(c) for c in counts]}

result = {
    "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
    "source": "Alchemy getNFTSales · Ethereum mainnet (every row verifiable on Etherscan)",
    "dataset": {
        "n_sales": int(len(df)),
        "collections": sorted(df["collection"].unique().tolist()),
        "date_from": df["dt"].min().strftime("%Y-%m-%d"),
        "date_to": df["dt"].max().strftime("%Y-%m-%d"),
    },
    "metrics": metrics,
    "confusion": confusion,
    "feature_importance": feat_imp,
    "flagged": flagged_json,
    "marketplaces": df["marketplace"].value_counts().to_dict(),
    "sales_over_time": sales_over_time,
    "price_hist": price_hist,
}

out = ROOT / "frontend" / "ml_results.json"
out.write_text(json.dumps(result, indent=2), encoding="utf-8")
try:
    import joblib
    joblib.dump(clf, ML / "model.joblib")
except Exception as e:
    print("  (model not saved:", e, ")")

print("dataset :", os.path.basename(DATA), "->", len(df), "clean sales")
print("metrics :", metrics)
print("wrote   :", out)
