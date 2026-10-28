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
import { HostAttestationProvider, hostActorId, issueHostAttestation, type HostExecutionAdapter } from "../../mcp-server/src/host-attestation.js";
import { adaptHostInput, isGovernanceHookTool, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { SessionActorProofs } from "../../mcp-server/src/session-actor-proof.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";

// D0344 production-wiring regression: the hook opens its own stores from env, then
// its exact updatedInput reaches a separately constructed MCP-equivalent service.
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

function checkpoint(objective = "New task after the completed workflow."): Omit<CheckpointContextRequestV1, "_continuityBinding"> {
  return { schemaVersion: "1.0.0", requestId: "d0344-next-task", expectedRevision: 0, status: "active",
    core: { objective, completionCriteria: ["Checkpoint succeeds."], constraints: [], decisions: [], progress: [], blockers: [], nextActions: [] },
    evidenceRefs: [] };
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
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: join(directory, "continuity.sqlite3") };
  const workflow = new SqliteWorkflowStore(env.AGENT_GOVERNANCE_DB_PATH);
  const continuity = new SqliteContinuityStore(env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
  stores.add(workflow); stores.add(continuity);
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, workflow);
  const initialContinuity = new ContinuityService(continuity, validator, workflow);
  const old = checkpoint("Historical direct payload must remain historical.");
  const historical = initialContinuity.checkpointContext({ ...old,
    _continuityBinding: initialContinuity.issueToolBinding(session, "checkpoint_context", old) }).data!;
  expect(historical).toMatchObject({ epoch: 1, revision: 1 });
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
  expect(initialContinuity.bindOpenedRoot({ ...openInput,
    _continuityBinding: initialContinuity.issueToolBinding(session, "open_convergence_root", openInput) }, root.rootId)).toBe(true);
  return { directory, registryPath, env, workflow, continuity, service, initialContinuity, historical, root, task };
}

function claim(fixture: Awaited<ReturnType<typeof harness>>) {
  const planned = fixture.service.planWorkflow(fixture.task);
  expect(planned.error).toBeNull();
  const plan = planned.data!;
  expect(plan.stages).toHaveLength(1);
  const claimed = fixture.service.claimWorkflowAttempt({ schemaVersion: "1.0.0", rootId: fixture.root.rootId,
    expectedRevision: fixture.root.revision, taskEnvelope: fixture.task, frame: fixture.root.frame,
    plan, actorId: "fixture-implementer", outputTargets: ["candidate.txt"], priorFailure: null });
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

function retry(fixture: Awaited<ReturnType<typeof harness>>, service = fixture.service, suppliedPlan?: WorkflowPlanV1) {
  const snapshot = fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)!;
  const planned = suppliedPlan ? null : service.planWorkflow(fixture.task);
  if (planned) expect(planned.error).toBeNull();
  const plan = suppliedPlan ?? planned!.data!;
  const latest = snapshot.outcomes.at(-1)!;
  expect(latest.failureFingerprint).not.toBeNull();
  const claimed = service.claimWorkflowAttempt({ schemaVersion: "1.0.0", rootId: snapshot.root.rootId,
    expectedRevision: snapshot.root.revision, taskEnvelope: fixture.task, frame: snapshot.root.frame, plan,
    actorId: plan.bootstrapExecution?.context.actorId ?? "fixture-implementer", outputTargets: ["candidate.txt"],
    priorFailure: { fingerprint: latest.failureFingerprint, hypothesis: "The previous attempt was intentionally stopped.",
      changeSummary: "Start a new guarded fixture attempt.", discriminator: "Check the new run lifecycle.",
      evidenceRefs: [`fixture:retry-${snapshot.root.revision}`] } });
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
    modelClassForModel: candidate => candidate === model ? "general" : null };
  const provider = new HostAttestationProvider(fixture.workflow, adapter), validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(fixture.registryPath, validator), validator, fixture.workflow, null, provider);
  const input = { schemaVersion: "1.0.0", taskEnvelope: fixture.task };
  const token = issueHostAttestation(fixture.workflow, adapter, { tool: "plan_workflow", input, model,
    reasoningEffort: "high", actorId: hostActorId(rootHost, session), sessionId: session, turnId: "owned-start-turn", toolUseId: "owned-start-plan" });
  expect(token).toEqual(expect.any(String));
  const planned = provider.run("plan_workflow", { ...input, _hostAttestation: token }, clean => service.planWorkflow(clean, true));
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
    plan: plan.data!, actorId: "fixture-implementer", outputTargets: ["candidate.txt"], priorFailure: null });
  expect(rejected.error?.code).toBe("FRAME_REVIEW_REQUIRED");
  expect(fixture.workflow.getConvergenceSnapshot(current.rootId)?.root.state).toBe("needs-review");
  const finalized = finalize(fixture, receipt);
  expect(finalized.root.state).toBe("needs-review");
  if (state === "open") {
    const review = { schemaVersion: "1.0.0", reviewId: "d0344-fresh-frame-review", rootId: current.rootId,
      rootRevision: finalized.root.revision, epoch: finalized.root.currentEpoch, reviewerActorId: "fixture-reviewer",
      implementationActorIds: ["fixture-implementer"], freshContext: { confirmed: true, evidenceRef: "fixture:fresh-review" },
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

function updatedInput(output: string) {
  expect(output).not.toBe("");
  const parsed = JSON.parse(output) as { hookSpecificOutput: { hookEventName: string; updatedInput: Record<string, unknown> } };
  expect(parsed.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", updatedInput: { _continuityBinding: expect.any(String) } });
  expect(parsed.hookSpecificOutput).not.toHaveProperty("permissionDecision");
  return parsed.hookSpecificOutput.updatedInput;
}

function consumeInFreshService(fixture: Awaited<ReturnType<typeof harness>>, input: Record<string, unknown>) {
  const workflow = new SqliteWorkflowStore(fixture.env.AGENT_GOVERNANCE_DB_PATH);
  const continuity = new SqliteContinuityStore(fixture.env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
  stores.add(workflow); stores.add(continuity);
  // Deliberately do not issue another binding or call ensureSession here: the hook must have done it.
  return new ContinuityService(continuity, new ContractValidator(), workflow).checkpointContext(input);
}

describe("D0344 runContinuityHook to checkpointContext production boundary", () => {
  it("a real finalized workflow permits a fresh direct checkpoint from the before-tool hook alone", async () => {
    const fixture = await harness(), attempt = start(fixture);
    const completed = finalize(fixture, attempt.receipt);
    expect(completed).toMatchObject({ root: { state: "completed" }, leases: [{ leaseId: attempt.lease.leaseId, state: "consumed" }],
      outcomes: [{ leaseId: attempt.lease.leaseId, state: "passed" }] });
    const correlation = fixture.initialContinuity.correlateSession(session);
    expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 1, rootId: fixture.root.rootId });
    const input = updatedInput(beforeTool(fixture));
    expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: null });
    const saved = consumeInFreshService(fixture, input);
    expect(saved.error).toBeNull();
    expect(saved.data).toMatchObject({ source: "direct", epoch: 2, revision: 1, core: { objective: checkpoint().core.objective } });
    expect(fixture.continuity.getSnapshot(correlation, 1)).toEqual(fixture.historical);
    expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(completed);
  });

  it.each(["startup", "post-compact"] as const)("%s opens real workflow authority before ensuring a terminal-bound session", async entry => {
    const fixture = await harness(), attempt = start(fixture);
    const completed = finalize(fixture, attempt.receipt), correlation = fixture.initialContinuity.correlateSession(session);
    const event = entry === "startup" ? { hook_event_name: "SessionStart", source: "startup" }
      : { hook_event_name: "PostCompact", turn_id: "fixture-turn", error: null };
    expect(runContinuityHook(JSON.stringify({ ...event, session_id: session }), fixture.env, rootHost)).toBe("");
    expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: null });
    expect(consumeInFreshService(fixture, updatedInput(beforeTool(fixture))).data).toMatchObject({ epoch: 2, revision: 1 });
    expect(fixture.continuity.getSnapshot(correlation, 1)).toEqual(fixture.historical);
    expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(completed);
  });

  it("abortWorkflow settles an attempt and permits a direct checkpoint while its root remains open", async () => {
    const fixture = await harness(), attempt = start(fixture);
    const aborted = fixture.service.abortWorkflow(attempt.receipt.runId, attempt.receipt.revision);
    expect(aborted.error).toBeNull();
    expect(aborted.data?.state).toBe("blocked");
    const active = fixture.workflow.getConvergenceSnapshot(fixture.root.rootId);
    expect(active).toMatchObject({ root: { state: "open" }, outcomes: [{ leaseId: attempt.lease.leaseId, state: "aborted" }] });
    const saved = consumeInFreshService(fixture, updatedInput(beforeTool(fixture)));
    expect(saved.error).toBeNull();
    expect(saved.data).toMatchObject({ source: "direct", epoch: 2, revision: 1 });
    const correlation = fixture.initialContinuity.correlateSession(session);
    expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: null });
    expect(fixture.continuity.getSnapshot(correlation, 2)).toEqual(saved.data);
    expect(fixture.continuity.getSnapshot(correlation, 1)).toEqual(fixture.historical);
    expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(active);
  });

  it.each(["open", "needs-review"] as const)("a publicly finalized run permits direct work while the root is %s", async state => {
    const fixture = await harness(), attempt = start(fixture);
    const settled = finalizeWithGatedRoot(fixture, attempt.receipt, state);
    expect(settled).toMatchObject({ root: { state }, outcomes: [{ state: "passed", leaseId: attempt.lease.leaseId }] });
    const saved = consumeInFreshService(fixture, updatedInput(beforeTool(fixture)));
    expect(saved.error).toBeNull();
    expect(saved.data).toMatchObject({ source: "direct", epoch: 2, revision: 1 });
    const correlation = fixture.initialContinuity.correlateSession(session);
    expect(fixture.continuity.getSnapshot(correlation, 2)).toEqual(saved.data);
    expect(fixture.continuity.getSnapshot(correlation, 1)).toEqual(fixture.historical);
    expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(settled);
  });

  it("a genuinely running guarded attempt stays bound and rejects direct work", async () => {
    const fixture = await harness(), attempt = start(fixture);
    const active = fixture.workflow.getConvergenceSnapshot(fixture.root.rootId);
    expect(fixture.workflow.getRun(attempt.receipt.runId)?.state).toBe("running");
    expect(active).toMatchObject({ outcomes: [], leases: [{ state: "consumed", leaseId: attempt.lease.leaseId }] });
    expect(consumeInFreshService(fixture, updatedInput(beforeTool(fixture))).error?.code).toBe("SNAPSHOT_CONFLICT");
    const correlation = fixture.initialContinuity.correlateSession(session);
    expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 1, rootId: fixture.root.rootId });
    expect(fixture.continuity.getSnapshot(correlation, 1)).toEqual(fixture.historical);
    expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(active);
  });

  it.each(["active", "missing", "unknown-state"] as const)("%s authority stays bound through the real before-tool hook", async authority => {
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
    expect(consumeInFreshService(fixture, updatedInput(beforeTool(fixture))).error?.code).toBe("SNAPSHOT_CONFLICT");
    expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 1, rootId: expectedRoot });
    expect(fixture.continuity.getSnapshot(correlation, 1)).toEqual(fixture.historical);
    expect(fixture.continuity.getSnapshot(correlation, 2)).toBeNull();
    expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(before);
  });

  it("payload claims cannot turn an adapter-observed child into a root or receive a binding", async () => {
    const fixture = await harness(), attempt = start(fixture);
    const completed = finalize(fixture, attempt.receipt), correlation = fixture.initialContinuity.correlateSession(session);
    const before = fixture.continuity.getTask(correlation);
    expect(beforeTool(fixture, childHost, { role: "root", actor: { role: "root", basis: "observed" },
      _sessionProof: "forged-root-proof", continuityAction: { kind: "clear" } })).toBe("");
    expect(fixture.continuity.getTask(correlation)).toEqual(before);
    expect(fixture.continuity.getSnapshot(correlation, 1)).toEqual(fixture.historical);
    expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(completed);
  });
});

describe("D0344 governance proof through the actual MCP checkpoint handler", () => {
  it.each(["completed", "aborted", "finalized-open", "finalized-needs-review", "running"] as const)("%s workflow reaches checkpoint domain validation with the exact hook-issued proofs", async state => {
    const fixture = await harness(), attempt = start(fixture);
    const oldHook = await runGovernanceHook(rootHost, JSON.stringify({ hook_event_name: "PreToolUse", session_id: session,
      tool_use_id: `d0344-old-mcp-checkpoint-${state}`, tool_name: "mcp__agent-governance-suite__checkpoint_context",
      tool_input: checkpoint() }), fixture.env);
    expect(oldHook.ok).toBe(true);
    const oldArgs = updatedInput(oldHook.output);
    expect(oldArgs).toMatchObject({ _sessionProof: expect.any(String), _continuityBinding: expect.any(String) });
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
    const hook = await runGovernanceHook(rootHost, JSON.stringify({ hook_event_name: "PreToolUse", session_id: session,
      tool_use_id: `d0344-mcp-checkpoint-${state}`, tool_name: "mcp__agent-governance-suite__checkpoint_context",
      tool_input: checkpoint() }), fixture.env);
    expect(hook.ok).toBe(true);
    const args = updatedInput(hook.output);
    expect(args).toMatchObject({ _sessionProof: expect.any(String), _continuityBinding: expect.any(String) });
    const correlation = fixture.initialContinuity.correlateSession(session);
    expect(fixture.continuity.getTask(correlation)).toMatchObject(state === "running"
      ? { currentEpoch: 1, rootId: fixture.root.rootId } : { currentEpoch: 2, rootId: null });

    const workflow = new SqliteWorkflowStore(fixture.env.AGENT_GOVERNANCE_DB_PATH);
    const continuity = new SqliteContinuityStore(fixture.env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
    stores.add(workflow); stores.add(continuity);
    const validator = new ContractValidator();
    const updates = new PluginUpdateService(new InMemoryPluginUpdateStore(), {
      fetcher: async () => { throw new Error("Unexpected network request in the checkpoint transport test."); },
    });
    // Neither proof is reminted, and the new continuity service is never ensured or rebound manually.
    const server = createMcpServer(fixture.service, updates, new ContinuityService(continuity, validator, workflow), undefined,
      undefined, validator, "default", null, null, new SessionMessageService(join(fixture.directory, "unused-messaging")),
      null, null, new SessionActorProofs(fixture.workflow));
    const client = new Client({ name: "d0344-hook-mcp-boundary", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      if (state !== "running") {
        const oldReply = await client.callTool({ name: "checkpoint_context", arguments: oldArgs });
        const oldContent = oldReply.content as Array<{ type: string; text?: string }>;
        const stale = JSON.parse(oldContent.find(item => item.type === "text")!.text!) as ApiResultV1<ContinuitySnapshotV1>;
        expect(stale).toMatchObject({ ok: false, data: null, error: { code: "BINDING_INVALID", details: null } });
        expect(continuity.getSnapshot(correlation, 2)).toBeNull();
      }
      const reply = await client.callTool({ name: "checkpoint_context", arguments: args });
      const content = reply.content as Array<{ type: string; text?: string }>;
      const first = content.find(item => item.type === "text");
      expect(first?.text).toBeTypeOf("string");
      const result = JSON.parse(first!.text!) as ApiResultV1<ContinuitySnapshotV1>;
      if (state === "running") {
        expect(result).toMatchObject({ ok: false, data: null, error: { code: "SNAPSHOT_CONFLICT" } });
        expect(continuity.getSnapshot(correlation, 2)).toBeNull();
      } else {
        expect(result.error).toBeNull();
        expect(result.data).toMatchObject({ source: "direct", epoch: 2, revision: 1, core: { objective: checkpoint().core.objective } });
        expect(continuity.getSnapshot(correlation, 2)).toEqual(result.data);
      }
      expect(continuity.getSnapshot(correlation, 1)).toEqual(fixture.historical);
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
    const saved = consumeInFreshService(fixture, updatedInput(beforeTool(fixture)));
    expect(saved.error).toBeNull();
    expect(saved.data).toMatchObject({ epoch: 2, revision: 1 });
    const correlation = fixture.initialContinuity.correlateSession(session);
    expect(fixture.continuity.getSnapshot(correlation, 1)).toEqual(fixture.historical);
    expect(fixture.workflow.getRun(active.receipt.runId)?.state).toBe("running");
    expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(before);
  });

  it("real proof and MCP start rebind after abort/detach, then a second abort permits E3", async () => {
    const fixture = await harness(), first = start(fixture);
    expect(fixture.service.abortWorkflow(first.receipt.runId, first.receipt.revision).error).toBeNull();
    const trusted = trustedPlan(fixture), validator = new ContractValidator();
    const continuity = new SqliteContinuityStore(fixture.env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
    const workflow = new SqliteWorkflowStore(fixture.env.AGENT_GOVERNANCE_DB_PATH);
    stores.add(continuity); stores.add(workflow);
    const server = createMcpServer(trusted.service, new PluginUpdateService(new InMemoryPluginUpdateStore(), {
      fetcher: async () => { throw new Error("Unexpected start lifecycle network request."); },
    }), new ContinuityService(continuity, validator, workflow), undefined, undefined, validator, "default", null, null,
    new SessionMessageService(join(fixture.directory, "unused-start-messaging")), null, null, new SessionActorProofs(fixture.workflow));
    const client = new Client({ name: "d0344-start-rebind", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let call = 0;
    const invoke = async <T,>(name: string, input: Record<string, unknown>): Promise<ApiResultV1<T>> => {
      const hook = await runGovernanceHook(rootHost, JSON.stringify({ hook_event_name: "PreToolUse", session_id: session,
        tool_use_id: `d0344-start-lifecycle-${++call}`, tool_name: `mcp__agent-governance-suite__${name}`, tool_input: input }), fixture.env);
      expect(hook.ok).toBe(true);
      const args = (JSON.parse(hook.output) as { hookSpecificOutput: { updatedInput: Record<string, unknown> } }).hookSpecificOutput.updatedInput;
      expect(args._sessionProof).toEqual(expect.any(String));
      if (name === "checkpoint_context") expect(args._continuityBinding).toEqual(expect.any(String));
      const reply = await client.callTool({ name, arguments: args });
      const content = reply.content as Array<{ type: string; text?: string }>;
      return JSON.parse(content.find(item => item.type === "text")!.text!) as ApiResultV1<T>;
    };
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const secondEpoch = await invoke<ContinuitySnapshotV1>("checkpoint_context", checkpoint());
      expect(secondEpoch.error).toBeNull();
      expect(secondEpoch.data).toMatchObject({ epoch: 2, revision: 1 });
      const startInput = retry(fixture, trusted.service, trusted.plan);
      const started = await invoke<WorkflowReceiptV1>("start_guarded_workflow", { ...startInput, responseMode: "full" });
      expect(started.error).toBeNull();
      expect(started.data?.state).toBe("running");
      const correlation = fixture.initialContinuity.correlateSession(session);
      expect(continuity.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: fixture.root.rootId });
      expect((await invoke("checkpoint_context", checkpoint())).error?.code).toBe("SNAPSHOT_CONFLICT");
      expect(trusted.service.abortWorkflow(started.data!.runId, started.data!.revision).error).toBeNull();
      const thirdEpoch = await invoke<ContinuitySnapshotV1>("checkpoint_context", checkpoint());
      expect(thirdEpoch.error).toBeNull();
      expect(thirdEpoch.data).toMatchObject({ epoch: 3, revision: 1 });
      expect(continuity.getSnapshot(correlation, 1)).toEqual(fixture.historical);
      expect(continuity.getSnapshot(correlation, 2)).toEqual(secondEpoch.data);
      expect(continuity.getSnapshot(correlation, 3)).toEqual(thirdEpoch.data);
    } finally { try { await client.close(); } finally { await server.close(); } }
  });

  it.each(["start-first", "detach-first"] as const)("%s preserves the active guard with real SQLite start/correlation commits", async order => {
    const fixture = await harness(), first = start(fixture);
    expect(fixture.service.abortWorkflow(first.receipt.runId, first.receipt.revision).error).toBeNull();
    const startInput = retry(fixture), correlation = fixture.initialContinuity.correlateSession(session);
    if (order === "detach-first") expect(fixture.initialContinuity.ensureSession(session).currentEpoch).toBe(2);
    const started = fixture.service.startGuardedWorkflow(startInput, false,
      rootId => fixture.initialContinuity.prepareWorkflowStart(session, rootId));
    expect(started.error).toBeNull();
    const epoch = order === "detach-first" ? 2 : 1;
    expect(fixture.initialContinuity.ensureSession(session)).toMatchObject({ currentEpoch: epoch, rootId: fixture.root.rootId });
    expect(consumeInFreshService(fixture, updatedInput(beforeTool(fixture))).error?.code).toBe("SNAPSHOT_CONFLICT");
    expect(fixture.workflow.getRun(started.data!.runId)?.state).toBe("running");
    expect(fixture.continuity.getSnapshot(correlation, 1)).toEqual(fixture.historical);
  });

  it.each(["continuity-update", "throw", "async", "epoch-cas", "root-cas"] as const)("%s callback failure rolls back run, lease, links and sequence", async failure => {
    const fixture = await harness(), pending = claim(fixture), correlation = fixture.initialContinuity.correlateSession(session);
    fixture.initialContinuity.clearSession(session);
    const beforeTask = fixture.continuity.getTask(correlation), beforeWorkflow = fixture.workflow.getConvergenceSnapshot(fixture.root.rootId);
    const beforeRows = workflowRows(fixture), database = new DatabaseSync(fixture.env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
    let expectedTask = beforeTask, callbackReached = false, correlationFailure: unknown;
    try {
      if (failure === "continuity-update") database.exec(`CREATE TRIGGER d0344_reject_start_binding BEFORE UPDATE OF root_id ON continuity_tasks
        BEGIN SELECT RAISE(ABORT, 'd0344-owned-start-binding-failure'); END;`);
      if (failure === "epoch-cas" || failure === "root-cas") {
        const original = fixture.continuity.bindRoot.bind(fixture.continuity);
        vi.spyOn(fixture.continuity, "bindRoot").mockImplementationOnce((...args) => {
          const competing = new SqliteContinuityStore(fixture.env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
          try {
            if (failure === "epoch-cas") competing.rotateEpoch(correlation, new Date().toISOString());
            else expect(competing.bindRoot(correlation, 2, "competing-root", new Date().toISOString())).toBe(true);
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
      if (failure === "throw") expect(started.error?.details).toMatchObject({ cause: "d0344-original-callback-cause" });
      if (failure === "epoch-cas" || failure === "root-cas") expect(started.error?.code).toBe("BINDING_INVALID");
      expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(beforeWorkflow);
      expect(workflowRows(fixture)).toEqual(beforeRows);
      expect(fixture.continuity.getTask(correlation)).toEqual(expectedTask);
      expect(fixture.continuity.getSnapshot(correlation, 1)).toEqual(fixture.historical);
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
      expect(started.error?.details?.cause).toMatch(/FOREIGN KEY/iu);
      expect(fixture.workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(beforeWorkflow);
      expect(workflowRows(fixture)).toEqual(beforeRows);
      expect(fixture.continuity.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: fixture.root.rootId });
      expect(consumeInFreshService(fixture, updatedInput(beforeTool(fixture))).error?.code).toBe("SNAPSHOT_CONFLICT");
      expect(fixture.continuity.getSnapshot(correlation, 1)).toEqual(fixture.historical);
      expect(fixture.continuity.getSnapshot(correlation, 2)).toBeNull();
      database.exec("DROP TRIGGER d0344_fail_workflow_commit");
      const retried = fixture.service.startGuardedWorkflow({ schemaVersion: "1.0.0", leaseId: pending.lease.leaseId,
        expectedRootRevision: pending.lease.rootRevision, plan: pending.plan }, false,
      rootId => fixture.initialContinuity.prepareWorkflowStart(session, rootId));
      expect(retried.error).toBeNull();
      expect(retried.data?.runId).toBe(`run-${fixture.task.taskId}-1`);
      expect(fixture.workflow.getGuardedRunBinding(retried.data!.runId)?.lease.leaseId).toBe(pending.lease.leaseId);
      expect(fixture.service.abortWorkflow(retried.data!.runId, retried.data!.revision).error).toBeNull();
      const recovered = consumeInFreshService(fixture, updatedInput(beforeTool(fixture)));
      expect(recovered.error).toBeNull();
      expect(recovered.data).toMatchObject({ epoch: 3, revision: 1 });
      expect(fixture.continuity.getSnapshot(correlation, 3)).toEqual(recovered.data);
      expect(fixture.continuity.getSnapshot(correlation, 1)).toEqual(fixture.historical);
    } finally {
      database.exec("DROP TRIGGER IF EXISTS d0344_fail_workflow_commit; DROP TABLE IF EXISTS d0344_deferred_commit; DROP TABLE IF EXISTS d0344_missing_parent;");
      database.close();
    }
  });
});
