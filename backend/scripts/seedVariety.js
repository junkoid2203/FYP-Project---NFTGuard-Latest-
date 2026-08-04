/**
 * seedVariety.js — add demo NFTs that cover ALL authenticity statuses
 * (Verified / Tampered / Duplicate / NonCompliant / Unverified) across a few
 * extra collections, so the marketplace's authenticity filter is meaningful.
 *
 * SAFE: only touches the demo collections below — it does NOT delete the real
 * Azuki / BoredApeYachtClub data seeded by seedReal.js. Idempotent (re-runnable).
 *
 * Run:  cd backend && node scripts/seedVariety.js
 */
require("dotenv").config();
const crypto = require("crypto");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Nft = require("../models/Nft");
const Transaction = require("../models/Transaction");
const RiskScore = require("../models/RiskScore");
const FraudFlag = require("../models/FraudFlag");

const sha = s => "0x" + crypto.createHash("sha256").update(String(s)).digest("hex");
const daysAgo = d => new Date(Date.now() - d * 864e5);
const COLLECTIONS = ["Pixel Guardians", "Meta Beasts", "Cyber Relics", "Vortex Ring"];
// real, older collections to source distinct character art from (via Alchemy)
const CONTRACTS = {
  "Pixel Guardians": "0x57a204AA1042f6E66DD7730813f4024114d74f37", // CyberKongz
  "Meta Beasts":     "0x1A92f7381B9F03921564a437210bB9396471050C", // Cool Cats
  "Cyber Relics":    "0xe785E82358879F061BC3dcAC6f0444462D4b5330", // World of Women
  "Vortex Ring":     "0xBd3531dA5CF5857e7CfAA92426877b022e612cf8", // Pudgy Penguins
};
const ALCHEMY_KEY = (() => {
  const fs = require("fs"), path = require("path");
  for (const f of [path.join(__dirname, "..", ".env"), path.join(__dirname, "..", "..", ".env")]) {
    try { const m = fs.readFileSync(f, "utf8").match(/alchemy\.com\/v2\/([A-Za-z0-9_-]+)/); if (m) return m[1]; } catch (_) {}
  }
  return null;
})();
async function fetchNfts(contract, n) {
  if (!ALCHEMY_KEY || !contract) return [];
  try {
    const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_KEY}/getNFTsForContract?contractAddress=${contract}&withMetadata=true&limit=${n}`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.nfts || []).map(x => {
      const image = (x.image && (x.image.cachedUrl || x.image.thumbnailUrl || x.image.pngUrl || x.image.originalUrl)) || "";
      const attrs = (x.raw && x.raw.metadata && x.raw.metadata.attributes) || x.attributes || [];
      const traits = {};
      if (Array.isArray(attrs)) attrs.forEach(a => { if (a && a.trait_type != null && a.value != null) traits[a.trait_type] = a.value; });
      return { image, traits };
    }).filter(o => o.image);
  } catch (_) { return []; }
}

// demo wallet pool
const POOL = [
  "0x7a3f9c21b4e8d6a15f0c9b7e2d84a6135c9f0e21",
  "0x2b9c1e77a0d4f8631b5e2c9a7f04d61385ab24cd",
  "0x53be4f11e0a9c7d2836b1f45e9c08a7d61b3ff92",
  "0xc41d80a5f7b26e93041c8ad5f9e0b7326914accd",
  "0x9f0e2d84a6135c9f0e217a3f9c21b4e8d6a15f0c",
  "0x66dbff1188aa77cc33ee55bb99dd44ff22004466",
];
const rndWallet = () => POOL[Math.floor(Math.random() * POOL.length)];
const randHex = () => "0x" + [...Array(40)].map(() => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

const W = { authenticity: 0.3, fraud: 0.5, priceAnomaly: 0.2 };
function riskDoc(tokenId, authRisk, fraudRisk, priceRisk) {
  const contribution = {
    authenticity: +(authRisk * W.authenticity).toFixed(1),
    fraud: +(fraudRisk * W.fraud).toFixed(1),
    priceAnomaly: +(priceRisk * W.priceAnomaly).toFixed(1),
  };
  const unifiedScore = Math.round(contribution.authenticity + contribution.fraud + contribution.priceAnomaly);
  const riskLevel = unifiedScore >= 70 ? "High" : unifiedScore >= 40 ? "Medium" : "Low";
  return { tokenId, authRisk, fraudRisk, priceRisk, unifiedScore, riskLevel,
    breakdown: { weights: W, authRisk, fraudRisk, priceRisk, contribution }, calculatedAt: new Date() };
}

// [collection, realId, status, price, opts]
const SPEC = [
  ["Pixel Guardians", 118, "Verified", 0.42, {}],
  ["Pixel Guardians", 204, "Verified", 0.55, {}],
  ["Pixel Guardians", 77,  "Tampered", 1.80, {}],
  ["Pixel Guardians", 301, "NonCompliant", 0.30, {}],
  ["Pixel Guardians", 9,   "Unverified", 0.65, {}],
  ["Meta Beasts", 45,  "Verified", 0.90, {}],
  ["Meta Beasts", 88,  "Duplicate", 0.70, { dupOf: "Meta Beasts #45" }],
  ["Meta Beasts", 89,  "Duplicate", 0.68, { dupOf: "Meta Beasts #45" }],
  ["Meta Beasts", 12,  "Tampered", 2.10, { wash: true }],
  ["Meta Beasts", 210, "Verified", 1.10, { wash: true }],
  ["Cyber Relics", 3,   "Verified", 3.20, {}],
  ["Cyber Relics", 66,  "NonCompliant", 0.50, {}],
  ["Cyber Relics", 141, "Unverified", 0.80, {}],
  ["Cyber Relics", 7,   "Duplicate", 1.40, { dupOf: "Cyber Relics #3" }],
  ["Cyber Relics", 250, "Tampered", 0.95, { wash: true }],
];

function riskFor(status, opts) {
  const wash = !!opts.wash;
  const fraud = wash ? 90 : 15;
  if (status === "Tampered")     return { auth: 100, fraud, price: 0 };
  if (status === "NonCompliant") return { auth: 100, fraud, price: 0 };
  if (status === "Duplicate")    return { auth: 55,  fraud, price: 0 };
  return { auth: 0, fraud, price: 0 }; // Verified
}
function flagsFor(tokenId, status, opts, dupOf) {
  const out = [];
  if (status === "Tampered") out.push({ tokenId, flagType: "METADATA_TAMPERED", penaltyScore: 80,
    description: "Off-chain metadata hash does not match the on-chain SHA-256 anchor" });
  if (status === "NonCompliant") out.push({ tokenId, flagType: "NON_COMPLIANT_CONTRACT", penaltyScore: 70,
    description: "Contract failed the ERC-165 / ERC-721 interface support check" });
  if (status === "Duplicate") out.push({ tokenId, flagType: "DUPLICATE_ASSET", penaltyScore: 50,
    description: `Perceptual hash matches an existing asset${dupOf ? " (" + dupOf + ")" : ""}` });
  if (opts.wash) out.push({ tokenId, flagType: "BUYER_SELLER_LOOP", penaltyScore: 45,
    description: "A wallet pair traded this NFT 3+ times — wash-trading pattern" });
  return out;
}

async function main() {
  await connectDB();

  // clean only the demo collections (leave real Azuki / BAYC untouched)
  const existing = await Nft.find({ collectionName: { $in: COLLECTIONS } }).lean();
  const oldIds = existing.map(n => n.tokenId);
  await Promise.all([
    Nft.deleteMany({ collectionName: { $in: COLLECTIONS } }),
    Transaction.deleteMany({ collectionName: { $in: COLLECTIONS } }),
    RiskScore.deleteMany({ tokenId: { $in: oldIds } }),
    FraudFlag.deleteMany({ tokenId: { $in: oldIds } }),
  ]);

  const maxDoc = await Nft.findOne().sort({ tokenId: -1 }).lean();
  let uid = (maxDoc ? maxDoc.tokenId : 0) + 1;

  // pull real images from OTHER older collections (via Alchemy) so demo art is distinct from Azuki/BAYC
  const imgPool = {};
  for (const c of COLLECTIONS) {
    imgPool[c] = await fetchNfts(CONTRACTS[c], 6);
    console.log(`  ${c}: ${imgPool[c].length} images sourced`);
  }
  const imgByName = {}, colCount = {};

  const nftDocs = [], txDocs = [], riskDocs = [], flagDocs = [];
  const dupHash = {}; // shared imageHash for duplicate pairs

  SPEC.forEach(([collection, realId, status, price, opts], idx) => {
    const tokenId = uid++;
    const key = `${collection}#${realId}`;
    const owner = POOL[idx % POOL.length];
    const creator = POOL[(idx + 2) % POOL.length];

    // hashes reflect the authenticity story
    const metaHash = sha(key);
    const offChain = status === "Tampered" ? sha("tampered-" + key) : metaHash; // mismatch = tampered
    let imageHash = crypto.createHash("sha256").update("img-" + key).digest("hex");
    if (status === "Duplicate" && opts.dupOf) {
      imageHash = dupHash[opts.dupOf] || (dupHash[opts.dupOf] = crypto.createHash("sha256").update("img-" + opts.dupOf).digest("hex"));
    }
    if (dupHash[key] === undefined) dupHash[key] = imageHash;

    const name = `${collection} #${realId}`;
    const pool = imgPool[collection] || [];
    const ci = (colCount[collection] = (colCount[collection] || 0) + 1) - 1;
    // a duplicate reuses the ORIGINAL's picture + traits (the copy-mint); others take a distinct one
    const src = (opts.dupOf && imgByName[opts.dupOf]) ? imgByName[opts.dupOf]
              : (pool.length ? pool[ci % pool.length] : { image: "", traits: {} });
    imgByName[name] = src;
    const image = src.image;
    const traits = (src.traits && Object.keys(src.traits).length)
      ? { Collection: collection, Edition: `#${realId}`, ...src.traits }
      : { Collection: collection, Edition: `#${realId}`, Tier: ["Common", "Rare", "Epic"][realId % 3] };

    nftDocs.push({
      tokenId, name, collectionName: collection,
      description: `${collection} demo token #${realId} — seeded to exercise the "${status}" authenticity path.`,
      image,
      tokenURI: `ipfs://nftguard-demo/${collection.replace(/\s/g, "")}/${realId}`,
      contractAddress: "0xDE300000000000000000000000000000000000" + String(idx % 100).padStart(2, "0"),
      metadataHash: metaHash, offChainMetadataHash: offChain, imageHash,
      authenticityStatus: status,
      erc721Compliant: status !== "NonCompliant",
      creatorAddress: creator, ownerAddress: owner,
      listed: status !== "Unverified", // unverified assets aren't listed for sale
      priceEth: price,
      traits,
    });

    // transactions: MINT + a few SALEs (wash = ping-pong loop between two wallets)
    txDocs.push({ tokenId, collectionName: collection, txType: "MINT",
      senderAddress: "0x0000000000000000000000000000000000000000", recipientAddress: creator,
      priceEth: 0, txHash: "0xmint" + sha(key).slice(2, 58), timestamp: daysAgo(40 - idx), simulated: true });

    if (opts.wash) {
      const a = randHex(), b = randHex(); let p = price * 0.5;
      for (let i = 0; i < 4; i++) {
        txDocs.push({ tokenId, collectionName: collection, txType: "SALE",
          senderAddress: i % 2 ? a : b, recipientAddress: i % 2 ? b : a,
          priceEth: +p.toFixed(3), txHash: "0xsim" + sha(key + i).slice(2, 58),
          timestamp: daysAgo(12 - i * 2.5), simulated: true });
        p *= 1.5;
      }
    } else if (status !== "Unverified") {
      let p = price * 0.7;
      for (let i = 0; i < 2; i++) {
        txDocs.push({ tokenId, collectionName: collection, txType: "SALE",
          senderAddress: randHex(), recipientAddress: randHex(),
          priceEth: +p.toFixed(3), txHash: "0xsim" + sha(key + "s" + i).slice(2, 58),
          timestamp: daysAgo(9 - i * 3), simulated: true });
        p = price;
      }
    }

    if (status !== "Unverified") {
      const r = riskFor(status, opts);
      riskDocs.push(riskDoc(tokenId, r.auth, r.fraud, r.price));
      flagsFor(tokenId, status, opts, opts.dupOf).forEach(f => flagDocs.push(f));
    }
  });

  // ===== demo wash-trading RING: 5 wallets cycling NFTs among themselves (marketplace data) =====
  const RING = ["ring-a", "ring-b", "ring-c", "ring-d", "ring-e"].map(s => "0x" + crypto.createHash("sha256").update(s).digest("hex").slice(0, 40));
  const RING_COL = "Vortex Ring";
  const ringPool = (imgPool["Vortex Ring"] || []).concat(imgPool["Meta Beasts"] || []);
  const cycle = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [1, 0], [2, 1], [0, 2]];
  for (let n = 0; n < 3; n++) {
    const tokenId = uid++;
    const src = ringPool[n % (ringPool.length || 1)] || { image: "", traits: {} };
    nftDocs.push({
      tokenId, name: `${RING_COL} #${101 + n}`, collectionName: RING_COL,
      description: `${RING_COL} demo token — part of a seeded wash-trading ring inside this marketplace.`,
      image: src.image || "", tokenURI: `ipfs://nftguard-demo/vortex/${101 + n}`,
      contractAddress: "0xDE31000000000000000000000000000000000000",
      metadataHash: sha("ring" + n), offChainMetadataHash: sha("ring" + n),
      imageHash: crypto.createHash("sha256").update("ringimg" + n).digest("hex"),
      authenticityStatus: "Verified", erc721Compliant: true,
      creatorAddress: RING[0], ownerAddress: RING[cycle[cycle.length - 1][1]],
      listed: true, priceEth: +(0.6 + n * 0.25).toFixed(2),
      traits: (src.traits && Object.keys(src.traits).length) ? { Collection: RING_COL, ...src.traits } : { Collection: RING_COL, Edition: `#${101 + n}` },
    });
    txDocs.push({ tokenId, collectionName: RING_COL, txType: "MINT",
      senderAddress: "0x0000000000000000000000000000000000000000", recipientAddress: RING[0],
      priceEth: 0, txHash: "0xmintring" + sha("ring" + n).slice(2, 50), timestamp: daysAgo(30), simulated: true });
    let p = 0.5;
    cycle.forEach((pair, i) => {
      txDocs.push({ tokenId, collectionName: RING_COL, txType: "SALE",
        senderAddress: RING[pair[0]], recipientAddress: RING[pair[1]],
        priceEth: +p.toFixed(3), txHash: "0xring" + n + "x" + i + sha("r" + n + i).slice(2, 42),
        timestamp: daysAgo(14 - i * 1.5), simulated: true });
      p *= 1.3;
    });
    riskDocs.push(riskDoc(tokenId, 40, 100, 70));
    flagDocs.push({ tokenId, flagType: "BUYER_SELLER_LOOP", penaltyScore: 45,
      description: "This NFT was cycled through a ring of wallets — wash-trading pattern" });
  }

  await Nft.insertMany(nftDocs);
  await Transaction.insertMany(txDocs);
  if (riskDocs.length) await RiskScore.insertMany(riskDocs);
  if (flagDocs.length) await FraudFlag.insertMany(flagDocs);

  const byStatus = {};
  nftDocs.forEach(n => (byStatus[n.authenticityStatus] = (byStatus[n.authenticityStatus] || 0) + 1));
  console.log(`Seeded ${nftDocs.length} demo NFTs across ${COLLECTIONS.length} collections.`);
  console.log("Authenticity spread:", JSON.stringify(byStatus));
  console.log(`Transactions: ${txDocs.length} · risk scores: ${riskDocs.length} · fraud flags: ${flagDocs.length}`);
  console.log("Done. Real Azuki / BAYC data left untouched. Refresh the marketplace.");
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
