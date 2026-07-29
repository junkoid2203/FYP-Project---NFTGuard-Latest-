# NFTGuard — Test Cases (for Report Chapter 5: Implementation and Testing)

Run `npm run seed` first. Each case below can be executed with the dashboard or
`curl`/Postman, and the seed dataset guarantees the expected result.

## Module 1 — NFT Authenticity Verification (Sprint 1)

| ID | Test case | Steps | Expected result | FR |
|----|-----------|-------|-----------------|-----|
| A1 | ERC-721 compliance pass | `POST /api/verify/1` (on-chain mode) | Layer "Smart contract validation" = pass, supportsInterface(0x80ac58cd)=true | 1.1 |
| A2 | Metadata integrity pass | `POST /api/verify/1` | SHA-256(off-chain) == on-chain anchor → status **Verified** | 1.2, 1.3 |
| A3 | Tampered metadata detected | `POST /api/verify/6` (seeded mismatch) | Hash MISMATCH → status **Tampered**, authRisk +80, METADATA_TAMPERED flag | 1.3, 1.5 |
| A4 | Duplicate NFT detected | `POST /api/verify/7` (same pHash as #6) | Duplicate layer fail → status **Duplicate**, DUPLICATE_ASSET flag | 1.4 |

## Module 2 — Transaction Simulation (Sprint 2)

| ID | Test case | Steps | Expected result | FR |
|----|-----------|-------|-----------------|-----|
| T1 | Mint NFT | Dashboard → Mint form (wallet connected) | New token appears in grid; MINT tx recorded; tx hash returned (Sepolia hash in on-chain mode) | 2.1, 2.2 |
| T2 | List for sale | `POST /api/list {tokenId, priceEth:0.8}` | `listed=true`, LIST tx recorded | 2.3 |
| T3 | Purchase | Card → Buy (wallet connected) | Ownership transfers, SALE tx with price+timestamp stored | 2.4, 2.5 |
| T4 | History view | Modal → "Price history" tab | Full chronological tx table displayed | 2.6 |
| T5 | Buy unlisted token | `POST /api/buy` on unlisted token | 400 "NFT is not listed for sale" | 2.4 |

## Module 3 — Price Transparency Analysis (Sprint 3)

| ID | Test case | Steps | Expected result | FR |
|----|-----------|-------|-----------------|-----|
| P1 | Collection statistics | `GET /api/price/CyberGuard%20Genesis` | avg, median, stdDev, sampleSize returned | 3.1 |
| P2 | Z-score anomaly | Same call — token #8 sale 5.5 ETH | point flagged `anomaly:true` (\|Z\| > 2.5) | 3.2, 3.4 |
| P3 | Price chart | Open token #8 → Price history tab | Line chart with red anomaly marker | 3.3 |

## Module 4 — Fraud Detection (Sprint 3)

| ID | Test case | Steps | Expected result | FR |
|----|-----------|-------|-----------------|-----|
| F1 | Buyer–seller loop | `POST /api/fraud/3` | BUYER_SELLER_LOOP (pair ×6 ≥ 3) penalty 45 | 4.1 |
| F2 | Abnormal frequency | `POST /api/fraud/5` | ABNORMAL_FREQUENCY (8 tx in 60-min window vs baseline) penalty 30 | 4.2 |
| F3 | Self-transfer | `POST /api/fraud/4` | SELF_TRANSFER (sender==recipient ×2) penalty 25 | 4.3 |
| F4 | Rapid escalation | `POST /api/fraud/3` | RAPID_PRICE_ESCALATION (+60% hops within 12 min) penalty 30 | 4.4 |
| F5 | Clean token | `POST /api/fraud/1` | `rulesTriggered: []`, fraudRisk 0 | 4.5 |
| F6 | Determinism (NFR Reliability) | Run F1 twice | Identical flags + score both runs | — |

## Module 5 — Risk Analytics & Visualization (Sprint 4)

| ID | Test case | Steps | Expected result | FR |
|----|-----------|-------|-----------------|-----|
| R1 | Weighted formula | `GET /api/risk/3` | unifiedScore = round(0.40·auth + 0.35·fraud + 0.25·price); breakdown shows each contribution | 5.1 |
| R2 | Level mapping | Compare tokens #1 / #3 / #9 | Low (<40) / Medium (40–69) / High (≥70) labels, colour-coded green/amber/red | 5.2 |
| R3 | High-risk alert | `GET /api/risk/9` (Dark Mint, combined scam) | score 75, `highRiskAlert:true`; red alert banner on dashboard | 5.3 |
| R4 | Dashboard render | Open http://localhost:5000 | Stat strip, grid with risk rings, charts render < 5 s (NFR Performance) | 5.4 |
| R5 | Search & filter | Filter riskLevel=High, search "wash" | Only matching NFTs shown | 5.5 |

## Configurability (NFR Maintainability)

| ID | Test case | Steps | Expected result |
|----|-----------|-------|-----------------|
| C1 | Threshold change | Set `washTrade.loopPairMinCount` to 7 in `config/thresholds.json`, restart, re-run F1 | Loop rule no longer triggers for token #3 (6 < 7) |
| C3 | Expected seed scores | `npm run seed` console output | #1/#2 = 0 Low · #3 = 41 Med · #4 = 9 · #5 = 11 · #6 = 40 Med · #7 = 20 · #8 = 15 · #9 = 75 High |
| C2 | Weight change | Set weights to 0.5/0.3/0.2, re-run R1 | unifiedScore recomputed with new weights |
