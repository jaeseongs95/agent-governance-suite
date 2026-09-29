// Read-only inspection of a reconcile experiment state dir. usage: node rc-inspect.mjs <dir> [find-receipts]
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const [dir, mode] = process.argv.slice(2);
const files = Object.fromEntries(readdirSync(dir).sort().filter((f) => statSync(join(dir, f)).isFile())
  .map((f) => [f, { bytes: statSync(join(dir, f)).size, sha256: createHash('sha256').update(readFileSync(join(dir, f))).digest('hex') }]));
const out = { dir, filesBefore: files };
const mask = (v) => (typeof v === 'string' ? `${v.slice(0, 8)}…(${v.length})` : v);
const msg = new DatabaseSync(join(dir, 'session-messages.sqlite3'), { readOnly: true });
out.wake = msg.prepare(`SELECT * FROM wake_nonces ORDER BY session_id, rowid`).all()
  .map((r) => ({ ...r, nonce: mask(r.nonce), nonce_digest: mask(r.nonce_digest) }));
out.presence = msg.prepare('SELECT session_id, instance_id, started_at, lease_until, ended_at FROM session_presence ORDER BY session_id, started_at').all().map((r) => ({ ...r, nonce: mask(r.nonce), nonce_digest: mask(r.nonce_digest) }));
out.messagesCount = msg.prepare('SELECT COUNT(*) c FROM messages').get().c;
msg.close();
if (existsSync(join(dir, 'trust.sqlite3'))) {
  const t = new DatabaseSync(join(dir, 'trust.sqlite3'), { readOnly: true });
  const rows = t.prepare('SELECT receipt_id, receipt_json FROM input_source_receipts ORDER BY rowid').all();
  out.trustReceipts = rows.length;
  if (mode === 'find-receipts') out.receipts = rows.map((r) => { const j = JSON.parse(r.receipt_json);
    return { receiptId: r.receipt_id, sessionId: j.sessionId, host: j.host, observedAt: j.observedAt, expiresAt: j.expiresAt, adapter: j.attestation?.adapter, authorityEffect: j.authorityEffect }; });
  out.trustLogical = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  out.trustKeyPresent = !!t.prepare("SELECT 1 FROM trust_metadata LIMIT 1").get();
  t.close();
}
console.log(JSON.stringify(out, null, 1));
