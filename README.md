# NFTGuard — Data-Driven NFT Fraud Detection & Risk Analytics Dashboard

**BMCS3413 Project II · Tan Weng Liang · TAR UMT**

A prototype NFT marketplace with built-in authenticity verification, heuristic fraud
detection, price-anomaly analytics and a unified 0–100 risk score — deployed on the
**Ethereum Sepolia testnet**.

---

## 1. How the code maps to the FYP report

| Report module (Fig 1.1 / Ch. 3–4)         | Sprint | Code |
|-------------------------------------------|--------|------|
| NFT Authenticity Verification             | 1 | `contracts/NFTGuardMarketplace.sol` (on-chain SHA-256 anchor) + `backend/services/authVerifier.js` (ERC-165 check, IPFS fetch, SHA-256 compare, pHash duplicates) |
| Transaction Simulation                    | 2 | contract `mintNFT / listForSale / buy` + `backend/routes/api.js` mint/list/buy + `services/blockchain.js` |
| Price Transparency Analysis               | 3 | `backend/services/priceAnalyzer.js` (avg / median / σ, Z-score, \|Z\| > 2.5 flags) |
| Fraud Detection (4 heuristic rules)       | 3 | `backend/services/fraudDetector.js` (loop, frequency, self-transfer, rapid escalation) |
| Risk Analytics & Visualization            | 4 | `backend/services/riskScoreEngine.js` (0.40·Auth + 0.35·Fraud + 0.25·Price) + `frontend/index.html` dashboard |

All heuristic thresholds and score weights are **configurable without code changes** in
`backend/config/thresholds.json` (non-functional requirement: Maintainability).

Layered architecture follows report Fig 4.1: React-style frontend → Node.js/Express
backend → Sepolia (ethers.js v6) + IPFS/Pinata → MongoDB.

---

## 2. Prerequisites

- **Node.js 18+** and npm
- **MongoDB** — local (`mongod`) or a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster
- Free **Alchemy** (or Infura) account → Sepolia RPC URL
- **MetaMask** with a *testnet-only* wallet, funded with free Sepolia ETH
  (https://sepoliafaucet.com or https://www.alchemy.com/faucets/ethereum-sepolia)
- *(optional)* **Pinata** account for real IPFS metadata pinning

> **No chain access?** Everything still runs in **simulated mode** — skip Section 4,
> the backend generates pseudo tx-hashes and the entire analytics pipeline works.
> Perfect for the demo if the testnet is slow on presentation day.

---

## 3. Install

```bash
# 1. contract toolchain (project root)
npm install

# 2. backend
cd backend && npm install && cd ..

# 3. environment
cp .env.example .env
cp .env.example backend/.env
#   -> edit both: SEPOLIA_RPC_URL, PRIVATE_KEY, MONGODB_URI
```

## 4. Deploy the smart contract to Sepolia

```bash
npm run compile          # hardhat compile (solc 0.8.24, optimizer on)
npm run deploy:sepolia   # deploys NFTGuardMarketplace
```

The script prints the contract address, writes the ABI to
`backend/abi/NFTGuardMarketplace.json`, and gives you an Etherscan link.
**Copy the address into `CONTRACT_ADDRESS=` in both `.env` files.**

Optional source verification on Etherscan:
```bash
npx hardhat verify --network sepolia <CONTRACT_ADDRESS>
```

## 5. Seed demo data & run

```bash
cd backend
npm run seed     # 8 NFTs + transaction histories exercising every detection rule
npm start        # http://localhost:5000  (dashboard + REST API)
```

The seed prints the computed risk score for every token, e.g. token #3 "Wash Cycle"
triggers BUYER_SELLER_LOOP + RAPID_PRICE_ESCALATION → High risk.

## 6. REST API

| Method | Endpoint | Report FR |
|--------|----------|-----------|
| GET  | `/api/health` | — mode + contract status |
| GET  | `/api/stats` | dashboard totals |
| GET  | `/api/nfts?search=&riskLevel=&status=&collection=` | FR 5.5 |
| GET  | `/api/nfts/:tokenId` | detail + risk + flags + history |
| POST | `/api/mint` `{name, walletAddress, priceEth}` | FR 2.2 |
| POST | `/api/list` `{tokenId, priceEth}` | FR 2.3 |
| POST | `/api/buy` `{tokenId, buyerAddress}` | FR 2.4 / 2.5 |
| GET  | `/api/transactions/:tokenId` | FR 2.6 |
| POST | `/api/verify/:tokenId` | FR 1.1–1.5 (Fig 4.3 pipeline) |
| POST | `/api/fraud/:tokenId` | FR 4.1–4.5 (Fig 4.12 pipeline) |
| GET  | `/api/price/:collectionName` | FR 3.1–3.4 (Fig 4.9 pipeline) |
| GET  | `/api/risk/:tokenId` | FR 5.1–5.4 (Fig 4.15 pipeline) |

## 7. Frontend

`frontend/index.html` (landing + marketplace) and `frontend/dashboard.html` (Risk Analytics Dashboard, Sprint 4) are served by the backend at `http://localhost:5000` and `/dashboard.html`.
It keeps your original **Three.js particle sphere** as the live hero backdrop and adds:
glass navigation, a typing verification console, stat strip, marketplace grid with
per-card conic-gradient **risk rings**, colour-coded Low/Medium/High labels
(green/amber/red per NFR Usability), a detail modal with risk-breakdown bars,
authenticity check list, fraud flags, and a Chart.js price history with red
anomaly markers. If the backend is offline it automatically switches to an
embedded demo dataset, so the page also works opened directly as a file.

## 8. Project structure

```
nftguard/
├── contracts/NFTGuardMarketplace.sol   ERC-721 + marketplace + metadata hash anchor
├── scripts/deploy.js                   Sepolia deployment (writes ABI to backend)
├── hardhat.config.js                   solc 0.8.24, sepolia network
├── backend/
│   ├── server.js                       Express entry, serves frontend + /api
│   ├── config/thresholds.json          all heuristic thresholds + risk weights
│   ├── models/                         Nft, Transaction, RiskScore, FraudFlag, PriceStats
│   ├── services/                       blockchain, authVerifier, fraudDetector,
│   │                                   priceAnalyzer, riskScoreEngine
│   ├── routes/api.js                   REST endpoints
│   └── scripts/seedDemo.js             demo dataset (all fraud scenarios)
└── frontend/index.html                 dashboard (particle sphere + risk analytics UI)
```

## 9. Security notes (NFR: Security)

- The `PRIVATE_KEY` is testnet-only, lives in `.env` (git-ignored), and is never sent
  to the frontend or written to logs.
- All chain writes go through backend endpoints only; the contract uses OpenZeppelin
  `ReentrancyGuard` and the checks-effects-interactions pattern in `buy()`.
