import type { ModelSelectionRequestV2, StageResultV1 } from "../../contracts/types.js";
import { WorkflowContractError } from "../../contracts/types.js";
import { checkApplicationArtifactBinding } from "../../skills/coordinate-subagents/scripts/model-routing-service-core.mjs";
import type { ModelRoutingStore } from "../../skills/coordinate-subagents/scripts/model-routing-store.mjs";
import { canonicalJson, convergenceDigest } from "./convergence-logic.js";
import { ContractValidator } from "./schema-validator.js";
import type { WorkflowStore } from "./workflow-store.js";

export const MODEL_APPLICATION_SCHEMA = "https://skill-suite.local/contracts/model-application-record.v2.schema.json";
const PREFIX = "ags-model-record:";
const MAX_HISTORY = 10000;
type Binding = ModelSelectionRequestV2["binding"];

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new WorkflowContractError("BINDING_INVALID", message);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function routingReference(value: unknown): boolean {
  const item = asRecord(value);
  return item.schemaId === MODEL_APPLICATION_SCHEMA || (typeof item.locator === "string" && item.locator.startsWith(PREFIX));
}

/** Inspect only the existing artifact/evidence slots, never a worker's free-form output. */
export function hasModelRoutingArtifacts(value: unknown): boolean {
  const result = asRecord(value);
  const artifacts = asRecord(result.output).artifacts;
  return (Array.isArray(artifacts) && artifacts.some(routingReference))
    || (Array.isArray(result.evidence) && result.evidence.some(routingReference));
}

/** Read-only bridge. It issues no lease, observation, approval or execution assurance. */
export class ModelRoutingWorkflowBridge {
  constructor(
    private readonly workflow: WorkflowStore,
    private readonly routing: ModelRoutingStore,
    private readonly validator = new ContractValidator(),
  ) {}

  private current(binding: Binding) {
    const receipt = this.workflow.getRun(binding.runId);
    requireCondition(receipt && receipt.plan.taskId === binding.taskId, "Routing task/run binding does not match the workflow.");
    requireCondition(receipt.state === "running" && receipt.revision === binding.revision, "Routing binding has a stale workflow revision or an inactive run.");
    const stage = receipt.plan.stages.find(item => item.stageId === binding.stageId);
    requireCondition(stage && stage.state === "ready" && receipt.plan.currentStageId === stage.stageId, "Routing binding is not the current ready stage.");
    const guarded = this.workflow.getGuardedRunBinding(binding.runId);
    requireCondition(guarded && guarded.lease.state === "consumed" && guarded.lease.leaseId === binding.attemptId, "Routing binding requires the run's consumed workflow lease as attemptId.");
    requireCondition(guarded.root.state === "open", "Routing lineage is not open.");
    requireCondition(binding.candidateDigest === guarded.lease.targetDigest
      || guarded.proposal.frame.targetArtifacts.some(item => item.digest === binding.candidateDigest), "Routing candidate is not in the frozen attempt frame.");
    return { receipt, guarded };
  }

  /** Read-only handoff admission, not a lease issuer or an execution approval. */
  validatePeerHandoff(rawRequest: unknown, receiverActor: string | null = null): void {
    const request = this.validator.modelSelectionRequestV2(rawRequest);
    const { guarded } = this.current(request.binding);
    requireCondition(guarded.outcome === null, "The workflow attempt already has an outcome.");
    const authorization = guarded.proposal.taskEnvelope.authorization;
    requireCondition(guarded.proposal.taskEnvelope.riskLevel !== "high" || request.highRisk,
      "A peer handoff cannot downgrade the task risk.");
    const required = new Set([...request.requirements.tools,
      ...(request.requirements.filesystem === "none" ? [] : ["read"]),
      ...(request.requirements.filesystem === "write" ? ["write"] : [])]);
    requireCondition([...required].every(action => authorization.allowedActions.includes(action)
      && !authorization.prohibitedActions.includes(action)), "Peer tools or filesystem exceed the local task authorization.");
    if (receiverActor !== null) {
      // This increment admits only an already-authorized local lease owner. It does not import
      // a foreign task/lease or infer a new delegation grant from a message or model selection.
      requireCondition(guarded.lease.actorId === receiverActor, "The receiver is not the existing local lease owner.");
      requireCondition(!request.requirements.excludedActors.includes(receiverActor), "The peer actor is excluded.");
      if (request.role === "independent-audit") {
        requireCondition(!this.history(request.binding).actors.includes(receiverActor), "The peer auditor participated in the workflow.");
      }
    }
  }

  /** Include all known participants conservatively, including failed/ambiguous dispatches and ancestors. */
  history = (rawBinding: unknown, excludeDecisionDigest: string | null = null): { actors: string[]; sessions: string[] } => {
    // Reuse the versioned binding schema rather than accepting caller-authored history.
    const bindingSchema = this.validator.modelSelectionRequestV2({
      schemaVersion: "2.0.0", binding: rawBinding, role: "independent-audit", highRisk: true,
      requirements: { inputModalities: [], tools: [], filesystem: "none", allowedSurfaces: [], allowedRuntimeModes: [],
        allowNestedDelegation: false, requireObservable: [], excludedActors: [], excludedSessions: [], contextMode: "limited" },
    });
    const { guarded } = this.current(bindingSchema.binding);
    const actors = new Set<string>();
    const sessions = new Set<string>();
    const roots = new Set<string>();
    const runs = new Set<string>();
    let rootId: string | null = guarded.root.rootId;
    while (rootId !== null) {
      requireCondition(!roots.has(rootId) && roots.size < 128, "Routing audit lineage is cyclic or exceeds the history bound.");
      roots.add(rootId);
      const snapshot = this.workflow.getConvergenceSnapshot(rootId);
      requireCondition(snapshot, "Routing audit lineage is incomplete.");
      for (const proposal of snapshot.proposals) actors.add(proposal.actorId);
      for (const lease of snapshot.leases) actors.add(lease.actorId);
      for (const runId of snapshot.workflowRunIds) {
        requireCondition(!runs.has(runId) && runs.size < MAX_HISTORY, "Routing audit run history is inconsistent or too large.");
        runs.add(runId);
        const receipt = this.workflow.getRun(runId);
        requireCondition(receipt, "Routing audit workflow receipt is missing.");
        const bootstrap = receipt.plan.bootstrapExecution?.context?.actorId;
        if (bootstrap) actors.add(bootstrap);
        for (const result of receipt.stageResults) {
          if (result.executionContext?.actorId) actors.add(result.executionContext.actorId);
        }
        const rows = this.routing.database.prepare(
          "SELECT payload FROM ags_model_dispatches_v2 WHERE json_extract(payload, '$.binding.runId') = ? LIMIT ?",
        ).all(runId, MAX_HISTORY + 1) as Array<{ payload: string }>;
        requireCondition(rows.length <= MAX_HISTORY, "Routing audit dispatch history is too large.");
        for (const row of rows) {
          const decision = this.validator.modelRoutingDecisionV2(JSON.parse(row.payload));
          const { decisionDigest, ...unsigned } = decision;
          requireCondition(convergenceDigest(unsigned) === decisionDigest && decision.binding.runId === runId && decision.target,
            "Routing audit dispatch history is corrupt.");
          if (decision.decisionDigest === excludeDecisionDigest) continue;
          actors.add(decision.target.actorId);
          sessions.add(`${decision.target.host}/${decision.target.sessionId}`);
        }
      }
      rootId = snapshot.root.parentRootId;
    }
    requireCondition(runs.has(bindingSchema.binding.runId), "Routing audit lineage omits the requested run.");
    // Only explicit snapshots map an opaque actor ID to a session. Never parse vendor names from the actor.
    for (const raw of this.routing.capabilities()) {
      const capability = this.validator.hostModelCapabilitiesV1(raw);
      if (actors.has(capability.actorId)) sessions.add(`${capability.host}/${capability.sessionId}`);
    }
    requireCondition(actors.size <= MAX_HISTORY && sessions.size <= MAX_HISTORY, "Routing audit participant history is too large.");
    return { actors: [...actors].sort(), sessions: [...sessions].sort() };
  };

  /** Validate optional diagnostic references before the existing stage/attestation gates run. */
  validateStageArtifacts(result: StageResultV1): void {
    const artifacts = result.output.artifacts.filter(routingReference);
    const ids = new Set<string>();
    for (const artifact of artifacts) {
      requireCondition(!ids.has(artifact.artifactId), "Duplicate routing artifact ID.");
      ids.add(artifact.artifactId);
      requireCondition(artifact.schemaId === MODEL_APPLICATION_SCHEMA && /^ags-model-record:[a-f0-9]{64}$/u.test(artifact.locator),
        "Routing artifact requires the versioned schema and exact stored-record URI.");
      const recordDigest = `sha256:${artifact.locator.slice(PREFIX.length)}`;
      requireCondition((artifact.digest.startsWith("sha256:") ? artifact.digest : `sha256:${artifact.digest}`) === recordDigest,
        "Routing artifact URI and digest disagree.");
      const record = this.validator.modelApplicationRecordV2(this.routing.application(recordDigest));
      const row = this.routing.database.prepare("SELECT request_json,payload FROM ags_model_decisions_v2 WHERE decision_digest=?")
        .get(record.decisionDigest) as { request_json: string; payload: string } | undefined;
      requireCondition(row, "Routing application has no stored decision.");
      const decision = this.validator.modelRoutingDecisionV2(JSON.parse(row.payload));
      const request = this.validator.modelSelectionRequestV2(JSON.parse(row.request_json));
      const { decisionDigest, ...unsigned } = decision;
      requireCondition(convergenceDigest(unsigned) === decisionDigest && convergenceDigest(request) === decision.requestDigest
        && record.requestDigest === decision.requestDigest && canonicalJson(request.binding) === canonicalJson(decision.binding)
        && record.catalogDigest === decision.catalogDigest && record.policyDigest === decision.policyDigest
        && record.capabilitySnapshotDigest === decision.capabilitySnapshotDigest && canonicalJson(record.selected) === canonicalJson(decision.selected),
      "Routing application decision/request binding is corrupt.");
      requireCondition(record.recordDigest === recordDigest && record.binding.runId === result.runId
        && record.binding.stageId === result.stageId && record.binding.revision === result.expectedRevision,
      "Routing application belongs to a different run, stage or revision.");
      this.current(record.binding);
      requireCondition(artifact.targetDigest === record.binding.candidateDigest, "Routing artifact candidate digest does not match its application.");
      const requiredFields = result.state === "passed"
        ? [...new Set([...request.requirements.requireObservable, ...(request.highRisk ? ["model", "reasoning", "runtimeMode"] : [])])]
        : [];
      checkApplicationArtifactBinding(record, { binding: decision.binding, target: decision.target, requiredFields, store: this.routing });
      if (result.state === "passed" && request.highRisk) {
        requireCondition(record.observationAdmitted && record.originVerified && record.terminalOutcome === "succeeded",
          "Passing high-risk routing evidence requires an admitted successful host outcome.");
      }
      // Recheck participation at adoption: an initially independent actor may have implemented in the meantime.
      if (result.state === "passed" && request.role === "independent-audit") {
        const history = this.history(record.binding, record.decisionDigest);
        requireCondition(!history.actors.includes(record.target.actorId)
          && !history.sessions.includes(`${record.target.host}/${record.target.sessionId}`)
          && !request.requirements.excludedActors.includes(record.target.actorId)
          && !request.requirements.excludedSessions.includes(`${record.target.host}/${record.target.sessionId}`),
        "Routing audit actor participated before final adoption.");
      }
    }
    for (const evidence of result.evidence.filter(routingReference)) {
      requireCondition(artifacts.some(artifact => artifact.artifactId === evidence.artifactId && artifact.locator === evidence.locator),
        "Routing evidence has no matching validated artifact.");
    }
  }
}
