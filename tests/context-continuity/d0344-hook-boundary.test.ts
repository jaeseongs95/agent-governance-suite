import { mkdtempSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResultV1, CheckpointContextRequestV1, ContinuitySnapshotV1, SkillDescriptorV2, StageResultV1, TaskEnvelopeV1, WorkflowPlanV1, WorkflowReceiptV1 } from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { runContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { runGovernanceHook } from "../../mcp-server/src/governance-hook.js";
import { claudeAdmissionIngress } from "../../mcp-server/src/builtin-caller-ingress.js";
import { HostAttestationProvider, hostActorId, type HostExecutionAdapter } from "../../mcp-server/src/host-attestation.js";
import { adaptHostInput, isGovernanceHookTool, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { rootCaller } from "../helpers/caller.js";

// D0344 production-wiring regression: the hook opens its own stores from env and leaves AGS calls unchanged; a
// separately constructed MCP-equivalent service computes the continuity scope from the verified caller at call time.
// Only host actor observations are synthetic. Planning, attempts, stage recording,
// finalization/abort, SQLite and runContinuityHook composition remain real.
// Product/DB execution is delegated to the designated tester; local status NOT_RUN.
const rootHost = "synthetic-d0344-hook-root", childHost = "synthetic-d0344-hook-child";
for (const [host, role] of [[rootHost, "root"], [childHost, "child"]] as const) {
  registerHookHostAdapter(host, {
    processPid: () => undefined,
    deliveryProfile: () => ({ transport: "claude-inbox", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false }),
    ownsTool: name => isGovernanceHookTool("codex", name),
    adaptInput: (payload, hostId) => {
      const adapted = adaptHostInput(payload, "codex");
      return { ...adapted, observation: { ...adapted.observation, host: hostId,
        actor: { role, basis: "observed", reasonCode: "D0344_OWNED_ACTOR_OBSERVATION" } } };
    },
  });
}
const session = "d0344-real-hook-session";
/** The host-observed root caller the server admits for this session. */
const asRoot = () => rootCaller(rootHost, session);
const directories: string[] = [];
const stores = new Set<SqliteContinuityStore | SqliteWorkflowStore>();
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const descriptor: SkillDescriptorV2 = { schemaVersion: "2.0.0", skillId: "d0344-fixture", version: "1.0.0",
  path: "./d0344-fixture", priority: 10, enabled: true, providers: [{
    capabilities: ["fixture-work"], executionClass: "workflow", phase: "execution", phaseOrder: 50,
    requiredInputArtifacts: [], inputBindings: [], producedArtifacts: [],
    outputSchema: "contracts/freeform-output.v1.schema.json", resultSchema: "contracts/provider-result.v1.schema.json",
    stateMapping: { default: { state: "passed", errorRequired: false }, adapterErrors: ["MISSING_EVIDENCE"] },
    selectionCriteria: ["fixture"], preconditions: [], failureHandling: "Return a structured result.",
    gate: { kind: "none", policy: "none", validator: null },
  }] };

// Also a plain tools/call argument record.
/** Private history oracle for this owned SQLite fixture; no agent-facing history API is used. */
function memoryAt(store: SqliteContinuityStore, correlation: string, epoch: number): ContinuitySnapshotV1 | null {
  const current = store.getCurrent(correlation, epoch);
  if (current) return current.memory ? current : null;
  const database = Reflect.get(store, "database") as DatabaseSync;
  const row = database.prepare(`SELECT state_token,memory_json,memory_digest,created_at,updated_at
    FROM continuity_memory_history WHERE task_correlation=? AND epoch=? AND format='memory-v1'
    ORDER BY rowid DESC LIMIT 1`).get(correlation, epoch) as {
      state_token: string; memory_json: string; memory_digest: ContinuitySnapshotV1["memoryDigest"];
      created_at: string; updated_at: string;
    } | undefined;
  return row ? { schemaVersion: "1.0.0", source: "direct", taskCorrelation: correlation, epoch,
    stateToken: row.state_token, memory: JSON.parse(row.memory_json), memoryDigest: row.memory_digest,
    createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function checkpoint(objective = "New task after the completed workflow.", overrides: Partial<CheckpointContextRequestV1> = {}): CheckpointContextRequestV1 & Record<string, unknown> {
  return { schemaVersion: "1.0.0", requestId: "d0344-next-task", expectedStateToken: "unissued-state-token", status: "active",
    core: { objective, completionCriteria: ["Checkpoint succeeds."], constraints: [], decisions: [], progress: [], blockers: [], nextActions: [] },
    evidenceRefs: [], ...overrides };
}

/**
 * Behavior 4 (d7585d74): when every bound workflow settles, E's session record moves to E+1 with the same body, so
 * the next save in E+1 continues from the historical memory.
 */
function afterCarry(): CheckpointContextRequestV1 & Record<string, unknown> {
  return checkpoint();
}

/** Behavior 1 (d7585d74): a save while a root is still bound writes the session record in that epoch. */
function whileBound(): CheckpointContextRequestV1 & Record<string, unknown> {
  return checkpoint("Session record while the workflow is bound.", { requestId: "d0344-while-bound" });
}

/** Rotation retains the body and digest and replaces the state token. */
function expectCarried(fixture: Awaited<ReturnType<typeof harness>>, correlation: string, epoch = 2) {
  const carried = fixture.continuity.getCurrent(correlation, epoch);
  expect(carried).toMatchObject({ ...fixture.historical, epoch, stateToken: expect.any(String), updatedAt: expect.any(String) });
  expect(carried!.stateToken).not.toBe(fixture.historical.stateToken);
  expect(carried!.memoryDigest).toBe(fixture.historical.memoryDigest);
}

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "d0344-hook-boundary-"));
  directories.push(directory);
  await mkdir(join(directory, "skills"));
  await mkdir(join(directory, "contracts"));
  for (const schema of ["freeform-output.v1.schema.json", "provider-result.v1.schema.json"]) {
    await copyFile(new URL(`../../contracts/${schema}`, import.meta.url), join(directory, "contracts", schema));
  }
  const registryPath = join(directory, "skills", "registry.json");
  await writeFile(registryPath, JSON.stringify({ schemaVersion: "2.0.0", skills: [descriptor] }), "utf8");
  const env = { AGENT_GOVERNANCE_DB_PATH: join(directory, "workflows.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: join(directory, "continuity.sqlite3"),
    // AGS3-D-0076: the shared state (context layers, board) stays in the fixture, never the tester's home.
    AGENT_GOVERNANCE_SHARED_STATE_DIR: join(directory, "shared") };
  const workflow = new SqliteWorkflowStore(env.AGENT_GOVERNANCE_DB_PATH);
  const continuity = new SqliteContinuityStore(env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
  stores.add(workflow); stores.add(continuity);
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, workflow);
  const initialContinuity = new ContinuityService(continuity, validator, workflow);
  const initial = initialContinuity.loadContext({ schemaVersion: "1.0.0" }, asRoot());
  if (initial.data?.source !== "direct") throw new Error("Expected own current memory.");
  const initialToken = initial.data.stateToken;
  const historical = initialContinuity.checkpointContext(checkpoint("Historical direct payload must remain historical.", { expectedStateToken: initialToken }), asRoot()).data!;
  expect(historical).toMatchObject({ epoch: 1, stateToken: expect.any(String) });
  const task: TaskEnvelopeV1 = { schemaVersion: "1.0.0", taskId: "d0344-hook-workflow", objective: "Complete a real guarded fixture workflow.",
    scope: { included: ["candidate.txt"], excluded: [] }, acceptanceCriteria: ["The fixture stage passes."], riskLevel: "low",
    workUnits: [{ id: "work", objective: "Use fixture data.", dependencies: [], writeTargets: ["candidate.txt"] }],
    requiredCapabilities: ["fixture-work"], constraints: [], authorization: { allowedActions: ["test"], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true } };
  const openInput = { schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: task, userApprovalRefs: [], frame: {
    schemaVersion: "1.0.0", workspace: { workspaceId: "d0344-hook-workspace", locator: directory },
    controlArtifacts: [{ artifactId: "contract", role: "validator", locator: "fixture:contract", digest: convergenceDigest("contract") }],
    targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: "candidate.txt", digest: convergenceDigest("candidate") }],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 } } };
  const opened = service.openConvergenceRoot(openInput);
  expect(opened.error).toBeNull();
  const root = opened.data!;
  expect(initialContinuity.bindOpenedRoot(asRoot(), root.rootId)).toBe(true);
  return { directory, registryPath, env, workflow, continuity, service, initialContinuity, historical, root, task };
}

function claim(fixture: Awaited<ReturnType<typeof harness>>) {
  const planned = fixture.service.planWorkflow(fixture.task);
  expect(planned.error).toBeNull();
  const plan = planned.data!;
  expect(plan.stages).toHaveLength(1);
  const claimed = fixture.service.claimWorkflowAttempt({ schemaVersion: "1.0.0", rootId: fixture.root.rootId,
    expectedRevision: fixture.root.revision, taskEnvelope: fixture.task, frame: fixture.root.frame,
    plan, outputTargets: ["candidate.txt"], priorFailure: null });
  expect(claimed.error).toBeNull();
  const lease = claimed.data!;
  return { lease, plan };
}

function start(fixture: Awaited<ReturnType<typeof harness>>) {
  const { lease, plan } = claim(fixture);
  const started = fixture.service.startGuardedWorkflow({ schemaVersion: "1.0.0", leaseId: lease.leaseId,
    expectedRootRevision: lease.rootRevision, plan });
  expect(started.error).toBeNull();
  return { lease, receipt: started.data! };
}

/** A retry must cite a readable local file whose bytes are new to the root. */
function retryEvidence(label: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "ags-d0344-retry-")), "evidence.txt");
  writeFileSync(file, label);
  return file;
}

function retry(fixture: Awaited<ReturnType<typeof harness>>, service = fixture.service, suppliedPlan?: WorkflowPlanV1) {
  const snapshot = fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)!;
  const planned = suppliedPlan ? null : service.planWorkflow(fixture.task);
  if (planned) expect(planned.error).toBeNull();
  const plan = suppliedPlan ?? planned!.data!;
  const latest = snapshot.outcomes.at(-1)!;
  expect(latest.failureFingerprint).not.toBeNull();
  const claimed = service.claimWorkflowAttempt({ schemaVersion: "1.0.0", rootId: snapshot.root.rootId,
    expectedRevision: snapshot.root.revision, taskEnvelope: fixture.task, frame: snapshot.root.frame, plan,
    outputTargets: ["candidate.txt"],
    priorFailure: { fingerprint: latest.failureFingerprint, hypothesis: "The previous attempt was intentionally stopped.",
      changeSummary: "Start a new guarded fixture attempt.", discriminator: "Check the new run lifecycle.",
      evidenceRefs: [retryEvidence(`fixture:retry-${snapshot.root.revision}`)] } });
  expect(claimed.error).toBeNull();
  return { schemaVersion: "1.0.0", leaseId: claimed.data!.leaseId, expectedRootRevision: claimed.data!.rootRevision, plan };
}

function workflowRows(fixture: Awaited<ReturnType<typeof harness>>) {
  const database = new DatabaseSync(fixture.env.AGENT_GOVERNANCE_DB_PATH);
  try {
    return { runs: database.prepare("SELECT run_id, revision, state FROM workflow_runs ORDER BY run_id").all(),
      links: database.prepare("SELECT run_id, root_id, lease_id FROM workflow_attempt_links ORDER BY run_id").all(),
      attempts: database.prepare("SELECT run_id, lease_id, state FROM convergence_attempts ORDER BY run_id").all(),
      sequence: database.prepare("SELECT value FROM workflow_metadata WHERE key = 'run-sequence'").get() };
  } finally { database.close(); }
}

function trustedPlan(fixture: Awaited<ReturnType<typeof harness>>) {
  const model = "owned-fixture-model";
  const adapter: HostExecutionAdapter = { host: rootHost, provider: "owned-fixture-provider",
    modelClassForModel: candidate => candidate === model ? "general" : null, policyRevision: "owned-fixture-r1",
    // D0089: a class callback alone is not a capability source, so this fixture states its trusted descriptor.
    resolveModel: (rawModel, provenance = `${rootHost}:runtime`) => rawModel === model ? { host: rootHost, provider: "owned-fixture-provider", rawModel,
      resolvedModel: rawModel, modelClass: "general", minimumReasoningEffort: null, supportedEfforts: ["high"], aliasUsed: false,
      policyRevision: "owned-fixture-r1", provenance } : null };
  const provider = new HostAttestationProvider(adapter), validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(fixture.registryPath, validator), validator, fixture.workflow, null, provider);
  const input = { schemaVersion: "1.0.0", taskEnvelope: fixture.task };
  // The verified caller of one host call, with the execution the host observed for it.
  const caller = rootCaller(rootHost, session, { callId: "owned-start-plan",
    execution: { model, effort: "high", turnId: "owned-start-turn", provenance: `${rootHost}:runtime` } });
  const planned = provider.run("plan_workflow", caller, () => service.planWorkflow(input, true));
  expect(planned.error).toBeNull();
  expect(planned.data?.bootstrapExecution?.context).toMatchObject({ actorId: hostActorId(rootHost, session), source: "runtime" });
  return { service, plan: planned.data! };
}

function finalize(fixture: Awaited<ReturnType<typeof harness>>, receipt: WorkflowReceiptV1) {
  const result: StageResultV1 = { schemaVersion: "1.0.0", runId: receipt.runId, expectedRevision: receipt.revision,
    stageId: receipt.plan.stages[0]!.stageId, state: "passed",
    output: { schemaVersion: "1.0.0", kind: "output", output: {}, artifacts: [], error: null },
    evidence: [{ artifactId: "fixture-result", kind: "test", locator: "fixture:observed-pass", verified: true, note: "Synthetic fixture stage passed." }],
    findings: [], blockers: [], error: null };
  const recorded = fixture.service.recordStageResult(result);
  expect(recorded.error).toBeNull();
  const finalized = fixture.service.finalizeWorkflow(receipt.runId, recorded.data!.revision);
  expect(finalized.error).toBeNull();
  expect(finalized.data?.state).toBe("passed");
  return fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)!;
}

function finalizeWithGatedRoot(fixture: Awaited<ReturnType<typeof harness>>, receipt: WorkflowReceiptV1, state: "open" | "needs-review") {
  const current = fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)!.root;
  const plan = fixture.service.planWorkflow(fixture.task);
  expect(plan.error).toBeNull();
  const rejected = fixture.service.claimWorkflowAttempt({ schemaVersion: "1.0.0", rootId: current.rootId,
    expectedRevision: current.revision, taskEnvelope: fixture.task,
    frame: { ...current.frame, controlArtifacts: current.frame.controlArtifacts.map(artifact => ({ ...artifact, digest: convergenceDigest("changed-control") })) },
    plan: plan.data!, outputTargets: ["candidate.txt"], priorFailure: null });
  expect(rejected.error?.code).toBe("FRAME_REVIEW_REQUIRED");
  expect(fixture.workflow.getConvergenceSnapshot(current.rootId)?.root.state).toBe("needs-review");
  const finalized = finalize(fixture, receipt);
  expect(finalized.root.state).toBe("needs-review");
  if (state === "open") {
    const review = { schemaVersion: "1.0.0", reviewId: "d0344-fresh-frame-review", rootId: current.rootId,
      rootRevision: finalized.root.revision, epoch: finalized.root.currentEpoch, reviewerActorId: "fixture-reviewer",
      freshContext: { confirmed: true, evidenceRef: "fixture:fresh-review" },
      classification: "semantics-preserving", comparability: { comparable: true, rationale: "The task and fixed control remain comparable." },
      route: "resume-new-epoch", proposedFrame: { ...finalized.root.frame,
        targetArtifacts: finalized.root.frame.targetArtifacts.map(artifact => ({ ...artifact, digest: convergenceDigest("corrected-target") })) },
      evidenceRefs: ["fixture:fresh-review"], userApprovalRefs: [], reviewedAt: new Date().toISOString() };
    const resolved = fixture.service.resolveConvergenceGate({ schemaVersion: "1.0.0", rootId: current.rootId,
      expectedRevision: finalized.root.revision, review });
    expect(resolved.error).toBeNull();
    expect(resolved.data?.root).toMatchObject({ state: "open", currentEpoch: 2 });
  }
  return fixture.workflow.getConvergenceSnapshot(current.rootId)!;
}

function beforeTool(fixture: Awaited<ReturnType<typeof harness>>, host = rootHost, extra: Record<string, unknown> = {}) {
  return runContinuityHook(JSON.stringify({ hook_event_name: "PreToolUse", session_id: session,
    tool_name: "mcp__agent-governance-suite__checkpoint_context", tool_input: checkpoint(), ...extra }), fixture.env, host);
}

/** The before-tool hook neither rewrites an AGS call nor changes its task: no output, task row unchanged. */
function hookLeavesCall(fixture: Awaited<ReturnType<typeof harness>>, host = rootHost) {
  const correlation = fixture.initialContinuity.correlateSession(session);
  const before = fixture.continuity.getTask(correlation);
  expect(beforeTool(fixture, host)).toBe("");
  expect(fixture.continuity.getTask(correlation)).toEqual(before);
}

function consumeInFreshService(fixture: Awaited<ReturnType<typeof harness>>, input: CheckpointContextRequestV1 = checkpoint()) {
  const workflow = new SqliteWorkflowStore(fixture.env.AGENT_GOVERNANCE_DB_PATH);
  const continuity = new SqliteContinuityStore(fixture.env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
  stores.add(workflow); stores.add(continuity);
  // A fresh service with no prior ensureSession: the server computes the scope from the verified caller alone.
  const service = new ContinuityService(continuity, new ContractValidator(), workflow);
  const current = service.loadContext({ schemaVersion: "1.0.0" }, asRoot());
  expect(current.error).toBeNull();
  return service.checkpointContext({ ...input, expectedStateToken: current.data?.source === "direct" ? current.data.stateToken : "unissued-state-token" }, asRoot());
}

/** The real before-tool hook runs first and changes nothing; then the fresh service handles the call. */
function checkpointAfterHook(fixture: Awaited<ReturnType<typeof harness>>, input: CheckpointContextRequestV1 = checkpoint()) {
  hookLeavesCall(fixture);
  return consumeInFreshService(fixture, input);
}

describe("D0344 runContinuityHook to checkpointContext production boundary", () => {
  it("a real finalized workflow permits a direct checkpoint on the carried record the server binds from the caller, not the hook (behavior 4)", async () => {
    const fixture = await harness(), attempt = start(fixture);
    const completed = finalize(fixture, attempt.receipt);
    expect(completed).toMatchObject({ root: { state: "completed" }, leases: [{ leaseId: attempt.lease.leaseId, state: "consumed" }],
      outcomes: [{ leaseId: attempt.lease.leaseId, state: "passed" }] });
    const correlation = fixture.initialContinuity.correlateSession(session);
    expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 1, rootId: fixture.root.rootId });
    hookLeavesCall(fixture);
    expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 1, rootId: fixture.root.rootId });
    const saved = consumeInFreshService(fixture, afterCarry());
    expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: null });
    expect(saved.error).toBeNull();
    expect(saved.data).toMatchObject({ source: "direct", epoch: 2, stateToken: expect.any(String), memory: { core: { objective: checkpoint().core.objective } } });
    expect(memoryAt(fixture.continuity, correlation, 1)).toEqual(fixture.historical);
    expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(completed);
  });

  it.each(["startup", "post-compact"] as const)("%s opens real workflow authority before ensuring a terminal-bound session and carries its record (behavior 4)", async entry => {
    const fixture = await harness(), attempt = start(fixture);
    const completed = finalize(fixture, attempt.receipt), correlation = fixture.initialContinuity.correlateSession(session);
    const event = entry === "startup" ? { hook_event_name: "SessionStart", source: "startup" }
      : { hook_event_name: "PostCompact", turn_id: "fixture-turn", error: null };
    expect(runContinuityHook(JSON.stringify({ ...event, session_id: session }), fixture.env, rootHost)).toBe("");
    expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: null });
    expectCarried(fixture, correlation);
    expect(checkpointAfterHook(fixture, afterCarry()).data).toMatchObject({ epoch: 2, stateToken: expect.any(String) });
    expect(memoryAt(fixture.continuity, correlation, 1)).toEqual(fixture.historical);
    expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(completed);
  });

  it("abortWorkflow settles an attempt and permits a direct checkpoint on the carried record while its root remains open (behavior 4)", async () => {
    const fixture = await harness(), attempt = start(fixture);
    const aborted = fixture.service.abortWorkflow(attempt.receipt.runId, attempt.receipt.revision);
    expect(aborted.error).toBeNull();
    expect(aborted.data?.state).toBe("blocked");
    const active = fixture.workflow.getConvergenceSnapshot(fixture.root.rootId);
    expect(active).toMatchObject({ root: { state: "open" }, outcomes: [{ leaseId: attempt.lease.leaseId, state: "aborted" }] });
    const saved = checkpointAfterHook(fixture, afterCarry());
    expect(saved.error).toBeNull();
    expect(saved.data).toMatchObject({ source: "direct", epoch: 2, stateToken: expect.any(String) });
    const correlation = fixture.initialContinuity.correlateSession(session);
    expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: null });
    expect(memoryAt(fixture.continuity, correlation, 2)).toEqual(saved.data);
    expect(memoryAt(fixture.continuity, correlation, 1)).toEqual(fixture.historical);
    expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(active);
  });

  it.each(["open", "needs-review"] as const)("a publicly finalized run permits direct work on the carried record while the root is %s (behavior 4)", async state => {
    const fixture = await harness(), attempt = start(fixture);
    const settled = finalizeWithGatedRoot(fixture, attempt.receipt, state);
    expect(settled).toMatchObject({ root: { state }, outcomes: [{ state: "passed", leaseId: attempt.lease.leaseId }] });
    const saved = checkpointAfterHook(fixture, afterCarry());
    expect(saved.error).toBeNull();
    expect(saved.data).toMatchObject({ source: "direct", epoch: 2, stateToken: expect.any(String) });
    const correlation = fixture.initialContinuity.correlateSession(session);
    expect(memoryAt(fixture.continuity, correlation, 2)).toEqual(saved.data);
    expect(memoryAt(fixture.continuity, correlation, 1)).toEqual(fixture.historical);
    expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(settled);
  });

  it("a genuinely running guarded attempt stays bound while the session record saves in its epoch (behavior 1)", async () => {
    const fixture = await harness(), attempt = start(fixture);
    const active = fixture.workflow.getConvergenceSnapshot(fixture.root.rootId);
    expect(fixture.workflow.getRun(attempt.receipt.runId)?.state).toBe("running");
    expect(active).toMatchObject({ outcomes: [], leases: [{ state: "consumed", leaseId: attempt.lease.leaseId }] });
    const saved = checkpointAfterHook(fixture, whileBound());
    expect(saved.error).toBeNull();
    expect(saved.data).toMatchObject({ source: "direct", epoch: 1, stateToken: expect.any(String) });
    const correlation = fixture.initialContinuity.correlateSession(session);
    expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 1, rootId: fixture.root.rootId });
    expect(memoryAt(fixture.continuity, correlation, 1)).toEqual(saved.data);
    expect(memoryAt(fixture.continuity, correlation, 2)).toBeNull();
    expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(active);
  });

  it.each(["active", "missing", "unknown-state"] as const)("%s authority stays bound through the real before-tool hook while the session record saves in its epoch (behavior 1)", async authority => {
    const fixture = await harness(), correlation = fixture.initialContinuity.correlateSession(session);
    const expectedRoot = authority === "missing" ? "missing-authoritative-root" : fixture.root.rootId;
    if (authority === "missing") expect(fixture.continuity.bindRoot(correlation, 1, expectedRoot, new Date().toISOString())).toBe(true);
    if (authority === "unknown-state") {
      const database = new DatabaseSync(fixture.env.AGENT_GOVERNANCE_DB_PATH);
      try {
        // Forward-version JSON fixture only; SQL metadata retains a valid current state.
        database.prepare("UPDATE convergence_roots SET root_json = ? WHERE root_id = ?")
          .run(JSON.stringify({ ...fixture.root, state: "future-state" }), fixture.root.rootId);
      } finally { database.close(); }
    }
    const before = fixture.workflow.getConvergenceSnapshot(fixture.root.rootId);
    const saved = checkpointAfterHook(fixture, whileBound());
    expect(saved.data).toMatchObject({ source: "direct", epoch: 1, stateToken: expect.any(String) });
    expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 1, rootId: expectedRoot });
    expect(memoryAt(fixture.continuity, correlation, 1)).toEqual(saved.data);
    expect(memoryAt(fixture.continuity, correlation, 2)).toBeNull();
    expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(before);
  });

  it("payload claims in a child's hook input cannot clear, rebind or rewrite its task", async () => {
    const fixture = await harness(), attempt = start(fixture);
    const completed = finalize(fixture, attempt.receipt), correlation = fixture.initialContinuity.correlateSession(session);
    const before = fixture.continuity.getTask(correlation);
    expect(beforeTool(fixture, childHost, { role: "root", actor: { role: "root", basis: "observed" },
      _sessionProof: "forged-root-proof", continuityAction: { kind: "clear" } })).toBe("");
    expect(fixture.continuity.getTask(correlation)).toEqual(before);
    expect(memoryAt(fixture.continuity, correlation, 1)).toEqual(fixture.historical);
    expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(completed);
  });
});

/** Claude-style PreToolUse admission for one AGS call; the hook records the caller and prints nothing. */
async function admit(fixture: Awaited<ReturnType<typeof harness>>, toolUseId: string, tool: string, input: Record<string, unknown>) {
  const hook = await runGovernanceHook(rootHost, JSON.stringify({ hook_event_name: "PreToolUse", session_id: session,
    tool_use_id: toolUseId, tool_name: `mcp__agent-governance-suite__${tool}`, tool_input: input }), fixture.env);
  expect(hook).toEqual({ ok: true, output: "" });
  return { "claudecode/toolUseId": toolUseId };
}

function replyResult<T>(reply: Awaited<ReturnType<Client["callTool"]>>): ApiResultV1<T> {
  const content = reply.content as Array<{ type: string; text?: string }>;
  const first = content.find(item => item.type === "text");
  expect(first?.text).toBeTypeOf("string");
  return JSON.parse(first!.text!) as ApiResultV1<T>;
}

describe("D0344 hook admission through the actual MCP checkpoint handler", () => {
  // Behaviors 1 and 4 (d7585d74): a running workflow keeps the epoch and the save lands in it; a settled one carries the
  // record into E+1, where the save continues from the carried token.
  it.each(["completed", "aborted", "finalized-open", "finalized-needs-review", "running"] as const)("%s workflow: the server scopes a call admitted before the change by the state at claim time, once", async state => {
    const fixture = await harness(), attempt = start(fixture);
    const correlation = fixture.initialContinuity.correlateSession(session);
    const input = { ...(state === "running" ? whileBound() : afterCarry()), expectedStateToken: fixture.historical.stateToken };
    // Admitted while the guarded run is active; the admission carries no continuity scope that could go stale.
    const early = await admit(fixture, `d0344-early-mcp-checkpoint-${state}`, "checkpoint_context", input);
    if (state === "completed") finalize(fixture, attempt.receipt);
    else if (state === "aborted") {
      const aborted = fixture.service.abortWorkflow(attempt.receipt.runId, attempt.receipt.revision);
      expect(aborted.error).toBeNull();
      expect(aborted.data?.state).toBe("blocked");
    } else if (state === "finalized-open") finalizeWithGatedRoot(fixture, attempt.receipt, "open");
    else if (state === "finalized-needs-review") finalizeWithGatedRoot(fixture, attempt.receipt, "needs-review");
    const beforeWorkflow = fixture.workflow.getConvergenceSnapshot(fixture.root.rootId);
    const expectedRootState = state === "completed" ? "completed" : state === "finalized-needs-review" ? "needs-review" : "open";
    expect(beforeWorkflow).toMatchObject({ root: { state: expectedRootState }, outcomes: state === "running" ? []
      : [{ leaseId: attempt.lease.leaseId, state: state === "aborted" ? "aborted" : "passed" }] });
    // A later admission hook still neither rewrites the call nor detaches the task: the server does that at call time.
    await admit(fixture, `d0344-late-mcp-checkpoint-${state}`, "checkpoint_context", input);
    expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 1, rootId: fixture.root.rootId });

    const workflow = new SqliteWorkflowStore(fixture.env.AGENT_GOVERNANCE_DB_PATH);
    const continuity = new SqliteContinuityStore(fixture.env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
    stores.add(workflow); stores.add(continuity);
    const validator = new ContractValidator();
    const updates = new PluginUpdateService(new InMemoryPluginUpdateStore(), {
      fetcher: async () => { throw new Error("Unexpected network request in the checkpoint transport test."); },
    });
    // The new continuity service is never ensured or rebound manually; the caller comes only from the claimed row.
    const server = createMcpServer(fixture.service, updates, new ContinuityService(continuity, validator, workflow), undefined,
      undefined, validator, "default", null, null, new SessionMessageService(join(fixture.directory, "unused-messaging")),
      null, null, claudeAdmissionIngress(workflow, rootHost));
    const client = new Client({ name: "d0344-hook-mcp-boundary", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const firstResult = replyResult<ContinuitySnapshotV1>(await client.callTool({ name: "checkpoint_context", arguments: input, _meta: early }));
      let result = firstResult;
      if (state !== "running") {
        expect(firstResult).toMatchObject({ ok: false, data: null, error: { code: "STALE_REVISION",
          details: { reasonCode: "CONTINUITY_STATE_STALE" } } });
        const carried = continuity.getCurrent(correlation, 2)!;
        expect(carried.memory).toEqual(fixture.historical.memory);
        expect(carried.stateToken).not.toBe(input.expectedStateToken);
        expect(continuity.getRequest(correlation, 2, fixture.initialContinuity.hashOpaque("request", input.requestId))).toBeNull();
        const loadMeta = await admit(fixture, `d0344-reload-${state}`, "load_context", { schemaVersion: "1.0.0" });
        const loaded = replyResult<ContinuitySnapshotV1>(await client.callTool({ name: "load_context", arguments: { schemaVersion: "1.0.0" }, _meta: loadMeta }));
        expect(loaded.data).toEqual(carried);
        const refreshed = { ...input, expectedStateToken: loaded.data!.stateToken };
        const freshMeta = await admit(fixture, `d0344-refreshed-${state}`, "checkpoint_context", refreshed);
        result = replyResult<ContinuitySnapshotV1>(await client.callTool({ name: "checkpoint_context", arguments: refreshed, _meta: freshMeta }));
      }
      expect(result.error).toBeNull();
      if (state === "running") {
        expect(result.data).toMatchObject({ source: "direct", epoch: 1, stateToken: expect.any(String), memory: { core: { objective: input.core.objective } } });
        expect(continuity.getTask(correlation)).toMatchObject({ currentEpoch: 1, rootId: fixture.root.rootId });
        expect(memoryAt(continuity, correlation, 1)).toEqual(result.data);
        expect(memoryAt(continuity, correlation, 2)).toBeNull();
      } else {
        expect(result.data).toMatchObject({ source: "direct", epoch: 2, stateToken: expect.any(String), memory: { core: { objective: checkpoint().core.objective } } });
        expect(continuity.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: null });
        expect(memoryAt(continuity, correlation, 2)).toEqual(result.data);
      }
      const afterFirst = continuity.getTask(correlation);
      // One claim per admission row: a replay of the same host call is unobserved and is not presumed to be a root.
      const replay = replyResult<ContinuitySnapshotV1>(await client.callTool({ name: "checkpoint_context", arguments: input, _meta: early }));
      expect(replay).toMatchObject({ ok: false, data: null, error: { code: "BINDING_REQUIRED",
        details: { reasonCode: "CALLER_PROVENANCE_UNAVAILABLE", ingressReason: "CALL_ADMISSION_MISSING" } } });
      expect(continuity.getTask(correlation)).toEqual(afterFirst);
      expect(memoryAt(continuity, correlation, 3)).toBeNull();
      expect(memoryAt(continuity, correlation, 1)).toEqual(state === "running" ? result.data : fixture.historical);
      expect(workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(beforeWorkflow);
    } finally {
      try { await client.close(); } finally { await server.close(); }
    }
  });
});

describe("D0344 guarded start correlates a resumed root before publishing its run", () => {
  it("explicit clear remains an unconditional task boundary while an older guarded run is active", async () => {
    const fixture = await harness(), active = start(fixture);
    const before = fixture.workflow.getConvergenceSnapshot(fixture.root.rootId);
    expect(fixture.initialContinuity.clearSession(session)).toMatchObject({ currentEpoch: 2, rootId: null });
    const saved = checkpointAfterHook(fixture);
    expect(saved.error).toBeNull();
    expect(saved.data).toMatchObject({ epoch: 2, stateToken: expect.any(String) });
    const correlation = fixture.initialContinuity.correlateSession(session);
    expect(memoryAt(fixture.continuity, correlation, 1)).toEqual(fixture.historical);
    expect(fixture.workflow.getRun(active.receipt.runId)?.state).toBe("running");
    expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(before);
  });

  it("real hook admission and MCP start rebind after abort/detach, the record saves while rebound, then a second abort carries it into E3 (behaviors 1, 4)", async () => {
    const fixture = await harness(), first = start(fixture);
    expect(fixture.service.abortWorkflow(first.receipt.runId, first.receipt.revision).error).toBeNull();
    const trusted = trustedPlan(fixture), validator = new ContractValidator();
    const continuity = new SqliteContinuityStore(fixture.env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
    const workflow = new SqliteWorkflowStore(fixture.env.AGENT_GOVERNANCE_DB_PATH);
    stores.add(continuity); stores.add(workflow);
    const server = createMcpServer(trusted.service, new PluginUpdateService(new InMemoryPluginUpdateStore(), {
      fetcher: async () => { throw new Error("Unexpected start lifecycle network request."); },
    }), new ContinuityService(continuity, validator, workflow), undefined, undefined, validator, "default", null, null,
    new SessionMessageService(join(fixture.directory, "unused-start-messaging")), null, null, claudeAdmissionIngress(workflow, rootHost));
    const client = new Client({ name: "d0344-start-rebind", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let call = 0;
    const invoke = async <T,>(name: string, input: Record<string, unknown>): Promise<ApiResultV1<T>> => {
      // The hook records the caller and leaves the arguments as the model wrote them.
      if (name === "checkpoint_context") {
        const loadMeta = await admit(fixture, `d0344-start-load-${++call}`, "load_context", { schemaVersion: "1.0.0" });
        const current = replyResult<ContinuitySnapshotV1>(await client.callTool({ name: "load_context", arguments: { schemaVersion: "1.0.0" }, _meta: loadMeta }));
        expect(current.error).toBeNull();
        input = { ...input, expectedStateToken: current.data?.source === "direct" ? current.data.stateToken : "unissued-state-token" };
      }
      const meta = await admit(fixture, `d0344-start-lifecycle-${++call}`, name, input);
      return replyResult<T>(await client.callTool({ name, arguments: input, _meta: meta }));
    };
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const secondEpoch = await invoke<ContinuitySnapshotV1>("checkpoint_context", afterCarry());
      expect(secondEpoch.error).toBeNull();
      expect(secondEpoch.data).toMatchObject({ epoch: 2, stateToken: expect.any(String) });
      const startInput = retry(fixture, trusted.service, trusted.plan);
      const started = await invoke<WorkflowReceiptV1>("start_guarded_workflow", { ...startInput, skills: [{ skillId: "minimal-implementation", reason: "test" }], responseMode: "full" });
      expect(started.error).toBeNull();
      expect(started.data?.state).toBe("running");
      const correlation = fixture.initialContinuity.correlateSession(session);
      expect(continuity.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: fixture.root.rootId });
      const rebound = await invoke<ContinuitySnapshotV1>("checkpoint_context", whileBound());
      expect(rebound.error).toBeNull();
      expect(rebound.data).toMatchObject({ epoch: 2, stateToken: expect.any(String) });
      expect(continuity.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: fixture.root.rootId });
      expect(trusted.service.abortWorkflow(started.data!.runId, started.data!.revision).error).toBeNull();
      const thirdEpoch = await invoke<ContinuitySnapshotV1>("checkpoint_context", checkpoint());
      expect(thirdEpoch.error).toBeNull();
      expect(thirdEpoch.data).toMatchObject({ epoch: 3, stateToken: expect.any(String) });
      expect(memoryAt(continuity, correlation, 1)).toEqual(fixture.historical);
      expect(memoryAt(continuity, correlation, 2)).toEqual(rebound.data);
      expect(memoryAt(continuity, correlation, 3)).toEqual(thirdEpoch.data);
    } finally { try { await client.close(); } finally { await server.close(); } }
  });

  it.each(["start-first", "detach-first"] as const)("%s preserves the active guard with real SQLite start/correlation commits while the record saves in its epoch (behaviors 1, 4)", async order => {
    const fixture = await harness(), first = start(fixture);
    expect(fixture.service.abortWorkflow(first.receipt.runId, first.receipt.revision).error).toBeNull();
    const startInput = retry(fixture), correlation = fixture.initialContinuity.correlateSession(session);
    if (order === "detach-first") expect(fixture.initialContinuity.ensureSession(session).currentEpoch).toBe(2);
    const started = fixture.service.startGuardedWorkflow(startInput, false,
      rootId => fixture.initialContinuity.prepareWorkflowStart(session, rootId));
    expect(started.error).toBeNull();
    const epoch = order === "detach-first" ? 2 : 1;
    expect(fixture.initialContinuity.ensureSession(session)).toMatchObject({ currentEpoch: epoch, rootId: fixture.root.rootId });
    // detach-first carried the historical memory into E2, so both orders continue from revision 1.
    if (order === "detach-first") expectCarried(fixture, correlation);
    const saved = checkpointAfterHook(fixture, whileBound());
    expect(saved.data).toMatchObject({ epoch, stateToken: expect.any(String) });
    expect(fixture.initialContinuity.ensureSession(session)).toMatchObject({ currentEpoch: epoch, rootId: fixture.root.rootId });
    expect(fixture.workflow.getRun(started.data!.runId)?.state).toBe("running");
    expect(memoryAt(fixture.continuity, correlation, epoch)).toEqual(saved.data);
    expect(memoryAt(fixture.continuity, correlation, 1)).toEqual(order === "start-first" ? saved.data : fixture.historical);
  });

  // A second root bound to the same epoch is not a failure any more (several workflows per session); only the epoch is compared.
  it.each(["continuity-update", "throw", "async", "epoch-cas"] as const)("%s callback failure rolls back run, lease, links and sequence", async failure => {
    const fixture = await harness(), pending = claim(fixture), correlation = fixture.initialContinuity.correlateSession(session);
    fixture.initialContinuity.clearSession(session);
    const beforeTask = fixture.continuity.getTask(correlation), beforeWorkflow = fixture.workflow.getConvergenceSnapshot(fixture.root.rootId);
    const beforeRows = workflowRows(fixture), database = new DatabaseSync(fixture.env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
    let expectedTask = beforeTask, callbackReached = false, correlationFailure: unknown;
    try {
      if (failure === "continuity-update") database.exec(`CREATE TRIGGER d0344_reject_start_binding BEFORE UPDATE OF root_id ON continuity_tasks
        BEGIN SELECT RAISE(ABORT, 'd0344-owned-start-binding-failure'); END;`);
      if (failure === "epoch-cas") {
        const original = fixture.continuity.bindRoot.bind(fixture.continuity);
        vi.spyOn(fixture.continuity, "bindRoot").mockImplementationOnce((...args) => {
          const competing = new SqliteContinuityStore(fixture.env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
          try {
            competing.rotateEpoch(correlation, new Date().toISOString());
            expectedTask = competing.getTask(correlation);
          } finally { competing.close(); }
          return original(...args);
        });
      }
      const started = fixture.service.startGuardedWorkflow({ schemaVersion: "1.0.0", leaseId: pending.lease.leaseId,
        expectedRootRevision: pending.lease.rootRevision, plan: pending.plan }, false,
      failure === "async" ? () => { callbackReached = true; return Promise.resolve(); } : rootId => {
        callbackReached = true;
        if (failure === "throw") throw new Error("d0344-original-callback-cause");
        try { fixture.initialContinuity.prepareWorkflowStart(session, rootId); }
        catch (error) { correlationFailure = error; throw error; }
      });
      expect(callbackReached).toBe(true);
      expect(started.ok).toBe(false);
      if (failure === "continuity-update") expect(correlationFailure).toMatchObject({
        causeValue: { message: expect.stringContaining("d0344-owned-start-binding-failure") },
      });
      if (failure === "async") expect(started.error).toMatchObject({ code: "INVALID_INPUT", message: "Workflow correlation callbacks must be synchronous." });
      // AGS 3.0 error model R2/R5: the callback failure is a server failure with a redacted cause, never its message.
      if (failure === "throw") expect(started.error).toMatchObject({ code: "MCP_UNAVAILABLE", details: { reason: "INTERNAL_FAILURE", cause: { type: "error" } } });
      if (failure === "throw") expect(JSON.stringify(started.error)).not.toContain("d0344-original-callback-cause");
      // A lost epoch race is retryable, so it is STALE_REVISION, never the infrastructure code BINDING_INVALID.
      if (failure === "epoch-cas") expect(started.error?.code).toBe("STALE_REVISION");
      expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(beforeWorkflow);
      expect(workflowRows(fixture)).toEqual(beforeRows);
      expect(fixture.continuity.getTask(correlation)).toEqual(expectedTask);
      expect(memoryAt(fixture.continuity, correlation, 1)).toEqual(fixture.historical);
    } finally { database.exec("DROP TRIGGER IF EXISTS d0344_reject_start_binding"); database.close(); }
  });

  it("a deferred workflow COMMIT failure leaves only conservative continuity binding and no published run", async () => {
    const fixture = await harness(), pending = claim(fixture), correlation = fixture.initialContinuity.correlateSession(session);
    fixture.initialContinuity.clearSession(session);
    const beforeWorkflow = fixture.workflow.getConvergenceSnapshot(fixture.root.rootId), beforeRows = workflowRows(fixture);
    const database = new DatabaseSync(fixture.env.AGENT_GOVERNANCE_DB_PATH);
    try {
      database.exec(`CREATE TABLE d0344_missing_parent(id INTEGER PRIMARY KEY);
        CREATE TABLE d0344_deferred_commit(run_id TEXT, missing_id INTEGER REFERENCES d0344_missing_parent(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER d0344_fail_workflow_commit AFTER INSERT ON workflow_runs BEGIN
          INSERT INTO d0344_deferred_commit(run_id, missing_id) VALUES(NEW.run_id, 1); END;`);
      let callbackCommitted = false;
      const started = fixture.service.startGuardedWorkflow({ schemaVersion: "1.0.0", leaseId: pending.lease.leaseId,
        expectedRootRevision: pending.lease.rootRevision, plan: pending.plan }, false, rootId => {
        fixture.initialContinuity.prepareWorkflowStart(session, rootId);
        callbackCommitted = true;
      });
      expect(callbackCommitted).toBe(true);
      expect(started).toMatchObject({ ok: false, data: null, error: { code: "MCP_UNAVAILABLE" } });
      // AGS 3.0 error model P4: the deferred FOREIGN KEY failure is classified, not copied as SQLite message text.
      expect(started.error?.details).toMatchObject({ reason: "STORE_CONSTRAINT", cause: { sqlite: { primaryCode: 19 } } });
      expect(JSON.stringify(started.error)).not.toMatch(/FOREIGN KEY/iu);
      expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(beforeWorkflow);
      expect(workflowRows(fixture)).toEqual(beforeRows);
      expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: fixture.root.rootId });
      // Behavior 1: the conservative binding does not close the session record; clear carried nothing into E2.
      const bound = checkpointAfterHook(fixture);
      expect(bound.data).toMatchObject({ epoch: 2, stateToken: expect.any(String) });
      expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: fixture.root.rootId });
      expect(memoryAt(fixture.continuity, correlation, 1)).toEqual(fixture.historical);
      expect(memoryAt(fixture.continuity, correlation, 2)).toEqual(bound.data);
      database.exec("DROP TRIGGER d0344_fail_workflow_commit");
      const retried = fixture.service.startGuardedWorkflow({ schemaVersion: "1.0.0", leaseId: pending.lease.leaseId,
        expectedRootRevision: pending.lease.rootRevision, plan: pending.plan }, false,
      rootId => fixture.initialContinuity.prepareWorkflowStart(session, rootId));
      expect(retried.error).toBeNull();
      expect(retried.data?.runId).toBe(`run-${fixture.task.taskId}-1`);
      expect(fixture.workflow.getGuardedRunBinding(retried.data!.runId)?.lease.leaseId).toBe(pending.lease.leaseId);
      expect(fixture.service.abortWorkflow(retried.data!.runId, retried.data!.revision).error).toBeNull();
      // Behavior 4: the abort settles the root, so E2's record moves to E3 and the next save continues it.
      const recovered = checkpointAfterHook(fixture, afterCarry());
      expect(recovered.error).toBeNull();
      expect(recovered.data).toMatchObject({ epoch: 3, stateToken: expect.any(String) });
      expect(memoryAt(fixture.continuity, correlation, 3)).toEqual(recovered.data);
      expect(memoryAt(fixture.continuity, correlation, 1)).toEqual(fixture.historical);
    } finally {
      database.exec("DROP TRIGGER IF EXISTS d0344_fail_workflow_commit; DROP TABLE IF EXISTS d0344_deferred_commit; DROP TABLE IF EXISTS d0344_missing_parent;");
      database.close();
    }
  });
});
