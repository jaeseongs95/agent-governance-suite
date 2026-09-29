// Audit-only: an operating-DB-shaped fixture. `seed <db> <now>` builds it with this worktree's store and runs a 2.7.4-style
// steady state; `prune <db> <now> <out.json>` runs one prune with this worktree's store and dumps every table.
import { writeFileSync } from "node:fs";
import { SessionMessageStore, WAKE_TTL_MS, WAKE_RETIRE_GRACE_MS } from "../../mcp-server/src/session-message-store.js";

const [mode, database, nowArg, out] = process.argv.slice(2);
const now = Number(nowArg);
const H = 3600_000, M = 60_000;
const caps = { supportedInjection: ["peer-wake", "tool-boundary"] as Array<"peer-wake" | "tool-boundary">, idleWake: "user-message" as const };
const store = new SessionMessageStore(database);
try {
  if (mode === "seed") {
    let n = 0;
    const session = (sessionId: string, bornAt: number, wakeAt: number, outcome: "submitted" | "accepted-or-unknown" | "reserved", transport = "codex-queue") => {
      const target = { host: "codex", sessionId };
      store.startPresence({ ...target, instanceId: `${sessionId}-inst`, transport, wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: caps }, bornAt);
      store.database.prepare("UPDATE session_presence SET heartbeat_at = ?, lease_until = ? WHERE session_id = ?")
        .run(new Date(wakeAt).toISOString(), new Date(wakeAt + 20_000).toISOString(), sessionId);
      store.database.prepare("DELETE FROM relay_leases WHERE session_id = ?").run(sessionId);
      store.acquireRelay({ ...target, transport, relayId: `${sessionId}-relay`, pid: 4242, parentPid: 4241 }, wakeAt);
      store.send({ sender: { host: "claude-code", sessionId: "coordinator" }, target, messageId: `body-${sessionId}-${n++}`, body: `queued for ${sessionId}`, ttlSeconds: 86400 }, wakeAt);
      const reserved = store.reserveManagedWake({ ...target, nonce: `${sessionId}-nonce-abcdefghijklmnopq`, instanceId: `${sessionId}-inst`, transport, relayId: `${sessionId}-relay` }, wakeAt);
      if (!reserved.dispatch) throw new Error(`no dispatch for ${sessionId}`);
      if (outcome !== "reserved") store.recordManagedWakeOutcome(store.startManagedWake(reserved.attempt!, wakeAt + 1).attempt!, outcome, wakeAt + 2);
    };
    // The 13 stuck rows: Codex sessions not reopened after a reboot (lease lapsed) or ended.
    for (let i = 0; i < 5; i += 1) session(`lapsed-3h-${i}`, now - 5 * H, now - 4 * H + i * M, "submitted");
    for (let i = 0; i < 4; i += 1) session(`lapsed-31h-${i}`, now - 32 * H, now - 31 * H + i * M, "submitted");
    for (let i = 0; i < 3; i += 1) {
      session(`ended-${i}`, now - 6 * H, now - 5 * H + i * M, "accepted-or-unknown");
      store.endPresence({ host: "codex", sessionId: `ended-${i}` }, "session-end", `ended-${i}-inst`, now - 5 * H + i * M + 30_000);
    }
    session("lapsed-reserved", now - 3 * H, now - 2 * H - 30 * M, "reserved");
    // Must stay active: live and quiet (heartbeats), still inside expiry + grace, live with another transport.
    session("live-quiet", now - 3 * H, now - 2 * H, "submitted");
    session("recent-lapsed", now - 40 * M, now - 30 * M, "submitted");
    session("live-other-transport", now - 3 * H, now - 2 * H, "submitted");
    store.startPresence({ host: "codex", sessionId: "live-other-transport", instanceId: "live-other-transport-inst", transport: "codex-deferred",
      wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: caps }, now - 2 * H + 10_000);
    for (const sessionId of ["live-quiet", "live-other-transport"]) {
      store.database.prepare("UPDATE session_presence SET heartbeat_at = ?, lease_until = ? WHERE session_id = ?")
        .run(new Date(now - 5_000).toISOString(), new Date(now + 15_000).toISOString(), sessionId);
    }
    // Other traffic: acknowledged and pending messages plus prepared receipts between two live Claude sessions.
    const a = { host: "claude-code", sessionId: "writer" }, b = { host: "claude-code", sessionId: "reviewer" };
    for (let i = 0; i < 6; i += 1) {
      const prepared = store.prepare({ sender: a, target: b, body: `note ${i}`, ttlSeconds: 86400 }, now - 50 * M + i * M);
      store.submitPrepared(a, prepared.messageId, now - 50 * M + i * M + 1);
      if (i % 2 === 0) store.acknowledge(b, [prepared.messageId], now - 20 * M);
    }
    store.prepare({ sender: b, target: a, body: "prepared only", ttlSeconds: 86400 }, now - 5 * M);
    store.prune(now - 1000); // a 2.7.4-era prune just before the upgrade (this runs the seeding worktree's rule)
  } else {
    store.prune(now);
  }
  const tables = (store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  const dump: Record<string, unknown[]> = {};
  for (const table of tables) dump[table] = store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  if (out) writeFileSync(out, JSON.stringify({ WAKE_TTL_MS, WAKE_RETIRE_GRACE_MS, dump }, null, 1));
  const states = store.database.prepare("SELECT state, count(*) AS n FROM wake_nonces GROUP BY state ORDER BY state").all();
  console.log(JSON.stringify({ mode, states }));
} finally { store.close(); }
