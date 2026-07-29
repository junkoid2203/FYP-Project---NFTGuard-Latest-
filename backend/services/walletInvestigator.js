/**
 * walletInvestigator.js — live on-chain wash-trading analysis for ANY wallet.
 *
 * Pulls the wallet's real ERC-721/1155 transfer history from the Alchemy API
 * (alchemy_getAssetTransfers) and applies wash-trading heuristics:
 *   - self-transfers        (wallet sends an NFT to itself)
 *   - NFT round-trips       (sold then re-acquired the same token)
 *   - repeated wallet pairs (traded 3+ times with the same counterparty)
 * Returns a 0-100 wallet risk score + evidence. No database needed — this works
 * on any address the user pastes in.
 */
const fs = require("fs");
const path = require("path");

function alchemyKey() {
  for (const f of [path.join(__dirname, "..", "..", ".env"), path.join(__dirname, "..", ".env")]) {
    try {
      const m = fs.readFileSync(f, "utf8").match(/alchemy\.com\/v2\/([A-Za-z0-9_-]+)/);
      if (m) return m[1];
    } catch (_) {}
  }
  return null;
}

async function getTransfers(key, extra) {
  const params = {
    fromBlock: "0x0", toBlock: "latest",
    category: ["erc721", "erc1155"],
    withMetadata: false, excludeZeroValue: false,
    maxCount: "0x64", order: "desc", ...extra,
  };
  const res = await fetch(`https://eth-mainnet.g.alchemy.com/v2/${key}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [params] }),
  });
  if (!res.ok) throw new Error("Alchemy request failed (" + res.status + ")");
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result?.transfers || [];
}

async function investigateWallet(address) {
  const key = alchemyKey();
  if (!key) throw new Error("Alchemy key not configured");
  const addr = address.toLowerCase();

  const [out, incoming] = await Promise.all([
    getTransfers(key, { fromAddress: addr }),
    getTransfers(key, { toAddress: addr }),
  ]);

  // dedupe combined transfer list
  const seen = new Set();
  const transfers = [...out, ...incoming].filter(t => {
    const k = t.uniqueId || (t.hash + "/" + t.tokenId);
    if (seen.has(k)) return false; seen.add(k); return true;
  });

  // --- heuristics ---
  const selfTransfers = transfers.filter(t =>
    (t.from || "").toLowerCase() === addr && (t.to || "").toLowerCase() === addr);

  const nftKey = t => (t.rawContract?.address || "") + "/" + t.tokenId;
  const outSet = new Set(out.map(nftKey));
  const inSet = new Set(incoming.map(nftKey));
  const roundTrips = [...outSet].filter(k => inSet.has(k));

  const counterparties = {};
  transfers.forEach(t => {
    const cp = ((t.from || "").toLowerCase() === addr ? t.to : t.from || "").toLowerCase();
    if (cp && cp !== addr) counterparties[cp] = (counterparties[cp] || 0) + 1;
  });
  const topCounterparties = Object.entries(counterparties)
    .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([wallet, trades]) => ({ wallet, trades }));
  const repeatedPairs = topCounterparties.filter(c => c.trades >= 3);

  // --- score ---
  let score = 0; const reasons = [];
  if (selfTransfers.length) { score += Math.min(55, 30 + selfTransfers.length * 5); reasons.push(`${selfTransfers.length} self-transfer(s)`); }
  if (roundTrips.length)    { score += Math.min(45, roundTrips.length * 8);          reasons.push(`${roundTrips.length} NFT round-trip(s) (sold then re-acquired)`); }
  if (repeatedPairs.length) { score += Math.min(35, repeatedPairs.length * 8);       reasons.push(`${repeatedPairs.length} wallet pair(s) traded 3+ times (loop)`); }
  score = Math.min(100, score);
  const riskLevel = score >= 70 ? "High" : score >= 40 ? "Medium" : "Low";

  return {
    address,
    totalTransfers: transfers.length,
    outgoing: out.length, incoming: incoming.length,
    selfTransfers: selfTransfers.length,
    roundTrips: roundTrips.length,
    topCounterparties, riskScore: score, riskLevel, reasons,
    sample: transfers.slice(0, 14).map(t => ({
      hash: t.hash,
      direction: (t.from || "").toLowerCase() === addr ? "OUT" : "IN",
      from: t.from, to: t.to,
      collection: t.asset || (t.rawContract?.address || "").slice(0, 10),
      tokenId: t.tokenId,
    })),
  };
}

module.exports = { investigateWallet };
