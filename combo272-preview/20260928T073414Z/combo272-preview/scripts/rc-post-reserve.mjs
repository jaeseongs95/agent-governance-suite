// After reconcile (copy of A): refresh live presence/relay for T3 (reconciled) and T1 (not reconcilable) and try reserve.
import { join } from 'node:path';
const [root, dir] = process.argv.slice(2);
const { SessionMessageStore } = await import(join(root, 'mcp-server/src/session-message-store.ts'));
const store = new SessionMessageStore(join(dir, 'session-messages.sqlite3'));
const now = Date.now();
for (const sessionId of ['exp-T3-late-unknown', 'exp-T1-gen-unknown']) {
  const t = { host: 'codex', sessionId };
  const before = store.managedWakeStatus(t, now);
  store.startPresence({ ...t, instanceId: 'inst-3', transport: 'codex-queue', wakeVisibility: 'user-message', canWakeSilently: false,
    deliveryCapabilities: { supportedInjection: ['peer-wake', 'tool-boundary'], idleWake: 'user-message' } }, now);
  const relay = store.acquireRelay({ ...t, transport: 'codex-queue', relayId: 'relay-3', pid: process.pid, parentPid: process.pid }, now);
  store.send({ sender: { host: 'portable', sessionId: 'exp-sender' }, target: t, messageId: `post-body-${sessionId}`, body: 'post' }, now);
  const r = store.reserveManagedWake({ ...t, instanceId: 'inst-3', transport: 'codex-queue', relayId: 'relay-3', nonce: `post-${sessionId}-abcdefghijklmnopqrstuv` }, now + 1);
  console.log(JSON.stringify({ sessionId, statusBefore: before, relayAcquired: relay, pending: store.pendingCount(t, now + 1), reserveDispatch: r.dispatch }));
}
store.close();
