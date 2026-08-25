/**
 * proveErc165.js — evidence that Layer 1 is a real on-chain check, not a stored flag.
 *
 * Calls ERC-165 supportsInterface() on live Ethereum mainnet contracts and prints the raw
 * JSON-RPC request and response for each, so the result can be reproduced by hand or in
 * any block explorer. No API key needed (public RPC).
 *
 * Run:  npm run prove:erc165
 */
const RPC = process.env.MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com";

// ERC-165: supportsInterface(bytes4) -> selector 0x01ffc9a7
const SELECTOR = "0x01ffc9a7";
const IFACE = {
  "ERC-721":  "80ac58cd",
  "ERC-1155": "d9b67a26",
};

const TARGETS = [
  ["BoredApeYachtClub", "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D", "deployed 2021, after EIP-721"],
  ["Azuki",             "0xED5AF388653567Af2F388E6224dC7C4b3241C544", "deployed 2022"],
  ["CryptoPunks",       "0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB", "deployed JUNE 2017 — before EIP-721 existed"],
  ["USDC (ERC-20)",     "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "a token contract, not an NFT"],
];

async function rpc(method, params) {
  const body = { jsonrpc: "2.0", id: 1, method, params };
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { request: body, response: await res.json() };
}

const pad = h => h.padEnd(64, "0");

(async () => {
  console.log("ERC-165 compliance check against live Ethereum mainnet");
  console.log("RPC:", RPC);
  console.log("=".repeat(78));

  for (const [name, addr, note] of TARGETS) {
    console.log(`\n${name}  (${note})`);
    console.log(`  address: ${addr}`);

    const code = await rpc("eth_getCode", [addr, "latest"]);
    const hasCode = code.response.result && code.response.result !== "0x";
    console.log(`  bytecode present: ${hasCode ? "yes (" + code.response.result.length + " chars)" : "NO"}`);

    for (const [label, id] of Object.entries(IFACE)) {
      const data = SELECTOR + pad(id);
      const { request, response } = await rpc("eth_call", [{ to: addr, data }, "latest"]);
      const raw = response.result;
      const err = response.error && response.error.message;
      const supported = typeof raw === "string" && /1$/.test(raw);

      console.log(`\n  --- supportsInterface(0x${id})  [${label}] ---`);
      console.log(`  REQUEST : ${JSON.stringify(request.params[0])}`);
      console.log(`  RESPONSE: ${err ? "error -> " + err : raw}`);
      console.log(`  MEANING : ${err ? "the function does not exist on this contract"
                                     : supported ? "true  -> declares " + label
                                                 : "false -> does NOT declare " + label}`);
    }

    const anyNft = await (async () => {
      for (const id of Object.values(IFACE)) {
        const { response } = await rpc("eth_call", [{ to: addr, data: SELECTOR + pad(id) }, "latest"]);
        if (typeof response.result === "string" && /1$/.test(response.result)) return true;
      }
      return false;
    })();
    console.log(`\n  VERDICT : ${anyNft ? "PASSES Layer 1 (a compliant NFT contract)"
                                        : "FAILS Layer 1 -> NonCompliant"}`);
    console.log("-".repeat(78));
  }

  console.log(`
Why CryptoPunks fails
  ERC-165 was finalised in 2018 and EIP-721 the same year. CryptoPunks was deployed in
  June 2017, so its contract has no supportsInterface() function at all — the call has
  nothing to execute and returns empty/reverts. This is a documented fact about the
  contract, not an accusation: CryptoPunks is the canonical example of a pre-standard NFT.

  The comparison is the evidence. Identical call, same RPC, same block:
    BoredApeYachtClub -> 0x...01  (true)
    CryptoPunks       -> empty/revert
  Anything can be verified independently on Etherscan's "Read Contract" tab: BAYC lists
  supportsInterface, CryptoPunks does not.
`);
})();
