/** Standalone SQLite contender: no vendor account, shell command or application worker. */
import { DatabaseSync } from 'node:sqlite';
import { ModelRoutingStore } from '../../../../skills/coordinate-subagents/scripts/model-routing-store.mjs';

const [file, key, decisionDigest, now, mode = 'reply'] = process.argv.slice(2);
const database = new DatabaseSync(file);
database.exec('PRAGMA busy_timeout=3000;');
const store = new ModelRoutingStore(database);
process.once('message', () => {
  let validations = 0;
  try {
    const result = store.claimExecutionStart(key, 1, decisionDigest, () => {
      validations += 1;
      // Ensure overlapping contenders encounter a real cross-process writer lock.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      return now;
    });
    if (mode !== 'drop-result') process.send({ type: 'result', acquired: true, validations, result });
  } catch (error) {
    process.send({ type: 'result', acquired: false, validations, code: error.code });
  } finally {
    database.close(); process.disconnect();
  }
});
process.send({ type: 'ready' });
