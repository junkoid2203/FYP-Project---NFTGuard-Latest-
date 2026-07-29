const mongoose = require("mongoose");

/** FRAUD_FLAG entity — one heuristic event, one-to-many with NFT */
const flagSchema = new mongoose.Schema(
  {
    tokenId: { type: Number, required: true, index: true },
    flagType: {
      type: String,
      enum: [
        "BUYER_SELLER_LOOP",
        "ABNORMAL_FREQUENCY",
        "SELF_TRANSFER",
        "RAPID_PRICE_ESCALATION",
        "PRICE_ANOMALY",
        "METADATA_TAMPERED",
        "DUPLICATE_ASSET",
        "NON_COMPLIANT_CONTRACT",
      ],
      required: true,
    },
    description: { type: String, default: "" },
    penaltyScore: { type: Number, default: 0 },
    evidence: { type: Object, default: {} },
    detectedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("FraudFlag", flagSchema);
