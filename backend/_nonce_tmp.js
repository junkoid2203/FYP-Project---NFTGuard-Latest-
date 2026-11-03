const { ethers } = require("ethers");
const FROM = "0x3AfEaBe327802Ac26fbeefE87eC4E0E3D59FA6E9";
const RPCS = {
  "publicnode": "https://ethereum-sepolia-rpc.publicnode.com",
  "drpc":       "https://sepolia.drpc.org",
};
(async () => {
  for (const [name, url] of Object.entries(RPCS)) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      const t0 = Date.now();
      const latest  = await p.getTransactionCount(FROM, "latest");
      const pending = await p.getTransactionCount(FROM, "pending");
      const block   = await p.getBlockNumber();
      console.log("%s  block %d  nonce latest %d / pending %d  %s  (%dms)",
        name.padEnd(11), block, latest, pending,
        latest === pending ? "-> no stuck tx  OK" : "-> STUCK TX BLOCKING THE NONCE",
        Date.now() - t0);
      await p.destroy();
    } catch (e) { console.log("%s  UNREACHABLE -> %s", name.padEnd(11), e.shortMessage || e.message); }
  }
})();
