/**
 * priceAnalyzer.js — Price Transparency Analysis Module (Sprint 3)
 *
 * Implements report Section 3.1.4:
 *   - collection statistics: average, median, standard deviation, min/max
 *   - Z-score-based price anomaly detection: |Z| > threshold (default 2.5)
 *   - price history chart data with anomaly markers (Fig 4.9)
 *   - priceRisk indicator (0-100) passed to the RiskScoreEngine
 */
const Transaction = require("../models/Transaction");
const PriceStats = require("../models/PriceStats");
const FraudFlag = require("../models/FraudFlag");
const thresholds = require("../config/thresholds.json");

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stdDev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1));
}
// Median Absolute Deviation — a robust spread measure that (unlike stdDev) is NOT
// inflated by a single extreme sale, so a genuine price spike still stands out.
function mad(xs) {
  if (xs.length < 2) return 0;
  const med = median(xs);
  return median(xs.map(x => Math.abs(x - med)));
}

/** Recompute + persist collection-level PRICE_STATS (steps 5-6, Fig 4.9). */
async function computeCollectionStats(collectionName) {
  const sales = await Transaction.find({ collectionName, txType: "SALE" }).sort({ timestamp: 1 }).lean();
  const prices = sales.map(t => t.priceEth).filter(p => p > 0);
  const stats = {
    collectionName,
    avgPrice: Number(mean(prices).toFixed(6)),
    medianPrice: Number(median(prices).toFixed(6)),
    stdDev: Number(stdDev(prices).toFixed(6)),
    mad: Number(mad(prices).toFixed(6)),
    minPrice: prices.length ? Math.min(...prices) : 0,
    maxPrice: prices.length ? Math.max(...prices) : 0,
    sampleSize: prices.length,
    updatedAt: new Date(),
  };
  await PriceStats.findOneAndUpdate({ collectionName }, stats, { upsert: true, new: true });
  return stats;
}

/**
 * Z-score anomaly detection for one collection (steps 7-10, Fig 4.9).
 * Returns per-transaction Z-scores and the flagged anomalies.
 */
async function analyzeCollection(collectionName) {
  const stats = await computeCollectionStats(collectionName);
  const zLimit = thresholds.priceAnomaly.zScoreThreshold;
  const sales = await Transaction.find({ collectionName, txType: "SALE" }).sort({ timestamp: 1 }).lean();

  // Robust modified Z-score (median + MAD, Iglewicz-Hoaglin) — resistant to outliers,
  // so a single extreme sale no longer inflates the spread and hides itself.
  // Falls back to the classic mean/stdDev Z-score when MAD is 0 (many identical prices).
  const points = sales.map(t => {
    const z = stats.mad > 0
      ? 0.6745 * (t.priceEth - stats.medianPrice) / stats.mad
      : (stats.stdDev > 0 ? (t.priceEth - stats.avgPrice) / stats.stdDev : 0);
    return {
      tokenId: t.tokenId,
      priceEth: t.priceEth,
      timestamp: t.timestamp,
      zScore: Number(z.toFixed(3)),
      anomaly: Math.abs(z) > zLimit,
    };
  });

  return { stats, zThreshold: zLimit, points, anomalies: points.filter(p => p.anomaly) };
}

/**
 * priceRisk (0-100) for a single token, derived from its own sale history
 * relative to collection distribution. Documented formula:
 *   basePenalty + perAnomaly x count + perExcessZ x (max|Z| - threshold), capped 100.
 */
async function priceRiskForToken(tokenId) {
  const anyTx = await Transaction.findOne({ tokenId }).lean();
  if (!anyTx) return { tokenId, priceRisk: 0, anomalies: [], stats: null };

  const { stats, points, zThreshold } = await analyzeCollection(anyTx.collectionName);
  const mine = points.filter(p => p.tokenId === tokenId);
  const anomalies = mine.filter(p => p.anomaly);

  // Clear any prior PRICE_ANOMALY flag first, so re-running analysis never stacks
  // duplicates and a token that is no longer anomalous correctly loses its flag.
  await FraudFlag.deleteMany({ tokenId, flagType: "PRICE_ANOMALY" });

  let risk = 0;
  if (anomalies.length) {
    const { basePenalty, perAnomaly, perExcessZ } = thresholds.priceAnomaly;
    const maxAbsZ = Math.max(...anomalies.map(a => Math.abs(a.zScore)));
    risk = Math.min(100, basePenalty + anomalies.length * perAnomaly + Math.max(0, (maxAbsZ - zThreshold)) * perExcessZ);
    // Persist a PRICE_ANOMALY flag once per analysis run
    await FraudFlag.create({
      tokenId,
      flagType: "PRICE_ANOMALY",
      penaltyScore: Math.round(risk),
      description: `${anomalies.length} sale(s) exceed |Z| > ${zThreshold} (max |Z| = ${maxAbsZ.toFixed(2)})`,
      evidence: { anomalies },
    });
  }

  return {
    tokenId,
    collectionName: anyTx.collectionName,
    priceRisk: Math.round(risk),
    stats,
    history: mine,
    anomalies,
  };
}

module.exports = { computeCollectionStats, analyzeCollection, priceRiskForToken };
