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
const TOKEN_PREFIX = "aghs1";
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

/** Adapter policy owns model mapping, never signing, binding, freshness or replay checks. */
export interface HostExecutionAdapter {
  host: string;
  provider?: string;
  policyRevision?: string;
  modelClassForModel(model: string): ModelClassV1 | null;
  resolveModel?(model: string, provenance?: string): ResolvedModelCapabilityV1 | null;
}

export interface HostAttestationBindingV1 {
  phase: "bootstrap" | "stage";
  taskId: string | null;
  runId: string | null;
  stageId: string | null;
  revision: number | null;
}

interface HostAttestationPayloadV1 extends HostAttestationBindingV1 {
  v: 1;
  host: string;
  provider?: string;
  session: string;
  agent: string | null;
  turn: string | null;
  call: string;
  tool: string;
  inputDigest: string;
  model: string;
  resolvedModel?: string;
  modelClass: ModelClassV1;
  reasoningEffort: ReasoningEffortV1;
  policyRevision?: string;
  provenance?: string;
  actorId: string;
  observationId: string;
  observedAt: string;
  expiresAt: string;
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

/** Resolves a vendor model identifier into a vendor-neutral capability contract at the adapter boundary. */
export function resolveAdapterModelCapability(
  adapter: HostExecutionAdapter,
  model: string,
  provenance: string = `${adapter.host}:runtime`,
): ResolvedModelCapabilityV1 | null {
  if (typeof model !== "string" || model.length === 0) return null;
  if (typeof adapter.resolveModel === "function") {
    const resolved = adapter.resolveModel(model, provenance);
    if (!resolved || !MODEL_CLASS.includes(resolved.modelClass)) return null;
    return resolved;
  }
  const modelClass = adapter.modelClassForModel(model);
  if (!modelClass || !MODEL_CLASS.includes(modelClass)) return null;
  return {
    provider: adapter.provider ?? adapter.host,
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

/** Signs one harness observation for one exact tool call. Returns null when the call cannot be attested. */
export function issueHostAttestation(store: WorkflowStore, adapter: HostExecutionAdapter, observation: HostObservation): string | null {
  if (!HOST_ATTESTATION_TOOLS.has(observation.tool)) return null;
  const input = withoutHostAttestation(observation.input);
  const binding = hostAttestationBinding(observation.tool, input);
  const provenance = nonEmpty(observation.provenance) ?? `${adapter.host}:runtime`;
  const capability = resolveAdapterModelCapability(adapter, observation.model, provenance);
  if (!binding || !capability || !MODEL_CLASS.includes(capability.modelClass) || !adapter.host
    || !isReasoningEffort(observation.reasoningEffort)
    || !satisfiesModelEffortPolicy(capability, observation.reasoningEffort)
    || !observation.actorId || !observation.sessionId || !observation.toolUseId
    || observation.actorId !== hostActorId(adapter.host, observation.sessionId, observation.agentId ?? null)) return null;
  const now = observation.now ?? new Date();
  const scope = {
    host: adapter.host,
    session: hostIdentityDigest(observation.sessionId),
    agent: observation.agentId ? hostIdentityDigest(observation.agentId) : null,
    turn: observation.turnId ? hostIdentityDigest(observation.turnId) : null,
    call: hostIdentityDigest(observation.toolUseId),
  };
  const payload: HostAttestationPayloadV1 = {
    v: 1,
    ...scope,
    provider: capability.provider,
    tool: observation.tool,
    inputDigest: convergenceDigest(input),
    ...binding,
    model: observation.model,
    resolvedModel: capability.resolvedModel,
    modelClass: capability.modelClass,
    reasoningEffort: observation.reasoningEffort,
    policyRevision: capability.policyRevision,
    provenance: capability.provenance,
    actorId: observation.actorId,
    // Retrying the same host call cannot mint a second consumable observation.
    observationId: createHash("sha256").update(JSON.stringify(scope), "utf8").digest("base64url"),
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
  };
  const body = `${TOKEN_PREFIX}.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
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

function invalid(message: string): WorkflowContractError {
  return new WorkflowContractError("BINDING_INVALID", message);
}

function verifyToken(store: WorkflowStore, adapter: HostExecutionAdapter, token: string): HostAttestationPayloadV1 {
  const [prefix, encodedPayload, signature, ...rest] = token.split(".");
  if (prefix !== TOKEN_PREFIX || !encodedPayload || !signature || rest.length > 0) {
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
  const capability = model
    ? resolveAdapterModelCapability(adapter, model, typeof value?.provenance === "string" ? value.provenance : `${adapter.host}:runtime`)
    : null;
  if (
    !value
    || value.v !== 1
    || value.host !== adapter.host
    || !model
    || !capability
    || !MODEL_CLASS.includes(value.modelClass as ModelClassV1)
    || capability.modelClass !== value.modelClass
    || (value.provider !== undefined && value.provider !== capability.provider)
    || (value.resolvedModel !== undefined && value.resolvedModel !== capability.resolvedModel)
    || (value.policyRevision !== undefined && value.policyRevision !== capability.policyRevision)
    || (value.provenance !== undefined && (typeof value.provenance !== "string" || value.provenance.length === 0))
    || !isReasoningEffort(value.reasoningEffort)
    || !satisfiesModelEffortPolicy(capability, value.reasoningEffort)
    || typeof value.session !== "string" || !/^[a-f0-9]{24}$/u.test(value.session)
    || typeof value.call !== "string" || !/^[a-f0-9]{24}$/u.test(value.call)
    || (value.agent !== null && (typeof value.agent !== "string" || !/^[a-f0-9]{24}$/u.test(value.agent)))
    || (value.turn !== null && (typeof value.turn !== "string" || !/^[a-f0-9]{24}$/u.test(value.turn)))
    || value.actorId !== `${adapter.host}:session-${String(value.session)}${value.agent ? `:agent-${String(value.agent)}` : ""}`
  ) {
    throw invalid("Host attestation token payload is not a supported observation for the configured adapter.");
  }
  return value as unknown as HostAttestationPayloadV1;
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
      connection: "Enable the host PreToolUse adapter, or supply host-owned observations through HostAttestationProvider.runObserved; caller executionContext is not trusted.",
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
    const payload = verifyToken(this.store, this.adapter, current.token);
    if (payload.tool !== current.tool || payload.inputDigest !== convergenceDigest(current.input)) {
      throw invalid("Host attestation token was issued for a different tool call.");
    }
    if (payload.phase !== binding.phase) throw invalid("Host attestation token was issued for a different phase.");
    // A stage call carries no task ID; its run, stage and revision bind the task.
    const taskId = payload.phase === "stage" ? binding.taskId : payload.taskId;
    if (!taskId) throw invalid("Host attestation token is missing its task binding.");
    this.lastVerifiedCapability = resolveAdapterModelCapability(
      this.adapter,
      payload.model,
      payload.provenance ?? `${this.adapter.host}:runtime`,
    );
    return {
      schemaVersion: CONTRACT_VERSION,
      model: payload.model,
      modelClass: payload.modelClass,
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
