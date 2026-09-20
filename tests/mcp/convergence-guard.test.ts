import fs from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

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
        NEEDS_INPUT: { state: "needs-input", errorRequired: false },
        NEEDS_APPROVAL: { state: "needs-approval", errorRequired: false },
        NEEDS_REDESIGN: { state: "needs-redesign", errorRequired: false },
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

function task(options: {
  taskId?: string;
  objective?: string;
  included?: string[];
  writeTargets?: string[];
} = {}): TaskEnvelopeV1 {
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
      writeTargets: options.writeTargets ?? ["src/candidate.ts"],
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
  targetLocator?: string;
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
      locator: options.targetLocator ?? "src/candidate.ts",
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

function userGateStage(receipt: WorkflowReceiptV1, verdict: string, state: StageResultV1["state"]): StageResultV1 {
  const stage = receipt.plan.stages[0]!;
  return {
    schemaVersion: "1.0.0",
    runId: receipt.runId,
    stageId: stage.stageId,
    expectedRevision: receipt.revision,
    state,
    output: {
      schemaVersion: "1.0.0",
      kind: "output",
      output: { verdict },
      artifacts: [],
      error: null,
    },
    evidence: [{
      artifactId: "user-decision-note",
      kind: "user-input",
      locator: "tests/results/user-decision.json",
      verified: true,
      note: "The attempt stopped for a user decision.",
    }],
    findings: ["user-decision-required"],
    blockers: [],
    error: null,
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

  it("reuses root and lease bindings when compact claim and guarded start omit duplicate values", async () => {
    const harness = await createHarness();
    const root = openRoot(harness.service);
    const workflowPlan = plan(harness.service, root.taskEnvelope);
    const partial = harness.service.claimWorkflowAttempt({
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      expectedRevision: root.revision,
      taskEnvelope: root.taskEnvelope,
      plan: workflowPlan,
      actorId: "implementation-agent",
      outputTargets: ["src/candidate.ts"],
      priorFailure: null,
    });
    expect(partial.error?.code).toBe("INVALID_INPUT");

    const lease = harness.service.claimWorkflowAttempt({
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      expectedRevision: root.revision,
      plan: workflowPlan,
      actorId: "implementation-agent",
      outputTargets: ["src/candidate.ts"],
      priorFailure: null,
    });
    expect(lease.error).toBeNull();
    expect(status(harness.service, root.rootId).proposals[0]).toMatchObject({
      taskEnvelope: root.taskEnvelope,
      frame: root.frame,
      plan: workflowPlan,
    });

    const tamperedLegacyStart = harness.service.startGuardedWorkflow({
      schemaVersion: "1.0.0",
      leaseId: lease.data!.leaseId,
      expectedRootRevision: lease.data!.rootRevision,
      plan: { ...workflowPlan, nextStageId: "tampered-stage" },
    });
    expect(tamperedLegacyStart.error?.code).toBe("INVALID_INPUT");

    closeStore(harness.store);
    const restartedStore = trackStore(harness.databasePath);
    const restarted = serviceFor(harness.registryPath, restartedStore);
    const started = restarted.startGuardedWorkflow({
      schemaVersion: "1.0.0",
      leaseId: lease.data!.leaseId,
      expectedRootRevision: lease.data!.rootRevision,
    });
    expect(started.error).toBeNull();
    expect(started.data).toMatchObject({ state: "running", revision: 0 });
    expect(restarted.getWorkflowStatus(started.data!.runId).data?.plan.taskId).toBe(root.taskEnvelope.taskId);

    const reused = restarted.startGuardedWorkflow({
      schemaVersion: "1.0.0",
      leaseId: lease.data!.leaseId,
      expectedRootRevision: lease.data!.rootRevision,
    });
    expect(reused.error?.code).toBe("LEASE_CONFLICT");
  });

  it("preserves stale and expiry checks for planless guarded starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T00:00:00.000Z"));
    try {
      const { service } = await createHarness();
      const root = openRoot(service);
      const workflowPlan = plan(service, root.taskEnvelope);
      const lease = service.claimWorkflowAttempt({
        schemaVersion: "1.0.0",
        rootId: root.rootId,
        expectedRevision: root.revision,
        plan: workflowPlan,
        actorId: "implementation-agent",
        outputTargets: ["src/candidate.ts"],
        priorFailure: null,
      });
      expect(lease.error).toBeNull();

      const stale = service.startGuardedWorkflow({
        schemaVersion: "1.0.0",
        leaseId: lease.data!.leaseId,
        expectedRootRevision: lease.data!.rootRevision + 1,
      });
      expect(stale.error?.code).toBe("STALE_REVISION");
      expect(status(service, root.rootId).leases[0]?.state).toBe("issued");

      vi.advanceTimersByTime(301_000);
      const expired = service.startGuardedWorkflow({
        schemaVersion: "1.0.0",
        leaseId: lease.data!.leaseId,
        expectedRootRevision: lease.data!.rootRevision,
      });
      expect(expired.error?.code).toBe("LEASE_CONFLICT");
      expect(status(service, root.rootId).leases[0]?.state).toBe("expired");
    } finally {
      vi.useRealTimers();
    }
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

  it("records a rejected retry on the root without spending attempt budget", async () => {
    const harness = await createHarness();
    const root = openRoot(harness.service);
    let current = status(harness.service, root.rootId);
    let attempt = claimAndStart(harness.service, current.root);
    current = recordFailureAndStatus(harness.service, root.rootId, attempt.receipt);

    const secondFrame = frame({ targetVersion: "target-v2" });
    attempt = claimAndStart(harness.service, current.root, {
      frame: secondFrame,
      priorFailure: latestFailure(current, "test:shared-evidence"),
    });
    current = recordFailureAndStatus(harness.service, root.rootId, attempt.receipt);
    const before = current;

    const rejected = harness.service.claimWorkflowAttempt(proposal(harness.service, before.root, {
      frame: secondFrame,
      priorFailure: latestFailure(before, "test:shared-evidence"),
    }));
    expect(rejected.error?.code).toBe("NEW_EVIDENCE_REQUIRED");
    expect(rejected.error?.details).toMatchObject({
      route: "diagnose",
      rootRevision: before.root.revision + 1,
    });

    current = status(harness.service, root.rootId);
    expect(current.root.revision).toBe(before.root.revision + 1);
    expect(current.root.state).toBe("open");
    expect(current.attemptsUsedInEpoch).toBe(before.attemptsUsedInEpoch);
    expect(current.leases).toHaveLength(before.leases.length);
    expect(current.root.retryRejections).toHaveLength(1);
    expect(current.root.retryRejections?.[0]).toMatchObject({
      epoch: 1,
      reason: "stale-evidence",
      actorId: "implementation-agent",
      evidenceRefs: ["test:shared-evidence"],
    });

    // The record has to survive a restart: it is what burns the evidence later.
    closeStore(harness.store);
    const restartedStore = trackStore(harness.databasePath);
    const restarted = serviceFor(harness.registryPath, restartedStore);
    expect(status(restarted, root.rootId).root.retryRejections).toHaveLength(1);
  });

  it("records a stale-fingerprint rejection without burning its evidence", async () => {
    const harness = await createHarness();
    const root = openRoot(harness.service);
    let current = status(harness.service, root.rootId);
    const attempt = claimAndStart(harness.service, current.root);
    current = recordFailureAndStatus(harness.service, root.rootId, attempt.receipt);

    const missing = harness.service.claimWorkflowAttempt(proposal(harness.service, current.root));
    expect(missing.error?.code).toBe("NEW_EVIDENCE_REQUIRED");
    expect(missing.error?.details).toMatchObject({ rootRevision: current.root.revision + 1 });

    current = status(harness.service, root.rootId);
    const wrongFingerprint = harness.service.claimWorkflowAttempt(proposal(harness.service, current.root, {
      priorFailure: {
        ...latestFailure(current, "test:wrong-fingerprint-evidence")!,
        fingerprint: `sha256:${"0".repeat(64)}`,
      },
    }));
    expect(wrongFingerprint.error?.code).toBe("NEW_EVIDENCE_REQUIRED");

    current = status(harness.service, root.rootId);
    expect(current.attemptsUsedInEpoch).toBe(1);
    expect(current.root.state).toBe("open");
    expect(current.root.retryRejections).toHaveLength(2);
    expect(current.root.retryRejections?.map((item) => item.reason)).toEqual([
      "stale-fingerprint",
      "stale-fingerprint",
    ]);
    expect(current.root.retryRejections?.[0]?.evidenceRefs).toEqual([]);
    expect(current.root.retryRejections?.[1]?.evidenceRefs).toEqual(["test:wrong-fingerprint-evidence"]);

    closeStore(harness.store);
    const restarted = serviceFor(harness.registryPath, trackStore(harness.databasePath));
    current = status(restarted, root.rootId);
    expect(current.root.retryRejections).toHaveLength(2);

    // A stale fingerprint must not discard the diagnostics it carried.
    const accepted = restarted.claimWorkflowAttempt(proposal(restarted, current.root, {
      priorFailure: latestFailure(current, "test:wrong-fingerprint-evidence"),
    }));
    expect(accepted.error).toBeNull();
    expect(accepted.data?.ordinal).toBe(2);
  });

  it("reads a root stored before retry rejections existed", async () => {
    const harness = await createHarness();
    const root = openRoot(harness.service);
    let current = status(harness.service, root.rootId);
    let attempt = claimAndStart(harness.service, current.root);
    current = recordFailureAndStatus(harness.service, root.rootId, attempt.receipt);
    const secondFrame = frame({ targetVersion: "legacy-target-v2" });
    attempt = claimAndStart(harness.service, current.root, {
      frame: secondFrame,
      priorFailure: latestFailure(current, "test:legacy-evidence"),
    });
    current = recordFailureAndStatus(harness.service, root.rootId, attempt.receipt);
    expect(harness.service.claimWorkflowAttempt(proposal(harness.service, current.root, {
      frame: secondFrame,
      priorFailure: latestFailure(current, "test:legacy-evidence"),
    })).error?.code).toBe("NEW_EVIDENCE_REQUIRED");
    expect(status(harness.service, root.rootId).root.retryRejections).toHaveLength(1);

    // A root written by a deployment without the field must still load.
    closeStore(harness.store);
    const database = new DatabaseSync(harness.databasePath);
    try {
      const stored = database.prepare("SELECT root_json FROM convergence_roots WHERE root_id = ?").get(root.rootId) as { root_json: string };
      const legacy = JSON.parse(stored.root_json) as ConvergenceRootV1;
      delete legacy.retryRejections;
      database.prepare("UPDATE convergence_roots SET root_json = ? WHERE root_id = ?").run(JSON.stringify(legacy), root.rootId);
    } finally {
      database.close();
    }

    const restarted = serviceFor(harness.registryPath, trackStore(harness.databasePath));
    current = status(restarted, root.rootId);
    expect(current.root.retryRejections).toBeUndefined();
    expect(current).toMatchObject({ attemptsUsedInEpoch: 2, currentEpoch: 1 });
    expect(current.root.state).toBe("open");
  });

  it("refuses evidence burnt by an earlier rejection even in the next epoch", async () => {
    const { service } = await createHarness();
    const root = openRoot(service);
    let current = status(service, root.rootId);
    let attempt = claimAndStart(service, current.root);
    current = recordFailureAndStatus(service, root.rootId, attempt.receipt);

    const secondFrame = frame({ targetVersion: "burnt-target-v2" });
    attempt = claimAndStart(service, current.root, {
      frame: secondFrame,
      priorFailure: latestFailure(current, "test:burnt-evidence"),
    });
    current = recordFailureAndStatus(service, root.rootId, attempt.receipt);

    const rejected = service.claimWorkflowAttempt(proposal(service, current.root, {
      frame: secondFrame,
      priorFailure: latestFailure(current, "test:burnt-evidence"),
    }));
    expect(rejected.error?.code).toBe("NEW_EVIDENCE_REQUIRED");

    current = status(service, root.rootId);
    attempt = claimAndStart(service, current.root, {
      frame: frame({ targetVersion: "burnt-target-v3" }),
      priorFailure: latestFailure(current, "test:third-attempt-evidence"),
    });
    current = recordFailureAndStatus(service, root.rootId, attempt.receipt);
    expect(current).toMatchObject({ attemptsUsedInEpoch: 3 });
    expect(current.root.state).toBe("needs-review");

    const nextFrame = frame({ targetVersion: "burnt-epoch-2" });
    const resolved = service.resolveConvergenceGate({
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      expectedRevision: current.root.revision,
      review: review(
        current,
        { classification: "semantics-preserving", route: "resume-new-epoch", proposedFrame: nextFrame },
        "burnt-review",
      ),
    });
    expect(resolved.error).toBeNull();
    expect(resolved.data?.currentEpoch).toBe(2);

    current = status(service, root.rootId);
    const reopened = claimAndStart(service, current.root, { frame: nextFrame, priorFailure: null });
    current = recordFailureAndStatus(service, root.rootId, reopened.receipt);

    const recycled = service.claimWorkflowAttempt(proposal(service, current.root, {
      frame: nextFrame,
      priorFailure: latestFailure(current, "test:burnt-evidence"),
    }));
    expect(recycled.error?.code).toBe("NEW_EVIDENCE_REQUIRED");

    current = status(service, root.rootId);
    const accepted = service.claimWorkflowAttempt(proposal(service, current.root, {
      frame: nextFrame,
      priorFailure: latestFailure(current, "test:genuinely-new-evidence"),
    }));
    expect(accepted.error).toBeNull();
    expect(accepted.data?.epoch).toBe(2);
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

  it("allows only one trusted observation claim across two SQLite connections", async () => {
    const harness = await createHarness();
    const observationId = "concurrent-trusted-observation";
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const consumedAt = new Date().toISOString();
    const workers = [0, 1].map(() => new Worker(
      new URL("./fixtures/concurrent-observation-claim-worker.ts", import.meta.url),
      {
        execArgv: ["--import", "tsx"],
        workerData: { databasePath: harness.databasePath, observationId, expiresAt, consumedAt },
      },
    ));
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      const onMessage = (message: { type?: string }) => {
        if (message.type !== "ready") return;
        worker.off("message", onMessage);
        resolve();
      };
      worker.on("message", onMessage);
      worker.once("error", reject);
    })));
    const results = workers.map((worker) => new Promise<boolean>((resolve, reject) => {
      worker.once("message", (message: { type?: string; claimed?: boolean }) => {
        if (message.type === "result" && typeof message.claimed === "boolean") resolve(message.claimed);
        else reject(new Error("Observation claim worker returned an unexpected message."));
      });
      worker.once("error", reject);
    }));
    const exits = workers.map((worker) => new Promise<void>((resolve) => worker.once("exit", () => resolve())));
    workers.forEach((worker) => worker.postMessage("claim"));
    expect((await Promise.all(results)).sort()).toEqual([false, true]);
    await Promise.all(exits);
  });

  it("keeps legacy plans compatible only outside strict MCP claim and start boundaries", async () => {
    const harness = await createHarness();
    const root = openRoot(harness.service);
    const legacyProposal = proposal(harness.service, root);
    expect(legacyProposal.plan.bootstrapExecution).toBeUndefined();
    expect(harness.service.claimWorkflowAttempt(legacyProposal, true).error?.code).toBe("BINDING_REQUIRED");

    const lease = harness.service.claimWorkflowAttempt(legacyProposal).data!;
    expect(harness.service.startGuardedWorkflow({
      schemaVersion: "1.0.0",
      leaseId: lease.leaseId,
      expectedRootRevision: lease.rootRevision,
      plan: legacyProposal.plan,
    }, true).error?.code).toBe("BINDING_REQUIRED");
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

  it.each([
    { name: "needs-approval" as const, verdict: "NEEDS_APPROVAL" },
    { name: "needs-input" as const, verdict: "NEEDS_INPUT" },
    { name: "needs-redesign" as const, verdict: "NEEDS_REDESIGN" },
  ])("returns the root to the user and requires a new user contract after a $name attempt", async ({ name, verdict }) => {
    const { service } = await createHarness();
    const root = openRoot(service);
    const attempt = claimAndStart(service, root);

    const recorded = service.recordStageResult(userGateStage(attempt.receipt, verdict, name));
    expect(recorded.error).toBeNull();
    expect(recorded.data?.state).toBe(name);

    const current = status(service, root.rootId);
    expect(current.root.state).toBe("needs-user");
    expect(current.outcomes.at(-1)).toMatchObject({ ordinal: 1, state: "failed" });
    expect(current.attemptsRemainingInEpoch).toBe(2);

    const retry = service.claimWorkflowAttempt(proposal(service, current.root, {
      frame: frame({ targetVersion: `after-${name}` }),
      priorFailure: latestFailure(current, `test:${name}-evidence`),
    }));
    expect(retry.error?.code).toBe("FRAME_REVIEW_REQUIRED");
    expect(status(service, root.rootId).leases).toHaveLength(1);

    const bypass = service.resolveConvergenceGate({
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      expectedRevision: current.root.revision,
      review: review(current, {
        classification: "semantics-preserving",
        route: "resume-new-epoch",
        proposedFrame: frame({ targetVersion: `bypass-${name}` }),
      }, `review-bypass-${name}`),
    });
    expect(bypass.error?.code).toBe("INVALID_TRANSITION");

    const withoutApproval = service.openConvergenceRoot({
      schemaVersion: "1.0.0",
      parentRootId: root.rootId,
      taskEnvelope: root.taskEnvelope,
      frame: root.frame,
      userApprovalRefs: [],
    });
    expect(withoutApproval.error?.code).toBe("INVALID_INPUT");

    const approved = service.openConvergenceRoot({
      schemaVersion: "1.0.0",
      parentRootId: root.rootId,
      taskEnvelope: root.taskEnvelope,
      frame: root.frame,
      userApprovalRefs: [`user-approval:${name}`],
    });
    expect(approved.error).toBeNull();
    expect(approved.data).toMatchObject({ state: "open", currentEpoch: 1, parentRootId: root.rootId });
    expect(status(service, root.rootId).root.state).toBe("abandoned");
    expect(status(service, approved.data!.rootId).attemptsUsedInEpoch).toBe(0);
  });

  it("does not reset the attempt budget by reopening after a stop review", async () => {
    const { service } = await createHarness();
    const root = openRoot(service);
    await consumeThreeFailedAttempts(service, root, "stop-bypass");

    const gated = status(service, root.rootId);
    expect(gated.root.state).toBe("needs-review");
    const stopped = service.resolveConvergenceGate({
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      expectedRevision: gated.root.revision,
      review: review(gated, { classification: "semantics-preserving", route: "stop", proposedFrame: null }, "review-stop"),
    });
    expect(stopped.error).toBeNull();
    expect(stopped.data?.root).toMatchObject({ state: "needs-user" });

    const reopened = service.openConvergenceRoot({
      schemaVersion: "1.0.0",
      parentRootId: null,
      taskEnvelope: task({ taskId: "guarded-task-after-stop" }),
      frame: frame(),
      userApprovalRefs: [],
    });
    expect(reopened.error?.code).toBe("ROOT_CONFLICT");
    expect(reopened.error?.details).toMatchObject({ rootId: root.rootId });

    const withoutApproval = service.openConvergenceRoot({
      schemaVersion: "1.0.0",
      parentRootId: root.rootId,
      taskEnvelope: task({ taskId: "guarded-task-after-stop" }),
      frame: frame(),
      userApprovalRefs: [],
    });
    expect(withoutApproval.error?.code).toBe("INVALID_INPUT");

    const approved = service.openConvergenceRoot({
      schemaVersion: "1.0.0",
      parentRootId: root.rootId,
      taskEnvelope: task({ taskId: "guarded-task-after-stop" }),
      frame: frame(),
      userApprovalRefs: ["user-approval:recontract-after-stop"],
    });
    expect(approved.error).toBeNull();
    expect(approved.data).toMatchObject({ state: "open", currentEpoch: 1, parentRootId: root.rootId });
    expect(status(service, approved.data!.rootId).attemptsUsedInEpoch).toBe(0);
    expect(status(service, root.rootId).root.state).toBe("abandoned");
  });

  it("treats a sibling-path rescope of the same write surface as the same root", async () => {
    const { service } = await createHarness();
    const root = openRoot(service);

    const rescoped = service.openConvergenceRoot({
      schemaVersion: "1.0.0",
      parentRootId: null,
      taskEnvelope: task({ taskId: "guarded-task-rescoped", included: ["sibling/src/candidate.ts"] }),
      frame: frame(),
      userApprovalRefs: [],
    });
    expect(rescoped.error?.code).toBe("ROOT_CONFLICT");
    expect(rescoped.error?.details).toMatchObject({ rootId: root.rootId });

    const rescopedWithWorkUnits = service.openConvergenceRoot({
      schemaVersion: "1.0.0",
      parentRootId: null,
      taskEnvelope: task({
        taskId: "guarded-task-rescoped-units",
        included: ["sibling/src/candidate.ts"],
        writeTargets: ["sibling/src/candidate.ts"],
      }),
      frame: frame(),
      userApprovalRefs: [],
    });
    expect(rescopedWithWorkUnits.error?.code).toBe("ROOT_CONFLICT");
  });

  it("opens a second root for unrelated work that shares only the control frame", async () => {
    const { service } = await createHarness();
    openRoot(service);

    const unrelated = service.openConvergenceRoot({
      schemaVersion: "1.0.0",
      parentRootId: null,
      taskEnvelope: task({
        taskId: "docs-task",
        included: ["docs/guide.md"],
        writeTargets: ["docs/guide.md"],
      }),
      frame: frame({ targetLocator: "docs/guide.md" }),
      userApprovalRefs: [],
    });
    expect(unrelated.error).toBeNull();
    expect(unrelated.data).toMatchObject({ state: "open", currentEpoch: 1 });
  });
});

/** A hand-written Git layout: one main checkout and linked worktrees that share its common dir. */
async function gitFixture(): Promise<{ base: string; main: string; worktree: (name: string, parent?: string) => Promise<string> }> {
  const base = await mkdtemp(join(tmpdir(), "convergence-identity-"));
  temporaryDirectories.push(base);
  const main = join(base, "main");
  await mkdir(join(main, ".git"), { recursive: true });
  return {
    base,
    main,
    worktree: async (name, parent = base) => {
      const checkout = join(parent, name);
      const gitDir = join(main, ".git", "worktrees", name);
      await mkdir(checkout, { recursive: true });
      await mkdir(gitDir, { recursive: true });
      await writeFile(join(checkout, ".git"), `gitdir: ${gitDir}\n`, "utf8");
      await writeFile(join(gitDir, "commondir"), "../..\n", "utf8");
      await writeFile(join(gitDir, "gitdir"), `${join(checkout, ".git")}\n`, "utf8");
      return checkout;
    },
  };
}

/** A stored root is only backfilled from what exists, so legacy fixtures need their target files. */
async function touch(...segments: string[]): Promise<void> {
  const target = join(...segments);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, "", "utf8");
}

function frameAt(locator: string, workspaceId: string, targetLocator = "src/candidate.ts"): ConvergenceFrameV1 {
  return { ...frame({ workspaceId, targetLocator }), workspace: { workspaceId, locator } };
}

function taskFor(taskId: string, entry = "src/candidate.ts"): TaskEnvelopeV1 {
  return task({ taskId, included: [entry], writeTargets: [entry] });
}

function tryOpen(
  service: WorkflowService,
  envelope: TaskEnvelopeV1,
  convergenceFrame: ConvergenceFrameV1,
  parentRootId: string | null = null,
): ReturnType<WorkflowService["openConvergenceRoot"]> {
  return service.openConvergenceRoot({
    schemaVersion: "1.0.0",
    parentRootId,
    taskEnvelope: envelope,
    frame: convergenceFrame,
    userApprovalRefs: parentRootId ? ["user-approval:replacement"] : [],
  });
}

function gateRoot(service: WorkflowService, root: ConvergenceRootV1): void {
  const attempt = claimAndStart(service, root);
  expect(service.recordStageResult(userGateStage(attempt.receipt, "NEEDS_INPUT", "needs-input")).error).toBeNull();
  expect(status(service, root.rootId).root.state).toBe("needs-user");
}

/** What an older server leaves behind: the roots, but no derived identity rows. */
function dropIdentities(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000; DELETE FROM convergence_root_identities;");
  } finally {
    database.close();
  }
}

/** Three failed attempts in the root's own workspace leave it in needs-review. */
function failIntoReview(service: WorkflowService, root: ConvergenceRootV1): ConvergenceStatusV1 {
  let current = status(service, root.rootId);
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const targetFrame = ordinal === 1 ? current.root.frame : {
      ...frame({ targetVersion: `review-${ordinal}`, targetLocator: root.frame.targetArtifacts[0]!.locator }),
      workspace: root.frame.workspace,
    };
    const priorFailure = ordinal === 1 ? null : latestFailure(current, `review-evidence-${ordinal}`);
    const started = claimAndStart(service, current.root, { frame: targetFrame, priorFailure });
    current = recordFailureAndStatus(service, root.rootId, started.receipt);
  }
  expect(current.root.state).toBe("needs-review");
  return current;
}

function identityRows(databasePath: string): Array<{ root_id: string; replacement_match: string | null }> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT root_id, replacement_match FROM convergence_root_identities ORDER BY root_id")
      .all() as unknown as Array<{ root_id: string; replacement_match: string | null }>;
  } finally {
    database.close();
  }
}

describe("server-derived workspace identity", () => {
  it.each([
    { entry: ".worktrees", reverse: false },
    { entry: ".worktrees/*/src/candidate.ts", reverse: false },
    { entry: ".worktrees", reverse: true },
    { entry: ".worktrees/*/src/candidate.ts", reverse: true },
  ])("checks nested checkout containers sharing a repository ($entry, reverse=$reverse)", async ({ entry, reverse }) => {
    const { service } = await createHarness();
    const git = await gitFixture();
    await git.worktree("nested", join(git.main, ".worktrees"));
    const external = await git.worktree("external");
    const gated = reverse
      ? openRoot(service, taskFor("gated-container", entry), frameAt(git.main, "main", entry))
      : openRoot(service, taskFor("gated-external"), frameAt(external, "external"));
    gateRoot(service, gated);
    const result = reverse
      ? tryOpen(service, taskFor("external-candidate"), frameAt(external, "external"))
      : tryOpen(service, taskFor("nested-container", entry), frameAt(git.main, "main", entry));
    expect(result.error?.code).toBe("ROOT_CONFLICT");
    expect(result.error?.details).toMatchObject({ rootId: gated.rootId, conflictKind: "lineage" });
    if (!reverse) {
      await mkdir(join(git.main, "unrelated"));
      expect(tryOpen(service, taskFor("same-repo-unrelated", "unrelated"), frameAt(git.main, "main", "unrelated")).error).toBeNull();
    }
  });
  it.each([
    { adminName: "admin", nested: false },
    { adminName: ".git", nested: false },
    { adminName: "admin", nested: true },
    { adminName: ".git", nested: true },
  ])("blocks checkout containers across separate gitdir layouts ($adminName, nested=$nested)", async ({ adminName, nested }) => {
    const harness = await createHarness();
    const fixture = await gitFixture();
    const container = nested ? join(fixture.main, "vendor") : join(fixture.base, "plain");
    const original = join(container, "original");
    const admin = join(fixture.base, "administration", adminName);
    await mkdir(container, { recursive: true });
    await mkdir(join(fixture.base, "administration"), { recursive: true });
    const initialized = spawnSync("git", ["init", "--separate-git-dir", admin, original], {
      encoding: "utf8", windowsHide: true, timeout: 10_000,
    });
    expect(initialized.status, initialized.stderr).toBe(0);
    const linked = join(fixture.base, "linked");
    const linkedAdmin = join(admin, "worktrees", "linked");
    await mkdir(linked, { recursive: true });
    await mkdir(linkedAdmin, { recursive: true });
    await writeFile(join(linked, ".git"), `gitdir: ${linkedAdmin}\n`, "utf8");
    await writeFile(join(linkedAdmin, "commondir"), "../..\n", "utf8");
    await writeFile(join(linkedAdmin, "gitdir"), `${join(linked, ".git")}\n`, "utf8");
    const gated = openRoot(harness.service, taskFor("gated-linked"), frameAt(linked, "linked"));
    gateRoot(harness.service, gated);
    for (const entry of [".", "*/src/candidate.ts"]) {
      const result = tryOpen(harness.service, taskFor(`container-${entry}`, entry), frameAt(container, "container", entry));
      expect(result.error?.code).toBe("ROOT_CONFLICT");
      expect(result.error?.details?.rootId).toBe(gated.rootId);
    }
    // Concrete unrelated files remain usable even when their repository differs.
    const unrelated = await gitFixture();
    await mkdir(join(unrelated.main, "src"));
    await writeFile(join(unrelated.main, "src", "candidate.ts"), "synthetic\n", "utf8");
    expect(tryOpen(harness.service, taskFor("unrelated-file"), frameAt(unrelated.main, "unrelated")).error).toBeNull();
    await mkdir(join(unrelated.main, "docs"));
    expect(tryOpen(harness.service, taskFor("unrelated-directory", "docs"), frameAt(unrelated.main, "unrelated-dir", "docs")).error).toBeNull();
    await mkdir(join(unrelated.main, "inaccessible"));
    const realOpen = fs.opendirSync;
    const denied = vi.spyOn(fs, "opendirSync").mockImplementation((path, ...options) => {
      if (String(path).endsWith("inaccessible")) throw new Error("EACCES");
      return realOpen(path, ...options);
    });
    try {
      const unknown = tryOpen(harness.service, taskFor("unknown-directory", "inaccessible"), frameAt(unrelated.main, "unknown-dir", "inaccessible"));
      expect(unknown.error?.code).toBe("ROOT_CONFLICT");
      expect(unknown.error?.details?.rootId).toBe(gated.rootId);
    } finally { denied.mockRestore(); }
  });
  it("rejects the same physical target under a changed workspace id and locator", async () => {
    const { service } = await createHarness();
    const git = await gitFixture();
    const root = openRoot(service, taskFor("owner"), frameAt(git.main, "workspace-main"));

    const subfolder = tryOpen(service, taskFor("alias-subfolder", "candidate.ts"), frameAt(join(git.main, "src"), "workspace-sub", "candidate.ts"));
    expect(subfolder.error?.code).toBe("ROOT_CONFLICT");
    expect(subfolder.error?.details).toMatchObject({
      rootId: root.rootId,
      blockerState: "open",
      conflictKind: "physical",
      requestedEntry: "candidate.ts",
      existingEntry: "src/candidate.ts",
      conservativeExpansion: [],
    });

    const parentFolder = tryOpen(
      service,
      taskFor("alias-parent", "main/src/candidate.ts"),
      frameAt(git.base, "workspace-base", "main/src/candidate.ts"),
    );
    expect(parentFolder.error?.code).toBe("ROOT_CONFLICT");
    expect(parentFolder.error?.details).toMatchObject({ rootId: root.rootId, conflictKind: "physical" });

  });

  it("rejects the same physical target reached through a junction or symlink", async (context) => {
    const { service } = await createHarness();
    const git = await gitFixture();
    const root = openRoot(service, taskFor("owner"), frameAt(git.main, "workspace-main"));
    const link = join(git.base, "alias");
    try {
      await symlink(git.main, link, "junction");
    } catch {
      context.skip(); // the platform refuses links
    }
    const junction = tryOpen(service, taskFor("alias-junction"), frameAt(link, "workspace-junction"));
    expect(junction.error?.code).toBe("ROOT_CONFLICT");
    expect(junction.error?.details).toMatchObject({ rootId: root.rootId, conflictKind: "physical" });
  });

  it("keeps open roots of different checkouts independent even on the same relative path", async () => {
    const { service } = await createHarness();
    const git = await gitFixture();
    openRoot(service, taskFor("in-main"), frameAt(git.main, "workspace-main"));
    const sibling = tryOpen(service, taskFor("in-worktree"), frameAt(await git.worktree("w1"), "workspace-w1"));
    expect(sibling.error).toBeNull();
    expect(sibling.data).toMatchObject({ state: "open" });
  });

  it("keeps a gated root blocking its relative surface in every checkout of the repository", async () => {
    const { service } = await createHarness();
    const git = await gitFixture();
    const gated = openRoot(service, taskFor("gated"), frameAt(await git.worktree("w1"), "workspace-w1"));
    gateRoot(service, gated);
    const second = await git.worktree("w2");

    const sibling = tryOpen(service, taskFor("sibling"), frameAt(second, "workspace-w2"));
    expect(sibling.error?.code).toBe("ROOT_CONFLICT");
    expect(sibling.error?.details).toMatchObject({ rootId: gated.rootId, blockerState: "needs-user", conflictKind: "lineage" });

    const viaParentFolder = tryOpen(
      service,
      taskFor("sibling-parent-locator", "w2/src/candidate.ts"),
      frameAt(git.base, "workspace-base", "w2/src/candidate.ts"),
    );
    expect(viaParentFolder.error?.code).toBe("ROOT_CONFLICT");
    expect(viaParentFolder.error?.details).toMatchObject({ rootId: gated.rootId, conflictKind: "lineage" });

    const unrelated = tryOpen(service, taskFor("sibling-docs", "docs/guide.md"), frameAt(second, "workspace-w2", "docs/guide.md"));
    expect(unrelated.error).toBeNull();

    const reviewed = openRoot(service, taskFor("reviewed", "lib/reviewed.ts"), frameAt(join(git.base, "w1"), "workspace-w1", "lib/reviewed.ts"));
    failIntoReview(service, reviewed);
    const pastReview = tryOpen(service, taskFor("past-review", "lib/reviewed.ts"), frameAt(second, "workspace-w2", "lib/reviewed.ts"));
    expect(pastReview.error?.details).toMatchObject({ rootId: reviewed.rootId, blockerState: "needs-review", conflictKind: "lineage" });
  });

  it("blocks a non-Git folder or glob that holds a sibling checkout of a gated root's repository", async () => {
    const { service } = await createHarness();
    const git = await gitFixture();
    const gated = openRoot(service, taskFor("gated"), frameAt(await git.worktree("w1"), "workspace-w1"));
    gateRoot(service, gated);
    const elsewhere = await mkdtemp(join(tmpdir(), "convergence-elsewhere-"));
    temporaryDirectories.push(elsewhere);
    await git.worktree("w2", elsewhere);

    for (const entry of [".", "*/src/candidate.ts"]) {
      const covering = tryOpen(service, taskFor(`covering-${entry.length}`, entry), frameAt(elsewhere, "workspace-elsewhere", entry));
      expect(covering.error?.code).toBe("ROOT_CONFLICT");
      expect(covering.error?.details).toMatchObject({ rootId: gated.rootId, conflictKind: "lineage" });
    }

    const unrelatedFolder = await mkdtemp(join(tmpdir(), "convergence-unrelated-"));
    temporaryDirectories.push(unrelatedFolder);
    expect(tryOpen(service, taskFor("unrelated-folder", "."), frameAt(unrelatedFolder, "workspace-unrelated", ".")).error).toBeNull();

    // A partial registration is not absence evidence; bounded inspection independently proves this empty folder unrelated.
    await writeFile(join(git.main, ".git", "worktrees", "w2", "gitdir"), "\n", "utf8");
    const otherFolder = await mkdtemp(join(tmpdir(), "convergence-unrelated-"));
    temporaryDirectories.push(otherFolder);
    const partial = tryOpen(service, taskFor("partial-listing", "."), frameAt(otherFolder, "workspace-other", "."));
    expect(partial.error).toBeNull();
    expect(tryOpen(service, taskFor("plain-file"), frameAt(join(git.base, "new-plain-folder"), "workspace-other")).error).toBeNull();
  });

  it("follows the write surface of a stored root after a review replaces its frame", async () => {
    const harness = await createHarness();
    const root = openRoot(harness.service);
    const current = await consumeThreeFailedAttempts(harness.service, root, "moved-target");
    const before = identityRows(harness.databasePath);
    const moved = harness.service.resolveConvergenceGate({
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      expectedRevision: current.root.revision,
      review: review(current, {
        classification: "semantics-preserving",
        route: "resume-new-epoch",
        proposedFrame: frame({ targetVersion: "moved-target-epoch-2", targetLocator: "src/other.ts" }),
      }, "review-moved-target"),
    });
    expect(moved.error).toBeNull();
    const storedRoot = status(harness.service, root.rootId).root;

    const onMovedTarget = tryOpen(harness.service, taskFor("on-moved-target", "src/other.ts"), frame({ targetLocator: "src/other.ts" }));
    expect(onMovedTarget.error?.code).toBe("ROOT_CONFLICT");
    expect(onMovedTarget.error?.details).toMatchObject({ rootId: root.rootId, conflictKind: "physical", existingEntry: "src/other.ts" });
    // Refreshing the derived identity leaves the root and its digests exactly as the review stored them.
    expect(status(harness.service, root.rootId).root).toEqual(storedRoot);
    expect(identityRows(harness.databasePath)).toEqual(before);
  });

  it("replaces the gated root of a deleted worktree from a sibling checkout", async () => {
    const harness = await createHarness();
    const git = await gitFixture();
    const removed = await git.worktree("w1");
    const gated = openRoot(harness.service, taskFor("gated"), frameAt(removed, "workspace-w1"));
    gateRoot(harness.service, gated);
    await rm(removed, { recursive: true, force: true });
    await rm(join(git.main, ".git", "worktrees", "w1"), { recursive: true, force: true });

    const other = await gitFixture();
    const foreign = tryOpen(harness.service, taskFor("foreign"), frameAt(other.main, "workspace-foreign"), gated.rootId);
    expect(foreign.error?.code).toBe("INVALID_INPUT");
    expect(foreign.error?.message).toContain("same workspace");
    expect(status(harness.service, gated.rootId).root.state).toBe("needs-user");

    const replacement = tryOpen(harness.service, taskFor("replacement"), frameAt(await git.worktree("w2"), "workspace-w2"), gated.rootId);
    expect(replacement.error).toBeNull();
    expect(status(harness.service, gated.rootId).root.state).toBe("abandoned");
    expect(identityRows(harness.databasePath)).toContainEqual({ root_id: replacement.data!.rootId, replacement_match: "lineage" });
  });

  it("lets two gated roots be replaced without blocking each other, but not widened or rescoped past a gate", async () => {
    const { service } = await createHarness();
    const git = await gitFixture();
    const first = await git.worktree("w1");
    const second = await git.worktree("w2");
    const left = openRoot(service, taskFor("left"), frameAt(first, "workspace-w1"));
    const right = openRoot(service, taskFor("right"), frameAt(second, "workspace-w2"));
    const docs = openRoot(service, taskFor("docs", "docs/guide.md"), frameAt(first, "workspace-w1", "docs/guide.md"));
    gateRoot(service, left);
    gateRoot(service, right);
    gateRoot(service, docs);

    const rescoped = tryOpen(service, taskFor("docs-rescoped"), frameAt(await git.worktree("w3"), "workspace-w3"), docs.rootId);
    expect(rescoped.error?.code).toBe("ROOT_CONFLICT");
    expect(rescoped.error?.details).toMatchObject({ conflictKind: "lineage", blockerState: "needs-user" });
    expect(status(service, docs.rootId).root.state).toBe("needs-user");

    const replacedLeft = tryOpen(service, taskFor("left-again"), frameAt(first, "workspace-w1"), left.rootId);
    expect(replacedLeft.error).toBeNull();
    const replacedRight = tryOpen(service, taskFor("right-again"), frameAt(second, "workspace-w2"), right.rootId);
    expect(replacedRight.error).toBeNull();
    expect(status(service, left.rootId).root.state).toBe("abandoned");
    expect(status(service, right.rootId).root.state).toBe("abandoned");
  });

  it("identifies a gitdir without commondir and rejects damaged Git evidence", async () => {
    const { service } = await createHarness();
    const git = await gitFixture();
    const submodule = join(git.main, "vendor", "sub");
    await mkdir(submodule, { recursive: true });
    await mkdir(join(git.main, ".git", "modules", "sub"), { recursive: true });
    await writeFile(join(submodule, ".git"), "gitdir: ../../.git/modules/sub\n", "utf8");
    expect(tryOpen(service, taskFor("submodule"), frameAt(submodule, "workspace-sub")).error).toBeNull();

    const damaged = join(git.base, "damaged");
    await mkdir(damaged, { recursive: true });
    await writeFile(join(damaged, ".git"), "not a git pointer\n", "utf8");
    const rejected = tryOpen(service, taskFor("damaged"), frameAt(damaged, "workspace-damaged"));
    expect(rejected.error?.code).toBe("INVALID_INPUT");
    expect(rejected.error?.details).toMatchObject({ reason: "WORKSPACE_IDENTITY_UNRESOLVED" });
  });

  it("widens globs conservatively and rejects scope entries that are not paths", async () => {
    const { service } = await createHarness();
    const git = await gitFixture();
    const globbed = openRoot(service, taskFor("globbed", "src/**"), frameAt(git.main, "workspace-main", "src/**"));
    const inside = tryOpen(service, taskFor("inside"), frameAt(git.main, "workspace-main"));
    expect(inside.error?.code).toBe("ROOT_CONFLICT");
    expect(inside.error?.details).toMatchObject({ rootId: globbed.rootId, conservativeExpansion: ["glob-prefix"] });
    expect(tryOpen(service, taskFor("outside", "docs/guide.md"), frameAt(git.main, "workspace-main", "docs/guide.md")).error).toBeNull();

    const checkout = await git.worktree("w1");
    const everything = openRoot(service, taskFor("everything", "**/*.ts"), frameAt(join(checkout, "src"), "workspace-w1-src", "**/*.ts"));
    const elsewhere = tryOpen(service, taskFor("elsewhere", "docs/guide.md"), frameAt(checkout, "workspace-w1", "docs/guide.md"));
    expect(elsewhere.error?.details).toMatchObject({ rootId: everything.rootId, conservativeExpansion: ["leading-glob"] });

    for (const entry of ["https://example.com/candidate.ts", "src/candi\u0000date.ts"]) {
      const rejected = tryOpen(service, taskFor("not-a-path", entry), frameAt(git.main, "workspace-main", "docs/other.md"));
      expect(rejected.error?.code).toBe("INVALID_INPUT");
      expect(rejected.error?.details).toMatchObject({ reason: "UNSUPPORTED_SCOPE_ENTRY" });
    }
  });

  it("backfills identities for stored roots without rewriting them and treats legacy URI scope as the whole workspace", async () => {
    const harness = await createHarness();
    const git = await gitFixture();
    const stored = openRoot(harness.service, taskFor("stored"), frameAt(git.main, "workspace-main"));
    await touch(git.main, "src", "candidate.ts");
    const legacyWorkspace = await git.worktree("w1");
    await touch(legacyWorkspace, "docs", "legacy.md");
    const legacy = openRoot(harness.service, taskFor("legacy", "docs/legacy.md"), frameAt(legacyWorkspace, "workspace-w1", "docs/legacy.md"));
    closeStore(harness.store);

    // A database written before identities existed: no identity rows, and one root whose scope holds a URI.
    const database = new DatabaseSync(harness.databasePath);
    const legacyJson = JSON.stringify({
      ...legacy,
      taskEnvelope: { ...legacy.taskEnvelope, scope: { ...legacy.taskEnvelope.scope, included: ["https://example.com/spec"] } },
    });
    database.prepare("UPDATE convergence_roots SET root_json = ? WHERE root_id = ?").run(legacyJson, legacy.rootId);
    database.exec("DELETE FROM convergence_root_identities;");
    const before = database.prepare("SELECT root_id, root_json, revision FROM convergence_roots ORDER BY root_id").all();
    database.close();

    const store = trackStore(harness.databasePath);
    const service = serviceFor(harness.registryPath, store);

    // A request that fails inside the insert transaction rolls the backfill back with it.
    const damaged = join(git.base, "damaged");
    await mkdir(damaged, { recursive: true });
    await writeFile(join(damaged, ".git"), "not a git pointer\n", "utf8");
    expect(tryOpen(service, taskFor("damaged"), frameAt(damaged, "workspace-damaged")).error?.code).toBe("INVALID_INPUT");
    expect(identityRows(harness.databasePath)).toHaveLength(0);

    const blocked = tryOpen(service, taskFor("after-legacy", "src/other.ts"), frameAt(legacyWorkspace, "workspace-w1", "src/other.ts"));
    expect(blocked.error?.code).toBe("ROOT_CONFLICT");
    expect(blocked.error?.details).toMatchObject({ rootId: legacy.rootId, conservativeExpansion: ["legacy-unsupported"] });
    expect(identityRows(harness.databasePath).map((row) => row.root_id).sort()).toEqual([legacy.rootId, stored.rootId].sort());

    expect(tryOpen(service, taskFor("unrelated", "docs/guide.md"), frameAt(git.main, "workspace-main", "docs/guide.md")).error).toBeNull();
    expect(identityRows(harness.databasePath)).toHaveLength(3);

    const verify = new DatabaseSync(harness.databasePath, { readOnly: true });
    const after = verify.prepare("SELECT root_id, root_json, revision FROM convergence_roots WHERE root_id IN (?, ?) ORDER BY root_id")
      .all(legacy.rootId, stored.rootId);
    const schemaVersion = (verify.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    verify.close();
    expect(after).toEqual(before);
    expect(schemaVersion).toBe(5);
  });

  it("admits only one of two connections that open the same target at once", async () => {
    const donor = await createHarness();
    const git = await gitFixture();
    const template = openRoot(donor.service, taskFor("racing"), frameAt(git.main, "workspace-main"));
    const harness = await createHarness();
    const earlier = await git.worktree("w1");
    await touch(earlier, "src", "candidate.ts");
    openRoot(harness.service, taskFor("stored-earlier"), frameAt(earlier, "workspace-w1"));
    dropIdentities(harness.databasePath);

    const source = `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const { SqliteWorkflowStore } = await require("tsx/esm/api").tsImport(workerData.storeUrl, workerData.parentUrl);
        const store = new SqliteWorkflowStore(workerData.databasePath);
        parentPort.postMessage({ type: "ready" });
        parentPort.once("message", () => {
          let result;
          try {
            result = { inserted: store.insertConvergenceRoot(workerData.root) === null, error: null };
          } catch (error) {
            result = { inserted: false, error: String(error && error.message) };
          }
          store.close();
          parentPort.postMessage({ type: "result", result });
        });
      })();
    `;
    const workers = ["a", "b"].map((suffix) => new Worker(source, {
      eval: true,
      workerData: {
        storeUrl: new URL("../../mcp-server/src/sqlite-workflow-store.ts", import.meta.url).href,
        parentUrl: import.meta.url,
        databasePath: harness.databasePath,
        root: { ...template, rootId: `${template.rootId}-${suffix}` },
      },
    }));
    const message = <T>(worker: Worker, type: string): Promise<T> => new Promise((resolve, reject) => {
      const onMessage = (value: { type?: string; result?: T }) => {
        if (value.type !== type) return;
        worker.off("message", onMessage);
        resolve(value.result as T);
      };
      worker.on("message", onMessage);
      worker.once("error", reject);
    });
    await Promise.all(workers.map((worker) => message<void>(worker, "ready")));
    const results = workers.map((worker) => message<{ inserted: boolean; error: string | null }>(worker, "result"));
    const exits = workers.map((worker) => new Promise<void>((resolve) => worker.once("exit", () => resolve())));
    workers.forEach((worker) => worker.postMessage("open"));
    const outcomes = await Promise.all(results);
    await Promise.all(exits);

    expect(outcomes.map((outcome) => outcome.error)).toEqual([null, null]);
    expect(outcomes.filter((outcome) => outcome.inserted)).toHaveLength(1);
    expect(identityRows(harness.databasePath)).toHaveLength(2); // the backfilled root and the single winner
  });
});

describe("gated roots stored before identities existed", () => {
  it.each([
    { name: "deleted", damage: async (checkout: string, gitDir: string) => {
      await rm(checkout, { recursive: true, force: true });
      await rm(gitDir, { recursive: true, force: true });
    } },
    { name: "damaged", damage: async (checkout: string) => writeFile(join(checkout, ".git"), "not a git pointer\n", "utf8") },
  ])("does not let a sibling worktree bypass a gated legacy root whose checkout is $name", async ({ damage }) => {
    const harness = await createHarness();
    const git = await gitFixture();
    const checkout = await git.worktree("w1");
    const gated = openRoot(harness.service, taskFor("legacy-gated"), frameAt(checkout, "workspace-w1"));
    gateRoot(harness.service, gated);
    dropIdentities(harness.databasePath);
    await damage(checkout, join(git.main, ".git", "worktrees", "w1"));

    const sibling = tryOpen(harness.service, taskFor("sibling"), frameAt(await git.worktree("w2"), "workspace-w2"));
    expect(sibling.error?.code).toBe("ROOT_CONFLICT");
    expect(sibling.error?.details).toMatchObject({
      rootId: gated.rootId,
      blockerState: "needs-user",
      conflictKind: "lineage-unresolved",
      reason: "WORKSPACE_IDENTITY_UNRESOLVED",
    });
    expect(identityRows(harness.databasePath)).toHaveLength(0);

    // Outside any repository the new root cannot share the unknown lineage.
    const plain = await mkdtemp(join(tmpdir(), "convergence-plain-"));
    temporaryDirectories.push(plain);
    expect(tryOpen(harness.service, taskFor("plain"), frameAt(plain, "workspace-plain")).error).toBeNull();
    const plainFolder = tryOpen(harness.service, taskFor("plain-folder", "."), frameAt(await mkdtemp(join(plain, "nested-")), "workspace-plain-folder", "."));
    expect(plainFolder.error?.details).toMatchObject({ rootId: gated.rootId, conflictKind: "lineage-unresolved" });

    // Lineage cannot be verified, so only a replacement bound to the same physical workspace is accepted.
    const lineageReplacement = tryOpen(harness.service, taskFor("from-sibling"), frameAt(join(git.base, "w2"), "workspace-w2"), gated.rootId);
    expect(lineageReplacement.error?.code).toBe("INVALID_INPUT");
    expect(lineageReplacement.error?.details).toMatchObject({ reason: "WORKSPACE_IDENTITY_UNRESOLVED" });
    expect(status(harness.service, gated.rootId).root.state).toBe("needs-user");
  });

  it("does not store a guessed identity for a legacy root under a non-Git parent locator whose checkout is gone", async () => {
    const harness = await createHarness();
    const git = await gitFixture();
    const checkout = await git.worktree("w1");
    const gated = openRoot(
      harness.service,
      taskFor("legacy-parent-locator", "w1/src/candidate.ts"),
      frameAt(git.base, "workspace-base", "w1/src/candidate.ts"),
    );
    gateRoot(harness.service, gated);
    dropIdentities(harness.databasePath);
    await rm(checkout, { recursive: true, force: true });
    await rm(join(git.main, ".git", "worktrees", "w1"), { recursive: true, force: true });

    const sibling = tryOpen(harness.service, taskFor("sibling"), frameAt(await git.worktree("w2"), "workspace-w2"));
    expect(sibling.error?.code).toBe("ROOT_CONFLICT");
    expect(sibling.error?.details).toMatchObject({ rootId: gated.rootId, conflictKind: "lineage-unresolved" });
    expect(identityRows(harness.databasePath)).toHaveLength(0);
  });

  async function removeWorktree(git: Awaited<ReturnType<typeof gitFixture>>, checkout: string, name: string): Promise<void> {
    await rm(checkout, { recursive: true, force: true });
    await rm(join(git.main, ".git", "worktrees", name), { recursive: true, force: true });
  }

  it.each([
    { name: "a target inside the nested worktree", locator: "checkout" as const, entry: "src/candidate.ts" },
    { name: "the nested worktree itself as '.'", locator: "checkout" as const, entry: "." },
    { name: "the nested worktree named from the outer checkout", locator: "main" as const, entry: ".worktrees/w1" },
  ])("does not guess an identity for a legacy gated root on $name once that worktree is deleted", async ({ locator, entry }) => {
    const harness = await createHarness();
    const git = await gitFixture();
    const nested = join(git.main, ".worktrees");
    const checkout = await git.worktree("w1", nested);
    await touch(checkout, "src", "candidate.ts");
    const gated = openRoot(harness.service, taskFor("legacy-nested", entry), frameAt(locator === "main" ? git.main : checkout, "workspace-w1", entry));
    gateRoot(harness.service, gated);
    dropIdentities(harness.databasePath);
    await removeWorktree(git, checkout, "w1");

    const sibling = tryOpen(harness.service, taskFor("sibling"), frameAt(await git.worktree("w2", nested), "workspace-w2"));
    expect(sibling.error?.code).toBe("ROOT_CONFLICT");
    expect(sibling.error?.details).toMatchObject({ rootId: gated.rootId, conflictKind: "lineage-unresolved" });
    expect(identityRows(harness.databasePath)).toHaveLength(0);
    const kept = status(harness.service, gated.rootId).root;
    expect({ frame: kept.frame, taskEnvelope: kept.taskEnvelope, frameDigest: kept.frameDigest, taskDigest: kept.taskDigest })
      .toEqual({ frame: gated.frame, taskEnvelope: gated.taskEnvelope, frameDigest: gated.frameDigest, taskDigest: gated.taskDigest });
  });

  it("backfills a legacy root whose target exists and leaves one whose target file was never written unresolved", async () => {
    const harness = await createHarness();
    const git = await gitFixture();
    const checkout = await git.worktree("w1", join(git.main, ".worktrees"));
    await touch(checkout, "src", "candidate.ts");
    const written = openRoot(harness.service, taskFor("written"), frameAt(checkout, "workspace-w1"));
    const unwritten = openRoot(harness.service, taskFor("unwritten", "src/later.ts"), frameAt(checkout, "workspace-w1", "src/later.ts"));
    dropIdentities(harness.databasePath);

    expect(tryOpen(harness.service, taskFor("elsewhere", "docs/guide.md"), frameAt(checkout, "workspace-w1", "docs/guide.md")).error).toBeNull();
    const rows = identityRows(harness.databasePath).map((row) => row.root_id);
    expect(rows).toContain(written.rootId);
    expect(rows).not.toContain(unwritten.rootId);
    // Unresolved is not unblocked: the same target still conflicts physically.
    expect(tryOpen(harness.service, taskFor("again", "src/later.ts"), frameAt(checkout, "workspace-w1", "src/later.ts")).error?.details)
      .toMatchObject({ rootId: unwritten.rootId, conflictKind: "physical" });
  });

  it("keeps a checkout observed for the current inputs after it is deleted, surface by surface", async () => {
    const harness = await createHarness();
    const git = await gitFixture();
    const nested = join(git.main, ".worktrees");
    const checkout = await git.worktree("w1", nested);
    await mkdir(join(git.base, "notes"), { recursive: true });

    // Mixed observation: one surface inside the nested worktree, one outside every checkout.
    const inside = "main/.worktrees/w1/src/candidate.ts";
    const mixed = openRoot(
      harness.service,
      task({ taskId: "mixed", included: [inside, "notes/plan.md"], writeTargets: [inside] }),
      frameAt(git.base, "workspace-base", inside),
    );
    gateRoot(harness.service, mixed);
    await removeWorktree(git, checkout, "w1");

    const pastMixed = tryOpen(harness.service, taskFor("past-mixed"), frameAt(await git.worktree("w2", nested), "workspace-w2"));
    expect(pastMixed.error?.details).toMatchObject({ rootId: mixed.rootId, conflictKind: "lineage", existingEntry: inside });
  });

  it("does not reuse an identity observed for a replaced frame, and grants no legacy exception for it", async () => {
    const harness = await createHarness();
    const git = await gitFixture();
    const nested = join(git.main, ".worktrees");
    const second = await git.worktree("w3", nested);
    const reframed = openRoot(harness.service, taskFor("reframed", "lib/first.ts"), frameAt(second, "workspace-w3", "lib/first.ts"));
    const reviewed = failIntoReview(harness.service, reframed);
    const moved = harness.service.resolveConvergenceGate({
      schemaVersion: "1.0.0",
      rootId: reframed.rootId,
      expectedRevision: reviewed.root.revision,
      review: review(reviewed, {
        classification: "semantics-preserving",
        route: "resume-new-epoch",
        proposedFrame: { ...frame({ targetVersion: "reframed-epoch-2", targetLocator: "lib/second.ts" }), workspace: reframed.frame.workspace },
      }, "review-reframed"),
    });
    expect(moved.error).toBeNull();
    gateRoot(harness.service, moved.data!.root);

    await removeWorktree(git, second, "w3");
    const sibling = await git.worktree("w2", nested);

    // The reframed root was never observed for its new inputs: unknown, not guessed, and no legacy exception.
    const pastReframed = tryOpen(harness.service, taskFor("past-reframed", "lib/second.ts"), frameAt(sibling, "workspace-w2", "lib/second.ts"));
    expect(pastReframed.error?.details).toMatchObject({ rootId: reframed.rootId, conflictKind: "lineage-unresolved" });
    const sameName = tryOpen(harness.service, taskFor("same-name", "lib/second.ts"), frameAt(second, "workspace-w3", "lib/second.ts"), reframed.rootId);
    expect(sameName.error?.code).toBe("INVALID_INPUT");
    expect(sameName.error?.details).toMatchObject({ reason: "WORKSPACE_IDENTITY_UNRESOLVED" });
  });

  it("still replaces a gated legacy root of a deleted checkout when the same workspace is named", async () => {
    const harness = await createHarness();
    const git = await gitFixture();
    const checkout = await git.worktree("w1");
    const gated = openRoot(harness.service, taskFor("legacy-gated"), frameAt(checkout, "workspace-w1"));
    gateRoot(harness.service, gated);
    dropIdentities(harness.databasePath);
    await rm(checkout, { recursive: true, force: true });
    await rm(join(git.main, ".git", "worktrees", "w1"), { recursive: true, force: true });

    // Nothing was ever observed about this root, so only the rule that predates identities applies.
    const renamed = tryOpen(harness.service, taskFor("renamed-workspace"), frameAt(checkout, "workspace-renamed"), gated.rootId);
    expect(renamed.error?.code).toBe("INVALID_INPUT");
    expect(renamed.error?.details).toMatchObject({ reason: "WORKSPACE_IDENTITY_UNRESOLVED" });

    const replacement = tryOpen(harness.service, taskFor("same-workspace"), frameAt(checkout, "workspace-w1"), gated.rootId);
    expect(replacement.error).toBeNull();
    expect(status(harness.service, gated.rootId).root.state).toBe("abandoned");
    expect(identityRows(harness.databasePath)).toEqual([{ root_id: replacement.data!.rootId, replacement_match: "legacy-locator" }]);
  });
});
