/** Internal replay publication. Artifact references are evidence, never a new runtime decision. */
import type { ArtifactRefV1, SemanticDecisionRequestV1 } from "../../../contracts/types.js";
import { WorkflowContractError } from "../../../contracts/types.js";
import { canonical, digest } from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import { assertPreparedSemanticInputV1 } from "../../../skills/coordinate-subagents/scripts/semantic/prepared-input-check.mjs";
import { ArtifactReferenceAccess, type ArtifactAccessGrant, type ArtifactAccessPrincipal } from "../artifacts/reference-access.js";
import { ArtifactRetentionStore } from "../artifacts/retention.js";
import { SnapshotSetStore, type SnapshotInputs } from "../artifacts/snapshot-set.js";
import { ContractValidator } from "../schema-validator.js";
import { SemanticAdviceAdmissionStore } from "./advice-admission.js";
import { validateSemanticAdviceForRequest } from "./advice-validator.js";
import { SemanticEvaluationIntentStore } from "./evaluation-intent.js";

const roles = ["request", "policy", "catalog", "capability", "advice"] as const;
type JsonRecord = Record<string, unknown>;

export interface SemanticReplayPublication {
  manifestRef: ArtifactRefV1;
  registrationId: string;
  adviceDigest: string;
  reducerVersion: string;
  projection: Pick<SemanticDecisionRequestV1, "stateDigest" | "questionDigest" |
    "capabilitySetDigest" | "eligibleSetDigest" | "optionMappingDigest">;
}

/** Supplied only by the owning server's committed consumption/adoption journal. */
export interface SemanticConsumptionRecord {
  evaluationId: string;
  registrationId: string;
  adviceDigest: string;
  adoption: { status: "eligible"; evidenceDigest: string };
  decisionTime: string;
}
export interface SemanticConsumptionReader {
  read(evaluationId: string): SemanticConsumptionRecord | null;
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new WorkflowContractError("GATE_FAILED", message);
}
function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord : null;
}

/** The owning server supplies every reference, access grant and store; no MCP publication endpoint exists. */
export class SemanticReplaySnapshotPublisher {
  private readonly access: ArtifactReferenceAccess;
  private readonly snapshots: SnapshotSetStore;
  private readonly validator = new ContractValidator();
  private readonly taskId: string;

  constructor(
    private readonly root: string,
    private readonly principal: ArtifactAccessPrincipal,
    private readonly grants: readonly ArtifactAccessGrant[],
    private readonly retention: ArtifactRetentionStore,
    private readonly admission: SemanticAdviceAdmissionStore,
    private readonly intents: SemanticEvaluationIntentStore,
    private readonly consumption: SemanticConsumptionReader,
  ) {
    if (!principal.taskId) throw new WorkflowContractError("INVALID_INPUT", "Replay requires a task-scoped principal.");
    this.taskId = principal.taskId;
    this.access = new ArtifactReferenceAccess(root, principal, grants);
    this.snapshots = new SnapshotSetStore(root, principal, grants);
  }

  async publish(input: {
    evaluationId: string;
    materials: SnapshotInputs;
  }): Promise<SemanticReplayPublication> {
    requireValue(record(input.materials) && Object.keys(input.materials).length === roles.length
      && roles.every(role => Object.hasOwn(input.materials, role)),
    "Replay requires exactly five material references.");
    const registration = this.admission.get(input.evaluationId);
    const intent = this.intents.get(input.evaluationId);
    const consumed = this.consumption.read(input.evaluationId);
    requireValue(registration && intent?.state === "recorded"
      && consumed?.evaluationId === input.evaluationId
      && consumed.registrationId === registration.registrationId
      && consumed.adviceDigest === registration.advice.adviceDigest,
    "Replay requires the exact registered advice consumed by this evaluation.");
    const prepared = intent.evaluation.request;
    requireValue(prepared.requestDigest === registration.requestDigest
      && prepared.evaluationId === registration.evaluationId
      && prepared.binding.taskId === this.taskId,
    "Replay request and registration diverged.");

    // Read every named immutable object before any pin or manifest publication.
    const bytes = await Promise.all(roles.map(role => this.access.read(input.materials[role])));
    const values = bytes.map((content) => {
      try { return JSON.parse(content.toString("utf8")) as unknown; }
      catch { throw new WorkflowContractError("INTEGRITY_FAILED", "Replay material is not JSON."); }
    });
    const archived = record(values[0]);
    requireValue(archived && Object.keys(archived).length === 5
      && ["routingRequest", "prepared", "adoption", "decisionTime", "reducerVersion"]
        .every(key => Object.hasOwn(archived, key)), "Replay request archive is incomplete.");
    requireValue(canonical(archived.prepared) === canonical(prepared)
      && archived.reducerVersion === prepared.reducerVersion,
    "Replay archive does not match the journal request or reducer.");
    const routingRequest = this.validator.modelSelectionRequestV2(archived.routingRequest);
    requireValue(digest(routingRequest) === prepared.effectiveRoutingRequestDigest,
      "Replay routing request differs from the journal binding.");
    const policy = this.validator.modelRoutingPolicyV1(values[1]);
    const catalog = this.validator.modelCatalogV1(values[2]);
    requireValue(Array.isArray(values[3]) && values[3].length > 0,
      "Replay capability material is missing.");
    const capabilities = values[3].map(value => this.validator.hostModelCapabilitiesV1(value));
    const decisionTime = archived.decisionTime;
    requireValue(typeof decisionTime === "string", "Replay decision time is missing.");
    const environment = { policy, catalog, capabilities, now: decisionTime };
    assertPreparedSemanticInputV1(prepared, routingRequest, environment, decisionTime);
    const advice = validateSemanticAdviceForRequest({
      prepared, advice: values[4], now: decisionTime,
    });
    requireValue(canonical(advice) === canonical(registration.advice),
      "Replay advice differs from the consumed registration.");
    const adoption = record(archived.adoption);
    requireValue(adoption?.status === "eligible" && typeof adoption.evidenceDigest === "string"
      && /^sha256:[a-f0-9]{64}$/u.test(adoption.evidenceDigest)
      && canonical(adoption) === canonical(consumed.adoption)
      && decisionTime === consumed.decisionTime,
    "Replay adoption material is incomplete.");

    const owner = `semantic-replay:${registration.registrationId}`;
    for (const role of roles) this.retention.pin(input.materials[role], owner, role);
    const manifestRef = await this.snapshots.publish(input.materials);
    this.retention.pin(manifestRef, owner, "manifest");
    const readback = new SnapshotSetStore(this.root, this.principal, [
      ...this.grants, { ref: manifestRef, workspaceId: this.principal.workspaceId,
        taskId: this.taskId },
    ]);
    const manifest = await readback.load(manifestRef);
    requireValue(canonical(manifest.inputs) === canonical(input.materials),
      "Published replay manifest differs from its members.");
    for (const role of [...roles, "manifest"] as const) this.retention.referencePublished(owner, role);
    return { manifestRef, registrationId: registration.registrationId,
      adviceDigest: advice.adviceDigest, reducerVersion: prepared.reducerVersion,
      projection: { stateDigest: prepared.stateDigest, questionDigest: prepared.questionDigest,
        capabilitySetDigest: prepared.capabilitySetDigest, eligibleSetDigest: prepared.eligibleSetDigest,
        optionMappingDigest: prepared.optionMappingDigest } };
  }
}
