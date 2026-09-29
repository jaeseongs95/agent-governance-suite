// Audit-only probes for v2.7.5 (run unchanged in the 0c8b52d9 and 3501e7c5 worktrees; never committed to the product).
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";
import { SessionMessageStore, WAKE_RETIRE_GRACE_MS, WAKE_TTL_MS, PRESENCE_LEASE_MS } from "../../mcp-server/src/session-message-store.js";

const LOG = process.env.AGS_AUDIT_LOG ?? path.join(tmpdir(), "v275-audit.log");
const log = (line: string) => appendFileSync(LOG, `${line}\n`);
const hook = fileURLToPath(new URL("../../mcp-server/dist/session-message-hook.mjs", import.meta.url));
const broker = fileURLToPath(new URL("../../mcp-server/src/session-message-broker.ts", import.meta.url));
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const task of cleanup.splice(0).reverse()) await task(); });
const caps = { supportedInjection: ["peer-wake", "tool-boundary"] as Array<"peer-wake" | "tool-boundary">, idleWake: "user-message" as const };
const MIN = 60_000;

async function world() {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-v275-audit-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const child = spawn(process.execPath, ["--import", "tsx", broker, "--state-directory", directory], { windowsHide: true, stdio: "ignore" });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; } });
  await waitForSessionMessageBrokerReady(directory, child, 5000);
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", directory);
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", path.join(directory, "trust.sqlite3"));
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "1");
  const database = path.join(directory, "session-messages.sqlite3");
  const withStore = <T>(fn: (store: SessionMessageStore) => T): T => { const store = new SessionMessageStore(database); try { return fn(store); } finally { store.close(); } };
  const invoke = (sessionId: string, nonce: string) => {
    const input = { hook_event_name: "UserPromptSubmit", session_id: sessionId, agent_id: "", prompt: `[agent-governance-suite:wake:${nonce}]` };
    const result = spawnSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: "utf8", timeout: 15_000, windowsHide: true, env: { ...process.env } });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout ? JSON.parse(result.stdout) as Record<string, unknown> : {};
  };
  return { withStore, invoke };
}

function wakeRow(store: SessionMessageStore, sessionId: string, nonceFragment: string) {
  return store.database.prepare(`SELECT state, retired_at IS NOT NULL AS retired, late_observed_at IS NOT NULL AS late, observed_at IS NOT NULL AS observed
    FROM wake_nonces WHERE session_id = ? AND nonce LIKE ?`).get(sessionId, `%${nonceFragment}%`) as Record<string, unknown>;
}
function messageRow(store: SessionMessageStore, sessionId: string) {
  return store.database.prepare("SELECT message_id, acknowledged_at IS NOT NULL AS acked, claim_until IS NOT NULL AS claimed FROM messages WHERE target_session_id = ?").get(sessionId);
}

// Sleep/resume: birth lapses (no end), wake submitted before sleep, resume after expiry + grace.
for (const order of ["O1-prune-then-old-marker", "O2-old-marker-first-no-prune", "O3-reregister-then-old-marker"] as const) {
  it(`sleep/resume ${order}: old marker, then the returning birth gets a new wake that delivers the body`, async () => {
    const { withStore, invoke } = await world();
    const target = { host: "codex", sessionId: `sleep-${order.slice(0, 2).toLowerCase()}` };
    const T = Date.now() - WAKE_TTL_MS - WAKE_RETIRE_GRACE_MS - 5 * MIN;
    const oldNonce = `old-${order.slice(0, 2)}-nonce-abcdefghijklmnopq`;
    withStore((store) => {
      store.startPresence({ ...target, instanceId: "inst", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: caps }, T);
      store.acquireRelay({ ...target, transport: "codex-queue", relayId: "relay-1", pid: process.pid, parentPid: process.pid }, T);
      store.send({ sender: { host: "portable", sessionId: "sender" }, target, messageId: "body-sleep-message", body: "peer body after sleep", ttlSeconds: 86400 }, T);
      const reserved = store.reserveManagedWake({ ...target, nonce: oldNonce, instanceId: "inst", transport: "codex-queue", relayId: "relay-1" }, T);
      expect(reserved.dispatch).toBe(true);
      const started = store.startManagedWake(reserved.attempt!, T + 1);
      expect(store.recordManagedWakeOutcome(started.attempt!, "submitted", T + 2)).toBe(true);
    });
    const reregister = () => withStore((store) => {
      store.startPresence({ ...target, instanceId: "inst", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: caps });
      store.acquireRelay({ ...target, transport: "codex-queue", relayId: "relay-2", pid: process.pid, parentPid: process.pid });
    });
    if (order === "O1-prune-then-old-marker") withStore((store) => store.pendingCount({ host: "codex", sessionId: "someone-else" }));
    if (order === "O3-reregister-then-old-marker") reregister();
    const beforeMarker = withStore((store) => wakeRow(store, target.sessionId, oldNonce));
    const first = invoke(target.sessionId, oldNonce);
    const afterMarker = withStore((store) => ({ wake: wakeRow(store, target.sessionId, oldNonce), message: messageRow(store, target.sessionId) }));
    if (order !== "O3-reregister-then-old-marker") reregister();
    const newNonce = `new-${order.slice(0, 2)}-nonce-abcdefghijklmnopq`;
    const reservation = withStore((store) => {
      const reserved = store.reserveManagedWake({ ...target, nonce: newNonce, instanceId: "inst", transport: "codex-queue", relayId: "relay-2" });
      if (!reserved.dispatch) return { dispatch: false };
      const started = store.startManagedWake(reserved.attempt!);
      store.recordManagedWakeOutcome(started.attempt!, "submitted");
      return { dispatch: started.dispatch };
    });
    const second = invoke(target.sessionId, newNonce);
    const final = withStore((store) => ({ message: messageRow(store, target.sessionId), wake: wakeRow(store, target.sessionId, newNonce) }));
    log(JSON.stringify({ probe: order, beforeMarker, firstHook: first, afterMarker, newWake: reservation,
      secondHookDeliversBody: JSON.stringify(second).includes("peer body after sleep"), final }));
    expect(reservation.dispatch).toBe(true);
    expect(JSON.stringify(second)).toContain("peer body after sleep");
  }, 60_000);
}

it("B: lease end boundary: retirement, heartbeat and presence agree at the same millisecond", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-v275-audit-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const out: Record<string, unknown> = {};
  for (const offset of [-1, 0]) {
    const store = new SessionMessageStore(path.join(directory, `b${offset}.sqlite3`));
    try {
      const target = { host: "codex", sessionId: "boundary" };
      const T = Date.now() - 5 * 3600_000;
      store.startPresence({ ...target, instanceId: "inst", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: caps }, T);
      store.acquireRelay({ ...target, transport: "codex-queue", relayId: "relay-1", pid: process.pid, parentPid: process.pid }, T);
      store.send({ sender: { host: "portable", sessionId: "sender" }, target, messageId: "body-boundary-message", body: "b", ttlSeconds: 86400 }, T);
      const r = store.reserveManagedWake({ ...target, nonce: "boundary-nonce-abcdefghijklmnopq", instanceId: "inst", transport: "codex-queue", relayId: "relay-1" }, T);
      store.recordManagedWakeOutcome(store.startManagedWake(r.attempt!, T + 1).attempt!, "submitted", T + 2);
      // Keep the birth alive by heartbeats until past expiry + grace, then stop; the lease ends at L.
      let at = T + 10_000;
      const until = T + WAKE_TTL_MS + WAKE_RETIRE_GRACE_MS + 60_000;
      for (; at < until; at += 10_000) { store.database.prepare("UPDATE relay_leases SET lease_until = ?, updated_at = ?").run(new Date(at + 15_000).toISOString(), new Date(at).toISOString()); if (!store.heartbeatPresence(target, "inst", at)) throw new Error(`heartbeat failed at ${at}`); }
      const L = Date.parse(store.presence(target, at).leaseUntil!);
      const now = L + offset;
      store.pendingCount({ host: "codex", sessionId: "other" }, now); // prune at now
      const state = store.database.prepare("SELECT state FROM wake_nonces").get() as { state: string };
      const presence = store.presence(target, now).state;
      const heartbeat = store.heartbeatPresence(target, "inst", now);
      out[`offset${offset}`] = { wakeState: state.state, presence, heartbeatAccepted: heartbeat };
    } finally { store.close(); }
  }
  log(JSON.stringify({ probe: "B-lease-boundary", ...out }));
});

it("E: two instances born in the same millisecond: the wake of the earlier row, the later row live and quiet", () => {
  const store = new SessionMessageStore(":memory:");
  try {
    const target = { host: "codex", sessionId: "tie" };
    const T = Date.now() - 3 * 3600_000;
    store.startPresence({ ...target, instanceId: "a", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: caps }, T);
    store.acquireRelay({ ...target, transport: "codex-queue", relayId: "relay-a", pid: process.pid, parentPid: process.pid }, T);
    store.send({ sender: { host: "portable", sessionId: "sender" }, target, messageId: "body-tie-message", body: "b", ttlSeconds: 86400 }, T);
    const r = store.reserveManagedWake({ ...target, nonce: "tie-nonce-a-abcdefghijklmnopq", instanceId: "a", transport: "codex-queue", relayId: "relay-a" }, T);
    store.recordManagedWakeOutcome(store.startManagedWake(r.attempt!, T).attempt!, "submitted", T);
    store.startPresence({ ...target, instanceId: "b", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: caps }, T);
    const now = T + WAKE_TTL_MS + WAKE_RETIRE_GRACE_MS + 60_000;
    store.database.prepare("UPDATE session_presence SET lease_until = ?").run(new Date(now + PRESENCE_LEASE_MS).toISOString());
    store.database.prepare("DELETE FROM relay_leases").run();
    store.acquireRelay({ ...target, transport: "codex-queue", relayId: "relay-b", pid: process.pid, parentPid: process.pid }, now);
    const state = (store.database.prepare("SELECT state FROM wake_nonces WHERE nonce LIKE 'tie-nonce-a%'").get() as { state: string }).state;
    const again = store.reserveManagedWake({ ...target, nonce: "tie-nonce-b-abcdefghijklmnopq", instanceId: "b", transport: "codex-queue", relayId: "relay-b" }, now);
    log(JSON.stringify({ probe: "E-same-ms-instances", latest: store.presence(target, now).instanceId, oldWake: state, newWakeForLatest: again.dispatch }));
  } finally { store.close(); }
});
