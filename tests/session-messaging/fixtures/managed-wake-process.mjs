import { appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SessionMessageStore } from '../../../mcp-server/src/session-message-store.ts';
import { dispatchSessionMessageBrokerOperation as dispatch } from '../../../mcp-server/src/session-message-broker.ts';
import { dispatchManagedWake } from '../../../mcp-server/src/session-message-relay.ts';
import { adaptHostInput } from '../../../mcp-server/src/host-input-adapter.ts';
import { recordWakeHookObservation, wakeHookObservationReader } from '../../../mcp-server/src/session-message-wake-port.ts';

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
if (mode === 'rebuild-failure') {
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql.includes('RENAME TO wake_nonces')) throw new Error('fixture rebuild failure');
    return original.call(this, sql);
  };
  try { new SessionMessageStore(database); process.exit(2); }
  catch (error) { process.send({ type: 'result', error: error.message }); process.exit(0); }
}
const store = new SessionMessageStore(database);
process.send({ type: 'ready' });
process.once('message', async (input) => {
  try {
    if (mode === 'open-only') {
      process.send({ type: 'result', version: store.database.prepare('PRAGMA user_version').get().user_version });
    } else if (mode === 'retire-then-exit') {
      store.prune(input.now);
      process.exit(21);
    } else if (mode === 'wake-transition') {
      const current = { ...target, instanceId: input.instanceId ?? 'instance-2', transport: 'portable', relayId,
        wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } };
      let result;
      if (input.kind === 'outcome') result = store.recordManagedWakeOutcome(input.attempt, 'definite-failure', input.now);
      else if (input.kind === 'start') result = store.startManagedWake(input.attempt, input.now);
      else {
        if (input.kind === 'generation') store.startPresence(current, input.now);
        store.acquireRelay({ ...current, pid: process.pid, parentPid: Number(parentPid) }, input.now);
        result = store.reserveManagedWake({ ...current, nonce: `fixture-${relayId}-nonce-abcdefghijklmnop`, resume: true }, input.now);
        if (input.kind === 'effect' && result.dispatch) {
          result = store.startManagedWake(result.attempt, input.now + 1);
          if (result.dispatch) {
            appendFileSync(effects, `${result.attempt.nonce}\n`, 'utf8');
            store.recordManagedWakeOutcome(result.attempt, 'submitted', input.now + 2);
          }
        }
      }
      process.send({ type: 'result', result });
    } else if (mode === 'sender') {
      store.send({ sender: { host: 'portable', sessionId: relayId }, target, messageId: relayId, body: relayId });
      process.send({ type: 'result', sent: true });
    } else if (mode === 'reconcile-wake') {
      process.send({ type: 'result', result: dispatch(store, 'reconcile-wake-observation', input) });
    } else if (mode === 'observe-wake') {
      const observation = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId,
        agent_id: '', prompt: `[agent-governance-suite:wake:${input.nonce}]` }, target.host).observation;
      const sourceReceiptId = recordWakeHookObservation(observation);
      const result = store.claimHostWake(target, observation, sourceReceiptId, wakeHookObservationReader);
      process.send({ type: 'result', result });
    } else if (mode === 'claim-and-ack') {
      store.observeNativeInput(target);
      store.claimDeferred(target); // Preserve the first native-input boundary.
      const messages = store.claimDeferred(target);
      store.acknowledge(target, messages.map(message => message.messageId));
      process.send({ type: 'result', claimed: messages.map(message => message.messageId) });
    } else {
      store.acquireRelay({ ...target, transport: 'portable', relayId, pid: process.pid, parentPid: Number(parentPid) });
      const request = async (operation, payload) => {
        if (mode === 'crash-before-start' && operation === 'start-wake') process.exit(17);
        if (mode === 'crash-after-effect' && operation === 'record-wake-outcome') process.exit(19);
        const result = dispatch(store, operation, payload);
        if (mode === 'crash-after-start' && operation === 'start-wake') process.exit(18);
        return result;
      };
      const called = await dispatchManagedWake({ ...target, instanceId: input?.instanceId ?? 'instance-1', transport: 'portable' }, relayId,
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
