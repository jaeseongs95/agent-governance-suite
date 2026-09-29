// Fuzz fixture writer (fix sources). Usage: node --import tsx fuzz-seed.mjs <R> <D>
// Targets: A (valid receipt in R/trust), B (late-unknown, no receipt anywhere), C (receipt only in default-path D/trust),
// T (terminal submitted), U (terminal definite-failure). All old-generation (instance-2 presence started after).
const SRC = '/tmp/fix';
const { SessionMessageStore } = await import(`${SRC}/mcp-server/src/session-message-store.ts`);
const { adaptHostInput } = await import(`${SRC}/mcp-server/src/host-input-adapter.ts`);
const { recordWakeHookObservation } = await import(`${SRC}/mcp-server/src/session-message-wake-port.ts`);
const [R, D] = process.argv.slice(2);
const store = new SessionMessageStore(`${R}/session-messages.sqlite3`);
const now = Date.now() - 60_000;
const out = {};
for (const [name, kind] of [['A', 'R'], ['B', 'none'], ['C', 'D'], ['T', 'submitted'], ['U', 'definite-failure']]) {
  const target = { host: 'portable', sessionId: `fz-${name}` };
  const presence = (instanceId) => ({ ...target, instanceId, transport: 'portable', wakeVisibility: 'silent',
    canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } });
  store.startPresence(presence('instance-1'), now);
  store.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-1', pid: process.pid, parentPid: process.pid }, now);
  store.send({ sender: { host: 'portable', sessionId: 'sender' }, target, messageId: `fuzz-body-${name}`, body: 'pending body' }, now);
  const nonce = `fuzz-nonce-${name}-abcdefghijklmnop`;
  const reserved = store.reserveManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable', relayId: 'relay-1', nonce }, now);
  const attempt = store.startManagedWake(reserved.attempt, now + 1).attempt;
  const terminal = kind === 'submitted' || kind === 'definite-failure';
  store.recordManagedWakeOutcome(attempt, terminal ? kind : 'accepted-or-unknown', now + 2);
  store.startPresence(presence('instance-2'), now + 5);
  let sourceReceiptId = null;
  if (kind === 'R' || kind === 'D') {
    process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = kind === 'R' ? `${R}/trust.sqlite3` : `${D}/trust.sqlite3`;
    const observation = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId,
      agent_id: '', prompt: `[agent-governance-suite:wake:${attempt.nonce}]` }, target.host).observation;
    sourceReceiptId = recordWakeHookObservation(observation, now + 10);
  }
  out[name] = { target, attemptId: attempt.attemptId, sourceReceiptId };
}
if (!out.A.sourceReceiptId) throw new Error('A receipt missing');
store.database.prepare("UPDATE wake_nonces SET late_observed_at = ? WHERE state = 'unknown'").run(new Date(now + 11).toISOString());
store.close();
process.stdout.write(JSON.stringify(out) + '\n');
