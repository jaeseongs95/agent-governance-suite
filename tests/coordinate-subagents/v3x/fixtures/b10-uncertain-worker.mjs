import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { parentPort, workerData } from 'node:worker_threads';

const db = new DatabaseSync(workerData.databasePath);
try {
  db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;');
  parentPort.postMessage('holding');
  await delay(200);
  db.prepare(`UPDATE resource_reservations SET state = 'uncertain'
    WHERE reservation_id = ? AND state = 'committed'`).run(workerData.reservationId);
  db.exec('COMMIT;');
  parentPort.postMessage('done');
} catch (error) {
  try { db.exec('ROLLBACK;'); } catch { /* Preserve the original failure. */ }
  parentPort.postMessage({ error: String(error) });
} finally { db.close(); }
