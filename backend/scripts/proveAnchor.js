/**
 * proveAnchor.js — read the on-chain metadata anchor straight off Sepolia and compare it
 * with what NFTGuard stores, so Layer 2 can be checked by a third party.
 *
 * The anchor is written once by mintNFT() and the contract exposes no setter, so it cannot
 * be changed afterwards. That is what makes it usable as a baseline: the off-chain metadata
 * can be edited at any time, the anchor cannot.
 *
 * Run:  npm run prove:anchor
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { ethers } = require("ethers");
const connectDB = require("../config/db");
const Nft = require("../models/Nft");

const RPC = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const ADDR = process.env.CONTRACT_ADDRESS;
const ABI = [
  "function metadataHash(uint256 tokenId) external view returns (bytes32)",
  "function tokenURI(uint256 tokenId) external view returns (string)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
];

(async () => {
  if (!ADDR) { console.log("CONTRACT_ADDRESS is not set in .env"); process.exit(1); }
  await connectDB();

  const provider = new ethers.JsonRpcProvider(RPC);
  const contract = new ethers.Contract(ADDR, ABI, provider);

  console.log("NFTGuard contract on Sepolia:", ADDR);
  console.log("RPC:", RPC);
  console.log("Explorer: https://sepolia.etherscan.io/address/" + ADDR + "#readContract");
  console.log("=".repeat(78));

  const nfts = await Nft.find({ onChainTokenId: { $ne: null } })
    .select("tokenId name onChainTokenId metadataHash offChainMetadataHash authenticityStatus")
    .sort({ tokenId: 1 }).lean();

  if (!nfts.length) { console.log("\nNo NFT has been minted into the contract yet."); await mongoose.disconnect(); return; }

  for (const n of nfts) {
    console.log(`\n#${n.tokenId} "${n.name}"  ->  contract token #${n.onChainTokenId}`);
    let onChain, uri;
    try {
      [onChain, uri] = await Promise.all([
        contract.metadataHash(n.onChainTokenId),
        contract.tokenURI(n.onChainTokenId),
      ]);
    } catch (e) { console.log(`  could not read from chain: ${e.shortMessage || e.message}`); continue; }

    const stored = (n.metadataHash || "").toLowerCase();
    const live = String(onChain).toLowerCase();
    const off = (n.offChainMetadataHash || "").toLowerCase();

    console.log(`  anchor READ FROM SEPOLIA   : ${live}`);
    console.log(`  anchor stored by NFTGuard  : ${stored}`);
    console.log(`  -> ${live === stored ? "IDENTICAL — the app is not inventing the anchor" : "DIFFERENT — investigate"}`);
    console.log(`  tokenURI on chain          : ${uri}`);
    console.log(`  current off-chain hash     : ${off}`);
    console.log(`  Layer 2 verdict            : ${live === off ? "match -> metadata intact" : "MISMATCH -> metadata changed since mint"}  [status: ${n.authenticityStatus}]`);
  }

  console.log(`
Reproduce by hand, no code:
  1. open https://sepolia.etherscan.io/address/${ADDR}#readContract
  2. expand metadataHash, enter the contract token id, click Query
  3. the value returned is the same bytes32 printed above

The anchor is set inside mintNFT() and the contract has no function that can overwrite it,
so anyone can re-read it later and get the value fixed at mint time.
`);
  await mongoose.disconnect();
})();
