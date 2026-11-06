import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ApiResultV1,
  AttemptLeaseV1,
  ConvergenceFrameV1,
  ConvergenceReviewV1,
  ConvergenceRootV1,
  ConvergenceStatusV1,
  StageResultV1,
  TaskEnvelopeV1,
  WorkflowPlanV1,
  WorkflowReceiptV1,
} from "../../contracts/types.js";
import { codexMetaIngress } from "../../mcp-server/src/builtin-caller-ingress.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { HostAttestationProvider, hostActorId } from "../../mcp-server/src/host-attestation.js";
import { codexExecutionAdapter } from "../../mcp-server/src/host-execution-adapters.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService, type MinimalWorkflowStartV1 } from "../../mcp-server/src/workflow-service.js";
import { codexCallMeta } from "../helpers/caller.js";
import { fixtureRootApprovalAccess, storedRootApprovalRefs } from "../helpers/root-approval.js";

// A run's contract never changes. When the final candidate changes, the caller binds the new candidate's
// artifactContracts by replacing the root (open_convergence_root with parentRootId and the user's approval).
const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const SESSION = "candidate-rebind-session";
const workspace = fileURLToPath(new URL("../../.phase-fixture/candidate-rebind", import.meta.url));
const CANDIDATE_A = `sha256:${"a".repeat(64)}` as const;
const CANDIDATE_B = `sha256:${"b".repeat(64)}` as const;
const DECOMPOSITION_ARTIFACTS = ["delegation-decision", "task-graph", "assignment-briefs", "integration-report"];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), "candidate-rebind-"));
  const validator = new ContractValidator();
  const store = new SqliteWorkflowStore(path.join(directory, "workflow.sqlite3"));
  const continuityStore = new SqliteContinuityStore(path.join(directory, "continuity.sqlite3"));
  const continuity = new ContinuityService(continuityStore, validator, store);
  const provider = new HostAttestationProvider(codexExecutionAdapter);
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, provider);
  const server = createMcpServer(service, new PluginUpdateService(new InMemoryPluginUpdateStore()), continuity, undefined, undefined, validator,
    "default", provider, path.join(directory, "session-board.sqlite3"), undefined, null, null, codexMetaIngress());
  const client = new Client({ name: "candidate-rebind", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => { store.close(); continuityStore.close(); });
  cleanups.push(async () => { await client.close(); await server.close(); });
  const call = async <T>(name: string, args: Record<string, unknown>, meta = codexCallMeta(SESSION)): Promise<ApiResultV1<T>> => {
    const response = await client.callTool({ name, arguments: args, _meta: meta });
    const text = (response.content as Array<{ type: string; text?: string }>).find(item => item.type === "text")?.text;
    return JSON.parse(text!) as ApiResultV1<T>;
  };
  const ok = async <T>(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<T> => {
    const result = await call<T>(name, args, meta);
    expect(result.error, `${name}: ${JSON.stringify(result.error)}`).toBeNull();
    return result.data!;
  };
  const status = (rootId: string) => ok<ConvergenceStatusV1>("get_convergence_status", { rootId, detail: "full" });
  const approveReplacement = (request: unknown) => storedRootApprovalRefs(service, "replace-root", request,
    { ...fixtureRootApprovalAccess(hostActorId("codex", SESSION)),
      ownsRoot: rootId => continuity.ownsRoot(SESSION, rootId),
      ownedByOtherSession: rootId => continuity.rootOwnedElsewhere(SESSION, rootId) && !continuity.ownsRoot(SESSION, rootId) });
  return { call, ok, status, approveReplacement };
}

function contracts(candidate: `sha256:${string}`): NonNullable<TaskEnvelopeV1["artifactContracts"]> {
  return [{
    capability: "task-decomposition",
    produced: DECOMPOSITION_ARTIFACTS.map(artifactId => ({ artifactId, schemaId: "candidate-rebind/v1", targetDigest: candidate })),
  }];
}

function task(candidate: `sha256:${string}`): TaskEnvelopeV1 {
  return {
    schemaVersion: "1.0.0",
    taskId: "candidate-rebind",
    objective: "Review the final candidate.",
    scope: { included: ["fixture.md"], excluded: ["deployment"] },
    acceptanceCriteria: ["The final candidate passes the planned stage."],
    riskLevel: "low",
    workUnits: [{ id: "unit-1", objective: "Review the candidate.", dependencies: [], writeTargets: ["fixture.md"] }],
    requiredCapabilities: ["task-decomposition"],
    artifactContracts: contracts(candidate),
    constraints: ["Use only fixture data."],
    authorization: { allowedActions: ["test"], prohibitedActions: ["deploy"], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false },
    orchestration: { requested: true, mcpAvailable: true },
  };
}

function frame(candidate: `sha256:${string}`): ConvergenceFrameV1 {
  return {
    schemaVersion: "1.0.0",
    workspace: { workspaceId: "candidate-rebind", locator: workspace },
    controlArtifacts: [{ artifactId: "acceptance", role: "pass-condition", locator: "fixture:acceptance", digest: `sha256:${"c".repeat(64)}` }],
    targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: "fixture.md", digest: candidate }],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
  };
}

function passedStage(receipt: WorkflowReceiptV1, candidate: string): Record<string, unknown> {
  const stage = receipt.plan.stages[0]!;
  const result: StageResultV1 = {
    schemaVersion: "1.0.0",
    runId: receipt.runId,
    stageId: stage.stageId,
    expectedRevision: receipt.revision,
    state: "passed",
    output: {
      schemaVersion: "1.0.0",
      kind: "output",
      output: { completed: true },
      artifacts: stage.requiredArtifacts.map(artifactId => ({
        artifactId, schemaId: "candidate-rebind/v1", locator: `fixture:${artifactId}`, digest: "d".repeat(64), targetDigest: candidate, verified: true,
      })),
      error: null,
    },
    evidence: [{ artifactId: "candidate-rebind", kind: "test", locator: "candidate-rebind.test.ts", verified: true, note: "In-memory MCP transport." }],
    findings: [],
    blockers: [],
    error: null,
  };
  return result as unknown as Record<string, unknown>;
}

const stageMeta = () => codexCallMeta(SESSION, { effort: "xhigh" });

type Harness = Awaited<ReturnType<typeof harness>>;

/** Claims the root's next attempt with its bound task and frame, and starts the run. */
async function claimAndStart(h: Harness, root: { rootId: string; revision: number }, plan: WorkflowPlanV1): Promise<WorkflowReceiptV1> {
  const lease = await h.ok<AttemptLeaseV1>("claim_workflow_attempt", {
    schemaVersion: "1.0.0", rootId: root.rootId, expectedRevision: root.revision, plan, outputTargets: ["fixture.md"], priorFailure: null,
  });
  return h.ok<WorkflowReceiptV1>("start_guarded_workflow", {
    schemaVersion: "1.0.0", leaseId: lease.leaseId, expectedRootRevision: lease.rootRevision, plan,
  });
}

/** Aborts the run; the attempt ends with an aborted outcome and the root stays open. */
async function abort(h: Harness, run: WorkflowReceiptV1, rootId: string): Promise<ConvergenceStatusV1> {
  expect((await h.ok<WorkflowReceiptV1>("abort_workflow", { runId: run.runId, expectedRevision: run.revision })).state).toBe("blocked");
  const current = await h.status(rootId);
  expect(current.root.state).toBe("open");
  expect(current.outcomes.at(-1)).toMatchObject({ workflowRunId: run.runId, state: "aborted" });
  return current;
}

/** Claiming the bound root with the new candidate is a frame change: the root moves to review. */
async function claimNewCandidate(h: Harness, root: ConvergenceRootV1, taskEnvelope: TaskEnvelopeV1, taskFrame: ConvergenceFrameV1,
  plan: WorkflowPlanV1): Promise<ConvergenceStatusV1> {
  const claimed = await h.call<AttemptLeaseV1>("claim_workflow_attempt", {
    schemaVersion: "1.0.0", rootId: root.rootId, expectedRevision: root.revision, taskEnvelope, frame: taskFrame, plan,
    outputTargets: ["fixture.md"], priorFailure: null,
  });
  expect(claimed.error?.code).toBe("FRAME_REVIEW_REQUIRED");
  const gated = await h.status(root.rootId);
  expect(gated.root.state).toBe("needs-review");
  return gated;
}

/** Replaces the gated root with one bound to the new candidate, runs it and records the new candidate as passed. */
async function replaceAndPass(h: Harness, parent: ConvergenceRootV1, taskEnvelope: TaskEnvelopeV1, taskFrame: ConvergenceFrameV1,
  plan: WorkflowPlanV1): Promise<void> {
  const request = { schemaVersion: "1.0.0", parentRootId: parent.rootId, taskEnvelope, frame: taskFrame, userApprovalRefs: [] as string[] };
  request.userApprovalRefs = h.approveReplacement(request);
  const replacement = await h.ok<ConvergenceRootV1>("open_convergence_root", request);
  expect(replacement).toMatchObject({ state: "open", currentEpoch: 1, parentRootId: parent.rootId });
  expect((await h.status(parent.rootId)).root.state).toBe("abandoned");

  const run = await claimAndStart(h, replacement, plan);
  expect(run.plan.stages[0]!.artifactContract?.produced.every(item => item.targetDigest === CANDIDATE_B)).toBe(true);
  const stale = await h.call<WorkflowReceiptV1>("record_stage_result", passedStage(run, CANDIDATE_A), stageMeta());
  expect(stale.error?.code).toBe("BINDING_INVALID");
  const recorded = await h.ok<WorkflowReceiptV1>("record_stage_result", passedStage(run, CANDIDATE_B), stageMeta());
  expect(recorded.state).toBe("running");
  const finalized = await h.ok<WorkflowReceiptV1>("finalize_workflow", { runId: run.runId, expectedRevision: recorded.revision });
  expect(finalized.state).toBe("passed");
  expect((await h.status(replacement.rootId)).root.state).toBe("completed");
}

describe("rebinding a workflow to a changed final candidate", () => {
  it("replaces a plan_workflow root and runs the new candidate's artifactContracts to a pass", async () => {
    const h = await harness();
    const taskA = task(CANDIDATE_A);
    const planA = await h.ok<WorkflowPlanV1>("plan_workflow", { schemaVersion: "1.0.0", taskEnvelope: taskA });
    const root = await h.ok<ConvergenceRootV1>("open_convergence_root", {
      schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: taskA, frame: frame(CANDIDATE_A), userApprovalRefs: [],
    });
    const runA = await claimAndStart(h, root, planA);
    const aborted = await abort(h, runA, root.rootId);
    expect(aborted.attemptsUsedInEpoch).toBe(1);

    const taskB = task(CANDIDATE_B);
    const planB = await h.ok<WorkflowPlanV1>("plan_workflow", { schemaVersion: "1.0.0", taskEnvelope: taskB });
    const gated = await claimNewCandidate(h, aborted.root, taskB, frame(CANDIDATE_B), planB);
    await replaceAndPass(h, gated.root, taskB, frame(CANDIDATE_B), planB);

    // The aborted run keeps the contract it started with.
    const oldRun = await h.ok<WorkflowReceiptV1>("get_workflow_status", { runId: runA.runId });
    expect(oldRun.state).toBe("blocked");
    expect(oldRun.plan.stages[0]!.artifactContract?.produced.every(item => item.targetDigest === CANDIDATE_A)).toBe(true);
  });

  it("does not rebind the task through a frame review: a new epoch keeps the root's frozen artifactContracts", async () => {
    const h = await harness();
    const taskA = task(CANDIDATE_A);
    const planA = await h.ok<WorkflowPlanV1>("plan_workflow", { schemaVersion: "1.0.0", taskEnvelope: taskA });
    const root = await h.ok<ConvergenceRootV1>("open_convergence_root", {
      schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: taskA, frame: frame(CANDIDATE_A), userApprovalRefs: [],
    });
    const aborted = await abort(h, await claimAndStart(h, root, planA), root.rootId);
    const taskB = task(CANDIDATE_B);
    const planB = await h.ok<WorkflowPlanV1>("plan_workflow", { schemaVersion: "1.0.0", taskEnvelope: taskB });
    const gated = await claimNewCandidate(h, aborted.root, taskB, frame(CANDIDATE_B), planB);

    const review: ConvergenceReviewV1 = {
      schemaVersion: "1.0.0",
      reviewId: "review-candidate-b",
      rootId: gated.root.rootId,
      rootRevision: gated.root.revision,
      epoch: gated.currentEpoch,
      reviewerActorId: "fresh-frame-auditor",
      freshContext: { confirmed: true, evidenceRef: "review-evidence:candidate-b" },
      classification: "semantics-preserving",
      comparability: { comparable: true, rationale: "Only the candidate changed." },
      route: "resume-new-epoch",
      proposedFrame: frame(CANDIDATE_B),
      evidenceRefs: ["review-evidence:candidate-b"],
      userApprovalRefs: [],
      reviewedAt: new Date().toISOString(),
    };
    const resumed = await h.ok<ConvergenceStatusV1>("resolve_convergence_gate", {
      schemaVersion: "1.0.0", rootId: gated.root.rootId, expectedRevision: gated.root.revision, review,
    });
    expect(resumed.root).toMatchObject({ state: "open", currentEpoch: 2, taskDigest: root.taskDigest });
    const reclaimed = await claimNewCandidate(h, resumed.root, taskB, frame(CANDIDATE_B), planB);
    expect(reclaimed.root.taskDigest).toBe(root.taskDigest);

    // Replacement remains the way to the new candidate.
    await replaceAndPass(h, reclaimed.root, taskB, frame(CANDIDATE_B), planB);
  });

  it("replaces a root that start_workflow opened in one call", async () => {
    const h = await harness();
    const started = await h.ok<MinimalWorkflowStartV1>("start_workflow", {
      goal: "Review the final candidate.", stages: ["minimal-implementation"], acceptanceCriteria: ["The final candidate passes."],
      workspace, writeTargets: ["fixture.md"],
    });
    const run = await h.ok<WorkflowReceiptV1>("get_workflow_status", { runId: started.runId });
    const aborted = await abort(h, run, started.rootId);

    // The new candidate needs a stage with required artifacts, which start_workflow cannot fix: plan it.
    const taskB: TaskEnvelopeV1 = {
      ...aborted.root.taskEnvelope, requiredCapabilities: ["task-decomposition"], artifactContracts: contracts(CANDIDATE_B),
    };
    const planB = await h.ok<WorkflowPlanV1>("plan_workflow", { schemaVersion: "1.0.0", taskEnvelope: taskB });
    const gated = await claimNewCandidate(h, aborted.root, taskB, aborted.root.frame, planB);
    await replaceAndPass(h, gated.root, taskB, aborted.root.frame, planB);
  });
});
