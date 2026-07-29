const mongoose = require("mongoose");

/** RISK_SCORE entity — one-to-one with NFT (ER diagram Fig 4.17) */
const riskSchema = new mongoose.Schema(
  {
    tokenId: { type: Number, required: true, unique: true, index: true },
    authRisk: { type: Number, default: 0 },        // 0-100
    fraudRisk: { type: Number, default: 0 },       // 0-100
    priceRisk: { type: Number, default: 0 },       // 0-100
    unifiedScore: { type: Number, default: 0 },    // 0-100, weighted formula
    riskLevel: { type: String, enum: ["Low", "Medium", "High"], default: "Low" },
    breakdown: { type: Object, default: {} },
    calculatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("RiskScore", riskSchema);
