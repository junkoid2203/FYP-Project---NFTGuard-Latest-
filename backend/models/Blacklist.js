const mongoose = require("mongoose");

/** BLACKLIST — wallets an admin has banned from the marketplace. */
const blacklistSchema = new mongoose.Schema(
  {
    address: { type: String, required: true, unique: true, lowercase: true, index: true },
    reason: { type: String, default: "" },
    washScore: { type: Number, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Blacklist", blacklistSchema);
