/**
 * testFraudRules.js — controlled unit tests for the fraud heuristic rules.
 *
 * Each rule is fed a hand-built transaction history where the correct answer is known,
 * so we can measure whether it fires when it should, stays silent when it should not,
 * and does not overlap with a different rule. Runs OFFLINE (no MongoDB, no network).
 *
 * Run:  npm run test:fraud
 */
const {
  detectBuyerSellerLoop,
  detectSelfTransfer,
  detectRapidPriceEscalation,
} = require("../services/fraudDetector");
const T = require("../config/thresholds.json");

const A = "0xAAAA000000000000000000000000000000000001";
const B = "0xBBBB000000000000000000000000000000000002";
const C = "0xCCCC000000000000000000000000000000000003";

let pass = 0, fail = 0;
function check(name, got, want, note) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(56)} ${ok ? "" : `(got ${got}, want ${want})`}${note ? "  " + note : ""}`);
}
const sale = (from, to, price, minsAgo) => ({
  txType: "SALE", senderAddress: from, recipientAddress: to, priceEth: price,
  timestamp: new Date(Date.now() - minsAgo * 60000), txHash: "0x" + Math.random().toString(16).slice(2),
});
const fired = r => !!r;

console.log("\nFraud rule tests — controlled scenarios\n");

// ---------------------------------------------------------------- Rule 1
console.log(`Rule 1 · Buyer-Seller Loop  (fires when a pair trades >= ${T.washTrade.loopPairMinCount}x)`);
check("A<->B twice: below threshold, must NOT fire",
  fired(detectBuyerSellerLoop([sale(A, B, 1, 60), sale(B, A, 1, 50)])), false);
check("A<->B three times: MUST fire",
  fired(detectBuyerSellerLoop([sale(A, B, 1, 60), sale(B, A, 1, 50), sale(A, B, 1, 40)])), true);
check("three DIFFERENT pairs once each: must NOT fire",
  fired(detectBuyerSellerLoop([sale(A, B, 1, 60), sale(B, C, 1, 50), sale(C, A, 1, 40)])), false,
  "<- a 3-wallet ring is invisible to this pairwise rule (the graph engine catches it)");
check("MINT is ignored (0x0 -> owner, not a trade)",
  fired(detectBuyerSellerLoop([
    { txType: "MINT", senderAddress: "0x0", recipientAddress: A, priceEth: 0, timestamp: new Date() },
    { txType: "MINT", senderAddress: "0x0", recipientAddress: A, priceEth: 0, timestamp: new Date() },
    { txType: "MINT", senderAddress: "0x0", recipientAddress: A, priceEth: 0, timestamp: new Date() },
  ])), false);

// ---------------------------------------------------------------- Rule 3
console.log(`\nRule 3 · Self-Transfer  (penalty ${T.selfTransfer.penalty} +${T.selfTransfer.perExtra} each extra)`);
check("A -> B is not a self-transfer",
  fired(detectSelfTransfer([sale(A, B, 1, 10)])), false);
check("A -> A once: MUST fire",
  fired(detectSelfTransfer([sale(A, A, 1, 10)])), true);
const two = detectSelfTransfer([sale(A, A, 1, 20), sale(A, A, 1, 10)]);
check("A -> A twice: penalty scales to 90",
  two && two.penaltyScore, T.selfTransfer.penalty + T.selfTransfer.perExtra);
check("LIST (owner -> owner) must NOT count as a self-transfer",
  fired(detectSelfTransfer([{ txType: "LIST", senderAddress: A, recipientAddress: A, priceEth: 1, timestamp: new Date() }])), false,
  "<- otherwise re-pricing your own listing would inflate the score");

// ---------------------------------------------------------------- Rule 4
console.log(`\nRule 4 · Rapid Price Escalation  (>= ${T.rapidPriceEscalation.minIncreasePct * 100}% within ${T.rapidPriceEscalation.windowMinutes} min)`);
check("+10% jump: below threshold, must NOT fire",
  fired(detectRapidPriceEscalation([sale(A, B, 1.0, 60), sale(B, C, 1.1, 50)])), false);
check("+100% jump inside the window: MUST fire",
  fired(detectRapidPriceEscalation([sale(A, B, 1.0, 60), sale(B, C, 2.0, 50)])), true);
check("+100% jump but 10 days apart: must NOT fire",
  fired(detectRapidPriceEscalation([sale(A, B, 1.0, 14400), sale(B, C, 2.0, 10)])), false,
  "<- slow appreciation is legitimate");

// ---------------------------------------------------------------- overlap
console.log("\nRule independence — do two rules double-count the same event?");
const selfOnly = [sale(A, A, 1, 30), sale(A, A, 1, 20)];
check("2 self-transfers do NOT also trigger the loop rule",
  fired(detectBuyerSellerLoop(selfOnly)), false);
const selfx3 = [sale(A, A, 1, 30), sale(A, A, 1, 20), sale(A, A, 1, 10)];
const loopOnSelf = fired(detectBuyerSellerLoop(selfx3));
check("3 self-transfers do NOT also trigger the loop rule",
  loopOnSelf, false,
  loopOnSelf ? "<- OVERLAP: pairKey(A,A) makes a self-transfer look like a wallet pair" : "");
const loopOnly = [sale(A, B, 1, 30), sale(B, A, 1, 20), sale(A, B, 1, 10)];
check("a genuine A<->B loop does NOT trigger the self-transfer rule",
  fired(detectSelfTransfer(loopOnly)), false);

console.log(`\n${fail ? "FAIL" : "OK"}  ${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
