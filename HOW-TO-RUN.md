# NFTGuard — How to Run

**Koid Cheng Chun** · Final Year Project 2025/26 · Supervisor: Mr Veren Ten Shai Cheong

---

## Option 1 — Open the deployed system (no setup)

The system is already deployed and running:

**https://nftguard.onrender.com**

Nothing to install. The full demonstration dataset is loaded — 54 NFTs, 250 transactions,
44 fraud flags.

> The service is hosted on a free tier that suspends after 15 minutes of inactivity, so the
> **first page load may take around 50 seconds** while it wakes. It is fast afterwards.

The administrative dashboard is at **/dashboard.html**, password `nftguard2026`.

---

## Option 2 — Run it locally, using the hosted database

Requires **Node.js 20 or later** and an internet connection. **MongoDB does not need to be
installed**, and the full 54-NFT dataset described in the report is already loaded.

```
cd backend
npm install
copy .env.example .env        (Windows)      cp .env.example .env    (macOS/Linux)
```

Open `backend/.env` and paste the database connection string from **Appendix B of the
project report** into the `MONGODB_URI` line, replacing what is there. The string is kept in
the report rather than in this repository because the repository is public.

```
npm start
```

Then open **http://localhost:5000**

---

## Option 3 — Run it fully locally, with your own MongoDB

No credential needed, but the dataset is the smaller 9-NFT demonstration set rather than the
54-NFT one described in the report.

1. Install **MongoDB Community Server** and make sure it is running.
2. `cd backend`
3. `npm install`
4. `cp .env.example .env` — leave `MONGODB_URI` exactly as it is
5. `npm run seed` — creates the demonstration data
6. `npm start`

Then open **http://localhost:5000**

---

## Verifying the claims in the report

Two commands reproduce evidence used in Chapter 5, and neither needs an API key —
both query public blockchain nodes directly.

```
cd backend
npm run prove:erc165      Reads ERC-165 compliance from live Ethereum mainnet contracts,
                          printing each raw JSON-RPC request and response. Shows why
                          CryptoPunks fails Layer 1 while Bored Ape Yacht Club passes.

npm run prove:anchor      Reads the metadata anchors from the deployed Sepolia contract
                          and prints them beside the values the application stores.
```

The automated test suites run offline, with no database or network:

```
npm test                  7 authenticity tests
npm run test:fraud        14 fraud rule tests, including rule-independence checks
```

---

## What is where

| Folder | Contents |
|---|---|
| `backend/` | Express API, the five analysis modules, schema models, scripts |
| `backend/services/` | Authenticity, fraud, price, graph and risk engines |
| `backend/config/thresholds.json` | Every detection threshold, weight and cut-off |
| `frontend/` | Marketplace (`index.html`) and analytics dashboard (`dashboard.html`) |
| `contracts/` | `NFTGuardMarketplace.sol`, the deployed ERC-721 contract |
| `ml/` | Jupyter notebook for the evaluation in Section 5.2.9 (analysis only) |

The smart contract is public and can be inspected without running anything:
**https://sepolia.etherscan.io/address/0x8a4A907794816E6bE76993de230e134Ea95e61F4**

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `[MongoDB] connection failed` then the process exits | `.env` was not created. Copy `.env.example` to `.env`. |
| Marketplace loads but shows no NFTs | Connected to the wrong database. Check the `MONGODB_URI` line ends with `/nftguard` before the `?`. |
| `Cannot find module 'express'` | `npm install` has not been run inside `backend/`. |
| First page load on the deployed URL is very slow | Expected. The free hosting tier suspends the service when idle. |
