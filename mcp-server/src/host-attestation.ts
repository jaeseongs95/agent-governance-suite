import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  CONTRACT_VERSION,
  MODEL_CLASS,
  type ExecutionContextV1,
  type ModelClassV1,
  REASONING_EFFORT,
  type ReasoningEffortV1,
  WorkflowContractError,
} from "../../contracts/types.js";
import { convergenceDigest } from "./convergence-logic.js";
import type { ExecutionObservationBindingV1, TrustedExecutionContextProvider } from "./workflow-service.js";
import type { WorkflowStore } from "./workflow-store.js";

/**
 * Shared host attestation. A host-owned hook or execution wrapper observes
 * an exact call; all adapters use the same signing and verification path.
 *
 * The token proves harness observation, not OS-level isolation: the signing
 * key lives in the plugin's workflow database, readable by the same user.
 */
export const HOST_ATTESTATION_FIELD = "_hostAttestation";
export const HOST_ATTESTATION_TOOLS: ReadonlySet<string> = new Set(["plan_workflow", "record_stage_result", "classify_skills", "record_skill_selection"]);

const HOST_ATTESTATION_KEY = "host_attestation_key_v1";
const OBSERVATION_TOKEN_PREFIX = "aghs2";
// The server accepts observations up to five minutes old; the token may wait on a permission prompt.
const TOKEN_TTL_MS = 5 * 60 * 1000;

/** Vendor-neutral resolved model and capability descriptor produced at the adapter boundary. */
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
  | "INVALID_MODEL_IDENTIFIER";

/** Explicit undetermined result when a model ID is absent from or ambiguous across vendor catalogs. */
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

export interface HostAttestationBindingV1 {
  phase: "bootstrap" | "stage";
  taskId: string | null;
  runId: string | null;
  stageId: string | null;
  revision: number | null;
}

/** Observation signing is independent of the nullable qualification snapshot. */
interface HostAttestationPayloadV2 extends HostAttestationBindingV1 {
  v: 2;
  host: string;
  session: string;
  agent: string | null;
  turn: string | null;
  call: string;
  tool: string;
  inputDigest: string;
  model: string;
  reasoningEffort: ReasoningEffortV1;
  provenance?: string;
  actorId: string;
  observationId: string;
  observedAt: string;
  expiresAt: string;
  // Required in the signed payload; null records missing policy observation and cannot qualify execution.
  policyRevision: string | null;
  eligibility: {
    provider: string;
    resolvedModel: string;
    modelClass: ModelClassV1;
    policyRevision: string;
  } | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

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
 * Judges a model identifier against the host adapter's vendor catalogs and returns an explicit
 * resolved capability or an explicit undetermined judgment without inferring vendor from host name.
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
  const modelClass = adapter.modelClassForModel(model);
  if (!modelClass || !MODEL_CLASS.includes(modelClass)) {
    return {
      status: "undetermined",
      reason: "MODEL_NOT_IN_CATALOG",
      host: adapter.host,
      rawModel: model,
      provider: null,
      modelClass: null,
      policyRevision: adapter.policyRevision ?? "1.0.0",
      provenance,
    };
  }
  return {
    status: "resolved",
    provider,
    host: adapter.host,
    rawModel: model,
    resolvedModel: model,
    modelClass,
    minimumReasoningEffort: null,
    supportedEfforts: REASONING_EFFORT,
    aliasUsed: false,
    policyRevision: adapter.policyRevision ?? "1.0.0",
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

export function withoutHostAttestation(input: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...input };
  delete copy[HOST_ATTESTATION_FIELD];
  return copy;
}

/** Derives the binding the server will check from the tool arguments the caller sent. */
export function hostAttestationBinding(tool: string, input: Record<string, unknown>): HostAttestationBindingV1 | null {
  if (tool === "classify_skills") {
    const taskId = nonEmpty(input.requestId);
    return taskId ? { phase: "bootstrap", taskId, runId: null, stageId: null, revision: null } : null;
  }
  if (tool === "record_skill_selection") {
    const taskId = nonEmpty(record(input.decision)?.requestDigest);
    return taskId ? { phase: "bootstrap", taskId, runId: null, stageId: null, revision: null } : null;
  }
  if (tool === "plan_workflow") {
    const taskId = nonEmpty(record(input.taskEnvelope)?.taskId) ?? nonEmpty(input.taskId);
    return taskId ? { phase: "bootstrap", taskId, runId: null, stageId: null, revision: null } : null;
  }
  if (tool === "record_stage_result") {
    const runId = nonEmpty(input.runId);
    const stageId = nonEmpty(input.stageId);
    const revision = input.expectedRevision;
    if (!runId || !stageId || !Number.isSafeInteger(revision)) return null;
    return { phase: "stage", taskId: null, runId, stageId, revision: revision as number };
  }
  return null;
}

function signingKey(store: WorkflowStore): Buffer {
  const key = Buffer.from(
    store.getOrCreateSecret(HOST_ATTESTATION_KEY, () => randomBytes(32).toString("base64url")),
    "base64url",
  );
  if (key.length !== 32) throw new WorkflowContractError("INVALID_INPUT", "Stored host attestation key is invalid.");
  return key;
}

function mac(key: Buffer, body: string): string {
  return createHmac("sha256", key).update(body, "utf8").digest("base64url");
}

export interface HostObservation {
  tool: string;
  input: Record<string, unknown>;
  model: string;
  reasoningEffort: string;
  actorId: string;
  sessionId: string;
  agentId?: string | null;
  turnId: string | null;
  toolUseId: string;
  provenance?: string;
  now?: Date;
}

/** Signs the observed call independently of model eligibility; the server owns qualification. */
export function issueHostAttestation(store: WorkflowStore, adapter: HostExecutionAdapter, observation: HostObservation): string | null {
  if (!HOST_ATTESTATION_TOOLS.has(observation.tool)) return null;
  const input = withoutHostAttestation(observation.input);
  const binding = hostAttestationBinding(observation.tool, input);
  const provenance = nonEmpty(observation.provenance) ?? `${adapter.host}:runtime`;
  if (!binding || !adapter.host || !nonEmpty(observation.model)
    || !isReasoningEffort(observation.reasoningEffort)
    || !observation.actorId || !observation.sessionId || !observation.toolUseId
    || observation.actorId !== hostActorId(adapter.host, observation.sessionId, observation.agentId ?? null)) return null;
  // Qualification can be absent without discarding the observation. The nullable snapshot
  // retains the old issuer floor and signed class/provider/model/revision protections.
  const capability = resolveAdapterModelCapability(adapter, observation.model, provenance);
  const policyRevision = nonEmpty(adapter.policyRevision)
    ?? nonEmpty(capability?.policyRevision)
    ?? (typeof adapter.judgeModel === "function"
      ? nonEmpty(adapter.judgeModel(observation.model, provenance).policyRevision)
      : null);
  const eligibility = capability && MODEL_CLASS.includes(capability.modelClass)
    && satisfiesModelEffortPolicy(capability, observation.reasoningEffort) ? {
      provider: capability.provider,
      resolvedModel: capability.resolvedModel,
      modelClass: capability.modelClass,
      policyRevision: capability.policyRevision,
    } : null;
  const now = observation.now ?? new Date();
  const scope = {
    host: adapter.host,
    session: hostIdentityDigest(observation.sessionId),
    agent: observation.agentId ? hostIdentityDigest(observation.agentId) : null,
    turn: observation.turnId ? hostIdentityDigest(observation.turnId) : null,
    call: hostIdentityDigest(observation.toolUseId),
  };
  const payload: HostAttestationPayloadV2 = {
    v: 2,
    ...scope,
    tool: observation.tool,
    inputDigest: convergenceDigest(input),
    ...binding,
    model: observation.model,
    reasoningEffort: observation.reasoningEffort,
    policyRevision,
    eligibility,
    provenance,
    actorId: observation.actorId,
    // Retrying the same host call cannot mint a second consumable observation.
    observationId: createHash("sha256").update(JSON.stringify(scope), "utf8").digest("base64url"),
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
  };
  const body = `${OBSERVATION_TOKEN_PREFIX}.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  return `${body}.${mac(signingKey(store), body)}`;
}

/** A host-owned wrapper observes once and dispatches the same signed arguments to its MCP transport. */
export function withHostObservation<T>(
  store: WorkflowStore,
  adapter: HostExecutionAdapter,
  tool: string,
  args: Record<string, unknown>,
  observe: () => Omit<HostObservation, "tool" | "input"> | null,
  dispatch: (input: Record<string, unknown>) => T,
): T {
  const input = withoutHostAttestation(args);
  const observation = observe();
  const token = observation ? issueHostAttestation(store, adapter, { ...observation, tool, input }) : null;
  return dispatch({ ...input, ...(token ? { [HOST_ATTESTATION_FIELD]: token } : {}) });
}

function invalid(message: string, details?: Record<string, unknown>): WorkflowContractError {
  return new WorkflowContractError("BINDING_INVALID", message, details);
}

function verifyToken(store: WorkflowStore, adapter: HostExecutionAdapter, token: string): {
  payload: HostAttestationPayloadV2;
  capability: ResolvedModelCapabilityV1;
} {
  const [prefix, encodedPayload, signature, ...rest] = token.split(".");
  if (prefix !== OBSERVATION_TOKEN_PREFIX || !encodedPayload || !signature || rest.length > 0) {
    throw invalid("Host attestation token is malformed.");
  }
  const expected = Buffer.from(mac(signingKey(store), `${prefix}.${encodedPayload}`), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw invalid("Host attestation token signature is invalid.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw invalid("Host attestation token payload is malformed.");
  }
  const value = record(payload);
  const model = typeof value?.model === "string" ? value.model : null;
  if (
    !value
    || value.v !== 2
    || value.host !== adapter.host
    || !model
    || !Object.hasOwn(value, "policyRevision")
    || (value.policyRevision !== null && !nonEmpty(value.policyRevision)) || !Object.hasOwn(value, "eligibility")
    || (value.provenance !== undefined && (typeof value.provenance !== "string" || value.provenance.length === 0))
    || !isReasoningEffort(value.reasoningEffort)
    || typeof value.session !== "string" || !/^[a-f0-9]{24}$/u.test(value.session)
    || typeof value.call !== "string" || !/^[a-f0-9]{24}$/u.test(value.call)
    || (value.agent !== null && (typeof value.agent !== "string" || !/^[a-f0-9]{24}$/u.test(value.agent)))
    || (value.turn !== null && (typeof value.turn !== "string" || !/^[a-f0-9]{24}$/u.test(value.turn)))
    || value.actorId !== `${adapter.host}:session-${String(value.session)}${value.agent ? `:agent-${String(value.agent)}` : ""}`
  ) {
    throw invalid("Host attestation token payload is not a supported observation for the configured adapter.");
  }
  const provenance = typeof value.provenance === "string" ? value.provenance : `${adapter.host}:runtime`;
  const capability = resolveAdapterModelCapability(adapter, model, provenance);
  if (!capability) {
    const judgment = judgeAdapterModelCapability(adapter, model, provenance);
    throw invalid("Host observation has no matching trusted execution capability and policy revision.", {
      reasonCode: judgment.status === "undetermined" ? judgment.reason : "MODEL_CAPABILITY_UNRESOLVED",
    });
  }
  // A raw v2 observation needs both its signed qualification snapshot and the
  // current trusted descriptor. Null snapshots never inherit server-current eligibility.
  const eligibility = record(value.eligibility);
  if (Object.hasOwn(value, "modelClass") || Object.hasOwn(value, "resolvedModel") || Object.hasOwn(value, "provider")
    || !eligibility || eligibility.modelClass !== capability.modelClass || eligibility.provider !== capability.provider
    || eligibility.resolvedModel !== capability.resolvedModel || eligibility.policyRevision !== capability.policyRevision
    || !nonEmpty(value.policyRevision) || value.policyRevision !== capability.policyRevision
    || (adapter.policyRevision !== undefined && adapter.policyRevision !== capability.policyRevision)
    || capability.host !== adapter.host || capability.rawModel !== model || !nonEmpty(capability.provider)
    || !nonEmpty(capability.resolvedModel) || !nonEmpty(capability.policyRevision)
    || !Array.isArray(capability.supportedEfforts) || !capability.supportedEfforts.every(isReasoningEffort)
    || (capability.minimumReasoningEffort !== null && !isReasoningEffort(capability.minimumReasoningEffort))) {
    throw invalid("Host observation has no matching trusted execution capability and policy revision.");
  }
  if (!satisfiesModelEffortPolicy(capability, value.reasoningEffort as ReasoningEffortV1)) {
    throw invalid("Host attestation token payload is not a supported observation for the configured adapter.");
  }
  return { payload: value as unknown as HostAttestationPayloadV2, capability };
}

/**
 * Supplies the verified observation for the tool call currently being handled.
 * The server wraps each attested tool call in run(); observe() outside run() sees nothing.
 */
export class HostAttestationProvider implements TrustedExecutionContextProvider {
  private current: { tool: string; input: Record<string, unknown>; token: string | null } | null = null;
  private lastVerifiedCapability: ResolvedModelCapabilityV1 | null = null;

  constructor(private readonly store: WorkflowStore, private readonly adapter: HostExecutionAdapter) {}

  /** Host-owned integrations without hooks supply their observation here, outside caller JSON. */
  runObserved<T>(
    tool: string,
    args: Record<string, unknown>,
    observe: () => Omit<HostObservation, "tool" | "input"> | null,
    call: (input: Record<string, unknown>) => T,
  ): T {
    return withHostObservation(this.store, this.adapter, tool, args, observe, (input) => this.run(tool, input, call));
  }

  /** Returns the vendor-neutral capability metadata and policy revision verified on the latest observe() call. */
  lastObservedCapability(): ResolvedModelCapabilityV1 | null {
    return this.lastVerifiedCapability;
  }

  diagnose(): Record<string, unknown> {
    return {
      host: this.adapter.host,
      ...(this.adapter.provider ? { provider: this.adapter.provider } : {}),
      ...(this.adapter.policyRevision ? { policyRevision: this.adapter.policyRevision } : {}),
      status: "missing-call-observation",
      required: ["host-owned model", "reasoningEffort", "session", "current tool call", "signed input binding"],
      connection: "This call has no signed host observation. Check the host-owned adapter observation diagnostic for the current model, reasoning effort, session and call; adapter configuration alone does not prove an observation.",
    };
  }

  run<T>(tool: string, args: Record<string, unknown>, call: (args: Record<string, unknown>) => T): T {
    const input = withoutHostAttestation(args);
    const token = typeof args[HOST_ATTESTATION_FIELD] === "string" ? args[HOST_ATTESTATION_FIELD] as string : null;
    const previous = this.current;
    this.current = { tool, input, token };
    try {
      return call(input);
    } finally {
      this.current = previous;
    }
  }

  observe(binding: ExecutionObservationBindingV1): ExecutionContextV1 | null {
    this.lastVerifiedCapability = null;
    const current = this.current;
    if (!current?.token) return null;
    const { payload, capability } = verifyToken(this.store, this.adapter, current.token);
    if (payload.tool !== current.tool || payload.inputDigest !== convergenceDigest(current.input)) {
      throw invalid("Host attestation token was issued for a different tool call.");
    }
    if (payload.phase !== binding.phase) throw invalid("Host attestation token was issued for a different phase.");
    // A stage call carries no task ID; its run, stage and revision bind the task.
    const taskId = payload.phase === "stage" ? binding.taskId : payload.taskId;
    if (!taskId) throw invalid("Host attestation token is missing its task binding.");
    this.lastVerifiedCapability = capability;
    return {
      schemaVersion: CONTRACT_VERSION,
      model: payload.model,
      modelClass: capability.modelClass,
      reasoningEffort: payload.reasoningEffort,
      source: "runtime",
      observedAt: payload.observedAt,
      observationId: payload.observationId,
      taskId,
      runId: payload.runId,
      stageId: payload.stageId,
      revision: payload.revision,
      actorId: payload.actorId,
      expiresAt: payload.expiresAt,
    };
  }
}
