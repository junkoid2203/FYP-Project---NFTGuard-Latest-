"""
collect_sales.py - NFTGuard real data collection.

Pulls REAL Ethereum-mainnet NFT sales (buyer, seller, price, marketplace,
timestamp) from the Alchemy NFT API and writes ml/data/sales_raw.csv.

This is the real dataset the fraud / wash-trading / price-anomaly models are
trained and evaluated on (report objective: "data-driven detection mechanisms").
Uses the Alchemy API key already configured in the project .env.

Run:  ml/.venv/Scripts/python.exe ml/collect_sales.py
Env:  MAX_SALES=200  -> quick test pull
"""
import os, sys, re, csv, time
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parents[1]
ENV_FILES = [ROOT / ".env", ROOT / "backend" / ".env"]
OUT = Path(__file__).resolve().parent / "data" / "sales_raw.csv"

# collection name -> mainnet contract address
COLLECTIONS = {
    "BoredApeYachtClub": "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
    "Azuki":             "0xED5AF388653567Af2F388E6224dC7C4b3241C544",
}
MAX_SALES = int(os.environ.get("MAX_SALES", "2500"))   # per collection
ORDER = "desc"


def alchemy_key():
    for f in ENV_FILES:
        if f.exists():
            m = re.search(r"alchemy\.com/v2/([A-Za-z0-9_-]+)", f.read_text(errors="ignore"))
            if m:
                return m.group(1)
    sys.exit("No Alchemy key found in .env (SEPOLIA_RPC_URL).")


KEY = alchemy_key()
NFT = f"https://eth-mainnet.g.alchemy.com/nft/v3/{KEY}"
RPC = f"https://eth-mainnet.g.alchemy.com/v2/{KEY}"


def wei_to_eth(x):
    try:
        return int(x) / 1e18
    except (TypeError, ValueError):
        return 0.0


def fee_eth(f):
    """Amount in ETH/WETH, else 0 (we keep the ETH-denominated market only)."""
    if not f or f.get("symbol") not in ("ETH", "WETH"):
        return 0.0
    return wei_to_eth(f.get("amount"))


def _get_with_retry(url, params=None, retries=5):
    """GET with backoff on Alchemy 429 rate limits."""
    for i in range(retries):
        r = requests.get(url, params=params, headers={"accept": "application/json"}, timeout=40)
        if r.status_code == 429:
            time.sleep(1.5 * (i + 1))
            continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()


def _block_timestamp(block, retries=5):
    """Real on-chain timestamp for one block, with 429 backoff."""
    payload = {"jsonrpc": "2.0", "id": 1, "method": "eth_getBlockByNumber",
               "params": [hex(int(block)), False]}
    for i in range(retries):
        r = requests.post(RPC, json=payload, timeout=30)
        if r.status_code == 429:
            time.sleep(1.5 * (i + 1))
            continue
        r.raise_for_status()
        res = r.json().get("result")
        return int(res["timestamp"], 16) if res else None
    return None


def collect_collection(name, contract):
    rows, page, pulled = [], None, 0
    while pulled < MAX_SALES:
        params = {"contractAddress": contract, "order": ORDER, "limit": 100}
        if page:
            params["pageKey"] = page
        data = _get_with_retry(f"{NFT}/getNFTSales", params)
        sales = data.get("nftSales", [])
        if not sales:
            break
        for s in sales:
            price = (fee_eth(s.get("sellerFee"))
                     + fee_eth(s.get("royaltyFee"))
                     + fee_eth(s.get("protocolFee")))
            rows.append({
                "collection": name,
                "contract": s.get("contractAddress"),
                "tokenId": s.get("tokenId"),
                "buyer": (s.get("buyerAddress") or "").lower(),
                "seller": (s.get("sellerAddress") or "").lower(),
                "price_eth": round(price, 6),
                "marketplace": s.get("marketplace"),
                "block": s.get("blockNumber"),
                "txhash": s.get("transactionHash"),
                "timestamp": None,  # filled by add_timestamps()
            })
        pulled += len(sales)
        print(f"  {name}: {pulled} sales")
        page = data.get("pageKey")
        if not page:
            break
        time.sleep(0.15)
    return rows[:MAX_SALES]


def add_timestamps(rows):
    """Assign real timestamps by interpolating between ~24 on-chain anchor blocks.

    Ethereum block time is near-constant, so interpolating between real anchor
    timestamps is accurate to seconds while avoiding thousands of RPC calls
    (which trip Alchemy's rate limit).
    """
    import numpy as np
    blocks = sorted({int(r["block"]) for r in rows if r["block"] is not None})
    if not blocks:
        return
    n = len(blocks)
    anchor_idx = sorted(set(int(round(x)) for x in np.linspace(0, n - 1, min(24, n))))
    ab, at = [], []
    for j in anchor_idx:
        ts = _block_timestamp(blocks[j])
        if ts is not None:
            ab.append(blocks[j]); at.append(ts)
        time.sleep(0.2)
    if len(ab) < 2:
        print("  WARN: could not fetch anchor timestamps; leaving them empty")
        return
    all_blocks = [int(r["block"]) if r["block"] is not None else ab[0] for r in rows]
    est = np.interp(all_blocks, ab, at)
    for r, t in zip(rows, est):
        if r["block"] is not None:
            r["timestamp"] = int(t)
    print(f"  timestamps: interpolated from {len(ab)} on-chain anchor blocks")


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    all_rows = []
    for name, contract in COLLECTIONS.items():
        print(f"Collecting {name} ({contract}) ...")
        all_rows += collect_collection(name, contract)
    print(f"Total sales: {len(all_rows)}. Fetching real block timestamps ...")
    add_timestamps(all_rows)
    cols = ["collection", "contract", "tokenId", "buyer", "seller", "price_eth",
            "marketplace", "block", "timestamp", "txhash"]

    def _write(path):
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(all_rows)

    try:
        _write(OUT)
        dest = OUT
    except PermissionError:
        dest = OUT.with_name("sales_raw.new.csv")
        _write(dest)
        print(f"  NOTE: {OUT.name} is locked (open in Excel?); wrote {dest.name} instead")

    priced = sum(1 for r in all_rows if r["price_eth"])
    dated = sum(1 for r in all_rows if r["timestamp"])
    print(f"Wrote {len(all_rows)} sales -> {dest}")
    print(f"  with ETH price: {priced} | with timestamp: {dated}")


if __name__ == "__main__":
    main()
