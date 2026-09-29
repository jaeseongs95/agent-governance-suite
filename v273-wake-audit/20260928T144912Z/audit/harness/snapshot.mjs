// Read-only snapshot of a messaging DB: version, schema, row digests, integrity.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
const [database] = process.argv.slice(2);
const db = new DatabaseSync(database, { readOnly: true });
const h = (rows) => createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
const cols = db.prepare("PRAGMA table_info(wake_nonces)").all().map(r => r.name);
const base = cols.filter(c => c !== "retired_at");
const out = {
  version: db.prepare("PRAGMA user_version").get().user_version,
  integrity: db.prepare("PRAGMA integrity_check").get().integrity_check,
  wakeColumns: cols,
  wakeSqlHasRetired: /expired-unobserved/.test(db.prepare("SELECT sql FROM sqlite_master WHERE name='wake_nonces'").get().sql),
  wakeRows: db.prepare("SELECT count(*) n FROM wake_nonces").get().n,
  wakeDigest: h(db.prepare(`SELECT rowid, ${base.join(",")} FROM wake_nonces ORDER BY rowid`).all()),
  states: db.prepare("SELECT state, count(*) n FROM wake_nonces WHERE nonce_digest NOT LIKE 'bulk-%' GROUP BY state ORDER BY state").all(),
  messagesDigest: h(db.prepare("SELECT * FROM messages ORDER BY message_id").all()),
  presenceDigest: h(db.prepare("SELECT * FROM session_presence ORDER BY rowid").all()),
  tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name),
  indexes: db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name),
};
db.close();
console.log(JSON.stringify(out));
