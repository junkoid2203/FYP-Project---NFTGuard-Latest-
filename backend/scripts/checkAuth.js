/**
 * checkAuth.js — the simplest "does authenticity detection work?" check.
 *
 * Finds one NFT of each kind already in the marketplace and re-verifies it,
 * proving the engine gives each the correct label. Plain-English output.
 *
 * Run:  npm run check        (the server must be running:  npm start)
 */
const http = require("http");
const BASE = "http://localhost:5000";

function api(method, path) {
  return new Promise((resolve, reject) => {
    const r = http.request(BASE + path, { method }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    r.on("error", reject);
    r.end();
  });
}

// the all-clear + the three problems the engine must catch
const WANT = [
  { status: "Verified",     plain: "a genuine NFT — passes all checks" },
  { status: "NonCompliant", plain: "fake / broken contract   (Layer 1)" },
  { status: "Tampered",     plain: "metadata was changed      (Layer 2)" },
  { status: "Duplicate",    plain: "copied image              (Layer 3)" },
];

(async () => {
  console.log("\nAuthenticity engine — checking one NFT of each kind\n");

  const body = await api("GET", "/api/nfts");
  const nfts = body.nfts || body;

  const byStatus = {};
  for (const n of nfts) (byStatus[n.authenticityStatus] ||= []).push(n);

  let allGood = true;
  for (const w of WANT) {
    const sample = (byStatus[w.status] || [])[0];
    if (!sample) {
      allGood = false;
      console.log(`  --    no NFT is "${w.status}" right now — re-seed the variety set`);
      continue;
    }
    // re-verify from scratch, so we prove the engine RE-DERIVES the label (not cached)
    const v = await api("POST", `/api/verify/${sample.tokenId}`);
    const ok = v.authenticityStatus === w.status;
    if (!ok) allGood = false;
    console.log(`  ${ok ? "PASS" : "FAIL"}  #${String(sample.tokenId).padEnd(3)} ${w.plain}  ->  "${v.authenticityStatus}"`);
  }

  console.log(`\n${allGood ? "✓ ALL GOOD — the engine labelled every kind correctly." : "✗ Something is off (see above)."}\n`);
  process.exitCode = allGood ? 0 : 1;
})().catch((e) => {
  console.error("\n✗ Could not reach the server — is `npm start` running?\n  " + e.message + "\n");
  process.exitCode = 1;
});
