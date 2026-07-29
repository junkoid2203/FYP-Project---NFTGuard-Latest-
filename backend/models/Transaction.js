const mongoose = require("mongoose");

/** TRANSACTION entity — the dataset consumed by fraud + price analysis */
const txSchema = new mongoose.Schema(
  {
    tokenId: { type: Number, required: true, index: true },
    collectionName: { type: String, default: "", index: true },
    txType: { type: String, enum: ["MINT", "LIST", "SALE", "TRANSFER"], default: "SALE" },
    senderAddress: { type: String, required: true },
    recipientAddress: { type: String, required: true },
    priceEth: { type: Number, default: 0 },
    txHash: { type: String, default: "" },
    timestamp: { type: Date, default: Date.now, index: true },
    simulated: { type: Boolean, default: true }, // false when confirmed on Sepolia
  },
  { timestamps: true }
);

module.exports = mongoose.model("Transaction", txSchema);
