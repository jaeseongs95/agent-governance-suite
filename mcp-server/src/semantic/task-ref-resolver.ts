import type { ModelSelectionRequestV2 } from "../../../contracts/model-routing-types.js";
import { type SemanticDecisionStateV1, type SemanticModelAssignmentRequestV1, type TaskEnvelopeV1, WorkflowContractError } from "../../../contracts/types.js";
import { canonicalJson, convergenceDigest } from "../convergence-logic.js";
import { ContractValidator } from "../schema-validator.js";
import type { WorkflowStore } from "../workflow-store.js";

/** Verified by the owning server from its caller/session context, never copied from MCP input. */
export interface TaskReferencePrincipal {
  actorId: string;
  taskId: string;
  runId: string;
  rootId: string;
  workspaceId: string;
  rootRevision: number;
  routingBinding: ModelSelectionRequestV2["binding"];
}

export interface ResolvedTaskReference {
  task: TaskEnvelopeV1;
  frame: { rootId: string; digest: string; workspaceId: string } | null;
  artifacts: Array<{ artifactId: string; role: string; digest: string }>;
  sources: SemanticDecisionStateV1["sources"];
  provenance: { runId: string; runRevision: number; rootId: string; rootRevision: number; actorId: string };
}

/** Read-only resolution. The caller supplies IDs only; the server injects the store and verified principal. */
export function resolveTaskReference(
  value: unknown,
  store: Pick<WorkflowStore, "getGuardedRunSnapshot">,
  principal: Readonly<TaskReferencePrincipal>,
): ResolvedTaskReference {
  const request: SemanticModelAssignmentRequestV1 = new ContractValidator().semanticModelAssignmentRequestV1(value);
  const binding = request.routingRequest.binding;
  requireAccess(canonicalJson(binding) === canonicalJson(principal.routingBinding)
    && binding.taskId === principal.taskId && binding.runId === principal.runId,
  "Routing binding is outside the caller's verified scope.");

  const snapshot = store.getGuardedRunSnapshot(principal.runId);
  requireAccess(snapshot, "No authorized local workflow binding exists.");
  const { receipt, guarded } = snapshot;
  const { root, proposal, lease, outcome } = guarded;
  requireAccess(root.rootId === principal.rootId && root.revision === principal.rootRevision
    && root.frame.workspace.workspaceId === principal.workspaceId
    && root.taskEnvelope.taskId === principal.taskId
    && proposal.rootId === root.rootId && lease.rootId === root.rootId
    && proposal.actorId === principal.actorId && lease.actorId === principal.actorId
    && lease.leaseId === binding.attemptId && lease.state === "consumed" && outcome === null,
  "Task reference is outside the active caller/workflow scope.");
  requireAccess(receipt.runId === binding.runId && receipt.revision === binding.revision
    && receipt.state === "running" && receipt.plan.currentStageId === binding.stageId
    && receipt.plan.stages.some(stage => stage.stageId === binding.stageId)
    && receipt.plan.taskId === principal.taskId && receipt.plan.taskDigest === root.taskDigest
    && receipt.plan.integrityToken === lease.planIntegrityToken,
  "Workflow revision or stage is no longer current.");
  requireAccess(root.state === "open" && root.taskDigest === convergenceDigest(root.taskEnvelope)
    && root.frameDigest === convergenceDigest(root.frame)
    && lease.taskDigest === root.taskDigest && lease.frameDigest === root.frameDigest
    && convergenceDigest(proposal.taskEnvelope) === root.taskDigest
    && convergenceDigest(proposal.frame) === root.frameDigest,
  "Stored task or frame provenance is stale.");

  const frame = request.taskRef.frameId === undefined ? null : (() => {
    requireAccess(request.taskRef.frameId === root.rootId, "Frame reference is not in the current workflow.");
    return { rootId: root.rootId, digest: root.frameDigest, workspaceId: root.frame.workspace.workspaceId };
  })();
  const available = [...root.frame.controlArtifacts, ...root.frame.targetArtifacts];
  const artifacts = (request.taskRef.artifactIds ?? []).map(artifactId => {
    const artifact = available.find(item => item.artifactId === artifactId);
    requireAccess(artifact, "Artifact reference is not in the current workflow frame.");
    return { artifactId: artifact.artifactId, role: artifact.role, digest: artifact.digest };
  });
  return {
    task: structuredClone(root.taskEnvelope), frame, artifacts,
    sources: [
      { kind: "task", id: root.taskEnvelope.taskId, digest: root.taskDigest },
      ...(frame ? [{ kind: "frame" as const, id: root.rootId, digest: root.frameDigest }] : []),
      ...artifacts.map(artifact => ({ kind: "artifact" as const, id: artifact.artifactId, digest: artifact.digest })),
    ],
    provenance: { runId: receipt.runId, runRevision: receipt.revision, rootId: root.rootId,
      rootRevision: root.revision, actorId: principal.actorId },
  };
}

function requireAccess(condition: unknown, message: string): asserts condition {
  if (!condition) throw new WorkflowContractError("GATE_FAILED", message);
}
