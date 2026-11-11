// WeKan database checks for upgrade-wekan.sh, read-only except where noted. The database address comes from MONGO_URL
// and is never printed. Usage: node wekan-db.js <bundle dir> <command> [args]
//   name                         the database MONGO_URL selects
//   snapshot <out.json>          every collection's count, and the _ids of the collections whose documents must survive
//   verify <manifest> upgrade    after an upgrade: no surviving-kind document is gone, no more broken references than
//                                in the snapshot, lists may only disappear if nothing points at them (13.06 merges lists)
//   verify <manifest> exact      after a restore: the same collections with the same counts and the same _ids
//   dropdb <db name> <manifest>  drop the WeKan database before a restore; only the manifest's database is accepted
//   counts <db name>             counts of every collection of another database (the restore rehearsal)
//   drop <db name>               drop that database; only names ending in _restore_rehearsal are accepted
const path = require("path");
const fs = require("fs");
const { MongoClient } = require(path.join(process.argv[2], "programs/server/npm/node_modules/meteor/npm-mongo/node_modules/mongodb"));
const KEEP = ["users", "boards", "cards", "swimlanes", "customFields", "card_comments", "checklists", "checklistItems",
  "attachments", "avatars", "team", "org", "settings", "rules", "triggers", "actions", "integrations", "accountSettings"];
const REFS = [["cards", "boardId", "boards"], ["cards", "listId", "lists"], ["cards", "swimlaneId", "swimlanes"],
  ["lists", "boardId", "boards"], ["swimlanes", "boardId", "boards"], ["card_comments", "cardId", "cards"],
  ["checklists", "cardId", "cards"], ["checklistItems", "checklistId", "checklists"],
  ["activities", "listId", "lists"]];
async function broken(db) {  // references with a non-empty id that points at no document
  const out = {};
  for (const [from, field, to] of REFS) {
    const target = new Set((await db.collection(to).find({}, { projection: { _id: 1 } }).toArray()).map(x => String(x._id)));
    let n = 0;
    for await (const d of db.collection(from).find({}, { projection: { [field]: 1 } })) {
      const v = d[field];
      if (v !== undefined && v !== null && v !== "" && !target.has(String(v))) n++;
    }
    out[`${from}.${field}->${to}`] = n;
  }
  return out;
}
const clean = m => String(m).replace(/mongodb:\/\/[^@\s]*@/g, "mongodb://***@");
(async () => {
  const [cmd, a1, a2] = process.argv.slice(3);
  const client = await MongoClient.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 15000 });
  const db = client.db();
  const names = async d => (await d.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => !n.startsWith("system.")).sort();
  const ids = async (d, n) => (await d.collection(n).find({}, { projection: { _id: 1 } }).toArray()).map(x => String(x._id)).sort();
  try {
    if (cmd === "name") { console.log(db.databaseName); return; }
    if (cmd === "snapshot") {
      const m = { database: db.databaseName, at: new Date().toISOString(), counts: {}, ids: {} };
      for (const n of await names(db)) m.counts[n] = await db.collection(n).countDocuments();
      for (const n of Object.keys(m.counts)) m.ids[n] = await ids(db, n);
      m.broken = await broken(db);
      fs.writeFileSync(a1, JSON.stringify(m), { mode: 0o600 });
      console.log(`snapshot of ${Object.keys(m.counts).length} collections: ` + JSON.stringify(Object.fromEntries(Object.entries(m.counts).filter(([k]) => ["users", "boards", "lists", "swimlanes", "cards", "customFields", "activities"].includes(k)))));
      return;
    }
    if (cmd === "verify") {
      const m = JSON.parse(fs.readFileSync(a1, "utf8"));
      if (m.database !== db.databaseName) throw new Error(`manifest is for database ${m.database}, connected to ${db.databaseName}`);
      const problems = [];
      for (const [n, before] of Object.entries(m.ids)) {
        if (a2 !== "exact" && !KEEP.includes(n) && n !== "lists") continue;
        const now = new Set(await ids(db, n));
        const gone = before.filter(i => !now.has(i));
        if (a2 === "exact") {
          if (gone.length || now.size !== before.length) problems.push(`${n}: ${before.length} before, ${now.size} now, ${gone.length} missing`);
        } else if (gone.length && n !== "lists") problems.push(`${n}: ${gone.length} of ${before.length} documents gone`);
        else if (gone.length) console.log(`lists: ${gone.length} of ${before.length} merged away (allowed only if no card points at them)`);
      }
      if (a2 === "exact") {
        const now = {};
        for (const n of await names(db)) now[n] = await db.collection(n).countDocuments();
        for (const n of new Set([...Object.keys(m.counts), ...Object.keys(now)]))
          if (m.counts[n] !== now[n]) problems.push(`collection ${n}: ${m.counts[n]} in the backup, ${now[n]} now`);
      } else {
        const b = await broken(db);
        for (const [k, v] of Object.entries(b)) if (v > ((m.broken || {})[k] || 0)) problems.push(`${k}: ${v} broken references, ${(m.broken || {})[k] || 0} before`);
        console.log("broken references (before -> now): " + Object.entries(b).map(([k, v]) => `${k} ${(m.broken || {})[k] || 0}->${v}`).join(", "));
      }
      const counts = {};
      for (const n of ["users", "boards", "lists", "swimlanes", "cards", "customFields", "activities"]) counts[n] = await db.collection(n).countDocuments();
      console.log("counts now: " + JSON.stringify(counts));
      if (problems.length) { console.log("VERIFY_FAILED " + problems.join("; ")); process.exitCode = 1; } else console.log("VERIFY_OK");
      return;
    }
    if (cmd === "counts") {
      const d = client.db(a1), out = {};
      for (const n of await names(d)) out[n] = await d.collection(n).countDocuments();
      console.log(JSON.stringify(out));
      return;
    }
    if (cmd === "dropdb") {
      const m = JSON.parse(fs.readFileSync(a2, "utf8"));
      if (a1 !== m.database || a1 !== db.databaseName) throw new Error(`refusing to drop ${a1}: not the manifest's and MONGO_URL's database`);
      await client.db(a1).dropDatabase();
      console.log("dropped " + a1 + " for the restore");
      return;
    }
    if (cmd === "drop") {
      if (!/_restore_rehearsal$/.test(a1)) throw new Error("refusing to drop " + a1);
      await client.db(a1).dropDatabase();
      console.log("dropped " + a1);
      return;
    }
    throw new Error("unknown command " + cmd);
  } finally { await client.close(); }
})().catch(e => { console.error("DB_ERROR " + clean(e.message)); process.exit(1); });
