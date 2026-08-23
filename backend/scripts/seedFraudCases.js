/**
 * seedFraudCases.js — add one demo NFT per fraud rule, so every heuristic has a
 * concrete token you can point at. ADDITIVE: it never wipes existing data, and
 * re-running it replaces only the tokens it created.
 *
 *   FC-1  Loop Bait      Rule 1  buyer<->seller loop, 4 trades between one pair
 *   FC-2  Burst Flip     Rule 2  8 trades inside 25 minutes
 *   FC-3  Mirror Wallet  Rule 3  3 self-transfers
 *   FC-4  Moon Ladder    Rule 4  price doubling every 10 minutes
 *
 * Run:  npm run seed:fraud      (then re-verify from the dashboard or /api/risk/:id)
 */
require("dotenv").config();
const mongoose = require("mongoose");
const crypto = require("crypto");
const connectDB = require("../config/db");
const Nft = require("../models/Nft");
const Transaction = require("../models/Transaction");
const RiskScore = require("../models/RiskScore");
const FraudFlag = require("../models/FraudFlag");
const { computeUnifiedRisk } = require("../services/riskScoreEngine");

// Each case gets its OWN collection. Price statistics are per-collection, so sharing one
// would let Moon Ladder's escalating prices distort Burst Flip's baseline and fire price
// flags on a token meant to isolate a different rule.
const COLL = "Fraud Cases";
const collOf = name => `${COLL} · ${name}`;
const collName = {};   // tokenId -> collection
const W = {
  a: "0xFC0A000000000000000000000000000000000001",
  b: "0xFC0B000000000000000000000000000000000002",
  c: "0xFC0C000000000000000000000000000000000003",
  d: "0xFC0D000000000000000000000000000000000004",
  zero: "0x0000000000000000000000000000000000000000",
};
const sha = s => "0x" + crypto.createHash("sha256").update(s).digest("hex");
const txh = () => "0xfc" + crypto.randomBytes(31).toString("hex");
const minsAgo = m => new Date(Date.now() - m * 60000);

async function main() {
  await connectDB();

  // remove only what this script previously created
  const old = await Nft.find({ collectionName: new RegExp("^" + COLL) }).select("tokenId").lean();
  const oldIds = old.map(n => n.tokenId);
  if (oldIds.length) {
    await Promise.all([
      Nft.deleteMany({ tokenId: { $in: oldIds } }),
      Transaction.deleteMany({ tokenId: { $in: oldIds } }),
      RiskScore.deleteMany({ tokenId: { $in: oldIds } }),
      FraudFlag.deleteMany({ tokenId: { $in: oldIds } }),
    ]);
    console.log(`Replaced ${oldIds.length} existing "${COLL}" token(s).`);
  }

  const last = await Nft.findOne().sort({ tokenId: -1 }).lean();
  let id = (last ? last.tokenId : 0) + 1;

  const T = [];
  const mint = (tokenId, to, when) => T.push({ tokenId, collectionName: collName[tokenId], txType: "MINT",
    senderAddress: W.zero, recipientAddress: to, priceEth: 0, txHash: txh(), timestamp: when });
  const sale = (tokenId, from, to, price, when) => T.push({ tokenId, collectionName: collName[tokenId], txType: "SALE",
    senderAddress: from, recipientAddress: to, priceEth: Number(price.toFixed(4)), txHash: txh(), timestamp: when });

  const mk = (tokenId, name, owner, price) => ((collName[tokenId] = collOf(name)), {
    tokenId, name, collectionName: collOf(name),
    description: `${name} — demo token for fraud-rule testing`,
    image: "", tokenURI: `ipfs://fraudcase/${tokenId}`,
    contractAddress: process.env.CONTRACT_ADDRESS || "0xSIMULATED",
    metadataHash: sha("fc-" + tokenId), offChainMetadataHash: sha("fc-" + tokenId),
    erc721Compliant: true, creatorAddress: owner, ownerAddress: owner,
    listed: true, priceEth: price, traits: { demo: "fraud-case" },
  });

  const made = [];

  // ---- Rule 1: buyer<->seller loop (4 trades between exactly one pair, no self-transfer)
  const t1 = id++;
  made.push({ id: t1, rule: "Rule 1 · BUYER_SELLER_LOOP", nft: mk(t1, "Loop Bait", W.a, 1.0) });
  mint(t1, W.a, minsAgo(600));
  for (let i = 0; i < 4; i++) {
    sale(t1, i % 2 ? W.b : W.a, i % 2 ? W.a : W.b, 1.0, minsAgo(500 - i * 90)); // 90 min apart: avoids Rule 2
  }

  // ---- Rule 2: abnormal frequency (8 trades in 25 minutes, 4 rotating wallets -> no pair hits 3)
  const t2 = id++;
  made.push({ id: t2, rule: "Rule 2 · ABNORMAL_FREQUENCY", nft: mk(t2, "Burst Flip", W.a, 1.0) });
  mint(t2, W.a, minsAgo(600));
  const ring = [W.a, W.b, W.c, W.d];
  for (let i = 0; i < 8; i++) {
    sale(t2, ring[i % 4], ring[(i + 1) % 4], 1.0 + i * 0.002, minsAgo(30 - i * 3)); // flat price: avoids Rule 4
  }

  // ---- Rule 3: self-transfer (3 self-transfers by one wallet)
  const t3 = id++;
  made.push({ id: t3, rule: "Rule 3 · SELF_TRANSFER", nft: mk(t3, "Mirror Wallet", W.c, 1.0) });
  mint(t3, W.c, minsAgo(600));
  for (let i = 0; i < 3; i++) sale(t3, W.c, W.c, 1.0, minsAgo(400 - i * 120)); // spread out: avoids Rule 2

  // ---- Rule 4: rapid price escalation (doubling every 10 min, all different wallet pairs)
  const t4 = id++;
  made.push({ id: t4, rule: "Rule 4 · RAPID_PRICE_ESCALATION", nft: mk(t4, "Moon Ladder", W.d, 8.0) });
  mint(t4, W.a, minsAgo(600));
  let p = 1.0;
  const chain = [W.a, W.b, W.c, W.d];
  for (let i = 0; i < 3; i++) { sale(t4, chain[i], chain[i + 1], p, minsAgo(40 - i * 10)); p *= 2; }

  await Nft.insertMany(made.map(m => m.nft));
  await Transaction.insertMany(T);

  console.log(`\nCreated ${made.length} tokens in collection "${COLL}" (${T.length} transactions).\n`);
  for (const m of made) {
    const r = await computeUnifiedRisk(m.id, { reverify: false });
    const flags = (r.flags || []).map(f => f.flagType);
    console.log(`  #${String(m.id).padEnd(3)} ${m.nft.name.padEnd(14)} ${m.rule.padEnd(34)}`);
    console.log(`        score ${String(r.unifiedScore).padStart(3)} ${r.riskLevel.padEnd(7)} flags: ${flags.join(", ") || "(none)"}`);
  }
  console.log(`\nInspect any of them:  curl.exe -s -X POST http://localhost:5000/api/fraud/<id>`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
