/**
 * graphAnalyzer.js — wash-trading detection via TRANSACTION-GRAPH STRUCTURE.
 *
 * Builds a directed wallet graph (seller -> buyer) from THIS marketplace's own
 * transactions and finds wash structure with Tarjan's Strongly-Connected-Components:
 *   - self-loops                (wallet sells an NFT to itself)
 *   - reciprocal pairs (A<->B)  (2-cycles)
 *   - SCC rings                 (multi-hop A->B->C->A rings pairwise rules can't see)
 * Each ring is scored on reciprocity + trade intensity. Computed on demand.
 */
/** Tarjan's SCC (iterative — safe for thousands of nodes). */
function tarjanSCC(adj, nodes) {
  const idx = new Map(), low = new Map(), onStack = new Set(), stack = [], sccs = [];
  let index = 0;
  for (const start of nodes) {
    if (idx.has(start)) continue;
    const work = [[start, 0]];                 // manual DFS stack: [node, childPointer]
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, pi] = frame;
      if (pi === 0) { idx.set(v, index); low.set(v, index); index++; stack.push(v); onStack.add(v); }
      const neigh = adj.get(v) || [];
      if (pi < neigh.length) {
        frame[1]++;
        const w = neigh[pi];
        if (!idx.has(w)) work.push([w, 0]);
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
      } else {
        if (low.get(v) === idx.get(v)) {
          const comp = []; let w;
          do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
          sccs.push(comp);
        }
        work.pop();
        if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(low.get(p), low.get(v))); }
      }
    }
  }
  return sccs;
}

/**
 * analyzeMarketGraph — same Tarjan-SCC wash-ring detection, but on THIS
 * marketplace's own transactions (MongoDB) instead of the external CSV.
 * Returns the top ring's actual wallets + edges so the dashboard can draw it.
 */
async function analyzeMarketGraph() {
  const Transaction = require("../models/Transaction");
  const rows = await Transaction.find({ txType: "SALE" }).lean();

  const adj = new Map(), weight = new Map(), nodesSet = new Set(), tradeCount = {};
  for (const r of rows) {
    const s = (r.senderAddress || "").toLowerCase(), b = (r.recipientAddress || "").toLowerCase();
    if (!s || !b) continue;
    nodesSet.add(s); nodesSet.add(b);
    if (!adj.has(s)) adj.set(s, new Set());
    adj.get(s).add(b);
    const k = s + ">" + b; weight.set(k, (weight.get(k) || 0) + 1);
    tradeCount[s] = (tradeCount[s] || 0) + 1; tradeCount[b] = (tradeCount[b] || 0) + 1;
  }
  const adjArr = new Map(); for (const [k, set] of adj) adjArr.set(k, [...set]);
  const nodes = [...nodesSet];

  const sccs = tarjanSCC(adjArr, nodes).filter(c => c.length > 1).sort((a, b) => b.length - a.length);

  const ringStats = comp => {
    const set = new Set(comp); let e = 0, t = 0, recipE = 0;
    for (const s of comp) for (const b of (adjArr.get(s) || [])) if (set.has(b)) {
      e++; t += weight.get(s + ">" + b) || 0;
      if ((adjArr.get(b) || []).includes(s)) recipE++;
    }
    const reciprocity = e ? recipE / e : 0;
    const intensity = e ? t / e : 0;
    const washScore = Math.round(Math.min(100,
      60 * reciprocity + 40 * Math.min(1, Math.max(0, intensity - 1)) + (comp.length <= 4 ? 20 : 0)));
    return { wallets: comp, size: comp.length, edges: e, trades: t, reciprocity: Number(reciprocity.toFixed(2)), washScore };
  };
  const rings = sccs.map(ringStats).sort((a, b) => b.size - a.size || b.washScore - a.washScore);

  const top = rings[0];
  let gNodes = [], gEdges = [];
  if (top) {
    const set = new Set(top.wallets);
    gNodes = top.wallets.map(w => {
      let recip = 0;
      top.wallets.forEach(o => { if (o !== w && (adjArr.get(w) || []).includes(o) && (adjArr.get(o) || []).includes(w)) recip++; });
      const ws = Math.min(100, Math.round(30 + recip * 18 + (tradeCount[w] || 0) * 4));
      return { address: w, trades: tradeCount[w] || 0, washScore: ws };
    });
    for (const [k, wt] of weight) {
      const [f, t2] = k.split(">");
      if (set.has(f) && set.has(t2)) gEdges.push({ from: f, to: t2, trades: wt });
    }
  }

  return {
    totalSales: rows.length,
    wallets: nodes.length,
    ringCount: rings.length,
    topRings: rings.slice(0, 6).map(r => ({ size: r.size, trades: r.trades, reciprocity: r.reciprocity, washScore: r.washScore })),
    graph: { nodes: gNodes, edges: gEdges, washScore: top ? top.washScore : 0 },
  };
}

module.exports = { analyzeMarketGraph };
