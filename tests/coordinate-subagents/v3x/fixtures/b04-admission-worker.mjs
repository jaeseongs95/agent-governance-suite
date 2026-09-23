import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

import { ResourcePoolAdmissionStore } from '../../../../mcp-server/src/resource/admit-pool.ts';

const { config, policy, request, now, hold, fail, barrier } = workerData;
const signal = new Int32Array(barrier);
const db = new DatabaseSync(config.databasePath);
const store = new ResourcePoolAdmissionStore(db, config, policy,
  () => Atomics.load(signal, 1) === 1 ? workerData.afterNow : now);
const exec = db.exec.bind(db);
db.exec = sql => {
  if (!hold && sql === 'BEGIN IMMEDIATE;') parentPort.postMessage({ type: 'write-attempt' });
  if (hold && fail && sql === 'COMMIT;') throw new Error('b04 rollback');
  return exec(sql);
};
db.function('b04_hold', () => {
  if (!hold) return;
  parentPort.postMessage({ type: 'holding' });
  if (Atomics.wait(signal, 0, 0, 5000) !== 'ok') throw new Error('B04 lock barrier timed out.');
});

parentPort.on('message', command => {
  try {
    if (command === 'arm') {
      db.exec(`CREATE TRIGGER b04_hold AFTER INSERT ON resource_reservation_holds
        WHEN (SELECT request_key FROM resource_reservations WHERE reservation_id = NEW.reservation_id)
          = '${request.requestKey}' BEGIN SELECT b04_hold(); END;`);
      parentPort.postMessage({ type: 'armed' });
    } else if (command === 'admit') {
      parentPort.postMessage({ type: 'result', result: store.admit(request) });
    } else {
      throw new Error('Unexpected B04 worker command.');
    }
  } catch (error) {
    parentPort.postMessage({ type: 'result', error: { code: error.code ?? null, message: error.message } });
  }
});

parentPort.postMessage({ type: 'ready' });
