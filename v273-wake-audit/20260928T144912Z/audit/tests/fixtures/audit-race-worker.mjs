// Audit child process: waits for a start barrier message, then performs one operation on a shared SQLite file.
import { appendFileSync } from 'node:fs';
import { SessionMessageStore } from '../../../mcp-server/src/session-message-store.ts';
import { adaptHostInput } from '../../../mcp-server/src/host-input-adapter.ts';
import { recordWakeHookObservation, wakeHookObservationReader } from '../../../mcp-server/src/session-message-wake-port.ts';

const [mode, database, effects, relayId] = process.argv.slice(2);
const target = { host: 'portable', sessionId: 'audit-target' };
const caps = { supportedInjection: ['peer-wake', 'tool-boundary'], idleWake: 'silent' };
const store = new SessionMessageStore(database);
process.send({ type: 'ready' });
process.once('message', (input) => {
  try {
    let result;
    if (mode === 'relay-effect') {
      // Every relay owns the same live instance lease (same parent pid), mirrors a relay tick, then reserve/start/effect.
      store.acquireRelay({ ...target, transport: 'portable', relayId, pid: process.pid, parentPid: input.parentPid }, input.now);
      const r = store.reserveManagedWake({ ...target, nonce: `audit-${relayId}-nonce-abcdefghijklmnop`, instanceId: input.instanceId,
        transport: 'portable', relayId, resume: true }, input.now);
      result = { reserved: r.dispatch, attemptId: r.attempt?.attemptId ?? null };
      if (r.dispatch) {
        const s = store.startManagedWake(r.attempt, input.now + 1);
        result.started = s.dispatch;
        if (s.dispatch) {
          appendFileSync(effects, `${s.attempt.attemptId} ${relayId}\n`, 'utf8');
          store.recordManagedWakeOutcome(s.attempt, 'submitted', input.now + 2);
        }
      }
    } else if (mode === 'late-arrival') {
      process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = input.trustPath;
      const observation = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId, agent_id: '',
        prompt: `[agent-governance-suite:wake:${input.nonce}]` }, target.host).observation;
      const receipt = recordWakeHookObservation(observation, input.now);
      result = store.claimHostWake(target, observation, receipt, wakeHookObservationReader, input.now);
    } else if (mode === 'activity') {
      store.observeNativeInput(target, input.now);
      result = { ok: true };
    }
    void caps;
    process.send({ type: 'result', result });
    store.close(); process.exit(0);
  } catch (error) { process.send({ type: 'result', error: String(error?.message ?? error) }); store.close(); process.exit(1); }
});
