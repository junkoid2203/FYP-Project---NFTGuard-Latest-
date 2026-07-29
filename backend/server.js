/**
 * NFTGuard backend server — Node.js + Express (report Table 3.2)
 * Layered architecture per Fig 4.1: this file is the Backend Layer entry.
 */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const path = require("path");
const connectDB = require("./config/db");
const apiRoutes = require("./routes/api");
const blockchain = require("./services/blockchain");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(morgan("dev"));

// REST API (Fig 4.1 — API Gateway)
app.use("/api", apiRoutes);

// Serve the frontend dashboard (single-page, ../frontend/index.html)
app.use(express.static(path.join(__dirname, "..", "frontend")));

const PORT = process.env.PORT || 5000;

(async () => {
  await connectDB();
  app.listen(PORT, () => {
    const mode = blockchain.isOnChainConfigured() ? "ON-CHAIN (Sepolia testnet)" : "SIMULATED (no chain config)";
    console.log("=".repeat(58));
    console.log("  NFTGuard backend running");
    console.log(`  Dashboard : http://localhost:${PORT}`);
    console.log(`  API       : http://localhost:${PORT}/api/health`);
    console.log(`  Mode      : ${mode}`);
    console.log("=".repeat(58));
    if (!blockchain.isOnChainConfigured()) {
      console.log("  Tip: set SEPOLIA_RPC_URL + CONTRACT_ADDRESS in backend/.env");
      console.log("       after running `npm run deploy:sepolia` in project root.");
    }
  });
})();
