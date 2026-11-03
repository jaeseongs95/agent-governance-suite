import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";

import {
  type ApiResultV1,
  type ArtifactCheckV1,
  type ObservedCallerV1,
  type StageArtifactContractV1,
  type AttemptLeaseV1,
  type AttemptOutcomeV1,
  type AttemptProposalV1,
  CONTRACT_VERSION,
  type ConvergenceFrameV1,
  type ConvergenceReviewV1,
  type ConvergenceRootV1,
  type ConvergenceStatusV1,
  type ContractErrorBody,
  type EvaluationAuditPurposeV1,
  type AuditPhaseV1,
  type ExecutionContextV1,
  type ExecutionRequirementV1,
  type GuardedWorkflowStartRequestV1,
  MODEL_CLASS,
  REASONING_EFFORT,
  RISK_LEVEL,
  type RiskLevel,
  type RetryRejectionV1,
  type PlannedStageV1,
  POLICY_CAPABILITY,
  type RoutedSkillProviderV2,
  type Sha256Digest,
  type StateMappingRuleV2,
  type StageResultV1,
  type TaskEnvelopeV1,
  type WorkflowPlanV1,
  type WorkflowReceiptV1,
  type WorkflowState,
  WorkflowContractError,
  contractErrorBody,
} from "../../contracts/types.js";
import { msg, render, ROOT_LOCALE, type MessageRef, type SupportedLocale } from "./i18n.js";
import { LATE_ADOPTION_LABEL, lateAdoptionConstraint } from "./workflow-record-messages.js";
import {
  canonicalJson,
  conflictDetails,
  convergenceDigest,
  failureFingerprint,
  frameDigests,
} from "./convergence-logic.js";
import { FileSkillRegistry, selectSkillByCapability } from "./registry.js";
import { validateDecisionRecordSemantics } from "./decision-record-validator.js";
import { assertProviderSemantics } from "./provider-semantics.js";
import { ContractValidator } from "./schema-validator.js";
import { assertReceiptPolicy, jsonPointer } from "./receipt-policy.js";
import { loadStageOutputFile, localFileDigest } from "./stage-output-file.js";
import { convergenceUnverifiedClaims, externalInputs, stageUnverifiedClaims, unique } from "./unverified-claims.js";
import { independence } from "./caller-actor.js";
import { assertCsStageBundle } from "./cs-engineering-validator.js";
import { assertEngineeringStageBundle } from "./engineering-practices-validator.js";
import { contractFailure } from "./failure-diagnostics.js";
import {
  clone,
  createPlanSigningKey,
  type ConvergenceSnapshot,
  InMemoryWorkflowStore,
  PLAN_SIGNING_KEY,
  type WorkflowStore,
} from "./workflow-store.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function apiOk<T>(data: T): ApiResultV1<T> {
  return { schemaVersion: CONTRACT_VERSION, ok: true, data, error: null };
}

function apiError<T>(error: ContractErrorBody): ApiResultV1<T> {
  return { schemaVersion: CONTRACT_VERSION, ok: false, data: null, error };
}

function stageId(order: number, capability: string): string {
  return `stage-${String(order).padStart(2, "0")}-${capability}`;
}

const DETERMINISTIC_CAPABILITIES = new Set<string>([
  "korean-prose-finalization",
]);

function isDeterministicStage(capabilities: string[]): boolean {
  return capabilities.length > 0 && capabilities.every((capability) => DETERMINISTIC_CAPABILITIES.has(capability));
}

/** Receipt states that end a full attempt with a user decision, not a retryable failure. */
const USER_GATE_RECEIPT_STATES = new Set<WorkflowState>([
  "needs-input",
  "needs-approval",
  "needs-redesign",
]);

/** Schema-validator detail keys that are safe to carry on a wrapped gate failure. */
const SCHEMA_CAUSE_DETAIL_KEYS = ["schemaPath", "expectedDigest", "actualDigest", "validationErrors"] as const;

/** Who an execution check is about; each message renders it through its `subject` select, with `stageId` for a stage. */
interface ExecutionSubject {
  subject: "bootstrapOrchestration" | "workflowAttempt" | "guardedStart" | "workflowAttemptBootstrap" | "guardedStartBootstrap" | "stage";
  stageId: string;
}
const BOOTSTRAP_ORCHESTRATION: ExecutionSubject = { subject: "bootstrapOrchestration", stageId: "" };
const stageSubject = (stageId: string): ExecutionSubject => ({ subject: "stage", stageId });

const LEASE_UNAVAILABLE = msg("workflow.service.attemptLeaseMissingConsumedSuperseded", {});
const TRUSTED_EXECUTION_CLOCK_SKEW_MS = 5 * 1000;
const PLAN_INTEGRITY_TOKEN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

export interface ExecutionObservationBindingV1 {
  phase: "bootstrap" | "stage";
  taskId: string;
  runId: string | null;
  stageId: string | null;
  revision: number | null;
}

export interface TrustedExecutionContextProvider {
  observe(binding: ExecutionObservationBindingV1): ExecutionContextV1 | null;
  diagnose?(): Record<string, unknown>;
}

/** Copy of a root at the next revision, stamped with updatedAt. */
/** Stages whose PASS relies on a checker independent of the implementation: audits and frame reviews. */
function isIndependentCheck(stage: PlannedStageV1): boolean {
  return (stage.riskGate === "mandatory" && stage.requiredArtifacts.includes("gate-verdict"))
    || stage.satisfiedCapabilities.includes("iteration-frame-audit");
}

/** Observed recorders of a run's passed implementation stages; null where no caller was observed. */
function implementationRecorders(receipt: WorkflowReceiptV1): Array<ObservedCallerV1 | null> {
  return receipt.stageResults.flatMap((result) => {
    const stage = receipt.plan.stages.find((item) => item.stageId === result.stageId);
    return result.state === "passed" && stage && !isIndependentCheck(stage) ? [result.recordedBy ?? null] : [];
  });
}

function bumpedRoot(root: ConvergenceRootV1, updatedAt: string): ConvergenceRootV1 {
  const next = clone(root);
  next.revision += 1;
  next.updatedAt = updatedAt;
  return next;
}

/**
 * Artifact digests are accepted bare or sha256:-prefixed, and outcomes keep the provider's
 * spelling. Evidence is compared under one spelling so a digest cannot return as new evidence.
 */
function evidenceKey(reference: string): string {
  return /^[a-f0-9]{64}$/u.test(reference) ? `sha256:${reference}` : reference;
}

function consumedLeases(snapshot: ConvergenceSnapshot, epoch: number): AttemptLeaseV1[] {
  return snapshot.leases.filter((lease) => lease.epoch === epoch && lease.state === "consumed");
}

/**
 * Planning does not create a stored run, but strict planning atomically consumes
 * a trusted observation claim. Specialists remain directly callable.
 */
/** Session continuity the minimal start reads before and binds inside its transaction. */
export interface MinimalStartContinuity {
  /** Distinct product files edited in the session's current window before the start. */
  priorFileCount(): number;
  /** Moves a session still bound to a finished workflow to a new epoch so the new root can bind. */
  settle(): void;
  /** Binds the session to the new root before the run commits (start_guarded_workflow's correlation). */
  beforeCommit(rootId: string): void;
  /** Whether the calling session ever bound this root: only its own open root can be continued (rootId). */
  ownsRoot(rootId: string): boolean;
  /** The request's locale for the result's display text (lateAdoption.label); the root locale when absent. */
  locale?: SupportedLocale;
  /**
   * The working directory the host reported for the calling session (session board), the default workspace. The
   * server's own directory is not used: a host may start the MCP server in the plugin folder.
   */
  sessionWorkspace?(): string | null;
}

export interface MinimalWorkflowStartV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  taskId: string;
  rootId: string;
  runId: string;
  revision: number;
  state: WorkflowState;
  stages: Array<{ stageId: string; capability: string }>;
  /** TaskEnvelope and frame fields the server filled with defaults instead of the caller. */
  defaultsUsed: string[];
  /** Product files changed in this window before the start: covered by the run, not observed under it. */
  lateAdoption: { label: string; messageKey: string; params: Record<string, never>; priorFileCount: number } | null;
}

/** A retry's account of the failed attempt; the server adds the failure fingerprint from the latest outcome. */
type MinimalPriorFailure = Omit<NonNullable<AttemptProposalV1["priorFailure"]>, "fingerprint">;

interface MinimalStartRequest {
  goal: string;
  stages: string[];
  acceptanceCriteria: string[];
  workspace: string | null;
  writeTargets: string[];
  /** Continue this session's own open root with a new attempt instead of opening a root. */
  rootId: string | null;
  priorFailure: MinimalPriorFailure | null;
}

const MINIMAL_START_KEYS = new Set(["goal", "stages", "acceptanceCriteria", "workspace", "writeTargets", "rootId", "priorFailure"]);
const PRIOR_FAILURE_KEYS = ["hypothesis", "changeSummary", "discriminator", "evidenceRefs"];

function nonEmptyStrings(value: unknown, field: string, minimum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 32
    || value.some(item => typeof item !== "string" || !item.trim() || item.length > 2000) || new Set(value).size !== value.length) {
    throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.distinctStringArray", { field, size: minimum > 0 ? "nonEmpty" : "any" }), { field });
  }
  return [...value] as string[];
}

function minimalStartRequest(raw: unknown): MinimalStartRequest {
  const input = asRecord(raw);
  const unknownKey = Object.keys(input).find(key => !MINIMAL_START_KEYS.has(key));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || unknownKey) {
    throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.startWorkflowAcceptsGoalStages", {}), unknownKey ? { field: unknownKey } : null);
  }
  if (typeof input.goal !== "string" || !input.goal.trim() || input.goal.length > 2000) {
    throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.goalNonEmptyString", {}), { field: "goal" });
  }
  if (input.workspace !== undefined && (typeof input.workspace !== "string" || !path.isAbsolute(input.workspace))) {
    throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.workspaceAbsolutePath", {}), { field: "workspace" });
  }
  if (input.rootId !== undefined && (typeof input.rootId !== "string" || !input.rootId.trim())) {
    throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.startWorkflowAcceptsGoalStages", {}), { field: "rootId" });
  }
  const prior = asRecord(input.priorFailure);
  if (input.priorFailure !== undefined && (input.rootId === undefined || Object.keys(prior).sort().join() !== [...PRIOR_FAILURE_KEYS].sort().join()
    || PRIOR_FAILURE_KEYS.slice(0, 3).some(key => typeof prior[key] !== "string" || !(prior[key] as string).trim()))) {
    throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.startWorkflowPriorFailureShape", {}), { field: "priorFailure" });
  }
  return {
    goal: input.goal.trim(),
    stages: nonEmptyStrings(input.stages, "stages", 1),
    acceptanceCriteria: nonEmptyStrings(input.acceptanceCriteria, "acceptanceCriteria", 1),
    workspace: typeof input.workspace === "string" ? input.workspace : null,
    // Required: a default of the whole workspace made every start cover every other start's paths (ROOT_CONFLICT).
    writeTargets: nonEmptyStrings(input.writeTargets, "writeTargets", 1),
    rootId: typeof input.rootId === "string" ? input.rootId : null,
    priorFailure: input.priorFailure === undefined ? null : {
      hypothesis: prior.hypothesis as string, changeSummary: prior.changeSummary as string, discriminator: prior.discriminator as string,
      evidenceRefs: nonEmptyStrings(prior.evidenceRefs, "priorFailure.evidenceRefs", 1),
    },
  };
}

/** The first request field that differs from the continued root's frozen task, or null. */
function continuedTaskMismatch(request: MinimalStartRequest, root: ConvergenceRootV1): string | null {
  const task = root.taskEnvelope;
  const same = (left: readonly string[], right: readonly string[]) => JSON.stringify(left) === JSON.stringify(right);
  if (request.goal !== task.objective.trim()) return "goal";
  if (!same(request.stages, task.requiredCapabilities)) return "stages";
  if (!same(request.acceptanceCriteria, task.acceptanceCriteria)) return "acceptanceCriteria";
  if (!same(request.writeTargets, task.scope.included)) return "writeTargets";
  if (request.workspace !== null && request.workspace !== root.frame.workspace.locator) return "workspace";
  return null;
}

/**
 * ROOT_CONFLICT of a minimal start, with what the caller can do next: start again on writeTargets that do not
 * overlap and hold back only the blocked part; keep working in its own running workflow (`runningRunId`), or continue
 * its own open root whose attempt ended with rootId; or resolve a gated root. Ownership that cannot be read (no
 * continuity store) leaves only the actions that need none.
 */
function startConflict(body: ContractErrorBody, ownsRoot: (rootId: string) => boolean,
  runningRunId: (rootId: string) => string | null): WorkflowContractError {
  const details = body.details ?? {};
  const rootId = String(details.rootId ?? "");
  const state = String(details.blockerState ?? "");
  let owned: boolean;
  try { owned = rootId !== "" && ownsRoot(rootId); } catch { owned = false; }
  const gated = state === "needs-review" || state === "needs-user";
  const runId = owned && state === "open" ? runningRunId(rootId) : null;
  const action = gated ? "resolve" : !owned || state !== "open" ? "disjoint" : runId ? "running" : "continue";
  const nextActions = [
    { action: "restart-with-disjoint-writeTargets", tool: "start_workflow" },
    ...(action === "running" ? [{ action: "continue-running-workflow", tool: "get_workflow_status", arguments: { runId } }] : []),
    ...(action === "continue" ? [{ action: "continue-own-root", tool: "start_workflow", arguments: { rootId } }] : []),
    ...(gated ? [{ action: "resolve-gate", tool: "resolve_convergence_gate", arguments: { rootId } }] : []),
  ];
  return new WorkflowContractError("ROOT_CONFLICT", msg("workflow.service.startWorkflowRootConflict", {
    requested: String(details.requestedEntry ?? ""), existing: String(details.existingPath ?? details.existingEntry ?? ""), rootId, state,
    owned: owned ? "yes" : "no", action, runId: runId ?? "",
  }), { ...details, ownedBySession: owned, nextActions });
}

/** The TaskEnvelope and frame of a minimal start; the AGENT's stage choice is used as given, never expanded. */
function minimalTask(request: MinimalStartRequest, workspace: string, priorFileCount: number): { task: TaskEnvelopeV1; frame: ConvergenceFrameV1; defaultsUsed: string[] } {
  const task: TaskEnvelopeV1 = {
    schemaVersion: CONTRACT_VERSION,
    taskId: `task-${randomUUID()}`,
    objective: request.goal,
    scope: { included: [...request.writeTargets], excluded: [] },
    acceptanceCriteria: [...request.acceptanceCriteria],
    riskLevel: "medium",
    workUnits: [{ id: "work", objective: request.goal, dependencies: [], writeTargets: [...request.writeTargets] }],
    requiredCapabilities: [...request.stages],
    // Stored in the root locale like every stored message (docs/i18n-design.md 3.2); readers map it back with recordMessageRef.
    constraints: priorFileCount > 0 ? [render(lateAdoptionConstraint(priorFileCount), ROOT_LOCALE)] : [],
    authorization: { allowedActions: [], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "complex", hasConflicts: false },
    orchestration: { requested: true, mcpAvailable: true },
  };
  const frame: ConvergenceFrameV1 = {
    schemaVersion: CONTRACT_VERSION,
    workspace: { workspaceId: path.basename(workspace) || "workspace", locator: workspace },
    controlArtifacts: [{ artifactId: "acceptance-criteria", role: "pass-condition", locator: "taskEnvelope.acceptanceCriteria", digest: convergenceDigest(task.acceptanceCriteria) }],
    targetArtifacts: request.writeTargets.map((locator, index) => ({
      artifactId: `target-${index + 1}`, role: "target" as const, locator, digest: convergenceDigest({ objective: task.objective, locator }),
    })),
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
  };
  const defaultsUsed = ["taskId", "scope", "riskLevel", "workUnits", "constraints", "authorization", "decision", "orchestration", "frame", "outputTargets",
    ...(request.workspace === null ? ["workspace"] : [])];
  return { task, frame, defaultsUsed };
}

/** An error body thrown again with its own code, key, params and details. */
function bodyError(body: ContractErrorBody): WorkflowContractError {
  // Bodies built here all carry a key; one from code not yet on the catalog keeps its text as the only param.
  const ref = body.messageKey
    ? { key: body.messageKey, params: body.params ?? {} } as MessageRef
    : msg("workflow.service.unkeyedFailure", { message: body.message });
  return new WorkflowContractError(body.code, ref, body.details);
}

/** A sub-step's failure keeps its own code, message and details, and rolls back the enclosing transaction. */
function unwrapResult<T>(result: ApiResultV1<T>): T {
  if (result.ok && result.data !== null) return result.data;
  throw bodyError(result.error ?? contractErrorBody("MCP_UNAVAILABLE", msg("workflow.service.workflowStepReturnedResult", {})));
}

export class WorkflowService {
  private readonly planSigningKey: Buffer;

  constructor(
    private readonly registry: FileSkillRegistry,
    private readonly validator = new ContractValidator(),
    private readonly store: WorkflowStore = new InMemoryWorkflowStore(),
    private readonly defaultExecutionContext: ExecutionContextV1 | null = null,
    private readonly trustedExecutionContextProvider: TrustedExecutionContextProvider | null = null,
  ) {
    const encodedKey = this.store.getOrCreateSecret(PLAN_SIGNING_KEY, createPlanSigningKey);
    this.planSigningKey = Buffer.from(encodedKey, "base64url");
    if (this.planSigningKey.length !== 32) {
      throw new WorkflowContractError("INTEGRITY_FAILED", msg("workflow.service.storedPlanSigningKeyInvalid", {}), { reason: "PLAN_SIGNING_KEY_INVALID" });
    }
  }

  planWorkflow(rawTask: unknown, requireExecutionContext = false): ApiResultV1<WorkflowPlanV1> {
    return this.attempt(() => {
      const request = this.validator.planWorkflowRequest(rawTask);
      const wrapped = "taskEnvelope" in request;
      const task = wrapped ? request.taskEnvelope : request;
      const evaluationAuditPurpose = wrapped ? request.evaluationAuditPurpose : undefined;
      const requiredAuditPhase = wrapped ? request.requiredAuditPhase : undefined;
      let executionContext = this.defaultExecutionContext;
      let trustedBootstrapContext: ExecutionContextV1 | null = null;
      if (task.requiredCapabilities.includes("evaluation-validity-audit") && evaluationAuditPurpose === undefined) {
        throw new WorkflowContractError(
          "INVALID_INPUT",
          msg("workflow.service.evaluationValidityPlanningRequiresStructured", {}),
        );
      }
      if (requireExecutionContext && task.orchestration.requested) {
        const binding: ExecutionObservationBindingV1 = {
          phase: "bootstrap",
          taskId: task.taskId,
          runId: null,
          stageId: null,
          revision: null,
        };
        trustedBootstrapContext = this.observeTrustedExecutionContext(binding, BOOTSTRAP_ORCHESTRATION);
        this.assertTrustedExecutionContext(
          this.bootstrapExecutionRequirement(),
          trustedBootstrapContext,
          BOOTSTRAP_ORCHESTRATION,
          binding,
          false,
        );
        executionContext = trustedBootstrapContext;
      }
      this.validateWorkUnitGraph(task);
      const plan = this.buildPlan(task, this.registry.read(), evaluationAuditPurpose, executionContext, requiredAuditPhase);
      plan.integrityToken = this.signPlan(plan);
      this.validator.workflowPlan(plan);
      if (trustedBootstrapContext) this.consumeTrustedExecutionObservation(trustedBootstrapContext, BOOTSTRAP_ORCHESTRATION);
      return plan;
    });
  }

  openConvergenceRoot(rawRequest: unknown): ApiResultV1<ConvergenceRootV1> {
    return this.attempt(() => {
      const request = this.validator.openConvergenceRootRequest(rawRequest);
      this.validateWorkUnitGraph(request.taskEnvelope);
      this.assertConvergenceFrame(request.frame);
      if (!request.taskEnvelope.orchestration.requested || !request.taskEnvelope.orchestration.mcpAvailable) {
        throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.convergenceRootsRequireMCPBacked", {}));
      }
      if (request.parentRootId && request.userApprovalRefs.length === 0) {
        throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.replacingConvergenceRootRequiresUser", {}), {
          parentRootId: request.parentRootId,
        });
      }
      if (request.parentRootId) {
        const parent = this.requireConvergenceSnapshot(request.parentRootId).root;
        if (!["needs-review", "needs-user"].includes(parent.state)) {
          throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.gatedConvergenceRootReplaced", {}), {
            parentRootId: parent.rootId,
            parentState: parent.state,
          });
        }
      }

      const now = new Date().toISOString();
      const digests = this.convergenceDigests(request.taskEnvelope, request.frame);
      const root: ConvergenceRootV1 = {
        schemaVersion: CONTRACT_VERSION,
        rootId: `root-${randomUUID()}`,
        parentRootId: request.parentRootId,
        revision: 0,
        state: "open",
        currentEpoch: 1,
        taskEnvelope: clone(request.taskEnvelope),
        frame: clone(request.frame),
        ...digests,
        userApprovalRefs: [...request.userApprovalRefs],
        createdAt: now,
        updatedAt: now,
      };
      this.validator.convergenceRoot(root);
      // The store decides workspace binding and conflicts from server-derived identities, in the insert transaction.
      const conflict = this.store.insertConvergenceRoot(root);
      if (conflict) {
        throw new WorkflowContractError("ROOT_CONFLICT", msg("workflow.service.activeConvergenceRootCoversWorkspace", {}), conflictDetails(conflict));
      }
      return clone(root);
    });
  }

  claimWorkflowAttempt(rawProposal: unknown, requireTrustedExecutionContext = false,
    caller: ObservedCallerV1 | null = null): ApiResultV1<AttemptLeaseV1> {
    return this.attempt(() => {
      const proposal = clone(this.normalizeAttemptProposal(rawProposal));
      const actorId = caller?.actor ?? null;
      this.assertPlanIntegrity(proposal.plan);
      if (requireTrustedExecutionContext) this.assertStrictPlanExecutionAssurance(proposal.plan, "workflowAttempt");
      this.assertConvergenceFrame(proposal.frame);
      if (proposal.plan.executionMode !== "orchestrated" || proposal.plan.state !== "ready") {
        throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.readyOrchestratedPlanClaimAttempt", {}));
      }
      if (proposal.plan.taskId !== proposal.taskEnvelope.taskId) {
        throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.attemptTaskWorkflowPlanIDs", {}));
      }
      if (proposal.plan.taskDigest !== convergenceDigest(proposal.taskEnvelope)) {
        throw new WorkflowContractError("LEASE_CONFLICT", msg("workflow.service.workflowPlanBoundDifferentTask", {}), {
          rootId: proposal.rootId,
          taskId: proposal.taskEnvelope.taskId,
        });
      }
      const evaluationAuditPurpose = proposal.plan.stages.find(
        (stage) => stage.requiredCapability === "evaluation-validity-audit",
      )?.evaluationAuditPurpose;
      const requiredAuditPhase = proposal.plan.stages.find(
        (stage) => stage.riskGate === "mandatory" && stage.requiredArtifacts.includes("gate-verdict"),
      )?.requiredAuditPhase;
      const expectedPlan = this.buildPlan(
        proposal.taskEnvelope,
        this.registry.read(),
        evaluationAuditPurpose,
        proposal.plan.bootstrapExecution?.context ?? this.defaultExecutionContext ?? undefined,
        requiredAuditPhase,
      );
      expectedPlan.integrityToken = this.signPlan(expectedPlan);
      if (canonicalJson(expectedPlan, "Plan") !== canonicalJson(proposal.plan, "Plan")) {
        throw new WorkflowContractError("LEASE_CONFLICT", msg("workflow.service.workflowPlanProducedProposedTask", {}), {
          rootId: proposal.rootId,
          taskId: proposal.taskEnvelope.taskId,
        });
      }

      // An issued but unstarted lease does not block: the store supersedes it when this claim commits.
      const snapshot = this.requireConvergenceSnapshot(proposal.rootId);
      const root = snapshot.root;
      if (proposal.expectedRevision !== root.revision) {
        throw new WorkflowContractError("STALE_REVISION", msg("workflow.service.expectedRevisionMatchConvergenceRoot", {}), {
          expectedRevision: proposal.expectedRevision,
          actualRevision: root.revision,
        });
      }

      const proposedDigests = this.convergenceDigests(proposal.taskEnvelope, proposal.frame);
      const frameChanged = proposedDigests.taskDigest !== root.taskDigest
        || proposedDigests.workspaceDigest !== root.workspaceDigest
        || proposedDigests.controlDigest !== root.controlDigest
        || proposedDigests.operationalDigest !== root.operationalDigest
        || this.artifactRolesChanged(root.frame, proposal.frame);
      if (frameChanged) {
        // The task or control frame changed before the next full attempt.
        if (root.state === "open") this.moveRootToReview(root);
        throw new WorkflowContractError("FRAME_REVIEW_REQUIRED", msg("workflow.service.taskControlWorkspaceOperationalArtifact", {}), {
          rootId: root.rootId,
          expected: {
            taskDigest: root.taskDigest,
            workspaceDigest: root.workspaceDigest,
            controlDigest: root.controlDigest,
            operationalDigest: root.operationalDigest,
          },
          proposed: proposedDigests,
        });
      }
      if (root.state !== "open") this.throwRootGate(root, snapshot);

      const attempts = consumedLeases(snapshot, root.currentEpoch);
      const currentOutcomes = snapshot.outcomes.filter((outcome) => outcome.epoch === root.currentEpoch);
      const latestOutcome = currentOutcomes.at(-1) ?? null;
      if (currentOutcomes.length < attempts.length) {
        throw new WorkflowContractError("LEASE_CONFLICT", msg("workflow.service.previousFullAttemptStillActive", {}), {
          rootId: root.rootId,
          epoch: root.currentEpoch,
        });
      }
      if (attempts.length >= root.frame.operationalSettings.maxAttemptsPerEpoch) {
        this.moveRootToReview(root);
        throw new WorkflowContractError("ATTEMPT_BUDGET_EXHAUSTED", msg("workflow.service.threeFullAttemptsStartedConvergence", {}), {
          rootId: root.rootId,
          epoch: root.currentEpoch,
          attemptsUsed: attempts.length,
        });
      }

      let priorEvidenceDigests: Sha256Digest[] = [];
      if (attempts.length === 0) {
        if (proposal.priorFailure !== null) {
          throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.firstAttemptEpochClaimPrior", {}));
        }
      } else {
        if (!latestOutcome || latestOutcome.state === "passed") {
          throw new WorkflowContractError("LEASE_CONFLICT", msg("workflow.service.previousFullAttemptProducedRetryable", {}), {
            rootId: root.rootId,
          });
        }
        if (!proposal.priorFailure || proposal.priorFailure.fingerprint !== latestOutcome.failureFingerprint) {
          this.rejectRetry(
            root,
            {
              epoch: root.currentEpoch,
              reason: "stale-fingerprint",
              ...(actorId ? { actorId } : {}),
              expectedFingerprint: latestOutcome.failureFingerprint,
              targetDigest: proposedDigests.targetDigest,
              evidenceRefs: proposal.priorFailure?.evidenceRefs ?? [],
              rejectedAt: new Date().toISOString(),
            },
            msg("workflow.service.retryMustBindLatestFingerprint", {}),
            { expectedFingerprint: latestOutcome.failureFingerprint },
          );
        }
        const priorLease = attempts.at(-1)!;
        const sameTarget = proposedDigests.targetDigest === priorLease.targetDigest;
        // Evidence burnt by an earlier rejection stays burnt for the whole root: a new epoch
        // forces priorFailure to null, so an epoch-scoped set would let it back in.
        const burned = (root.retryRejections ?? [])
          .filter((item) => item.reason === "stale-evidence")
          .flatMap((item) => item.evidenceRefs);
        // New evidence means new bytes the server read itself, never a new string (D-0039).
        priorEvidenceDigests = [...new Set(proposal.priorFailure.evidenceRefs.map((locator) => {
          const digest = localFileDigest(locator);
          if (!digest) {
            throw new WorkflowContractError("MISSING_EVIDENCE", msg("workflow.service.priorFailureEvidenceReadableLocal", {}), {
              rootId: root.rootId, locator, reason: "EVIDENCE_FILE_UNREADABLE",
            });
          }
          return digest;
        }))];
        const oldEvidence = new Set([
          // An expired, never-started lease did not spend its evidence.
          ...snapshot.leases.filter((lease) => lease.state === "consumed").flatMap((lease) => lease.priorEvidenceDigests ?? []),
          ...snapshot.outcomes.flatMap((outcome) => outcome.evidenceRefs),
          ...burned,
        ].map(evidenceKey));
        const hasNewEvidence = priorEvidenceDigests.some((digest) => !oldEvidence.has(digest));
        if (sameTarget && !hasNewEvidence) {
          this.rejectRetry(
            root,
            {
              epoch: root.currentEpoch,
              reason: "stale-evidence",
              ...(actorId ? { actorId } : {}),
              expectedFingerprint: latestOutcome.failureFingerprint,
              targetDigest: proposedDigests.targetDigest,
              evidenceRefs: priorEvidenceDigests,
              rejectedAt: new Date().toISOString(),
            },
            msg("workflow.service.retryChangesNothing", {}),
            { rootId: root.rootId, route: "diagnose" },
          );
        }
      }

      const now = new Date();
      const updatedRoot = bumpedRoot(root, now.toISOString());
      const lease: AttemptLeaseV1 = {
        schemaVersion: CONTRACT_VERSION,
        leaseId: `lease-${randomUUID()}`,
        rootId: root.rootId,
        rootRevision: updatedRoot.revision,
        epoch: root.currentEpoch,
        ordinal: attempts.length + 1,
        proposalDigest: convergenceDigest(proposal),
        ...proposedDigests,
        outputTargetsDigest: convergenceDigest(proposal.outputTargets),
        planIntegrityToken: proposal.plan.integrityToken,
        actorId,
        priorEvidenceDigests,
        outputTargets: [...proposal.outputTargets],
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + proposal.frame.operationalSettings.leaseTtlSeconds * 1000).toISOString(),
        state: "issued",
      };
      this.validator.attemptLease(lease);
      if (!this.store.insertAttemptLease(updatedRoot, root.revision, proposal, lease)) {
        throw new WorkflowContractError("LEASE_CONFLICT", msg("workflow.service.convergenceRootChangedWhileLease", {}), {
          rootId: root.rootId,
        });
      }
      return clone(lease);
    });
  }

  startGuardedWorkflow(rawRequest: unknown, requireTrustedExecutionContext = false,
    beforeCommit?: (rootId: string) => void): ApiResultV1<WorkflowReceiptV1> {
    if (beforeCommit) {
      try {
        return this.store.withWorkflowTransaction(() => {
          const result = this.startGuardedWorkflow(rawRequest, requireTrustedExecutionContext);
          if (result.ok && result.data) {
            const binding = this.store.getGuardedRunBinding(result.data.runId);
            if (!binding) throw new WorkflowContractError("LEASE_CONFLICT", msg("workflow.service.startedWorkflowGuardedRootBinding", {}));
            // Commit correlation before publishing the run. A correlation failure
            // rolls back the run; a later workflow commit failure stays fail-closed.
            const prepared: unknown = beforeCommit(binding.root.rootId);
            if (typeof (prepared as { then?: unknown } | null | undefined)?.then === "function") {
              throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.workflowCorrelationCallbacksSynchronous", {}));
            }
          }
          return result;
        });
      } catch (cause) {
        return this.attempt(() => { throw cause; });
      }
    }
    return this.attempt(() => {
      const request = this.normalizeGuardedWorkflowStartRequest(rawRequest);
      const plan = clone(request.plan);
      this.assertPlanIntegrity(plan);
      if (requireTrustedExecutionContext) this.assertStrictPlanExecutionAssurance(plan, "guardedStart");
      if (plan.executionMode !== "orchestrated" || plan.state !== "ready") {
        throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.readyOrchestratedWorkflowUseConvergence", {}));
      }
      const binding = this.store.getAttemptLease(request.leaseId);
      if (!binding || binding.lease.state !== "issued") {
        throw new WorkflowContractError("LEASE_CONFLICT", LEASE_UNAVAILABLE, { leaseId: request.leaseId });
      }
      if (request.expectedRootRevision !== binding.root.revision || request.expectedRootRevision !== binding.lease.rootRevision) {
        throw new WorkflowContractError("STALE_REVISION", msg("workflow.service.guardedStartTargetCurrentConvergence", {}), {
          expectedRevision: request.expectedRootRevision,
          actualRevision: binding.root.revision,
        });
      }
      if (plan.integrityToken !== binding.lease.planIntegrityToken || canonicalJson(plan, "Plan") !== canonicalJson(binding.proposal.plan, "Plan")) {
        throw new WorkflowContractError("LEASE_CONFLICT", msg("workflow.service.attemptLeaseBoundDifferentWorkflow", {}), { leaseId: request.leaseId });
      }

      const receipt = this.newRunningReceipt(plan);
      const started = this.store.insertGuardedRun(receipt, request.leaseId, request.expectedRootRevision, new Date().toISOString());
      if (!started) {
        throw new WorkflowContractError("LEASE_CONFLICT", msg("workflow.service.attemptLeaseCouldConsumedAtomically", {}), { leaseId: request.leaseId });
      }
      return clone(receipt);
    });
  }

  /**
   * The minimal workflow start (design ags30-phase-check 7.5): one call that plans, opens a root, claims a lease and
   * starts the run through the same checks as the four separate calls, in one workflow transaction. The caller names
   * the goal, the stages (capabilities) and the acceptance criteria; every other TaskEnvelope field takes a default
   * listed in `defaultsUsed`. A failure at any step rolls back the root, lease, run and observation it created.
   */
  startMinimalWorkflow(rawRequest: unknown, caller: ObservedCallerV1 | null, continuity: MinimalStartContinuity): ApiResultV1<MinimalWorkflowStartV1> {
    return this.attempt(() => {
      const request = minimalStartRequest(rawRequest);
      if (request.rootId !== null && !continuity.ownsRoot(request.rootId)) {
        throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.startWorkflowRootNotOwned", { rootId: request.rootId }),
          { field: "rootId", reason: "ROOT_NOT_OWNED", rootId: request.rootId });
      }
      const observed = request.workspace === null ? continuity.sessionWorkspace?.() ?? null : null;
      const workspace = request.workspace ?? (observed && path.isAbsolute(observed) ? observed : null);
      if (!workspace && request.rootId === null) {
        throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.workspaceRequiredHostReportedSession", {}), { field: "workspace" });
      }
      // Edits made in this window before the start are covered by the run but were not observed under it.
      const priorFileCount = continuity.priorFileCount();
      continuity.settle();
      // ponytail: a continued root keeps its frozen task, so late adoption is only reported, not added to its constraints.
      const fresh = request.rootId === null ? minimalTask(request, workspace!, priorFileCount) : null;
      return this.store.withWorkflowTransaction(() => {
        const continued = request.rootId === null ? null : this.continuedRoot(request.rootId, request);
        const task = continued ? continued.root.taskEnvelope : fresh!.task;
        const plan = unwrapResult(this.planWorkflow(task, true));
        // A passed record of these stages must match an artifact target fixed in the plan, which this start cannot know.
        const needTargets = plan.stages.filter(stage => stage.requiredArtifacts.length > 0).map(stage => stage.requiredCapability);
        if (needTargets.length > 0) {
          throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.startWorkflowFixArtifactTargets", {}), { field: "stages", capabilities: needTargets });
        }
        const blocked = plan.state === "ready" ? null : plan.errors[0];
        if (blocked) throw bodyError(blocked);
        let root = continued?.root;
        if (!root) {
          const opened = this.openConvergenceRoot({
            schemaVersion: CONTRACT_VERSION, parentRootId: null, taskEnvelope: task, frame: fresh!.frame, userApprovalRefs: [],
          });
          if (!opened.ok && opened.error?.code === "ROOT_CONFLICT") {
            throw startConflict(opened.error, rootId => continuity.ownsRoot(rootId), rootId => this.runningRunId(rootId));
          }
          root = unwrapResult(opened);
        }
        const lease = unwrapResult(this.claimWorkflowAttempt({
          schemaVersion: CONTRACT_VERSION, rootId: root.rootId, expectedRevision: root.revision, plan,
          outputTargets: continued?.outputTargets ?? request.writeTargets, priorFailure: continued?.priorFailure ?? null,
        }, true, caller));
        const receipt = unwrapResult(this.startGuardedWorkflow({
          schemaVersion: CONTRACT_VERSION, leaseId: lease.leaseId, expectedRootRevision: lease.rootRevision, plan,
        }, true, continuity.beforeCommit));
        return {
          schemaVersion: CONTRACT_VERSION,
          taskId: task.taskId,
          rootId: root.rootId,
          runId: receipt.runId,
          revision: receipt.revision,
          state: receipt.state,
          stages: receipt.plan.stages.map(stage => ({ stageId: stage.stageId, capability: stage.requiredCapability })),
          defaultsUsed: fresh?.defaultsUsed ?? [],
          lateAdoption: priorFileCount > 0
            ? { label: render(LATE_ADOPTION_LABEL, continuity.locale ?? ROOT_LOCALE), messageKey: LATE_ADOPTION_LABEL.key, params: {}, priorFileCount }
            : null,
        };
      });
    });
  }

  /** The root's latest run when it has not ended, or null. */
  private runningRunId(rootId: string): string | null {
    const runId = this.store.getConvergenceSnapshot(rootId)?.workflowRunIds.at(-1);
    const state = runId ? this.store.getRun(runId)?.state : undefined;
    return runId && state && !["passed", "failed", "blocked"].includes(state) ? runId : null;
  }

  /**
   * The open root a start continues (start_workflow rootId, after a failed or aborted attempt left it open): the request
   * must name the root's own frozen task, and a retry after a failed attempt brings priorFailure, bound here to the
   * latest outcome's fingerprint. The claim then applies the usual retry checks (new evidence or a changed target).
   */
  private continuedRoot(rootId: string, request: MinimalStartRequest): {
    root: ConvergenceRootV1; outputTargets: string[]; priorFailure: AttemptProposalV1["priorFailure"];
  } {
    const snapshot = this.requireConvergenceSnapshot(rootId);
    const root = snapshot.root;
    if (root.state !== "open") {
      throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.startWorkflowRootNotOpen", { rootId, state: root.state }),
        { field: "rootId", reason: "ROOT_NOT_OPEN", rootId, state: root.state });
    }
    const field = continuedTaskMismatch(request, root);
    if (field) {
      throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.startWorkflowRootTaskMismatch", { field }),
        { field, reason: "ROOT_TASK_MISMATCH", rootId });
    }
    const latest = snapshot.outcomes.filter(outcome => outcome.epoch === root.currentEpoch).at(-1);
    const failed = latest && latest.state !== "passed" ? latest : null;
    if (Boolean(failed) !== Boolean(request.priorFailure)) {
      throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.startWorkflowPriorFailure", { required: failed ? "yes" : "no" }),
        { field: "priorFailure", reason: failed ? "PRIOR_FAILURE_REQUIRED" : "PRIOR_FAILURE_UNEXPECTED", rootId });
    }
    const lastLease = snapshot.leases.filter(lease => lease.state === "consumed").at(-1);
    return {
      root,
      outputTargets: lastLease?.outputTargets ?? root.taskEnvelope.scope.included,
      priorFailure: failed && request.priorFailure ? { fingerprint: failed.failureFingerprint ?? "", ...request.priorFailure } : null,
    };
  }

  private normalizeAttemptProposal(rawProposal: unknown): AttemptProposalV1 {
    const candidate = asRecord(rawProposal);
    const hasTaskEnvelope = Object.hasOwn(candidate, "taskEnvelope");
    const hasFrame = Object.hasOwn(candidate, "frame");
    if (hasTaskEnvelope !== hasFrame) {
      throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.attemptProposalProvideBothTaskEnvelope", {}));
    }
    if (hasTaskEnvelope) return this.validator.attemptProposal(rawProposal);

    const rootId = typeof candidate.rootId === "string" ? candidate.rootId : "";
    const root = this.requireConvergenceSnapshot(rootId).root;
    return this.validator.attemptProposal({
      ...candidate,
      taskEnvelope: clone(root.taskEnvelope),
      frame: clone(root.frame),
    });
  }

  private normalizeGuardedWorkflowStartRequest(rawRequest: unknown): GuardedWorkflowStartRequestV1 {
    const candidate = asRecord(rawRequest);
    if (Object.hasOwn(candidate, "plan")) return this.validator.guardedWorkflowStartRequest(rawRequest);

    const leaseId = typeof candidate.leaseId === "string" ? candidate.leaseId : "";
    const binding = this.store.getAttemptLease(leaseId);
    if (!binding) {
      throw new WorkflowContractError("LEASE_CONFLICT", LEASE_UNAVAILABLE, { leaseId });
    }
    return this.validator.guardedWorkflowStartRequest({
      ...candidate,
      plan: clone(binding.proposal.plan),
    });
  }

  getConvergenceStatus(rootId: string): ApiResultV1<ConvergenceStatusV1> {
    return this.attempt(() => {
      const status = this.buildConvergenceStatus(this.requireConvergenceSnapshot(rootId));
      this.validator.convergenceStatus(status);
      return clone(status);
    });
  }

  resolveConvergenceGate(rawRequest: unknown, caller: ObservedCallerV1 | null = null): ApiResultV1<ConvergenceStatusV1> {
    return this.attempt(() => {
      const request = this.validator.resolveConvergenceGateRequest(rawRequest);
      const review = clone(request.review);
      if (Object.hasOwn(review, "observedReviewer")) {
        throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.observedReviewerServerOwnedCallersSend", {}), {
          reason: "SERVER_OWNED_FIELD",
        });
      }
      const snapshot = this.requireConvergenceSnapshot(request.rootId);
      const root = snapshot.root;
      if (request.expectedRevision !== root.revision || review.rootRevision !== root.revision) {
        throw new WorkflowContractError("STALE_REVISION", msg("workflow.service.convergenceReviewTargetCurrentRoot", {}), {
          expectedRevision: request.expectedRevision,
          reviewRevision: review.rootRevision,
          actualRevision: root.revision,
        });
      }
      if (review.rootId !== root.rootId || review.epoch !== root.currentEpoch) {
        throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.convergenceReviewTargetsDifferentRoot", {}));
      }
      if (root.state !== "needs-review") {
        throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.gatedConvergenceRootResolved", {}), { state: root.state });
      }
      // Fresh context stays the root's declaration. A declared reviewer that names an actor AGS observed as
      // a lease claimer or as a recorder without host-observed identity contradicts itself.
      if (!review.freshContext.confirmed || !review.freshContext.evidenceRef) {
        throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.frameReviewDeclaresMadeFresh", {}));
      }
      const observedActors = new Set([
        ...snapshot.leases.filter((lease) => lease.state === "consumed").map((lease) => lease.actorId),
        caller?.provenance === "host-observed" ? null : caller?.actor,
      ].filter((actorId): actorId is string => typeof actorId === "string"));
      if (observedActors.has(review.reviewerActorId)) {
        throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.declaredFrameReviewerActorAGS", {}), {
          reason: "REVIEWER_IS_OBSERVED_ROOT",
        });
      }
      const reviewerIndependence = independence(caller, snapshot.workflowRunIds.flatMap((runId) => {
        const run = this.store.getRun(runId);
        return run ? implementationRecorders(run) : [];
      }));
      if (reviewerIndependence === "violated") {
        throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.observedReviewerImplementedDelegatedWork", {}), {
          reason: "REVIEWER_NOT_INDEPENDENT",
        });
      }
      if (caller) review.observedReviewer = { ...clone(caller), independence: reviewerIndependence };
      this.assertReviewRoute(review);

      const updatedRoot = bumpedRoot(root, review.reviewedAt);
      if (review.route === "stop") {
        // A stopped root keeps holding its write surface; only an approved replacement releases it.
        updatedRoot.state = "needs-user";
      } else if (review.classification === "semantics-changing" || review.route === "needs-user") {
        updatedRoot.state = "needs-user";
      } else if (review.route === "panel" || review.route === "diagnose") {
        updatedRoot.state = "needs-review";
      } else if (review.route === "resume-new-epoch") {
        if (updatedRoot.currentEpoch >= updatedRoot.frame.operationalSettings.maxEpochs) {
          updatedRoot.state = "needs-user";
        } else {
          const proposedFrame = review.proposedFrame!;
          this.assertConvergenceFrame(proposedFrame);
          const nextDigests = this.convergenceDigests(updatedRoot.taskEnvelope, proposedFrame);
          if (nextDigests.workspaceDigest !== root.workspaceDigest || nextDigests.operationalDigest !== root.operationalDigest) {
            throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.semanticsPreservingReviewChangeWorkspace", {}));
          }
          if (nextDigests.targetDigest === root.targetDigest) {
            throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.newConvergenceEpochRequiresVerified", {}));
          }
          updatedRoot.currentEpoch += 1;
          updatedRoot.state = "open";
          updatedRoot.frame = clone(proposedFrame);
          Object.assign(updatedRoot, nextDigests);
        }
      }

      this.validator.convergenceRoot(updatedRoot);
      if (!this.store.updateConvergenceRoot(updatedRoot, root.revision, review)) {
        throw new WorkflowContractError("STALE_REVISION", msg("workflow.service.convergenceRootChangedWhileRecording", {}));
      }
      return this.buildConvergenceStatus(this.requireConvergenceSnapshot(root.rootId));
    });
  }

  rejectUnguardedWorkflow(rawPlan: unknown): ApiResultV1<WorkflowReceiptV1> {
    return this.attempt<WorkflowReceiptV1>(() => {
      const plan = clone(this.validator.workflowPlan(rawPlan));
      this.assertPlanIntegrity(plan);
      if (plan.executionMode === "orchestrated") {
        throw new WorkflowContractError("LEASE_REQUIRED", msg("workflow.service.newOrchestratedWorkflowsStartThrough", {}));
      }
      throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.directSkillPlansStartedMCP", {}));
    });
  }

  /** Embedding compatibility only. The MCP start_workflow tool is the guarded minimal start (startMinimalWorkflow). */
  startWorkflow(rawPlan: unknown): ApiResultV1<WorkflowReceiptV1> {
    return this.attempt(() => {
      const plan = clone(this.validator.workflowPlan(rawPlan));
      this.assertPlanIntegrity(plan);
      if (plan.executionMode !== "orchestrated") {
        throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.directSkillPlansStartedMCP", {}));
      }
      if (plan.state !== "ready") {
        const error = plan.errors.find((item) => item.code === "MCP_UNAVAILABLE");
        if (error) throw bodyError(error);
        throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.readyWorkflowPlanStarted", {}), {
          planState: plan.state,
        });
      }

      const receipt = this.newRunningReceipt(plan);
      this.store.insertRun(receipt);
      return clone(receipt);
    });
  }

  recordStageResult(rawResult: unknown, requireTrustedExecutionContext = false,
    caller: ObservedCallerV1 | null = null): ApiResultV1<WorkflowReceiptV1> {
    try {
      const callerResult = asRecord(rawResult);
      for (const field of ["artifactChecks", "recordedBy"]) {
        if (Object.hasOwn(callerResult, field)) {
          throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.serverOwnedField", { field }), {
            reason: "SERVER_OWNED_FIELD",
            field,
          });
        }
      }
      if (requireTrustedExecutionContext && Object.prototype.hasOwnProperty.call(callerResult, "executionContext")) {
        throw new WorkflowContractError(
          "BINDING_INVALID",
          msg("workflow.service.strictMCPStageExecutionRejects", {}),
        );
      }
      // A copy: the server adds its own fields, and the caller's object must stay reusable.
      const result = clone(this.validator.stageResult(rawResult));
      if (result.outputFile && result.output.output !== null) {
        throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.outputOutputNullWhenOutputFile", {}));
      }
      return this.change(result.runId, result.expectedRevision, (receipt) => {
        if (receipt.state !== "running") {
          throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.stageResultsRequireRunningWorkflow", {}), {
            state: receipt.state,
          });
        }
        const target = receipt.plan.stages.find((stage) => stage.stageId === result.stageId);
        if (!target) {
          throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.stageBelongRun", {}), { stageId: result.stageId });
        }
        if (target.state !== "ready") {
          throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.stageResultRecordedOnce", {}), {
            stageId: result.stageId,
            stageState: target.state,
          });
        }
        const priorStage = receipt.plan.stages.find(
          (stage) => stage.order < target.order && stage.state !== "passed",
        );
        if (priorStage) {
          throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.stagesRecordedPlanOrder", {}), {
            requiredStageId: priorStage.stageId,
            requestedStageId: result.stageId,
          });
        }
        let loadedOutput: Record<string, unknown> | undefined;
        if (result.outputFile) {
          // Receipt policies compare actors across stages through the stored output, so policy stages stay inline.
          if (target.receiptPolicy) {
            throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.stagesReceiptPolicyRecordTheir", {}), {
              stageId: target.stageId,
            });
          }
          loadedOutput = loadStageOutputFile(result.outputFile);
        }

        let trustedStageContext: ExecutionContextV1 | null = null;
        if (
          requireTrustedExecutionContext
          && result.state === "passed"
          && !target.executionRequirement
          && !isDeterministicStage(target.satisfiedCapabilities)
        ) {
          throw new WorkflowContractError(
            "BINDING_REQUIRED",
            msg("workflow.service.stageWithoutExecutionRequirementStrict", { stageId: target.stageId }),
          );
        }
        if (
          requireTrustedExecutionContext
          && target.executionRequirement?.kind === "semantic"
        ) {
          const binding: ExecutionObservationBindingV1 = {
            phase: "stage",
            taskId: receipt.plan.taskId,
            runId: receipt.runId,
            stageId: target.stageId,
            revision: result.expectedRevision,
          };
          const subject = stageSubject(target.stageId);
          // Only a passing stage has to clear the assurance floor. A failing one still records
          // what ran when the host can see it: requiring attestation there would push legitimate
          // unattested failures into abort_workflow, which drops the failure fingerprint.
          const passed = result.state === "passed";
          // The floor applies to an agent whose model an agent chose. The root session runs the model the user chose,
          // so its record is observed and bound but never refused for model or effort.
          const enforced = passed && (caller === null || caller.parentChain.length > 0);
          trustedStageContext = passed
            ? this.observeTrustedExecutionContext(binding, subject)
            : this.observeExecutionContext(binding);
          if (trustedStageContext) {
            this.assertTrustedExecutionContext(
              target.executionRequirement,
              trustedStageContext,
              subject,
              binding,
              enforced,
            );
            result.executionContext = clone(trustedStageContext);
          }
        }

        result.artifactChecks = this.checkArtifacts(target, result);
        if (caller) result.recordedBy = clone(caller);
        // A file-backed output is checked exactly like inline output; the receipt keeps only its reference.
        const checked: StageResultV1 = loadedOutput === undefined
          ? result
          : { ...result, output: { ...result.output, output: loadedOutput } };
        this.assertPlannedInputsAvailable(receipt, target, result.state === "passed");
        this.assertResultSemantics(target, checked, receipt.plan.taskId, receipt.plan.taskDigest);
        if (target.requiredCapability === "cs-implementation-review") {
          assertCsStageBundle(this.registry.rootDirectory, receipt.plan.taskDigest, checked, this.validator);
        }
        assertEngineeringStageBundle(this.registry.rootDirectory, receipt.plan.taskDigest, target.requiredCapability, checked, this.validator);
        this.assertDeclaredReceiptPolicy(receipt, target, checked);
        const checkerIndependence = result.state === "passed" && isIndependentCheck(target)
          ? independence(caller, implementationRecorders(receipt))
          : "unobserved";
        if (checkerIndependence === "violated") {
          throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.observedAuditorImplementedRunDelegated", {}), {
            stageId: target.stageId,
            reason: "AUDITOR_NOT_INDEPENDENT",
          });
        }
        if (result.state === "passed") {
          this.assertRequiredArtifacts(target, checked);
          this.assertDeliberationGate(target, checked);
          this.assertMandatoryAuditGate(target, checked, [
            caller?.provenance === "host-observed" ? null : caller?.actor ?? null,
            this.store.getGuardedRunBinding(receipt.runId)?.lease.actorId ?? null,
          ]);
          this.assertEvaluationValidityGate(target, checked);
          this.assertBaselineLineage(receipt, target, checked);
        }
        target.state = result.state;
        if (trustedStageContext) this.consumeTrustedExecutionObservation(trustedStageContext, stageSubject(target.stageId));
        receipt.stageResults.push(clone(result));
        receipt.unverifiedClaims = unique([
          ...receipt.unverifiedClaims,
          ...stageUnverifiedClaims(target, checked, trustedStageContext !== null, externalInputs(receipt.plan, target),
            checkerIndependence === "verified"),
        ]);
        this.addUnique(receipt.blockers, result.blockers);
        this.addUnique(receipt.unresolved, result.blockers);
        if (result.state !== "passed") {
          receipt.state = result.state;
          receipt.plan.state = result.state;
          receipt.error = result.error;
          this.addUnique(receipt.unresolved, [`${target.stageId}:${result.state}`]);
          if (result.state === "needs-input" || result.state === "needs-approval" || result.state === "needs-redesign") {
            receipt.plan.currentStageId = target.stageId;
          } else {
            receipt.plan.currentStageId = null;
          }
          receipt.plan.nextStageId = null;
        } else {
          this.setRunningStagePointers(receipt.plan);
        }
      });
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  getWorkflowStatus(runId: string): ApiResultV1<WorkflowReceiptV1> {
    return this.attempt(() => clone(this.requireRun(runId)));
  }

  finalizeWorkflow(runId: string, expectedRevision: number): ApiResultV1<WorkflowReceiptV1> {
    return this.change(runId, expectedRevision, (receipt) => {
      if (receipt.state !== "running") {
        throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.runningWorkflowFinalized", {}), {
          state: receipt.state,
        });
      }
      if (receipt.blockers.length > 0 || receipt.unresolved.length > 0) {
        throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.workflowUnresolvedBlockersFindings", {}), {
          blockers: receipt.blockers,
          unresolved: receipt.unresolved,
        });
      }

      for (const stage of receipt.plan.stages) {
        const result = receipt.stageResults.find((item) => item.stageId === stage.stageId);
        if (!result || result.state !== "passed") {
          throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.everyPlannedStagePassBefore", {}), {
            stageId: stage.stageId,
            stageState: result?.state ?? "ready",
          });
        }
        this.assertPlannedInputsAvailable(receipt, stage, true);
        this.assertRequiredArtifacts(stage, result);
        if (["cs-implementation-review", "test-sensitivity-review", "change-code-review"].includes(stage.requiredCapability)
          || (stage.riskGate === "mandatory" && stage.requiredArtifacts.includes("gate-verdict"))) {
          const checked = result.outputFile
            ? {...result, output:{...result.output, output:loadStageOutputFile(result.outputFile)}}
            : result;
          this.assertResultSemantics(stage, checked, receipt.plan.taskId, receipt.plan.taskDigest);
          if (stage.requiredCapability === "cs-implementation-review") {
            assertCsStageBundle(this.registry.rootDirectory, receipt.plan.taskDigest, checked, this.validator);
          }
          assertEngineeringStageBundle(this.registry.rootDirectory, receipt.plan.taskDigest, stage.requiredCapability, checked, this.validator);
          this.assertMandatoryAuditGate(stage, checked);
          this.assertAuditedFilesUnchanged(stage, result);
        }
        this.assertExecutionAssurance(stage, result);
        this.assertDeclaredReceiptPolicy(receipt, stage, result);
        this.assertEvaluationValidityGate(stage, result);
      }

      const mandatoryAudit = receipt.plan.stages.find((stage) => stage.riskGate === "mandatory");
      if (mandatoryAudit && mandatoryAudit.state !== "passed") {
        throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.mandatoryAuditStageDidPass", {}), {
          stageId: mandatoryAudit.stageId,
        });
      }

      receipt.state = "passed";
      receipt.plan.state = "passed";
      receipt.plan.currentStageId = null;
      receipt.plan.nextStageId = null;
      receipt.error = null;
    });
  }

  abortWorkflow(runId: string, expectedRevision: number): ApiResultV1<WorkflowReceiptV1> {
    return this.change(runId, expectedRevision, (receipt) => {
      if (receipt.state === "passed" || receipt.state === "failed" || receipt.state === "blocked") {
        throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.terminalWorkflowAborted", {}), {
          state: receipt.state,
        });
      }
      receipt.state = "blocked";
      receipt.plan.state = "blocked";
      receipt.plan.currentStageId = null;
      receipt.plan.nextStageId = null;
      this.addUnique(receipt.blockers, ["aborted-by-caller"]);
      this.addUnique(receipt.unresolved, ["aborted-by-caller"]);
      receipt.error = null;
    });
  }

  private buildPlan(
    task: TaskEnvelopeV1,
    skills: RoutedSkillProviderV2[],
    evaluationAuditPurpose?: EvaluationAuditPurposeV1,
    executionContext?: ExecutionContextV1 | null,
    requiredAuditPhase: AuditPhaseV1 = "post-execution",
  ): WorkflowPlanV1 {
    const executionMode = task.orchestration.requested ? "orchestrated" : "direct";
    const errors: ContractErrorBody[] = [];
    const stages: PlannedStageV1[] = [];
    const selectedSkills = new Set<string>();
    const selectedProviders = new Map<string, {
      capability: string;
      satisfiedCapabilities: string[];
      provider: RoutedSkillProviderV2;
    }>();

    for (const capability of this.requiredCapabilities(task)) {
      const skill = selectSkillByCapability(skills, capability);
      if (!skill) {
        errors.push(contractErrorBody("GATE_FAILED", msg("workflow.service.noProviderForCapability", { capability }), { capability }));
        continue;
      }
      if (skill.executionClass === "bootstrap") {
        errors.push(contractErrorBody("GATE_FAILED", msg("workflow.service.bootstrapCapabilityInPlan", { capability }),
          { capability, providerKey: skill.providerKey }));
        continue;
      }
      const selected = selectedProviders.get(skill.providerKey);
      if (selected) {
        if (!selected.satisfiedCapabilities.includes(capability)) selected.satisfiedCapabilities.push(capability);
      } else {
        selectedProviders.set(skill.providerKey, { capability, satisfiedCapabilities: [capability], provider: skill });
      }
    }

    const selectedProviderList = [...selectedProviders.values()];
    const executionClasses = new Set(selectedProviderList.map(({ provider }) => provider.executionClass));
    if (executionClasses.size > 1) {
      errors.push(contractErrorBody("INVALID_TRANSITION", msg("workflow.service.recoveryProvidersRunSeparateWorkflow", {}),
        { executionClasses: [...executionClasses] }));
    }
    for (const { provider: consumer } of selectedProviderList) {
      for (const binding of consumer.inputBindings.filter((item) => item.operation === "require-external")) {
        const producer = selectedProviderList.find(({ provider }) =>
          provider.providerKey !== consumer.providerKey
          && provider.producedArtifacts.includes(binding.targetArtifact));
        if (producer) {
          errors.push(contractErrorBody("INVALID_TRANSITION", msg("workflow.service.artifactFromExternalRun", { artifact: binding.targetArtifact }), {
            consumerProviderKey: consumer.providerKey,
            producerProviderKey: producer.provider.providerKey,
          }));
        }
      }
    }

    for (const { capability, satisfiedCapabilities, provider: skill } of this.orderProviders(selectedProviderList)) {
      // Descriptor requiredArtifacts are inputs/preconditions. Only declared
      // producedArtifacts become evidence obligations for a completed stage.
      const producedArtifacts = skill.producedArtifacts;
      const stageRequiredArtifacts = skill.gate.policy === "mandatory" && skill.capabilities.includes(POLICY_CAPABILITY.audit)
        ? [...new Set([...producedArtifacts, "gate-verdict"])]
        : producedArtifacts;
      const stageEvaluationAuditPurpose = capability === "evaluation-validity-audit"
        ? evaluationAuditPurpose
        : undefined;
      if (capability === "evaluation-validity-audit" && stageEvaluationAuditPurpose === undefined) {
        throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.evaluationAuditPurposeMissingPlanning", {}));
      }
      const order = stages.length + 1;
      const artifactContract = this.plannedArtifactContract(task, satisfiedCapabilities, stageRequiredArtifacts);
      stages.push({
        stageId: stageId(order, capability),
        order,
        requiredCapability: capability,
        ...(stageEvaluationAuditPurpose !== undefined
          ? { evaluationAuditPurpose: stageEvaluationAuditPurpose }
          : {}),
        ...(skill.gate.policy === "mandatory" && stageRequiredArtifacts.includes("gate-verdict")
          ? { requiredAuditPhase }
          : {}),
        satisfiedCapabilities,
        skillId: skill.skillId,
        phase: skill.phase,
        selectionReason: `Selected '${skill.skillId}' because provider '${skill.providerKey}' supplies '${satisfiedCapabilities.join("', '")}' at priority ${skill.priority}.`,
        state: "ready",
        ...(executionContext
          ? { executionRequirement: this.stageExecutionRequirement(task, satisfiedCapabilities, skill.executionRiskLevel) }
          : {}),
        ...(artifactContract ? { artifactContract } : {}),
        requiredArtifacts: stageRequiredArtifacts,
        riskGate: skill.gate.policy,
        providerKey: skill.providerKey,
        executionClass: skill.executionClass as "workflow" | "recovery",
        phaseOrder: skill.phaseOrder,
        requiredInputArtifacts: skill.requiredInputArtifacts,
        inputBindings: skill.inputBindings,
        producedArtifacts: skill.producedArtifacts,
        outputSchema: { path: skill.outputSchema, digest: skill.outputSchemaDigest },
        resultSchema: { path: skill.resultSchema, digest: skill.resultSchemaDigest },
        stateMapping: skill.stateMapping,
        gate: skill.gate,
        ...(skill.receiptPolicy ? { receiptPolicy: skill.receiptPolicy } : {}),
      });
      selectedSkills.add(skill.skillId);
    }

    if (executionMode === "orchestrated" && !task.orchestration.mcpAvailable) {
      errors.unshift(contractErrorBody("MCP_UNAVAILABLE", msg("workflow.service.orchestratorBlockedBecauseMCPUnavailable", {})));
    }

    for (const contract of task.artifactContracts ?? []) {
      if (!stages.some((stage) => stage.satisfiedCapabilities.includes(contract.capability))) {
        throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.artifactContractCapabilitySelectedPlan", {}), {
          capability: contract.capability,
        });
      }
    }
    return {
      schemaVersion: CONTRACT_VERSION,
      taskId: task.taskId,
      taskDigest: convergenceDigest(task),
      integrityToken: "pending",
      executionMode,
      ...(executionContext
        ? {
            bootstrapExecution: {
              requirement: this.bootstrapExecutionRequirement(),
              context: clone(executionContext),
            },
          }
        : {}),
      state: errors.length > 0 ? "blocked" : "ready",
      selectedSkills: [...selectedSkills],
      stages,
      currentStageId: null,
      nextStageId: errors.length > 0 ? null : stages[0]?.stageId ?? null,
      errors,
    };
  }

  private requiredCapabilities(task: TaskEnvelopeV1): string[] {
    const auditRequested = task.requiredCapabilities.includes(POLICY_CAPABILITY.audit)
      || task.riskLevel === "high"
      || task.riskLevel === "critical";
    const requestedWork = task.requiredCapabilities.filter((capability) => capability !== POLICY_CAPABILITY.audit);
    // Capability selection belongs to the request. Preserve dependency checks without expanding a language workflow.
    return [...new Set([...requestedWork, ...(auditRequested ? [POLICY_CAPABILITY.audit] : [])])];
  }

  private orderProviders(
    items: Array<{ capability: string; satisfiedCapabilities: string[]; provider: RoutedSkillProviderV2 }>,
  ): Array<{ capability: string; satisfiedCapabilities: string[]; provider: RoutedSkillProviderV2 }> {
    const producedBy = new Map<string, number>();
    for (const [index, item] of items.entries()) {
      for (const artifact of item.provider.producedArtifacts) {
        const existing = producedBy.get(artifact);
        if (existing !== undefined && items[existing]?.provider.providerKey !== item.provider.providerKey) {
          throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.selectedProvidersProduceSameArtifact", {}), {
            artifact,
            providers: [items[existing]?.provider.providerKey, item.provider.providerKey],
          });
        }
        producedBy.set(artifact, index);
      }
    }

    const outgoing = new Map<number, Set<number>>();
    const indegree = items.map(() => 0);
    for (const [consumerIndex, item] of items.entries()) {
      for (const artifact of item.provider.requiredInputArtifacts) {
        const producerIndex = producedBy.get(artifact);
        if (producerIndex === undefined || producerIndex === consumerIndex) continue;
        const edges = outgoing.get(producerIndex) ?? new Set<number>();
        if (!edges.has(consumerIndex)) {
          edges.add(consumerIndex);
          outgoing.set(producerIndex, edges);
          indegree[consumerIndex] = (indegree[consumerIndex] ?? 0) + 1;
        }
      }
    }

    const compare = (left: number, right: number) => (
      items[left]!.provider.phaseOrder - items[right]!.provider.phaseOrder
      || items[left]!.capability.localeCompare(items[right]!.capability)
      || items[left]!.provider.providerKey.localeCompare(items[right]!.provider.providerKey)
    );
    const ready = indegree.map((value, index) => value === 0 ? index : -1).filter((index) => index >= 0).sort(compare);
    const ordered: typeof items = [];
    while (ready.length > 0) {
      const index = ready.shift()!;
      ordered.push(items[index]!);
      for (const next of outgoing.get(index) ?? []) {
        indegree[next]!--;
        if (indegree[next] === 0) {
          ready.push(next);
          ready.sort(compare);
        }
      }
    }
    if (ordered.length !== items.length) {
      throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.selectedProviderArtifactDependenciesContain", {}));
    }
    return ordered;
  }

  private assertResultSemantics(stage: PlannedStageV1, result: StageResultV1, taskId: string, taskDigest: string | undefined): void {
    const providerResult = this.validator.providerResult(
      this.registry.rootDirectory,
      stage.resultSchema,
      stage.outputSchema,
      result.output,
    );
    if (providerResult.kind === "output") {
      // The skill's own semantic validator, selected by the stage's declared gate validator or capability.
      assertProviderSemantics({ taskId, taskDigest, stage, result, output: providerResult.output });
    }
    const rule = this.mappedState(stage, providerResult);
    if (result.state !== rule.state) {
      throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.stageStateMatchProviderState", {}), {
        stageId: result.stageId,
        expectedState: rule.state,
        actualState: result.state,
      });
    }
    const providerError = providerResult.error;
    if (rule.errorRequired !== Boolean(providerError)) {
      throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.providerErrorPresenceMatchState", {}), {
        stageId: result.stageId,
        errorRequired: rule.errorRequired,
      });
    }
    if (providerError && rule.allowedErrorCodes && !rule.allowedErrorCodes.includes(providerError.code)) {
      throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.providerErrorCodeAllowedState", {}), {
        stageId: result.stageId,
        errorCode: providerError.code,
      });
    }
    if ((providerError?.code ?? null) !== (result.error?.code ?? null)) {
      throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.stageErrorMirrorProviderResult", {}), {
        stageId: result.stageId,
      });
    }
    if (result.state === "passed") {
      this.assertExecutionAssurance(stage, result);
      if (result.evidence.length === 0) {
        throw new WorkflowContractError("MISSING_EVIDENCE", msg("workflow.service.passedStageRequiresEvidence", {}), {
          stageId: result.stageId,
        });
      }
      if (result.error) {
        throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.passedStageContainError", {}));
      }
    }
    if ((result.state === "failed" || result.state === "blocked") && rule.errorRequired && !result.error) {
      throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.failedBlockedStagesRequireError", {}));
    }
  }

  private assertDeclaredReceiptPolicy(
    receipt: WorkflowReceiptV1,
    stage: PlannedStageV1,
    result: StageResultV1,
  ): void {
    if (!stage.receiptPolicy) return;
    const fixedTokens = this.validator.referenceOnlyFixedTokens(
      this.registry.rootDirectory,
      stage.outputSchema,
    );
    assertReceiptPolicy(receipt, stage, result, fixedTokens);
  }

  private mappedState(stage: PlannedStageV1, providerResult: StageResultV1["output"]): StateMappingRuleV2 {
    if (providerResult.kind === "adapter-error") {
      const errorCode = providerResult.error?.code;
      if (!errorCode || !stage.stateMapping.adapterErrors.includes(errorCode)) {
        throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.adapterErrorAllowedProviderDescriptor", {}), {
          stageId: stage.stageId,
          errorCode: errorCode ?? null,
        });
      }
      return { state: "blocked", errorRequired: true, allowedErrorCodes: stage.stateMapping.adapterErrors };
    }
    let rule: StateMappingRuleV2 | "reject" = stage.stateMapping.default;
    if (stage.stateMapping.selector) {
      const value = jsonPointer(providerResult, stage.stateMapping.selector);
      if (typeof value === "string") rule = stage.stateMapping.values?.[value] ?? "reject";
    }
    if (rule === "reject") {
      throw new WorkflowContractError("INVALID_TRANSITION", msg("workflow.service.providerVerdictMappedDescriptor", {}), {
        stageId: stage.stageId,
        selector: stage.stateMapping.selector ?? null,
      });
    }
    return rule;
  }

  private plannedArtifactContract(
    task: TaskEnvelopeV1,
    capabilities: string[],
    requiredArtifacts: string[],
  ): StageArtifactContractV1 | undefined {
    const contracts = (task.artifactContracts ?? []).filter((item) => capabilities.includes(item.capability));
    if (contracts.length === 0) return undefined; // Legacy non-passing observations remain recordable.
    if (contracts.length !== 1) {
      throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.selectedStageNeedsUnambiguousArtifact", {}));
    }
    const contract = contracts[0]!;
    const ids = contract.produced.map((item) => item.artifactId);
    if (ids.length !== requiredArtifacts.length || new Set(ids).size !== ids.length
      || requiredArtifacts.some((id) => !ids.includes(id))) {
      throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.artifactContractIDsExactlyMatch", {}));
    }
    return clone(contract);
  }

  private assertRequiredArtifacts(stage: PlannedStageV1, result: StageResultV1): void {
    const missingArtifacts = stage.requiredArtifacts.filter(
      (artifactId) => !result.output.artifacts.some((artifact) => artifact.artifactId === artifactId),
    );
    if (missingArtifacts.length > 0) {
      throw new WorkflowContractError("MISSING_EVIDENCE", msg("workflow.service.requiredArtifactsMissingStageResult", {}), {
        stageId: stage.stageId, missingArtifacts,
      });
    }
    for (const artifactId of stage.requiredArtifacts) {
      const expected = stage.artifactContract?.produced.find((item) => item.artifactId === artifactId);
      const actual = result.output.artifacts.filter((item) => item.artifactId === artifactId);
      if (!expected || actual.length !== 1 || !actual[0]!.locator || !actual[0]!.digest) {
        throw new WorkflowContractError("MISSING_EVIDENCE", msg("workflow.service.requiredArtifactLacksDeclaredTarget", {}), {
          stageId: stage.stageId, artifactId,
        });
      }
      // The provider schema already supports bare and sha256:-prefixed digest spellings.
      const targetDigest = actual[0]!.targetDigest.startsWith("sha256:")
        ? actual[0]!.targetDigest : `sha256:${actual[0]!.targetDigest}`;
      if (actual[0]!.schemaId !== expected.schemaId || targetDigest !== expected.targetDigest) {
        throw new WorkflowContractError("BINDING_INVALID", msg("workflow.service.artifactSchemaTargetDiffersSigned", {}), {
          stageId: stage.stageId, artifactId,
        });
      }
    }
  }

  private assertPlannedInputsAvailable(receipt: WorkflowReceiptV1, stage: PlannedStageV1, requireDeclaredTarget: boolean): void {
    const missing: Array<{ artifactId: string; producerStageId: string }> = [];
    for (const artifactId of stage.requiredInputArtifacts) {
      const producer = receipt.plan.stages.find(
        (candidate) => candidate.stageId !== stage.stageId && candidate.producedArtifacts.includes(artifactId),
      );
      // An input from outside the run is not checked here; unverifiedClaims records it as evidence-content (D-0048).
      if (!producer) continue;
      const producerResult = receipt.stageResults.find((candidate) => candidate.stageId === producer.stageId);
      if (requireDeclaredTarget && producerResult?.state === "passed") {
        this.assertRequiredArtifacts(producer, producerResult);
      }
      const verified = producerResult?.state === "passed" && producerResult.output.artifacts.some(
        (artifact) => artifact.artifactId === artifactId
          && Boolean(artifact.locator)
          && Boolean(artifact.digest)
          && Boolean(artifact.targetDigest),
      );
      if (!verified) missing.push({ artifactId, producerStageId: producer.stageId });
    }
    if (missing.length > 0) {
      throw new WorkflowContractError("MISSING_EVIDENCE", msg("workflow.service.plannedInputArtifactsBackedProducer", {}), {
        stageId: stage.stageId,
        missingInputs: missing,
      });
    }
  }

  private assertDeliberationGate(stage: PlannedStageV1, result: StageResultV1): void {
    if (!stage.requiredArtifacts.includes("decision-record")) return;
    if (!stage.gate.validatorSchema) {
      throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.deliberationProviderDeclareDecisionRecord", {}), {
        stageId: stage.stageId,
      });
    }
    let record: Record<string, unknown>;
    try {
      record = this.validator.declaredSchema(
        this.registry.rootDirectory,
        stage.gate.validatorSchema,
        result.output.output?.decisionRecord,
        "deliberation decision record",
      );
    } catch (error) {
      // The public gate code stays GATE_FAILED, but the original code and an allow-listed subset of its
      // details are kept so a schema changed after planning stays distinguishable from an output violation.
      const contractError = error instanceof WorkflowContractError ? error : null;
      const causeDetails: Record<string, unknown> = {};
      for (const key of SCHEMA_CAUSE_DETAIL_KEYS) {
        if (contractError?.details && Object.hasOwn(contractError.details, key)) causeDetails[key] = contractError.details[key];
      }
      throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.deliberationRequiresSchemaValidDecisionRecord", {}), {
        stageId: stage.stageId,
        causeCode: contractError?.code ?? null,
        causeDetails: Object.keys(causeDetails).length > 0 ? causeDetails : null,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const semanticErrors = validateDecisionRecordSemantics(record);
    if (semanticErrors.length > 0) {
      throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.decisionRecordV1FailedCanonicalSemantic", {}), {
        stageId: stage.stageId,
        semanticErrors,
      });
    }
    const run = record.run as Record<string, unknown>;
    const proposal = record.consensus_proposal as Record<string, unknown> | null;
    if (
      run.assurance === "provisional"
      || run.capability_shortfall !== false
      || proposal === null
      || proposal.status === "no_consensus"
    ) {
      throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.deliberationResultEligibleAdvanceWorkflow", {}), {
        stageId: stage.stageId,
        assurance: run.assurance,
        capabilityShortfall: run.capability_shortfall,
        consensusStatus: proposal?.status ?? null,
      });
    }
    if ((run.stage === "HIGH" || run.stage === "CRITICAL") && run.strict !== true) {
      throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.highCriticalDeliberationRequiresStrict", {}), {
        stageId: stage.stageId,
        stage: run.stage,
      });
    }
    if (proposal.status === "conditional_consensus" && result.output.output?.conditionsVerified !== true) {
      throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.conditionalConsensusAdvanceAfterConditions", {}), {
        stageId: stage.stageId,
      });
    }
  }

  private assertEvaluationValidityGate(stage: PlannedStageV1, result: StageResultV1): void {
    if (stage.requiredCapability !== "evaluation-validity-audit") return;
    const output = result.output.output;
    // D0336: a v1 report carries only self-asserted actor UUIDs and no trust boundary observes worker separation,
    // so no PASS can complete this stage, whatever its purpose, verdict, qualification flag, limitations or digest,
    // and whether it is recorded now or was recorded by earlier code. A BLOCKED report still records as blocked.
    throw new WorkflowContractError(
      "GATE_FAILED",
      msg("workflow.service.evaluationValidityPASSCompleteStage", {}),
      {
        stageId: stage.stageId,
        cause: "WORKER_INDEPENDENCE_UNOBSERVED",
        purpose: stage.evaluationAuditPurpose ?? null,
        auditStage: output?.auditStage ?? null,
        verdict: output?.verdict ?? null,
        qualifiesAsQualityOrReleaseEvidence: output?.qualifiesAsQualityOrReleaseEvidence ?? null,
      },
    );
  }

  /**
   * AGS checks what it can see: the frozen phase, the audited target against the signed plan and the observed
   * actors. Independence, fresh context, no re-delegation and post-execution state stay the root's declaration:
   * a contradicting declaration fails here, a consistent one is recorded in unverifiedClaims (D-0097).
   */
  private assertMandatoryAuditGate(stage: PlannedStageV1, result: StageResultV1, observedActors: Array<string | null> = []): void {
    if (stage.riskGate !== "mandatory" || !stage.requiredArtifacts.includes("gate-verdict")) return;
    const requiredPhase = this.requireAuditPhase(stage);
    const output = result.output.output;
    const auditorId = output?.auditorId;
    const implementationActorIds = output?.implementationActorIds;
    const auditTarget = output?.auditTarget;
    const blockingFindings = output?.blockingFindings;
    const phase = output?.phase;
    if (
      output?.gateVerdict !== "PASS"
      || typeof auditorId !== "string"
      || auditorId.length === 0
      || !Array.isArray(implementationActorIds)
      || implementationActorIds.length === 0
      || implementationActorIds.some((actorId) => typeof actorId !== "string" || actorId.length === 0)
      || typeof auditTarget !== "string"
      || auditTarget.length === 0
      || output?.freshContext !== true
      || output?.delegationAllowed !== false
      || !Array.isArray(blockingFindings)
      || blockingFindings.length > 0
      || output?.stale !== false
      || phase !== requiredPhase
      || typeof output?.postExecutionVerified !== "boolean"
    ) {
      throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.mandatoryAuditRequiresDeclaredCurrent", {}), {
        stageId: stage.stageId,
        requiredPhase,
      });
    }
    if ((requiredPhase === "post-execution" || requiredPhase === "post-deploy") && output.postExecutionVerified !== true) {
      throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.postExecutionPostDeployAudits", {}), {
        stageId: stage.stageId,
        phase: requiredPhase,
      });
    }
    const verdictTarget = result.output.artifacts.find((artifact) => artifact.artifactId === "gate-verdict")?.targetDigest;
    if (!verdictTarget || evidenceKey(auditTarget) !== evidenceKey(verdictTarget)) {
      throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.auditTargetSignedPlanTarget", {}), {
        stageId: stage.stageId,
        reason: "AUDIT_TARGET_NOT_PLANNED",
      });
    }
    if (implementationActorIds.includes(auditorId)) {
      throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.declaredAuditorAlsoDeclaredImplementation", {}), {
        stageId: stage.stageId,
        auditorId,
        implementationActorIds,
      });
    }
    if (observedActors.includes(auditorId)) {
      throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.declaredAuditorActorAGSObserved", {}), {
        stageId: stage.stageId,
        reason: "AUDITOR_IS_OBSERVED_ROOT",
      });
    }
  }

  /** Server-side stale check: a file the audit stage recorded and the server hashed must still have those bytes. */
  private assertAuditedFilesUnchanged(stage: PlannedStageV1, result: StageResultV1): void {
    if (stage.riskGate !== "mandatory" || !stage.requiredArtifacts.includes("gate-verdict")) return;
    for (const check of result.artifactChecks ?? []) {
      if (check.check !== "sha256-matched") continue;
      const recorded = check.source === "artifact"
        ? result.output.artifacts.find((item) => item.artifactId === check.artifactId && item.locator === check.locator)?.digest
        : result.evidence.find((item) => item.artifactId === check.artifactId && item.locator === check.locator)?.digest;
      if (!recorded || localFileDigest(check.locator) !== evidenceKey(recorded)) {
        throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.fileAuditRecordedChangedAfter", {}), {
          stageId: stage.stageId,
          artifactId: check.artifactId,
          reason: "AUDIT_TARGET_CHANGED",
        });
      }
    }
  }

  /** Hashes local files named by artifacts and evidence. A passing stage cannot record a digest the bytes contradict. */
  private checkArtifacts(stage: PlannedStageV1, result: StageResultV1): ArtifactCheckV1[] {
    const entries = [
      ...result.output.artifacts.map((item) => ({ source: "artifact" as const, artifactId: item.artifactId, locator: item.locator, digest: item.digest as string | undefined })),
      ...result.evidence.map((item) => ({ source: "evidence" as const, artifactId: item.artifactId, locator: item.locator, digest: item.digest as string | undefined })),
    ];
    return entries.map(({ source, artifactId, locator, digest }) => {
      const actual = digest ? localFileDigest(locator) : null;
      if (actual && actual !== evidenceKey(digest!)) {
        if (result.state === "passed") {
          throw new WorkflowContractError("BINDING_INVALID", msg("workflow.service.recordedDigestMatchLocalFile", {}), {
            stageId: stage.stageId,
            artifactId,
            reason: "ARTIFACT_DIGEST_MISMATCH",
          });
        }
        return { source, artifactId, locator, check: "not-checked" as const };
      }
      return { source, artifactId, locator, check: actual ? "sha256-matched" as const : "not-checked" as const };
    });
  }

  /**
   * The first passed workspace baseline in a convergence lineage (root and parentRootId chain) is the baseline
   * for the whole lineage, so a re-captured baseline cannot absorb the task's own changes (D-0339).
   */
  private assertBaselineLineage(receipt: WorkflowReceiptV1, stage: PlannedStageV1, result: StageResultV1): void {
    const capture = stage.satisfiedCapabilities.includes("change-scope-baseline-capture");
    const assurance = stage.satisfiedCapabilities.includes("change-scope-assurance");
    if (!capture && !assurance) return;
    const recorded = capture ? result.output.output?.manifestSha256 : result.output.output?.baselineDigest;
    const pinned = this.lineageBaseline(receipt.runId) ?? (assurance ? this.runBaseline(receipt) : null);
    if (pinned !== null && recorded !== pinned) {
      throw new WorkflowContractError("BINDING_INVALID", msg("workflow.service.workspaceBaselineDiffersFirstBaseline", {}), {
        stageId: stage.stageId,
        reason: "BASELINE_REBOUND",
      });
    }
  }

  private runBaseline(receipt: WorkflowReceiptV1): unknown {
    for (const result of receipt.stageResults) {
      const stage = receipt.plan.stages.find((item) => item.stageId === result.stageId);
      if (result.state === "passed" && stage?.satisfiedCapabilities.includes("change-scope-baseline-capture")) {
        return result.output.output?.manifestSha256 ?? null;
      }
    }
    return null;
  }

  private lineageBaseline(runId: string): unknown {
    const binding = this.store.getGuardedRunBinding(runId);
    const chain: string[] = [];
    for (let rootId: string | null = binding?.root.rootId ?? null; rootId && !chain.includes(rootId);) {
      chain.unshift(rootId);
      rootId = this.store.getConvergenceSnapshot(rootId)?.root.parentRootId ?? null;
    }
    for (const rootId of chain) {
      for (const otherRunId of this.store.getConvergenceSnapshot(rootId)?.workflowRunIds ?? []) {
        if (otherRunId === runId) continue;
        const other = this.store.getRun(otherRunId);
        const baseline = other ? this.runBaseline(other) : null;
        if (baseline !== null) return baseline;
      }
    }
    return null;
  }

  private requireAuditPhase(stage: PlannedStageV1): AuditPhaseV1 {
    if (stage.requiredAuditPhase === undefined) {
      throw new WorkflowContractError("BINDING_REQUIRED", msg("workflow.service.mandatoryAuditPlanFrozenRequired", {}), {
        stageId: stage.stageId,
      });
    }
    return stage.requiredAuditPhase;
  }

  private bootstrapExecutionRequirement(): ExecutionRequirementV1 {
    // 초기 접수는 신뢰할 수 있는 관측을 요구한다. 성능 하한은 실제 단계가 소유한다.
    return {
      policyId: "semantic-execution-assurance-v1",
      kind: "semantic",
      minimumModelClass: null,
      minimumReasoningEffort: null,
      observationRequired: true,
    };
  }

  private stageExecutionRequirement(
    task: TaskEnvelopeV1,
    capabilities: string[],
    providerRiskLevel?: RiskLevel,
  ): ExecutionRequirementV1 {
    if (isDeterministicStage(capabilities)) {
      return {
        policyId: "semantic-execution-assurance-v1",
        kind: "deterministic",
        minimumModelClass: null,
        minimumReasoningEffort: null,
        observationRequired: false,
      };
    }

    // AGENTS.md의 명시 고위험 정책만 집행한다. 역할 추천이나 감사 의무는 모델 하한이 아니다.
    const riskLevel = providerRiskLevel !== undefined && RISK_LEVEL.indexOf(providerRiskLevel) > RISK_LEVEL.indexOf(task.riskLevel)
      ? providerRiskLevel : task.riskLevel;
    const highRisk = riskLevel === "high" || riskLevel === "critical";
    return {
      policyId: "semantic-execution-assurance-v1",
      kind: "semantic",
      minimumModelClass: highRisk ? "general" : null,
      minimumReasoningEffort: highRisk ? "high" : null,
      observationRequired: true,
    };
  }

  /** What the host observed, or null when it observed nothing. */
  private observeExecutionContext(binding: ExecutionObservationBindingV1): ExecutionContextV1 | null {
    const context = this.trustedExecutionContextProvider?.observe(binding) ?? null;
    return context ? clone(context) : null;
  }

  private observeTrustedExecutionContext(
    binding: ExecutionObservationBindingV1,
    subject: ExecutionSubject,
  ): ExecutionContextV1 {
    const context = this.observeExecutionContext(binding);
    if (!context) {
      throw new WorkflowContractError(
        "BINDING_REQUIRED",
        msg("workflow.service.requiresTrustedAttestation", subject),
        { binding, observation: this.trustedExecutionContextProvider?.diagnose?.() ?? {
          status: "provider-not-configured",
          connection: "Connect a host-owned TrustedExecutionContextProvider or enable a supported host attestation adapter. Caller executionContext is not a trusted observation.",
        } },
      );
    }
    return context;
  }

  private assertTrustedExecutionContext(
    requirement: ExecutionRequirementV1,
    context: ExecutionContextV1,
    subject: ExecutionSubject,
    binding: ExecutionObservationBindingV1,
    enforceMinimum = true,
  ): void {
    this.assertExecutionContext(requirement, context, subject, false);
    this.assertTrustedExecutionBinding(context, subject, binding);
    this.assertTrustedExecutionFreshness(context, subject);
    if (enforceMinimum) this.assertExecutionContext(requirement, context, subject);
  }

  private assertTrustedExecutionBinding(
    context: ExecutionContextV1,
    subject: ExecutionSubject,
    binding: ExecutionObservationBindingV1,
  ): void {
    if (
      typeof context.observationId !== "string"
      || context.observationId.length < 16
      || context.taskId !== binding.taskId
      || context.runId !== binding.runId
      || context.stageId !== binding.stageId
      || context.revision !== binding.revision
      || typeof context.actorId !== "string"
      || context.actorId.length === 0
    ) {
      throw new WorkflowContractError(
        "BINDING_INVALID",
        msg("workflow.service.attestationNotBound", subject),
        { binding, context },
      );
    }
  }

  // An observation does not age out: reuse is refused by the one-use claim, not by time. A legacy expiresAt is ignored.
  private assertTrustedExecutionFreshness(context: ExecutionContextV1, subject: ExecutionSubject): void {
    const observedAt = Date.parse(context.observedAt);
    if (Number.isNaN(observedAt) || observedAt > Date.now() + TRUSTED_EXECUTION_CLOCK_SKEW_MS) {
      throw new WorkflowContractError(
        "BINDING_INVALID",
        msg("workflow.service.attestationObservationTime", subject),
        { observedAt: context.observedAt },
      );
    }
  }

  private consumeTrustedExecutionObservation(context: ExecutionContextV1, subject: ExecutionSubject): void {
    const observationId = context.observationId;
    if (!observationId) {
      throw new WorkflowContractError(
        "BINDING_INVALID",
        msg("workflow.service.attestationClaimFieldsMissing", subject),
        { observationId: null },
      );
    }
    if (!this.store.claimExecutionObservation(observationId, new Date().toISOString())) {
      throw new WorkflowContractError(
        "BINDING_INVALID",
        msg("workflow.service.attestationConsumed", subject),
        { observationId },
      );
    }
  }

  private assertStrictPlanExecutionAssurance(plan: WorkflowPlanV1, subject: "workflowAttempt" | "guardedStart"): void {
    const bootstrap = plan.bootstrapExecution;
    if (!bootstrap) {
      throw new WorkflowContractError(
        "BINDING_REQUIRED",
        msg("workflow.service.planRequiresBootstrapAssurance", { subject }),
      );
    }
    const binding: ExecutionObservationBindingV1 = {
      phase: "bootstrap",
      taskId: plan.taskId,
      runId: null,
      stageId: null,
      revision: null,
    };
    const bootstrapSubject: ExecutionSubject = { subject: `${subject}Bootstrap`, stageId: "" };
    this.assertExecutionContext(bootstrap.requirement, bootstrap.context, bootstrapSubject, false);
    this.assertTrustedExecutionBinding(bootstrap.context, bootstrapSubject, binding);
    for (const stage of plan.stages) {
      if (!stage.executionRequirement && !isDeterministicStage(stage.satisfiedCapabilities)) {
        throw new WorkflowContractError(
          "BINDING_REQUIRED",
          msg("workflow.service.planStageWithoutExecutionRequirement", { subject, stageId: stage.stageId }),
        );
      }
    }
  }

  private assertExecutionContext(
    requirement: ExecutionRequirementV1,
    context: ExecutionContextV1 | null | undefined,
    subject: ExecutionSubject,
    enforceMinimum = true,
  ): void {
    if (requirement.kind === "deterministic") return;
    if (!context) {
      throw new WorkflowContractError(
        "BINDING_REQUIRED",
        msg("workflow.service.requiresObservedModel", subject),
        { requirement },
      );
    }
    if (
      context.schemaVersion !== CONTRACT_VERSION
      || typeof context.model !== "string"
      || context.model.length === 0
      || (context.modelClass !== null && !MODEL_CLASS.includes(context.modelClass))
      || (context.reasoningEffort !== null && !REASONING_EFFORT.includes(context.reasoningEffort))
      || !["runtime", "spawn-result"].includes(context.source)
      || Number.isNaN(Date.parse(context.observedAt))
    ) {
      throw new WorkflowContractError(
        "BINDING_INVALID",
        msg("workflow.service.executionContextMalformed", subject),
        { context },
      );
    }

    if (!enforceMinimum) return;

    const minimumModelClass = requirement.minimumModelClass;
    const minimumReasoningEffort = requirement.minimumReasoningEffort;
    if (minimumModelClass === null && minimumReasoningEffort === null) return;
    if (!minimumModelClass || !minimumReasoningEffort) {
      throw new WorkflowContractError(
        "INVALID_INPUT",
        msg("workflow.service.semanticRequirementIncomplete", subject),
        { requirement },
      );
    }

    // A model no catalog names has no class to compare and is not refused for it; a known lighter class is.
    const reasonCode = context.reasoningEffort === null ? "REASONING_EFFORT_UNOBSERVED"
      : REASONING_EFFORT.indexOf(context.reasoningEffort) < REASONING_EFFORT.indexOf(minimumReasoningEffort) ? "REASONING_EFFORT_BELOW_FLOOR"
        : context.modelClass !== null && MODEL_CLASS.indexOf(context.modelClass) < MODEL_CLASS.indexOf(minimumModelClass) ? "MODEL_CLASS_BELOW_FLOOR"
          : null;
    if (reasonCode) {
      throw new WorkflowContractError(
        "GATE_FAILED",
        msg("workflow.service.executionProfileBelowFloor", subject),
        {
          reasonCode,
          model: context.model,
          modelClass: context.modelClass,
          reasoningEffort: context.reasoningEffort,
          minimumModelClass,
          minimumReasoningEffort,
        },
      );
    }
  }

  private assertExecutionAssurance(stage: PlannedStageV1, result: StageResultV1): void {
    if (!stage.executionRequirement || result.state !== "passed") return;
    this.assertExecutionContext(
      stage.executionRequirement,
      result.executionContext,
      stageSubject(stage.stageId),
      result.recordedBy?.parentChain.length !== 0,
    );
  }

  private validateWorkUnitGraph(task: TaskEnvelopeV1): void {
    const graph = new Map<string, string[]>();
    for (const unit of task.workUnits) {
      if (graph.has(unit.id)) {
        throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.workUnitIDsUnique", {}), { workUnitId: unit.id });
      }
      graph.set(unit.id, unit.dependencies);
    }
    for (const unit of task.workUnits) {
      for (const dependencyId of unit.dependencies) {
        if (!graph.has(dependencyId)) {
          throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.workUnitDependencyExist", {}), {
            workUnitId: unit.id,
            dependencyId,
          });
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (unitId: string): void => {
      if (visiting.has(unitId)) {
        throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.workUnitDependenciesContainCycle", {}), {
          workUnitId: unitId,
        });
      }
      if (visited.has(unitId)) return;
      visiting.add(unitId);
      for (const dependencyId of graph.get(unitId) ?? []) visit(dependencyId);
      visiting.delete(unitId);
      visited.add(unitId);
    };
    for (const unit of task.workUnits) visit(unit.id);
  }

  private setRunningStagePointers(plan: WorkflowPlanV1): void {
    const readyStages = plan.stages.filter((stage) => stage.state === "ready");
    plan.currentStageId = readyStages[0]?.stageId ?? null;
    plan.nextStageId = readyStages[1]?.stageId ?? null;
  }

  private addUnique(destination: string[], values: string[]): void {
    for (const value of values) {
      if (!destination.includes(value)) destination.push(value);
    }
  }

  private signPlan(plan: WorkflowPlanV1): string {
    return createHmac("sha256", this.planSigningKey)
      .update(canonicalJson(this.planWithoutIntegrityToken(plan), "Plan"), "utf8")
      .digest("base64url");
  }

  private assertPlanIntegrity(plan: WorkflowPlanV1): void {
    if (!PLAN_INTEGRITY_TOKEN.test(plan.integrityToken)) {
      throw new WorkflowContractError(
        "INVALID_INPUT",
        msg("workflow.service.workflowPlanIntegrityTokenCanonical", {}),
      );
    }
    const expected = Buffer.from(this.signPlan(plan), "base64url");
    const supplied = Buffer.from(plan.integrityToken, "base64url");
    if (
      supplied.toString("base64url") !== plan.integrityToken
      || supplied.length !== expected.length
      || !timingSafeEqual(supplied, expected)
    ) {
      throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.workflowPlanIntegrityTokenMissing", {}));
    }
    for (const stage of plan.stages) {
      if (stage.riskGate === "mandatory" && stage.requiredArtifacts.includes("gate-verdict")) this.requireAuditPhase(stage);
    }
  }

  private planWithoutIntegrityToken(plan: WorkflowPlanV1): Omit<WorkflowPlanV1, "integrityToken"> {
    const unsignedPlan = { ...plan } as Partial<WorkflowPlanV1>;
    delete unsignedPlan.integrityToken;
    return unsignedPlan as Omit<WorkflowPlanV1, "integrityToken">;
  }

  private convergenceDigests(task: TaskEnvelopeV1, frame: ConvergenceFrameV1) {
    return {
      ...frameDigests(frame),
      taskDigest: convergenceDigest(task),
    };
  }

  private assertConvergenceFrame(frame: ConvergenceFrameV1): void {
    this.validator.convergenceFrame(frame);
    const artifactIds = [...frame.controlArtifacts, ...frame.targetArtifacts].map((artifact) => artifact.artifactId);
    if (new Set(artifactIds).size !== artifactIds.length) {
      throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.convergenceArtifactIDsUniqueAcross", {}));
    }
    if (frame.operationalSettings.maxAttemptsPerEpoch !== 3 || frame.operationalSettings.maxEpochs !== 2) {
      throw new WorkflowContractError("INVALID_INPUT", msg("workflow.service.convergenceGuardPolicyFixedThree", {}));
    }
  }

  private artifactRolesChanged(baseline: ConvergenceFrameV1, proposed: ConvergenceFrameV1): boolean {
    const baselineRoles = new Map([...baseline.controlArtifacts, ...baseline.targetArtifacts].map((artifact) => [artifact.artifactId, artifact.role]));
    return [...proposed.controlArtifacts, ...proposed.targetArtifacts]
      .some((artifact) => baselineRoles.has(artifact.artifactId) && baselineRoles.get(artifact.artifactId) !== artifact.role);
  }

  private requireConvergenceSnapshot(rootId: string): ConvergenceSnapshot {
    const snapshot = this.store.getConvergenceSnapshot(rootId);
    if (!snapshot) throw new WorkflowContractError("RUN_NOT_FOUND", msg("workflow.service.convergenceRootFound", {}), { rootId });
    this.validator.convergenceRoot(snapshot.root);
    return snapshot;
  }

  private newRunningReceipt(plan: WorkflowPlanV1): WorkflowReceiptV1 {
    const runId = `run-${plan.taskId}-${this.store.nextRunSequence()}`;
    plan.state = "running";
    this.setRunningStagePointers(plan);
    const receipt: WorkflowReceiptV1 = {
      schemaVersion: CONTRACT_VERSION,
      runId,
      revision: 0,
      state: "running",
      plan,
      stageResults: [],
      blockers: [],
      unresolved: [],
      error: null,
      unverifiedClaims: [],
    };
    this.assertReceipt(receipt);
    return receipt;
  }

  /** Records a rejected retry on the root before failing, so its evidence cannot return as new. */
  private rejectRetry(
    root: ConvergenceRootV1,
    entry: RetryRejectionV1,
    message: MessageRef,
    details: Record<string, unknown>,
  ): never {
    const recorded = root.retryRejections ?? [];
    const identity = (item: RetryRejectionV1): string => convergenceDigest({ ...item, rejectedAt: "" });
    let rootRevision = root.revision;
    if (!recorded.some((item) => identity(item) === identity(entry))) {
      const updated = bumpedRoot(root, entry.rejectedAt);
      updated.retryRejections = [...recorded, entry];
      this.validator.convergenceRoot(updated);
      if (!this.store.updateConvergenceRoot(updated, root.revision)) {
        throw new WorkflowContractError("STALE_REVISION", msg("workflow.service.convergenceRootChangedWhileRecording2", {}), {
          rootId: root.rootId,
        });
      }
      rootRevision = updated.revision;
    }
    throw new WorkflowContractError("NEW_EVIDENCE_REQUIRED", message, { ...details, rootRevision });
  }

  private moveRootToReview(root: ConvergenceRootV1): void {
    const updated = bumpedRoot(root, new Date().toISOString());
    updated.state = "needs-review";
    if (!this.store.updateConvergenceRoot(updated, root.revision)) {
      throw new WorkflowContractError("STALE_REVISION", msg("workflow.service.convergenceRootChangedWhileApplying", {}), {
        rootId: root.rootId,
      });
    }
  }

  private throwRootGate(root: ConvergenceRootV1, snapshot: ConvergenceSnapshot): never {
    const attempts = consumedLeases(snapshot, root.currentEpoch).length;
    if (root.state === "needs-review" && attempts >= root.frame.operationalSettings.maxAttemptsPerEpoch) {
      throw new WorkflowContractError("ATTEMPT_BUDGET_EXHAUSTED", msg("workflow.service.independentReviewRequiredBeforeAnother", {}), {
        rootId: root.rootId,
        epoch: root.currentEpoch,
      });
    }
    throw new WorkflowContractError("FRAME_REVIEW_REQUIRED", msg("workflow.service.convergenceRootGatedIssueAnother", {}), {
      rootId: root.rootId,
      state: root.state,
    });
  }

  private buildConvergenceStatus(snapshot: ConvergenceSnapshot): ConvergenceStatusV1 {
    const attemptsUsed = consumedLeases(snapshot, snapshot.root.currentEpoch).length;
    let gateError: ContractErrorBody | null = null;
    if (snapshot.root.state === "needs-review") {
      gateError = attemptsUsed >= snapshot.root.frame.operationalSettings.maxAttemptsPerEpoch
        ? contractErrorBody("ATTEMPT_BUDGET_EXHAUSTED", msg("workflow.service.independentReviewRequiredBeforeAnother", {}),
          { rootId: snapshot.root.rootId, epoch: snapshot.root.currentEpoch })
        : contractErrorBody("FRAME_REVIEW_REQUIRED", msg("workflow.service.taskControlFrameChangeRequires", {}),
          { rootId: snapshot.root.rootId, epoch: snapshot.root.currentEpoch });
    } else if (snapshot.root.state === "needs-user") {
      gateError = contractErrorBody("FRAME_REVIEW_REQUIRED", msg("workflow.service.proposedChangeRequiresNewUser", {}),
        { rootId: snapshot.root.rootId, epoch: snapshot.root.currentEpoch });
    }
    return {
      schemaVersion: CONTRACT_VERSION,
      root: clone(snapshot.root),
      currentEpoch: snapshot.root.currentEpoch,
      maxAttemptsPerEpoch: 3,
      maxEpochs: 2,
      attemptsUsedInEpoch: attemptsUsed,
      attemptsRemainingInEpoch: Math.max(0, 3 - attemptsUsed),
      proposals: clone(snapshot.proposals),
      leases: clone(snapshot.leases),
      outcomes: clone(snapshot.outcomes),
      reviews: clone(snapshot.reviews),
      workflowRunIds: [...snapshot.workflowRunIds],
      gateError,
      unverifiedClaims: convergenceUnverifiedClaims(snapshot),
    };
  }

  private assertReviewRoute(review: ConvergenceReviewV1): void {
    if (review.evidenceRefs.length === 0) {
      throw new WorkflowContractError("MISSING_EVIDENCE", msg("workflow.service.convergenceReviewRequiresEvidence", {}));
    }
    if (review.classification === "semantics-preserving") {
      if (review.route === "resume-new-epoch") {
        if (!review.comparability.comparable || !review.proposedFrame) {
          throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.resumingNewEpochRequiresComparable", {}));
        }
      } else if (!["diagnose", "stop"].includes(review.route)) {
        throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.semanticsPreservingReviewIncompatibleRoute", {}), { route: review.route });
      }
    } else if (review.classification === "semantics-changing") {
      if (review.route !== "needs-user" || review.proposedFrame === null) {
        throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.semanticsChangingReviewsReturnProposed", {}));
      }
    } else if (!["panel", "needs-user", "stop"].includes(review.route)) {
      throw new WorkflowContractError("GATE_FAILED", msg("workflow.service.ambiguousFrameReviewsRoutePanel", {}));
    }
  }

  private convergenceOutcome(
    receipt: WorkflowReceiptV1,
    binding: NonNullable<ReturnType<WorkflowStore["getGuardedRunBinding"]>>,
  ): { root: ConvergenceRootV1; expectedRootRevision: number; outcome: AttemptOutcomeV1 } {
    const recordedAt = new Date().toISOString();
    const expectedRootRevision = binding.root.revision;
    const root = bumpedRoot(binding.root, recordedAt);
    const aborted = receipt.blockers.includes("aborted-by-caller");
    const passed = receipt.state === "passed";
    const state: AttemptOutcomeV1["state"] = passed ? "passed" : aborted ? "aborted" : "failed";
    const attemptsUsed = consumedLeases(this.requireConvergenceSnapshot(root.rootId), root.currentEpoch).length;
    const needsUser = USER_GATE_RECEIPT_STATES.has(receipt.state);
    if (!["needs-user", "abandoned"].includes(root.state)) {
      // A user decision ends the attempt, so it escalates even a pending frame review.
      if (needsUser) root.state = "needs-user";
      else if (root.state !== "needs-review") {
        if (passed) root.state = "completed";
        else if (attemptsUsed >= root.frame.operationalSettings.maxAttemptsPerEpoch) root.state = "needs-review";
        else root.state = "open";
      }
    }
    const fingerprint = passed ? null : failureFingerprint(receipt);
    // Only bytes the server hashed count as evidence a later retry must move past.
    const evidenceRefs = [...new Set(receipt.stageResults.flatMap((result) => (result.artifactChecks ?? [])
      .filter((check) => check.check === "sha256-matched")
      .map((check) => check.source === "artifact"
        ? result.output.artifacts.find((item) => item.artifactId === check.artifactId && item.locator === check.locator)?.digest
        : result.evidence.find((item) => item.artifactId === check.artifactId && item.locator === check.locator)?.digest)
      .filter((digest): digest is string => typeof digest === "string")
      .map(evidenceKey)))];
    const outcome: AttemptOutcomeV1 = {
      schemaVersion: CONTRACT_VERSION,
      outcomeId: `outcome-${randomUUID()}`,
      rootId: root.rootId,
      rootRevision: root.revision,
      leaseId: binding.lease.leaseId,
      epoch: binding.lease.epoch,
      ordinal: binding.lease.ordinal,
      workflowRunId: receipt.runId,
      state,
      receiptDigest: convergenceDigest(receipt),
      failureFingerprint: fingerprint,
      evidenceRefs,
      recordedAt,
    };
    this.validator.attemptOutcome(outcome);
    return { root, expectedRootRevision, outcome };
  }

  private change(
    runId: string,
    expectedRevision: number,
    mutate: (receipt: WorkflowReceiptV1) => void,
  ): ApiResultV1<WorkflowReceiptV1> {
    return this.attempt(() => {
      const receipt = this.requireRun(runId);
      if (!Number.isInteger(expectedRevision) || expectedRevision !== receipt.revision) {
        throw new WorkflowContractError("STALE_REVISION", msg("workflow.service.expectedRevisionMatchCurrentRunRevision", {}), {
          expectedRevision,
          actualRevision: receipt.revision,
        });
      }
      mutate(receipt);
      receipt.revision += 1;
      this.assertReceipt(receipt);
      const binding = this.store.getGuardedRunBinding(runId);
      const convergence = binding && !binding.outcome && receipt.state !== "running"
        ? this.convergenceOutcome(receipt, binding)
        : undefined;
      if (!this.store.updateRun(receipt, expectedRevision, convergence)) {
        const current = this.store.getRun(runId);
        throw new WorkflowContractError("STALE_REVISION", msg("workflow.service.expectedRevisionMatchCurrentRunRevision", {}), {
          expectedRevision,
          actualRevision: current?.revision ?? null,
        });
      }
      return clone(receipt);
    });
  }

  private requireRun(runId: string): WorkflowReceiptV1 {
    const receipt = this.store.getRun(runId);
    if (!receipt) {
      throw new WorkflowContractError("RUN_NOT_FOUND", msg("workflow.service.runFoundWorkflowStorage", {}), { runId });
    }
    this.assertReceipt(receipt);
    return receipt;
  }

  private assertReceipt(receipt: WorkflowReceiptV1): void {
    this.validator.workflowPlan(receipt.plan);
    this.validator.workflowReceipt(receipt);
  }

  private attempt<T>(operation: () => T): ApiResultV1<T> {
    try {
      return apiOk(operation());
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  /** A non-contract failure is a server failure, never the caller's invalid input (contractFailure). */
  private toErrorBody(error: unknown): ContractErrorBody {
    return contractFailure(error).toBody();
  }
}
