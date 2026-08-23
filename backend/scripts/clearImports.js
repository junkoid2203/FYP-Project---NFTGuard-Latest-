/**
 * clearImports.js — remove every NFT imported from mainnet (external: true),
 * so the "Test a real on-chain NFT" demo starts from a clean slate.
 *
 * Run:  npm run clear-imports
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Nft = require("../models/Nft");
const Transaction = require("../models/Transaction");
const RiskScore = require("../models/RiskScore");
const FraudFlag = require("../models/FraudFlag");

(async () => {
  await connectDB();
  const imported = await Nft.find({ external: true }).select("tokenId name").lean();
  if (!imported.length) { console.log("No imported NFTs to remove."); await mongoose.disconnect(); return; }
  const ids = imported.map(n => n.tokenId);
  await Promise.all([
    Nft.deleteMany({ tokenId: { $in: ids } }),
    Transaction.deleteMany({ tokenId: { $in: ids } }),
    RiskScore.deleteMany({ tokenId: { $in: ids } }),
    FraudFlag.deleteMany({ tokenId: { $in: ids } }),
  ]);
  imported.forEach(n => console.log(`  removed #${n.tokenId}  ${n.name}`));
  console.log(`\n${imported.length} imported NFT(s) cleared.`);
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
