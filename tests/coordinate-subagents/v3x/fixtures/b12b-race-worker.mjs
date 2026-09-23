import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

import { ResourceObservationStore } from '../../../../mcp-server/src/resource/observation-store.ts';
import { ResourceUsageReconciliationStore } from '../../../../mcp-server/src/resource/reconcile-usage.ts';
import { ResourceReservationSettlementStore } from '../../../../mcp-server/src/resource/settle-reservation.ts';

const { action, config, response, usage, proof, expected, hold, barrier } = workerData;
const signal = new Int32Array(barrier);
const db = new DatabaseSync(config.databasePath);
let run;
if (action === 'snapshot') {
  const collector = { scope: { collectorId: response.collectorId, source: response.source,
    accountScope: response.accountScope, resourcePoolId: response.resourcePoolId },
  collect: async () => response };
  const store = new ResourceObservationStore(db, config, [collector]);
  run = () => store.admit(collector);
} else if (action === 'settle') {
  const store = new ResourceReservationSettlementStore(db, config,
    token => token === 'evidence' ? usage : null,
    () => usage.jobBindingDigest,
    () => ({ terminalResults: ['completed'], onUnknown: 'retain' }));
  run = () => store.record('evidence');
} else if (action === 'reconcile') {
  const store = new ResourceUsageReconciliationStore(db, config,
    token => token === 'evidence' ? proof : null);
  run = () => store.apply(expected, 'evidence');
} else throw new Error('Unknown B12-b worker action.');

const exec = db.exec.bind(db);
if (!hold) db.exec('PRAGMA busy_timeout = 0;');
db.exec = sql => {
  if (sql === 'BEGIN IMMEDIATE;') parentPort.postMessage({ type: 'attempt' });
  if (hold && sql === 'COMMIT;' && db.isTransaction) {
    parentPort.postMessage({ type: 'holding' });
    if (Atomics.wait(signal, 0, 0, 10000) !== 'ok') throw new Error('B12-b barrier timed out.');
  }
  return exec(sql);
};
parentPort.on('message', async command => {
  if (command !== 'go' && command !== 'retry') return;
  try {
    const result = await run();
    parentPort.postMessage({ type: 'result', result, transactionOpen: db.isTransaction });
  } catch (error) {
    parentPort.postMessage({ type: 'result', error: { code: error.code ?? null,
      message: error.message }, transactionOpen: db.isTransaction });
  }
});
parentPort.postMessage({ type: 'ready' });
