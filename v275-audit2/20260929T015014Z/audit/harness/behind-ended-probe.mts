// Audit-only: the new 'live-birth-behind-ended' case shape (portable host, same timings as wake-liveness.test.mjs),
// checking why each extra assertion holds. Usage: node --import tsx behind-ended-probe.mts <store module path>
const { SessionMessageStore, WAKE_TTL_MS, WAKE_RETIRE_GRACE_MS } = await import(process.argv[2]);
const target = { host: "portable", sessionId: "wake-target" };
const capabilities = { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "silent" };
const iso = (ms: number) => new Date(ms).toISOString();
const out: Record<string, unknown> = {};
for (const variant of ["as-test", "relay-1-refreshed", "control-no-B"]) {
  const store = new SessionMessageStore(":memory:");
  try {
    const now = Date.now(); const retireAt = now + WAKE_TTL_MS + WAKE_RETIRE_GRACE_MS;
    const live = (instanceId: string, relayId: string, at: number) => {
      store.startPresence({ ...target, instanceId, transport: "portable", wakeVisibility: "silent", canWakeSilently: true, deliveryCapabilities: capabilities }, at);
      store.acquireRelay({ ...target, transport: "portable", relayId, pid: process.pid, parentPid: process.pid }, at);
    };
    const request = (instanceId: string, relayId: string, nonce = `${instanceId}-next-nonce-abcdefghijklmnop`) => ({ ...target, nonce, instanceId, transport: "portable", relayId, resume: true });
    live("instance-1", "relay-1", now);
    store.send({ sender: { host: "portable", sessionId: "liveness-sender" }, target, messageId: "pending-body", body: "pending-body", ttlSeconds: 86400 }, now);
    const r = store.reserveManagedWake(request("instance-1", "relay-1", "liveness-first-nonce-abcdefghijklmnop"), now);
    const s = store.startManagedWake(r.attempt, now + 1);
    store.recordManagedWakeOutcome(s.attempt, "submitted", now + 2);
    if (variant !== "control-no-B") { live("instance-2", "relay-2", now + 20); store.endPresence(target, "fixture-ended", "instance-2", now + 30); }
    store.database.prepare("UPDATE session_presence SET lease_until = ? WHERE instance_id = ?").run(iso(retireAt + 60_000), "instance-1");
    const relayAcquired = variant === "as-test" ? null : store.acquireRelay({ ...target, transport: "portable", relayId: "relay-1", pid: process.pid, parentPid: process.pid }, retireAt);
    store.prune(retireAt);
    const state = (store.database.prepare("SELECT state FROM wake_nonces WHERE nonce LIKE 'liveness-first%'").get() as { state: string }).state;
    const presence = store.presence(target, retireAt);
    const relays = store.database.prepare("SELECT relay_id, lease_until > ? AS live FROM relay_leases").all(iso(retireAt));
    const reserve = store.reserveManagedWake(request("instance-1", "relay-1"), retireAt).dispatch;
    const outlook = store.autoWakeOutlook(target, retireAt);
    out[variant] = { oldWake: state, presence: { state: presence.state, instanceId: presence.instanceId }, relayAcquired, relays, reserveDispatch: reserve, outlook: { state: outlook.state, reason: outlook.reason } };
  } finally { store.close(); }
}
console.log(JSON.stringify(out, null, 1));
