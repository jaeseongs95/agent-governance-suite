import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { parentPort, workerData } from 'node:worker_threads';

const db = new DatabaseSync(workerData.databasePath);
try {
  db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;');
  parentPort.postMessage('holding');
  await delay(150);
  const e = workerData.event;
  db.prepare(`INSERT INTO resource_usage_events
    (event_id,reservation_id,account_scope,pool_id,window_id,amount,unit,basis,coverage,
     job_binding_digest,source_digest,payload_json,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    e.eventId, e.reservationId, e.accountScope, e.poolId, e.windowId, e.amount, e.unit,
    e.basis, e.coverage, e.jobBindingDigest, e.sourceDigest, workerData.payload, e.occurredAt);
  db.exec('COMMIT;');
  parentPort.postMessage('done');
} catch (error) {
  try { db.exec('ROLLBACK;'); } catch { /* Preserve the original failure. */ }
  parentPort.postMessage({ error: String(error) });
} finally { db.close(); }
