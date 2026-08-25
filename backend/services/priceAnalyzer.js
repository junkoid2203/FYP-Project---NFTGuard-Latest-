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
const Nft = require("../models/Nft");
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

/**
 * Robust modified Z-score (median + MAD, Iglewicz-Hoaglin) — resistant to outliers,
 * so a single extreme price no longer inflates the spread and hides itself.
 * Falls back to the classic mean/stdDev Z-score when MAD is 0 (many identical prices).
 * Shared by sale-history analysis and live listing-price analysis.
 */
function zScoreOf(price, stats) {
  if (stats.mad > 0) return 0.6745 * (price - stats.medianPrice) / stats.mad;
  if (stats.stdDev > 0) return (price - stats.avgPrice) / stats.stdDev;
  return 0;
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

  const points = sales.map(t => {
    const z = zScoreOf(t.priceEth, stats);
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

  // Clear any prior price flags first, so re-running analysis never stacks duplicates
  // and a token that is no longer anomalous correctly loses its flag.
  await FraudFlag.deleteMany({ tokenId, flagType: { $in: ["PRICE_ANOMALY", "LISTING_PRICE_ANOMALY"] } });

  // A collection needs a real sample before its median/MAD mean anything. With 3 sales a
  // perfectly ordinary price scores |Z| = 6.7, so judging it would be pure noise.
  const enoughData = stats.sampleSize >= (thresholds.priceAnomaly.minSamples ?? 8);

  let risk = 0;
  if (enoughData && anomalies.length) {
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

  // ---- LIVE LISTING price anomaly (proactive) ----------------------------------
  // A completed sale only flags fraud *after* a victim has already paid. The asking
  // price of a live listing can be judged immediately, so an NFT listed far outside
  // its collection's normal range raises risk the moment it is listed or re-priced.
  const { listingPenalty, perExcessZ, minSamplesForListing, underpriceFactor, extremeRatio } = thresholds.priceAnomaly;
  const nft = await Nft.findOne({ tokenId }).select("listed priceEth").lean();
  let listing = null;
  const enoughSales = stats.sampleSize >= (minSamplesForListing ?? 3);
  // Without a real sample there is no "normal" to compare against, and a ratio is useless
  // here: a brand-new collection whose only trades were 0.002 ETH made 0.02 look extreme,
  // so an ordinary asking price on a freshly minted NFT was flagged. Fall back instead to
  // an ABSOLUTE ceiling set above any price an NFT has ever fetched (the record is
  // Beeple's ~38,000 ETH), so a small collection is only flagged for a figure that could
  // not be a genuine ask.
  const absurd = thresholds.priceAnomaly.absurdPriceEth ?? 50000;
  const smallSampleExtreme = !enoughSales && nft && nft.priceEth >= absurd;
  if (nft && nft.listed && nft.priceEth > 0 && (enoughSales || smallSampleExtreme)) {
    const z = zScoreOf(nft.priceEth, stats);
    const med = stats.medianPrice;
    // Over-pricing: the Z-score handles it (upside is unbounded).
    const overpriced = enoughSales ? Math.abs(z) > zThreshold : true;
    // Under-pricing: a Z-score can never flag it, because price is bounded below by 0
    // while the median sits far above — so a "too cheap" listing (stolen goods dumped
    // fast, or a wash-trade setup) is caught by a ratio rule instead.
    const cheapCutoff = med > 0 ? med / (underpriceFactor ?? 5) : 0;
    const underpriced = cheapCutoff > 0 && nft.priceEth <= cheapCutoff;

    if (overpriced || underpriced) {
      const ratio = med > 0 ? nft.priceEth / med : 0;
      // Scale by how far past the threshold the Z-score sits — but only when the sample
      // is large enough for that Z to mean anything. On a 3-sale collection the spread is
      // near zero, so |Z| explodes into the thousands; there we charge the flat penalty.
      const listingRisk = Math.min(100, listingPenalty
        + ((overpriced && enoughSales) ? Math.max(0, Math.abs(z) - zThreshold) * perExcessZ : 0));
      risk = Math.min(100, risk + listingRisk);
      const how = underpriced
        ? `only ${ratio.toFixed(3)}× the collection median (${med} ETH) — far below the normal range`
        : enoughSales
          ? `|Z| = ${Math.abs(z).toFixed(2)} (> ${zThreshold}), ~${ratio.toFixed(1)}× the collection median of ${med} ETH`
          : `${nft.priceEth} ETH exceeds the ${absurd} ETH sanity ceiling — higher than any NFT has ever sold for, and this collection has only ${stats.sampleSize} sale(s) to judge against`;
      listing = { priceEth: nft.priceEth, zScore: Number(z.toFixed(3)), medianPrice: med,
                  ratio: Number(ratio.toFixed(3)), direction: underpriced ? "under" : "over", risk: Math.round(listingRisk) };
      await FraudFlag.create({
        tokenId,
        flagType: "LISTING_PRICE_ANOMALY",
        penaltyScore: Math.round(listingRisk),
        description: `Listed at ${nft.priceEth} ETH — ${how}`,
        evidence: { listedPrice: nft.priceEth, zScore: Number(z.toFixed(3)), medianPrice: med,
                    ratio: Number(ratio.toFixed(3)), direction: underpriced ? "under" : "over", sampleSize: stats.sampleSize },
      });
    }
  }

  return {
    tokenId,
    collectionName: anyTx.collectionName,
    priceRisk: Math.round(risk),
    stats,
    history: mine,
    anomalies,
    listing,
  };
}

module.exports = { computeCollectionStats, analyzeCollection, priceRiskForToken };
