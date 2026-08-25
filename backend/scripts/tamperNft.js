/**
 * tamperNft.js — reproduce a metadata rug-pull against a token that is already Verified.
 *
 * This does NOT set the status to "Tampered". It edits the off-chain metadata the way a
 * dishonest creator would after minting, and lets Layer 2 reach its own verdict: the
 * on-chain SHA-256 anchor was fixed at mint and never changes, the metadata did, so the
 * two hashes stop matching. That mismatch is the detection — nothing is declared.
 *
 * Usage:
 *   npm run tamper -- 12                             swap the description (default)
 *   npm run tamper -- 12 --image <url>               swap the artwork (classic rug-pull)
 *   npm run tamper -- 12 --name "New Name"
 *   npm run tamper -- 12 --restore                   undo, back to Verified
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Nft = require("../models/Nft");
const { verifyNft, sha256OfMetadata } = require("../services/authVerifier");
const { computeUnifiedRisk } = require("../services/riskScoreEngine");

// The verifier hashes the metadata document, so rebuild it the same way /api/mint did.
const metaOf = n => ({ name: n.name, description: n.description, image: n.image, attributes: [] });
const short = h => (h ? `${h.slice(0, 12)}…${h.slice(-6)}` : "(none)");

async function main() {
  const argv = process.argv.slice(2);
  const tokenId = Number(argv.find(a => /^\d+$/.test(a)));
  const restore = argv.includes("--restore");
  const val = f => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };

  if (!tokenId) {
    console.log("Usage:\n  npm run tamper -- 12\n  npm run tamper -- 12 --image <url>\n  npm run tamper -- 12 --restore\n");
    process.exit(1);
  }

  await connectDB();
  const nft = await Nft.findOne({ tokenId });
  if (!nft) { console.log(`NFT #${tokenId} not found.`); return mongoose.disconnect(); }

  if (nft.external) {
    console.log(`\n#${tokenId} ${nft.name} is an imported mainnet token.`);
    console.log("It has no NFTGuard on-chain anchor, so Layer 2 reports N/A and there is");
    console.log("nothing to tamper with. Use a token minted in this marketplace instead.\n");
    return mongoose.disconnect();
  }

  // ---------------------------------------------------------------- restore
  if (restore) {
    const snap = nft.tamperBackup;
    if (!snap) { console.log(`#${tokenId} has no tamper snapshot — nothing to restore.`); return mongoose.disconnect(); }
    nft.name = snap.name; nft.description = snap.description; nft.image = snap.image;
    nft.imageHash = snap.imageHash || "";
    // Put the stored hash back verbatim. Recomputing it here would break seeded tokens,
    // whose anchor was written by the seeder rather than derived from the metadata document.
    nft.offChainMetadataHash = snap.offChainMetadataHash;
    nft.tamperBackup = null;
    await nft.save();
    const r = await verifyNft(tokenId);
    await computeUnifiedRisk(tokenId);
    console.log(`\nRestored #${tokenId} "${nft.name}" -> ${r.authenticityStatus}\n`);
    return mongoose.disconnect();
  }

  // ---------------------------------------------------------------- tamper
  if (nft.tamperBackup) { console.log(`#${tokenId} is already tampered. Use --restore first.`); return mongoose.disconnect(); }

  console.log(`\nBEFORE  #${tokenId} "${nft.name}"  [${nft.authenticityStatus}]`);
  console.log(`  on-chain anchor (fixed at mint) : ${short(nft.metadataHash)}`);
  console.log(`  off-chain metadata hash         : ${short(nft.offChainMetadataHash)}`);
  console.log(`  match                           : ${nft.metadataHash === nft.offChainMetadataHash ? "YES" : "no"}`);

  nft.tamperBackup = {
    name: nft.name, description: nft.description, image: nft.image,
    imageHash: nft.imageHash, offChainMetadataHash: nft.offChainMetadataHash,
  };

  const newImage = val("--image"), newName = val("--name"), newDesc = val("--description");
  let changed;
  if (newImage) {
    nft.image = newImage;
    nft.imageHash = "";   // artwork changed, so the old perceptual hash is stale — let Layer 3 redo it
    changed = "image";
  } else if (newName) { nft.name = newName; changed = "name"; }
  else {
    nft.description = (nft.description || "") + " Holders now receive exclusive airdrop access.";
    changed = "description";
  }

  // The new hash is computed from the new content — it is a real SHA-256, not a placeholder.
  nft.offChainMetadataHash = sha256OfMetadata(metaOf(nft));
  await nft.save();

  console.log(`\n  ...creator edits the ${changed} after mint...\n`);

  const r = await verifyNft(tokenId);
  const risk = await computeUnifiedRisk(tokenId);
  const fresh = await Nft.findOne({ tokenId }).lean();

  console.log(`AFTER   #${tokenId} "${fresh.name}"  [${r.authenticityStatus}]`);
  console.log(`  on-chain anchor (unchanged)     : ${short(fresh.metadataHash)}`);
  console.log(`  off-chain metadata hash (new)   : ${short(fresh.offChainMetadataHash)}`);
  console.log(`  match                           : ${fresh.metadataHash === fresh.offChainMetadataHash ? "YES" : "NO  <- mismatch detected"}`);
  console.log(`  risk score                      : ${risk.unifiedScore} (${risk.riskLevel})`);
  for (const c of r.checks) console.log(`    ${c.na ? "-" : c.pass ? "PASS" : "FAIL"}  ${c.layer}`);
  console.log(`\nUndo with:  npm run tamper -- ${tokenId} --restore\n`);

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
