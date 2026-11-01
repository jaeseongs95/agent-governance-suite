import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AttemptLeaseV1, AttemptProposalV1, ContinuitySnapshotV1, ConvergenceRootV1, TaskEnvelopeV1, WorkflowReceiptV1 } from "../../contracts/types.js";
import { createInactiveSharedStores } from "../../mcp-server/src/inactive-shared-stores.js";
import { InactiveSharedConnection } from "../../runtime/unified-state/shared-connection.mjs";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { ContinuityStoreError } from "../../mcp-server/src/continuity-store.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { readEntry, recordInput, setSummary } from "../../skills/session-board/scripts/board-store.mjs";
import type { InputObservation } from "../../mcp-server/src/input-observation.js";

const directories: string[] = [];
const bundles: ReturnType<typeof createInactiveSharedStores>[] = [];
const keys = { workflow: Buffer.alloc(32, 1).toString("base64url"), continuity: Buffer.alloc(32, 2).toString("base64url"), trust: Buffer.alloc(32, 3).toString("base64url") };
const iso = (value: number) => new Date(value).toISOString();
function fixture(clock = () => 100, syntheticKeys = keys) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ags-r2-legacy-")); directories.push(directory); const value = createInactiveSharedStores({ directory, mode: "fixture-only", clock, syntheticKeys }); bundles.push(value); return value; }
function receipt(runId = "original-run", revision = 0): WorkflowReceiptV1 { return { schemaVersion: "1.0.0", runId, revision, state: "running", plan: { schemaVersion: "1.0.0", taskId: "synthetic-task", integrityToken: "SYNTHETIC_UNVERIFIED_PLAN", executionMode: "orchestrated", state: "running", selectedSkills: [], stages: [], currentStageId: null, nextStageId: null, errors: [] }, stageResults: [], blockers: [], unresolved: [], error: null }; }
function snapshot(correlation = "original-correlation"): ContinuitySnapshotV1 { return { schemaVersion: "1.0.0", source: "direct", taskCorrelation: correlation, epoch: 1, revision: 1, status: "active", core: { objective: "synthetic", completionCriteria: [], constraints: [], decisions: [], progress: [], blockers: [], nextActions: [] }, evidenceRefs: [], snapshotDigest: `sha256:${"a".repeat(64)}`, createdAt: iso(100), updatedAt: iso(100) }; }
function root(directory: string): ConvergenceRootV1 {
  const task: TaskEnvelopeV1 = { schemaVersion: "1.0.0", taskId: "synthetic-task", objective: "synthetic repository fixture", scope: { included: ["fixture.ts"], excluded: [] }, acceptanceCriteria: ["fixture"], riskLevel: "low", workUnits: [{ id: "fixture", objective: "fixture", dependencies: [], writeTargets: ["fixture.ts"] }], requiredCapabilities: [], constraints: [], authorization: { allowedActions: ["fixture"], prohibitedActions: ["operating"], approvalRequired: [] }, decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true } };
  const frame = { schemaVersion: "1.0.0" as const, workspace: { workspaceId: "synthetic-workspace", locator: directory }, controlArtifacts: [], targetArtifacts: [], operationalSettings: { maxAttemptsPerEpoch: 3 as const, maxEpochs: 2 as const, leaseTtlSeconds: 10 } };
  const digest = convergenceDigest(frame);
  return { schemaVersion: "1.0.0", rootId: "original-root", parentRootId: null, revision: 0, state: "open", currentEpoch: 1, taskEnvelope: task, frame, taskDigest: convergenceDigest(task), frameDigest: digest, workspaceDigest: digest, controlDigest: digest, targetDigest: digest, operationalDigest: digest, userApprovalRefs: [], createdAt: iso(100), updatedAt: iso(100) };
}
function lease(value: ConvergenceRootV1): AttemptLeaseV1 { return { schemaVersion: "1.0.0", leaseId: "original-lease", rootId: value.rootId, rootRevision: 1, epoch: 1, ordinal: 1, proposalDigest: value.frameDigest, taskDigest: value.taskDigest, frameDigest: value.frameDigest, workspaceDigest: value.workspaceDigest, controlDigest: value.controlDigest, targetDigest: value.targetDigest, operationalDigest: value.operationalDigest, outputTargetsDigest: value.targetDigest, planIntegrityToken: "SYNTHETIC_UNVERIFIED_PLAN", actorId: "synthetic-actor", outputTargets: [], issuedAt: iso(100), expiresAt: iso(110), state: "issued" }; }
afterEach(() => { for (const value of bundles.splice(0)) value.owner.close(); for (const directory of directories.splice(0)) { expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir())); expect(path.basename(directory)).toMatch(/^ags-r2-legacy-/u); fs.rmSync(directory, { recursive: true }); } });

describe("native legacy APIs on one inactive authority connection", () => {
  it("B2-LEGACY-08: a shared storage fault retains the original typed/context error and atomic rollback", () => {
    const value = fixture(); const fault = new DatabaseSync(value.owner.databasePath);
    try { fault.exec("CREATE TRIGGER synthetic_continuity_fault BEFORE INSERT ON continuity_tasks BEGIN SELECT RAISE(ABORT,'synthetic-domain-fault'); END;"); } finally { fault.close(); }
    let rejected; try { value.continuity.ensureTask("valid-synthetic-correlation", iso(100)); } catch (error) { rejected = error; }
    expect(rejected).toBeInstanceOf(ContinuityStoreError); expect(rejected).toMatchObject({ message: "Cannot initialize the continuity task.", reason: "STORE_UNAVAILABLE" }); expect(value.owner.inspect().counts.continuity_tasks).toBe(0); expect(value.owner.inspect().time).toBe(100);
  });
  it("B2-LEGACY-01: cross-module domain failure is atomic; IDs/revisions survive success and replay", () => {
    const value = fixture(); const run = receipt();
    expect(() => value.owner.transaction(() => { value.workflow.insertRun(run); value.continuity.ensureTask("original-correlation", iso(100)); value.messaging.prepare({ sender: { host: "a", sessionId: "s" }, target: { host: "b", sessionId: "t" }, body: "fixture" }, 100); throw new Error("fixed-partial-fault"); })).toThrow("fixed-partial-fault");
    expect(value.workflow.getRun(run.runId)).toBeNull(); expect(value.continuity.getTask("original-correlation")).toBeNull(); expect(value.owner.inspect().counts.prepared_messages).toBe(0);
    value.owner.transaction(() => { value.workflow.insertRun(run); value.continuity.ensureTask("original-correlation", iso(100)); });
    expect(value.workflow.updateRun({ ...run, revision: 1 }, 99)).toBe(false); expect(value.workflow.getRun(run.runId)).toEqual(run);
    expect(value.workflow.updateRun({ ...run, revision: 1 }, 0)).toBe(true); expect(() => value.workflow.insertRun({ ...run, revision: 2 })).toThrow(); expect(value.workflow.getRun(run.runId)?.revision).toBe(1);
  });
  it("B2-LEGACY-02: original continuity request digest, epoch, snapshot and marker semantics stay distinct", () => {
    const value = fixture(); const store = value.continuity; const image = snapshot(); store.ensureTask(image.taskCorrelation, iso(100));
    expect(store.checkpoint(image.taskCorrelation, 1, 0, "original-request", "original-digest", image)).toEqual({ kind: "stored" });
    expect(store.checkpoint(image.taskCorrelation, 1, 0, "original-request", "original-digest", image)).toMatchObject({ kind: "replay" });
    expect(store.checkpoint(image.taskCorrelation, 1, 0, "original-request", "changed-digest", image)).toEqual({ kind: "conflict" });
    expect(store.checkpoint(image.taskCorrelation, 1, 0, "new-request", "new-digest", image)).toEqual({ kind: "stale", actualRevision: 1 });
    expect(store.bindRoot(image.taskCorrelation, 1, "original-root", iso(100))).toBe(true);
    expect(store.setPendingMarker(image.taskCorrelation, 1, "workflow", 1, image.snapshotDigest, "original-root", iso(100))).toBe(true);
    expect(store.consumeWorkflowMarker(image.taskCorrelation, 1, "original-root", 1, "wrong-digest", iso(100))).toBe(false); expect(store.consumeWorkflowMarker(image.taskCorrelation, 1, "original-root", 1, image.snapshotDigest, iso(100))).toBe(true); expect(store.consumeWorkflowMarker(image.taskCorrelation, 1, "original-root", 1, image.snapshotDigest, iso(100))).toBe(false);
    expect(store.rotateEpoch(image.taskCorrelation, iso(101)).currentEpoch).toBe(2); expect(store.setPendingMarker(image.taskCorrelation, 1, "workflow", 1, image.snapshotDigest, null, iso(102))).toBe(false);
    expect(store.getSnapshot(image.taskCorrelation, 1)).toEqual(image); expect(store.getRequest(image.taskCorrelation, 1, "original-request")?.commandDigest).toBe("original-digest");
    expect(() => store.backupTo(path.join(path.dirname(value.owner.databasePath), "no-backup.sqlite3"))).toThrow(/SHARED_BACKUP_OWNER_REQUIRED/u);
  });
  it("B2-LEGACY-03: ACK, committed receipt, unknown delivery and same-ID retry are different states", () => {
    let now = 100; const value = fixture(() => now); const store = value.messaging; const sender = { host: "sender-host", sessionId: "s" }; const target = { host: "target-host", sessionId: "t" };
    const draft = store.prepare({ sender, target, body: "original payload", ttlSeconds: 30 }, now); const first = store.submitPrepared(sender, draft.messageId, now);
    const replay = store.submitPrepared(sender, draft.messageId, now); expect(replay.messageId).toBe(first.messageId); expect(replay.createdAt).toBe(first.createdAt); expect(replay.duplicate).toBe(true); expect(value.owner.inspect().counts.messages).toBe(1);
    expect(() => store.send({ messageId: draft.messageId, sender, target, body: "changed payload", ttlSeconds: 30 }, now)).toThrow(/different message/u);
    expect(store.status({ ...sender, sessionId: "wrong" }, draft.messageId, now)).toBeNull(); expect(store.claim({ ...target, host: "wrong" }, now)).toEqual([]);
    const claimed = store.claim(target, now); expect(claimed).toHaveLength(1); expect(store.acknowledge({ ...target, sessionId: "wrong" }, [draft.messageId], now, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(0);
    expect(store.acknowledge(target, [draft.messageId, draft.messageId], now, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1); expect(store.acknowledge(target, [draft.messageId], now, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(0);
    expect(store.status(sender, draft.messageId, now)?.state).toBe("acknowledged");
    now = 30101; expect(store.status(sender, draft.messageId, now)).toMatchObject({ state: "acknowledged", messageId: draft.messageId }); expect(store.claim(target, now)).toEqual([]);
    console.log("B2-RAW receipt", JSON.stringify({ first, replay, afterExpiry: store.status(sender, draft.messageId, now), counts: value.owner.inspect().counts }));
  });
  it("B2-LEGACY-04: valid later clock plus stale revision cannot resurrect the native workflow lease", () => {
    let now = 100; const value = fixture(() => now); const initial = root(path.dirname(value.owner.databasePath)); expect(value.workflow.insertConvergenceRoot(initial)).toBeNull();
    const leased = { ...initial, revision: 1 }; const token = lease(initial); const proposal: AttemptProposalV1 = { schemaVersion: "1.0.0", rootId: initial.rootId, expectedRevision: 0, taskEnvelope: initial.taskEnvelope, frame: initial.frame, plan: receipt().plan, actorId: "synthetic-actor", outputTargets: [], priorFailure: null };
    expect(value.workflow.insertAttemptLease(leased, 0, proposal, token)).toBe(true);
    now = 200; expect(value.workflow.updateConvergenceRoot({ ...leased, revision: 2 }, 99)).toBe(false); expect(value.owner.inspect().time).toBe(200);
    now = 105; expect(value.workflow.insertGuardedRun(receipt("old-owner-run"), token.leaseId, 1, iso(105))).toBeNull(); expect(value.workflow.getRun("old-owner-run")).toBeNull(); expect(value.workflow.getConvergenceSnapshot(initial.rootId)?.root.revision).toBe(1); expect(value.workflow.getAttemptLease(token.leaseId)?.lease.state).toBe("issued");
    console.log("B2-RAW native-expiry", JSON.stringify({ time: value.owner.inspect().time, root: value.workflow.getConvergenceSnapshot(initial.rootId)?.root.revision, run: value.workflow.getRun("old-owner-run") }));
  });
  it("B2-LEGACY-05: real synthetic HMAC and original provenance conflict are preserved", () => {
    const value = fixture(); const input = { originKind: "peer" as const, host: "synthetic-host", sessionId: "synthetic-session", eventId: "original-source-event", contentDigest: `sha256:${"a".repeat(64)}` as const, observedAt: iso(100), expiresAt: iso(1000), authorityEffect: "none" as const, attestation: { kind: "broker-peer-envelope" as const, adapter: "synthetic-adapter", capabilityVersion: "1.0.0" as const } };
    const original = value.trust.recordInputSource(input); expect(value.trust.recordInputSource(input)).toEqual(original); expect(value.trust.verify(original)).toBe(true); expect(value.trust.verify({ ...original, eventId: "changed-event" })).toBe(false); expect(value.trust.latestInputSource({ host: input.host, sessionId: input.sessionId })?.receiptId).toBe(original.receiptId);
    expect(() => value.trust.recordInputSource({ ...input, contentDigest: `sha256:${"b".repeat(64)}` })).toThrow(/different content or provenance/u);
    expect(() => value.trust.recordInputSource({ ...input, originKind: "user-turn", attestation: { ...input.attestation, kind: "host-direct-user-event" } })).toThrow(/cannot attest direct-user/u);
    const other = fixture(); expect(other.trust.verify(original)).toBe(true); // Same explicit synthetic key, rather than a fabricated key transfer.
    const alternate = { ...keys, trust: Buffer.alloc(32, 4).toString("base64url") }; const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ags-r2-legacy-")); directories.push(dir); const foreign = createInactiveSharedStores({ directory: dir, mode: "fixture-only", clock: () => 100, syntheticKeys: alternate }); bundles.push(foreign); expect(foreign.trust.verify(original)).toBe(false);
  });
  it("B2-LEGACY-06: a real signed wake observation is checked on the same connection with negative predicate coverage", () => {
    const now = 100; const value = fixture(() => now); const target = { host: "fake-host", sessionId: "fake-session" }; const sender = { host: "fake-sender", sessionId: "s" }; const nonce = "abcdefghijklmnopqrstuvwx";
    value.messaging.startPresence({ ...target, instanceId: "instance-1", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" }, hostPid: 4242 }, now);
    const relayId = value.messaging.grantRelay({ ...target, transport: "codex-queue", instanceId: "instance-1", codeDigest: null, hostPid: 4242 }, now).relayId!;
    expect(value.messaging.relayTick({ ...target, transport: "codex-queue", relayId, instanceId: "instance-1", includePending: false, hostStart: "synthetic-host-start" }, now)).toEqual({ alive: true, count: 0, hostBound: true });
    value.messaging.send({ messageId: "wake-body-original", sender, target, body: "synthetic body" }, now);
    const reserved = value.messaging.reserveManagedWake({ ...target, instanceId: "instance-1", transport: "codex-queue", relayId, nonce }, now); expect(reserved.attempt).not.toBeNull();
    const started = value.messaging.startManagedWake(reserved.attempt!, 600_000, now); expect(started.dispatch).toBe(true); expect(value.messaging.startManagedWake(reserved.attempt!, 600_000, now).dispatch).toBe(false); expect(value.messaging.recordManagedWakeOutcome(started.attempt!, { result: "unknown" }, 600_000, now)).toBe(true);
    const observation: InputObservation = { ...target, kind: "user-input", wakeOnly: true, wakeCandidates: [nonce], actor: { role: "root", basis: "observed", reasonCode: "SYNTHETIC_LEGACY_WAKE_ROOT" } };
    const contentDigest = `sha256:${createHash("sha256").update(JSON.stringify([target.host, target.sessionId, "user-input", true, "root", "observed", [nonce]])).digest("hex")}` as const;
    const source = value.trust.recordInputSource({ originKind: "peer", ...target, eventId: "synthetic-wake-source", contentDigest, observedAt: iso(now), expiresAt: iso(1000), authorityEffect: "none", attestation: { kind: "broker-peer-envelope", adapter: "session-message-wake-hook", capabilityVersion: "3.0.0" } });
    expect(value.wakeReader.verifyObservation(target, { ...observation, wakeCandidates: ["xxxxxxxxxxxxxxxxxxxxxxxx"] }, source.receiptId, now)).toBe(false); expect(value.wakeReader.verifyObservation({ ...target, sessionId: "wrong" }, observation, source.receiptId, now)).toBe(false); expect(value.wakeReader.verifyObservation(target, observation, source.receiptId, 1000)).toBe(false);
    const effect = value.messaging.claimHostWake(target, observation, source.receiptId, value.wakeReader, now); expect(effect.recognized).toBe(true); expect(effect.messages).toHaveLength(1); expect(effect.binding?.attemptId).toBe(started.attempt?.attemptId); expect(value.messaging.claimHostWake(target, observation, source.receiptId, value.wakeReader, now).messages).toEqual([]); expect(value.owner.inspect().databases.filter(row => row.file !== "")).toHaveLength(1);
  });
  it("B2-LEGACY-07: board composite scope and continuity correlation never merge identities", () => {
    const value = fixture(); const a = { host: "board-a", sessionId: "same-session", cwd: "synthetic-cwd", now: iso(100) }; const b = { ...a, host: "board-b" };
    recordInput(value.board, a, { prompt: true }); setSummary(value.board, a, "one synthetic line"); expect(readEntry(value.board, a.host, a.sessionId)).toMatchObject({ summary: "one synthetic line", lastPromptAt: iso(100), summaryStale: false }); expect(readEntry(value.board, b.host, b.sessionId)).toBeNull();
    const service = new ContinuityService(value.continuity, null, value.workflow, () => new Date(100)); const other = fixture(); const sameKeyService = new ContinuityService(other.continuity, null, other.workflow, () => new Date(100)); expect(service.correlateSession("raw-session-fixture")).toBe(sameKeyService.correlateSession("raw-session-fixture"));
    expect(service.correlateSession("another-raw-session")).not.toBe(service.correlateSession("raw-session-fixture"));
    const distinct = fixture(() => 100, { ...keys, continuity: Buffer.alloc(32, 5).toString("base64url") }); const distinctService = new ContinuityService(distinct.continuity, null, distinct.workflow, () => new Date(100)); expect(distinctService.correlateSession("raw-session-fixture")).not.toBe(service.correlateSession("raw-session-fixture"));
    expect(() => value.workflow.backupTo(path.join(path.dirname(value.owner.databasePath), "no-backup.sqlite3"))).toThrow(/SHARED_BACKUP_OWNER_REQUIRED/u);
  });
});


// The owner's committed header shape (#shape in runtime/unified-state/shared-connection.mjs), recomputed for a downgraded file.
function moduleShape(db: DatabaseSync, tables: readonly string[]): string {
  return JSON.stringify(tables.map(name => ({ name, columns: db.prepare(`PRAGMA table_info(${name})`).all(),
    sql: (db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name) as { sql?: string } | undefined)?.sql,
    indexes: (db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' AND tbl_name=? ORDER BY name").all(name) as Array<{ name: string }>)
      .map(index => ({ ...index, columns: db.prepare("SELECT * FROM pragma_index_xinfo(?)").all(index.name) })) })));
}

// The previous shared messaging layout (module v3): PID-bound relay leases and parent-identity presence columns, no peer_wait_snapshots.
const V3_MESSAGING_TABLES = ["messages", "relay_leases", "wake_nonces", "session_presence", "prepared_messages", "input_observations", "wake_paths"] as const;
const V3_RELAY_LEASES = `CREATE TABLE relay_leases (host TEXT NOT NULL, session_id TEXT NOT NULL, transport TEXT NOT NULL, relay_id TEXT NOT NULL,
  pid INTEGER NOT NULL, parent_pid INTEGER NOT NULL, relay_start_token TEXT, relay_code_digest TEXT, relay_code_id TEXT,
  lease_until TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (host, session_id, transport)) STRICT;`;

it("AGS 3.0: 공용 messaging v3는 읽기 검증 뒤 명시적 이전으로 v4가 되고(lease는 비고 PID 열은 사라진다), v2는 거부되며, 다시 열어도 같다", () => {
  const previous = fixture();
  const filename = previous.owner.databasePath, directory = path.dirname(filename);
  const sender = { host: "sender-host", sessionId: "migration-sender" };
  const target = { host: "target-host", sessionId: "migration-target" };
  const delivered = previous.messaging.prepare({ sender, target, body: "historical delivered body" }, 100);
  previous.messaging.submitPrepared(sender, delivered.messageId, 100);
  expect(previous.messaging.claim(target, 100)).toMatchObject([{ messageId: delivered.messageId, deliveryAttempt: 1 }]);
  const queued = previous.messaging.prepare({ sender, target, body: "historical queued body" }, 101);
  previous.messaging.submitPrepared(sender, queued.messageId, 101);
  previous.messaging.startPresence({ ...target, instanceId: "migration-instance", transport: "codex-queue", wakeVisibility: "user-message",
    canWakeSilently: false, deliveryCapabilities: { supportedInjection: ["peer-wake"], idleWake: "user-message" } }, 101);
  previous.workflow.insertRun(receipt("migration-retained-run"));
  previous.owner.close();

  // Downgrade the messaging module to the v3 shared layout: old relay_leases with PID ownership, presence identity columns.
  const legacy = new DatabaseSync(filename);
  try {
    legacy.exec(`DROP TABLE peer_wait_snapshots; DROP TABLE relay_leases; ${V3_RELAY_LEASES}`);
    legacy.exec(`ALTER TABLE session_presence DROP COLUMN host_pid; ALTER TABLE session_presence DROP COLUMN host_start;
      ALTER TABLE session_presence ADD COLUMN verified_parent_pid INTEGER; ALTER TABLE session_presence ADD COLUMN verified_parent_token TEXT;
      ALTER TABLE session_presence ADD COLUMN reported_parent_pid INTEGER; ALTER TABLE session_presence ADD COLUMN reported_parent_token TEXT;`);
    legacy.prepare("UPDATE session_presence SET verified_parent_pid = 77, verified_parent_token = 'old-token', reported_parent_pid = 77, reported_parent_token = 'old-token'").run();
    legacy.prepare(`INSERT INTO relay_leases (host, session_id, transport, relay_id, pid, parent_pid, relay_start_token, lease_until, updated_at)
      VALUES (?, ?, 'codex-queue', 'old-relay', 88, 77, 'old-relay-token', ?, ?)`).run(target.host, target.sessionId, iso(3_600_000), iso(100));
    legacy.prepare("UPDATE shared_module_schema SET version = 3, schema_json = ? WHERE module = 'messaging'").run(moduleShape(legacy, V3_MESSAGING_TABLES));
  } finally { legacy.close(); }

  // A v2 messaging header is no longer an accepted previous format (the broker removal migrates only from v3).
  const setMessagingVersion = (version: number) => { const db = new DatabaseSync(filename); try { db.prepare("UPDATE shared_module_schema SET version = ? WHERE module = 'messaging'").run(version); } finally { db.close(); } };
  setMessagingVersion(2);
  let v2Failure: unknown;
  try {
    const connection = new InactiveSharedConnection({ databasePath: filename, mode: "fixture-only", clock: () => 101 });
    try { connection.borrow("messaging").getSchemaVersion(); connection.transaction(() => {}); } finally { connection.close(); }
  } catch (error) { v2Failure = error; }
  expect(v2Failure).toMatchObject({ code: "SHARED_SCHEMA_DRIFT" });
  setMessagingVersion(3);

  const before = fs.readFileSync(filename);
  const pending = new InactiveSharedConnection({ databasePath: filename, mode: "fixture-only", clock: () => 101 });
  try {
    expect(pending.borrow("messaging").getSchemaVersion()).toBe(3);
    let called = false, failure: unknown;
    try { pending.transaction(() => { called = true; }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "SCHEMA_NOT_READY" });
    expect(called).toBe(false);
  } finally { pending.close(); }
  expect(fs.readFileSync(filename)).toEqual(before);

  const migrated = createInactiveSharedStores({ directory, mode: "fixture-only", clock: () => 122_001, syntheticKeys: keys });
  bundles.push(migrated);
  const inspected = migrated.owner.inspect();
  expect(inspected.modules.find(row => row.module === "messaging")?.version).toBe(4);
  expect(Object.keys(inspected.counts)).toContain("peer_wait_snapshots");
  expect(inspected.counts.relay_leases).toBe(0);
  const columns = (table: string) => (migrated.messaging.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
  expect(columns("relay_leases")).toEqual(["host", "session_id", "transport", "instance_id", "relay_id", "code_digest", "granted_at", "lease_until", "updated_at"]);
  expect(columns("session_presence")).toEqual(expect.arrayContaining(["host_pid", "host_start"]));
  for (const gone of ["verified_parent_pid", "verified_parent_token", "reported_parent_pid", "reported_parent_token"]) expect(columns("session_presence")).not.toContain(gone);
  // The old generation stays but reports no host: it gets no relay until its next start.
  expect(migrated.messaging.presenceHost(target, "migration-instance")).toBeNull();
  expect(migrated.workflow.getRun("migration-retained-run")).toEqual(receipt("migration-retained-run"));
  expect(migrated.messaging.status(sender, delivered.messageId, 122_001)).toMatchObject({ deliveryAttempts: 1 });
  expect(migrated.messaging.status(sender, queued.messageId, 122_001)).toMatchObject({ state: "queued", deliveryAttempts: 0 });
  const rowsOf = (store: typeof migrated.messaging) => ["messages", "session_presence", "wake_nonces", "prepared_messages", "relay_leases"]
    .map(table => (store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>).map(row => ({ ...row })));
  const closing = rowsOf(migrated.messaging);
  migrated.owner.close();

  // Reopening runs no second migration: the same rows, version and inventory.
  const reopened = createInactiveSharedStores({ directory, mode: "fixture-only", clock: () => 122_003, syntheticKeys: keys });
  bundles.push(reopened);
  expect(reopened.owner.inspect().modules.find(row => row.module === "messaging")?.version).toBe(4);
  expect(rowsOf(reopened.messaging)).toEqual(closing);
  const claimed = reopened.messaging.claim(target, 122_003, { maxMessages: 1 });
  expect(claimed).toMatchObject([{ messageId: delivered.messageId, body: "historical delivered body", deliveryAttempt: 2 }]);
  expect(reopened.messaging.acknowledge(target, [delivered.messageId], 122_004, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
  expect(reopened.messaging.status(sender, delivered.messageId, 122_005)).toMatchObject({ state: "acknowledged", deliveryAttempts: 2 });
  expect(reopened.workflow.getRun("migration-retained-run")).toEqual(receipt("migration-retained-run"));
});
