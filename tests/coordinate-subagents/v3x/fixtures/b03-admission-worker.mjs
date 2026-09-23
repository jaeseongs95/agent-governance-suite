import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

import { ResourceObservationStore } from '../../../../mcp-server/src/resource/observation-store.ts';

const { config, response, hold, fail, barrier } = workerData;
const signal = new Int32Array(barrier);
const db = new DatabaseSync(config.databasePath);
const collector = { scope: {
  collectorId: response.collectorId, source: response.source,
  accountScope: response.accountScope, resourcePoolId: response.resourcePoolId,
}, collect: async () => {
  parentPort.postMessage({ type: 'collected' });
  return response;
} };
const store = new ResourceObservationStore(db, config, [collector]);
const exec = db.exec.bind(db);
db.exec = sql => {
  if (!hold && sql === 'BEGIN IMMEDIATE;') parentPort.postMessage({ type: 'write-attempt' });
  return exec(sql);
};

db.function('b03_hold_observation', () => {
  if (!hold) return;
  parentPort.postMessage({ type: 'holding' });
  if (Atomics.wait(signal, 0, 0, 5000) !== 'ok') throw new Error('B03 lock barrier timed out.');
});

parentPort.on('message', async command => {
  try {
    if (command === 'arm') {
      db.exec(`CREATE TRIGGER b03_hold AFTER INSERT ON resource_window_observations
        WHEN NEW.revision = ${response.snapshot.windows[0].revision}
        BEGIN SELECT b03_hold_observation(); ${fail ? "SELECT RAISE(ABORT, 'b03 rollback');" : ''} END;`);
      parentPort.postMessage({ type: 'armed' });
    } else if (command === 'admit') {
      const result = await store.admit(collector);
      parentPort.postMessage({ type: 'result', result });
    } else {
      throw new Error('Unexpected B03 worker command.');
    }
  } catch (error) {
    parentPort.postMessage({ type: 'result', error: { code: error.code ?? null, message: error.message } });
  }
});

parentPort.postMessage({ type: 'ready' });
