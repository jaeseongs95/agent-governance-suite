import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createInactiveSharedStores, type InactiveSharedStoresOptions } from "../../mcp-server/src/inactive-shared-stores.js";
import { InactiveSharedConnection } from "../../runtime/unified-state/shared-connection.mjs";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import { TrustStore } from "../../mcp-server/src/trust-store.js";
import { openBoard, setSummary, readSession } from "../../skills/session-board/scripts/board-store.mjs";

const directories: string[] = [];
const owners = new Set<InactiveSharedConnection>();
const keys = { workflow: Buffer.alloc(32, 1).toString("base64url"), continuity: Buffer.alloc(32, 2).toString("base64url"), trust: Buffer.alloc(32, 3).toString("base64url") };
function options(): InactiveSharedStoresOptions { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ags-r2-factory-")); directories.push(directory); return { directory, mode: "fixture-only", clock: () => 100, syntheticKeys: keys }; }
afterEach(() => { for (const owner of owners) owner.close(); owners.clear(); for (const directory of directories.splice(0)) { expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir())); expect(path.basename(directory)).toMatch(/^ags-r2-factory-/u); fs.rmSync(directory, { recursive: true }); } });

describe("explicit inactive factory boundary", () => {
  it("B2-FACTORY-01: invalid mode and absent/conflicting/noncanonical synthetic key namespaces create no DB", () => {
    const input = options();
    for (const changed of [{ ...input, mode: "live" }, { ...input, syntheticKeys: {} }, { ...input, syntheticKeys: { ...keys, trust: keys.workflow } }, { ...input, syntheticKeys: { ...keys, trust: "invalid" } }]) expect(() => Reflect.apply(createInactiveSharedStores, undefined, [changed])).toThrow();
    expect(fs.readdirSync(input.directory)).toEqual([]);
  });
  it("B2-FACTORY-02: unrelated schema and R1 format are rejected without overwriting markers/rows", () => {
    for (const marker of [0, 0x41475355]) {
      const input = options(); const filename = path.join(input.directory, "ags-state.sqlite3"); const db = new DatabaseSync(filename); db.exec(`CREATE TABLE preserved(id TEXT PRIMARY KEY); INSERT INTO preserved VALUES('original'); PRAGMA application_id=${marker}; PRAGMA user_version=1;`); db.close();
      expect(() => createInactiveSharedStores(input)).toThrow(/Only empty or matching inactive/u);
      const read = new DatabaseSync(filename, { readOnly: true }); try { expect(read.prepare("SELECT id FROM preserved").get()).toMatchObject({ id: "original" }); expect(read.prepare("PRAGMA application_id").get()).toMatchObject({ application_id: marker }); } finally { read.close(); }
    }
  });
  it("B2-FACTORY-03: a different synthetic signing key on reopen is an explicit conflict", () => {
    const input = options(); const first = createInactiveSharedStores(input); first.owner.close();
    expect(() => createInactiveSharedStores({ ...input, syntheticKeys: { ...keys, trust: Buffer.alloc(32, 4).toString("base64url") } })).toThrow(/stored trust key differs/u);
    const reopen = createInactiveSharedStores(input); owners.add(reopen.owner); expect(reopen.owner.inspect().modules).toHaveLength(5);
  });
  it("B2-FACTORY-04: body/TTL/NUL limits fail before recording or observing a malformed request", () => {
    let now = 100; const input = options(); const value = createInactiveSharedStores({ ...input, clock: () => now }); owners.add(value.owner);
    const base = { sender: { host: "fake-sender", sessionId: "s" }, target: { host: "fake-target", sessionId: "t" }, body: "valid" };
    now = 200;
    for (const changed of [{ ...base, body: "x".repeat(4097) }, { ...base, body: "bad\0input" }, { ...base, ttlSeconds: 29 }, { ...base, ttlSeconds: 86401 }, { ...base, sender: { host: "", sessionId: "s" } }]) expect(() => value.messaging.prepare(changed, now)).toThrow();
    expect(value.owner.inspect().counts.prepared_messages).toBe(0); expect(value.owner.inspect().time).toBe(0);
    expect(value.messaging.prepare({ ...base, body: "x".repeat(4096), ttlSeconds: 30 }, now).messageId).toBeTruthy(); expect(value.owner.inspect().time).toBe(200);
  });
  it("B2-FACTORY-05: invalid authority clock leaves original schema and time without a successful write", () => {
    const input = options(); const value = createInactiveSharedStores({ ...input, clock: () => Number.NaN }); owners.add(value.owner);
    let rejected; try { value.workflow.nextRunSequence(); } catch (error) { rejected = error; } expect(rejected).toMatchObject({ code: "INVALID_INPUT", details: { cause: "A nonnegative safe integer clock is required." } }); expect(value.owner.inspect().time).toBe(0); expect(value.owner.inspect().counts.workflow_metadata).toBe(1);
  });
  it("B2-FACTORY-06: original standalone path APIs remain available using separate explicit synthetic temp files", () => {
    const input = options(); const workflow = new SqliteWorkflowStore(path.join(input.directory, "standalone-workflow.sqlite3")); const continuity = new SqliteContinuityStore(path.join(input.directory, "standalone-continuity.sqlite3")); const messaging = new SessionMessageStore(path.join(input.directory, "standalone-message.sqlite3")); const trust = new TrustStore(path.join(input.directory, "standalone-trust.sqlite3"), keys.trust); const board = openBoard(path.join(input.directory, "standalone-board.sqlite3"));
    try {
      expect(workflow.getSchemaVersion()).toBe(5); expect(workflow.nextRunSequence()).toBe(1); expect(continuity.getSchemaVersion()).toBe(2); expect(continuity.ensureTask("standalone-synthetic", new Date(100).toISOString()).currentEpoch).toBe(1);
      const sender = { host: "standalone-a", sessionId: "s" }; const target = { host: "standalone-b", sessionId: "t" }; const draft = messaging.prepare({ sender, target, body: "synthetic standalone" }, 100); expect(messaging.submitPrepared(sender, draft.messageId, 100).duplicate).toBe(false); expect(messaging.claim(target, 100)).toHaveLength(1); expect(messaging.acknowledge(target, [draft.messageId], 100)).toBe(1);
      const source = trust.recordInputSource({ originKind: "peer", ...sender, eventId: "standalone-event", contentDigest: `sha256:${"a".repeat(64)}`, observedAt: new Date(100).toISOString(), expiresAt: new Date(1000).toISOString(), authorityEffect: "none", attestation: { kind: "broker-peer-envelope", adapter: "fixture", capabilityVersion: "1.0.0" } }); expect(trust.verify(source)).toBe(true);
      const session = { ...sender, cwd: "synthetic-cwd", now: new Date(100).toISOString() }; setSummary(board, session, "standalone fixture"); expect(readSession(board, sender.host, sender.sessionId)?.summary).toBe("standalone fixture");
    } finally { workflow.close(); continuity.close(); messaging.close(); trust.close(); board.close(); }
  });
});
