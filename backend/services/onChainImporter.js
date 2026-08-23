/**
 * onChainImporter.js — import a REAL NFT from a public EVM chain and run it
 * through the authenticity pipeline.
 *
 * Why this exists: the old demo dropdown ("pick a flaw") proved the comparison
 * logic but not the DETECTION, because the fault was declared rather than
 * discovered. Importing a live token instead makes two layers genuine:
 *
 *   Layer 1  real ERC-165 supportsInterface() call against the chain the
 *            contract actually lives on
 *   Layer 3  real perceptual hash of the real artwork — importing the same
 *            asset twice is genuinely caught as a copy-mint
 *   Layer 2  NOT APPLICABLE and reported as such: third-party contracts do not
 *            store NFTGuard's on-chain SHA-256 metadata anchor, so there is no
 *            baseline to compare against. We never fake a pass here.
 *
 * MULTI-CHAIN: a contract pasted from Polygonscan/Basescan does not exist at
 * that address on Ethereum, so checking only Ethereum reported a perfectly good
 * NFT as "NonCompliant". We now auto-detect which chain holds the bytecode.
 * Public RPCs are used (no API key required); Alchemy is used for richer
 * metadata on Ethereum only, since the project key is Ethereum-only.
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const Nft = require("../models/Nft");
const Transaction = require("../models/Transaction");

const INTERFACE_IDS = { ERC721: "0x80ac58cd", ERC1155: "0xd9b67a26" };

/** Chains we probe, in priority order (Ethereum first — same address can exist elsewhere). */
const CHAINS = [
  { key: "ethereum", label: "Ethereum",  rpc: "https://ethereum-rpc.publicnode.com",       explorer: "https://etherscan.io",            osSlug: "ethereum" },
  { key: "polygon",  label: "Polygon",   rpc: "https://polygon-bor-rpc.publicnode.com",    explorer: "https://polygonscan.com",         osSlug: "matic"    },
  { key: "base",     label: "Base",      rpc: "https://base-rpc.publicnode.com",           explorer: "https://basescan.org",            osSlug: "base"     },
  { key: "arbitrum", label: "Arbitrum",  rpc: "https://arbitrum-one-rpc.publicnode.com",   explorer: "https://arbiscan.io",             osSlug: "arbitrum" },
  { key: "optimism", label: "Optimism",  rpc: "https://optimism-rpc.publicnode.com",       explorer: "https://optimistic.etherscan.io", osSlug: "optimism" },
];

const coder = ethers.AbiCoder.defaultAbiCoder();
const selector = sig => ethers.id(sig).slice(0, 10);

/** Minimal JSON-RPC call with a hard timeout (avoids ethers' endless retry loop). */
async function rpcCall(url, method, params, ms = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "RPC error");
    return j.result;
  } finally { clearTimeout(timer); }
}

async function supportsInterface(rpc, contract, interfaceId) {
  try {
    const data = selector("supportsInterface(bytes4)") + interfaceId.slice(2).padEnd(64, "0");
    const res = await rpcCall(rpc, "eth_call", [{ to: contract, data }, "latest"]);
    return typeof res === "string" && /1$/.test(res);
  } catch (_) { return false; }
}

/**
 * LAYER 1, for real: find the chain holding this contract, then ask it whether
 * it declares ERC-721 / ERC-1155 via ERC-165.
 */
async function checkChainCompliance(contract) {
  const triedChains = [];
  for (const chain of CHAINS) {
    let code;
    try { code = await rpcCall(chain.rpc, "eth_getCode", [contract, "latest"]); }
    catch (_) { triedChains.push(chain.label + " (unreachable)"); continue; }
    triedChains.push(chain.label);
    if (!code || code === "0x") continue;                       // not on this chain

    const [erc721, erc1155] = await Promise.all([
      supportsInterface(chain.rpc, contract, INTERFACE_IDS.ERC721),
      supportsInterface(chain.rpc, contract, INTERFACE_IDS.ERC1155),
    ]);
    const compliant = erc721 || erc1155;
    return {
      checked: true, found: true, bytecode: true, chain: chain.key, chainLabel: chain.label,
      explorer: `${chain.explorer}/address/${contract}`,
      openseaBase: chain.osSlug, erc721, erc1155, compliant,
      source: `${chain.label} · ERC-165 supportsInterface()`,
      reason: compliant ? undefined
        : "Contract does not declare ERC-721 (0x80ac58cd) or ERC-1155 (0xd9b67a26)",
    };
  }
  return { checked: true, found: false, bytecode: false, compliant: false, triedChains,
           reason: `No contract bytecode found at this address on ${triedChains.join(", ")}` };
}

/** Alchemy key (Ethereum only): explicit env var, else parsed from an RPC URL in .env. */
function alchemyKey() {
  if (process.env.ALCHEMY_KEY) return process.env.ALCHEMY_KEY;
  const candidates = [process.env.MAINNET_RPC_URL, process.env.SEPOLIA_RPC_URL];
  for (const f of [path.join(__dirname, "..", "..", ".env"), path.join(__dirname, "..", ".env")]) {
    try { candidates.push(fs.readFileSync(f, "utf8")); } catch (_) {}
  }
  for (const c of candidates) {
    const m = c && String(c).match(/alchemy\.com\/v2\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
  }
  return null;
}

const ipfs = u => (u || "").startsWith("ipfs://")
  ? (process.env.PINATA_GATEWAY || "https://ipfs.io/ipfs/") + u.replace("ipfs://", "")
  : u;

/** Rich metadata via Alchemy — Ethereum only (the project key is not enabled elsewhere). */
async function fetchViaAlchemy(contract, tokenId) {
  const key = alchemyKey();
  if (!key) return null;
  const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${key}/getNFTMetadata`
            + `?contractAddress=${contract}&tokenId=${tokenId}&refreshCache=false`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) return null;
  const j = await r.json();
  const img = j.image || {};
  const raw = (j.raw && j.raw.metadata) || {};
  const traits = {};
  if (Array.isArray(raw.attributes)) raw.attributes.forEach(a => { if (a && a.trait_type != null) traits[a.trait_type] = a.value; });
  return {
    name: j.name || raw.name || "",
    // pngUrl/thumbnailUrl are converted by Alchemy: browser-displayable AND Jimp-readable.
    // cachedUrl can be APNG, which Jimp cannot decode (silently breaking Layer 3).
    image: img.pngUrl || img.thumbnailUrl || img.cachedUrl || img.originalUrl || "",
    traits,
    collection: (j.contract && (j.contract.name || j.contract.symbol)) || "",
    tokenURI: (j.tokenUri && (j.tokenUri.raw || j.tokenUri)) || "",
  };
}

/** Chain-agnostic fallback: read tokenURI()/uri() straight from the contract. */
async function fetchViaTokenUri(rpc, contract, tokenId) {
  const encodedId = coder.encode(["uint256"], [tokenId]).slice(2);
  let uri = "";
  for (const sig of ["tokenURI(uint256)", "uri(uint256)"]) {
    try {
      const res = await rpcCall(rpc, "eth_call", [{ to: contract, data: selector(sig) + encodedId }, "latest"]);
      if (res && res !== "0x") { uri = coder.decode(["string"], res)[0]; break; }
    } catch (_) {}
  }
  if (!uri) return { name: "", image: "", traits: {}, collection: "", tokenURI: "" };

  // ERC-1155 metadata spec: "{id}" must be substituted with the token id in LOWERCASE
  // HEX, zero-padded to 64 characters, with no 0x prefix. Substituting the decimal id
  // fetches the wrong URL — usually a generic default file, which is why every token
  // then came back with the same name/image.
  const hexId = BigInt(tokenId).toString(16).padStart(64, "0");
  const resolved = uri.includes("{id}")
    ? uri.replace(/\{id\}/g, hexId)
    : uri;

  let meta = {};
  for (const candidate of [resolved, uri.replace(/\{id\}/g, String(tokenId))]) {
    try {
      const r = await fetch(ipfs(candidate), { headers: { accept: "application/json" } });
      if (r.ok) { meta = await r.json(); break; }
    } catch (_) {}
    if (candidate === uri) break;   // no {id} template — nothing else to try
  }

  const traits = {};
  if (Array.isArray(meta.attributes)) meta.attributes.forEach(a => { if (a && a.trait_type != null) traits[a.trait_type] = a.value; });
  return {
    name: meta.name || "",
    image: ipfs(meta.image || meta.image_url || ""),
    traits, collection: "", tokenURI: uri,
  };
}

/** Contract-level name() for a nicer collection label. */
async function readName(rpc, contract) {
  try {
    const res = await rpcCall(rpc, "eth_call", [{ to: contract, data: selector("name()") }, "latest"]);
    if (res && res !== "0x") return coder.decode(["string"], res)[0];
  } catch (_) {}
  return "";
}

/**
 * Import one real on-chain NFT. Re-importing the SAME contract+token is allowed
 * on purpose — that is exactly how the genuine copy-mint (Layer 3) demo works.
 */
async function importOnChainNft(contract, tokenId) {
  // Explorers display addresses in mixed-case (EIP-55 checksum). A copy/paste that
  // loses or alters that casing is still a perfectly valid address, so fall back to
  // the lower-cased form rather than rejecting the user's input outright.
  if (!ethers.isAddress(contract)) {
    const lower = String(contract).trim().toLowerCase();
    if (ethers.isAddress(lower)) contract = lower;
    else throw new Error("That is not a valid EVM contract address (expected 0x followed by 40 hex characters)");
  }

  const compliance = await checkChainCompliance(contract);
  if (!compliance.found) {
    throw new Error(compliance.reason + ". Check the address, and that its chain is one of: "
      + CHAINS.map(c => c.label).join(", ") + ".");
  }
  const chain = CHAINS.find(c => c.key === compliance.chain);

  let meta = null;
  if (chain.key === "ethereum") { try { meta = await fetchViaAlchemy(contract, tokenId); } catch (_) {} }
  if (!meta || (!meta.image && !meta.name)) {
    try { meta = await fetchViaTokenUri(chain.rpc, contract, tokenId); } catch (_) {}
  }
  meta = meta || { name: "", image: "", traits: {}, collection: "", tokenURI: "" };
  if (!meta.collection) meta.collection = await readName(chain.rpc, contract);

  const last = await Nft.findOne().sort({ tokenId: -1 }).lean();
  const newId = (last ? last.tokenId : 0) + 1;
  const collectionName = meta.collection || `Imported (${chain.label})`;
  // Some collections (ERC-1155 packs/editions especially) return the SAME name for every
  // token, so imports were indistinguishable in the marketplace. Always carry the token
  // id unless the metadata name already includes it.
  const baseName = meta.name || collectionName;
  const name = new RegExp(`#\\s*${tokenId}\\b`).test(baseName)
    ? baseName
    : `${baseName} #${tokenId}`;

  const nft = await Nft.create({
    tokenId: newId,
    name,
    description: `Imported from ${chain.label} · contract ${contract} · token #${tokenId}`,
    image: meta.image,
    tokenURI: meta.tokenURI || "",
    contractAddress: contract,
    // No NFTGuard anchor exists for a third-party contract — leave both blank so
    // Layer 2 is reported as N/A rather than silently "matching".
    metadataHash: "",
    offChainMetadataHash: "",
    erc721Compliant: Boolean(compliance.compliant),
    collectionName,
    creatorAddress: contract,
    ownerAddress: contract,
    listed: false,
    priceEth: 0,
    traits: meta.traits || {},
    external: true,
    externalContract: contract,
    externalTokenId: String(tokenId),
    externalChain: chain.label,
    chainCompliance: compliance,
  });

  await Transaction.create({
    tokenId: newId,
    collectionName,
    txType: "MINT",
    senderAddress: "0x0000000000000000000000000000000000000000",
    recipientAddress: contract,
    priceEth: 0,
    txHash: `import:${chain.key}:${contract}:${tokenId}`,
    simulated: false,
  });

  return {
    nft,
    links: {
      explorer: `${chain.explorer}/address/${contract}`,
      opensea: `https://opensea.io/item/${chain.osSlug}/${contract}/${tokenId}`,
      chainLabel: chain.label,
    },
  };
}

module.exports = { importOnChainNft, checkChainCompliance, CHAINS };
