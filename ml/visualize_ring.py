# -*- coding: utf-8 -*-
"""Visualise the largest wash-trading ring (strongly connected component) as a
network diagram — a real, on-chain wash cluster for the report/slide."""
import glob, os
import pandas as pd
import networkx as nx
import matplotlib
matplotlib.use("Agg")            # headless save, no display needed
import matplotlib.pyplot as plt

DATA = max(glob.glob("data/sales_raw*.csv"), key=os.path.getmtime)
df = pd.read_csv(DATA)
df = df[df["price_eth"] > 0].dropna(subset=["buyer", "seller"])
df["buyer"] = df["buyer"].str.lower(); df["seller"] = df["seller"].str.lower()

G = nx.DiGraph()
for (s, b), grp in df.groupby(["seller", "buyer"]):
    G.add_edge(s, b, weight=int(len(grp)))

# largest strongly connected component = the wash ring
ring = max((c for c in nx.strongly_connected_components(G) if len(c) > 1), key=len)
H = G.subgraph(ring).copy()
trades = sum(d["weight"] for *_, d in H.edges(data=True))
print(f"Ring: {H.number_of_nodes()} wallets, {H.number_of_edges()} edges, {trades} trades")

deg = dict(H.degree(weight="weight"))
sizes = [90 + deg[n] * 55 for n in H.nodes()]
colors = [deg[n] for n in H.nodes()]
ew = [0.4 + H[u][v]["weight"] * 1.1 for u, v in H.edges()]

plt.figure(figsize=(13, 11), facecolor="#0a0f18")
ax = plt.gca(); ax.set_facecolor("#0a0f18")
pos = nx.spring_layout(H, k=0.62, iterations=150, seed=42)
nx.draw_networkx_edges(H, pos, width=ew, edge_color="#00FF88", alpha=0.22,
                       arrowsize=8, arrowstyle="-|>", connectionstyle="arc3,rad=0.09")
nx.draw_networkx_nodes(H, pos, node_size=sizes, node_color=colors, cmap="plasma",
                       edgecolors="#0a0f18", linewidths=0.6)
top = sorted(deg, key=deg.get, reverse=True)[:6]     # label the busiest hubs
nx.draw_networkx_labels(H, pos, labels={n: n[:6] + "…" for n in top},
                        font_size=8, font_color="#e8eef7", font_family="monospace")
plt.title(f"NFT wash-trading ring — {H.number_of_nodes()} wallets · {trades} trades cycling among them\n"
          "a strongly-connected cluster in real Ethereum sales (invisible to pairwise rules)",
          color="#e8eef7", fontsize=13, pad=16)
plt.axis("off"); plt.tight_layout()
out = "data/wash_ring.png"
plt.savefig(out, dpi=160, facecolor="#0a0f18", bbox_inches="tight")
print("saved", out)
