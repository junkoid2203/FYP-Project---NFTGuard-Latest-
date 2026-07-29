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
  },
  { timestamps: true }
);

module.exports = mongoose.model("Nft", nftSchema);
