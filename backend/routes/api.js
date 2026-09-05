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
const Offer = require("../models/Offer");
const Blacklist = require("../models/Blacklist");

const blockchain = require("../services/blockchain");
const { verifyNft, sha256OfMetadata } = require("../services/authVerifier");
const { runFraudAnalysis } = require("../services/fraudDetector");
const { analyzeCollection } = require("../services/priceAnalyzer");
const { computeUnifiedRisk } = require("../services/riskScoreEngine");
const { investigateWallet } = require("../services/walletInvestigator");
const { analyzeMarketGraph } = require("../services/graphAnalyzer");
const { handleChat } = require("../services/chatAssistant");
const { importOnChainNft } = require("../services/onChainImporter");

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

/**
 * Marketplace-wide enforcement (server side — the frontend checks are only a UX
 * courtesy and can be bypassed by calling the API directly).
 *
 * A wallet banned for wash trading must not be able to mint, list, buy or make
 * offers, otherwise "banning" is cosmetic.
 */
async function blockedWallet(address) {
  const a = String(address || "").trim().toLowerCase();
  if (!a) return null;
  const banned = await Blacklist.findOne({ address: a }).lean();
  if (!banned) return null;
  return `Wallet ${a.slice(0, 6)}…${a.slice(-4)} is blacklisted for wash trading`
       + (banned.reason ? ` (${banned.reason})` : "")
       + " — minting, listing, buying and offers are disabled for this wallet.";
}

/**
 * After ownership changes, any Active offer made BY the new owner is meaningless —
 * you cannot bid on your own asset. Without this a buyer's own offer stayed live on
 * the NFT they had just bought, and they could "accept" their own bid.
 * Offers from other wallets survive on purpose: they are bids on the asset, and the
 * new owner may still want to accept one.
 */
async function cancelOwnOffers(tokenId, newOwner) {
  if (!newOwner) return 0;
  const r = await Offer.updateMany(
    { tokenId: Number(tokenId), status: "Active",
      fromAddress: { $regex: `^${String(newOwner).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } },
    { status: "Cancelled" }
  );
  return r.modifiedCount || 0;
}

/** Authenticity failures are not tradeable: NFTGuard blocks the sale outright. */
const UNSELLABLE = ["Tampered", "Duplicate", "NonCompliant"];
/** Only the recorded owner may act on a token. Returns an error string, or null. */
function notOwner(nft, walletAddress, action) {
  if (!walletAddress) return `A wallet address is required to ${action} this NFT`;
  if (String(nft.ownerAddress).toLowerCase() !== String(walletAddress).toLowerCase())
    return `Only the owner may ${action} this NFT`;
  return null;
}

function blockedAsset(nft) {
  if (!UNSELLABLE.includes(nft.authenticityStatus)) return null;
  const why = nft.authenticityStatus === "Tampered"
      ? "its metadata does not match its on-chain hash (possible fake)"
    : nft.authenticityStatus === "Duplicate"
      ? "its image matches another minted asset (likely copy-mint)"
      : "its contract failed the ERC-721/1155 standard check";
  return `#${nft.tokenId} is flagged ${nft.authenticityStatus} — ${why}. `
       + "NFTGuard blocks trading of assets that fail authenticity verification.";
}

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
  const { name, description = "", image = "", collectionName = "NFTGuard Collection", walletAddress, demoFlaw = "" } = req.body;
  if (!name || !walletAddress) return res.status(400).json({ error: "name and walletAddress are required" });

  const mintBan = await blockedWallet(walletAddress);
  if (mintBan) return res.status(403).json({ error: mintBan });

  const last = await Nft.findOne().sort({ tokenId: -1 }).lean();
  let tokenId = (last ? last.tokenId : 0) + 1;

  const metadata = { name, description, image, attributes: [] };
  const metaHash = sha256OfMetadata(metadata);
  const tokenURI = `ipfs://simulated/${metaHash.slice(2, 14)}`;

  const chain = await blockchain.mintOnChain(tokenURI, metaHash);
  if (chain.tokenId) tokenId = chain.tokenId; // trust on-chain id when real

  // Demo/testing hooks — a CLEAN mint is authentic by construction (off-chain hash
  // equals the on-chain anchor, compliant contract), so it will always verify as
  // "Verified". To exercise the authenticity engine, a tester can request a flaw:
  //   tampered      -> off-chain metadata hash won't match the on-chain anchor  (=> Tampered)
  //   noncompliant  -> contract fails the ERC-721 interface check               (=> NonCompliant)
  const flaw = String(demoFlaw || "").toLowerCase();
  const offChainMetadataHash = flaw === "tampered"
    ? sha256OfMetadata({ ...metadata, __tampered: Date.now() })
    : metaHash;
  const erc721Compliant = flaw !== "noncompliant";

  const nft = await Nft.create({
    tokenId, name, description, image, tokenURI,
    contractAddress: process.env.CONTRACT_ADDRESS || "0xSIMULATED",
    metadataHash: metaHash, offChainMetadataHash,
    collectionName, creatorAddress: walletAddress, ownerAddress: walletAddress,
    listed: false, priceEth: 0,            // minting no longer lists — owner lists it afterwards
    erc721Compliant,
  });

  await Transaction.create({
    tokenId, collectionName, txType: "MINT",
    senderAddress: "0x0000000000000000000000000000000000000000",
    recipientAddress: walletAddress,
    priceEth: 0, txHash: chain.txHash, simulated: chain.simulated,
  });

  // Auto-run the verification + risk pipeline so a fresh mint gets a real
  // authenticity status (a clean mint -> "Verified") and a risk score right away.
  try { await computeUnifiedRisk(tokenId); } catch (e) { console.warn("[mint] risk pipeline:", e.message); }
  const fresh = await Nft.findOne({ tokenId }).lean();

  res.json({ ok: true, nft: fresh || nft, txHash: chain.txHash, simulated: chain.simulated });
}));

// ---------------------------------------------------------------- transfer (FR 2.5)
// Moving a token without a sale. The fraud rules already read TRANSFER records - Rule 3
// looks for a sender and recipient that match, and Rules 1 and 2 count transfers alongside
// sales - but nothing in the interface could create one, so those rules could only ever
// fire on seeded data. This endpoint closes that gap.
router.post("/transfer", wrap(async (req, res) => {
  const { tokenId, walletAddress, toAddress } = req.body || {};
  const nft = await Nft.findOne({ tokenId: Number(tokenId) });
  if (!nft) return res.status(404).json({ error: "NFT not found" });

  const ownerErr = notOwner(nft, walletAddress, "transfer");
  if (ownerErr) return res.status(403).json({ error: ownerErr });

  if (!/^0x[a-fA-F0-9]{40}$/.test(String(toAddress || "")))
    return res.status(400).json({ error: "Recipient must be a wallet address (0x followed by 40 hex characters)" });

  const senderBan = await blockedWallet(walletAddress);
  if (senderBan) return res.status(403).json({ error: senderBan });
  const recipientBan = await blockedWallet(toAddress);
  if (recipientBan) return res.status(403).json({ error: "Recipient blocked — " + recipientBan });
  const assetBlocked = blockedAsset(nft);
  if (assetBlocked) return res.status(403).json({ error: assetBlocked });

  // A transfer to your own address is allowed on purpose. It is not a mistake to guard
  // against: it is precisely the behaviour Rule 3 exists to detect, and refusing it here
  // would leave that rule with no way to be exercised through the interface.
  const from = nft.ownerAddress;
  nft.ownerAddress = toAddress;
  nft.listed = false;            // a listing cannot outlive the owner who made it
  await nft.save();

  const tx = await Transaction.create({
    tokenId: nft.tokenId, collectionName: nft.collectionName, txType: "TRANSFER",
    senderAddress: from, recipientAddress: toAddress, priceEth: 0,
    txHash: "0xsim" + [...Array(60)].map(() => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join(""),
    simulated: true,
  });
  await cancelOwnOffers(nft.tokenId, toAddress);

  let risk = null;
  try { risk = await computeUnifiedRisk(nft.tokenId, { reverify: false }); }
  catch (e) { console.warn("[transfer] risk:", e.message); }

  res.json({ ok: true, transaction: tx, selfTransfer: String(from).toLowerCase() === String(toAddress).toLowerCase(),
             risk: risk && { unifiedScore: risk.unifiedScore, riskLevel: risk.riskLevel,
                             flags: (risk.flags || []).map(f => f.flagType) } });
}));

// ---------------------------------------------------------------- list (FR 2.3)
router.post("/list", wrap(async (req, res) => {
  const { tokenId, priceEth, walletAddress } = req.body;
  const nft = await Nft.findOne({ tokenId });
  if (!nft) return res.status(404).json({ error: "NFT not found" });
  if (!priceEth || priceEth <= 0) return res.status(400).json({ error: "priceEth must be > 0" });

  // Only the owner may list. The interface already hides the control for a token the
  // connected wallet does not own, but that is a convenience: the endpoint is still
  // reachable from a browser console, so ownership has to be checked here as well.
  const ownerErr = notOwner(nft, walletAddress, "list");
  if (ownerErr) return res.status(403).json({ error: ownerErr });

  const listBan = await blockedWallet(nft.ownerAddress);
  if (listBan) return res.status(403).json({ error: listBan });
  const listBlocked = blockedAsset(nft);
  if (listBlocked) return res.status(403).json({ error: listBlocked });

  const chain = await blockchain.listOnChain(tokenId, priceEth);
  nft.listed = true; nft.priceEth = priceEth;
  await nft.save();

  await Transaction.create({
    tokenId, collectionName: nft.collectionName, txType: "LIST",
    senderAddress: nft.ownerAddress, recipientAddress: nft.ownerAddress,
    priceEth, txHash: chain.txHash, simulated: chain.simulated,
  });

  // Re-score immediately: the asking price feeds the price-anomaly indicator, so
  // listing (or re-pricing) far outside the collection's range must move the risk
  // score right away — not only after someone has already bought at that price.
  let risk = null;
  try { risk = await computeUnifiedRisk(tokenId, { reverify: false }); } catch (e) { console.warn("[list] risk:", e.message); }
  res.json({ ok: true, txHash: chain.txHash, simulated: chain.simulated,
             risk: risk && { unifiedScore: risk.unifiedScore, riskLevel: risk.riskLevel, priceRisk: risk.breakdown.priceRisk } });
}));

// ---------------------------------------------------------------- buy (FR 2.4 / 2.5)
router.post("/buy", wrap(async (req, res) => {
  const { tokenId, buyerAddress } = req.body;
  const nft = await Nft.findOne({ tokenId });
  if (!nft) return res.status(404).json({ error: "NFT not found" });
  if (!nft.listed) return res.status(400).json({ error: "NFT is not listed for sale" });
  if (!buyerAddress) return res.status(400).json({ error: "buyerAddress is required" });

  // Buyer banned, seller banned, or the asset itself failed authenticity → no sale.
  // You cannot buy your own NFT. Without this the marketplace could MANUFACTURE a
  // self-transfer — the very pattern the fraud engine treats as a strong wash-trading
  // signal — from an ordinary double-click or a stale modal.
  if (String(nft.ownerAddress).toLowerCase() === String(buyerAddress).toLowerCase())
    return res.status(400).json({ error: "You already own this NFT — a wallet cannot buy from itself" });

  const buyerBan = await blockedWallet(buyerAddress);
  if (buyerBan) return res.status(403).json({ error: buyerBan });
  const sellerBan = await blockedWallet(nft.ownerAddress);
  if (sellerBan) return res.status(403).json({ error: "Seller blocked — " + sellerBan });
  const assetBlocked = blockedAsset(nft);
  if (assetBlocked) return res.status(403).json({ error: assetBlocked });

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
  await cancelOwnOffers(tokenId, buyerAddress);

  // A completed sale is exactly what the price and fraud rules analyse, so re-score now.
  // Without this the new SALE sat unanalysed until some later action (a re-list) happened
  // to trigger a recompute, so a buyer saw no PRICE_ANOMALY on a sale they had just made.
  let risk = null;
  try { risk = await computeUnifiedRisk(tokenId, { reverify: false }); }
  catch (e) { console.warn("[buy] risk:", e.message); }

  res.json({ ok: true, transaction: tx, txHash: chain.txHash, simulated: chain.simulated,
             risk: risk && { unifiedScore: risk.unifiedScore, riskLevel: risk.riskLevel,
                             flags: (risk.flags || []).map(f => f.flagType) } });
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

// ------------------------------------- import a REAL mainnet NFT + verify it
// Demonstrates genuine detection on live data: Layer 1 makes a real ERC-165 call,
// Layer 3 hashes the real artwork (import the same token twice -> Duplicate).
router.post("/import-onchain", wrap(async (req, res) => {
  const { contract, tokenId } = req.body || {};
  if (!contract || tokenId === undefined || tokenId === "") {
    return res.status(400).json({ error: "contract and tokenId are required" });
  }
  const { nft, links } = await importOnChainNft(String(contract).trim(), String(tokenId).trim());
  const verification = await verifyNft(nft.tokenId);
  try { await computeUnifiedRisk(nft.tokenId, { reverify: false }); } catch (_) {}
  const fresh = await Nft.findOne({ tokenId: nft.tokenId }).lean();
  res.json({ ok: true, nft: fresh, verification, links });
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

// ---------------------------------------------------------------- wallet investigator (live, any address)
router.get("/investigate/:address", wrap(async (req, res) => {
  const addr = String(req.params.address || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return res.status(400).json({ error: "Invalid wallet address (expected 0x + 40 hex characters)" });
  // blacklisted wallets are blocked instantly (no need to hit the chain)
  const banned = await Blacklist.findOne({ address: addr.toLowerCase() }).lean();
  if (banned) return res.json({ address: addr, blacklisted: true, riskScore: 100, riskLevel: "High",
    totalTransfers: 0, roundTrips: 0, topCounterparties: [],
    reasons: ["Wallet is blacklisted by the marketplace" + (banned.reason ? ": " + banned.reason : "")] });
  res.json(await investigateWallet(addr));
}));

// ---------------------------------------------------------------- activity feed (recent tx across all tokens)
router.get("/activity", wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 40, 100);
  const txs = await Transaction.find().sort({ timestamp: -1 }).limit(limit).lean();
  const ids = [...new Set(txs.map(t => t.tokenId))];
  const nfts = await Nft.find({ tokenId: { $in: ids } }).lean();
  const scores = await RiskScore.find({ tokenId: { $in: ids } }).lean();
  const infoBy = Object.fromEntries(nfts.map(n => [n.tokenId, n]));
  const riskBy = Object.fromEntries(scores.map(s => [s.tokenId, s]));
  res.json(txs.map(t => {
    const n = infoBy[t.tokenId] || {};
    const r = riskBy[t.tokenId];
    return {
      tokenId: t.tokenId,
      name: n.name || `Token #${t.tokenId}`,
      image: n.image || "",
      collection: n.collectionName || t.collectionName || "—",
      event: t.txType,
      from: t.senderAddress,
      to: t.recipientAddress,
      priceEth: t.priceEth,
      timestamp: t.timestamp,
      txHash: t.txHash,
      riskLevel: r ? r.riskLevel : null,
    };
  }));
}));

// ---------------------------------------------------------------- AI chat assistant
router.post("/chat", wrap(async (req, res) => {
  const messages = (req.body && req.body.messages) || [];
  // Best-effort live snapshot for the assistant — wrapped so it never blocks chat
  let context = {};
  try {
    const [nfts, scores, totalFlags] = await Promise.all([
      Nft.find().sort({ tokenId: 1 }).lean(),
      RiskScore.find().lean(),
      FraudFlag.countDocuments(),
    ]);
    const byTok = Object.fromEntries(scores.map(s => [s.tokenId, s]));
    const nftCtx = nfts.map(n => ({
      id: n.tokenId, name: n.name, collection: n.collectionName,
      status: n.authenticityStatus,
      risk: byTok[n.tokenId] ? byTok[n.tokenId].riskLevel : "—",
      score: byTok[n.tokenId] ? byTok[n.tokenId].unifiedScore : null,
    }));
    context = {
      totalNfts: nfts.length,
      highRisk: nftCtx.filter(n => n.risk === "High").length,
      totalFlags,
      nfts: nftCtx,
    };
  } catch (e) {
    console.warn("[chat] context build failed:", e.message);
  }
  res.json(await handleChat(messages, context));
}));

// ---------------------------------------------------------------- offers (make offer on any NFT, listed or not)
router.get("/offers/:tokenId", wrap(async (req, res) => {
  const offers = await Offer.find({ tokenId: Number(req.params.tokenId) })
    .sort({ status: 1, priceEth: -1, createdAt: -1 }).lean();
  res.json(offers);
}));

router.post("/offers", wrap(async (req, res) => {
  const { tokenId, fromAddress, priceEth } = req.body || {};
  if (!tokenId || !fromAddress || !(Number(priceEth) > 0))
    return res.status(400).json({ error: "tokenId, fromAddress and priceEth (> 0) are required" });
  const nft = await Nft.findOne({ tokenId: Number(tokenId) });
  if (!nft) return res.status(404).json({ error: "NFT not found" });
  const offerBan = await blockedWallet(fromAddress);
  if (offerBan) return res.status(403).json({ error: offerBan });
  const offerBlocked = blockedAsset(nft);
  if (offerBlocked) return res.status(403).json({ error: offerBlocked });
  if (nft.ownerAddress && nft.ownerAddress.toLowerCase() === String(fromAddress).toLowerCase())
    return res.status(400).json({ error: "You already own this NFT" });
  // An offer is a bid to negotiate a LOWER price. Paying the asking price is what
  // "Buy now" is for, so an offer at/above the listing makes no sense — reject it.
  if (nft.listed && nft.priceEth > 0 && Number(priceEth) >= nft.priceEth)
    return res.status(400).json({ error: `Offer must be below the listed price (${nft.priceEth} ETH). To pay the asking price, use Buy now.` });
  const offer = await Offer.create({ tokenId: Number(tokenId), fromAddress, priceEth: Number(priceEth), status: "Active" });
  res.json({ ok: true, offer });
}));

// ---------------------------------------------------------------- cancel a listing (owner un-lists)
router.post("/unlist", wrap(async (req, res) => {
  const { tokenId, walletAddress } = req.body || {};
  const nft = await Nft.findOne({ tokenId: Number(tokenId) });
  if (!nft) return res.status(404).json({ error: "NFT not found" });

  const ownerErr = notOwner(nft, walletAddress, "cancel the listing of");
  if (ownerErr) return res.status(403).json({ error: ownerErr });

  nft.listed = false;
  await nft.save();
  // Delisting removes the anomalous asking price, so the listing flag must clear too.
  try { await computeUnifiedRisk(Number(tokenId), { reverify: false }); } catch (_) {}
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- offers received on a wallet's own NFTs (bell + profile)
router.get("/offers-received/:address", wrap(async (req, res) => {
  const addr = String(req.params.address || "").trim().toLowerCase();
  if (!addr) return res.json([]);
  const all = await Nft.find().select("tokenId name image priceEth listed ownerAddress").lean();
  const owned = all.filter(n => (n.ownerAddress || "").toLowerCase() === addr);
  const byTok = Object.fromEntries(owned.map(n => [n.tokenId, n]));
  const ids = owned.map(n => n.tokenId);
  if (!ids.length) return res.json([]);
  const offers = await Offer.find({ tokenId: { $in: ids }, status: "Active" }).sort({ createdAt: -1 }).lean();
  res.json(offers.map(o => ({ ...o, nft: byTok[o.tokenId] || null })));
}));

/**
 * Owner accepted a bid on an ON-CHAIN token. The contract has no acceptOffer(), so
 * acceptance is expressed as a real listForSale() at the agreed price (already signed
 * and mined by the owner's MetaMask). Ownership moves only when the bidder settles with
 * buy() — recorded via /record-buy — so our records never claim a transfer the chain
 * has not made.
 */
router.post("/offers/:offerId/accept-onchain", wrap(async (req, res) => {
  const { txHash } = req.body || {};
  if (!txHash) return res.status(400).json({ error: "txHash is required" });
  const offer = await Offer.findById(req.params.offerId).catch(() => null);
  if (!offer || offer.status !== "Active") return res.status(404).json({ error: "Offer not found or no longer active" });
  const nft = await Nft.findOne({ tokenId: offer.tokenId });
  if (!nft) return res.status(404).json({ error: "NFT not found" });
  if (String(nft.ownerAddress).toLowerCase() === String(offer.fromAddress).toLowerCase())
    return res.status(400).json({ error: "That bid came from the current owner" });

  nft.listed = true; nft.priceEth = offer.priceEth;
  await nft.save();
  await Transaction.create({
    tokenId: nft.tokenId, collectionName: nft.collectionName, txType: "LIST",
    senderAddress: nft.ownerAddress, recipientAddress: nft.ownerAddress,
    priceEth: offer.priceEth, txHash, simulated: false,
  });
  offer.status = "Accepted";
  await offer.save();
  // competing bids are declined, as they would be by an ordinary accept
  await Offer.updateMany({ tokenId: offer.tokenId, status: "Active", _id: { $ne: offer._id } }, { status: "Rejected" });
  let risk = null;
  try { risk = await computeUnifiedRisk(nft.tokenId, { reverify: false }); } catch (_) {}
  res.json({ ok: true, txHash, listedAt: offer.priceEth, awaitingBuyer: offer.fromAddress,
             risk: risk && { unifiedScore: risk.unifiedScore, riskLevel: risk.riskLevel } });
}));

/** Owner declines a bid. Only the current owner of the token may reject it. */
router.post("/offers/:offerId/reject", wrap(async (req, res) => {
  const offer = await Offer.findById(req.params.offerId).catch(() => null);
  if (!offer || offer.status !== "Active") return res.status(404).json({ error: "Offer not found or no longer active" });
  const nft = await Nft.findOne({ tokenId: offer.tokenId }).lean();
  if (!nft) return res.status(404).json({ error: "NFT not found" });
  const by = String(req.body?.ownerAddress || "").toLowerCase();
  if (by && String(nft.ownerAddress).toLowerCase() !== by)
    return res.status(403).json({ error: "Only the current owner can reject an offer" });
  offer.status = "Rejected";
  await offer.save();
  res.json({ ok: true, offerId: String(offer._id), status: offer.status });
}));

router.post("/offers/:offerId/accept", wrap(async (req, res) => {
  const offer = await Offer.findById(req.params.offerId).catch(() => null);
  if (!offer || offer.status !== "Active") return res.status(404).json({ error: "Offer not found or no longer active" });
  const nft = await Nft.findOne({ tokenId: offer.tokenId });
  if (!nft) return res.status(404).json({ error: "NFT not found" });

  // Defence in depth: cancelOwnOffers() should already have retired any bid from the
  // current owner, but if a stale one survives, accepting it would write a sale from a
  // wallet to ITSELF — fabricating the self-transfer the fraud engine is meant to detect.
  if (String(nft.ownerAddress).toLowerCase() === String(offer.fromAddress).toLowerCase()) {
    offer.status = "Cancelled";
    await offer.save();
    return res.status(400).json({ error: "That bid came from the current owner — cancelled instead of accepted" });
  }

  const seller = nft.ownerAddress;
  const chain = await blockchain.buyOnChain(offer.tokenId, offer.priceEth);
  nft.ownerAddress = offer.fromAddress;
  nft.listed = false;
  await nft.save();

  await Transaction.create({
    tokenId: offer.tokenId, collectionName: nft.collectionName, txType: "SALE",
    senderAddress: seller, recipientAddress: offer.fromAddress,
    priceEth: offer.priceEth, txHash: chain.txHash, simulated: chain.simulated,
  });
  offer.status = "Accepted";
  await offer.save();
  await cancelOwnOffers(offer.tokenId, offer.fromAddress);
  await Offer.updateMany({ tokenId: offer.tokenId, status: "Active", _id: { $ne: offer._id } }, { status: "Rejected" });

  res.json({ ok: true, txHash: chain.txHash, simulated: chain.simulated });
}));

// ---------------------------------------------------------------- record an on-chain mint (signed by the user's MetaMask on the frontend)
router.post("/record-mint", wrap(async (req, res) => {
  const { name, image = "", priceEth = 0, walletAddress, onChainTokenId, txHash, metadataHash = "", tokenURI = "" } = req.body || {};
  if (!name || !walletAddress || !txHash) return res.status(400).json({ error: "name, walletAddress and txHash are required" });

  // The on-chain mint path was unguarded, so a blacklisted wallet could still mint by
  // signing with MetaMask. The chain itself cannot be stopped, but the marketplace must
  // refuse to index the result — otherwise a banned wallet still gets a listed NFT.
  const mintBan = await blockedWallet(walletAddress);
  if (mintBan) return res.status(403).json({ error: mintBan });

  const last = await Nft.findOne().sort({ tokenId: -1 }).lean();
  const tokenId = (last ? last.tokenId : 0) + 1; // app-internal id (real on-chain id kept in traits)

  const nft = await Nft.create({
    tokenId, name, image, tokenURI,
    contractAddress: process.env.CONTRACT_ADDRESS || "",
    metadataHash, offChainMetadataHash: metadataHash,
    collectionName: "NFTGuard Collection",
    creatorAddress: walletAddress, ownerAddress: walletAddress,
    listed: Number(priceEth) > 0, priceEth: Number(priceEth) || 0,
    erc721Compliant: true, authenticityStatus: "Verified",
    onChainTokenId: onChainTokenId != null ? Number(onChainTokenId) : null,
    traits: { "On-chain token": "#" + (onChainTokenId != null ? onChainTokenId : "?"), Network: "Sepolia", Tx: txHash },
  });
  await Transaction.create({
    tokenId, collectionName: "NFTGuard Collection", txType: "MINT",
    senderAddress: "0x0000000000000000000000000000000000000000", recipientAddress: walletAddress,
    priceEth: 0, txHash, simulated: false,
  });
  try { await computeUnifiedRisk(tokenId); } catch (e) { console.warn("[record-mint] risk:", e.message); }
  const fresh = await Nft.findOne({ tokenId }).lean();
  res.json({ ok: true, nft: fresh || nft });
}));

/**
 * record-list / record-buy — persist a CONFIRMED on-chain action.
 *
 * The transaction is signed by the user's own MetaMask in the browser and is already
 * mined on Sepolia by the time we get here; these endpoints only mirror it into MongoDB
 * so the fraud rules, price analytics and risk score can see it. Without this an
 * on-chain trade would be invisible to the detection engine.
 */
router.post("/record-list", wrap(async (req, res) => {
  const { tokenId, priceEth, txHash } = req.body || {};
  if (!tokenId || !(Number(priceEth) > 0) || !txHash)
    return res.status(400).json({ error: "tokenId, priceEth (> 0) and txHash are required" });
  const nft = await Nft.findOne({ tokenId: Number(tokenId) });
  if (!nft) return res.status(404).json({ error: "NFT not found" });

  const ban = await blockedWallet(nft.ownerAddress);
  if (ban) return res.status(403).json({ error: ban });
  const blocked = blockedAsset(nft);
  if (blocked) return res.status(403).json({ error: blocked });

  nft.listed = true; nft.priceEth = Number(priceEth);
  await nft.save();
  await Transaction.create({
    tokenId: nft.tokenId, collectionName: nft.collectionName, txType: "LIST",
    senderAddress: nft.ownerAddress, recipientAddress: nft.ownerAddress,
    priceEth: Number(priceEth), txHash, simulated: false,
  });
  let risk = null;
  try { risk = await computeUnifiedRisk(nft.tokenId, { reverify: false }); } catch (_) {}
  res.json({ ok: true, txHash, risk: risk && { unifiedScore: risk.unifiedScore, riskLevel: risk.riskLevel } });
}));

router.post("/record-buy", wrap(async (req, res) => {
  const { tokenId, buyerAddress, priceEth, txHash } = req.body || {};
  if (!tokenId || !buyerAddress || !txHash)
    return res.status(400).json({ error: "tokenId, buyerAddress and txHash are required" });
  const nft = await Nft.findOne({ tokenId: Number(tokenId) });
  if (!nft) return res.status(404).json({ error: "NFT not found" });

  if (String(nft.ownerAddress).toLowerCase() === String(buyerAddress).toLowerCase())
    return res.status(400).json({ error: "You already own this NFT — a wallet cannot buy from itself" });

  const buyerBan = await blockedWallet(buyerAddress);
  if (buyerBan) return res.status(403).json({ error: buyerBan });
  const sellerBan = await blockedWallet(nft.ownerAddress);
  if (sellerBan) return res.status(403).json({ error: "Seller blocked — " + sellerBan });
  const blocked = blockedAsset(nft);
  if (blocked) return res.status(403).json({ error: blocked });

  const seller = nft.ownerAddress;
  const paid = Number(priceEth) > 0 ? Number(priceEth) : nft.priceEth;
  nft.ownerAddress = buyerAddress;
  nft.listed = false;
  await nft.save();
  await Transaction.create({
    tokenId: nft.tokenId, collectionName: nft.collectionName, txType: "SALE",
    senderAddress: seller, recipientAddress: buyerAddress,
    priceEth: paid, txHash, simulated: false,
  });
  await cancelOwnOffers(nft.tokenId, buyerAddress);
  let risk = null;
  try { risk = await computeUnifiedRisk(nft.tokenId, { reverify: false }); } catch (_) {}
  const flags = risk ? (risk.flags || []).map(f => f.flagType) : [];
  res.json({ ok: true, txHash, seller, buyer: buyerAddress, priceEth: paid,
             risk: risk && { unifiedScore: risk.unifiedScore, riskLevel: risk.riskLevel, flags } });
}));

// ---------------------------------------------------------------- marketplace wash-ring graph (this marketplace's own data)
router.get("/wash-graph", wrap(async (req, res) => {
  res.json(await analyzeMarketGraph());
}));

// ---------------------------------------------------------------- wallet blacklist (admin ban / un-ban)
router.get("/blacklist", wrap(async (req, res) => {
  res.json(await Blacklist.find().sort({ createdAt: -1 }).lean());
}));
router.post("/blacklist", wrap(async (req, res) => {
  const { address, reason = "", washScore = null } = req.body || {};
  const a = String(address || "").trim().toLowerCase();
  if (!a) return res.status(400).json({ error: "address is required" });
  const entry = await Blacklist.findOneAndUpdate({ address: a }, { address: a, reason, washScore }, { upsert: true, new: true });
  res.json({ ok: true, entry });
}));
router.delete("/blacklist/:address", wrap(async (req, res) => {
  await Blacklist.deleteOne({ address: String(req.params.address || "").trim().toLowerCase() });
  res.json({ ok: true });
}));

module.exports = router;
