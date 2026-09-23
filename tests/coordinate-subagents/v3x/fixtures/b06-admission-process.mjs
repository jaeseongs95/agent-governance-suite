import { DatabaseSync } from 'node:sqlite';

import { ResourcePoolsAdmissionStore } from '../../../../mcp-server/src/resource/admit-pools.ts';

let store;
let db;
process.on('message', message => {
  try {
    if (message.type === 'setup') {
      db = new DatabaseSync(message.config.databasePath);
      store = new ResourcePoolsAdmissionStore(db, message.config, message.policies, () => message.now);
      process.send({ type: 'ready' });
    } else if (message.type === 'admit') {
      process.send({ type: 'result', result: store.admitIdempotent(message.request) });
    }
  } catch (error) {
    process.send({ type: 'result', error: { code: error.code ?? null, message: error.message } });
  }
});
process.on('disconnect', () => { db?.close(); });
