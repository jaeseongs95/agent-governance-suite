import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttemptLeaseV1, AttemptProposalV1, ConvergenceRootV1, TaskEnvelopeV1, WorkflowReceiptV1 } from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { StateCleanupService } from "../../mcp-server/src/state-cleanup-service.js";
import { createInactiveSharedStores } from "../../mcp-server/src/inactive-shared-stores.js";
// @ts-expect-error Existing fixture-only JavaScript authority has no declaration file.
import { InactiveUnifiedAuthority, createProviderAdapter, fixtureDigest } from "../../runtime/unified-state/authority.mjs";
// @ts-expect-error Existing JavaScript fixtures have no declaration file.
import { scopeA, workflowRef, workflowRow, nextWorkflowRow, records, reference, snapshot } from "../unified-state/fixtures.mjs";

const directories: string[] = [];
const stores = new Set<{ close(): void }>();
const OLD = "2025-01-01T00:00:00.000Z";
const NOW = new Date("2026-10-25T00:00:00.000Z");
const keys = { workflow: Buffer.alloc(32, 1).toString("base64url"), continuity: Buffer.alloc(32, 2).toString("base64url"), trust: Buffer.alloc(32, 3).toString("base64url") };
function directory(): string { const value = mkdtempSync(path.join(tmpdir(), "ags30-al07-")); directories.push(value); return value; }
function keep<T extends { close(): void }>(value: T): T { stores.add(value); return value; }
afterEach(() => {
  vi.restoreAllMocks();
  const errors: unknown[] = [];
  for (const value of stores) { try { value.close(); } catch (error) { errors.push(error); } }
  stores.clear();
  for (const dir of directories.splice(0)) {
    try {
      if (path.dirname(dir) !== path.resolve(tmpdir()) || !path.basename(dir).startsWith("ags30-al07-")) throw new Error("Fixture cleanup escaped its owned root.");
      rmSync(dir, { recursive: true, force: true });
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "AL07 fixture cleanup failed.");
});
function receipt(runId: string): WorkflowReceiptV1 {
  return { schemaVersion: "1.0.0", runId, revision: 1, state: "running", plan: { schemaVersion: "1.0.0", taskId: "fixture-task", integrityToken: "fixture-token", executionMode: "orchestrated", state: "running", selectedSkills: [], stages: [], currentStageId: null, nextStageId: null, errors: [] }, stageResults: [], blockers: [], unresolved: [], error: null };
}
function taskEnvelope(): TaskEnvelopeV1 {
  return {
    schemaVersion: "1.0.0",
    taskId: "workflow-task",
    objective: "Finish an orchestrated task.",
    scope: { included: ["src"], excluded: ["deploy"] },
    acceptanceCriteria: ["Tests pass."],
    riskLevel: "low",
    workUnits: [{ id: "implementation", objective: "Implement.", dependencies: [], writeTargets: ["src"] }],
    requiredCapabilities: [],
    constraints: ["Keep scope fixed."],
    authorization: { allowedActions: ["edit"], prohibitedActions: ["deploy"], approvalRequired: [] },
    decision: { complexity: "complex", hasConflicts: false },
    orchestration: { requested: true, mcpAvailable: true },
  };
}

function workflowRoot(): ConvergenceRootV1 {
  const task = taskEnvelope();
  const frame = {
    schemaVersion: "1.0.0" as const,
    workspace: { workspaceId: "workspace", locator: "D:/workspace" },
    controlArtifacts: [],
    targetArtifacts: [],
    operationalSettings: { maxAttemptsPerEpoch: 3 as const, maxEpochs: 2 as const, leaseTtlSeconds: 300 },
  };
  return {
    schemaVersion: "1.0.0",
    rootId: "root-1",
    parentRootId: null,
    revision: 1,
    state: "open",
    currentEpoch: 1,
    taskEnvelope: task,
    frame,
    taskDigest: convergenceDigest(task),
    frameDigest: convergenceDigest(frame),
    workspaceDigest: convergenceDigest(frame.workspace),
    controlDigest: convergenceDigest(frame.controlArtifacts),
    targetDigest: convergenceDigest(frame.targetArtifacts),
    operationalDigest: convergenceDigest(frame.operationalSettings),
    userApprovalRefs: [],
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}


describe("AGS30 AL07 owned regressions", () => {
  it("AGS-D-0050: the signed token binds a digest without copying every candidate", () => {
    const filename = path.join(directory(), "workflow.sqlite3");
    const workflow = keep(new SqliteWorkflowStore(filename));
    const raw = new DatabaseSync(filename);
    try {
      const insert = raw.prepare("INSERT INTO workflow_runs VALUES (?,1,'passed','{}',?,?)");
      raw.exec("BEGIN;");
      for (let index = 0; index < 500; index++) insert.run(`candidate-${index}-${"x".repeat(100)}`, OLD, OLD);
      raw.exec("COMMIT;");
    } finally { raw.close(); }
    const service = new StateCleanupService(workflow, null, new ContractValidator(), () => new Date(NOW));
    const plan = service.prepare({ schemaVersion: "1.0.0" });
    expect(plan.ok).toBe(true); expect(plan.data?.counts.workflowRuns).toBe(500);
    const token = plan.data!.planToken;
    const payload = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("candidates"); expect(payload).not.toHaveProperty("linkedRuns");
    expect(Buffer.byteLength(token)).toBeLessThan(4096);
    expect(service.execute({ schemaVersion: "1.0.0", planToken: "x".repeat(65537) }).error?.code).toBe("INVALID_INPUT");
    const changed = new DatabaseSync(filename);
    try { changed.prepare("UPDATE workflow_runs SET revision=2 WHERE run_id=(SELECT min(run_id) FROM workflow_runs)").run(); }
    finally { changed.close(); }
    expect(service.execute({ schemaVersion: "1.0.0", planToken: token }).error?.code).toBe("STALE_REVISION");
    const reader = new DatabaseSync(filename, { readOnly: true });
    try { expect(reader.prepare("SELECT count(*) AS n FROM state_cleanup_claims").get()?.n).toBe(0); expect(reader.prepare("SELECT count(*) AS n FROM workflow_runs").get()?.n).toBe(500); }
    finally { reader.close(); }
  });
  it("AGS-D-0054: bounded workflow arrays state how many entries were omitted", () => {
    const workflow = new InMemoryWorkflowStore(); const root = workflowRoot();
    root.taskEnvelope.acceptanceCriteria = Array.from({ length: 6 }, (_, index) => `criterion-${index}`);
    root.taskDigest = convergenceDigest(root.taskEnvelope);
    workflow.insertConvergenceRoot(root);
    const service = new ContinuityService(keep(new SqliteContinuityStore(":memory:")), null, workflow, () => new Date(NOW));
    const input = { schemaVersion: "1.0.0" };
    service.bindOpenedRoot({ ...input, _continuityBinding: service.issueToolBinding("array-session", "open_convergence_root", input) }, root.rootId);
    service.markPreCompact("array-session");
    const output = service.compactContext("array-session");
    expect(output).toContain("criterion-3 [+2 omitted]"); expect(output).not.toContain("criterion-4");
    const card = JSON.parse(output!.split("\n")[2]!) as { acceptanceCriteria: string[] };
    expect(card.acceptanceCriteria).toHaveLength(4); expect(card.acceptanceCriteria.every(value => value.length <= 240)).toBe(true);
  });
  it("AGS-D-0056: root correlation returns an observable success or rejection", () => {
    const service = new ContinuityService(keep(new SqliteContinuityStore(":memory:")), null, null, () => new Date(NOW));
    const input = { schemaVersion: "1.0.0" };
    expect(service.bindOpenedRoot(input, "root-fixture")).toBe(false);
    const bound = { ...input, _continuityBinding: service.issueToolBinding("bind-session", "open_convergence_root", input) };
    expect(service.bindOpenedRoot(bound, "root-fixture")).toBe(true);
    service.clearSession("bind-session"); expect(service.bindOpenedRoot(bound, "root-fixture")).toBe(false);
  });
  it("AGS-D-0059: a second connection can finish migration before the first writer acquires its lock", () => {
    const filename = path.join(directory(), "legacy.sqlite3");
    const raw = new DatabaseSync(filename);
    try {
      raw.exec("CREATE TABLE workflow_runs(run_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, receipt_json TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT; PRAGMA user_version=3;");
      raw.prepare("INSERT INTO workflow_runs VALUES('preserved',1,?,?)").run(JSON.stringify(receipt("preserved")), OLD);
    } finally { raw.close(); }
    const exec = DatabaseSync.prototype.exec; let competitorOpened = false;
    const intercept = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE;" && !competitorOpened) { competitorOpened = true; keep(new SqliteWorkflowStore(filename)); }
      return exec.call(this, sql);
    });
    const first = keep(new SqliteWorkflowStore(filename)); intercept.mockRestore();
    expect(competitorOpened).toBe(true); expect(first.getSchemaVersion()).toBe(5); expect(first.getRun("preserved")?.runId).toBe("preserved");
  });
  it("AGS-D-0060: expiry is checked after the writer lock even when consumedAt was fresh before waiting", () => {
    let clock = 100; vi.spyOn(Date, "now").mockImplementation(() => clock);
    const workflow = keep(new SqliteWorkflowStore(":memory:")); const root = workflowRoot(); workflow.insertConvergenceRoot(root);
    const claimed = { ...root, revision: 2 };
    const plan = { ...receipt("guarded-run").plan, state: "ready" as const };
    const proposal: AttemptProposalV1 = { schemaVersion: "1.0.0", rootId: root.rootId, expectedRevision: 1, taskEnvelope: root.taskEnvelope, frame: root.frame, plan, actorId: "fixture-actor", outputTargets: [], priorFailure: null };
    const digest = convergenceDigest("fixture");
    const lease: AttemptLeaseV1 = { schemaVersion: "1.0.0", leaseId: "expiry-lease", rootId: root.rootId, rootRevision: 2, epoch: 1, ordinal: 1, proposalDigest: digest, taskDigest: root.taskDigest, frameDigest: root.frameDigest, workspaceDigest: root.workspaceDigest, controlDigest: root.controlDigest, targetDigest: root.targetDigest, operationalDigest: root.operationalDigest, outputTargetsDigest: digest, planIntegrityToken: plan.integrityToken, actorId: "fixture-actor", outputTargets: [], issuedAt: new Date(100).toISOString(), expiresAt: new Date(200).toISOString(), state: "issued" };
    expect(workflow.insertAttemptLease(claimed, 1, proposal, lease)).toBe(true);
    const exec = DatabaseSync.prototype.exec;
    const intercept = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) { const result = exec.call(this, sql); if (sql === "BEGIN IMMEDIATE;") clock = 200; return result; });
    expect(workflow.insertGuardedRun(receipt("guarded-run"), lease.leaseId, 2, new Date(100).toISOString())).toBeNull(); intercept.mockRestore();
    expect(workflow.getRun("guarded-run")).toBeNull(); expect(workflow.getAttemptLease(lease.leaseId)?.lease.state).toBe("issued"); expect(workflow.getConvergenceSnapshot(root.rootId)?.root.revision).toBe(2);
  });
  it("AGS-D-0149: authority table shape drift and shared index drift fail closed", () => {
    const opaqueDirectory = directory();
    const initial = new InactiveUnifiedAuthority({ directory: opaqueDirectory, mode: "fixture-only" }); const filename = initial.databasePath; initial.close();
    const opaqueEditor = new DatabaseSync(filename); try { opaqueEditor.exec("ALTER TABLE write_intents ADD COLUMN forbidden_drift TEXT"); } finally { opaqueEditor.close(); }
    const reopened: { value?: { close(): void } } = {};
    try { expect(() => { reopened.value = new InactiveUnifiedAuthority({ directory: opaqueDirectory, mode: "fixture-only" }); }).toThrow(expect.objectContaining({ code: "CANDIDATE_SCHEMA_DRIFT" })); }
    finally { reopened.value?.close(); }
    const sharedDirectory = directory();
    const native = createInactiveSharedStores({ directory: sharedDirectory, mode: "fixture-only", clock: () => 100, syntheticKeys: keys }); const nativeFilename = native.owner.databasePath; native.owner.close();
    const sharedEditor = new DatabaseSync(nativeFilename); try { sharedEditor.exec("DROP INDEX input_source_latest"); } finally { sharedEditor.close(); }
    const reopenedNative: { value?: ReturnType<typeof createInactiveSharedStores> } = {};
    try { expect(() => { reopenedNative.value = createInactiveSharedStores({ directory: sharedDirectory, mode: "fixture-only", clock: () => 100, syntheticKeys: keys }); }).toThrow(/Module versions and native schemas/u); }
    finally { reopenedNative.value?.owner.close(); }
  });
  it.each(["password", "passwd", "pwd", "apiKey", "apiToken", "authToken", "bearerToken", "token", "authorization", "credential", "cookie"])("AGS-D-0226: %s is rejected while the public integrityToken fixture remains importable", field => {
    const authority = keep(new InactiveUnifiedAuthority({ directory: directory(), mode: "fixture-only", clock: () => 100 })); const provider = createProviderAdapter(authority, scopeA);
    const entries = records(); entries[0].row[field] = "synthetic-private-value"; const json = snapshot(scopeA, entries);
    expect(() => provider.importFixture({ snapshotJson: json, sourceDigest: fixtureDigest(json), intentId: "secret-denied" })).toThrow(expect.objectContaining({ code: "SECRET_IMPORT_UNSUPPORTED" }));
    expect(authority.inspect().counts.records).toBe(0);
    const clean = snapshot(); expect(provider.importFixture({ snapshotJson: clean, sourceDigest: fixtureDigest(clean), intentId: "public-signature" }).state).toBe("COMPLETE");
  });
  it("AGS-D-0228/0236: missing records differ from actual epoch inconsistency and a valid continuity CAS reaches the branch", () => {
    let now = 100;
    const authority = keep(new InactiveUnifiedAuthority({ directory: directory(), mode: "fixture-only", clock: () => now })); const provider = createProviderAdapter(authority, scopeA);
    const absent = { ...workflowRef, key: { run_id: "absent" } };
    expect(() => provider.claim(absent, { expectedRevision: 4, owner: "fixture-owner", ttlMs: 100 })).toThrow(expect.objectContaining({ code: "RECORD_NOT_FOUND" }));
    expect(() => provider.commit(absent, { expectedRevision: 4, lease: { generation: 1, owner: "fixture-owner" }, row: { ...nextWorkflowRow(), run_id: "absent" }, intentId: "missing-record", receiptId: "missing-receipt" })).toThrow(expect.objectContaining({ code: "RECORD_NOT_FOUND" }));
    const json = snapshot(); provider.importFixture({ snapshotJson: json, sourceDigest: fixtureDigest(json), intentId: "seed" });
    const entry = records()[2]; const ref = reference(entry);
    const next = { ...entry.row, revision: 8, snapshot_json: '{"source":"direct","revision":8}' };
    expect(() => provider.commit(ref, { expectedRevision: 7, lease: { generation: 1, owner: "continuity-owner" }, row: next, intentId: "missing-lease", receiptId: "missing-lease-receipt" })).toThrow(expect.objectContaining({ code: "LEASE_REQUIRED" }));
    const shortLease = provider.claim(ref, { expectedRevision: 7, owner: "continuity-owner", ttlMs: 50 });
    expect(() => provider.commit(ref, { expectedRevision: 7, lease: { ...shortLease, owner: "other-owner" }, row: next, intentId: "lease-owner-mismatch", receiptId: "owner-mismatch-receipt" })).toThrow(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    now = 200;
    expect(() => provider.commit(ref, { expectedRevision: 7, lease: shortLease, row: next, intentId: "lease-expired", receiptId: "lease-expired-receipt" })).toThrow(expect.objectContaining({ code: "LEASE_EXPIRED" }));
    const lease = provider.claim(ref, { expectedRevision: 7, owner: "continuity-owner", ttlMs: 1000 });
    expect(() => provider.commit(ref, { expectedRevision: 7, lease: shortLease, row: next, intentId: "lease-generation-mismatch", receiptId: "gen-mismatch-receipt" })).toThrow(expect.objectContaining({ code: "LEASE_CONFLICT" }));
    expect(provider.commit(ref, { expectedRevision: 7, lease, row: next, intentId: "continuity-cas", receiptId: "continuity-receipt" }).applied).toBe(true); expect(provider.read(ref).epoch).toBe(2);
    expect(() => provider.commit(ref, { expectedRevision: 7, lease, row: next, intentId: "stale-revision-commit", receiptId: "stale-revision-receipt" })).toThrow(expect.objectContaining({ code: "STALE_REVISION" }));
    const raw = new DatabaseSync(authority.databasePath); try { raw.prepare("UPDATE records SET epoch=3 WHERE table_name='continuity_snapshots'").run(); } finally { raw.close(); }
    const fresh = provider.claim(ref, { expectedRevision: 8, owner: "continuity-owner", ttlMs: 1000 });
    expect(() => provider.commit(ref, { expectedRevision: 8, lease: fresh, row: { ...next, revision: 9 }, intentId: "epoch-inconsistent", receiptId: "epoch-receipt" })).toThrow(expect.objectContaining({ code: "EPOCH_CHANGE_UNSUPPORTED" }));
    expect(provider.receipt("epoch-inconsistent")).toBeNull(); expect(provider.history(ref)).toHaveLength(2);
  });
  it("AGS-D-0241: a later import chunk conflicts with an already stored row without overwriting it", () => {
    const authority = keep(new InactiveUnifiedAuthority({ directory: directory(), mode: "fixture-only" })); const provider = createProviderAdapter(authority, scopeA);
    const entries = [records()[0], { ...records()[0], row: { ...workflowRow, state: "failed" } }]; const json = snapshot(scopeA, entries);
    const request = { snapshotJson: json, sourceDigest: fixtureDigest(json), intentId: "stored-row-conflict", batchSize: 1 };
    expect(provider.importFixture(request)).toEqual({ state: "PENDING", nextIndex: 1, inserted: 1 });
    expect(provider.importFixture(request)).toMatchObject({ state: "CONFLICT", reason: "ROW_PAYLOAD_CONFLICT", nextIndex: 1 });
    expect(provider.read(workflowRef).row).toEqual(workflowRow); expect(authority.inspect().counts).toMatchObject({ records: 1, record_history: 1, import_journal: 1, conflicts: 1 });
  });
});
