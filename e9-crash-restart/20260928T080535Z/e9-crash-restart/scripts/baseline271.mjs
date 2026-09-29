// Builds an authentic historical DB with the frozen v2.7.1 code (main d5c5932):
//  A = old-generation hook arrival left as state=unknown + late_observed_at (reconcilable, receipt exists)
//  B = accepted-or-unknown outcome, generation change, no hook arrival (unknown without any receipt)
// usage: (cwd /tmp/v271) node --import tsx baseline271.mjs <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const out = process.argv[2];
mkdirSync(out, { recursive: true });
process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = join(out, 'trust.sqlite3');
const src = '/tmp/v271/mcp-server/src';
const { SessionMessageStore } = await import(`${src}/session-message-store.ts`);
const { adaptHostInput } = await import(`${src}/host-input-adapter.ts`);
const { recordWakeHookObservation, createWakeHookObservationReader } = await import(`${src}/session-message-wake-port.ts`);

const hotWal = process.argv[3] === 'hotwal';
let holder = null;
if (hotWal) { const { TrustStore } = await import(`${src}/trust-store.ts`); new TrustStore(join(out, 'trust.sqlite3')).close();
  const { DatabaseSync } = await import('node:sqlite'); holder = new DatabaseSync(join(out, 'trust.sqlite3')); holder.exec('PRAGMA wal_autocheckpoint = 0'); holder.prepare('SELECT count(*) FROM trust_metadata').get(); }
const store = new SessionMessageStore(join(out, 'session-messages.sqlite3'));
const T0 = Date.now() - 10 * 60_000;
const presence = (sessionId, instanceId) => ({ host: 'portable', sessionId, instanceId, transport: 'portable', wakeVisibility: 'silent',
  canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } });
const meta = { T0: new Date(T0).toISOString(), targets: {} };
for (const [sessionId, arrive] of [['wake-A', true], ['wake-B', false]]) {
  const target = { host: 'portable', sessionId };
  store.startPresence(presence(sessionId, 'instance-1'), T0);
  store.acquireRelay({ ...target, transport: 'portable', relayId: `relay-${sessionId}-1`, pid: process.pid, parentPid: process.pid }, T0);
  store.send({ sender: { host: 'portable', sessionId: 'sender' }, target, messageId: `hist-body-${sessionId}`, body: `pending ${sessionId}`, ttlSeconds: 86400 }, T0);
  const reserved = store.reserveManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable', relayId: `relay-${sessionId}-1`,
    nonce: `histnonce${sessionId.replace('-', '')}abcdefghijklmnop` }, T0);
  const attempt = store.startManagedWake(reserved.attempt, T0 + 1).attempt;
  store.recordManagedWakeOutcome(attempt, 'accepted-or-unknown', T0 + 2);
  store.startPresence(presence(sessionId, 'instance-2'), T0 + 5);
  let sourceReceiptId = null;
  if (arrive) {
    const observation = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, agent_id: '',
      prompt: `[agent-governance-suite:wake:${attempt.nonce}]` }, 'portable').observation;
    sourceReceiptId = recordWakeHookObservation(observation, T0 + 10);
    const r = store.claimHostWake(target, observation, sourceReceiptId, createWakeHookObservationReader(), T0 + 10);
    meta.targets[sessionId + ':claim'] = r;
  }
  meta.targets[sessionId] = { attemptId: attempt.attemptId, nonce: attempt.nonce, sourceReceiptId,
    row: store.database.prepare('SELECT * FROM wake_nonces WHERE attempt_id = ?').get(attempt.attemptId) };
}
store.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
store.close();
writeFileSync(join(out, 'baseline.json'), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2));
if (hotWal) { const { statSync } = await import('node:fs'); console.error('trust-wal-bytes', statSync(join(out, 'trust.sqlite3-wal')).size); process.kill(process.pid, 'SIGKILL'); }
