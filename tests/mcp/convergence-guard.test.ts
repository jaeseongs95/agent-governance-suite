import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";

import {
  type AttemptLeaseV1,
  type AttemptProposalV1,
  type ConvergenceFrameV1,
  type ConvergenceReviewV1,
  type ConvergenceRootV1,
  type ConvergenceStatusV1,
  type SkillDescriptorV2,
  type StageResultV1,
  type TaskEnvelopeV1,
  type WorkflowPlanV1,
  type WorkflowReceiptV1,
} from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";

const temporaryDirectories: string[] = [];
const sqliteStores = new Set<SqliteWorkflowStore>();

const descriptor: SkillDescriptorV2 = {
  schemaVersion: "2.0.0",
  skillId: "fixture-editor",
  version: "1.0.0",
  path: "./fixture-editor",
  priority: 10,
  enabled: true,
  providers: [{
    capabilities: ["fixture-editing"],
    executionClass: "workflow",
    phase: "execution",
    phaseOrder: 50,
    requiredInputArtifacts: [],
    inputBindings: [],
    producedArtifacts: ["candidate"],
    outputSchema: "contracts/freeform-output.v1.schema.json",
    resultSchema: "contracts/provider-result.v1.schema.json",
    stateMapping: {
      selector: "/output/verdict",
      values: {
        PASS: { state: "passed", errorRequired: false },
        FAIL: { state: "failed", errorRequired: true, allowedErrorCodes: ["GATE_FAILED"] },
      },
      default: "reject",
      adapterErrors: ["INVALID_INPUT", "MISSING_EVIDENCE"],
    },
    selectionCriteria: ["fixture capability match"],
    preconditions: [],
    failureHandling: "Return a structured result.",
    gate: { kind: "none", policy: "none", validator: null },
  }],
};

interface Harness {
  databasePath: string;
  registryPath: string;
  service: WorkflowService;
  store: SqliteWorkflowStore;
}

function trackStore(databasePath: string): SqliteWorkflowStore {
  const store = new SqliteWorkflowStore(databasePath);
  sqliteStores.add(store);
  return store;
}

function closeStore(store: SqliteWorkflowStore): void {
  store.close();
  sqliteStores.delete(store);
}

function serviceFor(registryPath: string, store: SqliteWorkflowStore): WorkflowService {
  const validator = new ContractValidator();
  return new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store);
}

async function createHarness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "convergence-guard-"));
  temporaryDirectories.push(directory);
  const registryPath = join(directory, "skills", "registry.json");
  const databasePath = join(directory, "state", "workflows.sqlite3");
  await mkdir(join(directory, "skills"), { recursive: true });
  await mkdir(join(directory, "contracts"), { recursive: true });
  await copyFile(
    new URL("../../contracts/freeform-output.v1.schema.json", import.meta.url),
    join(directory, "contracts", "freeform-output.v1.schema.json"),
  );
  await copyFile(
    new URL("../../contracts/provider-result.v1.schema.json", import.meta.url),
    join(directory, "contracts", "provider-result.v1.schema.json"),
  );
  await writeFile(registryPath, JSON.stringify({ schemaVersion: "2.0.0", skills: [descriptor] }), "utf8");
  const store = trackStore(databasePath);
  return { databasePath, registryPath, service: serviceFor(registryPath, store), store };
}

function task(options: { taskId?: string; objective?: string; included?: string[] } = {}): TaskEnvelopeV1 {
  return {
    schemaVersion: "1.0.0",
    taskId: options.taskId ?? "guarded-task",
    objective: options.objective ?? "Produce a candidate while preserving the fixed evaluation contract.",
    scope: { included: options.included ?? ["src/candidate.ts"], excluded: ["deployment"] },
    acceptanceCriteria: ["The fixed validator accepts the candidate."],
    riskLevel: "low",
    workUnits: [{
      id: "edit",
      objective: "Edit the candidate.",
      dependencies: [],
      writeTargets: ["src/candidate.ts"],
    }],
    requiredCapabilities: ["fixture-editing"],
    constraints: ["Keep the evaluation frame fixed."],
    authorization: {
      allowedActions: ["read", "write"],
      prohibitedActions: ["deploy"],
      approvalRequired: ["change acceptance criteria"],
    },
    decision: { complexity: "complex", hasConflicts: false },
    orchestration: { requested: true, mcpAvailable: true },
  };
}

function frame(options: {
  workspaceId?: string;
  controlVersion?: string;
  targetVersion?: string;
} = {}): ConvergenceFrameV1 {
  const workspaceId = options.workspaceId ?? "workspace-fixture";
  return {
    schemaVersion: "1.0.0",
    workspace: { workspaceId, locator: `D:/fixtures/${workspaceId}` },
    controlArtifacts: [{
      artifactId: "fixed-validator",
      role: "validator",
      locator: "tests/validator.json",
      digest: convergenceDigest({ version: options.controlVersion ?? "control-v1" }),
    }],
    targetArtifacts: [{
      artifactId: "candidate",
      role: "candidate",
      locator: "src/candidate.ts",
      digest: convergenceDigest({ version: options.targetVersion ?? "target-v1" }),
    }],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
  };
}

function plan(service: WorkflowService, envelope: TaskEnvelopeV1): WorkflowPlanV1 {
  const result = service.planWorkflow(envelope);
  expect(result.error).toBeNull();
  expect(result.data).not.toBeNull();
  return result.data!;
}

function openRoot(
  service: WorkflowService,
  envelope: TaskEnvelopeV1 = task(),
  convergenceFrame: ConvergenceFrameV1 = frame(),
): ConvergenceRootV1 {
  const result = service.openConvergenceRoot({
    schemaVersion: "1.0.0",
    parentRootId: null,
    taskEnvelope: envelope,
    frame: convergenceFrame,
    userApprovalRefs: [],
  });
  expect(result.error).toBeNull();
  expect(result.data).not.toBeNull();
  return result.data!;
}

function status(service: WorkflowService, rootId: string): ConvergenceStatusV1 {
  const result = service.getConvergenceStatus(rootId);
  expect(result.error).toBeNull();
  expect(result.data).not.toBeNull();
  return result.data!;
}

function proposal(
  service: WorkflowService,
  root: ConvergenceRootV1,
  options: {
    taskEnvelope?: TaskEnvelopeV1;
    frame?: ConvergenceFrameV1;
    priorFailure?: AttemptProposalV1["priorFailure"];
    actorId?: string;
  } = {},
): AttemptProposalV1 {
  const envelope = options.taskEnvelope ?? root.taskEnvelope;
  return {
    schemaVersion: "1.0.0",
    rootId: root.rootId,
    expectedRevision: root.revision,
    taskEnvelope: envelope,
    frame: options.frame ?? root.frame,
    plan: plan(service, envelope),
    actorId: options.actorId ?? "implementation-agent",
    outputTargets: ["src/candidate.ts"],
    priorFailure: options.priorFailure ?? null,
  };
}

function claimAndStart(
  service: WorkflowService,
  root: ConvergenceRootV1,
  options: Parameters<typeof proposal>[2] = {},
): { lease: AttemptLeaseV1; receipt: WorkflowReceiptV1 } {
  const leaseResult = service.claimWorkflowAttempt(proposal(service, root, options));
  expect(leaseResult.error).toBeNull();
  expect(leaseResult.data).not.toBeNull();
  const lease = leaseResult.data!;
  const startResult = service.startGuardedWorkflow({
    schemaVersion: "1.0.0",
    leaseId: lease.leaseId,
    expectedRootRevision: lease.rootRevision,
    plan: plan(service, options.taskEnvelope ?? root.taskEnvelope),
  });
  expect(startResult.error).toBeNull();
  expect(startResult.data).not.toBeNull();
  return { lease, receipt: startResult.data! };
}

function failedStage(receipt: WorkflowReceiptV1): StageResultV1 {
  const stage = receipt.plan.stages[0]!;
  return {
    schemaVersion: "1.0.0",
    runId: receipt.runId,
    stageId: stage.stageId,
    expectedRevision: receipt.revision,
    state: "failed",
    output: {
      schemaVersion: "1.0.0",
      kind: "output",
      output: { verdict: "FAIL" },
      artifacts: [],
      error: { code: "GATE_FAILED", message: "The candidate did not pass.", details: null },
    },
    evidence: [{
      artifactId: "failure-log",
      kind: "test",
      locator: "tests/results/failure.json",
      verified: true,
      note: "Observed fixture failure.",
    }],
    findings: ["candidate-rejected"],
    blockers: ["candidate-rejected"],
    error: { code: "GATE_FAILED", message: "The candidate did not pass.", details: null },
  };
}

function latestFailure(current: ConvergenceStatusV1, evidenceRef: string): AttemptProposalV1["priorFailure"] {
  const failure = current.outcomes.at(-1);
  expect(failure?.failureFingerprint).toBeTruthy();
  return {
    fingerprint: failure!.failureFingerprint!,
    hypothesis: "The candidate content still contains the rejected construction.",
    changeSummary: "Revise only the candidate artifact.",
    discriminator: "Run the frozen validator and compare its finding.",
    evidenceRefs: [evidenceRef],
  };
}

function recordFailureAndStatus(
  service: WorkflowService,
  rootId: string,
  receipt: WorkflowReceiptV1,
): ConvergenceStatusV1 {
  const result = service.recordStageResult(failedStage(receipt));
  expect(result.error).toBeNull();
  expect(result.data?.state).toBe("failed");
  return status(service, rootId);
}

function abortAndStatus(
  service: WorkflowService,
  rootId: string,
  receipt: WorkflowReceiptV1,
): ConvergenceStatusV1 {
  const result = service.abortWorkflow(receipt.runId, receipt.revision);
  expect(result.error).toBeNull();
  expect(result.data?.state).toBe("blocked");
  return status(service, rootId);
}

function review(
  current: ConvergenceStatusV1,
  options: Pick<ConvergenceReviewV1, "classification" | "route" | "proposedFrame">,
  reviewId: string,
): ConvergenceReviewV1 {
  return {
    schemaVersion: "1.0.0",
    reviewId,
    rootId: current.root.rootId,
    rootRevision: current.root.revision,
    epoch: current.currentEpoch,
    reviewerActorId: "fresh-frame-auditor",
    implementationActorIds: ["implementation-agent"],
    freshContext: { confirmed: true, evidenceRef: `review-evidence:${reviewId}` },
    classification: options.classification,
    comparability: {
      comparable: options.classification === "semantics-preserving",
      rationale: options.classification === "semantics-preserving"
        ? "The fixed task and control frame remain comparable."
        : "The evaluation meaning is changed or unresolved.",
    },
    route: options.route,
    proposedFrame: options.proposedFrame,
    evidenceRefs: [`review-evidence:${reviewId}`],
    userApprovalRefs: [],
    reviewedAt: new Date().toISOString(),
  };
}

async function consumeThreeFailedAttempts(
  service: WorkflowService,
  initialRoot: ConvergenceRootV1,
  targetPrefix: string,
): Promise<ConvergenceStatusV1> {
  let current = status(service, initialRoot.rootId);
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const targetFrame = ordinal === 1 ? current.root.frame : frame({
      workspaceId: initialRoot.frame.workspace.workspaceId,
      targetVersion: `${targetPrefix}-${ordinal}`,
    });
    const priorFailure = ordinal === 1 ? null : latestFailure(current, `${targetPrefix}-evidence-${ordinal}`);
    const started = claimAndStart(service, current.root, { frame: targetFrame, priorFailure });
    expect(started.lease.ordinal).toBe(ordinal);
    current = recordFailureAndStatus(service, initialRoot.rootId, started.receipt);
  }
  return current;
}

afterEach(async () => {
  for (const store of sqliteStores) store.close();
  sqliteStores.clear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local MCP convergence guard", () => {
  it("opens an immutable root and rejects overlapping active scope even under a changed taskId", async () => {
    const { service } = await createHarness();
    const opened = openRoot(service);

    expect(opened).toMatchObject({ state: "open", currentEpoch: 1, revision: 0 });
    expect(opened.taskDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(opened.controlDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(opened.controlDigest).toBe(convergenceDigest(opened.frame.controlArtifacts));

    const conflictingTask = task({ taskId: "guarded-task-renamed" });
    const conflict = service.openConvergenceRoot({
      schemaVersion: "1.0.0",
      parentRootId: null,
      taskEnvelope: conflictingTask,
      frame: frame(),
      userApprovalRefs: [],
    });
    expect(conflict.error?.code).toBe("ROOT_CONFLICT");
    expect(conflict.error?.details).toMatchObject({ rootId: opened.rootId, workspaceId: "workspace-fixture" });

    const aliasedFrame = frame({ workspaceId: "workspace-fixture-alias" });
    aliasedFrame.workspace.locator = opened.frame.workspace.locator;
    const aliasConflict = service.openConvergenceRoot({
      schemaVersion: "1.0.0",
      parentRootId: null,
      taskEnvelope: task({ taskId: "guarded-task-alias" }),
      frame: aliasedFrame,
      userApprovalRefs: [],
    });
    expect(aliasConflict.error?.code).toBe("ROOT_CONFLICT");

    const normalizedAliasFrame = frame({ workspaceId: "workspace-dot-alias" });
    normalizedAliasFrame.workspace.locator = "D:/fixtures/./workspace-fixture";
    const normalizedAliasConflict = service.openConvergenceRoot({
      schemaVersion: "1.0.0",
      parentRootId: null,
      taskEnvelope: task({ taskId: "guarded-task-dot-alias", included: ["./src/candidate.ts"] }),
      frame: normalizedAliasFrame,
      userApprovalRefs: [],
    });
    expect(normalizedAliasConflict.error?.code).toBe("ROOT_CONFLICT");
  });

  it("requires a lease for every valid orchestrated plan", async () => {
    const { service } = await createHarness();
    const result = service.rejectUnguardedWorkflow(plan(service, task()));
    expect(result.error?.code).toBe("LEASE_REQUIRED");
  });

  it("rejects a signed plan produced from a different task envelope with the same taskId", async () => {
    const { service } = await createHarness();
    const root = openRoot(service);
    const mismatched = proposal(service, root);
    mismatched.plan = plan(service, task({ objective: "A different task hidden behind the same taskId." }));

    const result = service.claimWorkflowAttempt(mismatched);
    expect(result.error?.code).toBe("LEASE_CONFLICT");
    expect(status(service, root.rootId).leases).toHaveLength(0);
  });

  it("atomically consumes the first lease and rejects reuse", async () => {
    const { service } = await createHarness();
    const root = openRoot(service);
    const attempt = claimAndStart(service, root);

    expect(attempt.lease).toMatchObject({ epoch: 1, ordinal: 1, state: "issued" });
    expect(attempt.receipt.state).toBe("running");
    const reused = service.startGuardedWorkflow({
      schemaVersion: "1.0.0",
      leaseId: attempt.lease.leaseId,
      expectedRootRevision: attempt.lease.rootRevision,
      plan: plan(service, root.taskEnvelope),
    });
    expect(reused.error?.code).toBe("LEASE_CONFLICT");
    expect(status(service, root.rootId).leases[0]?.state).toBe("consumed");
  });

  it("does not issue another lease while the previous consumed attempt is still running", async () => {
    const { service } = await createHarness();
    const root = openRoot(service);
    claimAndStart(service, root);
    const current = status(service, root.rootId);

    const overlapping = service.claimWorkflowAttempt(proposal(service, current.root));
    expect(overlapping.error?.code).toBe("LEASE_CONFLICT");
    expect(status(service, root.rootId).leases).toHaveLength(1);
  });

  it("preserves a pending frame-review gate when an older running attempt terminates", async () => {
    const { service } = await createHarness();
    const root = openRoot(service);
    const running = claimAndStart(service, root);
    let current = status(service, root.rootId);
    const drift = service.claimWorkflowAttempt(proposal(service, current.root, {
      frame: frame({ controlVersion: "drift-detected-while-running" }),
    }));
    expect(drift.error?.code).toBe("FRAME_REVIEW_REQUIRED");
    current = status(service, root.rootId);
    expect(current.root.state).toBe("needs-review");

    current = abortAndStatus(service, root.rootId, running.receipt);
    expect(current.root.state).toBe("needs-review");
    expect(current.outcomes.at(-1)?.state).toBe("aborted");
  });

  it("records failed outcomes and allows target-only, evidence-bearing retries through ordinal 3", async () => {
    const { service } = await createHarness();
    const root = openRoot(service);
    let current = status(service, root.rootId);

    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      const targetFrame = ordinal === 1 ? frame() : frame({ targetVersion: `target-v${ordinal}` });
      const priorFailure = ordinal === 1 ? null : latestFailure(current, `test:evidence-${ordinal}`);
      const attempt = claimAndStart(service, current.root, { frame: targetFrame, priorFailure });
      expect(attempt.lease.ordinal).toBe(ordinal);
      current = recordFailureAndStatus(service, root.rootId, attempt.receipt);
      expect(current.outcomes).toHaveLength(ordinal);
      expect(current.outcomes.at(-1)).toMatchObject({ ordinal, state: "failed" });
      expect(current.attemptsUsedInEpoch).toBe(ordinal);
      expect(current.attemptsRemainingInEpoch).toBe(3 - ordinal);
    }

    expect(current.root.state).toBe("needs-review");
    const fourth = service.claimWorkflowAttempt(proposal(service, current.root, {
      frame: frame({ targetVersion: "target-v4" }),
      priorFailure: latestFailure(current, "test:evidence-4"),
    }));
    expect(fourth.error?.code).toBe("ATTEMPT_BUDGET_EXHAUSTED");
  });

  it.each([
    {
      name: "task contract",
      mutate: (root: ConvergenceRootV1) => ({
        taskEnvelope: task({ objective: `${root.taskEnvelope.objective} Changed.` }),
        frame: root.frame,
      }),
    },
    {
      name: "control frame",
      mutate: (root: ConvergenceRootV1) => ({
        taskEnvelope: root.taskEnvelope,
        frame: frame({ controlVersion: "control-v2" }),
      }),
    },
  ])("gates a changed $name before workflow start", async ({ mutate }) => {
    const { service } = await createHarness();
    const root = openRoot(service);
    const attempt = claimAndStart(service, root);
    let current = abortAndStatus(service, root.rootId, attempt.receipt);
    const changed = mutate(current.root);

    const claimed = service.claimWorkflowAttempt(proposal(service, current.root, {
      ...changed,
      priorFailure: latestFailure(current, "test:changed-frame"),
    }));
    expect(claimed.error?.code).toBe("FRAME_REVIEW_REQUIRED");
    current = status(service, root.rootId);
    expect(current.root.state).toBe("needs-review");
    expect(current.workflowRunIds).toHaveLength(1);
  });

  it("accepts an independent review when frame drift is detected before any attempt starts", async () => {
    const { service } = await createHarness();
    const root = openRoot(service);
    const changedFrame = frame({ controlVersion: "control-v2" });
    const claimed = service.claimWorkflowAttempt(proposal(service, root, { frame: changedFrame }));
    expect(claimed.error?.code).toBe("FRAME_REVIEW_REQUIRED");

    const current = status(service, root.rootId);
    expect(current.leases).toHaveLength(0);
    const gateReview = review(current, {
      classification: "semantics-changing",
      route: "needs-user",
      proposedFrame: changedFrame,
    }, "review-before-first-attempt");
    gateReview.implementationActorIds = [];

    const resolved = service.resolveConvergenceGate({
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      expectedRevision: current.root.revision,
      review: gateReview,
    });
    expect(resolved.error).toBeNull();
    expect(resolved.data?.root.state).toBe("needs-user");
    expect(resolved.data?.reviews[0]?.implementationActorIds).toEqual([]);
  });

  it("rejects a repeated target and repeated evidence as NEW_EVIDENCE_REQUIRED", async () => {
    const { service } = await createHarness();
    const root = openRoot(service);
    let current = status(service, root.rootId);
    let attempt = claimAndStart(service, current.root);
    current = recordFailureAndStatus(service, root.rootId, attempt.receipt);

    const secondFrame = frame({ targetVersion: "target-v2" });
    attempt = claimAndStart(service, current.root, {
      frame: secondFrame,
      priorFailure: latestFailure(current, "test:shared-evidence"),
    });
    current = recordFailureAndStatus(service, root.rootId, attempt.receipt);

    const rejected = service.claimWorkflowAttempt(proposal(service, current.root, {
      frame: secondFrame,
      priorFailure: latestFailure(current, "test:shared-evidence"),
    }));
    expect(rejected.error?.code).toBe("NEW_EVIDENCE_REQUIRED");
    expect(rejected.error?.details).toMatchObject({ route: "diagnose" });
  });

  it("persists roots, consumed budget, running attempts, and aborted outcomes across restart", async () => {
    const harness = await createHarness();
    const root = openRoot(harness.service);
    const attempt = claimAndStart(harness.service, root);
    closeStore(harness.store);

    const restartedStore = trackStore(harness.databasePath);
    const restarted = serviceFor(harness.registryPath, restartedStore);
    let current = status(restarted, root.rootId);
    expect(current).toMatchObject({ attemptsUsedInEpoch: 1, attemptsRemainingInEpoch: 2 });
    expect(current.outcomes).toHaveLength(0);
    expect(restarted.getWorkflowStatus(attempt.receipt.runId).data?.state).toBe("running");

    current = abortAndStatus(restarted, root.rootId, attempt.receipt);
    expect(current.attemptsUsedInEpoch).toBe(1);
    expect(current.outcomes).toHaveLength(1);
    expect(current.outcomes[0]).toMatchObject({ state: "aborted", ordinal: 1 });
  });

  it("allows only one competing lease claim across two SQLite connections", async () => {
    const harness = await createHarness();
    const root = openRoot(harness.service);
    const firstProposal = proposal(harness.service, root);
    const workers = [firstProposal, structuredClone(firstProposal)].map((workerProposal) => new Worker(
      new URL("./fixtures/concurrent-claim-worker.ts", import.meta.url),
      {
        execArgv: ["--import", "tsx"],
        workerData: {
          databasePath: harness.databasePath,
          registryPath: harness.registryPath,
          proposal: workerProposal,
        },
      },
    ));
    const ready = workers.map((worker) => new Promise<void>((resolve, reject) => {
      const onMessage = (message: { type?: string }) => {
        if (message.type !== "ready") return;
        worker.off("message", onMessage);
        resolve();
      };
      worker.on("message", onMessage);
      worker.once("error", reject);
    }));
    await Promise.all(ready);
    const results = workers.map((worker) => new Promise<{ ok: boolean; error: { code: string } | null }>((resolve, reject) => {
      worker.once("message", (message: { type?: string; result?: { ok: boolean; error: { code: string } | null } }) => {
        if (message.type === "result" && message.result) resolve(message.result);
        else reject(new Error("Concurrent claim worker returned an unexpected message."));
      });
      worker.once("error", reject);
    }));
    const exits = workers.map((worker) => new Promise<void>((resolve) => worker.once("exit", () => resolve())));
    workers.forEach((worker) => worker.postMessage("claim"));
    const workerResults = await Promise.all(results);
    await Promise.all(exits);
    expect(workerResults.filter((result) => result.ok)).toHaveLength(1);
    expect(workerResults.filter((result) => !result.ok)).toHaveLength(1);
    expect(workerResults.find((result) => !result.ok)?.error?.code).toBe("LEASE_CONFLICT");
    expect(status(harness.service, root.rootId).leases.filter((lease) => lease.state === "issued")).toHaveLength(1);
  });

  it("opens epoch 2 exactly once after a fresh independent semantics-preserving review", async () => {
    const { service } = await createHarness();
    const root = openRoot(service);
    let current = await consumeThreeFailedAttempts(service, root, "epoch-1");
    const nextFrame = frame({ targetVersion: "epoch-2-target" });
    const resolved = service.resolveConvergenceGate({
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      expectedRevision: current.root.revision,
      review: review(current, {
        classification: "semantics-preserving",
        route: "resume-new-epoch",
        proposedFrame: nextFrame,
      }, "review-open-epoch-2"),
    });
    expect(resolved.error).toBeNull();
    expect(resolved.data).toMatchObject({ currentEpoch: 2, attemptsUsedInEpoch: 0 });
    expect(resolved.data?.root).toMatchObject({ state: "open", currentEpoch: 2, frame: nextFrame });

    current = resolved.data!;
    const epochTwoAttempt = claimAndStart(service, current.root);
    current = abortAndStatus(service, root.rootId, epochTwoAttempt.receipt);
    const changedControl = frame({ controlVersion: "epoch-2-control-change", targetVersion: "epoch-2-target" });
    const gated = service.claimWorkflowAttempt(proposal(service, current.root, {
      frame: changedControl,
      priorFailure: latestFailure(current, "test:epoch-2-control-change"),
    }));
    expect(gated.error?.code).toBe("FRAME_REVIEW_REQUIRED");
    current = status(service, root.rootId);
    const noThirdEpoch = service.resolveConvergenceGate({
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      expectedRevision: current.root.revision,
      review: review(current, {
        classification: "semantics-preserving",
        route: "resume-new-epoch",
        proposedFrame: current.root.frame,
      }, "review-refuse-epoch-3"),
    });
    expect(noThirdEpoch.error).toBeNull();
    expect(noThirdEpoch.data?.root).toMatchObject({ currentEpoch: 2, state: "needs-user" });
  });

  it("does not open a new epoch when an otherwise preserving review has no target correction", async () => {
    const { service } = await createHarness();
    const root = openRoot(service);
    const current = await consumeThreeFailedAttempts(service, root, "unchanged-review");
    const result = service.resolveConvergenceGate({
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      expectedRevision: current.root.revision,
      review: review(current, {
        classification: "semantics-preserving",
        route: "resume-new-epoch",
        proposedFrame: current.root.frame,
      }, "review-without-target-correction"),
    });
    expect(result.error?.code).toBe("GATE_FAILED");
    expect(status(service, root.rootId).root).toMatchObject({ currentEpoch: 1, state: "needs-review" });
  });

  it.each([
    { classification: "semantics-changing" as const, route: "needs-user" as const, expectedState: "needs-user" },
    { classification: "ambiguous" as const, route: "panel" as const, expectedState: "needs-review" },
  ])("routes $classification reviews through $route", async ({ classification, route, expectedState }) => {
    const { service } = await createHarness();
    const root = openRoot(service);
    const attempt = claimAndStart(service, root);
    let current = abortAndStatus(service, root.rootId, attempt.receipt);
    const proposedFrame = frame({ controlVersion: `${classification}-control` });
    const gated = service.claimWorkflowAttempt(proposal(service, current.root, {
      frame: proposedFrame,
      priorFailure: latestFailure(current, `test:${classification}`),
    }));
    expect(gated.error?.code).toBe("FRAME_REVIEW_REQUIRED");
    current = status(service, root.rootId);

    const resolved = service.resolveConvergenceGate({
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      expectedRevision: current.root.revision,
      review: review(current, { classification, route, proposedFrame }, `review-${classification}`),
    });
    expect(resolved.error).toBeNull();
    expect(resolved.data?.root.state).toBe(expectedState);
    expect(resolved.data?.reviews.at(-1)).toMatchObject({ classification, route });
  });

  it("does not let an independent review reopen a needs-user root without a new user contract", async () => {
    const { service } = await createHarness();
    const root = openRoot(service);
    const attempt = claimAndStart(service, root);
    let current = abortAndStatus(service, root.rootId, attempt.receipt);
    const proposedFrame = frame({ controlVersion: "user-value-change" });
    expect(service.claimWorkflowAttempt(proposal(service, current.root, {
      frame: proposedFrame,
      priorFailure: latestFailure(current, "test:user-value-change"),
    }))).toMatchObject({ error: { code: "FRAME_REVIEW_REQUIRED" } });
    current = status(service, root.rootId);
    const needsUser = service.resolveConvergenceGate({
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      expectedRevision: current.root.revision,
      review: review(current, {
        classification: "semantics-changing",
        route: "needs-user",
        proposedFrame,
      }, "review-needs-user"),
    });
    expect(needsUser.data?.root.state).toBe("needs-user");
    current = needsUser.data!;

    const bypass = service.resolveConvergenceGate({
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      expectedRevision: current.root.revision,
      review: review(current, {
        classification: "semantics-preserving",
        route: "resume-new-epoch",
        proposedFrame: current.root.frame,
      }, "review-bypass-user"),
    });
    expect(bypass.error?.code).toBe("INVALID_TRANSITION");
    expect(status(service, root.rootId).root.state).toBe("needs-user");

    const changedWhileWaiting = service.claimWorkflowAttempt(proposal(service, current.root, {
      frame: frame({ controlVersion: "another-user-value-change", targetVersion: "another-target" }),
      priorFailure: latestFailure(current, "test:still-needs-user"),
    }));
    expect(changedWhileWaiting.error?.code).toBe("FRAME_REVIEW_REQUIRED");
    expect(status(service, root.rootId).root.state).toBe("needs-user");
  });

  it("genericized Korean attempt-6/7 regression gates changed evaluation meaning before attempt 7 starts", async () => {
    const { service } = await createHarness();
    const root = openRoot(service);
    let current = await consumeThreeFailedAttempts(service, root, "generic-edit-epoch-1");
    const epochTwoFrame = frame({ targetVersion: "generic-edit-attempt-4" });
    const epochTwo = service.resolveConvergenceGate({
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      expectedRevision: current.root.revision,
      review: review(current, {
        classification: "semantics-preserving",
        route: "resume-new-epoch",
        proposedFrame: epochTwoFrame,
      }, "generic-edit-fresh-review"),
    });
    expect(epochTwo.error).toBeNull();
    current = epochTwo.data!;

    for (let attemptNumber = 4; attemptNumber <= 6; attemptNumber += 1) {
      const attemptFrame = attemptNumber === 4 ? epochTwoFrame : frame({ targetVersion: `generic-edit-attempt-${attemptNumber}` });
      const started = claimAndStart(service, current.root, {
        frame: attemptFrame,
        priorFailure: attemptNumber === 4 ? null : latestFailure(current, `test:generic-edit-${attemptNumber}`),
      });
      current = recordFailureAndStatus(service, root.rootId, started.receipt);
    }
    expect(current.outcomes).toHaveLength(6);
    expect(current.workflowRunIds).toHaveLength(6);

    const changedEvaluator = frame({
      controlVersion: "changed-evaluation-meaning-before-attempt-7",
      targetVersion: "generic-edit-attempt-7",
    });
    const attemptSeven = service.claimWorkflowAttempt(proposal(service, current.root, {
      frame: changedEvaluator,
      priorFailure: latestFailure(current, "test:generic-edit-7"),
    }));
    expect(attemptSeven.error?.code).toBe("FRAME_REVIEW_REQUIRED");
    expect(status(service, root.rootId).workflowRunIds).toHaveLength(6);
  });
});
