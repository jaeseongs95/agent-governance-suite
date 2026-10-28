import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiResultV1, CheckpointContextRequestV1, ContinuitySnapshotV1, SkillDescriptorV2, StageResultV1, TaskEnvelopeV1, WorkflowReceiptV1 } from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { runContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { runGovernanceHook } from "../../mcp-server/src/governance-hook.js";
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
  return { directory, env, workflow, continuity, service, initialContinuity, historical, root, task };
}

function start(fixture: Awaited<ReturnType<typeof harness>>) {
  const planned = fixture.service.planWorkflow(fixture.task);
  expect(planned.error).toBeNull();
  const plan = planned.data!;
  expect(plan.stages).toHaveLength(1);
  const claimed = fixture.service.claimWorkflowAttempt({ schemaVersion: "1.0.0", rootId: fixture.root.rootId,
    expectedRevision: fixture.root.revision, taskEnvelope: fixture.task, frame: fixture.root.frame,
    plan, actorId: "fixture-implementer", outputTargets: ["candidate.txt"], priorFailure: null });
  expect(claimed.error).toBeNull();
  const lease = claimed.data!;
  const started = fixture.service.startGuardedWorkflow({ schemaVersion: "1.0.0", leaseId: lease.leaseId,
    expectedRootRevision: lease.rootRevision, plan });
  expect(started.error).toBeNull();
  return { lease, receipt: started.data! };
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

  it("abortWorkflow settles an attempt while its active root still rejects a direct checkpoint", async () => {
    const fixture = await harness(), attempt = start(fixture);
    const aborted = fixture.service.abortWorkflow(attempt.receipt.runId, attempt.receipt.revision);
    expect(aborted.error).toBeNull();
    expect(aborted.data?.state).toBe("blocked");
    const active = fixture.workflow.getConvergenceSnapshot(fixture.root.rootId);
    expect(active).toMatchObject({ root: { state: "open" }, outcomes: [{ leaseId: attempt.lease.leaseId, state: "aborted" }] });
    expect(consumeInFreshService(fixture, updatedInput(beforeTool(fixture))).error?.code).toBe("SNAPSHOT_CONFLICT");
    expect(fixture.continuity.getTask(fixture.initialContinuity.correlateSession(session))).toMatchObject({ currentEpoch: 1, rootId: fixture.root.rootId });
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
  it.each(["completed", "aborted"] as const)("%s workflow reaches checkpoint domain validation with the exact hook-issued proofs", async state => {
    const fixture = await harness(), attempt = start(fixture);
    if (state === "completed") finalize(fixture, attempt.receipt);
    else {
      const aborted = fixture.service.abortWorkflow(attempt.receipt.runId, attempt.receipt.revision);
      expect(aborted.error).toBeNull();
      expect(aborted.data?.state).toBe("blocked");
    }
    const beforeWorkflow = fixture.workflow.getConvergenceSnapshot(fixture.root.rootId);
    expect(beforeWorkflow).toMatchObject({ root: { state: state === "completed" ? "completed" : "open" },
      outcomes: [{ leaseId: attempt.lease.leaseId, state: state === "completed" ? "passed" : "aborted" }] });
    const hook = await runGovernanceHook(rootHost, JSON.stringify({ hook_event_name: "PreToolUse", session_id: session,
      tool_use_id: `d0344-mcp-checkpoint-${state}`, tool_name: "mcp__agent-governance-suite__checkpoint_context",
      tool_input: checkpoint() }), fixture.env);
    expect(hook.ok).toBe(true);
    const args = updatedInput(hook.output);
    expect(args).toMatchObject({ _sessionProof: expect.any(String), _continuityBinding: expect.any(String) });
    const correlation = fixture.initialContinuity.correlateSession(session);
    expect(fixture.continuity.getTask(correlation)).toMatchObject(state === "completed"
      ? { currentEpoch: 2, rootId: null } : { currentEpoch: 1, rootId: fixture.root.rootId });

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
      const reply = await client.callTool({ name: "checkpoint_context", arguments: args });
      const content = reply.content as Array<{ type: string; text?: string }>;
      const first = content.find(item => item.type === "text");
      expect(first?.text).toBeTypeOf("string");
      const result = JSON.parse(first!.text!) as ApiResultV1<ContinuitySnapshotV1>;
      if (state === "completed") {
        expect(result.error).toBeNull();
        expect(result.data).toMatchObject({ source: "direct", epoch: 2, revision: 1, core: { objective: checkpoint().core.objective } });
        expect(continuity.getSnapshot(correlation, 2)).toEqual(result.data);
      } else {
        // This domain error proves the genuine root proof passed the actual MCP ingress gate.
        expect(result).toMatchObject({ ok: false, data: null, error: { code: "SNAPSHOT_CONFLICT" } });
        expect(continuity.getSnapshot(correlation, 2)).toBeNull();
      }
      expect(continuity.getSnapshot(correlation, 1)).toEqual(fixture.historical);
      expect(workflow.getConvergenceSnapshot(fixture.root.rootId)).toEqual(beforeWorkflow);
    } finally {
      try { await client.close(); } finally { await server.close(); }
    }
  });
});
