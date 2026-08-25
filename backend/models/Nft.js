const mongoose = require("mongoose");

/** NFT entity — mirrors ER diagram Fig 4.17 */
const nftSchema = new mongoose.Schema(
  {
    tokenId: { type: Number, required: true, unique: true, index: true },
    contractAddress: { type: String, default: "" },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    image: { type: String, default: "" },            // image URL / ipfs://
    tokenURI: { type: String, default: "" },         // ipfs://<CID> of metadata
    metadataHash: { type: String, default: "" },     // on-chain SHA-256 anchor
    offChainMetadataHash: { type: String, default: "" }, // recomputed by verifier
    imageHash: { type: String, default: "" },        // perceptual hash (pHash)
    authenticityStatus: {
      type: String,
      enum: ["Unverified", "Verified", "Tampered", "Duplicate", "NonCompliant"],
      default: "Unverified",
    },
    erc721Compliant: { type: Boolean, default: null },
    collectionName: { type: String, default: "NFTGuard Collection", index: true },
    creatorAddress: { type: String, default: "" },
    ownerAddress: { type: String, default: "" },
    listed: { type: Boolean, default: false },
    priceEth: { type: Number, default: 0 },
    traits: { type: Object, default: {} },
    // Real token id inside the NFTGuard Sepolia contract. Set only for NFTs minted
    // with the on-chain button; these are the only ones that can be listed/bought
    // on-chain, since a seeded token exists in MongoDB but not in the contract.
    onChainTokenId: { type: Number, default: null },
    // --- imported real mainnet tokens (see services/onChainImporter.js) ---
    external: { type: Boolean, default: false },     // true = third-party contract
    externalContract: { type: String, default: "" },
    externalTokenId: { type: String, default: "" },
    externalChain: { type: String, default: "" },     // which EVM chain it was found on
    chainCompliance: { type: Object, default: null }, // real ERC-165 result observed on that chain
    // Pre-tamper snapshot written by scripts/tamperNft.js so a test rug-pull can be undone.
    // Kept out of `traits`, which is rendered to users as the token's attributes.
    tamperBackup: { type: Object, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Nft", nftSchema);
