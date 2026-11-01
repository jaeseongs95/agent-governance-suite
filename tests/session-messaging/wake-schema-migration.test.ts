import assert from "node:assert/strict";
import { fork, type ForkOptions } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import { buildV2Database } from "./fixtures/session-message-v2-schema.mjs";

// Design 4 / 7.1 #7 and #2b: a file last written by a 2.x broker (schema 2, copied from c5343231) opened by the 3.0 store.
// Synthetic rows only. The shared-mode variant lives in tests/unified-state/legacy-stores.test.ts.
const iso = (at: number) => new Date(at).toISOString();
const MINUTE = 60_000;
const host = "migration-synthetic";
type Row = Record<string, unknown>;
const directories: string[] = [];
const stores: SessionMessageStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function wake(sessionId: string, state: string, extra: Row = {}): Row {
  return { nonce_digest: `digest-${sessionId}`, host, session_id: sessionId, expires_at: extra.expires_at ?? iso(Date.now() + 30 * MINUTE),
    state, nonce: `${sessionId}-nonce-abcdefghijklmnopqrstuv`, instance_id: `${sessionId}-instance`, birth_generation: iso(Date.now() - 5 * MINUTE),
    transport: "portable", relay_id: `${sessionId}-relay`, attempt_id: `${sessionId}-attempt`, dispatch_epoch: 1, ...extra };
}
function v2Fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ags-wake-migration-"));
  directories.push(directory);
  const database = join(directory, "session-messages.sqlite3");
  const m = Date.now();
  const birth = iso(m - 2 * MINUTE);
  const presence = { host, session_id: "live", instance_id: "live-instance", transport: "gemini-queue", wake_visibility: "user-message",
    can_wake_silently: 0, supported_injection: '["peer-wake","tool-boundary"]', idle_wake: "user-message", started_at: birth,
    heartbeat_at: iso(m), lease_until: iso(m + 20_000) };
  const relays = [{ host, session_id: "live", transport: "gemini-queue", relay_id: "live-relay", pid: process.pid, parent_pid: process.pid,
    lease_until: iso(m + 15_000), updated_at: iso(m) }];
  const wakes = [
    // An active hand-off of the live birth, handed one minute before the migration.
    wake("live", "submitted", { instance_id: "live-instance", birth_generation: birth, transport: "gemini-queue", relay_id: "live-relay",
      started_at: iso(m - MINUTE - 1000), outcome_at: iso(m - MINUTE), prior_unobserved: 1 }),
    wake("started", "started", { started_at: iso(m - 3 * MINUTE), outcome_at: null }),
    wake("reserved", "reserved", { dispatch_epoch: 0 }),
    wake("not-submitted", "not-submitted", { outcome_at: iso(m - 4 * MINUTE), retry_not_before: iso(m + MINUTE), retry_count: 2 }),
    wake("expired", "expired-unobserved", { started_at: iso(m - 50 * MINUTE), outcome_at: iso(m - 49 * MINUTE), retired_at: iso(m - 30 * MINUTE) }),
    wake("late", "unknown", { started_at: iso(m - 40 * MINUTE), outcome_at: iso(m - 40 * MINUTE), late_observed_at: iso(m - 20 * MINUTE) }),
    wake("observed", "observed", { started_at: iso(m - 6 * MINUTE), outcome_at: iso(m - 6 * MINUTE), observed_at: iso(m - 5 * MINUTE), consumed_at: iso(m - 5 * MINUTE) }),
    { nonce_digest: "digest-legacy", host, session_id: "legacy", expires_at: iso(m + 30 * MINUTE), state: "legacy" },
  ];
  buildV2Database(database, { presence: [presence], relays, wakes, activity: [{ host, session_id: "live", active_at: iso(m - 10_000) }] });
  return { directory, database, m, birth };
}
function open(database: string) {
  const store = new SessionMessageStore(database);
  stores.push(store);
  return store;
}
function bySession(store: SessionMessageStore): Map<string, Row> {
  return new Map((store.database.prepare("SELECT * FROM wake_nonces").all() as Row[]).map(row => [String(row.session_id), { ...row }]));
}
function snapshot(database: string) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Row[]).map(row => String(row.name));
    return {
      version: (db.prepare("PRAGMA user_version").get() as Row).user_version,
      tables,
      wake: db.prepare("SELECT * FROM wake_nonces ORDER BY rowid").all(),
      paths: tables.includes("wake_paths") ? db.prepare("SELECT * FROM wake_paths ORDER BY session_id").all() : null,
      presence: db.prepare("SELECT * FROM session_presence ORDER BY rowid").all(),
      relays: db.prepare("SELECT * FROM relay_leases ORDER BY rowid").all(),
      sql: (db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'wake_nonces'").get() as Row).sql,
    };
  } finally { db.close(); }
}

test("7: every 2.x state is renamed, legacy rows go, retired_at is kept as released_at and the file becomes schema 4", () => {
  const { database, m, birth } = v2Fixture();
  const store = open(database);
  const rows = bySession(store);
  assert.equal(rows.has("legacy"), false, "legacy rows are dropped");
  const states = Object.fromEntries([...rows].map(([session, row]) => [session, [row.state, row.release_reason ?? null]]));
  assert.deepEqual(states, {
    live: ["handed-off", null], started: ["unknown", null], reserved: ["reserved", null], "not-submitted": ["not-delivered", null],
    expired: ["released", "migrated"], late: ["released", "migrated"], observed: ["observed", null],
  });
  assert.equal(rows.get("expired")!.released_at, iso(m - 30 * MINUTE), "the 2.x retired_at survives as released_at");
  // Migrated hand-offs get outcome_at, a 10 minute base and a resend deadline, so none stays active forever (r3 N1).
  assert.deepEqual([rows.get("live")!.outcome_at, rows.get("live")!.resend_base_ms, rows.get("live")!.resend_due_at],
    [iso(m - MINUTE), 600_000, iso(m - MINUTE + 10 * MINUTE)]);
  assert.deepEqual([rows.get("started")!.outcome_at, rows.get("started")!.resend_base_ms, rows.get("started")!.resend_due_at],
    [iso(m - 3 * MINUTE), 600_000, iso(m - 3 * MINUTE + 10 * MINUTE)]);
  // Bindings, epochs and observation times are copied unchanged; gemini-queue is renamed everywhere (r3 S-N1).
  assert.deepEqual([rows.get("live")!.instance_id, rows.get("live")!.birth_generation, rows.get("live")!.relay_id, rows.get("live")!.dispatch_epoch,
    rows.get("live")!.transport], ["live-instance", birth, "live-relay", 1, "antigravity-queue"]);
  assert.deepEqual([rows.get("observed")!.observed_at, rows.get("observed")!.consumed_at], [iso(m - 5 * MINUTE), iso(m - 5 * MINUTE)]);
  assert.equal(rows.get("late")!.late_observed_at, iso(m - 20 * MINUTE));
  const after = snapshot(database);
  assert.equal(after.version, 4);
  assert.equal((after.presence[0] as Row).transport, "antigravity-queue");
  // Schema 4 rebuilds the PID-bound lease table empty: every relay restarts and is granted again after the install.
  assert.deepEqual(after.relays, []);
  const presenceColumns = Object.keys(after.presence[0] as Row);
  for (const column of ["host_pid", "host_start"]) assert.ok(presenceColumns.includes(column), column);
  assert.equal((after.presence[0] as Row).host_pid, null, "a migrated birth reports no host and gets no relay grant");
  const columns = (store.database.prepare("PRAGMA table_info(wake_nonces)").all() as Row[]).map(row => String(row.name));
  for (const column of ["release_reason", "resend_base_ms", "resend_due_at", "released_at"]) assert.ok(columns.includes(column), column);
  for (const column of ["retired_at", "prior_unobserved"]) assert.equal(columns.includes(column), false, column);
  assert.equal(after.tables.includes("session_activity"), false, "session_activity has no consumer left");
  // One wake path per birth that still has an active attempt, starting at streak 0.
  const paths = (after.paths as Row[]).map(row => [row.session_id, row.instance_id, row.birth_generation, row.streak, row.failures]);
  for (const session of ["live", "started", "reserved"]) {
    const row = rows.get(session)!;
    assert.deepEqual(paths.find(path => path[0] === session), [session, row.instance_id, row.birth_generation, 0, 0], session);
  }
  // The rebuilt active index admits one active attempt per target.
  assert.throws(() => store.database.prepare(`INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at, state, nonce, attempt_id)
    VALUES ('digest-second-active', ?, 'live', ?, 'reserved', 'second-active-nonce-abcdefghijk', 'second-active')`).run(host, iso(m + MINUTE)), /UNIQUE/);
  assert.throws(() => store.database.prepare(`INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at, state)
    VALUES ('digest-legacy-again', ?, 'x', ?, 'legacy')`).run(host, iso(m + MINUTE)), /CHECK/);
});

test("7: reopening a migrated file by another connection is idempotent", () => {
  const { database } = v2Fixture();
  open(database).close(); stores.pop();
  const first = snapshot(database);
  const peer = open(database);
  open(database);
  assert.deepEqual(snapshot(database), first);
  peer.close(); stores.splice(stores.indexOf(peer), 1);
  open(database);
  assert.deepEqual(snapshot(database), first);
});

test("2b: a migrated active hand-off is released at its resend deadline, within 10 minutes of the migration", () => {
  const { database, m } = v2Fixture();
  const store = open(database);
  const due = m - MINUTE + 10 * MINUTE;
  // Keep the live birth live without a new birth (a live relay renews it).
  const keepAlive = (at: number) => store.database.prepare("UPDATE session_presence SET lease_until = ? WHERE instance_id = 'live-instance'").run(iso(at + 20_000));
  keepAlive(due - 1); store.prune(due - 1);
  assert.equal(bySession(store).get("live")!.state, "handed-off");
  keepAlive(due); store.prune(due);
  const live = bySession(store).get("live")!;
  assert.deepEqual([live.state, live.release_reason, live.released_at], ["released", "resend-due", iso(due)]);
  assert.ok(due - m <= 10 * MINUTE);
  // The migrated unknown without a live birth is released at once (birth-ended), the reservation keeps its expiry rule.
  assert.equal(bySession(store).get("started")!.state, "released");
});

test("G: a newer message schema version is rejected without mutation", () => {
  const { database } = v2Fixture();
  const db = new DatabaseSync(database); db.exec("PRAGMA user_version = 7;"); db.close();
  const before = snapshot(database);
  assert.throws(() => new SessionMessageStore(database), /newer/);
  assert.deepEqual(snapshot(database), before);
});

test("G: a failure inside the wake table rebuild rolls back rows, columns and schema version", async () => {
  const { directory, database } = v2Fixture();
  const before = snapshot(database);
  const worker = fileURLToPath(new URL("./fixtures/managed-wake-process.mjs", import.meta.url));
  const child = fork(worker, ["rebuild-failure", database, join(directory, "effects.txt"), "relay-rebuild", String(process.pid)],
    { execArgv: ["--import", "tsx"], silent: true, windowsHide: true } as ForkOptions);
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
  const [message] = await once(child, "message") as [{ error?: string }];
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  assert.match(String(message.error), /rebuild failure/);
  assert.deepEqual(snapshot(database), before);
  assert.equal(before.version, 2);
  open(database);
  assert.equal(snapshot(database).version, 4);
});
