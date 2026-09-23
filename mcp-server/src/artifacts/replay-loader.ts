import type { ArtifactRefV1 } from "../../../contracts/types.js";
import { WorkflowContractError } from "../../../contracts/types.js";
import type { replaySemanticDecisionV1 } from "../../../skills/coordinate-subagents/scripts/semantic/replay.mjs";
import { SEMANTIC_REDUCER_VERSION_V1 } from "../../../skills/coordinate-subagents/scripts/semantic/replay.mjs";
import { instant, RoutingError } from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import { ContractValidator } from "../schema-validator.js";
import { ArtifactReferenceAccess, type ArtifactAccessGrant, type ArtifactAccessPrincipal } from "./reference-access.js";
import { SnapshotSetStore } from "./snapshot-set.js";

type ReplayInput = Parameters<typeof replaySemanticDecisionV1>[0];
export type ReplayLoadResult =
  | { status: "ready"; input: ReplayInput }
  | { status: "missing" | "denied" | "corrupt" | "unsupported-version" };

/** Loads only the immutable, authorized members named by an A04 manifest. */
export class ReplayMaterialLoader {
  private readonly snapshots: SnapshotSetStore;
  private readonly access: ArtifactReferenceAccess;
  private readonly validator = new ContractValidator();

  constructor(approvedRoot: string, principal: ArtifactAccessPrincipal, grants: readonly ArtifactAccessGrant[]) {
    this.snapshots = new SnapshotSetStore(approvedRoot, principal, grants);
    this.access = new ArtifactReferenceAccess(approvedRoot, principal, grants);
  }

  async load(manifestRef: ArtifactRefV1): Promise<ReplayLoadResult> {
    try {
      const manifest = await this.snapshots.load(manifestRef);
      const readJson = async (ref: ArtifactRefV1): Promise<unknown> => {
        if (ref.mediaType !== "application/json") throw new WorkflowContractError("INTEGRITY_FAILED", "Replay member must be JSON.");
        try { return JSON.parse((await this.access.read(ref)).toString("utf8")) as unknown; }
        catch (error) {
          if (error instanceof SyntaxError) throw new WorkflowContractError("INTEGRITY_FAILED", "Replay member is not JSON.");
          throw error;
        }
      };
      const { request, policy, catalog, capability, advice } = manifest.inputs;
      const archived = record(await readJson(request));
      if (!archived) {
        throw new WorkflowContractError("INTEGRITY_FAILED", "Replay request archive is incomplete.");
      }
      if (!("reducerVersion" in archived)) return { status: "unsupported-version" };
      if (!hasKeys(archived, ["routingRequest", "prepared", "adoption", "decisionTime", "reducerVersion"])) {
        throw new WorkflowContractError("INTEGRITY_FAILED", "Replay request archive is incomplete.");
      }
      if (archived.reducerVersion !== SEMANTIC_REDUCER_VERSION_V1) return { status: "unsupported-version" };
      const prepared = record(archived.prepared);
      const savedAdvice = record(await readJson(advice));
      if (!prepared || !savedAdvice) throw new WorkflowContractError("INTEGRITY_FAILED", "Replay semantic input is invalid.");
      if (prepared.reducerVersion !== SEMANTIC_REDUCER_VERSION_V1
        || savedAdvice.reducerVersion !== SEMANTIC_REDUCER_VERSION_V1) return { status: "unsupported-version" };
      const savedCapabilities = await readJson(capability);
      if (!Array.isArray(savedCapabilities) || savedCapabilities.length === 0) {
        throw new WorkflowContractError("INTEGRITY_FAILED", "Replay capability archive is invalid.");
      }
      const adoption = record(archived.adoption);
      if (!adoption || !hasKeys(adoption, ["status", "evidenceDigest"])
        || adoption.status !== "eligible" || typeof adoption.evidenceDigest !== "string"
        || !/^sha256:[0-9a-f]{64}$/u.test(adoption.evidenceDigest)
        || typeof archived.decisionTime !== "string") {
        throw new WorkflowContractError("INTEGRITY_FAILED", "Replay admission or time is invalid.");
      }
      instant(archived.decisionTime, "decisionTime");
      const input: ReplayInput = {
        routingRequest: this.validator.modelSelectionRequestV2(archived.routingRequest),
        environment: {
          catalog: this.validator.modelCatalogV1(await readJson(catalog)),
          policy: this.validator.modelRoutingPolicyV1(await readJson(policy)),
          capabilities: savedCapabilities.map((value) => this.validator.hostModelCapabilitiesV1(value)),
          now: archived.decisionTime,
        },
        prepared: this.validator.semanticDecisionRequestV1(archived.prepared),
        advice: this.validator.semanticDecisionAdviceV1(savedAdvice),
        adoption: { status: "eligible", evidenceDigest: adoption.evidenceDigest },
        decisionTime: archived.decisionTime,
        reducerVersion: SEMANTIC_REDUCER_VERSION_V1,
      };
      return { status: "ready", input };
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { status: "missing" };
      if (isErrno(error, "EACCES") || isErrno(error, "EPERM")
        || (error instanceof WorkflowContractError && error.code === "GATE_FAILED")) return { status: "denied" };
      if (error instanceof WorkflowContractError
        && (error.code === "INTEGRITY_FAILED" || error.code === "INVALID_INPUT")) return { status: "corrupt" };
      if (error instanceof RoutingError && error.code === "INVALID_INPUT") return { status: "corrupt" };
      throw error;
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function hasKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isErrno(value: unknown, code: string): boolean {
  return value !== null && typeof value === "object" && "code" in value && value.code === code;
}
