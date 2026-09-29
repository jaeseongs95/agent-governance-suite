// Fixture seeding (mirrors tests/session-messaging/historical-wake.test.mjs fixture()).
// Usage: node --import tsx seed.mjs <sessionDbPath> <trustDbPathForReceipt> [offsetMs=-60000]
import { SessionMessageStore } from '/tmp/e9/mcp-server/src/session-message-store.ts';
import { adaptHostInput } from '/tmp/e9/mcp-server/src/host-input-adapter.ts';
const [database, trustPath, offset = '-60000'] = process.argv.slice(2);
process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = trustPath; // seed process only: where the hook receipt is written
const { recordWakeHookObservation } = await import('/tmp/e9/mcp-server/src/session-message-wake-port.ts');
const target = { host: 'portable', sessionId: 'wake-target' };
const store = new SessionMessageStore(database);
const now = Date.now() + Number(offset);
const presence = instanceId => ({ ...target, instanceId, transport: 'portable', wakeVisibility: 'silent',
  canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } });
store.startPresence(presence('instance-1'), now);
store.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-1', pid: process.pid, parentPid: process.pid }, now);
store.send({ sender: { host: 'portable', sessionId: 'sender' }, target, messageId: 'history-body', body: 'pending body' }, now);
const nonce = process.env.SEED_NONCE ?? 'history-nonce-abcdefghijklmnop';
const reserved = store.reserveManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable', relayId: 'relay-1', nonce }, now);
const attempt = store.startManagedWake(reserved.attempt, now + 1).attempt;
store.recordManagedWakeOutcome(attempt, 'accepted-or-unknown', now + 2);
store.startPresence(presence('instance-2'), now + 5);
const observation = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId,
  agent_id: '', prompt: `[agent-governance-suite:wake:${attempt.nonce}]` }, target.host).observation;
const sourceReceiptId = recordWakeHookObservation(observation, now + 10);
store.database.prepare("UPDATE wake_nonces SET late_observed_at = ? WHERE state = 'unknown'").run(new Date(now + 11).toISOString());
store.close();
process.stdout.write(JSON.stringify({ target, attemptId: attempt.attemptId, sourceReceiptId, now, nonceDigestOnly: true }) + '\n');
