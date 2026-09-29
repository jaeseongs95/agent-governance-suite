// Independent audit of v2.7.4 candidate 7125d7f. Not product code.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";
import { dispatchSessionMessageBrokerOperation as dispatch } from "../../mcp-server/src/session-message-broker.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import { SESSION_MESSAGE_MAX_RESPONSE_BYTES, SESSION_PRESENCE_LIST_MAX_TARGETS } from "../../mcp-server/src/session-message-protocol.js";
import { SessionMessageStore, PRESENCE_RETENTION_MS, WAKE_TTL_MS, WAKE_RETIRE_GRACE_MS } from "../../mcp-server/src/session-message-store.js";
import { adaptHostInput } from "../../mcp-server/src/host-input-adapter.js";
import { recordWakeHookObservation, wakeHookObservationReader } from "../../mcp-server/src/session-message-wake-port.js";

type Store = InstanceType<typeof SessionMessageStore>;
const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const caps = { supportedInjection: ["peer-wake", "tool-boundary"] as Array<"peer-wake" | "tool-boundary">, idleWake: "silent" as const };
const cleanup: Array<() => void> = [];
afterEach(() => { vi.unstubAllEnvs(); for (const t of cleanup.splice(0).reverse()) t(); });
function dir() { const d = mkdtempSync(path.join(tmpdir(), "ags-v274-audit-")); cleanup.push(() => rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })); return d; }
function open(db: string): Store { const s = new SessionMessageStore(db); cleanup.push(() => s.close()); return s; }
function born(s: Store, sessionId: string, instanceId: string, at: number, extra: Record<string, string> = {}) {
  return s.startPresence({ host: "portable", sessionId, instanceId, transport: "portable", wakeVisibility: "silent", canWakeSilently: true, deliveryCapabilities: caps, ...extra }, at);
}
const t = (sessionId: string) => ({ host: "portable", sessionId });
const presenceRows = (s: Store, sessionId: string) => s.database.prepare("SELECT instance_id, started_at, lease_until, ended_at FROM session_presence WHERE session_id = ? ORDER BY rowid").all(sessionId);
const strip = <T extends { autoWake?: unknown }>(v: T) => ({ ...v, autoWake: v.autoWake ? { ...(v.autoWake as object), checkedAt: null } : v.autoWake });

// ---------- 2. retention SQL ----------
it("R1 a live row is never deleted, even when born weeks ago with a renewed lease", () => {
  const s = open(":memory:"); const now = Date.now();
  born(s, "live", "i1", now - 30 * 24 * H);
  s.database.prepare("UPDATE session_presence SET heartbeat_at = ?, lease_until = ?").run(iso(now), iso(now + 20_000));
  s.prune(now); expect(presenceRows(s, "live")).toHaveLength(1);
  expect(s.presence(t("live"), now).state).toBe("online");
});

it("R2 boundary: lease_until == now-24h is deleted, 1 ms later is kept", () => {
  const s = open(":memory:"); const now = Date.now();
  born(s, "a", "ia", now - 30 * H); s.endPresence(t("a"), "x", "ia", now - PRESENCE_RETENTION_MS);
  born(s, "b", "ib", now - 30 * H); s.endPresence(t("b"), "x", "ib", now - PRESENCE_RETENTION_MS + 1);
  s.prune(now);
  expect(presenceRows(s, "a")).toHaveLength(0); expect(presenceRows(s, "b")).toHaveLength(1);
});

it("R3 same started_at for two instances: the live one and the latest-by-rowid are kept, identical presence()", () => {
  const s = open(":memory:"); const now = Date.now(); const at = now - 3 * 24 * H;
  born(s, "same", "old", at); s.endPresence(t("same"), "x", "old", at + 10);
  born(s, "same", "live", at);  // same started_at, later rowid
  s.database.prepare("UPDATE session_presence SET lease_until = ? WHERE instance_id = 'live'").run(iso(now + 20_000));
  const before = s.presence(t("same"), now);
  s.prune(now);
  expect(strip(s.presence(t("same"), now) as never)).toEqual(strip(before as never));
  expect(presenceRows(s, "same").map((r) => (r as { instance_id: string }).instance_id)).toEqual(["live"]);
});

it("R4 latest row not live but another row live: latest kept so presence() and retirement read the same row", () => {
  const s = open(":memory:"); const now = Date.now();
  born(s, "mix", "live-early", now - 5 * 24 * H);
  s.database.prepare("UPDATE session_presence SET lease_until = ? WHERE instance_id = 'live-early'").run(iso(now + 20_000));
  born(s, "mix", "ended-later", now - 4 * 24 * H); s.endPresence(t("mix"), "x", "ended-later", now - 4 * 24 * H + 5);
  born(s, "mix", "ended-mid", now - 4.5 * 24 * H); s.endPresence(t("mix"), "x", "ended-mid", now - 4.5 * 24 * H + 5);
  const before = s.presence(t("mix"), now);
  s.prune(now);
  expect(strip(s.presence(t("mix"), now) as never)).toEqual(strip(before as never));
  expect(presenceRows(s, "mix").map((r) => (r as { instance_id: string }).instance_id).sort()).toEqual(["ended-later", "live-early"]);
});

it("R5 probe: deleting the latest row can expose an older-started, later-lapsed row (presence changes, never to online)", () => {
  const s = open(":memory:"); const now = Date.now();
  born(s, "shift", "x-long", now - 120 * H);
  s.database.prepare("UPDATE session_presence SET heartbeat_at = ?, lease_until = ? WHERE instance_id = 'x-long'").run(iso(now - 20 * H), iso(now - 20 * H));
  born(s, "shift", "y-short", now - 110 * H); s.endPresence(t("shift"), "x", "y-short", now - 109 * H);
  const before = s.presence(t("shift"), now); const outBefore = s.autoWakeOutlook(t("shift"), now);
  s.prune(now);
  const after = s.presence(t("shift"), now); const outAfter = s.autoWakeOutlook(t("shift"), now);
  console.log("AUDIT-R5", JSON.stringify({ before: [before.instanceId, before.state], after: [after.instanceId, after.state], outBefore: [outBefore.state, outBefore.reason], outAfter: [outAfter.state, outAfter.reason] }));
  expect(after.state).not.toBe("online"); expect(outAfter.state).toBe(outBefore.state);
});

it("R6 randomized: prune never deletes a live row and never changes an online presence, autoWake state or retirement", () => {
  let changedNonOnline = 0; let cases = 0;
  for (let round = 0; round < 40; round++) {
    const s = open(":memory:"); const now = Date.now();
    for (let id = 0; id < 15; id++) {
      const n = 1 + (id % 4);
      for (let k = 0; k < n; k++) {
        const start = now - Math.floor(Math.random() * 6 * 24 * H) - 1000;
        born(s, `s${id}`, `i${id}-${k}`, start);
        const r = Math.random(); const lease = r < 0.25 ? now + 15_000 : now - Math.floor(Math.random() * 5 * 24 * H);
        if (r >= 0.25 && Math.random() < 0.5) s.database.prepare("UPDATE session_presence SET ended_at = ?, lease_until = ?, end_reason = 'x' WHERE instance_id = ?").run(iso(lease), iso(lease), `i${id}-${k}`);
        else s.database.prepare("UPDATE session_presence SET lease_until = ?, heartbeat_at = ? WHERE instance_id = ?").run(iso(lease), iso(Math.min(lease, now)), `i${id}-${k}`);
      }
      // One active wake per identity bound to a random row's generation, expired long ago, to exercise retirement.
      const row = s.database.prepare("SELECT instance_id, started_at FROM session_presence WHERE session_id = ? ORDER BY random() LIMIT 1").get(`s${id}`) as { instance_id: string; started_at: string };
      s.database.prepare(`INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at, state, nonce, instance_id, birth_generation, transport, relay_id, attempt_id, dispatch_epoch)
        VALUES (?, 'portable', ?, ?, 'submitted', ?, ?, ?, 'portable', 'r', ?, 1)`).run(`d${round}-${id}`, `s${id}`, iso(now - 3 * H), `n${round}-${id}-abcdefghijklmnopqrstuv`, row.instance_id, row.started_at, `a${round}-${id}`);
    }
    const liveBefore = s.database.prepare("SELECT instance_id FROM session_presence WHERE ended_at IS NULL AND lease_until > ?").all(iso(now)).map((r) => (r as { instance_id: string }).instance_id).sort();
    // Reference: retirement decision computed on a copy without the presence purge.
    const ref = new SessionMessageStore(":memory:"); cleanup.push(() => ref.close());
    const dump = (st: Store, table: string) => st.database.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    for (const table of ["session_presence", "wake_nonces"]) for (const r of dump(s, table)) {
      const cols = Object.keys(r); ref.database.prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...(cols.map((c) => r[c]) as never[]));
    }
    ref.database.exec("CREATE TRIGGER keep_presence BEFORE DELETE ON session_presence BEGIN SELECT raise(IGNORE); END;");
    const before = Array.from({ length: 15 }, (_, id) => ({ p: s.presence(t(`s${id}`), now), o: s.autoWakeOutlook(t(`s${id}`), now) }));
    s.prune(now); ref.prune(now);
    const liveAfter = s.database.prepare("SELECT instance_id FROM session_presence WHERE ended_at IS NULL AND lease_until > ?").all(iso(now)).map((r) => (r as { instance_id: string }).instance_id).sort();
    expect(liveAfter).toEqual(liveBefore);
    expect(dump(s, "wake_nonces").map((r) => r.state)).toEqual(dump(ref, "wake_nonces").map((r) => r.state));
    for (let id = 0; id < 15; id++) {
      cases++;
      const p = s.presence(t(`s${id}`), now); const o = s.autoWakeOutlook(t(`s${id}`), now);
      if (before[id]!.p.state === "online") { expect(p.instanceId).toBe(before[id]!.p.instanceId); expect(p.startedAt).toBe(before[id]!.p.startedAt); }
      expect(o.state).toBe(before[id]!.o.state);
      if (p.state === "online") expect(before[id]!.p.state).toBe("online");
      if (p.instanceId !== before[id]!.p.instanceId || p.state !== before[id]!.p.state) changedNonOnline++;
    }
  }
  console.log("AUDIT-R6", JSON.stringify({ cases, changedNonOnlinePresence: changedNonOnline }));
});

it("R7 generation fence survives the purge: same instance re-registers later; the old marker neither claims nor observes as current", () => {
  const d = dir(); const db = path.join(d, "m.sqlite3"); const s = open(db); vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", path.join(d, "trust.sqlite3"));
  const now = Date.now(); const t0 = now - 25 * H; const target = t("fence");
  born(s, "fence", "same-instance", t0);
  s.acquireRelay({ ...target, transport: "portable", relayId: "r0", pid: process.pid, parentPid: process.pid }, t0);
  s.send({ sender: t("snd"), target, messageId: "fence-body-1", body: "b", ttlSeconds: 86400 }, t0);
  const r = s.reserveManagedWake({ ...target, nonce: "fence-old-nonce-abcdefghijklmnop", instanceId: "same-instance", transport: "portable", relayId: "r0" }, t0);
  const a = s.startManagedWake(r.attempt!, t0 + 1).attempt!; s.recordManagedWakeOutcome(a, "submitted", t0 + 2);
  s.endPresence(target, "session-end", "same-instance", t0 + 10);
  s.prune(now);
  expect(presenceRows(s, "fence")).toHaveLength(0);
  s.send({ sender: t("snd"), target, messageId: "fence-body-2", body: "b2", ttlSeconds: 86400 }, now - 1000);
  const reborn = born(s, "fence", "same-instance", now);
  expect(reborn.startedAt! > a.generation).toBe(true);
  s.acquireRelay({ ...target, transport: "portable", relayId: "r1", pid: process.pid, parentPid: process.pid }, now);
  const obs = adaptHostInput({ hook_event_name: "UserPromptSubmit", session_id: "fence", agent_id: "", prompt: `[agent-governance-suite:wake:${a.nonce}]` }, "portable").observation;
  const res = s.claimHostWake(target, obs, recordWakeHookObservation(obs, now + 1), wakeHookObservationReader, now + 2);
  expect(res.recognized).toBe(false); expect(res.messages).toEqual([]);
  expect(s.pendingCount(target, now + 3)).toBe(1);
  // Clock regression edge: a re-registration timestamped before the old birth would reuse... record behavior only.
});

it("R8 retirement still works for a wake whose generation rows were purged once a new generation is live", () => {
  const s = open(":memory:"); const now = Date.now(); const t0 = now - 25 * H; const target = t("ret");
  born(s, "ret", "gone", t0); s.acquireRelay({ ...target, transport: "portable", relayId: "r0", pid: process.pid, parentPid: process.pid }, t0);
  s.send({ sender: t("snd"), target, messageId: "ret-body-01", body: "b", ttlSeconds: 86400 }, t0);
  const r = s.reserveManagedWake({ ...target, nonce: "ret-old-nonce-abcdefghijklmnopqr", instanceId: "gone", transport: "portable", relayId: "r0" }, t0);
  const a = s.startManagedWake(r.attempt!, t0 + 1).attempt!; s.recordManagedWakeOutcome(a, "submitted", t0 + 2);
  s.endPresence(target, "x", "gone", t0 + 10); s.prune(now);
  expect(s.database.prepare("SELECT state FROM wake_nonces WHERE attempt_id = ?").get(a.attemptId)).toEqual({ state: "submitted" });
  s.send({ sender: t("snd"), target, messageId: "ret-body-02", body: "b2", ttlSeconds: 86400 }, now - 1000);
  born(s, "ret", "new", now); s.acquireRelay({ ...target, transport: "portable", relayId: "r1", pid: process.pid, parentPid: process.pid }, now);
  expect(s.reserveManagedWake({ ...target, nonce: "ret-new-nonce-abcdefghijklmnopqr", instanceId: "new", transport: "portable", relayId: "r1" }, now).dispatch).toBe(true);
  expect(s.database.prepare("SELECT state FROM wake_nonces WHERE attempt_id = ?").get(a.attemptId)).toEqual({ state: "expired-unobserved" });
  void WAKE_TTL_MS; void WAKE_RETIRE_GRACE_MS;
});

// ---------- 3. response limit ----------
function worstIdentity(s: Store, i: number, now: number) {
  const ctl = (n: number) => "\u0001".repeat(n); // JSON escapes each as \u0001 (6 bytes)
  const sessionId = `${String(i)}${"z".repeat(199)}`.slice(0, 200);
  const host = `h${"q".repeat(63)}`;
  s.startPresence({ host, sessionId, instanceId: ctl(128), transport: ctl(64), wakeVisibility: "user-message", canWakeSilently: false,
    deliveryCapabilities: { supportedInjection: ["user-input", "peer-wake", "tool-boundary", "turn-end", "unknown"], idleWake: "user-message" },
    collaborationId: ctl(200), workspaceId: ctl(500), role: ctl(100) }, now);
  s.endPresence({ host, sessionId }, ctl(100), ctl(128), now + 1);
  return { host, sessionId };
}
it("S1 worst-case 3 targets (max-length control-char fields, ended, autoWake) fit the response limit; measured bytes recorded", () => {
  const s = open(":memory:"); const now = Date.now();
  const targets = [0, 1, 2].map((i) => worstIdentity(s, i, now));
  const data = dispatch(s, "list-presence", { targets });
  const bytes = Buffer.byteLength(`${JSON.stringify({ ok: true, data })}\n`, "utf8");
  const perSession = Buffer.byteLength(JSON.stringify((data as { sessions: unknown[] }).sessions[0]), "utf8");
  console.log("AUDIT-S1", JSON.stringify({ targets: SESSION_PRESENCE_LIST_MAX_TARGETS, bytes, perSession, limit: SESSION_MESSAGE_MAX_RESPONSE_BYTES, headroom: SESSION_MESSAGE_MAX_RESPONSE_BYTES - bytes, maxTargetsThatFit: Math.floor((SESSION_MESSAGE_MAX_RESPONSE_BYTES - 40) / (perSession + 1)) }));
  expect(bytes).toBeLessThanOrEqual(SESSION_MESSAGE_MAX_RESPONSE_BYTES);
});
it("S2 broker rejects 0, 4, non-array targets and an untargeted oversize list explicitly", () => {
  const s = open(":memory:"); const now = Date.now();
  for (const bad of [[], [t("a"), t("b"), t("c"), t("d")], "x", {}]) expect(() => dispatch(s, "list-presence", { targets: bad })).toThrow(/targets must list/);
  for (let i = 0; i < 8; i++) worstIdentity(s, i, now);
  expect(() => dispatch(s, "list-presence", {})).toThrow(/exceeds the broker response limit/);
  expect(() => dispatch(s, "list-presence", { targets: [{ host: "bad host", sessionId: "x" }] })).toThrow(/bounded identifier/);
});

// ---------- 4. service batching behavior (real broker) ----------
async function broker() {
  const d = dir(); const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../mcp-server/src/session-message-broker.ts", import.meta.url)), "--state-directory", d], { windowsHide: true, stdio: "ignore" });
  cleanup.push(() => { const e = path.join(d, "endpoint.json"); if (existsSync(e)) { try { process.kill((JSON.parse(readFileSync(e, "utf8")) as { pid: number }).pid); } catch { /* gone */ } } child.kill(); });
  await waitForSessionMessageBrokerReady(d, child, 10_000);
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", d);
  return d;
}
it("B1 probe: one board identity outside the broker's identifier pattern makes the whole batched lookup fail (all presence unknown)", async () => {
  const d = await broker(); const s = open(path.join(d, "session-messages.sqlite3")); const now = Date.now();
  for (let i = 0; i < 6; i++) born(s, `ok-${i}`, `i-${i}`, now);
  const svc = new SessionMessageService(d);
  const good = await svc.listPresence(Array.from({ length: 6 }, (_, i) => t(`ok-${i}`)));
  const mixed = await svc.listPresence([...Array.from({ length: 6 }, (_, i) => t(`ok-${i}`)), { host: "portable", sessionId: "has space" }]);
  console.log("AUDIT-B1", JSON.stringify({ good: good.ok, goodCount: good.data?.sessions.length, mixed: mixed.ok, error: mixed.error?.message?.slice(0, 120) }));
  expect(good.ok).toBe(true);
}, 60_000);

it("C1 latency: list of N board sessions against a DB with ~1300 presence rows (N = 40, 100, 300)", async () => {
  const d = await broker(); const s = open(path.join(d, "session-messages.sqlite3")); const now = Date.now();
  s.database.exec("BEGIN");
  for (let i = 0; i < 1300; i++) born(s, `row-${i % 340}`, `inst-${i}`, now - (i % 20) * H);
  for (let i = 0; i < 300; i++) born(s, `board-${i}`, `b-${i}`, now);
  s.database.exec("COMMIT");
  const svc = new SessionMessageService(d); const out: Record<string, unknown> = {};
  for (const n of [40, 100, 300]) {
    const targets = Array.from({ length: n }, (_, i) => t(`board-${i}`));
    const runs: number[] = [];
    for (let r = 0; r < 3; r++) { const st = performance.now(); const res = await svc.listPresence(targets); runs.push(Math.round(performance.now() - st)); expect(res.ok).toBe(true); expect(res.data!.sessions).toHaveLength(n); }
    out[`N${n}`] = { requests: Math.ceil(n / SESSION_PRESENCE_LIST_MAX_TARGETS), ms: runs };
  }
  console.log("AUDIT-C1", JSON.stringify(out));
}, 180_000);

it("C2 prune cost inside send's BEGIN IMMEDIATE with 1300 and 13000 presence rows (non-deletable and deletable mixes)", () => {
  const out: Record<string, unknown> = {};
  for (const [label, total, mode] of [["1300-lapsed-within-24h", 1300, "lapsed"], ["1300-live", 1300, "live"], ["1300-old-deletable", 1300, "old"], ["13000-lapsed-within-24h", 13000, "lapsed"], ["13000-old-deletable", 13000, "old"]] as const) {
    const s = open(":memory:"); const now = Date.now();
    s.database.exec("BEGIN");
    for (let i = 0; i < total; i++) { born(s, `p-${i % Math.ceil(total / 4)}`, `i-${i}`, now - 48 * H + i); }
    const lease = mode === "lapsed" ? iso(now - H) : mode === "live" ? iso(now + 3600_000) : iso(now - 30 * H);
    s.database.prepare("UPDATE session_presence SET lease_until = ?").run(lease);
    s.database.exec("COMMIT");
    const times: number[] = [];
    for (let r = 0; r < 5; r++) { const st = performance.now(); s.prune(now + r); times.push(Number((performance.now() - st).toFixed(2))); }
    const sendTimes: number[] = [];
    for (let r = 0; r < 5; r++) { const d = s.prepare({ sender: t("snd"), target: t("rcv"), body: "x" }, now + 10 + r); const st = performance.now(); s.submitPrepared(t("snd"), d.messageId, now + 10 + r); sendTimes.push(Number((performance.now() - st).toFixed(2))); }
    out[label] = { rowsAfter: (s.database.prepare("SELECT count(*) n FROM session_presence").get() as { n: number }).n, pruneMs: times, submitMs: sendTimes };
  }
  console.log("AUDIT-C2", JSON.stringify(out));
}, 180_000);
void copyFileSync;
