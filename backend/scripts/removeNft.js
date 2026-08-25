/**
 * removeNft.js — delete NFTs from the marketplace database, with everything attached
 * to them (transactions, risk score, fraud flags, offers). Without removing those too
 * the token disappears but its trades keep feeding the price statistics and wash-ring.
 *
 * Usage:
 *   npm run remove -- 55 56                 delete by token id
 *   npm run remove -- --name "CryptoPunks"  delete every NFT whose name matches
 *   npm run remove -- --imported            delete every NFT imported from a chain
 *   npm run remove -- 55 --dry              show what would go, delete nothing
 *
 * Note: this only removes the marketplace RECORD. A token minted on Sepolia still exists
 * on the blockchain — nothing can delete that.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Nft = require("../models/Nft");
const Transaction = require("../models/Transaction");
const RiskScore = require("../models/RiskScore");
const FraudFlag = require("../models/FraudFlag");
const Offer = require("../models/Offer");
const { computeUnifiedRisk } = require("../services/riskScoreEngine");

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");
  const ids = argv.filter(a => /^\d+$/.test(a)).map(Number);
  const nameIdx = argv.indexOf("--name");
  const name = nameIdx > -1 ? argv[nameIdx + 1] : null;
  const imported = argv.includes("--imported");

  if (!ids.length && !name && !imported) {
    console.log("Nothing selected.\n");
    console.log("  npm run remove -- 55 56");
    console.log('  npm run remove -- --name "CryptoPunks"');
    console.log("  npm run remove -- --imported");
    console.log("  add --dry to preview\n");
    process.exit(1);
  }

  await connectDB();

  const q = { $or: [] };
  if (ids.length) q.$or.push({ tokenId: { $in: ids } });
  if (name) q.$or.push({ name: new RegExp(name, "i") });
  if (imported) q.$or.push({ external: true });

  const targets = await Nft.find(q).select("tokenId name collectionName onChainTokenId external").lean();
  if (!targets.length) { console.log("No NFTs matched."); await mongoose.disconnect(); return; }

  console.log(`${dry ? "WOULD REMOVE" : "REMOVING"} ${targets.length} NFT(s):\n`);
  const tokenIds = targets.map(t => t.tokenId);
  for (const t of targets) {
    const [tx, fl, of_] = await Promise.all([
      Transaction.countDocuments({ tokenId: t.tokenId }),
      FraudFlag.countDocuments({ tokenId: t.tokenId }),
      Offer.countDocuments({ tokenId: t.tokenId }),
    ]);
    console.log(`  #${String(t.tokenId).padStart(3)}  ${(t.name || "?").padEnd(26)} ${t.collectionName}`);
    console.log(`        ${tx} transaction(s) · ${fl} flag(s) · ${of_} offer(s)`
      + (t.onChainTokenId != null ? `  [on-chain token #${t.onChainTokenId} — stays on Sepolia]` : ""));
  }

  if (dry) { console.log("\n--dry: nothing deleted."); await mongoose.disconnect(); return; }

  await Promise.all([
    Nft.deleteMany({ tokenId: { $in: tokenIds } }),
    Transaction.deleteMany({ tokenId: { $in: tokenIds } }),
    RiskScore.deleteMany({ tokenId: { $in: tokenIds } }),
    FraudFlag.deleteMany({ tokenId: { $in: tokenIds } }),
    Offer.deleteMany({ tokenId: { $in: tokenIds } }),
  ]);

  // A deleted token may have been another NFT's duplicate twin, or part of a collection's
  // price sample, so re-score whatever is left rather than leaving stale verdicts behind.
  const rest = await Nft.find().select("tokenId").lean();
  for (const n of rest) { try { await computeUnifiedRisk(n.tokenId); } catch (_) {} }

  console.log(`\nDone. ${await Nft.countDocuments()} NFTs remain (all re-scored).`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
