/**
 * blockchain.js — ethers.js (v6) interaction layer with the Sepolia testnet.
 *
 * Two operating modes:
 *   ON-CHAIN mode  — SEPOLIA_RPC_URL + CONTRACT_ADDRESS (+ PRIVATE_KEY for writes)
 *                    are configured in backend/.env. Real testnet transactions.
 *   SIMULATED mode — env not configured. Mint/list/buy are simulated with
 *                    pseudo tx-hashes so the whole analytics pipeline still
 *                    works (report: Transaction Simulation Module supports
 *                    testing "without financial risk").
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// Human-readable ABI (subset used by the backend). If scripts/deploy.js has
// been run, the full compiled ABI in backend/abi/ takes precedence.
const FALLBACK_ABI = [
  "function mintNFT(string uri, bytes32 _metadataHash) external returns (uint256)",
  "function listForSale(uint256 tokenId, uint256 price) external",
  "function cancelListing(uint256 tokenId) external",
  "function buy(uint256 tokenId) external payable",
  "function verifyMetadataHash(uint256 tokenId, bytes32 hashToCheck) external view returns (bool)",
  "function metadataHash(uint256 tokenId) external view returns (bytes32)",
  "function getListing(uint256 tokenId) external view returns (uint256 price, bool active)",
  "function totalMinted() external view returns (uint256)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function tokenURI(uint256 tokenId) external view returns (string)",
  "function creatorOf(uint256 tokenId) external view returns (address)",
  "function supportsInterface(bytes4 interfaceId) external view returns (bool)",
  "event Minted(uint256 indexed tokenId, address indexed creator, string tokenURI, bytes32 metadataHash, uint256 timestamp)",
  "event Listed(uint256 indexed tokenId, address indexed seller, uint256 price, uint256 timestamp)",
  "event Purchased(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 timestamp)",
];

// ERC-165 interface identifiers (EIP-721 / EIP-1155) — FR 1.1
const INTERFACE_IDS = {
  ERC721: "0x80ac58cd",
  ERC721_METADATA: "0x5b5e139f",
  ERC1155: "0xd9b67a26",
};

function loadAbi() {
  try {
    const p = path.join(__dirname, "..", "abi", "NFTGuardMarketplace.json");
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (j.abi) return j.abi;
    }
  } catch (_) { /* fall through to human-readable ABI */ }
  return FALLBACK_ABI;
}

function isOnChainConfigured() {
  return Boolean(process.env.SEPOLIA_RPC_URL && process.env.CONTRACT_ADDRESS);
}

function getProvider() {
  if (!process.env.SEPOLIA_RPC_URL) return null;
  return new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
}

function getContract(withSigner = false) {
  const provider = getProvider();
  if (!provider || !process.env.CONTRACT_ADDRESS) return null;
  if (withSigner) {
    if (!process.env.PRIVATE_KEY) return null;
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    return new ethers.Contract(process.env.CONTRACT_ADDRESS, loadAbi(), wallet);
  }
  return new ethers.Contract(process.env.CONTRACT_ADDRESS, loadAbi(), provider);
}

/**
 * FR 1.1 — Smart contract standard compliance check via ERC-165
 * supportsInterface(). Also confirms deployed bytecode exists at the address.
 */
async function checkContractCompliance(contractAddress) {
  const provider = getProvider();
  if (!provider) return { checked: false, reason: "SEPOLIA_RPC_URL not configured (simulated mode)" };

  const addr = contractAddress || process.env.CONTRACT_ADDRESS;
  if (!addr) return { checked: false, reason: "No contract address supplied" };

  const code = await provider.getCode(addr);
  if (!code || code === "0x") {
    return { checked: true, compliant: false, erc721: false, erc1155: false, reason: "No contract bytecode at address" };
  }

  const c = new ethers.Contract(addr, loadAbi(), provider);
  const result = { checked: true, erc721: false, erc721Metadata: false, erc1155: false };
  try { result.erc721 = await c.supportsInterface(INTERFACE_IDS.ERC721); } catch (_) {}
  try { result.erc721Metadata = await c.supportsInterface(INTERFACE_IDS.ERC721_METADATA); } catch (_) {}
  try { result.erc1155 = await c.supportsInterface(INTERFACE_IDS.ERC1155); } catch (_) {}
  result.compliant = result.erc721 || result.erc1155;
  return result;
}

/** Read on-chain metadata hash + tokenURI + owner for a token (FR 1.2). */
async function readTokenOnChain(tokenId) {
  const c = getContract(false);
  if (!c) return null;
  const [hash, uri, owner] = await Promise.all([
    c.metadataHash(tokenId),
    c.tokenURI(tokenId),
    c.ownerOf(tokenId),
  ]);
  return { metadataHash: hash, tokenURI: uri, owner };
}

function pseudoTxHash() {
  return "0xsim" + [...Array(60)].map(() => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
}

/** FR 2.2 — mint (on-chain if configured, otherwise simulated). */
async function mintOnChain(uri, metadataHashHex) {
  const c = getContract(true);
  if (!c) return { simulated: true, txHash: pseudoTxHash() };
  const tx = await c.mintNFT(uri, metadataHashHex);
  const receipt = await tx.wait();
  let tokenId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = c.interface.parseLog(log);
      if (parsed && parsed.name === "Minted") tokenId = Number(parsed.args.tokenId);
    } catch (_) {}
  }
  return { simulated: false, txHash: receipt.hash, tokenId };
}

/** FR 2.3 — list for sale. */
async function listOnChain(tokenId, priceEth) {
  const c = getContract(true);
  if (!c) return { simulated: true, txHash: pseudoTxHash() };
  const tx = await c.listForSale(tokenId, ethers.parseEther(String(priceEth)));
  const receipt = await tx.wait();
  return { simulated: false, txHash: receipt.hash };
}

/** FR 2.4 — buy (sends priceEth as msg.value from the backend wallet). */
async function buyOnChain(tokenId, priceEth) {
  const c = getContract(true);
  if (!c) return { simulated: true, txHash: pseudoTxHash() };
  const tx = await c.buy(tokenId, { value: ethers.parseEther(String(priceEth)) });
  const receipt = await tx.wait();
  return { simulated: false, txHash: receipt.hash };
}

module.exports = {
  isOnChainConfigured,
  getProvider,
  getContract,
  checkContractCompliance,
  readTokenOnChain,
  mintOnChain,
  listOnChain,
  buyOnChain,
  INTERFACE_IDS,
};
