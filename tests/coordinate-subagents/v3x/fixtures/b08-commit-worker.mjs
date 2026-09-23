import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

import { ArtifactRetentionStore } from '../../../../mcp-server/src/artifacts/retention.ts';
import { ResourceReservationCommitStore } from '../../../../mcp-server/src/resource/commit-reservation.ts';

const { config, retentionPath, binding, policies, request, now, barrier, hold, fail } = workerData;
const db = new DatabaseSync(config.databasePath);
const retention = new ArtifactRetentionStore(retentionPath);
const store = new ResourceReservationCommitStore(db, config, retention, () => binding,
  () => policies, () => ({ authorityId: config.authorityId, realmId: config.realmId,
    ownerId: 'owner-1', leaseId: 'lease-1', epoch: 1,
    expiresAt: '2026-09-23T00:20:00.000Z' }), () => now);
const exec = db.exec.bind(db);
db.exec = sql => {
  if (sql === 'COMMIT;' && hold) {
    parentPort.postMessage({ type: 'holding' });
    if (Atomics.wait(new Int32Array(barrier), 0, 0, 5000) !== 'ok') {
      throw new Error('B08 lock barrier timed out.');
    }
    if (fail) throw new Error('B08 forced commit fault');
  }
  return exec(sql);
};

parentPort.on('message', command => {
  if (command !== 'commit') return;
  if (!hold) parentPort.postMessage({ type: 'attempt' });
  try { parentPort.postMessage({ type: 'result', result: store.commit(request) }); }
  catch (error) { parentPort.postMessage({ type: 'result', error: { code: error.code ?? null,
    message: error.message } }); }
});
parentPort.postMessage({ type: 'ready' });
