import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import { readRelayCodeDigest } from "../../mcp-server/src/relay-code-identity.js";

const A = "sha256:" + "a".repeat(64), B = "sha256:" + "b".repeat(64);
const now = Date.UTC(2026, 0, 1);
const stores: SessionMessageStore[] = [];
const directories: string[] = [];
const directory = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "ags-relay-code-")); directories.push(dir); return dir; };
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, {recursive: true, force: true}); });

function fixture(database = ":memory:") {
  const store = new SessionMessageStore(database); stores.push(store);
  const input = { host: "portable", sessionId: "code-fixture", instanceId: "host-process-v1:" + "c".repeat(64),
    parentPid: 100, transport: "portable-queue", wakeVisibility: "user-message" as const, canWakeSilently: false,
    deliveryCapabilities: { supportedInjection: ["peer-wake" as const], idleWake: "user-message" as const } };
  let expectedDigest: string | null = null;
  const ensure = (installed?: string | null) => { expectedDigest = installed ?? null; return store.prepareVerifiedRelay({...input,
    expectedOwner: store.relayOwner(input, input.transport)}, now + 2); };
  const activate = (relayId: string, codeDigest?: string | null, pid = 200) => store.activateVerifiedRelay({...input, relayId, pid, codeDigest: codeDigest ?? null}, now + 3);
  const view = () => store.listPresence(now + 4, [input], expectedDigest)[0]!;
  return {store, input, ensure, activate, view};
}

it("marks a live reused old relay outdated without respawning or renewing its presence", () => {
  const f = fixture(); const grant = f.ensure(A); expect(f.activate(grant.relayId!, A)).toBe(true);
  expect(f.view().relayCode).toEqual({status: "current", runningDigest: A, expectedDigest: A});
  const presence = f.store.presence(f.input, now + 4), owner = f.store.relayOwner(f.input, f.input.transport);
  expect(f.ensure(B)).toEqual({...grant, spawn: false});
  expect(f.view().relayCode).toEqual({status: "outdated", runningDigest: A, expectedDigest: B});
  expect(f.store.presence(f.input, now + 4)).toEqual(presence);
  expect(f.store.relayOwner(f.input, f.input.transport)).toEqual(owner);
  expect(f.activate(grant.relayId!, B)).toBe(true);
  expect(f.view().relayCode?.runningDigest).toBe(A);
});

it("stores the exact child-owner text independently of SQLite numeric parameter rendering", () => {
  const f = fixture(); const grant = f.ensure(A);
  expect(f.activate(grant.relayId!, A)).toBe(true);
  const row = f.store.database.prepare("SELECT relay_code_id,pid FROM relay_leases").get();
  expect(row).toEqual({relay_code_id: grant.relayId + ":200", pid: 200});
  expect(f.view().relayCode).toEqual({status: "current", runningDigest: A, expectedDigest: A});
});

it("does not infer current code from a legacy relay or an unactivated grant", () => {
  const f = fixture(); const grant = f.ensure(B);
  expect(f.view().relayCode).toEqual({status: "unknown", runningDigest: null, expectedDigest: B});
  expect(f.activate(grant.relayId!)).toBe(true);
  expect(f.ensure(B).spawn).toBe(false);
  expect(f.view().relayCode?.status).toBe("unknown");
});

it("fences stale activation and clears code identity on a new reservation", () => {
  const f = fixture(); const old = f.ensure(A); f.activate(old.relayId!, A);
  const newer = f.store.prepareVerifiedRelay({...f.input, instanceId: "host-process-v1:" + "d".repeat(64),
    expectedOwner: f.store.relayOwner(f.input, f.input.transport)}, now + 5);
  expect(newer.spawn).toBe(true);
  expect(f.activate(old.relayId!, A)).toBe(false);
  expect(f.store.listPresence(now + 6, [f.input], B)[0]!.relayCode).toEqual({status: "unknown", runningDigest: null, expectedDigest: B});
});

it.each(["relay_id='legacy-replacement',pid=300", "pid=300"])("rejects inherited metadata after a pre-upgrade broker changes owner: %s", update => {
  const f = fixture(); const grant = f.ensure(A); f.activate(grant.relayId!, A);
  // Exact old-broker behavior: new lease owner without knowledge of additive code columns.
  f.store.database.prepare(`UPDATE relay_leases SET ${update}`).run();
  expect(f.view().relayCode).toEqual({status: "unknown", runningDigest: null, expectedDigest: A});
});

it("migrates legacy rows additively without losing ownership or assigning a code identity", () => {
  const dbPath = path.join(directory(), "old.sqlite3");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE relay_leases(host TEXT,session_id TEXT,transport TEXT,relay_id TEXT,pid INTEGER,parent_pid INTEGER,relay_start_token TEXT,lease_until TEXT,updated_at TEXT,PRIMARY KEY(host,session_id,transport)) STRICT;");
  db.prepare("INSERT INTO relay_leases VALUES(?,?,?,?,?,?,?,?,?)").run("portable", "code-fixture", "portable-queue", "legacy", 200, 100, null, "9999-12-31T23:59:59.999Z", new Date(now).toISOString());
  db.close();
  const f = fixture(dbPath); f.store.startPresence(f.input, now);
  expect(f.store.relayOwner(f.input, f.input.transport)?.relayId).toBe("legacy");
  expect(f.view().relayCode).toEqual({status: "unknown", runningDigest: null, expectedDigest: null});
});

it("observes entry bytes rather than a version label and preserves an earlier snapshot after overwrite", () => {
  const entry = path.join(directory(), "relay.mjs"), url = pathToFileURL(entry);
  expect(readRelayCodeDigest(url)).toBeNull();
  writeFileSync(entry, "old-code"); const startup = readRelayCodeDigest(url);
  writeFileSync(entry, "new-code"); const expected = readRelayCodeDigest(url);
  expect(startup).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(expected).not.toBe(startup);
  expect(readFileSync(entry, "utf8")).toBe("new-code");
});
