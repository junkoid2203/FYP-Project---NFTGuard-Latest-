/**
 * routes/api.js — REST API endpoints (report Fig 4.1 "API Gateway/REST Endpoints")
 *
 *  GET  /api/health                     server + mode status
 *  GET  /api/stats                      dashboard headline stats
 *  GET  /api/nfts                       browse + search/filter (FR 5.5)
 *  GET  /api/nfts/:tokenId              full detail (risk, flags, history)
 *  POST /api/mint                       mint (Sepolia or simulated)   FR 2.2
 *  POST /api/list                       list for sale                 FR 2.3
 *  POST /api/buy                        purchase                      FR 2.4/2.5
 *  GET  /api/transactions/:tokenId      transaction history           FR 2.6
 *  POST /api/verify/:tokenId            authenticity pipeline         FR 1.x
 *  POST /api/fraud/:tokenId             4-rule fraud analysis         FR 4.x
 *  GET  /api/price/:collectionName      collection stats + anomalies  FR 3.x
 *  GET  /api/risk/:tokenId              unified risk score            FR 5.x
 */
const express = require("express");
const router = express.Router();

const Nft = require("../models/Nft");
const Transaction = require("../models/Transaction");
const RiskScore = require("../models/RiskScore");
const FraudFlag = require("../models/FraudFlag");

const blockchain = require("../services/blockchain");
const { verifyNft, sha256OfMetadata } = require("../services/authVerifier");
const { runFraudAnalysis } = require("../services/fraudDetector");
const { analyzeCollection } = require("../services/priceAnalyzer");
const { computeUnifiedRisk } = require("../services/riskScoreEngine");
const { investigateWallet } = require("../services/walletInvestigator");
const { analyzeGraph } = require("../services/graphAnalyzer");

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// ---------------------------------------------------------------- health
router.get("/health", wrap(async (req, res) => {
  res.json({
    ok: true,
    mode: blockchain.isOnChainConfigured() ? "on-chain (Sepolia)" : "simulated",
    contract: process.env.CONTRACT_ADDRESS || null,
    time: new Date().toISOString(),
  });
}));

// ---------------------------------------------------------------- stats
router.get("/stats", wrap(async (req, res) => {
  const [nfts, txs, flags, scores] = await Promise.all([
    Nft.countDocuments(),
    Transaction.countDocuments(),
    FraudFlag.countDocuments(),
    RiskScore.find().lean(),
  ]);
  const high = scores.filter(s => s.riskLevel === "High").length;
  const verified = await Nft.countDocuments({ authenticityStatus: "Verified" });
  res.json({ totalNfts: nfts, totalTransactions: txs, totalFlags: flags, highRiskNfts: high, verifiedNfts: verified });
}));

// ---------------------------------------------------------------- browse (FR 5.5)
router.get("/nfts", wrap(async (req, res) => {
  const { collection, riskLevel, status, search } = req.query;
  const q = {};
  if (collection) q.collectionName = collection;
  if (status) q.authenticityStatus = status;
  if (search) q.name = { $regex: search, $options: "i" };

  let nfts = await Nft.find(q).sort({ tokenId: 1 }).lean();
  const scores = await RiskScore.find().lean();
  const byToken = Object.fromEntries(scores.map(s => [s.tokenId, s]));

  let out = nfts.map(n => ({ ...n, risk: byToken[n.tokenId] || null }));
  if (riskLevel) out = out.filter(n => n.risk && n.risk.riskLevel === riskLevel);
  res.json(out);
}));

// ---------------------------------------------------------------- detail
router.get("/nfts/:tokenId", wrap(async (req, res) => {
  const tokenId = Number(req.params.tokenId);
  const nft = await Nft.findOne({ tokenId }).lean();
  if (!nft) return res.status(404).json({ error: `NFT #${tokenId} not found` });
  const [risk, flags, txs] = await Promise.all([
    RiskScore.findOne({ tokenId }).lean(),
    FraudFlag.find({ tokenId }).sort({ detectedAt: -1 }).lean(),
    Transaction.find({ tokenId }).sort({ timestamp: 1 }).lean(),
  ]);
  res.json({ ...nft, risk, flags, transactions: txs });
}));

// ---------------------------------------------------------------- mint (FR 2.2)
router.post("/mint", wrap(async (req, res) => {
  const { name, description = "", image = "", collectionName = "NFTGuard Collection", walletAddress, priceEth = 0 } = req.body;
  if (!name || !walletAddress) return res.status(400).json({ error: "name and walletAddress are required" });

  const last = await Nft.findOne().sort({ tokenId: -1 }).lean();
  let tokenId = (last ? last.tokenId : 0) + 1;

  const metadata = { name, description, image, attributes: [] };
  const metaHash = sha256OfMetadata(metadata);
  const tokenURI = `ipfs://simulated/${metaHash.slice(2, 14)}`;

  const chain = await blockchain.mintOnChain(tokenURI, metaHash);
  if (chain.tokenId) tokenId = chain.tokenId; // trust on-chain id when real

  const nft = await Nft.create({
    tokenId, name, description, image, tokenURI,
    contractAddress: process.env.CONTRACT_ADDRESS || "0xSIMULATED",
    metadataHash: metaHash, offChainMetadataHash: metaHash,
    collectionName, creatorAddress: walletAddress, ownerAddress: walletAddress,
    listed: priceEth > 0, priceEth,
    erc721Compliant: true,
  });

  await Transaction.create({
    tokenId, collectionName, txType: "MINT",
    senderAddress: "0x0000000000000000000000000000000000000000",
    recipientAddress: walletAddress,
    priceEth: 0, txHash: chain.txHash, simulated: chain.simulated,
  });

  res.json({ ok: true, nft, txHash: chain.txHash, simulated: chain.simulated });
}));

// ---------------------------------------------------------------- list (FR 2.3)
router.post("/list", wrap(async (req, res) => {
  const { tokenId, priceEth } = req.body;
  const nft = await Nft.findOne({ tokenId });
  if (!nft) return res.status(404).json({ error: "NFT not found" });
  if (!priceEth || priceEth <= 0) return res.status(400).json({ error: "priceEth must be > 0" });

  const chain = await blockchain.listOnChain(tokenId, priceEth);
  nft.listed = true; nft.priceEth = priceEth;
  await nft.save();

  await Transaction.create({
    tokenId, collectionName: nft.collectionName, txType: "LIST",
    senderAddress: nft.ownerAddress, recipientAddress: nft.ownerAddress,
    priceEth, txHash: chain.txHash, simulated: chain.simulated,
  });
  res.json({ ok: true, txHash: chain.txHash, simulated: chain.simulated });
}));

// ---------------------------------------------------------------- buy (FR 2.4 / 2.5)
router.post("/buy", wrap(async (req, res) => {
  const { tokenId, buyerAddress } = req.body;
  const nft = await Nft.findOne({ tokenId });
  if (!nft) return res.status(404).json({ error: "NFT not found" });
  if (!nft.listed) return res.status(400).json({ error: "NFT is not listed for sale" });
  if (!buyerAddress) return res.status(400).json({ error: "buyerAddress is required" });

  const chain = await blockchain.buyOnChain(tokenId, nft.priceEth);
  const seller = nft.ownerAddress;
  nft.ownerAddress = buyerAddress;
  nft.listed = false;
  await nft.save();

  const tx = await Transaction.create({
    tokenId, collectionName: nft.collectionName, txType: "SALE",
    senderAddress: seller, recipientAddress: buyerAddress,
    priceEth: nft.priceEth, txHash: chain.txHash, simulated: chain.simulated,
  });

  res.json({ ok: true, transaction: tx, txHash: chain.txHash, simulated: chain.simulated });
}));

// ---------------------------------------------------------------- history (FR 2.6)
router.get("/transactions/:tokenId", wrap(async (req, res) => {
  const txs = await Transaction.find({ tokenId: Number(req.params.tokenId) }).sort({ timestamp: 1 }).lean();
  res.json(txs);
}));

// ---------------------------------------------------------------- verify (FR 1.x, Fig 4.3)
router.post("/verify/:tokenId", wrap(async (req, res) => {
  res.json(await verifyNft(Number(req.params.tokenId)));
}));

// ---------------------------------------------------------------- fraud (FR 4.x, Fig 4.12)
router.post("/fraud/:tokenId", wrap(async (req, res) => {
  res.json(await runFraudAnalysis(Number(req.params.tokenId)));
}));

// ---------------------------------------------------------------- price (FR 3.x, Fig 4.9)
router.get("/price/:collectionName", wrap(async (req, res) => {
  res.json(await analyzeCollection(req.params.collectionName));
}));

// ---------------------------------------------------------------- risk (FR 5.x, Fig 4.15)
router.get("/risk/:tokenId", wrap(async (req, res) => {
  res.json(await computeUnifiedRisk(Number(req.params.tokenId)));
}));

// ---------------------------------------------------------------- graph wash-trading analysis (live)
router.get("/graph", wrap(async (req, res) => {
  res.json(analyzeGraph());
}));

// ---------------------------------------------------------------- wallet investigator (live, any address)
router.get("/investigate/:address", wrap(async (req, res) => {
  const addr = String(req.params.address || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return res.status(400).json({ error: "Invalid wallet address (expected 0x + 40 hex characters)" });
  res.json(await investigateWallet(addr));
}));

module.exports = router;
