const mongoose = require("mongoose");

/** PRICE_STATS entity — collection-level stats used for Z-score computation */
const statsSchema = new mongoose.Schema(
  {
    collectionName: { type: String, required: true, unique: true, index: true },
    avgPrice: { type: Number, default: 0 },
    medianPrice: { type: Number, default: 0 },
    stdDev: { type: Number, default: 0 },
    minPrice: { type: Number, default: 0 },
    maxPrice: { type: Number, default: 0 },
    sampleSize: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PriceStats", statsSchema);
