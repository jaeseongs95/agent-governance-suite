import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  CONTRACT_VERSION,
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
 * Claude Code host attestation. A PreToolUse hook run by the Claude Code
 * harness reads the model and effort that issued the exact tool call and
 * injects a signed token into the tool input; the server verifies it and
 * supplies the observation through TrustedExecutionContextProvider.
 *
 * The token proves harness observation, not OS-level isolation: the signing
 * key lives in the plugin's workflow database, readable by the same user.
 */
export const HOST_ATTESTATION_FIELD = "_hostAttestation";
export const HOST_ATTESTATION_TOOLS: ReadonlySet<string> = new Set(["plan_workflow", "record_stage_result"]);

const HOST_ATTESTATION_KEY = "host_attestation_key_v1";
const TOKEN_PREFIX = "aghs1";
// The server accepts observations up to five minutes old; the token may wait on a permission prompt.
const TOKEN_TTL_MS = 5 * 60 * 1000;

const CLAUDE_MODEL_CLASSES: Readonly<Record<string, ModelClassV1>> = {
  haiku: "lightweight",
  sonnet: "general",
  opus: "deep",
  fable: "frontier",
};

// Anthropic IDs (claude-opus-5, claude-3-5-sonnet-20241022), Bedrock IDs with an
// optional region prefix (us., global., us-gov.) and Vertex IDs (claude-opus-5@20260101).
const CLAUDE_MODEL_ID = /^(?:[a-z]{2,6}(?:-[a-z]{2,4})?\.)?(?:anthropic\.)?claude-(?:\d+(?:-\d+)?-)?(haiku|sonnet|opus|fable)(?:[-@:.]|$)/u;

export interface HostAttestationBindingV1 {
  phase: "bootstrap" | "stage";
  taskId: string | null;
  runId: string | null;
  stageId: string | null;
  revision: number | null;
}

interface HostAttestationPayloadV1 extends HostAttestationBindingV1 {
  v: 1;
  host: "claude-code";
  tool: string;
  inputDigest: string;
  model: string;
  modelClass: ModelClassV1;
  reasoningEffort: ReasoningEffortV1;
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

/** Maps a Claude model ID to the class used by the Claude routing presets; unknown models get none. */
export function modelClassForClaudeModel(model: string): ModelClassV1 | null {
  const family = CLAUDE_MODEL_ID.exec(model)?.[1];
  return family ? CLAUDE_MODEL_CLASSES[family] ?? null : null;
}

/** Orders reasoning efforts; used to report the lower of two observations. */
export function lowerReasoningEffort(left: ReasoningEffortV1, right: ReasoningEffortV1): ReasoningEffortV1 {
  return REASONING_EFFORT.indexOf(left) <= REASONING_EFFORT.indexOf(right) ? left : right;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffortV1 {
  return typeof value === "string" && (REASONING_EFFORT as readonly string[]).includes(value);
}

export function withoutHostAttestation(input: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...input };
  delete copy[HOST_ATTESTATION_FIELD];
  return copy;
}

/** Derives the binding the server will check from the tool arguments the caller sent. */
export function hostAttestationBinding(tool: string, input: Record<string, unknown>): HostAttestationBindingV1 | null {
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
  now?: Date;
}

/** Signs one harness observation for one exact tool call. Returns null when the call cannot be attested. */
export function issueHostAttestation(store: WorkflowStore, observation: HostObservation): string | null {
  if (!HOST_ATTESTATION_TOOLS.has(observation.tool)) return null;
  const input = withoutHostAttestation(observation.input);
  const binding = hostAttestationBinding(observation.tool, input);
  const modelClass = modelClassForClaudeModel(observation.model);
  if (!binding || !modelClass || !isReasoningEffort(observation.reasoningEffort) || !observation.actorId) return null;
  const now = observation.now ?? new Date();
  const payload: HostAttestationPayloadV1 = {
    v: 1,
    host: "claude-code",
    tool: observation.tool,
    inputDigest: convergenceDigest(input),
    ...binding,
    model: observation.model,
    modelClass,
    reasoningEffort: observation.reasoningEffort,
    actorId: observation.actorId,
    observationId: randomBytes(24).toString("base64url"),
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
  };
  const body = `${TOKEN_PREFIX}.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  return `${body}.${mac(signingKey(store), body)}`;
}

function invalid(message: string): WorkflowContractError {
  return new WorkflowContractError("BINDING_INVALID", message);
}

function verifyToken(store: WorkflowStore, token: string): HostAttestationPayloadV1 {
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
  if (
    !value
    || value.v !== 1
    || value.host !== "claude-code"
    || typeof value.model !== "string"
    || modelClassForClaudeModel(value.model) !== value.modelClass
    || !isReasoningEffort(value.reasoningEffort)
  ) {
    throw invalid("Host attestation token payload is not a supported Claude Code observation.");
  }
  return value as unknown as HostAttestationPayloadV1;
}

/**
 * Supplies the verified observation for the tool call currently being handled.
 * The server wraps each attested tool call in run(); observe() outside run() sees nothing.
 */
export class HostAttestationProvider implements TrustedExecutionContextProvider {
  private current: { tool: string; input: Record<string, unknown>; token: string | null } | null = null;

  constructor(private readonly store: WorkflowStore) {}

  run<T>(tool: string, args: Record<string, unknown>, call: (args: Record<string, unknown>) => T): T {
    const input = withoutHostAttestation(args);
    const token = typeof args[HOST_ATTESTATION_FIELD] === "string" ? args[HOST_ATTESTATION_FIELD] as string : null;
    this.current = { tool, input, token };
    try {
      return call(input);
    } finally {
      this.current = null;
    }
  }

  observe(binding: ExecutionObservationBindingV1): ExecutionContextV1 | null {
    const current = this.current;
    if (!current?.token) return null;
    const payload = verifyToken(this.store, current.token);
    if (payload.tool !== current.tool || payload.inputDigest !== convergenceDigest(current.input)) {
      throw invalid("Host attestation token was issued for a different tool call.");
    }
    if (payload.phase !== binding.phase) throw invalid("Host attestation token was issued for a different phase.");
    // A stage call carries no task ID; its run, stage and revision bind the task.
    const taskId = payload.phase === "stage" ? binding.taskId : payload.taskId;
    if (!taskId) throw invalid("Host attestation token is missing its task binding.");
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
