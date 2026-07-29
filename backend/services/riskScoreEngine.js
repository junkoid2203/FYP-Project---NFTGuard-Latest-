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
  const unified = Math.round(
    w.authenticity * auth.authRisk +
    w.fraud * fraud.fraudRisk +
    w.priceAnomaly * price.priceRisk
  );
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
