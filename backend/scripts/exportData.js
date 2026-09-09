/**
 * exportData.js — write every collection out to JSON files, so the marketplace's data can
 * travel with a copy of the project.
 *
 * Handing someone the folder does not hand them the data: MongoDB lives outside it, and
 * backend/.env — which points at the database — is deliberately not shared. Without a dump
 * a fresh copy starts empty. `npm run seed` builds a 9-NFT demo set, which is enough for
 * most purposes; this script is for when the real dataset is wanted instead.
 *
 * Uses the driver directly rather than mongodump, which ships separately from MongoDB and
 * is usually not installed.
 *
 * Usage:
 *   npm run export                       MONGODB_URI -> backend/data-export/
 *   npm run export -- --dry              list what would be written, write nothing
 *   npm run export -- --from <uri>       explicit source
 *   npm run export -- --out <dir>        explicit destination folder
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const argv = process.argv.slice(2);
const val = f => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };
const dry = argv.includes("--dry");

const FROM = val("--from") || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/nftguard";
const OUT = path.resolve(val("--out") || path.join(__dirname, "..", "data-export"));

// Print the host only. A connection string carries the password, and this output is
// exactly the kind that ends up in a screenshot.
const hostOf = u => {
  const m = String(u).match(/^mongodb(?:\+srv)?:\/\/(?:[^@]*@)?([^/?]+)/);
  return m ? m[1] : "(unparsed uri)";
};

(async () => {
  console.log(`FROM  ${hostOf(FROM)}`);
  console.log(`TO    ${OUT}`);
  console.log("=".repeat(66));

  const client = new MongoClient(FROM, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db();

  const cols = (await db.listCollections().toArray())
    .map(c => c.name).filter(n => !n.startsWith("system."));
  if (!cols.length) {
    console.log("Database is empty — nothing to export.");
    await client.close();
    return;
  }

  if (!dry) fs.mkdirSync(OUT, { recursive: true });

  let total = 0;
  const manifest = { exportedAt: new Date().toISOString(), source: hostOf(FROM), collections: {} };

  for (const name of cols.sort()) {
    const docs = await db.collection(name).find({}).toArray();
    // Indexes do not travel with the documents, and tokenId is declared unique — without
    // them an import would accept two tokens sharing an id.
    const indexes = (await db.collection(name).indexes())
      .filter(ix => ix.name !== "_id_")
      .map(ix => ({ name: ix.name, key: ix.key, unique: !!ix.unique }));

    total += docs.length;
    manifest.collections[name] = { documents: docs.length, indexes: indexes.length };

    if (dry) {
      console.log(`  ${name.padEnd(18)} ${String(docs.length).padStart(5)} documents`);
      continue;
    }
    fs.writeFileSync(path.join(OUT, `${name}.json`),
                     JSON.stringify({ collection: name, indexes, documents: docs }, null, 2));
    console.log(`  ${name.padEnd(18)} ${String(docs.length).padStart(5)} documents written`);
  }

  if (!dry) {
    fs.writeFileSync(path.join(OUT, "_manifest.json"), JSON.stringify(manifest, null, 2));
  }

  console.log("=".repeat(66));
  console.log(dry
    ? `--dry: ${total} documents across ${cols.length} collections, nothing written.`
    : `Done. ${total} documents across ${cols.length} collections -> ${OUT}`);
  if (!dry) console.log("Give that folder to whoever needs the data; they run: npm run import");
  await client.close();
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
