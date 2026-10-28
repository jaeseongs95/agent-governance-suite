import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AttemptLeaseV1, AttemptOutcomeV1, AttemptProposalV1, CheckpointContextRequestV1, ConvergenceRootV1,
  ContinuityCandidateV1, TaskEnvelopeV1, WorkflowReceiptV1,
} from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { ContinuityStoreError, SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { adaptHostInput, isGovernanceHookTool, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { createInactiveSharedStores } from "../../mcp-server/src/inactive-shared-stores.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { InMemoryWorkflowStore, type ConvergenceSnapshot, type WorkflowStore } from "../../mcp-server/src/workflow-store.js";

// D0344 test plan: service/lifecycle + real SQLite conditional-rotation boundaries.
// Terminal cases: E -> E+1, fresh direct revision 1, history preserved and old authority fenced.
// Negative cases: active/missing/unavailable authority and unfinished older attempts never detach.
// Race oracle: the exact E/root observed before entry may rotate once; a changed E/root survives.
// Owned adapter/snapshot fixtures are synthetic authority observations, not native-host evidence.
// Execution proof is collected remotely; local test/typecheck/build/DB execution is NOT_RUN.
const now = "2026-10-28T00:00:00.000Z";
const session = "d0344-same-session";
const stores = new Set<SqliteContinuityStore | SqliteWorkflowStore>();
const owners = new Set<ReturnType<typeof createInactiveSharedStores>["owner"]>();
const directories: string[] = [];
const host = "synthetic-d0344-terminal-continuity";
registerHookHostAdapter(host, {
  processPid: () => undefined,
  deliveryProfile: () => ({ transport: "claude-inbox", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false }),
  ownsTool: name => isGovernanceHookTool("codex", name),
  adaptInput: (payload, hostId) => {
    const mapped = adaptHostInput(payload, "codex");
    return { ...mapped, observation: { ...mapped.observation, host: hostId,
      actor: { role: "root", basis: "observed", reasonCode: "D0344_SYNTHETIC_ROOT" } } };
  },
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.clear();
  for (const owner of owners) owner.close();
  owners.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function service(workflow: WorkflowStore | null = new InMemoryWorkflowStore(), path = ":memory:") {
  const store = new SqliteContinuityStore(path);
  stores.add(store);
  return new ContinuityService(store, new ContractValidator(), workflow, () => new Date(now));
}

function checkpoint(overrides: Partial<CheckpointContextRequestV1> = {}): Omit<CheckpointContextRequestV1, "_continuityBinding"> {
  return {
    schemaVersion: "1.0.0", requestId: "same-request-id", expectedRevision: 0, status: "active",
    core: { objective: "HISTORICAL-D0344-PAYLOAD", completionCriteria: ["Tests pass."], constraints: [],
      decisions: [], progress: ["Previous task."], blockers: [], nextActions: ["Historical action."] },
    evidenceRefs: [], ...overrides,
  };
}

function bound<T extends Record<string, unknown>>(target: ContinuityService, tool: string, input: T) {
  return { ...input, _continuityBinding: target.issueToolBinding(session, tool, input) };
}

function root(): ConvergenceRootV1 {
  const task: TaskEnvelopeV1 = {
    schemaVersion: "1.0.0", taskId: "d0344-workflow", objective: "Finish the bound workflow.",
    scope: { included: ["src"], excluded: ["deploy"] }, acceptanceCriteria: ["Tests pass."], riskLevel: "low",
    workUnits: [{ id: "implementation", objective: "Implement.", dependencies: [], writeTargets: ["src"] }],
    requiredCapabilities: [], constraints: [],
    authorization: { allowedActions: ["edit"], prohibitedActions: ["deploy"], approvalRequired: [] },
    decision: { complexity: "complex", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
  };
  const frame = { schemaVersion: "1.0.0" as const, workspace: { workspaceId: "d0344", locator: "D:/d0344" },
    controlArtifacts: [], targetArtifacts: [],
    operationalSettings: { maxAttemptsPerEpoch: 3 as const, maxEpochs: 2 as const, leaseTtlSeconds: 300 } };
  return { schemaVersion: "1.0.0", rootId: "d0344-root", parentRootId: null, revision: 1, state: "open", currentEpoch: 1,
    taskEnvelope: task, frame, taskDigest: convergenceDigest(task), frameDigest: convergenceDigest(frame),
    workspaceDigest: convergenceDigest(frame.workspace), controlDigest: convergenceDigest(frame.controlArtifacts),
    targetDigest: convergenceDigest(frame.targetArtifacts), operationalDigest: convergenceDigest(frame.operationalSettings),
    userApprovalRefs: [], createdAt: now, updatedAt: now };
}

function bindRoot(target: ContinuityService, value: ConvergenceRootV1) {
  const input = { schemaVersion: "1.0.0", taskEnvelope: value.taskEnvelope, frame: value.frame, parentRootId: null, userApprovalRefs: [] };
  expect(target.bindOpenedRoot(bound(target, "open_convergence_root", input), value.rootId)).toBe(true);
}

function finish(workflow: WorkflowStore, value: ConvergenceRootV1, state: "completed" | "abandoned") {
  const terminal = { ...value, state, revision: value.revision + 1 };
  expect(workflow.updateConvergenceRoot(terminal, value.revision)).toBe(true);
  return terminal;
}

function loadInput(candidate: ContinuityCandidateV1) {
  expect(candidate.restoreToken).toEqual(expect.any(String));
  return { schemaVersion: "1.0.0" as const, candidateToken: candidate.restoreToken!, epoch: candidate.summary!.epoch,
    revision: candidate.summary!.revision, digest: candidate.summary!.snapshotDigest };
}

async function twoConnections() {
  const directory = await mkdtemp(join(tmpdir(), "d0344-rotation-"));
  directories.push(directory);
  const workflow = new InMemoryWorkflowStore();
  const path = join(directory, "continuity.sqlite3");
  return { workflow, first: service(workflow, path), second: service(workflow, path) };
}

async function sharedFixture() {
  const directory = await mkdtemp(join(tmpdir(), "d0344-shared-service-"));
  directories.push(directory);
  const bundle = createInactiveSharedStores({ directory, mode: "fixture-only", clock: () => Date.parse(now),
    syntheticKeys: { workflow: Buffer.alloc(32, 1).toString("base64url"), continuity: Buffer.alloc(32, 2).toString("base64url"), trust: Buffer.alloc(32, 3).toString("base64url") } });
  owners.add(bundle.owner);
  return { ...bundle, target: new ContinuityService(bundle.continuity, new ContractValidator(), bundle.workflow, () => new Date(now)) };
}

async function sqliteFixture() {
  const directory = await mkdtemp(join(tmpdir(), "d0344-sqlite-failure-"));
  directories.push(directory);
  const workflow = new SqliteWorkflowStore(join(directory, "workflow.sqlite3"));
  stores.add(workflow);
  const continuityPath = join(directory, "continuity.sqlite3"), target = service(workflow, continuityPath);
  return { target, workflow, continuityPath };
}

function startSqliteAttempt(workflow: SqliteWorkflowStore, value: ConvergenceRootV1, leaseId: string) {
  const receipt: WorkflowReceiptV1 = { schemaVersion: "1.0.0", runId: `${leaseId}-run`, revision: 1, state: "running",
    plan: { schemaVersion: "1.0.0", taskId: value.taskEnvelope.taskId, integrityToken: "synthetic-plan", executionMode: "orchestrated",
      state: "running", selectedSkills: [], stages: [], currentStageId: null, nextStageId: null, errors: [] },
    stageResults: [], blockers: [], unresolved: [], error: null };
  const proposal: AttemptProposalV1 = { schemaVersion: "1.0.0", rootId: value.rootId, expectedRevision: value.revision,
    taskEnvelope: value.taskEnvelope, frame: value.frame, plan: receipt.plan, actorId: "synthetic-actor", outputTargets: [], priorFailure: null };
  const claimed = { ...value, revision: value.revision + 1 };
  const lease: AttemptLeaseV1 = { ...consumedLease(value), leaseId, state: "issued", epoch: value.currentEpoch,
    rootRevision: claimed.revision, proposalDigest: convergenceDigest(proposal), expiresAt: "9999-01-01T00:00:00.000Z" };
  expect(workflow.insertAttemptLease(claimed, value.revision, proposal, lease)).toBe(true);
  const started = workflow.insertGuardedRun(receipt, lease.leaseId, claimed.revision, now);
  expect(started).not.toBeNull();
  return { receipt, lease: started!.lease, root: started!.root };
}

function settleSqliteAttempt(workflow: SqliteWorkflowStore, attempt: ReturnType<typeof startSqliteAttempt>, current: ConvergenceRootV1) {
  const settledRoot = { ...current, revision: current.revision + 1, state: "completed" as const };
  const receipt = { ...attempt.receipt, revision: attempt.receipt.revision + 1, state: "passed" as const,
    plan: { ...attempt.receipt.plan, state: "passed" as const } };
  const finished = { ...outcome(attempt.lease), outcomeId: `${attempt.lease.leaseId}-outcome`, workflowRunId: receipt.runId, rootRevision: settledRoot.revision };
  expect(workflow.updateRun(receipt, attempt.receipt.revision, { root: settledRoot, expectedRootRevision: current.revision, outcome: finished })).toBe(true);
  return { root: settledRoot, receipt, outcome: finished };
}

describe("D0344 terminal workflow to fresh direct task", () => {
  for (const state of ["completed", "abandoned"] as const) {
    it.each(["lifecycle", "tool-binding"] as const)(`${state}: %s starts E+1 without restoring or deleting history`, entry => {
      const workflow = new InMemoryWorkflowStore(), value = root();
      expect(workflow.insertConvergenceRoot(value)).toBeNull();
      const target = service(workflow);
      const oldRequest = bound(target, "checkpoint_context", checkpoint());
      const historical = target.checkpointContext(oldRequest).data!;
      const oldDirectLoad = loadInput(target.candidateForSession(session));
      const oldLoadRequest = bound(target, "load_context", oldDirectLoad);
      bindRoot(target, value);
      const oldWorkflowLoad = loadInput(target.candidateForSession(session));
      target.markPreCompact(session);
      expect(target.compactContext(session)).toContain("decision=INJECT");
      const correlation = target.correlateSession(session);
      expect(target.store.setSuppressed(correlation, 1, now)).toBe(true);
      const receipt = target.store.getRequest(correlation, 1, target.hashOpaque("request", "same-request-id"));
      expect(receipt).not.toBeNull();
      const terminal = finish(workflow, value, state);
      const fresh = checkpoint({ core: { ...checkpoint().core, objective: "CURRENT-D0344-TASK" } });
      if (entry === "lifecycle") {
        expect(handleContinuityHook({ hook_event_name: "SessionStart", session_id: session, source: "startup" }, target, host)).toEqual({});
        expect(target.store.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: null });
      }
      const freshRequest = bound(target, "checkpoint_context", fresh);
      expect(target.store.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: null, suppressed: false,
        lastAutoInjectedRevision: null, pendingSource: null, pendingRevision: null, pendingDigest: null,
        pendingRootId: null, pendingConsumed: false });
      expect(target.candidateForSession(session)).toMatchObject({ decision: "REJECT", summary: null, restoreToken: null });
      expect(target.compactContext(session)).toBeNull();
      expect(target.checkpointContext(oldRequest).error?.code).toBe("BINDING_INVALID");
      expect(target.loadContext(oldLoadRequest).error?.code).toBe("BINDING_INVALID");
      for (const oldCandidate of [oldDirectLoad, oldWorkflowLoad]) {
        const rejected = target.loadContext(bound(target, "load_context", oldCandidate));
        expect(rejected.error?.code).toBe("BINDING_INVALID");
        expect(rejected.data).toBeNull();
        expect(JSON.stringify(rejected)).not.toContain(historical.core.objective);
      }
      expect(target.store.getSnapshot(correlation, 1)).toEqual(historical);
      expect(target.store.getRequest(correlation, 1, target.hashOpaque("request", "same-request-id"))).toEqual(receipt);
      expect(target.store.getTombstone(correlation, 1)).toBeNull();
      expect(workflow.getConvergenceSnapshot(value.rootId)?.root).toEqual(terminal);
      const saved = target.checkpointContext(freshRequest);
      expect(saved.data).toMatchObject({ source: "direct", epoch: 2, revision: 1, core: { objective: "CURRENT-D0344-TASK" } });
      expect(target.checkpointContext(bound(target, "checkpoint_context", fresh))).toEqual(saved);
      expect(target.ensureSession(session).currentEpoch).toBe(2);
      expect(target.candidateForSession(session).summary).toMatchObject({ source: "direct", epoch: 2, revision: 1 });
      expect(target.store.getSnapshot(correlation, 1)).toEqual(historical);
    });
  }

  it.each(["open", "needs-review", "needs-user"] as const)("%s remains bound and rejects direct checkpoints", state => {
    const workflow = new InMemoryWorkflowStore(), value = { ...root(), state };
    expect(workflow.insertConvergenceRoot(value)).toBeNull();
    const target = service(workflow);
    bindRoot(target, value);
    const request = bound(target, "checkpoint_context", checkpoint());
    expect(target.checkpointContext(request).error?.code).toBe("SNAPSHOT_CONFLICT");
    expect(target.ensureSession(session)).toMatchObject({ currentEpoch: 1, rootId: value.rootId });
    expect(target.store.getSnapshot(target.correlateSession(session), 1)).toBeNull();
  });

  it.each(["missing", "unavailable", "wrong-root"] as const)("%s authority cannot detach or expose historical direct context", authority => {
    const workflow = new InMemoryWorkflowStore(), value = root();
    const target = service(authority === "unavailable" ? null : workflow);
    const historical = target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).data!;
    bindRoot(target, value);
    if (authority === "wrong-root") {
      expect(workflow.insertConvergenceRoot({ ...value, rootId: "different-root", state: "completed" })).toBeNull();
      const wrong = workflow.getConvergenceSnapshot("different-root")!;
      vi.spyOn(workflow, "getConvergenceSnapshot").mockReturnValue(wrong);
    }
    expect(target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).error?.code).toBe("SNAPSHOT_CONFLICT");
    expect(target.store.getTask(target.correlateSession(session))).toMatchObject({ currentEpoch: 1, rootId: value.rootId });
    expect(target.store.getSnapshot(target.correlateSession(session), 1)).toEqual(historical);
    const candidate = target.candidateForSession(session);
    expect(candidate.summary?.source).not.toBe("direct");
    expect(JSON.stringify(candidate)).not.toContain(historical.core.objective);
    if (authority !== "wrong-root") expect(candidate).toMatchObject({ decision: "REJECT", summary: null, restoreToken: null });
  });

  it("a failing authority read leaves the binding and historical data untouched", () => {
    const workflow = new InMemoryWorkflowStore(), target = service(workflow), value = root();
    const historical = target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).data!;
    bindRoot(target, value);
    const before = target.store.getTask(target.correlateSession(session));
    vi.spyOn(workflow, "getConvergenceSnapshot").mockImplementation(() => { throw new Error("synthetic-authority-unavailable"); });
    expect(() => target.issueToolBinding(session, "checkpoint_context", checkpoint())).toThrow();
    expect(target.store.getTask(target.correlateSession(session))).toEqual(before);
    expect(target.store.getSnapshot(target.correlateSession(session), 1)).toEqual(historical);
  });
});

function consumedLease(value: ConvergenceRootV1): AttemptLeaseV1 {
  return { schemaVersion: "1.0.0", leaseId: "older-consumed-lease", rootId: value.rootId, rootRevision: 1, epoch: 1,
    ordinal: 1, proposalDigest: value.taskDigest, taskDigest: value.taskDigest, frameDigest: value.frameDigest,
    workspaceDigest: value.workspaceDigest, controlDigest: value.controlDigest, targetDigest: value.targetDigest,
    operationalDigest: value.operationalDigest, outputTargetsDigest: convergenceDigest([]), planIntegrityToken: "synthetic-plan",
    actorId: "synthetic-actor", outputTargets: [], issuedAt: now, expiresAt: "2026-10-28T00:05:00.000Z", state: "consumed" };
}

function outcome(lease: AttemptLeaseV1): AttemptOutcomeV1 {
  return { schemaVersion: "1.0.0", outcomeId: "older-outcome", rootId: lease.rootId, rootRevision: 2,
    leaseId: lease.leaseId, epoch: lease.epoch, ordinal: lease.ordinal, workflowRunId: "older-run", state: "passed",
    receiptDigest: null, failureFingerprint: null, evidenceRefs: [], recordedAt: now };
}

describe("D0344 completed root must be quiescent across all workflow epochs", () => {
  it.each(["absent", "root", "lease", "epoch", "ordinal"] as const)("%s outcome does not finish an older consumed lease", mismatch => {
    const workflow = new InMemoryWorkflowStore(), value = root(), target = service(workflow);
    expect(workflow.insertConvergenceRoot(value)).toBeNull();
    bindRoot(target, value);
    const terminal = finish(workflow, value, "completed");
    const snapshot = workflow.getConvergenceSnapshot(value.rootId)!;
    snapshot.root = { ...terminal, currentEpoch: 2 };
    const lease = consumedLease(value), finished = outcome(lease);
    if (mismatch === "root") finished.rootId = "different-root";
    if (mismatch === "lease") finished.leaseId = "different-lease";
    if (mismatch === "epoch") finished.epoch = 2;
    if (mismatch === "ordinal") finished.ordinal = 2;
    snapshot.leases = [lease];
    snapshot.outcomes = mismatch === "absent" ? [] : [finished];
    const read = vi.spyOn(workflow, "getConvergenceSnapshot").mockReturnValue(snapshot);
    expect(target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).error?.code).toBe("SNAPSHOT_CONFLICT");
    expect(target.store.getTask(target.correlateSession(session))).toMatchObject({ currentEpoch: 1, rootId: value.rootId });
    snapshot.outcomes = [outcome(lease)];
    read.mockReturnValue(snapshot);
    expect(target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).data).toMatchObject({ epoch: 2, revision: 1 });
  });

  it("abandonment permits a fresh direct task even with an older consumed lease", () => {
    const workflow = new InMemoryWorkflowStore(), value = root(), target = service(workflow);
    expect(workflow.insertConvergenceRoot(value)).toBeNull();
    bindRoot(target, value);
    finish(workflow, value, "abandoned");
    const snapshot = workflow.getConvergenceSnapshot(value.rootId)!;
    snapshot.leases = [consumedLease(value)];
    vi.spyOn(workflow, "getConvergenceSnapshot").mockReturnValue(snapshot);
    expect(target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).data).toMatchObject({ epoch: 2, revision: 1 });
  });
});

describe("D0344 conditional epoch rotation races", () => {
  it.each(["root", "epoch"] as const)("a second connection changing %s before rotation is preserved on retries", async change => {
    const { first, second, workflow } = await twoConnections(), value = root();
    expect(workflow.insertConvergenceRoot(value)).toBeNull();
    bindRoot(first, value);
    finish(workflow, value, "completed");
    const correlation = first.correlateSession(session), rotate = first.store.rotateEpoch.bind(first.store);
    vi.spyOn(first.store, "rotateEpoch").mockImplementationOnce((...args) => {
      if (change === "epoch") second.clearSession(session);
      expect(second.store.bindRoot(correlation, change === "epoch" ? 2 : 1, "new-active-root", now)).toBe(true);
      return rotate(...args);
    });
    const expected = { currentEpoch: change === "epoch" ? 2 : 1, rootId: "new-active-root" };
    expect(first.ensureSession(session)).toMatchObject(expected);
    expect(first.ensureSession(session)).toMatchObject(expected);
    expect(first.checkpointContext(bound(first, "checkpoint_context", checkpoint())).error?.code).toBe("SNAPSHOT_CONFLICT");
    expect(second.store.getTask(correlation)).toMatchObject(expected);
  });

  it("two connections observing the same terminal binding rotate only once", async () => {
    const { first, second, workflow } = await twoConnections(), value = root();
    expect(workflow.insertConvergenceRoot(value)).toBeNull();
    bindRoot(first, value);
    finish(workflow, value, "completed");
    const rotate = first.store.rotateEpoch.bind(first.store);
    vi.spyOn(first.store, "rotateEpoch").mockImplementationOnce((...args) => {
      expect(second.ensureSession(session)).toMatchObject({ currentEpoch: 2, rootId: null });
      return rotate(...args);
    });
    expect(first.ensureSession(session)).toMatchObject({ currentEpoch: 2, rootId: null });
    expect(second.ensureSession(session).currentEpoch).toBe(2);
    expect(first.ensureSession(session).currentEpoch).toBe(2);
  });

  it("rechecks live root state at transaction entry instead of using a terminal observation cached earlier", () => {
    const workflow = new InMemoryWorkflowStore(), value = root(), target = service(workflow);
    expect(workflow.insertConvergenceRoot(value)).toBeNull();
    bindRoot(target, value);
    const terminal = finish(workflow, value, "completed"), rotate = target.store.rotateEpoch.bind(target.store);
    vi.spyOn(target.store, "rotateEpoch").mockImplementationOnce((...args) => {
      expect(workflow.updateConvergenceRoot({ ...terminal, revision: 3, state: "open" }, 2)).toBe(true);
      return rotate(...args);
    });
    expect(target.ensureSession(session)).toMatchObject({ currentEpoch: 1, rootId: value.rootId });
    expect(target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).error?.code).toBe("SNAPSHOT_CONFLICT");
  });

  it.each(["root", "epoch"] as const)("SQL compare-and-swap preserves a %s change made inside a shared predicate", async change => {
    const directory = await mkdtemp(join(tmpdir(), "d0344-shared-cas-"));
    directories.push(directory);
    const bundle = createInactiveSharedStores({ directory, mode: "fixture-only", clock: () => Date.parse(now),
      syntheticKeys: { workflow: Buffer.alloc(32, 1).toString("base64url"), continuity: Buffer.alloc(32, 2).toString("base64url"), trust: Buffer.alloc(32, 3).toString("base64url") } });
    owners.add(bundle.owner);
    const store = bundle.continuity, correlation = "synthetic-d0344-correlation";
    store.ensureTask(correlation, now);
    expect(store.bindRoot(correlation, 1, "terminal-root", now)).toBe(true);
    const predicate = vi.fn(() => {
      if (change === "epoch") store.rotateEpoch(correlation, now);
      expect(store.bindRoot(correlation, change === "epoch" ? 2 : 1, "replacement-root", now)).toBe(true);
      return true;
    });
    const expected = { currentEpoch: change === "epoch" ? 2 : 1, rootId: "replacement-root" };
    expect(store.rotateEpoch(correlation, now, { epoch: 1, rootId: "terminal-root", isTerminal: predicate })).toMatchObject(expected);
    expect(predicate).toHaveBeenCalledTimes(1);
    predicate.mockClear();
    expect(store.rotateEpoch(correlation, now, { epoch: 1, rootId: "terminal-root", isTerminal: predicate })).toMatchObject(expected);
    expect(predicate).not.toHaveBeenCalled();
    // Explicit clear remains unconditional even while the replacement root is active.
    expect(store.rotateEpoch(correlation, now)).toMatchObject({ currentEpoch: expected.currentEpoch + 1, rootId: null });
  });
});

describe("D0344 SQLite service composition and transactional rollback", () => {
  for (const state of ["completed", "abandoned"] as const) {
    it.each(["ensure-session", "tool-binding"] as const)(`${state}: separate SQLite stores allow fresh direct work through %s`, async entry => {
      const directory = await mkdtemp(join(tmpdir(), "d0344-separate-stores-"));
      directories.push(directory);
      const workflow = new SqliteWorkflowStore(join(directory, "workflow.sqlite3"));
      stores.add(workflow);
      const target = service(workflow, join(directory, "continuity.sqlite3")), value = root();
      expect(workflow.insertConvergenceRoot(value)).toBeNull();
      const historical = target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).data!;
      expect(historical).toMatchObject({ epoch: 1, revision: 1 });
      bindRoot(target, value);
      const terminal = finish(workflow, value, state), correlation = target.correlateSession(session);
      const receipt = target.store.getRequest(correlation, 1, target.hashOpaque("request", "same-request-id"));
      expect(receipt).not.toBeNull();
      if (entry === "ensure-session") expect(target.ensureSession(session)).toMatchObject({ currentEpoch: 2, rootId: null });
      const request = bound(target, "checkpoint_context", checkpoint({ core: { ...checkpoint().core, objective: "New SQLite-backed task." } }));
      expect(target.store.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: null });
      expect(target.candidateForSession(session)).toMatchObject({ decision: "REJECT", summary: null, restoreToken: null });
      expect(target.checkpointContext(request).data).toMatchObject({ epoch: 2, revision: 1, core: { objective: "New SQLite-backed task." } });
      expect(target.store.getSnapshot(correlation, 1)).toEqual(historical);
      expect(target.store.getRequest(correlation, 1, target.hashOpaque("request", "same-request-id"))).toEqual(receipt);
      expect(target.store.getTombstone(correlation, 1)).toBeNull();
      expect(workflow.getConvergenceSnapshot(value.rootId)?.root).toEqual(terminal);
      expect(target.ensureSession(session).currentEpoch).toBe(2);
    });

    it(`${state}: shared service reads workflow authority inside rotation and preserves history`, async () => {
      const { target, workflow, continuity } = await sharedFixture(), value = root();
      expect(workflow.insertConvergenceRoot(value)).toBeNull();
      const historical = target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).data!;
      expect(historical).toMatchObject({ epoch: 1, revision: 1 });
      bindRoot(target, value);
      target.markPreCompact(session);
      const correlation = target.correlateSession(session), before = continuity.getTask(correlation)!;
      expect(before).toMatchObject({ currentEpoch: 1, rootId: value.rootId, pendingSource: "workflow" });
      const receipt = continuity.getRequest(correlation, 1, target.hashOpaque("request", "same-request-id"));
      const terminal = finish(workflow, value, state);
      // No authority spy: getConvergenceSnapshot uses the same owner's nested transaction.
      expect(target.ensureSession(session)).toMatchObject({ currentEpoch: 2, rootId: null, pendingSource: null,
        pendingRevision: null, pendingDigest: null, pendingRootId: null, pendingConsumed: false });
      expect(continuity.getSnapshot(correlation, 1)).toEqual(historical);
      expect(continuity.getRequest(correlation, 1, target.hashOpaque("request", "same-request-id"))).toEqual(receipt);
      expect(continuity.getTombstone(correlation, 1)).toBeNull();
      expect(workflow.getConvergenceSnapshot(value.rootId)?.root).toEqual(terminal);
      expect(target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).data).toMatchObject({ epoch: 2, revision: 1 });
      expect(continuity.getSnapshot(correlation, 1)).toEqual(historical);
    });
  }

  it("a throwing shared predicate rolls back nested epoch, root, suppression and marker changes", async () => {
    const { target, workflow, continuity } = await sharedFixture(), value = root();
    expect(workflow.insertConvergenceRoot(value)).toBeNull();
    const historical = target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).data!;
    bindRoot(target, value);
    target.markPreCompact(session);
    const correlation = target.correlateSession(session), pending = continuity.getTask(correlation)!;
    expect(continuity.consumeWorkflowMarker(correlation, 1, value.rootId, pending.pendingRevision!, pending.pendingDigest!, now)).toBe(true);
    expect(continuity.setSuppressed(correlation, 1, now)).toBe(true);
    const before = continuity.getTask(correlation)!;
    expect(before).toMatchObject({ currentEpoch: 1, rootId: value.rootId, suppressed: true, pendingConsumed: true,
      pendingSource: "workflow", pendingRevision: value.revision, lastAutoInjectedRevision: value.revision });
    const requestHash = target.hashOpaque("request", "same-request-id"), receipt = continuity.getRequest(correlation, 1, requestHash);
    let nestedWriteReached = false;
    expect(() => continuity.rotateEpoch(correlation, now, { epoch: 1, rootId: value.rootId, isTerminal: () => {
      expect(continuity.rotateEpoch(correlation, now).currentEpoch).toBe(2);
      expect(continuity.bindRoot(correlation, 2, "rollback-root", now)).toBe(true);
      expect(continuity.setPendingMarker(correlation, 2, "workflow", 99, convergenceDigest("rollback-marker"), "rollback-root", now)).toBe(true);
      expect(continuity.setSuppressed(correlation, 2, now)).toBe(true);
      nestedWriteReached = true;
      throw new Error("synthetic-terminal-predicate-failure");
    } })).toThrow();
    expect(nestedWriteReached).toBe(true);
    expect(continuity.getTask(correlation)).toEqual(before);
    expect(continuity.getSnapshot(correlation, 1)).toEqual(historical);
    expect(continuity.getSnapshot(correlation, 2)).toBeNull();
    expect(continuity.getRequest(correlation, 1, requestHash)).toEqual(receipt);
    // The owner remains usable after the outer rollback.
    expect(target.clearSession(session)).toMatchObject({ currentEpoch: 2, rootId: null, suppressed: false, pendingConsumed: false });
  });
});

describe("D0344 root state remains the authority", () => {
  it("a finished run and matching outcome cannot detach an active root", () => {
    const workflow = new InMemoryWorkflowStore(), value = root(), target = service(workflow);
    expect(workflow.insertConvergenceRoot(value)).toBeNull();
    bindRoot(target, value);
    const lease = consumedLease(value), finished = outcome(lease);
    const receipt: WorkflowReceiptV1 = { schemaVersion: "1.0.0", runId: finished.workflowRunId, revision: 1, state: "passed",
      plan: { schemaVersion: "1.0.0", taskId: value.taskEnvelope.taskId, integrityToken: "synthetic-plan", executionMode: "orchestrated",
        state: "passed", selectedSkills: [], stages: [], currentStageId: null, nextStageId: null, errors: [] },
      stageResults: [], blockers: [], unresolved: [], error: null };
    const claimed = { ...value, revision: 2 };
    expect(workflow.insertAttemptLease(claimed, 1, { schemaVersion: "1.0.0", rootId: value.rootId, expectedRevision: 1,
      taskEnvelope: value.taskEnvelope, frame: value.frame, plan: receipt.plan, actorId: lease.actorId, outputTargets: [], priorFailure: null }, lease)).toBe(true);
    workflow.insertRun(receipt);
    const active = { ...claimed, revision: 3 };
    expect(workflow.updateRun({ ...receipt, revision: 2 }, 1, { root: active, expectedRootRevision: 2, outcome: finished })).toBe(true);
    expect(workflow.getConvergenceSnapshot(value.rootId)).toMatchObject({ root: { state: "open" }, outcomes: [finished] });
    expect(workflow.getRun(finished.workflowRunId)?.state).toBe("passed");
    expect(target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).error?.code).toBe("SNAPSHOT_CONFLICT");
    expect(target.store.getTask(target.correlateSession(session))).toMatchObject({ currentEpoch: 1, rootId: value.rootId });
  });

  it("an unrecognized state in a raw authority snapshot keeps the root bound", () => {
    const workflow = new InMemoryWorkflowStore(), value = root(), target = service(workflow);
    expect(workflow.insertConvergenceRoot(value)).toBeNull();
    bindRoot(target, value);
    const snapshot = workflow.getConvergenceSnapshot(value.rootId)!;
    // The persisted JSON boundary can contain a future state outside the current TypeScript union.
    const rawSnapshot: unknown = { ...snapshot, root: { ...snapshot.root, state: "future-terminal-state" } };
    vi.spyOn(workflow, "getConvergenceSnapshot").mockReturnValue(rawSnapshot as ConvergenceSnapshot);
    expect(target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).error?.code).toBe("SNAPSHOT_CONFLICT");
    expect(target.ensureSession(session)).toMatchObject({ currentEpoch: 1, rootId: value.rootId });
    expect(target.store.getSnapshot(target.correlateSession(session), 1)).toBeNull();
  });
});

describe("D0344 persisted failure, settlement and repeated clear boundaries", () => {
  it("an aborted epoch UPDATE preserves continuity and workflow history, then retries successfully", async () => {
    const { target, workflow, continuityPath } = await sqliteFixture(), value = root();
    expect(workflow.insertConvergenceRoot(value)).toBeNull();
    const historical = target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).data!;
    bindRoot(target, value);
    const attempt = startSqliteAttempt(workflow, value, "update-failure-lease");
    target.markPreCompact(session);
    const correlation = target.correlateSession(session), marker = target.store.getTask(correlation)!;
    expect(target.store.consumeWorkflowMarker(correlation, 1, value.rootId, marker.pendingRevision!, marker.pendingDigest!, now)).toBe(true);
    expect(target.store.setSuppressed(correlation, 1, now)).toBe(true);
    settleSqliteAttempt(workflow, attempt, attempt.root);
    const beforeTask = target.store.getTask(correlation), beforeWorkflow = workflow.getConvergenceSnapshot(value.rootId);
    expect(beforeWorkflow).toMatchObject({ root: { state: "completed" }, leases: [{ state: "consumed" }], outcomes: [{ leaseId: attempt.lease.leaseId }] });
    const requestHash = target.hashOpaque("request", "same-request-id"), beforeRequest = target.store.getRequest(correlation, 1, requestHash);
    const database = new DatabaseSync(continuityPath);
    try {
      database.exec(`CREATE TRIGGER d0344_abort_rotation BEFORE UPDATE OF current_epoch ON continuity_tasks
        WHEN NEW.current_epoch <> OLD.current_epoch BEGIN SELECT RAISE(ABORT, 'd0344-owned-rotation-abort'); END;`);
      let failure: unknown;
      try { target.ensureSession(session); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(ContinuityStoreError);
      expect((failure as ContinuityStoreError).causeValue).toMatchObject({ message: expect.stringContaining("d0344-owned-rotation-abort") });
      expect(target.store.getTask(correlation)).toEqual(beforeTask);
      expect(target.store.getSnapshot(correlation, 1)).toEqual(historical);
      expect(target.store.getSnapshot(correlation, 2)).toBeNull();
      expect(target.store.getRequest(correlation, 1, requestHash)).toEqual(beforeRequest);
      expect(target.store.getTombstone(correlation, 1)).toBeNull();
      expect(workflow.getConvergenceSnapshot(value.rootId)).toEqual(beforeWorkflow);
      database.exec("DROP TRIGGER d0344_abort_rotation");
      expect(target.ensureSession(session)).toMatchObject({ currentEpoch: 2, rootId: null, suppressed: false,
        lastAutoInjectedRevision: null, pendingSource: null, pendingRevision: null, pendingDigest: null, pendingRootId: null, pendingConsumed: false });
      expect(target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).data).toMatchObject({ epoch: 2, revision: 1 });
      expect(target.store.getSnapshot(correlation, 1)).toEqual(historical);
      expect(workflow.getConvergenceSnapshot(value.rootId)).toEqual(beforeWorkflow);
    } finally {
      database.exec("DROP TRIGGER IF EXISTS d0344_abort_rotation");
      database.close();
    }
  });

  it("a settled newer SQLite attempt cannot hide an older consumed lease, and matching settlement permits one rotation", async () => {
    const { target, workflow } = await sqliteFixture(), value = root();
    expect(workflow.insertConvergenceRoot(value)).toBeNull();
    bindRoot(target, value);
    const older = startSqliteAttempt(workflow, value, "older-pending");
    const nextEpoch = { ...older.root, revision: older.root.revision + 1, currentEpoch: 2 };
    expect(workflow.updateConvergenceRoot(nextEpoch, older.root.revision)).toBe(true);
    const newer = startSqliteAttempt(workflow, nextEpoch, "newer-finished");
    const newerSettlement = settleSqliteAttempt(workflow, newer, newer.root);
    const before = workflow.getConvergenceSnapshot(value.rootId)!;
    expect(before).toMatchObject({ root: { state: "completed", currentEpoch: 2 },
      leases: [{ leaseId: older.lease.leaseId, epoch: 1, state: "consumed" }, { leaseId: newer.lease.leaseId, epoch: 2, state: "consumed" }],
      outcomes: [{ leaseId: newer.lease.leaseId, epoch: 2 }] });
    expect(target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).error?.code).toBe("SNAPSHOT_CONFLICT");
    expect(target.store.getTask(target.correlateSession(session))).toMatchObject({ currentEpoch: 1, rootId: value.rootId });
    expect(workflow.getConvergenceSnapshot(value.rootId)).toEqual(before);
    const olderSettlement = settleSqliteAttempt(workflow, older, newerSettlement.root);
    const settledSnapshot = workflow.getConvergenceSnapshot(value.rootId);
    // A fresh receipt revision cannot settle the same guarded attempt twice; the failed write rolls back.
    expect(() => workflow.updateRun({ ...olderSettlement.receipt, revision: 3 }, 2, {
      root: { ...olderSettlement.root, revision: olderSettlement.root.revision + 1 }, expectedRootRevision: olderSettlement.root.revision,
      outcome: olderSettlement.outcome,
    })).toThrow();
    expect(workflow.getRun(older.receipt.runId)).toEqual(olderSettlement.receipt);
    expect(workflow.getConvergenceSnapshot(value.rootId)).toEqual(settledSnapshot);
    expect(target.checkpointContext(bound(target, "checkpoint_context", checkpoint())).data).toMatchObject({ epoch: 2, revision: 1 });
    expect(target.ensureSession(session).currentEpoch).toBe(2);
    expect(workflow.getConvergenceSnapshot(value.rootId)).toEqual(settledSnapshot);
  });

  it("repeated explicit clear resets every marker and keeps request conflicts scoped to the current epoch", async () => {
    const { target, workflow } = await sqliteFixture(), value = root();
    expect(workflow.insertConvergenceRoot(value)).toBeNull();
    const correlation = target.correlateSession(session), requestHash = target.hashOpaque("request", "same-request-id");
    const history = [];
    for (const epoch of [1, 2]) {
      const input = checkpoint({ core: { ...checkpoint().core, objective: `Epoch ${epoch} task.` } });
      const snapshot = target.checkpointContext(bound(target, "checkpoint_context", input)).data!;
      expect(snapshot).toMatchObject({ epoch, revision: 1 });
      const receipt = target.store.getRequest(correlation, epoch, requestHash);
      expect(receipt).not.toBeNull();
      history.push({ epoch, snapshot, receipt });
      bindRoot(target, value);
      target.markPreCompact(session);
      const marker = target.store.getTask(correlation)!;
      expect(target.store.consumeWorkflowMarker(correlation, epoch, value.rootId, marker.pendingRevision!, marker.pendingDigest!, now)).toBe(true);
      expect(target.store.setSuppressed(correlation, epoch, now)).toBe(true);
      expect(target.store.getTask(correlation)).toMatchObject({ suppressed: true, pendingConsumed: true, pendingSource: "workflow",
        pendingRootId: value.rootId, pendingRevision: value.revision, lastAutoInjectedRevision: value.revision });
      expect(target.clearSession(session)).toMatchObject({ currentEpoch: epoch + 1, rootId: null, suppressed: false,
        lastAutoInjectedRevision: null, pendingSource: null, pendingRevision: null, pendingDigest: null, pendingRootId: null, pendingConsumed: false });
      expect(target.candidateForSession(session)).toMatchObject({ decision: "REJECT", summary: null, restoreToken: null });
    }
    const fresh = checkpoint({ core: { ...checkpoint().core, objective: "Epoch 3 task." } });
    const saved = target.checkpointContext(bound(target, "checkpoint_context", fresh));
    expect(saved.data).toMatchObject({ epoch: 3, revision: 1 });
    expect(target.checkpointContext(bound(target, "checkpoint_context", fresh))).toEqual(saved);
    const conflicting = { ...fresh, core: { ...fresh.core, objective: "Different payload for the current request." } };
    expect(target.checkpointContext(bound(target, "checkpoint_context", conflicting)).error?.code).toBe("REQUEST_CONFLICT");
    expect(target.store.getSnapshot(correlation, 3)).toEqual(saved.data);
    for (const old of history) {
      expect(target.store.getSnapshot(correlation, old.epoch)).toEqual(old.snapshot);
      expect(target.store.getRequest(correlation, old.epoch, requestHash)).toEqual(old.receipt);
      expect(target.store.getTombstone(correlation, old.epoch)).toBeNull();
    }
    expect(workflow.getConvergenceSnapshot(value.rootId)?.root).toEqual(value);
  });
});
