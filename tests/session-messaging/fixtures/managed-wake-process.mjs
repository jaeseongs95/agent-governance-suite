import { appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SessionMessageStore } from '../../../mcp-server/src/session-message-store.ts';
import { dispatchSessionMessageBrokerOperation as dispatch } from '../../../mcp-server/src/session-message-broker.ts';
import { dispatchManagedWake } from '../../../mcp-server/src/session-message-relay.ts';

const [mode, database, effects, relayId, parentPid] = process.argv.slice(2);
const target = { host: 'portable', sessionId: 'wake-target' };
if (mode === 'migration-failure') {
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql.includes('ALTER TABLE wake_nonces ADD COLUMN nonce TEXT')) throw new Error('fixture migration failure');
    return original.call(this, sql);
  };
  try { new SessionMessageStore(database); process.exit(2); }
  catch (error) { process.send({ type: 'result', error: error.message }); process.exit(0); }
}
const store = new SessionMessageStore(database);
process.send({ type: 'ready' });
process.once('message', async () => {
  try {
    if (mode === 'sender') {
      store.send({ sender: { host: 'portable', sessionId: relayId }, target, messageId: relayId, body: relayId });
      process.send({ type: 'result', sent: true });
    } else {
      store.acquireRelay({ ...target, transport: 'portable', relayId, pid: process.pid, parentPid: Number(parentPid) });
      const request = async (operation, payload) => {
        if (mode === 'crash-before-start' && operation === 'start-wake') process.exit(17);
        if (mode === 'crash-after-effect' && operation === 'record-wake-outcome') process.exit(19);
        const result = dispatch(store, operation, payload);
        if (mode === 'crash-after-start' && operation === 'start-wake') process.exit(18);
        return result;
      };
      const called = await dispatchManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable' }, relayId,
        { capabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' },
          dispatch: async (_target, marker) => {
            const row = store.database.prepare("SELECT state FROM wake_nonces WHERE state = 'started'").get();
            if (!row) throw new Error('effect started without a persisted intent');
            appendFileSync(effects, `${marker}\n`, 'utf8');
            return 'submitted';
          } }, request);
      process.send({ type: 'result', called });
    }
    store.close();
    process.exit(0);
  } catch (error) { process.send({ type: 'result', error: error.message }); store.close(); process.exit(1); }
});
