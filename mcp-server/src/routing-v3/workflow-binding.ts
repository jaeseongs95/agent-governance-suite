/** Read-only binding of a stored semantic selection to the owning workflow. */
import { type ModelSelectionRequestV2, type ModelRoutingDecisionV3, type StageResultV1,
  WorkflowContractError } from "../../../contracts/types.js";
import { canonical, digest, verifySeal } from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import type { ModelRoutingStore } from "../../../skills/coordinate-subagents/scripts/model-routing-store.mjs";
import { convergenceDigest } from "../convergence-logic.js";
import { ContractValidator } from "../schema-validator.js";
import type { WorkflowStore } from "../workflow-store.js";
import { readDecision } from "./decision-codec.js";

export const MODEL_DECISION_V3_SCHEMA = "https://skill-suite.local/contracts/model-routing-decision.v3.schema.json";
export const MODEL_DECISION_V3_PREFIX = "ags-model-decision:";

function requireBinding(condition: unknown, message: string): asserts condition {
  if (!condition) throw new WorkflowContractError("BINDING_INVALID", message);
}

export function isSemanticDecisionReference(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as { schemaId?: unknown; locator?: unknown };
  return ref.schemaId === MODEL_DECISION_V3_SCHEMA
    || typeof ref.locator === "string" && ref.locator.startsWith(MODEL_DECISION_V3_PREFIX);
}

/** A v3 decision is diagnostic; this check grants no workflow lease, approval or execution authority. */
export function validateSemanticDecisionArtifact(
  workflow: WorkflowStore,
  routing: ModelRoutingStore,
  artifact: StageResultV1["output"]["artifacts"][number],
  result: StageResultV1,
): void {
  requireBinding(artifact.schemaId === MODEL_DECISION_V3_SCHEMA
    && /^ags-model-decision:[a-f0-9]{64}$/u.test(artifact.locator),
  "Semantic artifact requires the v3 schema and exact stored-decision URI.");
  const decisionDigest = `sha256:${artifact.locator.slice(MODEL_DECISION_V3_PREFIX.length)}`;
  requireBinding((artifact.digest.startsWith("sha256:") ? artifact.digest : `sha256:${artifact.digest}`) === decisionDigest,
    "Semantic artifact URI and digest disagree.");
  const decision = validateStoredSemanticWorkflowBinding(workflow, routing, decisionDigest);
  requireBinding(decision.binding.runId === result.runId && decision.binding.stageId === result.stageId
    && decision.binding.revision === result.expectedRevision && artifact.targetDigest === decision.binding.candidateDigest,
  "Semantic artifact belongs to a different run, stage, revision or candidate.");
}

/** Current workflow admission for a stored v3 selection; returns the decision, never a permit. */
export function validateStoredSemanticWorkflowBinding(
  workflow: WorkflowStore,
  routing: ModelRoutingStore,
  decisionDigest: string,
): ModelRoutingDecisionV3 {
  const entry = readDecision(routing, decisionDigest, new ContractValidator());
  requireBinding(entry?.decision.schemaVersion === "3.0.0", "Semantic artifact has no stored v3 decision.");
  const { decision } = entry;
  verifySeal(decision, "decisionDigest");
  requireBinding(decision.decisionDigest === decisionDigest, "Semantic decision row key does not match its payload.");
  const request = new ContractValidator().modelSelectionRequestV2(entry.request);
  const reference = routing.database.prepare(`SELECT baseline_decision_digest,advice_digest
    FROM ags_model_decision_refs_v3 WHERE decision_digest=?`).get(decisionDigest) as
    { baseline_decision_digest: string; advice_digest: string } | undefined;
  requireBinding(reference?.baseline_decision_digest === decision.semantic.baselineDecisionDigest
    && reference.advice_digest === decision.semantic.adviceDigest,
  "Semantic artifact has no matching registered decision reference.");
  requireBinding(digest(request) === decision.requestDigest
    && canonical(request.binding) === canonical(decision.binding)
    && decision.status === "selected" && decision.target
    && decision.executionAuthorized === false && decision.trustedGateSatisfied === false,
  "Semantic decision and request binding disagree.");
  validateCurrentBinding(workflow, request, decision);
  return decision;
}

function validateCurrentBinding(
  workflow: WorkflowStore,
  request: ModelSelectionRequestV2,
  decision: ModelRoutingDecisionV3,
): void {
  const binding = decision.binding;
  const snapshot = workflow.getGuardedRunSnapshot(binding.runId);
  requireBinding(snapshot, "Semantic artifact has no guarded workflow snapshot.");
  const { receipt, guarded } = snapshot;
  requireBinding(receipt.runId === binding.runId && receipt.plan.taskId === binding.taskId
    && receipt.state === "running" && receipt.revision === binding.revision,
  "Semantic artifact has no current workflow run.");
  const stage = receipt.plan.stages.find(item => item.stageId === binding.stageId);
  requireBinding(stage?.state === "ready" && receipt.plan.currentStageId === binding.stageId,
    "Semantic artifact is not for the current ready stage.");
  requireBinding(guarded.root.state === "open" && guarded.outcome === null
    && guarded.lease.state === "consumed" && guarded.lease.leaseId === binding.attemptId,
  "Semantic artifact requires the current consumed workflow lease.");
  requireBinding(guarded.root.taskEnvelope.taskId === binding.taskId
    && guarded.root.taskDigest === convergenceDigest(guarded.root.taskEnvelope)
    && guarded.root.frameDigest === convergenceDigest(guarded.root.frame)
    && guarded.root.targetDigest === convergenceDigest(guarded.root.frame.targetArtifacts)
    && guarded.proposal.rootId === guarded.root.rootId
    && guarded.lease.rootId === guarded.root.rootId
    && guarded.lease.taskDigest === guarded.root.taskDigest
    && guarded.lease.frameDigest === guarded.root.frameDigest
    && guarded.lease.targetDigest === guarded.root.targetDigest
    && convergenceDigest(guarded.proposal.taskEnvelope) === guarded.root.taskDigest
    && convergenceDigest(guarded.proposal.frame) === guarded.root.frameDigest
    && receipt.plan.taskDigest === guarded.root.taskDigest
    && receipt.plan.integrityToken === guarded.lease.planIntegrityToken
    && (binding.candidateDigest === guarded.lease.targetDigest
      || guarded.root.frame.targetArtifacts.some(item => item.digest === binding.candidateDigest)),
  "Semantic artifact candidate is outside the frozen attempt frame.");
  const task = guarded.proposal.taskEnvelope;
  requireBinding(!["high", "critical"].includes(task.riskLevel) || request.highRisk,
    "A semantic decision cannot downgrade the task risk.");
  const required = new Set([...request.requirements.tools,
    ...(request.requirements.filesystem === "none" ? [] : ["read"]),
    ...(request.requirements.filesystem === "write" ? ["write"] : [])]);
  requireBinding([...required].every(action => task.authorization.allowedActions.includes(action)
    && !task.authorization.prohibitedActions.includes(action)),
  "Semantic decision exceeds local task authorization.");
  requireBinding(task.authorization.approvalRequired.length === 0,
    "Semantic decision cannot satisfy task-specific approvals without a native approval adapter.");
}
