/**
 * chatAssistant.js — NFTGuard AI assistant (real LLM, via Claude).
 *
 * Design goal: NEVER crash or hang the server.
 *  - The Anthropic SDK is loaded lazily and defensively; a missing package or
 *    missing ANTHROPIC_API_KEY simply falls back to a built-in scripted helper.
 *  - Every LLM call is wrapped so an API/network error degrades to the fallback
 *    instead of throwing. The chat widget therefore always gets a reply.
 */

const MODEL = process.env.CHAT_MODEL || "claude-opus-5";

let _client = null;
let _tried = false;

function getClient() {
  if (_tried) return _client;
  _tried = true;
  if (!process.env.ANTHROPIC_API_KEY) return null; // no key -> scripted fallback
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  } catch (e) {
    console.warn("[chat] @anthropic-ai/sdk unavailable, using fallback:", e.message);
    _client = null;
  }
  return _client;
}

function buildSystemPrompt(ctx) {
  const nfts = (ctx && ctx.nfts) || [];
  const lines = nfts
    .map(n => `  #${n.id} "${n.name}" (${n.collection}) — authenticity: ${n.status}, risk: ${n.risk}${n.score != null ? ` ${n.score}/100` : ""}`)
    .join("\n");
  return `You are "NFTGuard Assistant", a friendly AI helper built into the NFTGuard NFT marketplace and fraud-detection prototype.

WHAT NFTGUARD DOES
NFTGuard is an NFT marketplace with built-in authenticity verification, heuristic fraud detection, price-anomaly analytics, and a unified 0–100 risk score.
Risk score = 0.40·Authenticity + 0.35·Fraud + 0.25·Price anomaly. Levels: below 40 = Low, 40–69 = Medium, 70+ = High.

HOW DETECTION WORKS (explain simply when asked)
- Authenticity: on-chain SHA-256 metadata anchor, ERC-165 contract check, IPFS metadata compare, and perceptual-hash (pHash) duplicate / copy-mint detection.
- Fraud: four heuristic rules — buyer↔seller loop (wash trading), abnormal trade frequency, self-transfer, and rapid price escalation — PLUS a transaction-graph wash-ring detector (Tarjan strongly-connected components) that catches multi-wallet wash-trading rings the simple pairwise rules miss.
- Price transparency: average / median / standard deviation and Z-score anomaly flags (|Z| > 2.5).

YOUR JOB
Help users understand NFT risk, explain how the checks work, interpret a specific NFT's score, and guide them around the marketplace (searching, filtering by risk, minting, buying). Be concise, warm, and plain-spoken. If someone asks about live data, use the snapshot below.

LIVE SNAPSHOT
${(ctx && ctx.totalNfts) ?? "?"} NFTs indexed · ${(ctx && ctx.highRisk) ?? "?"} high-risk · ${(ctx && ctx.totalFlags) ?? "?"} fraud flags raised.
NFTs currently listed:
${lines || "  (none loaded)"}

STYLE
Keep replies short (2–5 sentences) unless asked for detail. Do not include internal or system XML tags in your response. You are a demo assistant, not a financial advisor — never give investment advice; if asked whether to buy for profit, explain you only assess authenticity/fraud risk.`;
}

/* ---- built-in scripted fallback (works with no API key, never fails) ---- */
function scriptedReply(messages, ctx) {
  const last = [...messages].reverse().find(m => m.role === "user");
  const q = (last ? last.content : "").toLowerCase();
  const nfts = (ctx && ctx.nfts) || [];
  const has = (...k) => k.some(w => q.includes(w));

  if (has("highest", "riskiest", "most risky", "worst")) {
    const top = [...nfts].filter(n => n.score != null).sort((a, b) => b.score - a.score)[0];
    if (top) return `The highest-risk NFT right now is #${top.id} "${top.name}" (${top.collection}) at ${top.score}/100 — ${top.risk} risk. Open its card in the marketplace to see the exact authenticity, fraud, and price breakdown.`;
  }
  if (has("how many", "stats", "total", "overview")) {
    return `Right now: ${ctx?.totalNfts ?? "?"} NFTs indexed, ${ctx?.highRisk ?? 0} flagged High-risk, and ${ctx?.totalFlags ?? 0} fraud flags raised across all transaction histories.`;
  }
  if (has("wash", "loop", "ring")) {
    return `Wash trading is when the same wallets trade an NFT back and forth to fake volume/price. NFTGuard catches it two ways: a heuristic rule flags any wallet pair that trades a token 3+ times, and a transaction-graph detector (Tarjan strongly-connected components) finds larger multi-wallet rings that the pairwise rule misses.`;
  }
  if (has("authentic", "verify", "fake", "duplicate", "copy", "stolen", "phash", "hash")) {
    return `Authenticity is checked by anchoring the metadata's SHA-256 hash on-chain, verifying the contract is ERC-721, and comparing a perceptual hash (pHash) of the image against every minted asset to catch duplicates and copy-mints. A mismatch marks the NFT "Tampered" or "Duplicate".`;
  }
  if (has("price", "anomaly", "z-score", "zscore")) {
    return `Price transparency computes the average, median and standard deviation of a collection's sales, then flags any sale where the Z-score exceeds 2.5 (well outside normal range) as a price anomaly. That contributes 25% of the risk score.`;
  }
  if (has("risk", "score", "how is", "calculated", "formula")) {
    return `The 0–100 risk score = 0.40·Authenticity + 0.35·Fraud + 0.25·Price anomaly. Below 40 is Low (green), 40–69 is Medium (amber), 70+ is High (red). Click any NFT to see each component broken out.`;
  }
  if (has("hi", "hello", "hey", "help", "what can you", "who are you")) {
    return `Hi! I'm the NFTGuard assistant. I can explain how risk scores, wash-trading detection, authenticity checks and price anomalies work, tell you the riskiest NFTs right now, or help you navigate the marketplace. What would you like to know?`;
  }
  return `I can help with NFTGuard's risk scores, wash-trading / fraud detection, authenticity checks, and price anomalies — or point you to the riskiest NFTs on the marketplace. Try asking "how is the risk score calculated?" or "which NFT is riskiest?"`;
}

async function handleChat(messages, context) {
  // sanitize: keep only well-formed user/assistant text turns, cap length & count
  let clean = (Array.isArray(messages) ? messages : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (clean.length && clean[0].role !== "user") clean.shift(); // API needs a leading user turn

  if (!clean.length) {
    return { reply: "Hi! I'm the NFTGuard assistant. Ask me about an NFT's risk score, how wash-trading or authenticity checks work, or anything on the marketplace.", mode: "fallback" };
  }

  const client = getClient();
  if (!client) return { reply: scriptedReply(clean, context), mode: "fallback" };

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: "disabled" }, // snappy chat; no tools so this is safe
      system: buildSystemPrompt(context),
      messages: clean,
    });
    const text = (resp.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();
    return { reply: text || scriptedReply(clean, context), mode: "llm" };
  } catch (e) {
    console.warn("[chat] LLM error, falling back:", e.message);
    return { reply: scriptedReply(clean, context), mode: "fallback" };
  }
}

module.exports = { handleChat };
