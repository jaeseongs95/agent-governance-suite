import { appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SessionMessageStore } from '../../../mcp-server/src/session-message-store.ts';
import { dispatchSessionMessageOperation as dispatch } from '../../../mcp-server/src/session-message-operations.ts';
import { dispatchManagedWake } from '../../../mcp-server/src/session-message-relay.ts';
import '../../../mcp-server/src/builtin-hook-host-adapters.ts';
import { adaptHostInput, registerHookHostAdapter } from '../../../mcp-server/src/host-input-adapter.ts';
import { recordWakeHookObservation, wakeHookObservationReader } from '../../../mcp-server/src/session-message-wake-port.ts';

// relayId names this worker: a relay that was granted a lease uses the granted relay_id, otherwise this name (fenced).
const [mode, database, effects, relayId, parentPid] = process.argv.slice(2);
// The host process the parent test reported for the birth and the birth the relay's watcher bound (docs/ags30-broker-redesign.md 3.3).
const hostPid = Number(parentPid);
const HOST_START = 'synthetic-host-start';
// Explicit synthetic root adapter for core regression cases; not native capture or R7 evidence.
// The builtin decoder supplies event shape only; actor authority is this fake fixture contract.
registerHookHostAdapter("portable", {
    adaptInput: (input, selectedHost) => {
      const adapted = adaptHostInput(input, "codex");
      return {...adapted, observation: {...adapted.observation, host: selectedHost,
        actor: {role: "root", basis: "observed", reasonCode: "SYNTHETIC_CORE_ROOT"}}};
    },
  deliveryProfile: () => ({transport: "claude-inbox", capabilities: {supportedInjection: [], idleWake: "none"}, blocksEmptyWakePrompt: false}),
  processPid: () => undefined,
});

const target = { host: 'portable', sessionId: 'wake-target' };
if (mode === 'migration-failure') {
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql.includes('DROP TABLE wake_nonces;')) throw new Error('fixture migration failure');
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
// Default-time operations read the command clock below (an explicit fixture time per process), sampled under the writer lock.
const store = new SessionMessageStore(database, { clock: () => Date.now() });
/** Grants the birth a lease and binds the host birth with the relay's first tick; null when the store refuses the grant. */
function grantRelay(instanceId, at) {
  const grant = store.grantRelay({ ...target, transport: 'portable', instanceId, codeDigest: null, hostPid }, at);
  if (grant.relayId === null) return null;
  const tick = store.relayTick({ ...target, transport: 'portable', relayId: grant.relayId, instanceId, includePending: false, hostStart: HOST_START }, at);
  if (!tick.alive || !tick.hostBound) throw new Error('Fixture relay could not bind its granted lease.');
  return grant.relayId;
}
const HANDED = { result: 'handed-off' };
const TRANSIENT = { result: 'not-delivered', kind: 'transient', reasonCode: 'SYNTHETIC_TRANSIENT' };
const BASE = 10 * 60_000;
process.send({ type: 'ready' });
if (mode === 'ring-race') {
  // Two phases on one real connection: reserve, then start; the external effect follows only a committed start (I3).
  process.on('message', (input) => {
    try {
      if (input.phase === 'reserve') {
        const result = store.reserveManagedWake({ ...input.binding, nonce: `race-${relayId}-${process.pid}-nonce-abcdefghij`, resume: true }, input.now);
        process.send({ type: 'result', result });
        return;
      }
      let result = { dispatch: false, attempt: null };
      if (input.attempt) {
        result = store.startManagedWake(input.attempt, input.resendBaseMs, input.now);
        if (result.dispatch) {
          appendFileSync(effects, `${result.attempt.nonce}
`, 'utf8');
          store.recordManagedWakeOutcome(result.attempt, HANDED, input.resendBaseMs, input.now + 1);
        }
      }
      process.send({ type: 'result', result }, () => { store.close(); process.exit(0); });
    } catch (error) { process.send({ type: 'result', result: null, error: error.message }, () => { store.close(); process.exit(1); }); }
  });
} else process.once('message', async (input) => {
  try {
    // Explicit command clocks keep lease-expiry scenarios deterministic across independent fixture processes.
    if (input && typeof input === 'object' && Number.isSafeInteger(input.now) && input.now >= 0) {
      Date.now = () => input.now;
    }
    if (mode === 'open-only') {
      process.send({ type: 'result', version: store.database.prepare('PRAGMA user_version').get().user_version });
    } else if (mode === 'retire-then-exit') {
      store.prune(input.now);
      process.exit(21);
    } else if (mode === 'wake-transition') {
      const current = { ...target, instanceId: input.instanceId ?? 'instance-2', transport: 'portable', relayId,
        wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' }, hostPid };
      let result;
      if (input.kind === 'outcome') result = store.recordManagedWakeOutcome(input.attempt, TRANSIENT, BASE, input.now);
      else if (input.kind === 'start') result = store.startManagedWake(input.attempt, BASE, input.now);
      else {
        if (input.kind === 'generation') store.startPresence(current, input.now);
        // generation/effect workers are boundary hooks that grant their birth a relay; a 'relay' worker only holds argv relayId.
        if (input.kind === 'generation' || input.kind === 'effect') {
          const granted = grantRelay(current.instanceId, input.now);
          if (input.kind === 'generation' && !granted) throw new Error('Fixture generation was refused a relay lease.');
          if (granted) current.relayId = granted;
        }
        result = store.reserveManagedWake({ ...current, nonce: `fixture-${relayId}-nonce-abcdefghijklmnop`, resume: true }, input.now);
        if (input.kind === 'effect' && result.dispatch) {
          result = store.startManagedWake(result.attempt, BASE, input.now + 1);
          if (result.dispatch) {
            appendFileSync(effects, `${result.attempt.nonce}\n`, 'utf8');
            store.recordManagedWakeOutcome(result.attempt, HANDED, BASE, input.now + 2);
          }
        }
      }
      process.send({ type: 'result', result });
    } else if (mode === 'sender') {
      store.send({ sender: { host: 'portable', sessionId: relayId }, target, messageId: relayId, body: relayId });
      process.send({ type: 'result', sent: true });
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
      store.acknowledge(target, messages.map(message => message.messageId), undefined, messages.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt })));
      process.send({ type: 'result', claimed: messages.map(message => message.messageId) });
    } else {
      const instanceId = input?.instanceId ?? 'instance-1';
      const granted = grantRelay(instanceId, Number.isSafeInteger(input?.now) ? input.now : undefined);
      if (mode.startsWith('crash-') && !granted) throw new Error('Fixture crash worker was refused the expired relay lease.');
      // A worker refused the grant still runs one cycle under its own name, which the store fences (3.3).
      const servingId = granted ?? relayId;
      const request = async (operation, payload) => {
        if (mode === 'crash-before-start' && operation === 'start-wake') process.exit(17);
        if (mode === 'crash-after-effect' && operation === 'record-wake-outcome') process.exit(19);
        const result = dispatch(store, operation, payload);
        if (mode === 'crash-after-start' && operation === 'start-wake') process.exit(18);
        return result;
      };
      const called = await dispatchManagedWake({ ...target, instanceId, transport: 'portable' }, servingId,
        { capabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' }, resendBaseMs: BASE,
          dispatch: async (_target, marker) => {
            const row = store.database.prepare("SELECT state FROM wake_nonces WHERE state = 'started'").get();
            if (!row) throw new Error('effect started without a persisted intent');
            appendFileSync(effects, `${marker}\n`, 'utf8');
            return HANDED;
          } }, request);
      process.send({ type: 'result', called, granted: granted !== null });
    }
    store.close();
    process.exit(0);
  } catch (error) { process.send({ type: 'result', error: error.message }); store.close(); process.exit(1); }
});
