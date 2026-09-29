// Row dump: node dump.mjs <sessionDb> [trustDb...]  (read-only; nonce column masked to length)
import { DatabaseSync } from 'node:sqlite'; import { existsSync, readdirSync, statSync } from 'node:fs'; import path from 'node:path';
const [sessionDb, ...trusts] = process.argv.slice(2);
const out = {};
if (sessionDb && existsSync(sessionDb)) {
  const db = new DatabaseSync(sessionDb, { readOnly: true });
  out.wake_nonces = db.prepare('SELECT * FROM wake_nonces').all().map(r => ({ ...r, nonce: r.nonce ? `<${r.nonce.length} chars>` : r.nonce }));
  out.messages = db.prepare('SELECT message_id, claimed_at, delivery_attempts, acknowledged_at FROM messages').all();
  out.input_observations = db.prepare('SELECT count(*) n FROM input_observations').get().n;
  out.session_presence = db.prepare('SELECT * FROM session_presence').all();
  db.close();
}
for (const t of trusts) {
  const dir = path.dirname(t);
  const files = existsSync(dir) ? readdirSync(dir).filter(n => n.startsWith(path.basename(t))).map(n => ({ n, size: statSync(path.join(dir, n)).size })) : 'NO_DIR';
  const e = { exists: existsSync(t), files };
  if (existsSync(t)) {
    try { const db = new DatabaseSync(t, { readOnly: true });
      e.keys = db.prepare('SELECT key, length(value) len FROM trust_metadata').all();
      e.receipts = db.prepare('SELECT receipt_id FROM input_source_receipts').all().map(r => r.receipt_id);
      db.close(); } catch (err) { e.error = String(err.message); }
  }
  out[t] = e;
}
console.log(JSON.stringify(out, null, 1));
