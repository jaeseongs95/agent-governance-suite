// Late outcome from an old-generation dispatcher on a fenced (started->unknown, no late) row. ROOT via argv[2].
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { randomBytes } from 'node:crypto';
const ROOT = process.argv[2]; const OUTCOME = process.argv[3];
const dir = mkdtempSync(join(tmpdir(), 'late-out-')); process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = join(dir, 'trust.sqlite3');
const { SessionMessageStore } = await import(`${ROOT}/mcp-server/src/session-message-store.ts`);
const target = { host: 'portable', sessionId: 'late-target' };
const pres = i => ({ ...target, instanceId: i, transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } });
const s = new SessionMessageStore(join(dir, 'm.sqlite3')); const now = Date.now();
const row = () => { const r = s.database.prepare('SELECT state, instance_id, relay_id, dispatch_epoch, retry_not_before, late_observed_at FROM wake_nonces').all(); return JSON.stringify(r); };
s.startPresence(pres('inst-1'), now); s.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-1', pid: 1, parentPid: 1 }, now);
s.send({ sender: { host: 'portable', sessionId: 'sender' }, target, messageId: 'late-msg-1', body: 'b' }, now);
const old = s.startManagedWake(s.reserveManagedWake({ ...target, instanceId: 'inst-1', transport: 'portable', relayId: 'relay-1', nonce: randomBytes(18).toString('base64url') }, now).attempt, now + 1).attempt;
console.log('1 started old attempt (effect in flight):', row());
s.startPresence(pres('inst-2'), now + 100); s.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-2', pid: 2, parentPid: 2 }, now + 16_000);
const fence = s.reserveManagedWake({ ...target, instanceId: 'inst-2', transport: 'portable', relayId: 'relay-2', nonce: randomBytes(18).toString('base64url') }, now + 16_000);
console.log('2 new-generation reserve fences old started->unknown; dispatch =', fence.dispatch, row());
console.log(`3 late outcome '${OUTCOME}' from old dispatcher recorded =`, s.recordManagedWakeOutcome(old, OUTCOME, now + 16_500), row());
for (const dt of [17_000, 20 * 60_000, 2 * 3_600_000]) {
  s.startPresence(pres('inst-2'), now + dt); s.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-2', pid: 2, parentPid: 2 }, now + dt);
  const r1 = s.reserveManagedWake({ ...target, instanceId: 'inst-2', transport: 'portable', relayId: 'relay-2', nonce: randomBytes(18).toString('base64url') }, now + dt);
  const r2 = s.reserveManagedWake({ ...target, instanceId: 'inst-2', transport: 'portable', relayId: 'relay-2', nonce: randomBytes(18).toString('base64url'), resume: true }, now + dt);
  const st = s.startManagedWake(old, now + dt);
  console.log(`4 +${dt}ms current-gen reserve=${r1.dispatch} resume=${r2.dispatch} old start=${st.dispatch} pending=${s.pendingCount(target, now + dt)}`, row());
}
if (typeof s.reconcileHistoricalWake === 'function') console.log('5 reconcile (no receipt) =', JSON.stringify(s.reconcileHistoricalWake(target, old.attemptId, 'source-none', now + 2 * 3_600_000)));
s.close();
