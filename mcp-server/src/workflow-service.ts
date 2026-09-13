import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  type ApiResultV1,
  type AttemptLeaseV1,
  type AttemptOutcomeV1,
  CONTRACT_VERSION,
  type ConvergenceFrameV1,
  type ConvergenceReviewV1,
  type ConvergenceRootV1,
  type ConvergenceStatusV1,
  type ContractErrorBody,
  type PlannedStageV1,
  POLICY_CAPABILITY,
  type RoutedSkillProviderV2,
  type StateMappingRuleV2,
  type StageResultV1,
  type TaskEnvelopeV1,
  type WorkflowPlanV1,
  type WorkflowReceiptV1,
  WorkflowContractError,
} from "../../contracts/types.js";
import {
  convergenceDigest,
  frameDigests,
  normalizeWorkspaceLocator,
} from "./convergence-logic.js";
import { FileSkillRegistry, selectSkillByCapability } from "./registry.js";
import { validateDecisionRecordSemantics } from "./decision-record-validator.js";
import { ContractValidator } from "./schema-validator.js";
import { assertReceiptPolicy } from "./receipt-policy.js";
import {
  createPlanSigningKey,
  type ConvergenceSnapshot,
  InMemoryWorkflowStore,
  PLAN_SIGNING_KEY,
  type WorkflowStore,
} from "./workflow-store.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

const KOREAN_PROSE_CAPABILITIES = [
  "korean-prose-selection",
  "korean-prose-editing",
  "korean-prose-verification",
  "korean-prose-finalization",
] as const;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new WorkflowContractError("INVALID_INPUT", "Plan contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new WorkflowContractError("INVALID_INPUT", "Plan contains a non-serializable value.");
}

/**
 * Planning is read-only. Only startWorkflow creates a stored run, while
 * specialists remain directly callable.
 */
export class WorkflowService {
  private readonly planSigningKey: Buffer;

  constructor(
    private readonly registry: FileSkillRegistry,
    private readonly validator = new ContractValidator(),
    private readonly store: WorkflowStore = new InMemoryWorkflowStore(),
  ) {
    const encodedKey = this.store.getOrCreateSecret(PLAN_SIGNING_KEY, createPlanSigningKey);
    this.planSigningKey = Buffer.from(encodedKey, "base64url");
    if (this.planSigningKey.length !== 32) {
      throw new WorkflowContractError("INVALID_INPUT", "Stored plan signing key is invalid.");
    }
  }

  planWorkflow(rawTask: unknown): ApiResultV1<WorkflowPlanV1> {
    try {
      const task = this.validator.taskEnvelope(rawTask);
      this.validateWorkUnitGraph(task);
      const plan = this.buildPlan(task, this.registry.read());
      plan.integrityToken = this.signPlan(plan);
      this.validator.workflowPlan(plan);
      return apiOk(plan);
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  openConvergenceRoot(rawRequest: unknown): ApiResultV1<ConvergenceRootV1> {
    try {
      const request = this.validator.openConvergenceRootRequest(rawRequest);
      this.validateWorkUnitGraph(request.taskEnvelope);
      this.assertConvergenceFrame(request.frame);
      if (!request.taskEnvelope.orchestration.requested || !request.taskEnvelope.orchestration.mcpAvailable) {
        throw new WorkflowContractError("INVALID_INPUT", "Convergence roots require an MCP-backed orchestrated task.");
      }
      if (request.parentRootId && request.userApprovalRefs.length === 0) {
        throw new WorkflowContractError("INVALID_INPUT", "Replacing a convergence root requires user approval evidence.", {
          parentRootId: request.parentRootId,
        });
      }
      if (request.parentRootId) {
        const parent = this.requireConvergenceSnapshot(request.parentRootId).root;
        if (!["needs-review", "needs-user"].includes(parent.state)) {
          throw new WorkflowContractError("INVALID_TRANSITION", "Only a gated convergence root may be replaced.", {
            parentRootId: parent.rootId,
            parentState: parent.state,
          });
        }
        if (
          parent.frame.workspace.workspaceId !== request.frame.workspace.workspaceId
          || normalizeWorkspaceLocator(parent.frame.workspace.locator) !== normalizeWorkspaceLocator(request.frame.workspace.locator)
        ) {
          throw new WorkflowContractError("INVALID_INPUT", "A replacement root must remain bound to the same workspace.");
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
      const conflicting = this.store.insertConvergenceRoot(root);
      if (conflicting) {
        throw new WorkflowContractError("ROOT_CONFLICT", "An active convergence root already covers this workspace scope.", {
          rootId: conflicting.rootId,
          workspaceId: conflicting.frame.workspace.workspaceId,
          scope: conflicting.taskEnvelope.scope.included,
        });
      }
      return apiOk(clone(root));
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  claimWorkflowAttempt(rawProposal: unknown): ApiResultV1<AttemptLeaseV1> {
    try {
      const proposal = clone(this.validator.attemptProposal(rawProposal));
      this.assertPlanIntegrity(proposal.plan);
      this.assertConvergenceFrame(proposal.frame);
      if (proposal.plan.executionMode !== "orchestrated" || proposal.plan.state !== "ready") {
        throw new WorkflowContractError("INVALID_TRANSITION", "Only a ready orchestrated plan can claim an attempt lease.");
      }
      if (proposal.plan.taskId !== proposal.taskEnvelope.taskId) {
        throw new WorkflowContractError("INVALID_INPUT", "Attempt task and workflow plan IDs do not match.");
      }
      if (proposal.plan.taskDigest !== convergenceDigest(proposal.taskEnvelope)) {
        throw new WorkflowContractError("LEASE_CONFLICT", "The workflow plan is bound to a different task envelope.", {
          rootId: proposal.rootId,
          taskId: proposal.taskEnvelope.taskId,
        });
      }
      const expectedPlan = this.buildPlan(proposal.taskEnvelope, this.registry.read());
      expectedPlan.integrityToken = this.signPlan(expectedPlan);
      if (canonicalJson(expectedPlan) !== canonicalJson(proposal.plan)) {
        throw new WorkflowContractError("LEASE_CONFLICT", "The workflow plan was not produced from the proposed task envelope.", {
          rootId: proposal.rootId,
          taskId: proposal.taskEnvelope.taskId,
        });
      }

      let snapshot = this.requireConvergenceSnapshot(proposal.rootId);
      this.expireStaleLeases(snapshot);
      snapshot = this.requireConvergenceSnapshot(proposal.rootId);
      const root = snapshot.root;
      if (snapshot.leases.some((lease) => lease.state === "issued")) {
        throw new WorkflowContractError("LEASE_CONFLICT", "A live attempt lease already exists for this convergence root.", {
          rootId: root.rootId,
        });
      }
      if (proposal.expectedRevision !== root.revision) {
        throw new WorkflowContractError("STALE_REVISION", "expectedRevision does not match the convergence root.", {
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
        this.moveRootToReview(root, "The task or control frame changed before the next full attempt.");
        throw new WorkflowContractError("FRAME_REVIEW_REQUIRED", "Task, control, workspace, operational, or artifact-role changes require independent review.", {
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

      const attempts = snapshot.leases.filter((lease) => lease.epoch === root.currentEpoch && lease.state === "consumed");
      if (attempts.length >= root.frame.operationalSettings.maxAttemptsPerEpoch) {
        this.moveRootToReview(root, "The convergence attempt budget is exhausted.");
        throw new WorkflowContractError("ATTEMPT_BUDGET_EXHAUSTED", "Three full attempts have already started in this convergence epoch.", {
          rootId: root.rootId,
          epoch: root.currentEpoch,
          attemptsUsed: attempts.length,
        });
      }

      const currentOutcomes = snapshot.outcomes.filter((outcome) => outcome.epoch === root.currentEpoch);
      const latestOutcome = currentOutcomes.at(-1) ?? null;
      if (currentOutcomes.length < attempts.length) {
        throw new WorkflowContractError("LEASE_CONFLICT", "The previous full attempt is still active and must reach a terminal outcome before another lease can be claimed.", {
          rootId: root.rootId,
          epoch: root.currentEpoch,
        });
      }
      if (attempts.length === 0) {
        if (proposal.priorFailure !== null) {
          throw new WorkflowContractError("INVALID_INPUT", "The first attempt in an epoch must not claim a prior failure.");
        }
      } else {
        if (!latestOutcome || latestOutcome.state === "passed") {
          throw new WorkflowContractError("LEASE_CONFLICT", "The previous full attempt has not produced a retryable failure.", {
            rootId: root.rootId,
          });
        }
        if (!proposal.priorFailure || proposal.priorFailure.fingerprint !== latestOutcome.failureFingerprint) {
          throw new WorkflowContractError("NEW_EVIDENCE_REQUIRED", "A retry must bind the latest failure fingerprint and a discriminating hypothesis.", {
            expectedFingerprint: latestOutcome.failureFingerprint,
          });
        }
        const priorLease = attempts.at(-1)!;
        const priorProposal = snapshot.proposals.find((item) => convergenceDigest(item) === priorLease.proposalDigest);
        const sameTarget = proposedDigests.targetDigest === priorLease.targetDigest;
        const oldEvidence = new Set(priorProposal?.priorFailure?.evidenceRefs ?? []);
        const hasNewEvidence = proposal.priorFailure.evidenceRefs.some((reference) => !oldEvidence.has(reference));
        if (sameTarget && !hasNewEvidence) {
          throw new WorkflowContractError("NEW_EVIDENCE_REQUIRED", "The proposed retry changes neither the target nor the observed evidence.", {
            rootId: root.rootId,
            route: "diagnose",
          });
        }
      }

      const now = new Date();
      const updatedRoot = clone(root);
      updatedRoot.revision += 1;
      updatedRoot.updatedAt = now.toISOString();
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
        actorId: proposal.actorId,
        outputTargets: [...proposal.outputTargets],
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + proposal.frame.operationalSettings.leaseTtlSeconds * 1000).toISOString(),
        state: "issued",
      };
      this.validator.attemptLease(lease);
      if (!this.store.insertAttemptLease(updatedRoot, root.revision, proposal, lease)) {
        throw new WorkflowContractError("LEASE_CONFLICT", "The convergence root changed while the lease was being claimed.", {
          rootId: root.rootId,
        });
      }
      return apiOk(clone(lease));
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  startGuardedWorkflow(rawRequest: unknown): ApiResultV1<WorkflowReceiptV1> {
    try {
      const request = this.validator.guardedWorkflowStartRequest(rawRequest);
      const plan = clone(request.plan);
      this.assertPlanIntegrity(plan);
      if (plan.executionMode !== "orchestrated" || plan.state !== "ready") {
        throw new WorkflowContractError("INVALID_TRANSITION", "Only a ready orchestrated workflow can use a convergence lease.");
      }
      const binding = this.store.getAttemptLease(request.leaseId);
      if (!binding || binding.lease.state !== "issued") {
        throw new WorkflowContractError("LEASE_CONFLICT", "The attempt lease is missing, expired, or already consumed.", { leaseId: request.leaseId });
      }
      if (Date.parse(binding.lease.expiresAt) <= Date.now()) {
        this.store.expireAttemptLease(binding.lease.leaseId);
        throw new WorkflowContractError("LEASE_CONFLICT", "The attempt lease expired before workflow start.", { leaseId: request.leaseId });
      }
      if (request.expectedRootRevision !== binding.root.revision || request.expectedRootRevision !== binding.lease.rootRevision) {
        throw new WorkflowContractError("STALE_REVISION", "The guarded start does not target the current convergence revision.", {
          expectedRevision: request.expectedRootRevision,
          actualRevision: binding.root.revision,
        });
      }
      if (plan.integrityToken !== binding.lease.planIntegrityToken || canonicalJson(plan) !== canonicalJson(binding.proposal.plan)) {
        throw new WorkflowContractError("LEASE_CONFLICT", "The attempt lease is bound to a different workflow plan.", { leaseId: request.leaseId });
      }

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
      };
      this.assertReceipt(receipt);
      const started = this.store.insertGuardedRun(receipt, request.leaseId, request.expectedRootRevision, new Date().toISOString());
      if (!started) {
        throw new WorkflowContractError("LEASE_CONFLICT", "The attempt lease could not be consumed atomically.", { leaseId: request.leaseId });
      }
      return apiOk(clone(receipt));
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  getConvergenceStatus(rootId: string): ApiResultV1<ConvergenceStatusV1> {
    try {
      let snapshot = this.requireConvergenceSnapshot(rootId);
      this.expireStaleLeases(snapshot);
      snapshot = this.requireConvergenceSnapshot(rootId);
      const status = this.buildConvergenceStatus(snapshot);
      this.validator.convergenceStatus(status);
      return apiOk(clone(status));
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  resolveConvergenceGate(rawRequest: unknown): ApiResultV1<ConvergenceStatusV1> {
    try {
      const request = this.validator.resolveConvergenceGateRequest(rawRequest);
      const review = clone(request.review);
      let snapshot = this.requireConvergenceSnapshot(request.rootId);
      const root = snapshot.root;
      if (request.expectedRevision !== root.revision || review.rootRevision !== root.revision) {
        throw new WorkflowContractError("STALE_REVISION", "The convergence review does not target the current root revision.", {
          expectedRevision: request.expectedRevision,
          reviewRevision: review.rootRevision,
          actualRevision: root.revision,
        });
      }
      if (review.rootId !== root.rootId || review.epoch !== root.currentEpoch) {
        throw new WorkflowContractError("INVALID_INPUT", "The convergence review targets a different root or epoch.");
      }
      if (root.state !== "needs-review") {
        throw new WorkflowContractError("INVALID_TRANSITION", "Only a gated convergence root can be resolved.", { state: root.state });
      }
      const actualActors = [...new Set(snapshot.leases.filter((lease) => lease.state === "consumed").map((lease) => lease.actorId))].sort();
      const reviewedActors = [...new Set(review.implementationActorIds)].sort();
      if (!review.freshContext.confirmed || !review.freshContext.evidenceRef || actualActors.join("\0") !== reviewedActors.join("\0")) {
        throw new WorkflowContractError("GATE_FAILED", "Independent frame review must be fresh and cover every implementation actor.", {
          actualActors,
          reviewedActors,
        });
      }
      if (actualActors.includes(review.reviewerActorId)) {
        throw new WorkflowContractError("GATE_FAILED", "The frame reviewer must be independent from implementation actors.");
      }
      this.assertReviewRoute(review);

      const updatedRoot = clone(root);
      updatedRoot.revision += 1;
      updatedRoot.updatedAt = review.reviewedAt;
      if (review.route === "stop") {
        updatedRoot.state = "abandoned";
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
            throw new WorkflowContractError("INVALID_INPUT", "A semantics-preserving review cannot change workspace or guard policy.");
          }
          updatedRoot.currentEpoch += 1;
          updatedRoot.state = "open";
          updatedRoot.frame = clone(proposedFrame);
          Object.assign(updatedRoot, nextDigests);
        }
      }

      this.validator.convergenceRoot(updatedRoot);
      if (!this.store.updateConvergenceRoot(updatedRoot, root.revision, review)) {
        throw new WorkflowContractError("STALE_REVISION", "The convergence root changed while recording the review.");
      }
      snapshot = this.requireConvergenceSnapshot(root.rootId);
      return apiOk(this.buildConvergenceStatus(snapshot));
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  rejectUnguardedWorkflow(rawPlan: unknown): ApiResultV1<WorkflowReceiptV1> {
    try {
      const plan = clone(this.validator.workflowPlan(rawPlan));
      this.assertPlanIntegrity(plan);
      if (plan.executionMode === "orchestrated") {
        throw new WorkflowContractError("LEASE_REQUIRED", "New orchestrated workflows must start through start_guarded_workflow.");
      }
      throw new WorkflowContractError("INVALID_TRANSITION", "Direct skill plans are not started by the MCP orchestrator.");
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  /** Embedding compatibility only. The MCP start_workflow tool rejects new unguarded orchestrated runs. */
  startWorkflow(rawPlan: unknown): ApiResultV1<WorkflowReceiptV1> {
    try {
      const plan = clone(this.validator.workflowPlan(rawPlan));
      this.assertPlanIntegrity(plan);
      if (plan.executionMode !== "orchestrated") {
        throw new WorkflowContractError("INVALID_TRANSITION", "Direct skill plans are not started by the MCP orchestrator.");
      }
      if (plan.state !== "ready") {
        const error = plan.errors.find((item) => item.code === "MCP_UNAVAILABLE");
        if (error) throw new WorkflowContractError(error.code, error.message, error.details);
        throw new WorkflowContractError("INVALID_TRANSITION", "Only a ready workflow plan can be started.", {
          planState: plan.state,
        });
      }

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
      };
      this.assertReceipt(receipt);
      this.store.insertRun(receipt);
      return apiOk(clone(receipt));
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  recordStageResult(rawResult: unknown): ApiResultV1<WorkflowReceiptV1> {
    try {
      const result = this.validator.stageResult(rawResult);
      return this.change(result.runId, result.expectedRevision, (receipt) => {
        if (receipt.state !== "running") {
          throw new WorkflowContractError("INVALID_TRANSITION", "Stage results require a running workflow.", {
            state: receipt.state,
          });
        }
        const target = receipt.plan.stages.find((stage) => stage.stageId === result.stageId);
        if (!target) {
          throw new WorkflowContractError("INVALID_INPUT", "Stage does not belong to this run.", { stageId: result.stageId });
        }
        if (target.state !== "ready") {
          throw new WorkflowContractError("INVALID_TRANSITION", "A stage result may only be recorded once.", {
            stageId: result.stageId,
            stageState: target.state,
          });
        }
        const priorStage = receipt.plan.stages.find(
          (stage) => stage.order < target.order && stage.state !== "passed",
        );
        if (priorStage) {
          throw new WorkflowContractError("INVALID_TRANSITION", "Stages must be recorded in plan order.", {
            requiredStageId: priorStage.stageId,
            requestedStageId: result.stageId,
          });
        }

        this.assertPlannedInputsAvailable(receipt, target);
        this.assertResultSemantics(target, result);
        this.assertDeclaredReceiptPolicy(receipt, target, result);
        if (result.state === "passed") {
          this.assertRequiredArtifacts(target, result);
          this.assertDeliberationGate(target, result);
          this.assertMandatoryAuditGate(target, result);
        }
        target.state = result.state;
        receipt.stageResults.push(clone(result));
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
    try {
      return apiOk(clone(this.requireRun(runId)));
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  finalizeWorkflow(runId: string, expectedRevision: number): ApiResultV1<WorkflowReceiptV1> {
    return this.change(runId, expectedRevision, (receipt) => {
      if (receipt.state !== "running") {
        throw new WorkflowContractError("INVALID_TRANSITION", "Only a running workflow can be finalized.", {
          state: receipt.state,
        });
      }
      if (receipt.blockers.length > 0 || receipt.unresolved.length > 0) {
        throw new WorkflowContractError("GATE_FAILED", "Workflow has unresolved blockers or findings.", {
          blockers: receipt.blockers,
          unresolved: receipt.unresolved,
        });
      }

      for (const stage of receipt.plan.stages) {
        const result = receipt.stageResults.find((item) => item.stageId === stage.stageId);
        if (!result || result.state !== "passed") {
          throw new WorkflowContractError("GATE_FAILED", "Every planned stage must pass before finalization.", {
            stageId: stage.stageId,
            stageState: result?.state ?? "ready",
          });
        }
        this.assertRequiredArtifacts(stage, result);
        this.assertDeclaredReceiptPolicy(receipt, stage, result);
      }

      const mandatoryAudit = receipt.plan.stages.find((stage) => stage.riskGate === "mandatory");
      if (mandatoryAudit && mandatoryAudit.state !== "passed") {
        throw new WorkflowContractError("GATE_FAILED", "Mandatory audit stage did not pass.", {
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
        throw new WorkflowContractError("INVALID_TRANSITION", "A terminal workflow cannot be aborted.", {
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
        errors.push({
          code: "GATE_FAILED",
          message: `No enabled registry descriptor provides '${capability}'.`,
          details: { capability },
        });
        continue;
      }
      if (skill.executionClass === "bootstrap") {
        errors.push({
          code: "GATE_FAILED",
          message: `Capability '${capability}' is a bootstrap provider and must run before plan_workflow.`,
          details: { capability, providerKey: skill.providerKey },
        });
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
      errors.push({
        code: "INVALID_TRANSITION",
        message: "Recovery providers must run in a separate workflow.",
        details: { executionClasses: [...executionClasses] },
      });
    }

    for (const { capability, satisfiedCapabilities, provider: skill } of this.orderProviders(selectedProviderList)) {
      // Descriptor requiredArtifacts are inputs/preconditions. Only declared
      // producedArtifacts become evidence obligations for a completed stage.
      const producedArtifacts = skill.producedArtifacts;
      const stageRequiredArtifacts = skill.gate.policy === "mandatory"
        ? [...new Set([...producedArtifacts, "gate-verdict"])]
        : producedArtifacts;
      const order = stages.length + 1;
      stages.push({
        stageId: stageId(order, capability),
        order,
        requiredCapability: capability,
        satisfiedCapabilities,
        skillId: skill.skillId,
        phase: skill.phase,
        selectionReason: `Selected '${skill.skillId}' because provider '${skill.providerKey}' supplies '${satisfiedCapabilities.join("', '")}' at priority ${skill.priority}.`,
        state: "ready",
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
      errors.unshift({
        code: "MCP_UNAVAILABLE",
        message: "The orchestrator is blocked because MCP is unavailable.",
        details: null,
      });
    }

    return {
      schemaVersion: CONTRACT_VERSION,
      taskId: task.taskId,
      taskDigest: convergenceDigest(task),
      integrityToken: "pending",
      executionMode,
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
    const work: string[] = [];
    let koreanProseExpanded = false;
    for (const capability of requestedWork) {
      if (KOREAN_PROSE_CAPABILITIES.includes(capability as (typeof KOREAN_PROSE_CAPABILITIES)[number])) {
        if (!koreanProseExpanded) work.push(...KOREAN_PROSE_CAPABILITIES);
        koreanProseExpanded = true;
      } else {
        work.push(capability);
      }
    }
    const after: string[] = [];
    if (auditRequested) {
      after.push(POLICY_CAPABILITY.audit);
    }
    return [...new Set([...work, ...after])];
  }

  private orderProviders(
    items: Array<{ capability: string; satisfiedCapabilities: string[]; provider: RoutedSkillProviderV2 }>,
  ): Array<{ capability: string; satisfiedCapabilities: string[]; provider: RoutedSkillProviderV2 }> {
    const producedBy = new Map<string, number>();
    for (const [index, item] of items.entries()) {
      for (const artifact of item.provider.producedArtifacts) {
        const existing = producedBy.get(artifact);
        if (existing !== undefined && items[existing]?.provider.providerKey !== item.provider.providerKey) {
          throw new WorkflowContractError("INVALID_INPUT", "Selected providers produce the same artifact.", {
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
      throw new WorkflowContractError("INVALID_INPUT", "Selected provider artifact dependencies contain a cycle.");
    }
    return ordered;
  }

  private assertResultSemantics(stage: PlannedStageV1, result: StageResultV1): void {
    const providerResult = this.validator.providerResult(
      this.registry.rootDirectory,
      stage.resultSchema,
      stage.outputSchema,
      result.output,
    );
    const rule = this.mappedState(stage, providerResult);
    if (result.state !== rule.state) {
      throw new WorkflowContractError("INVALID_TRANSITION", "Stage state does not match the provider state mapping.", {
        stageId: result.stageId,
        expectedState: rule.state,
        actualState: result.state,
      });
    }
    const providerError = providerResult.error;
    if (rule.errorRequired !== Boolean(providerError)) {
      throw new WorkflowContractError("INVALID_TRANSITION", "Provider error presence does not match the state mapping.", {
        stageId: result.stageId,
        errorRequired: rule.errorRequired,
      });
    }
    if (providerError && rule.allowedErrorCodes && !rule.allowedErrorCodes.includes(providerError.code)) {
      throw new WorkflowContractError("INVALID_TRANSITION", "Provider error code is not allowed by the state mapping.", {
        stageId: result.stageId,
        errorCode: providerError.code,
      });
    }
    if ((providerError?.code ?? null) !== (result.error?.code ?? null)) {
      throw new WorkflowContractError("INVALID_INPUT", "Stage error must mirror the provider result error.", {
        stageId: result.stageId,
      });
    }
    if (result.state === "passed") {
      if (result.evidence.length === 0 || result.evidence.some((evidence) => !evidence.verified || !evidence.locator)) {
        throw new WorkflowContractError("MISSING_EVIDENCE", "A passed stage requires verified evidence.", {
          stageId: result.stageId,
        });
      }
      if (result.error) {
        throw new WorkflowContractError("INVALID_INPUT", "A passed stage cannot contain an error.");
      }
    }
    if ((result.state === "failed" || result.state === "blocked") && !result.error) {
      throw new WorkflowContractError("INVALID_INPUT", "Failed or blocked stages require an error object.");
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
        throw new WorkflowContractError("INVALID_TRANSITION", "Adapter error is not allowed by the provider descriptor.", {
          stageId: stage.stageId,
          errorCode: errorCode ?? null,
        });
      }
      return { state: "blocked", errorRequired: true, allowedErrorCodes: stage.stateMapping.adapterErrors };
    }
    let rule: StateMappingRuleV2 | "reject" = stage.stateMapping.default;
    if (stage.stateMapping.selector) {
      const value = this.jsonPointer(providerResult, stage.stateMapping.selector);
      if (typeof value === "string") rule = stage.stateMapping.values?.[value] ?? "reject";
    }
    if (rule === "reject") {
      throw new WorkflowContractError("INVALID_TRANSITION", "Provider verdict is not mapped by the descriptor.", {
        stageId: stage.stageId,
        selector: stage.stateMapping.selector ?? null,
      });
    }
    return rule;
  }

  private jsonPointer(value: unknown, pointer: string): unknown {
    return pointer.split("/").slice(1).reduce<unknown>((current, token) => {
      if (!current || typeof current !== "object") return undefined;
      const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
      return (current as Record<string, unknown>)[key];
    }, value);
  }

  private assertRequiredArtifacts(stage: PlannedStageV1, result: StageResultV1): void {
    const verifiedArtifacts = new Set(
      result.output.artifacts.filter((artifact) => artifact.verified && artifact.locator && artifact.digest && artifact.targetDigest)
        .map((artifact) => artifact.artifactId),
    );
    const missing = stage.requiredArtifacts.filter((artifact) => !verifiedArtifacts.has(artifact));
    if (missing.length > 0) {
      throw new WorkflowContractError("MISSING_EVIDENCE", "Required stage artifacts lack verified evidence.", {
        stageId: stage.stageId,
        missingArtifacts: missing,
      });
    }
  }

  private assertPlannedInputsAvailable(receipt: WorkflowReceiptV1, stage: PlannedStageV1): void {
    const missing: Array<{ artifactId: string; producerStageId: string }> = [];
    for (const artifactId of stage.requiredInputArtifacts) {
      const producer = receipt.plan.stages.find(
        (candidate) => candidate.stageId !== stage.stageId && candidate.producedArtifacts.includes(artifactId),
      );
      if (!producer) continue;
      const producerResult = receipt.stageResults.find((candidate) => candidate.stageId === producer.stageId);
      const verified = producerResult?.state === "passed" && producerResult.output.artifacts.some(
        (artifact) => artifact.artifactId === artifactId
          && artifact.verified
          && Boolean(artifact.locator)
          && Boolean(artifact.digest)
          && Boolean(artifact.targetDigest),
      );
      if (!verified) missing.push({ artifactId, producerStageId: producer.stageId });
    }
    if (missing.length > 0) {
      throw new WorkflowContractError("MISSING_EVIDENCE", "Planned input artifacts are not backed by verified producer results.", {
        stageId: stage.stageId,
        missingInputs: missing,
      });
    }
  }

  private assertDeliberationGate(stage: PlannedStageV1, result: StageResultV1): void {
    if (!stage.requiredArtifacts.includes("decision-record")) return;
    if (!stage.gate.validatorSchema) {
      throw new WorkflowContractError("GATE_FAILED", "Deliberation provider must declare its decision record validator schema.", {
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
      throw new WorkflowContractError("GATE_FAILED", "Deliberation requires a schema-valid DecisionRecord.v1.", {
        stageId: stage.stageId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const semanticErrors = validateDecisionRecordSemantics(record);
    if (semanticErrors.length > 0) {
      throw new WorkflowContractError("GATE_FAILED", "DecisionRecord.v1 failed canonical semantic validation.", {
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
      throw new WorkflowContractError("GATE_FAILED", "Deliberation result is not eligible to advance the workflow.", {
        stageId: stage.stageId,
        assurance: run.assurance,
        capabilityShortfall: run.capability_shortfall,
        consensusStatus: proposal?.status ?? null,
      });
    }
    if ((run.stage === "HIGH" || run.stage === "CRITICAL") && run.strict !== true) {
      throw new WorkflowContractError("GATE_FAILED", "HIGH and CRITICAL deliberation requires strict execution assurance.", {
        stageId: stage.stageId,
        stage: run.stage,
      });
    }
    if (proposal.status === "conditional_consensus" && result.output.output?.conditionsVerified !== true) {
      throw new WorkflowContractError("GATE_FAILED", "Conditional consensus may advance only after its conditions are verified.", {
        stageId: stage.stageId,
      });
    }
  }

  private assertMandatoryAuditGate(stage: PlannedStageV1, result: StageResultV1): void {
    if (stage.riskGate !== "mandatory") return;
    const output = result.output.output;
    const auditorId = output?.auditorId;
    const implementationActorIds = output?.implementationActorIds;
    const auditTarget = output?.auditTarget;
    const currentTarget = output?.currentTarget;
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
      || typeof currentTarget !== "string"
      || currentTarget !== auditTarget
      || output?.freshContext !== true
      || output?.delegationAllowed !== false
      || !Array.isArray(blockingFindings)
      || blockingFindings.length > 0
      || output?.stale !== false
      || !["pre-execution", "post-execution", "pre-deploy", "post-deploy"].includes(String(phase))
      || typeof output?.postExecutionVerified !== "boolean"
    ) {
      throw new WorkflowContractError("GATE_FAILED", "Mandatory audit requires a current, fresh, non-delegated PASS with no blocking findings.", {
        stageId: stage.stageId,
      });
    }
    if ((phase === "post-execution" || phase === "post-deploy") && output.postExecutionVerified !== true) {
      throw new WorkflowContractError("GATE_FAILED", "Post-execution and post-deploy audits require verified resulting state.", {
        stageId: stage.stageId,
        phase,
      });
    }
    if (implementationActorIds.includes(auditorId)) {
      throw new WorkflowContractError("GATE_FAILED", "Mandatory audit auditor must be independent from implementation actors.", {
        stageId: stage.stageId,
        auditorId,
        implementationActorIds,
      });
    }
  }

  private validateWorkUnitGraph(task: TaskEnvelopeV1): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    for (const unit of task.workUnits) {
      if (graph.has(unit.id)) {
        throw new WorkflowContractError("INVALID_INPUT", "Work unit IDs must be unique.", { workUnitId: unit.id });
      }
      graph.set(unit.id, unit.dependencies);
    }
    for (const unit of task.workUnits) {
      for (const dependencyId of unit.dependencies) {
        if (!graph.has(dependencyId)) {
          throw new WorkflowContractError("INVALID_INPUT", "Work unit dependency does not exist.", {
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
        throw new WorkflowContractError("INVALID_INPUT", "Work unit dependencies must not contain a cycle.", {
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
    return graph;
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
      .update(canonicalJson(this.planWithoutIntegrityToken(plan)), "utf8")
      .digest("base64url");
  }

  private assertPlanIntegrity(plan: WorkflowPlanV1): void {
    const expected = Buffer.from(this.signPlan(plan), "base64url");
    const supplied = Buffer.from(plan.integrityToken, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new WorkflowContractError("INVALID_INPUT", "Workflow plan integrity token is missing, modified, or signed by a different workflow store.");
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
      throw new WorkflowContractError("INVALID_INPUT", "Convergence artifact IDs must be unique across control and target frames.");
    }
    if (frame.operationalSettings.maxAttemptsPerEpoch !== 3 || frame.operationalSettings.maxEpochs !== 2) {
      throw new WorkflowContractError("INVALID_INPUT", "The convergence guard policy is fixed at three attempts and two epochs.");
    }
  }

  private artifactRolesChanged(baseline: ConvergenceFrameV1, proposed: ConvergenceFrameV1): boolean {
    const baselineRoles = new Map([...baseline.controlArtifacts, ...baseline.targetArtifacts].map((artifact) => [artifact.artifactId, artifact.role]));
    return [...proposed.controlArtifacts, ...proposed.targetArtifacts]
      .some((artifact) => baselineRoles.has(artifact.artifactId) && baselineRoles.get(artifact.artifactId) !== artifact.role);
  }

  private requireConvergenceSnapshot(rootId: string): ConvergenceSnapshot {
    const snapshot = this.store.getConvergenceSnapshot(rootId);
    if (!snapshot) throw new WorkflowContractError("RUN_NOT_FOUND", "Convergence root was not found.", { rootId });
    this.validator.convergenceRoot(snapshot.root);
    return snapshot;
  }

  private expireStaleLeases(snapshot: ConvergenceSnapshot): void {
    const now = Date.now();
    for (const lease of snapshot.leases) {
      if (lease.state === "issued" && Date.parse(lease.expiresAt) <= now) this.store.expireAttemptLease(lease.leaseId);
    }
  }

  private moveRootToReview(root: ConvergenceRootV1, reason: string): void {
    const updated = clone(root);
    updated.revision += 1;
    updated.state = "needs-review";
    updated.updatedAt = new Date().toISOString();
    if (!this.store.updateConvergenceRoot(updated, root.revision)) {
      throw new WorkflowContractError("STALE_REVISION", "The convergence root changed while applying its gate.", {
        rootId: root.rootId,
      });
    }
    void reason;
  }

  private throwRootGate(root: ConvergenceRootV1, snapshot: ConvergenceSnapshot): never {
    const attempts = snapshot.leases.filter((lease) => lease.epoch === root.currentEpoch && lease.state === "consumed").length;
    if (root.state === "needs-review" && attempts >= root.frame.operationalSettings.maxAttemptsPerEpoch) {
      throw new WorkflowContractError("ATTEMPT_BUDGET_EXHAUSTED", "Independent review is required before another full attempt.", {
        rootId: root.rootId,
        epoch: root.currentEpoch,
      });
    }
    throw new WorkflowContractError("FRAME_REVIEW_REQUIRED", "The convergence root is gated and cannot issue another lease.", {
      rootId: root.rootId,
      state: root.state,
    });
  }

  private buildConvergenceStatus(snapshot: ConvergenceSnapshot): ConvergenceStatusV1 {
    const attemptsUsed = snapshot.leases.filter(
      (lease) => lease.epoch === snapshot.root.currentEpoch && lease.state === "consumed",
    ).length;
    let gateError: ContractErrorBody | null = null;
    if (snapshot.root.state === "needs-review") {
      gateError = attemptsUsed >= snapshot.root.frame.operationalSettings.maxAttemptsPerEpoch
        ? {
            code: "ATTEMPT_BUDGET_EXHAUSTED",
            message: "Independent review is required before another full attempt.",
            details: { rootId: snapshot.root.rootId, epoch: snapshot.root.currentEpoch },
          }
        : {
            code: "FRAME_REVIEW_REQUIRED",
            message: "A task or control-frame change requires independent review.",
            details: { rootId: snapshot.root.rootId, epoch: snapshot.root.currentEpoch },
          };
    } else if (snapshot.root.state === "needs-user") {
      gateError = {
        code: "FRAME_REVIEW_REQUIRED",
        message: "The proposed change requires a new user contract.",
        details: { rootId: snapshot.root.rootId, epoch: snapshot.root.currentEpoch },
      };
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
    };
  }

  private assertReviewRoute(review: ConvergenceReviewV1): void {
    if (review.evidenceRefs.length === 0) {
      throw new WorkflowContractError("MISSING_EVIDENCE", "A convergence review requires evidence.");
    }
    if (review.classification === "semantics-preserving") {
      if (review.route === "resume-new-epoch") {
        if (!review.comparability.comparable || !review.proposedFrame) {
          throw new WorkflowContractError("GATE_FAILED", "Resuming a new epoch requires a comparable, semantics-preserving frame.");
        }
      } else if (!["diagnose", "stop"].includes(review.route)) {
        throw new WorkflowContractError("GATE_FAILED", "A semantics-preserving review has an incompatible route.", { route: review.route });
      }
    } else if (review.classification === "semantics-changing") {
      if (review.route !== "needs-user" || review.proposedFrame === null) {
        throw new WorkflowContractError("GATE_FAILED", "Semantics-changing reviews must return the proposed frame to the user.");
      }
    } else if (!["panel", "needs-user", "stop"].includes(review.route)) {
      throw new WorkflowContractError("GATE_FAILED", "Ambiguous frame reviews must route to a panel, the user, or stop.");
    }
  }

  private convergenceOutcome(
    receipt: WorkflowReceiptV1,
    binding: NonNullable<ReturnType<WorkflowStore["getGuardedRunBinding"]>>,
  ): { root: ConvergenceRootV1; expectedRootRevision: number; outcome: AttemptOutcomeV1 } {
    const recordedAt = new Date().toISOString();
    const expectedRootRevision = binding.root.revision;
    const root = clone(binding.root);
    root.revision += 1;
    root.updatedAt = recordedAt;
    const aborted = receipt.blockers.includes("aborted-by-caller");
    const passed = receipt.state === "passed";
    const state: AttemptOutcomeV1["state"] = passed ? "passed" : aborted ? "aborted" : "failed";
    const attemptsUsed = this.requireConvergenceSnapshot(root.rootId).leases.filter(
      (lease) => lease.epoch === root.currentEpoch && lease.state === "consumed",
    ).length;
    if (!["needs-review", "needs-user", "abandoned"].includes(root.state)) {
      if (passed) root.state = "completed";
      else if (attemptsUsed >= root.frame.operationalSettings.maxAttemptsPerEpoch) root.state = "needs-review";
      else root.state = "open";
    }
    const failureFingerprint = passed ? null : convergenceDigest({
      state: receipt.state,
      stage: receipt.stageResults.at(-1)?.stageId ?? null,
      error: receipt.error?.code ?? null,
      blockers: receipt.blockers,
      unresolved: receipt.unresolved,
    });
    const evidenceRefs = [...new Set(receipt.stageResults.flatMap((result) => [
      ...result.evidence.map((evidence) => evidence.locator),
      ...result.output.artifacts.map((artifact) => artifact.digest),
    ]))];
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
      failureFingerprint,
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
    try {
      const receipt = this.requireRun(runId);
      if (!Number.isInteger(expectedRevision) || expectedRevision !== receipt.revision) {
        throw new WorkflowContractError("STALE_REVISION", "expectedRevision does not match the current run revision.", {
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
        throw new WorkflowContractError("STALE_REVISION", "expectedRevision does not match the current run revision.", {
          expectedRevision,
          actualRevision: current?.revision ?? null,
        });
      }
      return apiOk(clone(receipt));
    } catch (error) {
      return apiError(this.toErrorBody(error));
    }
  }

  private requireRun(runId: string): WorkflowReceiptV1 {
    const receipt = this.store.getRun(runId);
    if (!receipt) {
      throw new WorkflowContractError("RUN_NOT_FOUND", "Run was not found in workflow storage.", { runId });
    }
    this.assertReceipt(receipt);
    return receipt;
  }

  private assertReceipt(receipt: WorkflowReceiptV1): void {
    this.validator.workflowPlan(receipt.plan);
    this.validator.workflowReceipt(receipt);
  }

  private toErrorBody(error: unknown): ContractErrorBody {
    if (error instanceof WorkflowContractError) return error.toBody();
    return {
      code: "INVALID_INPUT",
      message: "Workflow request could not be processed.",
      details: { cause: error instanceof Error ? error.message : String(error) },
    };
  }
}
