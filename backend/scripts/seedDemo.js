/**
 * seedDemo.js — populate MongoDB with a demonstration dataset that exercises
 * every detection mechanism in the report (useful for Chapter 5 Testing and
 * the live FYP demo). Run:  npm run seed
 *
 * Scenarios created:
 *   #1  Genesis Orb          — clean, verified                (Low risk)
 *   #2  Neon Circuit         — clean, several fair sales      (Low risk)
 *   #3  Wash Cycle           — A<->B loop x6, 12min apart      (Medium+)    Rule 1+2+4
 *   #4  Mirror Mint          — self-transfers                 (Medium)     Rule 3
 *   #5  Flash Flip           — 8 tx in 30 minutes             (Medium)     Rule 2
 *   #6  Phantom Ape          — metadata hash mismatch         (Tampered)
 *   #7  Phantom Ape Copy     — duplicate pHash of #6          (Duplicate)
 *   #8  Moon Spike           — one sale at |Z| >> 2.5         (price anomaly)
 *   #9  Dark Mint            — tampered + duplicate + loop +
 *                            self-transfer + escalation      (HIGH risk, combined scam)
 */
require("dotenv").config();
const mongoose = require("mongoose");
const crypto = require("crypto");
const connectDB = require("../config/db");
const Nft = require("../models/Nft");
const Transaction = require("../models/Transaction");
const RiskScore = require("../models/RiskScore");
const FraudFlag = require("../models/FraudFlag");
const PriceStats = require("../models/PriceStats");
const { computeUnifiedRisk } = require("../services/riskScoreEngine");

const sha = s => "0x" + crypto.createHash("sha256").update(s).digest("hex");

// Simulated testnet wallets (FR 2.1)
const W = {
  alice:  "0xA11CE00000000000000000000000000000000001",
  bob:    "0xB0B0000000000000000000000000000000000002",
  carol:  "0xCA401000000000000000000000000000000003",
  dave:   "0xDA7E000000000000000000000000000000000004",
  washer1:"0x3A5B111111111111111111111111111111111111",
  washer2:"0x3A5B222222222222222222222222222222222222",
  zero:   "0x0000000000000000000000000000000000000000",
};

const COLL = "CyberGuard Genesis";
const now = Date.now();
const minsAgo = m => new Date(now - m * 60 * 1000);
const daysAgo = d => new Date(now - d * 24 * 60 * 60 * 1000);
const txh = () => "0xseed" + crypto.randomBytes(29).toString("hex");

async function main() {
  await connectDB();
  console.log("Clearing existing collections...");
  await Promise.all([Nft.deleteMany({}), Transaction.deleteMany({}), RiskScore.deleteMany({}), FraudFlag.deleteMany({}), PriceStats.deleteMany({})]);

  const mk = (tokenId, name, opts = {}) => ({
    tokenId, name, collectionName: COLL,
    description: opts.description || `${name} — part of the ${COLL} demo collection`,
    image: opts.image || "",
    tokenURI: `ipfs://demo/${tokenId}`,
    contractAddress: process.env.CONTRACT_ADDRESS || "0xSIMULATEDCONTRACT",
    metadataHash: opts.metadataHash ?? sha(`meta-${tokenId}`),
    offChainMetadataHash: opts.offChainMetadataHash ?? sha(`meta-${tokenId}`),
    imageHash: opts.imageHash || "",
    erc721Compliant: opts.erc721Compliant ?? true,
    creatorAddress: opts.creator || W.alice,
    ownerAddress: opts.owner || W.alice,
    listed: opts.listed ?? true,
    priceEth: opts.priceEth ?? 0.5,
    traits: opts.traits || { rarity: "Common" },
  });

  console.log("Creating NFTs...");
  await Nft.insertMany([
    mk(1, "Genesis Orb",   { priceEth: 0.45, owner: W.bob,   traits: { rarity: "Rare" } }),
    mk(2, "Neon Circuit",  { priceEth: 0.55, owner: W.carol }),
    mk(3, "Wash Cycle",    { priceEth: 4.2,  owner: W.washer1, creator: W.washer1, traits: { rarity: "Legendary?" } }),
    mk(4, "Mirror Mint",   { priceEth: 0.6,  owner: W.dave,  creator: W.dave }),
    mk(5, "Flash Flip",    { priceEth: 0.9,  owner: W.bob }),
    mk(6, "Phantom Ape",   { priceEth: 0.7,  owner: W.carol, offChainMetadataHash: sha("meta-6-TAMPERED"), imageHash: "pHASH_APE_0001" }),
    mk(7, "Phantom Ape Copy", { priceEth: 0.65, owner: W.dave, creator: W.dave, imageHash: "pHASH_APE_0001" }),
    mk(8, "Moon Spike",    { priceEth: 5.5,  owner: W.alice }),
    mk(9, "Dark Mint",     { priceEth: 6.7,  owner: W.washer2, creator: W.washer2,
                             offChainMetadataHash: sha("meta-9-TAMPERED"),
                             imageHash: "pHASH_APE_0001", traits: { rarity: "Mythic??" } }),
  ]);

  console.log("Creating transaction histories...");
  const T = [];
  const mint = (id, to, when) => T.push({ tokenId: id, collectionName: COLL, txType: "MINT", senderAddress: W.zero, recipientAddress: to, priceEth: 0, txHash: txh(), timestamp: when });
  const sale = (id, from, to, price, when) => T.push({ tokenId: id, collectionName: COLL, txType: "SALE", senderAddress: from, recipientAddress: to, priceEth: price, txHash: txh(), timestamp: when });

  // #1 / #2 — organic history
  mint(1, W.alice, daysAgo(30)); sale(1, W.alice, W.bob, 0.40, daysAgo(20)); sale(1, W.bob, W.carol, 0.44, daysAgo(10)); sale(1, W.carol, W.bob, 0.45, daysAgo(3));
  mint(2, W.alice, daysAgo(28)); sale(2, W.alice, W.dave, 0.50, daysAgo(18)); sale(2, W.dave, W.carol, 0.55, daysAgo(6));

  // #3 — wash trading: washer1 <-> washer2 loop x6 with rapid escalation (Rule 1 + 4)
  mint(3, W.washer1, daysAgo(5));
  let p = 0.5;
  for (let i = 0; i < 6; i++) {
    const from = i % 2 === 0 ? W.washer1 : W.washer2;
    const to   = i % 2 === 0 ? W.washer2 : W.washer1;
    sale(3, from, to, Number(p.toFixed(3)), minsAgo(120 - i * 12)); // every 12 min -> dense burst
    p *= 1.6; // +60% each hop  -> triggers rapid escalation
  }

  // #4 — self transfers (Rule 3)
  mint(4, W.dave, daysAgo(8));
  sale(4, W.dave, W.dave, 0.60, daysAgo(2));
  sale(4, W.dave, W.dave, 0.62, daysAgo(1));

  // #5 — abnormal frequency: 8 sales inside 30 minutes (Rule 2)
  mint(5, W.alice, daysAgo(9));
  const cyc = [W.alice, W.bob, W.carol, W.dave];
  for (let i = 0; i < 8; i++) sale(5, cyc[i % 4], cyc[(i + 1) % 4], 0.85 + i * 0.01, minsAgo(35 - i * 4));

  // #6 / #7 — tampered + duplicate (verified by authVerifier layers 2-3)
  mint(6, W.carol, daysAgo(15)); sale(6, W.carol, W.bob, 0.70, daysAgo(7)); sale(6, W.bob, W.carol, 0.72, daysAgo(2));
  mint(7, W.dave, daysAgo(4));

  // #8 — single extreme price spike -> |Z| >> 2.5
  mint(8, W.alice, daysAgo(12)); sale(8, W.alice, W.bob, 0.5, daysAgo(6)); sale(8, W.bob, W.alice, 5.5, daysAgo(1));

  // #9 — combined scam: tampered metadata + wash loop + rapid escalation (HIGH)
  mint(9, W.washer2, daysAgo(3));
  let q = 0.8;
  for (let i = 0; i < 4; i++) {
    const from = i % 2 === 0 ? W.washer2 : W.washer1;
    const to   = i % 2 === 0 ? W.washer1 : W.washer2;
    sale(9, from, to, Number(q.toFixed(3)), minsAgo(90 - i * 15));
    q *= 1.6;
  }
  sale(9, W.washer2, W.washer2, 3.4, minsAgo(28)); // self-transfer -> fraud maxes out

  await Transaction.insertMany(T);
  console.log(`  ${T.length} transactions inserted`);

  console.log("Running full risk pipeline for every token (verify + fraud + price + unified score)...");
  for (let id = 1; id <= 9; id++) {
    const r = await computeUnifiedRisk(id);
    console.log(`  #${id}  score=${String(r.unifiedScore).padStart(3)}  level=${r.riskLevel.padEnd(6)}  auth=${r.breakdown.authRisk} fraud=${r.breakdown.fraudRisk} price=${r.breakdown.priceRisk}  [${r.fraud.rulesTriggered.join(", ") || "clean"}]`);
  }

  console.log("\nSeed complete. Start the server with `npm start` and open http://localhost:5000");
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
