import { DatabaseSync } from "node:sqlite"; import { createHash } from "node:crypto";
const db = new DatabaseSync(process.argv[2], { readOnly: true }); const h = (r) => createHash("sha256").update(JSON.stringify(r)).digest("hex").slice(0, 16);
const out = {}; for (const t of ["messages", "prepared_messages", "wake_nonces", "session_presence", "session_activity", "relay_leases", "input_observations"]) { const rows = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(); out[t] = { n: rows.length, h: h(rows) }; }
out.version = db.prepare("PRAGMA user_version").get().user_version; out.integrity = db.prepare("PRAGMA integrity_check").get().integrity_check; console.log(JSON.stringify(out));
