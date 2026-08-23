/**
 * fraudDetector.js — Fraud Detection Module (Sprint 3)
 *
 * Heuristic rule engine, report Section 3.1.5 (sequence diagram Fig 4.12):
 *   Rule 1  Buyer–Seller Loop Detection      (wash trading, pair >= 3 tx)
 *   Rule 2  Abnormal Transaction Frequency   (window count >> collection avg)
 *   Rule 3  Self-Transfer Detection          (sender == recipient)
 *   Rule 4  Rapid Price Escalation           (>= 50% jumps in short window)
 *
 * Every triggered rule contributes a weighted penalty (config/thresholds.json)
 * -> fraudRisk 0-100 passed to the RiskScoreEngine. Deterministic output for
 * the same dataset (non-functional requirement: Reliability).
 */
const Transaction = require("../models/Transaction");
const FraudFlag = require("../models/FraudFlag");
const thresholds = require("../config/thresholds.json");

const pairKey = (a, b) => [String(a).toLowerCase(), String(b).toLowerCase()].sort().join("<->");

/** Rule 1 — Buyer–Seller Loop (A -> B -> A -> B ...) */
function detectBuyerSellerLoop(txs) {
  const min = thresholds.washTrade.loopPairMinCount;
  const counts = {};
  for (const t of txs) {
    if (t.txType !== "SALE" && t.txType !== "TRANSFER") continue;
    // A wallet trading with ITSELF is not a two-party buyer-seller loop — that is
    // Rule 3's job. Without this guard pairKey(A,A) forms a "pair", so three
    // self-transfers fired BOTH rules and the same event was penalised twice.
    const from = String(t.senderAddress).toLowerCase();
    const to = String(t.recipientAddress).toLowerCase();
    if (from === to) continue;
    const k = pairKey(from, to);
    counts[k] = (counts[k] || 0) + 1;
  }
  const loops = Object.entries(counts).filter(([, n]) => n >= min);
  if (!loops.length) return null;
  return {
    flagType: "BUYER_SELLER_LOOP",
    penaltyScore: thresholds.washTrade.penalty,
    description: `Wallet pair(s) traded this NFT ${loops.map(([k, n]) => `${n}x (${k})`).join("; ")} — wash trading pattern`,
    evidence: { loops: loops.map(([pair, count]) => ({ pair, count })), threshold: min },
  };
}

/** Rule 2 — Abnormal Transaction Frequency inside a sliding window.
 * Baseline = mean of every token's own densest window count in this collection,
 * so a token is flagged when its burst is `baselineMultiplier`x the typical burst. */
function maxWindowCount(times, windowMs) {
  const t = [...times].sort((a, b) => a - b);
  let mx = t.length ? 1 : 0;
  for (let i = 0, j = 0; i < t.length; i++) {
    while (t[i] - t[j] > windowMs) j++;
    mx = Math.max(mx, i - j + 1);
  }
  return mx;
}

async function detectAbnormalFrequency(txs, collectionName, tokenId) {
  const { windowMinutes, baselineMultiplier, minCount, penalty } = thresholds.abnormalFrequency;
  const windowMs = windowMinutes * 60 * 1000;
  const isTrade = t => t.txType === "SALE" || t.txType === "TRANSFER"; // listings/mints are not trades

  const mine = maxWindowCount(txs.filter(isTrade).map(t => new Date(t.timestamp).getTime()), windowMs);
  if (mine < minCount) return null;

  // collection baseline: mean densest-window count across the other tokens (trades only)
  const collTxs = await Transaction.find({ collectionName, txType: { $in: ["SALE", "TRANSFER"] } }).select("tokenId timestamp").lean();
  const byToken = {};
  for (const t of collTxs) (byToken[t.tokenId] = byToken[t.tokenId] || []).push(new Date(t.timestamp).getTime());
  const others = Object.entries(byToken).filter(([id]) => Number(id) !== tokenId)
    .map(([, times]) => maxWindowCount(times, windowMs));
  const baseline = others.length ? others.reduce((a, b) => a + b, 0) / others.length : 1;

  if (mine > baseline * baselineMultiplier) {
    return {
      flagType: "ABNORMAL_FREQUENCY",
      penaltyScore: penalty,
      description: `${mine} transactions within ${windowMinutes} min vs collection baseline ${baseline.toFixed(1)} per token`,
      evidence: { maxInWindow: mine, windowMinutes, baseline: Number(baseline.toFixed(2)), multiplier: baselineMultiplier },
    };
  }
  return null;
}

/** Rule 3 — Self-Transfer (identical sender/recipient wallet).
 * Only an actual ownership move (SALE / TRANSFER) can be a wash "self-transfer".
 * A LIST / DELIST records owner -> owner by design (no ownership change), and a
 * MINT records 0x0 -> owner, so neither must ever be counted here — otherwise
 * simply re-pricing your own listing would keep inflating the fraud score. */
function detectSelfTransfer(txs) {
  const hits = txs.filter(t =>
    (t.txType === "SALE" || t.txType === "TRANSFER") &&
    String(t.senderAddress).toLowerCase() === String(t.recipientAddress).toLowerCase());
  if (!hits.length) return null;
  const { penalty, perExtra = 0 } = thresholds.selfTransfer;
  return {
    flagType: "SELF_TRANSFER",
    penaltyScore: Math.min(100, penalty + Math.max(0, hits.length - 1) * perExtra),
    description: `${hits.length} self-transfer(s) where sender and recipient are the same wallet (penalty scales with count)`,
    evidence: { count: hits.length, txHashes: hits.map(h => h.txHash) },
  };
}

/** Rule 4 — Rapid Price Escalation between consecutive sales */
function detectRapidPriceEscalation(txs) {
  const { minIncreasePct, windowMinutes, penalty } = thresholds.rapidPriceEscalation;
  const sales = txs.filter(t => t.txType === "SALE" && t.priceEth > 0)
                   .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const spikes = [];
  for (let i = 1; i < sales.length; i++) {
    const prev = sales[i - 1], cur = sales[i];
    const dtMin = (new Date(cur.timestamp) - new Date(prev.timestamp)) / 60000;
    const inc = (cur.priceEth - prev.priceEth) / prev.priceEth;
    if (inc >= minIncreasePct && dtMin <= windowMinutes) {
      spikes.push({ from: prev.priceEth, to: cur.priceEth, increasePct: Number((inc * 100).toFixed(1)), withinMinutes: Number(dtMin.toFixed(1)) });
    }
  }
  if (!spikes.length) return null;
  return {
    flagType: "RAPID_PRICE_ESCALATION",
    penaltyScore: penalty,
    description: `${spikes.length} consecutive sale(s) jumped >= ${minIncreasePct * 100}% within ${windowMinutes} min (max +${Math.max(...spikes.map(s => s.increasePct))}%)`,
    evidence: { spikes },
  };
}

/**
 * Run the full 4-rule pipeline for one token (Fig 4.12 steps 2-16).
 * Clears previous heuristic flags first so results stay deterministic.
 */
async function runFraudAnalysis(tokenId) {
  const txs = await Transaction.find({ tokenId }).sort({ timestamp: 1 }).lean();
  const collectionName = txs[0] ? txs[0].collectionName : "";

  await FraudFlag.deleteMany({
    tokenId,
    flagType: { $in: ["BUYER_SELLER_LOOP", "ABNORMAL_FREQUENCY", "SELF_TRANSFER", "RAPID_PRICE_ESCALATION"] },
  });

  const results = [];
  const r1 = detectBuyerSellerLoop(txs);            if (r1) results.push(r1);
  const r2 = await detectAbnormalFrequency(txs, collectionName, tokenId); if (r2) results.push(r2);
  const r3 = detectSelfTransfer(txs);               if (r3) results.push(r3);
  const r4 = detectRapidPriceEscalation(txs);       if (r4) results.push(r4);

  for (const r of results) await FraudFlag.create({ tokenId, ...r });

  const fraudRisk = Math.min(100, results.reduce((s, r) => s + r.penaltyScore, 0));
  return { tokenId, fraudRisk, rulesTriggered: results.map(r => r.flagType), flags: results, txCount: txs.length };
}

module.exports = { runFraudAnalysis, detectBuyerSellerLoop, detectSelfTransfer, detectRapidPriceEscalation };
