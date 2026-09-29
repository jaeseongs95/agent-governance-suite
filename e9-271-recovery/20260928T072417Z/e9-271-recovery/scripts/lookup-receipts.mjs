// Find hook receipts in a throwaway copy of the trust DB (read-only). Prints no signing key or integrity token.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2], { readOnly: true });
console.log(JSON.stringify({ tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
  metadataKeys: db.prepare('SELECT key FROM trust_metadata').all().map((r) => r.key) }));
for (const r of db.prepare('SELECT receipt_id, receipt_json FROM input_source_receipts').all()) {
  const j = JSON.parse(r.receipt_json); delete j.integrityToken;
  console.log(JSON.stringify(j));
}
db.close();
