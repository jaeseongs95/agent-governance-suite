// Step 5: read-only open of a copied 2.7.1 state; separates sidecar vs main-file bytes vs logical content.
// Usage: tsx readonly-open.mjs <root-v53> <dir> [<dir>...]
import { join } from 'node:path';
import { load, fileHashes, schemaDump, logicalDigest, openReadOnly } from './lib.mjs';

const [root, ...dirs] = process.argv.slice(2);
const m = await load(root);
const log = (step, data) => console.log(JSON.stringify({ step, ...data }));
const wakeBrief = (db) => db.prepare('SELECT session_id, state, late_observed_at IS NOT NULL AS late, observed_at FROM wake_nonces ORDER BY session_id, rowid').all();
for (const dir of dirs) {
  const path = join(dir, 'session-messages.sqlite3');
  log('5.files-before', { dir, files: fileHashes(dir) });
  let first = null;
  for (const pass of [1, 2]) {
    let db;
    try { db = openReadOnly(path); } catch (e) { log('5.ro-open-error', { dir, pass, error: String(e.message) }); continue; }
    try {
      log('5.ro-files-while-open', { dir, pass, files: fileHashes(dir) });
      const digest = logicalDigest(db);
      if (pass === 1) { first = digest; log('5.ro-schema', { dir, schema: schemaDump(db) }); log('5.ro-wake', { dir, rows: wakeBrief(db) }); }
      log('5.ro-logical', { dir, pass, digest, sameAsPass1: JSON.stringify(digest) === JSON.stringify(first) });
      try { db.exec("UPDATE wake_nonces SET state = state WHERE 0"); log('5.ro-write-probe', { dir, pass, writable: true }); }
      catch (e) { log('5.ro-write-probe', { dir, pass, writable: false, error: String(e.message) }); }
    } catch (e) { log('5.ro-read-error', { dir, pass, error: String(e.message) }); }
    finally { db.close(); }
    log('5.files-after-ro-close', { dir, pass, files: fileHashes(dir) });
  }
  // Reference: logical content through the 53eff30a writable constructor on a separate copy (no operations).
  log('5.ro-done', { dir, firstAllSha256: first?.all_sha256 ?? null });
}
if (process.env.REF_DIR) {
  const store = new m.SessionMessageStore(join(process.env.REF_DIR, 'session-messages.sqlite3'));
  log('5.ref-writable-constructor-logical', { dir: process.env.REF_DIR, digest: logicalDigest(store.database) });
  store.close();
  log('5.ref-files-after-close', { dir: process.env.REF_DIR, files: fileHashes(process.env.REF_DIR) });
}
