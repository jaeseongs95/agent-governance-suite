import { createHash } from "node:crypto";

import {
  CONTRACT_VERSION,
  MODEL_CLASS,
  type ExecutionContextV1,
  type ModelClassV1,
  REASONING_EFFORT,
  type ReasoningEffortV1,
  WorkflowContractError,
} from "../../contracts/types.js";
import type { VerifiedCaller } from "./caller-identity.js";
import type { ExecutionObservationBindingV1, TrustedExecutionContextProvider } from "./workflow-service.js";
import { msg, type MessageRef } from "./i18n.js";

/**
 * Execution observation for the workflow tools with execution floors. The host-observed caller of the
 * current tool call supplies model, effort and call ID; this module only qualifies them against the
 * trusted installation adapter. Nothing here is read from tool arguments.
 */
export const HOST_ATTESTATION_TOOLS: ReadonlySet<string> = new Set(["plan_workflow", "start_workflow", "record_stage_result", "classify_skills", "record_skill_selection"]);

export interface ResolvedModelCapabilityV1 {
  readonly provider: string;
  readonly host: string;
  readonly rawModel: string;
  readonly resolvedModel: string;
  readonly modelClass: ModelClassV1;
  readonly minimumReasoningEffort: ReasoningEffortV1 | null;
  readonly supportedEfforts: readonly ReasoningEffortV1[];
  readonly aliasUsed: boolean;
  readonly policyRevision: string;
  readonly provenance: string;
}

export type UndeterminedModelReasonV1 =
  | "MODEL_NOT_IN_CATALOG"
  | "AMBIGUOUS_PROVIDER_MATCH"
  | "MISSING_PROVIDER_IDENTITY"
  | "MISSING_MODEL_CAPABILITY"
  | "INVALID_MODEL_IDENTIFIER";

/** Explicit undetermined result when trusted model capability cannot be established. */
export interface UndeterminedModelCapabilityV1 {
  readonly status: "undetermined";
  readonly reason: UndeterminedModelReasonV1;
  readonly host: string;
  readonly rawModel: string;
  readonly provider: null;
  readonly modelClass: null;
  readonly policyRevision: string | null;
  readonly provenance: string;
}

export type ModelCapabilityJudgmentV1 =
  | ({ readonly status: "resolved" } & ResolvedModelCapabilityV1)
  | UndeterminedModelCapabilityV1;

/** Adapter policy owns model mapping, never signing, binding, freshness or replay checks. */
export interface HostExecutionAdapterBase {
  host: string;
  providers?: readonly string[];
  policyRevision?: string;
  modelClassForModel(model: string): ModelClassV1 | null;
  judgeModel?(model: string, provenance?: string): ModelCapabilityJudgmentV1;
}

export type HostExecutionAdapter =
  | (HostExecutionAdapterBase & {
      provider: string;
      resolveModel?(model: string, provenance?: string): ResolvedModelCapabilityV1 | null;
    })
  | (HostExecutionAdapterBase & {
      provider?: string;
      resolveModel(model: string, provenance?: string): ResolvedModelCapabilityV1 | null;
    });


function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export const hostIdentityDigest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);

/** Raw host session IDs do not enter persisted workflow actors or signed payloads. */
export function hostActorId(host: string, sessionId: string, agentId: string | null = null): string {
  return `${host}:session-${hostIdentityDigest(sessionId)}${agentId ? `:agent-${hostIdentityDigest(agentId)}` : ""}`;
}

/** Orders reasoning efforts; used to report the lower of two observations. */
export function lowerReasoningEffort(left: ReasoningEffortV1, right: ReasoningEffortV1): ReasoningEffortV1 {
  return REASONING_EFFORT.indexOf(left) <= REASONING_EFFORT.indexOf(right) ? left : right;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffortV1 {
  return typeof value === "string" && (REASONING_EFFORT as readonly string[]).includes(value);
}

/**
 * Uses the trusted adapter capability contract without inferring capability from an identifier
 * or a legacy class mapping. Observation signing remains independent of qualification.
 */
export function judgeAdapterModelCapability(
  adapter: HostExecutionAdapter,
  model: string,
  provenance: string = `${adapter.host}:runtime`,
): ModelCapabilityJudgmentV1 {
  if (typeof model !== "string" || model.length === 0) {
    return {
      status: "undetermined",
      reason: "INVALID_MODEL_IDENTIFIER",
      host: adapter.host,
      rawModel: typeof model === "string" ? model : "",
      provider: null,
      modelClass: null,
      policyRevision: adapter.policyRevision ?? null,
      provenance,
    };
  }
  if (typeof adapter.judgeModel === "function") {
    const judged = adapter.judgeModel(model, provenance);
    if (judged.status === "undetermined") return judged;
    const provider = nonEmpty(judged.provider);
    if (!provider || !MODEL_CLASS.includes(judged.modelClass)) {
      return {
        status: "undetermined",
        reason: !provider ? "MISSING_PROVIDER_IDENTITY" : "MODEL_NOT_IN_CATALOG",
        host: adapter.host,
        rawModel: model,
        provider: null,
        modelClass: null,
        policyRevision: judged.policyRevision ?? adapter.policyRevision ?? null,
        provenance,
      };
    }
    return { ...judged, provider };
  }
  if (typeof adapter.resolveModel === "function") {
    const resolved = adapter.resolveModel(model, provenance);
    if (!resolved || !MODEL_CLASS.includes(resolved.modelClass)) {
      return {
        status: "undetermined",
        reason: "MODEL_NOT_IN_CATALOG",
        host: adapter.host,
        rawModel: model,
        provider: null,
        modelClass: null,
        policyRevision: adapter.policyRevision ?? null,
        provenance,
      };
    }
    const provider = nonEmpty(resolved.provider);
    if (!provider) {
      return {
        status: "undetermined",
        reason: "MISSING_PROVIDER_IDENTITY",
        host: adapter.host,
        rawModel: model,
        provider: null,
        modelClass: null,
        policyRevision: resolved.policyRevision ?? adapter.policyRevision ?? null,
        provenance,
      };
    }
    return { status: "resolved", ...resolved, provider };
  }
  const provider = nonEmpty(adapter.provider);
  if (!provider) {
    return {
      status: "undetermined",
      reason: "MISSING_PROVIDER_IDENTITY",
      host: adapter.host,
      rawModel: model,
      provider: null,
      modelClass: null,
      policyRevision: adapter.policyRevision ?? null,
      provenance,
    };
  }
  // 등급 매핑만으로 전체 지원 능력과 정책 버전을 합성하지 않는다.
  return {
    status: "undetermined",
    reason: "MISSING_MODEL_CAPABILITY",
    host: adapter.host,
    rawModel: model,
    provider: null,
    modelClass: null,
    policyRevision: adapter.policyRevision ?? null,
    provenance,
  };
}

/** Resolves a vendor model identifier into a vendor-neutral capability contract at the adapter boundary. */
export function resolveAdapterModelCapability(
  adapter: HostExecutionAdapter,
  model: string,
  provenance: string = `${adapter.host}:runtime`,
): ResolvedModelCapabilityV1 | null {
  if (typeof model !== "string" || model.length === 0) return null;
  if (typeof adapter.resolveModel === "function") {
    const resolved = adapter.resolveModel(model, provenance);
    if (!resolved || !nonEmpty(resolved.provider) || !MODEL_CLASS.includes(resolved.modelClass)) return null;
    return resolved;
  }
  const judgment = judgeAdapterModelCapability(adapter, model, provenance);
  if (judgment.status !== "resolved") return null;
  return {
    provider: judgment.provider,
    host: judgment.host,
    rawModel: judgment.rawModel,
    resolvedModel: judgment.resolvedModel,
    modelClass: judgment.modelClass,
    minimumReasoningEffort: judgment.minimumReasoningEffort,
    supportedEfforts: judgment.supportedEfforts,
    aliasUsed: judgment.aliasUsed,
    policyRevision: judgment.policyRevision,
    provenance: judgment.provenance,
  };
}

/** Checks whether the observed reasoning effort satisfies the model's supported set and minimum floor. */
export function satisfiesModelEffortPolicy(
  capability: ResolvedModelCapabilityV1,
  effort: ReasoningEffortV1,
): boolean {
  if (!capability.supportedEfforts.includes(effort)) return false;
  if (
    capability.minimumReasoningEffort
    && REASONING_EFFORT.indexOf(effort) < REASONING_EFFORT.indexOf(capability.minimumReasoningEffort)
  ) {
    return false;
  }
  return true;
}

function invalid(message: MessageRef, details?: Record<string, unknown>): WorkflowContractError {
  return new WorkflowContractError("BINDING_INVALID", message, details);
}

/** Why the current policy rejects an observed model and effort; never inferred from the caller. */
function qualificationRejectionReason(capability: ResolvedModelCapabilityV1, effort: ReasoningEffortV1): string {
  if (!capability.supportedEfforts.includes(effort)) return "CURRENT_POLICY_EFFORT_UNSUPPORTED";
  return "CURRENT_POLICY_EFFORT_BELOW_MINIMUM";
}

/**
 * Supplies the execution observation of the tool call currently being handled.
 * The server wraps each call in run(); observe() outside run() sees nothing.
 */
export class HostAttestationProvider implements TrustedExecutionContextProvider {
  private current: { tool: string; caller: VerifiedCaller } | null = null;
  private lastVerifiedCapability: ResolvedModelCapabilityV1 | null = null;

  constructor(private readonly adapter: HostExecutionAdapter, private readonly now: () => Date = () => new Date()) {}

  /** Returns the vendor-neutral capability metadata and policy revision verified on the latest observe() call. */
  lastObservedCapability(): ResolvedModelCapabilityV1 | null {
    return this.lastVerifiedCapability;
  }

  diagnose(): Record<string, unknown> {
    const execution = this.current?.caller.execution;
    return {
      host: this.adapter.host,
      ...(this.adapter.provider ? { provider: this.adapter.provider } : {}),
      ...(this.adapter.policyRevision ? { policyRevision: this.adapter.policyRevision } : {}),
      status: "missing-call-observation",
      ...(execution && "unavailable" in execution ? { reasonCode: execution.unavailable }
        : this.current && !this.current.caller.callId ? { reasonCode: "HOST_CALL_ID_UNAVAILABLE" } : {}),
      required: ["host-owned model", "reasoningEffort", "session", "current tool call"],
      connection: "The host did not report the model, reasoning effort or call ID for this call. Caller arguments cannot supply them.",
    };
  }

  run<T>(tool: string, caller: VerifiedCaller, call: () => T): T {
    const previous = this.current;
    this.current = { tool, caller };
    try {
      return call();
    } finally {
      this.current = previous;
    }
  }

  observe(binding: ExecutionObservationBindingV1): ExecutionContextV1 | null {
    this.lastVerifiedCapability = null;
    const current = this.current;
    if (!current || !HOST_ATTESTATION_TOOLS.has(current.tool)) return null;
    const { caller } = current;
    const execution = caller.execution;
    if ("unavailable" in execution || !caller.callId) return null;
    if (caller.host !== this.adapter.host) {
      throw invalid(msg("services.hostAttestation.adapterMismatch", {}), { reasonCode: "HOST_ADAPTER_MISMATCH" });
    }
    // The catalog only describes models it knows. A model or effort it does not know still runs: the main session's
    // model is the user's choice and a new release must not stop AGS. Findings are kept as notes for audit.
    const notes: string[] = [];
    const effort = isReasoningEffort(execution.effort) ? execution.effort : null;
    if (effort === null) notes.push(execution.effort === null ? "HOST_EFFORT_UNREPORTED" : "REASONING_EFFORT_UNRECOGNIZED");
    const capability = resolveAdapterModelCapability(this.adapter, execution.model, execution.provenance);
    if (!capability) {
      const judgment = judgeAdapterModelCapability(this.adapter, execution.model, execution.provenance);
      notes.push(judgment.status === "undetermined" ? judgment.reason : "MODEL_CAPABILITY_UNRESOLVED");
    } else {
      // A resolved descriptor that contradicts this host, model or policy revision is a broken installation, not a new model.
      const mismatch = capability.host !== this.adapter.host || capability.rawModel !== execution.model || !nonEmpty(capability.resolvedModel)
        ? "QUALIFICATION_CAPABILITY_MISMATCH"
        : !nonEmpty(capability.policyRevision)
          || (this.adapter.policyRevision !== undefined && this.adapter.policyRevision !== capability.policyRevision)
          ? "QUALIFICATION_POLICY_REVISION_MISMATCH" : null;
      if (mismatch) throw invalid(msg("services.hostAttestation.capabilityMismatch", {}), { reasonCode: mismatch });
      if (effort !== null && !satisfiesModelEffortPolicy(capability, effort)) notes.push(qualificationRejectionReason(capability, effort));
    }
    this.lastVerifiedCapability = capability;
    const now = this.now();
    return {
      schemaVersion: CONTRACT_VERSION,
      model: execution.model,
      modelClass: capability?.modelClass ?? null,
      reasoningEffort: effort,
      ...(notes.length ? { policyNotes: notes } : {}),
      source: "runtime",
      observedAt: now.toISOString(),
      // One host call yields one consumable observation, however often the call is retried.
      observationId: createHash("sha256").update(JSON.stringify([caller.host, caller.sessionId, caller.actor.id, caller.callId]), "utf8").digest("base64url"),
      taskId: binding.taskId,
      runId: binding.runId,
      stageId: binding.stageId,
      revision: binding.revision,
      actorId: caller.actor.id,
    };
  }
}
