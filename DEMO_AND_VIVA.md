# NFTGuard — live demo script + viva answers

## Part A — The live demo (Dashboard → "1 Authenticity Verification")

Scroll to **"Test a real on-chain NFT"**. Click a preset (or paste any contract +
token id), then **Import & verify**. The token is fetched live from Ethereum
mainnet and pushed through the real pipeline.

Run these three in order — the story builds:

### 1. A genuine NFT → **Verified**
Preset **Bored Ape #1** · contract `0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D`, token `1`
- https://opensea.io/item/ethereum/0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D/1
- https://etherscan.io/address/0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d

Observed result:
```
Layer 1  PASS   ERC-165 supportsInterface -> ERC-721: true   [Ethereum mainnet]
Layer 2  N/A    external contract stores no NFTGuard SHA-256 anchor
Layer 3  PASS   No perceptually similar assets found
=> Verified
```
Point: our engine independently agrees with OpenSea's verified badge.

### 2. A real non-compliant contract → **NonCompliant**  (Layer 1, genuine)
Preset **CryptoPunk #7804** · contract `0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB`
- https://etherscan.io/address/0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb
- https://opensea.io/collection/cryptopunks

**Why it genuinely fails:** CryptoPunks was deployed in **June 2017**, *before* the
ERC-721 standard existed (EIP-721 was finalised in 2018). It therefore does not
implement `supportsInterface`, so the ERC-165 probe returns false. This is a
well-documented fact about the contract, not an accusation of fraud — it is the
textbook example of a non-standard NFT contract.

Alternative, even blunter: **USDC** `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
(https://etherscan.io/address/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48) — a real
ERC-20 token contract, so it fails the NFT interface check outright.

Observed result:
```
Layer 1  FAIL   Contract does not declare ERC-721 (0x80ac58cd) or ERC-1155 (0xd9b67a26)
=> NonCompliant
```

### 3. A real copy-mint → **Duplicate**  (Layer 3, genuine — the strongest demo)
**Import Bored Ape #1 a second time** (same preset, click Import again).

The engine has never been told anything. It computes the perceptual hash of the
real artwork, compares it to every indexed asset, and catches the copy:
```
Layer 3  FAIL   Similar to token(s): #50 (dist 0)
=> Duplicate
```
This is exactly the real-world fraud (right-click-and-mint / copy-mint) that the
layer is designed to stop.

### What about a real "Tampered" NFT?
**There isn't one, and claiming otherwise would be dishonest.** Layer 2 compares
off-chain metadata against **an on-chain SHA-256 anchor written at mint by our own
contract**. Third-party collections (BAYC, Azuki…) never stored such an anchor, so
for them there is no baseline and the engine correctly reports **N/A**.

To demo Tampered you must use a token minted *by this system*, where the anchor
exists. The seeded fixtures do exactly that — **#33 Pixel Guardians #77** and
**#39 Meta Beasts #12**. Verify either and Layer 2 fails with both hashes shown.

> Reset between demos: `npm run clear-imports`

---

## Part B — "Where does the data come from?"

| Source | What it provides | How it enters the system |
|---|---|---|
| **Alchemy NFT API** (Ethereum mainnet) | real NFT images, names, traits, contract info | `services/onChainImporter.js` (live import) and `ml/collect_sales.py` → `ml/data/sales_raw*.csv` → `scripts/seedReal.js` |
| **Ethereum mainnet JSON-RPC** (via Alchemy) | genuine `supportsInterface` / bytecode results | `checkMainnetCompliance()` — a real `eth_call` |
| **Real sales CSV** (`ml/data/sales_raw*.csv`) | historical seller→buyer trades used for graph wash-trading analysis | `services/graphAnalyzer.js` |
| **Synthetic demo seed** (`scripts/seedDemo.js`) | 9 labelled scenarios with *known* fraud (ground truth) | `npm run seed` |
| **Variety seed** (`scripts/seedVariety.js`) | one NFT per authenticity status, for testing | seeded set |
| **This marketplace's own MongoDB** | every mint / list / sale users perform in the app | `models/Transaction.js`; drives the wash-ring graph |

**Why both real and synthetic?** Real data gives realistic price/volume baselines
and credibility, but you cannot *prove* a real wallet was wash trading, and
blue-chip collections contain no catchable fraud. Synthetic data provides
**labelled ground truth** (we planted the fraud, so we can measure precision and
recall) and is **deterministic**, satisfying the reliability requirement.

---

## Part C — "How is everything calculated?"

### 1. Unified risk score  (`services/riskScoreEngine.js`)
```
weighted = 0.40 × authRisk  +  0.35 × fraudRisk  +  0.25 × priceRisk
Risk     = max(weighted, escalationFloor)
```
Levels: **< 40 Low · 40–69 Medium · ≥ 70 High**.
All weights/cutoffs live in `config/thresholds.json` (no code change needed).

**Why the escalation term exists.** A pure weighted average caps every indicator at its
own weight, which is wrong for a fraud system: an NFT listed at 50× its collection median
scored `100 × 0.25 = 25` ("Low"), and a *proven* tampered asset scored `100 × 0.40 = 40`
("Medium"). No single decisive signal could ever reach High. The escalation lets the
strongest indicator set a **floor** on the final score.

Each indicator has its **own curve**, given as anchor points `[indicatorValue, floor]` in
`config/thresholds.json` and **linearly interpolated** between them:

| indicator | curve (value → floor) |
|---|---|
| authenticity | 100 → 92 |
| fraud | 45 → 40 · 80 → 50 · 100 → 75 |
| price | 45 → 40 · 70 → 55 · 90 → 75 · 100 → 92 |

```
floor  = max( curve_auth(authRisk), curve_fraud(fraudRisk), curve_price(priceRisk) )
Risk   = max(weighted, floor)
```

Two design points worth defending in a viva:

1. **Curves are per-indicator because the same number means different things.**
   `fraudRisk 90` is two self-transfers — routine in real mainnet data — while
   `priceRisk 90` is an asset listed at ~5× its collection median. An earlier shared
   table treated them identically and pushed 18 of 48 legitimate blue-chip tokens to High.
2. **Interpolation removes cliffs.** With discrete bands, a listing at 97 ETH scored 55
   ("Medium") while 100 ETH scored 75 ("High") — a 20-point jump for a 3 ETH difference.
   Interpolating makes the score rise smoothly with severity.

Measured distribution on the current dataset: **Low 24 / Medium 13 / High 11** (of 48),
with 24 tokens escalated (fraud 12, authenticity 8, price 4). Proven authenticity failures
(#33 Tampered, #37 Duplicate, #34 NonCompliant) all reach **92 High**; tokens carrying only
benign mainnet self-transfers settle at **50–63 Medium**.

### 2. Authenticity risk — binary, 3 layers (`services/authVerifier.js`)
`authRisk = 100` if **any** layer fails, else `0`. Authenticity is treated as
binary because a token that fails any layer is untrustworthy regardless of degree.

- **Layer 1 — ERC-165:** `supportsInterface(0x80ac58cd)` (ERC-721) OR `0xd9b67a26`
  (ERC-1155); also requires non-empty bytecode. → `NonCompliant`
- **Layer 2 — SHA-256 integrity:** `SHA256(canonical JSON of off-chain metadata)`
  compared to the on-chain anchor stored at mint. Any difference → `Tampered`
- **Layer 3 — perceptual hash:** Jimp pHash; `Jimp.compareHashes(a,b)` returns a
  normalised distance in [0,1]. `distance ≤ 0.15` → `Duplicate`
  (measured: exact copy = `0.000`; the same image rotated 90° = `0.273`)

### 3. Fraud risk — 4 heuristic rules (`services/fraudDetector.js`)
Sum of triggered penalties, capped at 100:

| Rule | Condition | Penalty |
|---|---|---|
| Buyer–Seller Loop | a wallet **pair** traded the token **≥ 3** times | 45 |
| Abnormal Frequency | ≥ 4 trades in 60 min **and** > 3× the collection's per-token baseline | 30 |
| Self-Transfer | `sender == recipient` on a SALE/TRANSFER | 80 (+10 each extra) |
| Rapid Price Escalation | consecutive sales jump **≥ 50%** within 60 min | 30 |

*Note:* self-transfer counts only SALE/TRANSFER — never LIST or MINT — otherwise
re-pricing your own listing would inflate the score.

### 4. Price anomaly risk (`services/priceAnalyzer.js`)
Robust **modified Z-score** (Iglewicz–Hoaglin), which resists a single extreme
sale inflating the spread and hiding itself:
```
Z = 0.6745 × (price − median) / MAD          (falls back to (price − mean)/stdDev when MAD = 0)
anomaly when |Z| > 2.5
priceRisk = 40 + 15 × (anomaly count) + 10 × (max|Z| − 2.5),  capped 100
```
MAD = median absolute deviation. Statistics are computed **per collection**, so each
collection has its own price range.

**Live listing-price anomaly (proactive).** A completed sale only flags fraud *after* a
victim has paid, so the asking price of a live listing is judged immediately — listing or
re-pricing an NFT recomputes its risk on the spot:
```
listingRisk = 45 + 10 × (|Z| − 2.5)          when |Z| > 2.5      (over-priced)
listingRisk = 45                              when price ≤ median ÷ 5   (under-priced)
priceRisk   = min(100, saleRisk + listingRisk)
```
Under-pricing needs the ratio rule because a Z-score **cannot** flag it: price is bounded
below by 0 while the median sits far above, so a "too cheap" listing (dumped stolen goods,
or a wash-trade setup) never reaches |Z| > 2.5. Requires ≥ 3 sales in the collection.

Measured on BoredApeYachtClub (median 19.99 ETH), on a token with no other flags:

| listed price | ×median | priceRisk | unified | level |
|---|---|---|---|---|
| 20 ETH   | 1.0×  | 0   | 0  | Low |
| 47 ETH   | 2.4×  | 45  | 40 | Medium |
| 100 ETH  | 5.0×  | 95  | 75 | High |
| 300 ETH  | 15×   | 100 | 92 | High |
| 0.5 ETH  | 0.03× | 45  | 40 | Medium |

### 5. Wash-trading ring detection (`services/graphAnalyzer.js`)
Build a **directed graph**: each sale is an edge *seller → buyer*, weighted by how
many times that pair repeated. Then run **Tarjan's Strongly-Connected-Components**
(iterative) to find every cycle — self-loops (length 1), reciprocal pairs
(length 2), and multi-hop rings (length ≥ 3) that pairwise rules cannot see.

Per ring:
```
reciprocity = (edges that are reciprocated) / (edges in ring)
intensity   = (total trades in ring) / (edges in ring)
washScore   = 60 × reciprocity
            + 40 × min(1, max(0, intensity − 1))
            + 20  if the ring has ≤ 4 wallets
            (capped at 100)
```
Rationale: tight, highly reciprocal, repeatedly-traded small rings score high;
large loose clusters (normal circulation) score low.

Per wallet shown in the ring graph:
`washScore = min(100, 30 + 18 × (reciprocal partners) + 4 × (trades))`

### 6. Why a graph *and* rules?
The rules are fast and explainable but **pairwise** — they cannot see
A→B→C→A where no single pair looks abnormal. The graph engine catches exactly
those; `analyzeGraph()` even reports `extraCaughtByGraph`, the wallets the graph
flags that the heuristics miss.

---

## Part D — Likely follow-up questions

**"Could someone fake authenticity and pass all three layers?"**
Yes, and this is the honest limitation. Deploy a genuinely ERC-721-compliant
contract (Layer 1 ✓), mint metadata whose hash matches itself (Layer 2 ✓), and use
artwork that is perceptually distinct from anything indexed (Layer 3 ✓). The system
verifies **integrity, standards-compliance and image-uniqueness — not provenance**.
It never asks *"is this the official contract / the real artist?"* The missing
defence is a **verified-issuer allowlist** (like OpenSea's blue check) plus
first-mint/provenance analysis → Future Work.

**"How can Layer 3 be evaded?"** pHash is not rotation- or flip-invariant. Measured:
an exact copy scores 0.000 (caught) but a 90° rotation scores 0.273 (missed, since
the threshold is 0.15). Mitigation: rotation-invariant descriptors or a CNN
embedding (the project's `ml/resnet_duplicate.py` explores this).

**"Is `supportsInterface` trustworthy?"** No — it is **self-reported**. A malicious
contract can return `true` while behaving badly. It proves the interface is
*declared*, not that the contract is *honest*.

**"Is the output reproducible?"** Yes. Re-running verification re-derives the
result from stored data rather than caching, so the same input always yields the
same verdict — a stated reliability requirement.
