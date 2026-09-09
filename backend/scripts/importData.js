/**
 * importData.js — load the JSON files written by exportData.js into a database.
 *
 * The counterpart to `npm run export`. Point backend/.env at your own MongoDB, run this,
 * and the marketplace comes up holding the same NFTs, transactions, risk scores and fraud
 * flags as the copy it came from.
 *
 * A non-empty collection is left alone unless --drop is given. Merging two datasets would
 * be worse than refusing: the duplicate detector would compare tokens that never coexisted,
 * and the price statistics would be computed over trades from two different markets.
 *
 * Usage:
 *   npm run import                       backend/data-export/ -> MONGODB_URI
 *   npm run import -- --dry              report what would happen, write nothing
 *   npm run import -- --drop             replace collections that already hold documents
 *   npm run import -- --in <dir>         explicit source folder
 *   npm run import -- --to <uri>         explicit destination
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const argv = process.argv.slice(2);
const val = f => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };
const dry = argv.includes("--dry");
const drop = argv.includes("--drop");

const IN = path.resolve(val("--in") || path.join(__dirname, "..", "data-export"));
const TO = val("--to") || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/nftguard";

const hostOf = u => {
  const m = String(u).match(/^mongodb(?:\+srv)?:\/\/(?:[^@]*@)?([^/?]+)/);
  return m ? m[1] : "(unparsed uri)";
};

(async () => {
  if (!fs.existsSync(IN)) {
    console.log(`No export folder at ${IN}`);
    console.log("Ask whoever shared the project to run `npm run export`, or use `npm run seed`");
    console.log("for the 9-NFT demo set instead.");
    process.exit(1);
  }

  const files = fs.readdirSync(IN).filter(f => f.endsWith(".json") && f !== "_manifest.json");
  if (!files.length) {
    console.log(`${IN} holds no collection files.`);
    process.exit(1);
  }

  console.log(`FROM  ${IN}`);
  console.log(`TO    ${hostOf(TO)}`);
  console.log("=".repeat(66));

  const client = new MongoClient(TO, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db();

  let total = 0, skipped = 0;
  for (const file of files.sort()) {
    const payload = JSON.parse(fs.readFileSync(path.join(IN, file), "utf8"));
    const name = payload.collection || path.basename(file, ".json");
    const docs = payload.documents || [];
    const col = db.collection(name);
    const existing = await col.countDocuments();

    if (existing && !drop) {
      console.log(`  ${name.padEnd(18)} SKIPPED — already holds ${existing} documents (use --drop to replace)`);
      skipped++;
      continue;
    }
    if (dry) {
      console.log(`  ${name.padEnd(18)} ${String(docs.length).padStart(5)} documents would be written`);
      total += docs.length;
      continue;
    }

    if (existing) await col.deleteMany({});
    if (docs.length) {
      // Dates arrive as ISO strings from JSON; the schemas expect Date objects, and the
      // fraud rules compare timestamps arithmetically.
      for (const d of docs) revive(d);
      await col.insertMany(docs, { ordered: false });
    }
    for (const ix of payload.indexes || []) {
      try { await col.createIndex(ix.key, { name: ix.name, unique: ix.unique }); } catch (_) {}
    }
    total += docs.length;
    console.log(`  ${name.padEnd(18)} ${String(docs.length).padStart(5)} documents loaded`);
  }

  console.log("=".repeat(66));
  console.log(dry
    ? `--dry: ${total} documents would be written, nothing changed.`
    : `Done. ${total} documents loaded.`);
  if (skipped) console.log(`${skipped} collection(s) skipped because they already held data.`);
  await client.close();
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Turn ISO date strings back into Date objects, in place and at any depth. */
function revive(obj) {
  if (obj === null || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && ISO.test(v)) obj[k] = new Date(v);
    else if (typeof v === "object") revive(v);
  }
}
