# -*- coding: utf-8 -*-
"""
graph_wash_detection.py — wash-trading detection via TRANSACTION-GRAPH STRUCTURE
(moving beyond hardcoded pairwise rules).

Builds a directed graph of wallets (edge = seller -> buyer) from the real sales
data and finds wash-trading structure with graph algorithms:
  - self-loops                 (wallet sells an NFT to itself)
  - reciprocal pairs (A<->B)   (2-cycles = the classic pairwise wash)
  - strongly connected comps   (multi-hop rings A->B->C->A that pairwise rules MISS)

Then it compares what the graph catches vs the old pairwise heuristic.
Uses networkx.  Run:  ml/.venv/Scripts/python.exe ml/graph_wash_detection.py
"""
import glob, os
import pandas as pd
import networkx as nx

DATA = max(glob.glob("data/sales_raw*.csv"), key=os.path.getmtime)
df = pd.read_csv(DATA)
df = df[df["price_eth"] > 0].dropna(subset=["buyer", "seller"])
df["buyer"] = df["buyer"].str.lower()
df["seller"] = df["seller"].str.lower()
print(f"Loaded {len(df)} real sales from {os.path.basename(DATA)}")

# --- build the directed wallet graph (edge weight = number of seller->buyer trades) ---
G = nx.DiGraph()
for (s, b), grp in df.groupby(["seller", "buyer"]):
    G.add_edge(s, b, weight=int(len(grp)))
print(f"Graph: {G.number_of_nodes()} wallets, {G.number_of_edges()} directed trade-edges\n")

# --- 1. self-loops (wallet sold to itself) ---
self_loops = list(nx.nodes_with_selfloops(G))

# --- 2. reciprocal pairs (A<->B) ---
recip = {tuple(sorted((u, v))) for u, v in G.edges() if u != v and G.has_edge(v, u)}

# --- 3. strongly connected components = wash rings (including multi-hop) ---
sccs = sorted([c for c in nx.strongly_connected_components(G) if len(c) > 1], key=len, reverse=True)
ring_wallets = set().union(*sccs) if sccs else set()
multihop = [c for c in sccs if len(c) > 2]      # rings a pairwise rule cannot see

print("=== GRAPH-BASED WASH-TRADING FINDINGS ===")
print(f"  self-loops (sold to self)     : {len(self_loops)} wallets")
print(f"  reciprocal pairs (A<->B)      : {len(recip)}")
print(f"  wash rings / clusters (SCC>1) : {len(sccs)}  covering {len(ring_wallets)} wallets")
print(f"  MULTI-HOP rings (SCC>2)       : {len(multihop)}   <- invisible to pairwise rules")
if sccs:
    print("  largest rings:")
    for c in sccs[:5]:
        sub = G.subgraph(c)
        trades = sum(d["weight"] for *_, d in sub.edges(data=True))
        print(f"    - {len(c)} wallets, {sub.number_of_edges()} edges, {trades} trades between them")

# --- compare to the OLD pairwise heuristic (a pair that traded >=3 times) ---
pair_counts = {}
for (s, b), grp in df.groupby(["seller", "buyer"]):
    k = tuple(sorted((s, b)))
    pair_counts[k] = pair_counts.get(k, 0) + len(grp)
heur_pairs = {k for k, n in pair_counts.items() if n >= 3 and k[0] != k[1]}
heur_wallets = set().union(*heur_pairs) if heur_pairs else set()

graph_flagged = ring_wallets | set(self_loops)
print("\n=== GRAPH vs OLD PAIRWISE HEURISTIC ===")
print(f"  old pairwise heuristic flags : {len(heur_wallets)} wallets")
print(f"  graph flags                  : {len(graph_flagged)} wallets")
print(f"  caught by GRAPH but MISSED by heuristic : {len(graph_flagged - heur_wallets)} wallets")
