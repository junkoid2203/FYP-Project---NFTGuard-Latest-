/**
 * migrateToCloud.js — copy a whole NFTGuard database from one MongoDB to another.
 *
 * npm run seed builds the 9-NFT demo set, which is not the database the system has been
 * tested against. This copies the real one — every NFT, transaction, risk score, flag,
 * offer and user — so a deployed instance shows the same data as the local one.
 *
 * Uses the driver directly rather than mongodump, which ships separately from MongoDB.
 *
 * Destination is the first of: --to, ATLAS_URI, MONGODB_URI. Keeping the cloud URI in
 * ATLAS_URI lets MONGODB_URI stay pointed at local MongoDB for day-to-day development.
 *
 * Usage:
 *   npm run migrate -- --dry        list what would be copied
 *   npm run migrate                 local -> ATLAS_URI
 *   npm run migrate -- --to <uri>   explicit destination
 *   npm run migrate -- --from <uri> --to <uri>
 */
require("dotenv").config();
const { MongoClient } = require("mongodb");

const argv = process.argv.slice(2);
const val = f => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };
const dry = argv.includes("--dry");

const FROM = val("--from") || "mongodb://127.0.0.1:27017/nftguard";
const TO   = val("--to")   || process.env.ATLAS_URI || process.env.MONGODB_URI;

// Print the host only. A connection string carries the password, and this output is
// exactly the kind that ends up in a screenshot.
const hostOf = u => {
  const m = String(u).match(/^mongodb(?:\+srv)?:\/\/(?:[^@]*@)?([^/?]+)/);
  return m ? m[1] : "(unparsed uri)";
};

(async () => {
  if (!TO) {
    console.log("No destination. Pass --to <uri>, or set ATLAS_URI in backend/.env.");
    process.exit(1);
  }
  if (FROM === TO) {
    console.log("Source and destination are the same database.");
    console.log("MONGODB_URI points at local MongoDB — put the cloud URI in ATLAS_URI, or pass --to.");
    process.exit(1);
  }

  console.log(`FROM  ${hostOf(FROM)}`);
  console.log(`TO    ${hostOf(TO)}`);
  console.log("=".repeat(66));

  const src = new MongoClient(FROM, { serverSelectionTimeoutMS: 15000 });
  const dst = new MongoClient(TO,   { serverSelectionTimeoutMS: 20000 });
  await src.connect(); await dst.connect();
  const sdb = src.db(), ddb = dst.db();

  const cols = (await sdb.listCollections().toArray()).map(c => c.name).filter(n => !n.startsWith("system."));
  if (!cols.length) { console.log("Source database is empty — nothing to copy."); await src.close(); await dst.close(); return; }

  let total = 0;
  for (const name of cols.sort()) {
    const docs = await sdb.collection(name).find({}).toArray();
    total += docs.length;
    if (dry) { console.log(`  ${name.padEnd(18)} ${String(docs.length).padStart(5)} documents`); continue; }

    // Replace rather than merge: leftovers from an earlier seed would silently mix two
    // datasets, and the duplicate detector would then compare tokens that never coexisted.
    await ddb.collection(name).deleteMany({});
    if (docs.length) await ddb.collection(name).insertMany(docs, { ordered: false });

    // Indexes do not travel with the documents, and tokenId is declared unique.
    for (const ix of await sdb.collection(name).indexes()) {
      if (ix.name === "_id_") continue;
      try { await ddb.collection(name).createIndex(ix.key, { name: ix.name, unique: !!ix.unique }); } catch (_) {}
    }
    console.log(`  ${name.padEnd(18)} ${String(docs.length).padStart(5)} documents copied`);
  }

  console.log("=".repeat(66));
  console.log(dry ? `--dry: ${total} documents across ${cols.length} collections, nothing written.`
                  : `Done. ${total} documents across ${cols.length} collections.`);
  await src.close(); await dst.close();
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
