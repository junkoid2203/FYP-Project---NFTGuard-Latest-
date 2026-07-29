const mongoose = require("mongoose");

async function connectDB() {
  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/nftguard";
  try {
    await mongoose.connect(uri);
    console.log(`[MongoDB] connected -> ${uri}`);
  } catch (err) {
    console.error("[MongoDB] connection failed:", err.message);
    console.error("  Make sure MongoDB is running, or set MONGODB_URI in backend/.env");
    console.error("  (Free cloud option: MongoDB Atlas -> https://www.mongodb.com/atlas)");
    process.exit(1);
  }
}

module.exports = connectDB;
