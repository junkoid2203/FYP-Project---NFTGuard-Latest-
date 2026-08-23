/**
 * riskScoreEngine.js — Risk Analytics & Visualization Module (Sprint 4)
 *
 * Unified risk score, report Section 3.1.6 (sequence diagram Fig 4.15):
 *
 *   Risk Score = (0.40 x Authenticity Risk)
 *              + (0.35 x Fraud Risk)
 *              + (0.25 x Price Anomaly Risk)
 *
 * Normalised 0 (lowest risk) — 100 (highest risk).
 * Level mapping: < 40 Low | 40-69 Medium | >= 70 High  (FR 5.2)
 * Weights + level cutoffs are configurable in config/thresholds.json
 * (administrator-configurable, per report).
 */
const Nft = require("../models/Nft");
const RiskScore = require("../models/RiskScore");
const FraudFlag = require("../models/FraudFlag");
const { verifyNft } = require("./authVerifier");
const { runFraudAnalysis } = require("./fraudDetector");
const { priceRiskForToken } = require("./priceAnalyzer");
const thresholds = require("../config/thresholds.json");

function levelOf(score) {
  const { mediumFrom, highFrom } = thresholds.riskLevels;
  if (score >= highFrom) return "High";
  if (score >= mediumFrom) return "Medium";
  return "Low";
}

/**
 * Compute + persist the unified risk score for one token.
 * Fig 4.15 steps 3-12: gather three indicators -> weighted formula ->
 * level label -> store record in MongoDB -> return full payload.
 */
async function computeUnifiedRisk(tokenId, { reverify = true } = {}) {
  const nft = await Nft.findOne({ tokenId }).lean();
  if (!nft) throw new Error(`NFT #${tokenId} not found`);

  // Indicator 1 — authenticity (Sprint 1 module)
  const auth = reverify
    ? await verifyNft(tokenId)
    : { authRisk: await storedAuthRisk(tokenId), checks: [], authenticityStatus: nft.authenticityStatus };

  // Indicator 2 — fraud heuristics (Sprint 3 module)
  const fraud = await runFraudAnalysis(tokenId);

  // Indicator 3 — price anomalies (Sprint 3 module)
  const price = await priceRiskForToken(tokenId);

  const w = thresholds.riskWeights;
  const weighted = Math.round(
    w.authenticity * auth.authRisk +
    w.fraud * fraud.fraudRisk +
    w.priceAnomaly * price.priceRisk
  );

  // Severe-indicator escalation. The weighted average alone caps any single signal at
  // its weight (price 100 -> 25 = "Low"; a proven fake -> 40 = "Medium"), which is wrong
  // for a fraud system: one decisive red flag must be able to raise the verdict by itself.
  //
  // Each indicator has its OWN curve, because the same number does not mean the same
  // thing across them: fraudRisk 90 is two self-transfers (routine in real mainnet data),
  // while priceRisk 90 is an asset listed at ~5x its collection median. Shared bands also
  // produced a cliff — 97 ETH scored 55 while 100 ETH scored 75. The curves are
  // interpolated, so the score now rises smoothly with severity.
  const esc = thresholds.riskLevels.escalation || {};
  const curves = esc.curves || {};
  const floorFor = (value, curve) => {
    if (!Array.isArray(curve) || !curve.length || !(value > 0)) return 0;
    if (value < curve[0][0]) return 0;                       // below the first anchor: no floor
    for (let i = 0; i < curve.length; i++) {
      const [x, y] = curve[i];
      if (value === x) return y;
      if (value < x) {
        const [px, py] = curve[i - 1];
        return py + ((value - px) / (x - px)) * (y - py);    // linear between anchors
      }
    }
    return curve[curve.length - 1][1];                       // at/above the last anchor
  };

  const candidates = [
    { indicator: "authenticity", value: auth.authRisk,  floor: floorFor(auth.authRisk,  curves.authenticity) },
    { indicator: "fraud",        value: fraud.fraudRisk, floor: floorFor(fraud.fraudRisk, curves.fraud) },
    { indicator: "price",        value: price.priceRisk, floor: floorFor(price.priceRisk, curves.price) },
  ];
  const top = candidates.reduce((a, b) => (b.floor > a.floor ? b : a), candidates[0]);
  const floor = Math.round(top.floor);
  const escalatedBy = floor >= 70 ? "critical" : floor >= 55 ? "severe" : "moderate";

  const unified = Math.max(weighted, floor || 0);
  const riskLevel = levelOf(unified);

  const breakdown = {
    weights: w,
    authRisk: auth.authRisk,
    fraudRisk: fraud.fraudRisk,
    priceRisk: price.priceRisk,
    contribution: {
      authenticity: Number((w.authenticity * auth.authRisk).toFixed(1)),
      fraud: Number((w.fraud * fraud.fraudRisk).toFixed(1)),
      priceAnomaly: Number((w.priceAnomaly * price.priceRisk).toFixed(1)),
    },
    weightedScore: weighted,
    // present only when a single indicator lifted the score above the weighted sum
    escalation: (floor > weighted)
      ? { level: escalatedBy, indicator: top.indicator, strongestIndicator: top.value, floor, raisedFrom: weighted }
      : null,
  };

  await RiskScore.findOneAndUpdate(
    { tokenId },
    {
      tokenId,
      authRisk: auth.authRisk,
      fraudRisk: fraud.fraudRisk,
      priceRisk: price.priceRisk,
      unifiedScore: unified,
      riskLevel,
      breakdown,
      calculatedAt: new Date(),
    },
    { upsert: true, new: true }
  );

  const flags = await FraudFlag.find({ tokenId }).sort({ detectedAt: -1 }).lean();

  return {
    tokenId,
    unifiedScore: unified,
    riskLevel,
    breakdown,
    authenticity: { status: auth.authenticityStatus, checks: auth.checks },
    fraud: { rulesTriggered: fraud.rulesTriggered, txCount: fraud.txCount },
    price: { stats: price.stats, history: price.history || [], anomalies: price.anomalies || [] },
    flags,
    highRiskAlert: unified >= thresholds.riskLevels.highFrom, // FR 5.3 extend condition
  };
}

async function storedAuthRisk(tokenId) {
  const rs = await RiskScore.findOne({ tokenId }).lean();
  return rs ? rs.authRisk : 0;
}

module.exports = { computeUnifiedRisk, levelOf };
