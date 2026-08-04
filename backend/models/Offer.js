const mongoose = require("mongoose");

/** OFFER entity — a bid a wallet places on an NFT (listed or not). */
const offerSchema = new mongoose.Schema(
  {
    tokenId: { type: Number, required: true, index: true },
    fromAddress: { type: String, required: true },
    priceEth: { type: Number, required: true },
    status: {
      type: String,
      enum: ["Active", "Accepted", "Rejected", "Cancelled"],
      default: "Active",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Offer", offerSchema);
