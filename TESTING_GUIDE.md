# NFTGuard — Hands-On Testing Guide

**Authenticity Verification + Fraud Detection — click-by-click**

This is the practical, do-it-in-the-browser companion to the formal test-case table in
[`TESTING.md`](./TESTING.md). It uses the **current seed data** and the newest UI
(image upload, demo-flaw mint, cancel listing, offers, notification bell).

> Token IDs below are from the **current** database. If you run `npm run seed` again the
> IDs change — use the **authenticity filter** / **risk filter** / a token's **Fraud flags**
> tab to find equivalents, or re-run the "find flagged tokens" query in the appendix.

---

## 0. Setup

1. Start the backend: in `backend/`, run `node server.js` (or `npm start`).
2. Open **http://localhost:5000**.
3. Click **Connect wallet** (top-right). Simulated wallets work — you don't need MetaMask
   for any authenticity/fraud test. Use MetaMask + Sepolia only for the "real on-chain mint" test.

---

## Part A — Authenticity Verification (the 3-layer engine)

Every NFT is checked on three layers → one `authenticityStatus`:

| Layer | What it checks | Fail status |
|-------|----------------|-------------|
| 1. Smart-contract validation | Contract implements ERC-721 (ERC-165 `supportsInterface`) | **NonCompliant** |
| 2. Metadata integrity | `SHA-256(off-chain metadata)` == on-chain hash anchor | **Tampered** |
| 3. Duplicate detection | Image perceptual-hash (pHash) vs every other NFT | **Duplicate** |

**Key fact:** a *clean* mint is **Verified by construction** — the engine sets the off-chain
hash equal to the on-chain anchor, marks the contract compliant, and the image is unique, so
all three layers pass. **That is why your Sepolia mint shows "Verified" — it is genuinely
authentic, not a bug.** To *see* an Unverified result you must mint something flawed.

### A1 — Verified (baseline)
1. Sidebar → **Create / Mint**.
2. Name it (e.g. `Clean Test`). Leave **Authenticity (demo/testing) = Authentic**.
3. **Mint (simulated)**.
4. Open the new card → **Authenticity** tab.
- ✅ All three checks show ✓, badge = **Verified**, Authenticity risk = **0**.

### A2 — Tampered metadata → Unverified  ← *this answers "how do I get Unverified status?"*
1. Create → set **Authenticity = "Tampered metadata"** → **Mint (simulated)**.
2. Open the card → **Authenticity** tab.
- ✅ Layer 2 "Metadata integrity (SHA-256)" shows ✗ **MISMATCH**, badge = **Tampered**,
  Authenticity risk = **100** → unified score jumps to **40 (Medium)**.

### A3 — Non-compliant contract → Unverified
1. Create → **Authenticity = "Non-compliant contract"** → **Mint**.
- ✅ Layer 1 "Smart contract validation" ✗, badge = **NonCompliant**.

### A4 — Duplicate image → Unverified
1. Create → paste an **image URL** (or upload a file) → Mint. (this is the new image box)
2. Create **again** with the **same image** → Mint.
- ✅ The 2nd one verifies as **Duplicate** (its pHash matches the first).
- *Tip:* duplicate detection reads the image, so use a normal `https://…png/jpg` URL for a reliable match.

### Inspect the seeded examples (no minting needed)
Marketplace → **authenticity filter** dropdown, or open these directly:

| Status | Tokens in current seed |
|--------|------------------------|
| Tampered | **#33** Pixel Guardians #77, **#39** Meta Beasts #12, **#45** Cyber Relics #250 |
| Duplicate | **#37** Meta Beasts #88, **#38** Meta Beasts #89, **#44** Cyber Relics #7 |
| NonCompliant | **#34** Pixel Guardians #301, **#42** Cyber Relics #66 |

The checkout modal also shows a **⚠ Authenticity warning** if you try to buy any of these.

---

## Part B — Fraud Detection (4 heuristic rules + price anomaly)

Open any flagged token → **Fraud flags** tab to read the evidence. Rules live in
`backend/services/fraudDetector.js`; penalties in `config/thresholds.json`.

| Rule | Fires when | Penalty | See it on |
|------|-----------|---------|-----------|
| Self-transfer | a **SALE/TRANSFER** where sender == recipient | 80 (+scales) | **#1** Azuki #4305, **#2** BAYC #3511, **#3** Azuki #8418 |
| Buyer–seller loop (wash) | a wallet pair trades the token **≥ 3×** | 45 | **#39** Meta Beasts #12, **#40** Meta Beasts #210, **#45** Cyber Relics #250 |
| Price anomaly | a **SALE** exceeds \|Z\| > 2.5 vs collection | 40 + extras | **#3** Azuki #8418, **#4** Azuki #6966, **#29** BAYC #8295 |
| Abnormal frequency | trades in a short window ≫ collection baseline | 30 | *(needs a burst of trades — see B4)* |
| Rapid price escalation | consecutive sales jump ≥ 50% **within the time window** | 30 | *(needs fast jumps — see B5)* |

### B1 — Self-transfer
Open **#3 (Azuki #8418)** → **Fraud flags** → `SELF_TRANSFER` (2 sales where the wallet sold to
itself). The **Price history** table shows those `SALE` rows with identical FROM/TO.

### B2 — Wash-trading ring (buyer–seller loop)
1. Open **#39 (Meta Beasts #12)** → **Fraud flags** → `BUYER_SELLER_LOOP`. It's the highest-risk
   token in the set (**score 80, High**): Tampered + wash-traded.
2. Then go to **Admin dashboard** (sidebar → Admin, password `nftguard2026`) → the interactive
   **wash-ring graph** draws the ring wallets; click a node to **ban / blacklist** it.

### B3 — Price anomaly
- Open **#29 (BAYC #8295)** → **Price history** tab → the outlier sale is a **red** dot, and the
  **Fraud flags** tab lists `PRICE_ANOMALY` with the max \|Z\|.
- Or: **Price analytics** page → pick a collection → the scatter shows every sale, red = anomaly,
  with the live line "`N sales · μ … · σ … · K anomalies at |Z| > 2.5`".

### B4 — Abnormal frequency (create it live)
The current seed doesn't burst-trade, so make one: repeatedly **Buy** and re-sell a token between
two simulated wallets within a minute (or `POST /api/buy` in a loop). Re-run verification → once the
token's densest 60-min window beats the collection baseline, `ABNORMAL_FREQUENCY` appears.

### B5 — Rapid price escalation
Needs consecutive **sales** that jump ≥ 50% **within the configured minutes** (default is a short
window). The seeded BAYC spike (0.5 → 27.888 ETH) is huge but months apart, so it does **not**
fire — escalation is deliberately time-boxed to catch pump bursts, not slow appreciation.

---

## Part C — Verify the three bug fixes (regression tests)

### C1 — Re-pricing no longer fakes a "self-transfer"  ✅ FIXED
1. Create → mint a clean NFT (it is now **unlisted**).
2. Open it → **List for sale** at `1` ETH.
3. Change the price box to `2`, click **Update price**. Repeat for `3`, `5`.
4. Click **Re-run verification**.
- ✅ Score stays **0 (Low)**, **no** SELF_TRANSFER flag. (Before the fix, each re-price added an
  owner→owner `LIST` row that was miscounted as wash trading and the score climbed.)

### C2 — Offers must be below the asking price  ✅ NEW
1. Open a listed NFT you **don't** own → **Make offer**.
2. Enter an amount **≥ the listed price** → **Submit**.
- ✅ Rejected: *"Offer must be below the listed price (X ETH). To pay the asking price, use Buy now."*
3. Enter an amount **below** the price → ✅ accepted.

### C3 — Price-anomaly flag no longer duplicates  ✅ FIXED
Open a `PRICE_ANOMALY` token (e.g. **#3**) → **Re-run verification** two or three times → the
**Fraud flags** tab shows **one** `PRICE_ANOMALY`, not a growing stack.

---

## Part D — New feature checks

| Feature | How to test |
|---------|-------------|
| **Image upload** | Create → paste an image URL **or** choose a file → preview appears → mint → the card shows your image |
| **Mint ≠ list** | After minting, the item is **not for sale**; open it → **List for sale** to price it |
| **Cancel listing** | Open an NFT you own that's listed → **Cancel listing** → it leaves the marketplace's for-sale set |
| **My NFTs filter** | Marketplace filter bar → tick **My NFTs** → only your wallet's tokens show |
| **Notification bell** | With offers on your NFTs, the 🔔 (top-right) shows a red count → click → **Accept** an offer |
| **Offers in profile** | Account → Profile → **Offers received** table → **Accept** to sell |
| **Lower vs raise price** | Lowering a price = free update; raising it warns it needs *cancel + re-list* (real-world gas), per OpenSea's model |

---

## Part E — Risk-score sanity (the unified formula)

Open any token → **Risk breakdown** tab. The score is:

```
unified = round( 0.40 × authenticityRisk  +  0.35 × fraudRisk  +  0.25 × priceRisk )
level:   < 40 Low   ·   40–69 Medium   ·   ≥ 70 High
```

Worked example — **#39 Meta Beasts #12** = **80 High**: authRisk 100 (Tampered) ×0.40 = 40,
fraudRisk ~75 ×0.35 ≈ 26, priceRisk ~55 ×0.25 ≈ 14 → ~80.

---

## Appendix — API / curl equivalents & finding flagged tokens

```bash
# Authenticity of one token
curl -X POST http://localhost:5000/api/verify/33

# Fraud rules for one token
curl -X POST http://localhost:5000/api/fraud/39

# Full unified risk (re-runs the whole pipeline)
curl http://localhost:5000/api/risk/39

# Collection price stats + anomalies
curl "http://localhost:5000/api/price/Meta%20Beasts"

# Mint a deliberately-flawed NFT for a demo
curl -X POST http://localhost:5000/api/mint -H "Content-Type: application/json" \
  -d '{"name":"Fake","walletAddress":"0x1111111111111111111111111111111111111111","demoFlaw":"tampered"}'
```

**Find which tokens carry which flag after a re-seed** — run in `backend/`:

```bash
node -e "require('dotenv').config();const m=require('mongoose');(async()=>{await m.connect(process.env.MONGODB_URI||'mongodb://127.0.0.1:27017/nftguard');const F=require('./models/FraudFlag');const g={};(await F.find().lean()).forEach(f=>(g[f.flagType]=g[f.flagType]||new Set()).add(f.tokenId));for(const k in g)console.log(k,[...g[k]].slice(0,6));await m.disconnect()})()"
```
