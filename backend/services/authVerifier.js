/**
 * authVerifier.js — NFT Authenticity Verification Module (Sprint 1)
 *
 * Three-layer pipeline exactly as specified in report Section 3.1.2:
 *   Layer 1: smart contract standard compliance (ERC-721 / ERC-1155 via ERC-165)
 *   Layer 2: metadata integrity — SHA-256(off-chain IPFS metadata) vs on-chain hash
 *   Layer 3: duplicate / copy-mint detection — perceptual hash (pHash) registry
 *
 * Output: authenticityStatus + authRisk (0-100) consumed by RiskScoreEngine.
 */
const crypto = require("crypto");
const axios = require("axios");
const Jimp = require("jimp");
const Nft = require("../models/Nft");
const FraudFlag = require("../models/FraudFlag");
const blockchain = require("./blockchain");
const thresholds = require("../config/thresholds.json");

/** Canonical SHA-256 of a metadata object (FR 1.3). */
function sha256OfMetadata(metadataObj) {
  const canonical = typeof metadataObj === "string" ? metadataObj : JSON.stringify(metadataObj);
  return "0x" + crypto.createHash("sha256").update(canonical).digest("hex");
}

/** Resolve ipfs:// URIs through the configured Pinata gateway (FR 1.2). */
function resolveIpfsUri(uri) {
  if (!uri) return null;
  const gateway = process.env.PINATA_GATEWAY || "https://gateway.pinata.cloud/ipfs/";
  if (uri.startsWith("ipfs://")) return gateway + uri.replace("ipfs://", "");
  return uri;
}

/** Fetch off-chain metadata JSON from IPFS / HTTP (FR 1.2). */
async function fetchMetadata(tokenURI) {
  const url = resolveIpfsUri(tokenURI);
  if (!url) return null;
  const res = await axios.get(url, { timeout: 10000 });
  return res.data;
}

/**
 * Layer 3 — perceptual hash of the NFT image (FR 1.4).
 * Jimp's built-in pHash; compareHashes() returns a normalised distance in
 * [0,1] where 0 = identical. Distance below the configured threshold flags
 * the pair as a potential duplicate / copy-mint.
 */
async function computeImagePHash(imageUrl) {
  const url = resolveIpfsUri(imageUrl);
  if (!url) return null;
  try {
    const img = await Jimp.read(url);
    return img.hash(); // base-64 pHash string
  } catch (err) {
    return null; // unreadable image -> skip duplicate layer gracefully
  }
}

async function findDuplicates(tokenId, imageHash) {
  if (!imageHash) return [];
  const maxDist = thresholds.duplicateDetection.phashMaxDistance;
  const others = await Nft.find({ tokenId: { $ne: tokenId }, imageHash: { $nin: [null, ""] } })
    .select("tokenId name imageHash")
    .lean();
  const dupes = [];
  for (const o of others) {
    const dist = Jimp.compareHashes(imageHash, o.imageHash);
    if (dist <= maxDist) dupes.push({ tokenId: o.tokenId, name: o.name, distance: Number(dist.toFixed(4)) });
  }
  return dupes;
}

/**
 * Full verification pipeline for one token.
 * Mirrors sequence diagram Fig 4.3 step-by-step.
 */
async function verifyNft(tokenId) {
  const nft = await Nft.findOne({ tokenId });
  if (!nft) throw new Error(`NFT #${tokenId} not found`);

  // Clear this token's authenticity flags before re-deriving them. Previously the layers
  // only ever upserted, so a flag survived after its cause was gone — Cyber Relics #7 kept
  // a DUPLICATE_ASSET flag while verifying as Verified, because its twin's perceptual hash
  // had changed. The fraud and price analysers already clear theirs the same way.
  await FraudFlag.deleteMany({
    tokenId,
    flagType: { $in: ["METADATA_TAMPERED", "DUPLICATE_ASSET", "NON_COMPLIANT_CONTRACT"] },
  });

  const checks = [];
  let authRisk = 0;
  let status = "Verified";

  // ---- Layer 1: contract compliance (steps 3-6, Fig 4.3) ----
  // An imported mainnet token carries a REAL ERC-165 result observed at import
  // time (services/onChainImporter.js) — use it instead of the simulated flag.
  const compliance = (nft.external && nft.chainCompliance)
    ? { ...nft.chainCompliance, checked: true }
    : await blockchain.checkContractCompliance(nft.contractAddress);
  if (compliance.checked) {
    nft.erc721Compliant = Boolean(compliance.compliant);
    checks.push({
      layer: "Smart contract validation",
      pass: compliance.compliant,
      detail: (compliance.compliant
        ? `ERC-165 supportsInterface -> ERC-721: ${compliance.erc721}, ERC-1155: ${compliance.erc1155}`
        : compliance.reason || "Contract does not implement ERC-721 / ERC-1155")
        + (compliance.source ? ` [${compliance.source}]` : ""),
    });
    if (!compliance.compliant) {
      authRisk = 100; // authenticity is binary: untrusted contract => no trust
      status = "NonCompliant";
      await FraudFlag.findOneAndUpdate(
        { tokenId, flagType: "NON_COMPLIANT_CONTRACT" },
        { tokenId, flagType: "NON_COMPLIANT_CONTRACT", penaltyScore: 100,
          description: "Contract failed ERC-721/ERC-1155 interface check",
          evidence: compliance, detectedAt: new Date() },
        { upsert: true }
      );
    }
  } else {
    // Simulated mode: trust the stored flag from seed data if present
    const simulatedPass = nft.erc721Compliant !== false;
    checks.push({
      layer: "Smart contract validation",
      pass: simulatedPass,
      detail: `${compliance.reason} — using stored compliance flag (${simulatedPass ? "compliant" : "non-compliant"})`,
    });
    if (!simulatedPass) { authRisk = 100; status = "NonCompliant"; }
  }

  // ---- Layer 2: metadata integrity (steps 7-11, Fig 4.3) ----
  let offChainHash = nft.offChainMetadataHash;
  let onChainHash = nft.metadataHash;
  try {
    if (blockchain.isOnChainConfigured()) {
      const chainData = await blockchain.readTokenOnChain(tokenId);
      if (chainData) onChainHash = chainData.metadataHash;
      const metadata = await fetchMetadata(chainData ? chainData.tokenURI : nft.tokenURI);
      if (metadata) offChainHash = sha256OfMetadata(metadata);
    }
  } catch (err) {
    checks.push({ layer: "IPFS metadata fetch", pass: false, detail: `Fetch failed: ${err.message}` });
  }

  // Third-party mainnet contracts never stored an NFTGuard SHA-256 anchor, so there
  // is no baseline to compare against. Report that honestly as NOT APPLICABLE
  // instead of silently passing (or failing) the token.
  const noAnchor = Boolean(nft.external) && !onChainHash;
  if (noAnchor) {
    checks.push({
      layer: "Metadata integrity (SHA-256)",
      pass: true,
      na: true,
      detail: "N/A — external contract stores no NFTGuard on-chain SHA-256 anchor, so tamper-vs-mint cannot be proven for this token",
    });
  }

  const hashMatch = Boolean(onChainHash && offChainHash && onChainHash.toLowerCase() === offChainHash.toLowerCase());
  if (!noAnchor) checks.push({
    layer: "Metadata integrity (SHA-256)",
    pass: hashMatch,
    detail: hashMatch
      ? "Off-chain metadata hash matches on-chain anchor"
      : `MISMATCH — on-chain ${short(onChainHash)} vs off-chain ${short(offChainHash)}`,
  });
  if (!noAnchor && !hashMatch) {
    authRisk = 100; // tampered metadata destroys authenticity entirely
    if (status === "Verified") status = "Tampered";
    await FraudFlag.findOneAndUpdate(
      { tokenId, flagType: "METADATA_TAMPERED" },
      { tokenId, flagType: "METADATA_TAMPERED", penaltyScore: 100,
        description: "Off-chain metadata hash does not match on-chain SHA-256 anchor",
        evidence: { onChainHash, offChainHash }, detectedAt: new Date() },
      { upsert: true }
    );
  }

  // ---- Layer 3: duplicate / copy-mint detection (steps 12-13, Fig 4.3) ----
  if (!nft.imageHash && nft.image) {
    nft.imageHash = (await computeImagePHash(nft.image)) || nft.imageHash;
  }
  // If no perceptual hash could be produced, the comparison never ran — report that
  // honestly as N/A instead of "no similar assets found", which would be a pass the
  // layer did not earn (e.g. APNG/SVG artwork Jimp cannot decode).
  const duplicates = await findDuplicates(tokenId, nft.imageHash);
  if (!nft.imageHash) {
    checks.push({
      layer: "Duplicate detection (pHash)",
      pass: true,
      na: true,
      detail: nft.image
        ? "N/A — artwork could not be decoded (unsupported image format), so no perceptual hash exists to compare"
        : "N/A — this token has no image to hash",
    });
  } else checks.push({
    layer: "Duplicate detection (pHash)",
    pass: duplicates.length === 0,
    detail: duplicates.length === 0
      ? "No perceptually similar assets found in registry"
      : `Similar to token(s): ${duplicates.map(d => `#${d.tokenId} (dist ${d.distance})`).join(", ")}`,
  });
  if (duplicates.length > 0) {
    authRisk = 100; // a copy-mint is not an authentic asset
    if (status === "Verified") status = "Duplicate";
    await FraudFlag.findOneAndUpdate(
      { tokenId, flagType: "DUPLICATE_ASSET" },
      { tokenId, flagType: "DUPLICATE_ASSET", penaltyScore: 100,
        description: `Perceptual hash matches ${duplicates.length} existing asset(s)`,
        evidence: { duplicates }, detectedAt: new Date() },
      { upsert: true }
    );
  }

  // ---- Persist result (step 14, Fig 4.3) ----
  nft.authenticityStatus = status;
  nft.offChainMetadataHash = offChainHash || nft.offChainMetadataHash;
  await nft.save();

  return {
    tokenId,
    authenticityStatus: status,
    authRisk: Math.min(100, authRisk),
    checks,
    duplicates,
  };
}

function short(h) {
  if (!h) return "(none)";
  return h.length > 14 ? `${h.slice(0, 10)}…${h.slice(-4)}` : h;
}

module.exports = { verifyNft, sha256OfMetadata, computeImagePHash, fetchMetadata, resolveIpfsUri };
