import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { REASONING_EFFORT } from "../../../contracts/types.js";
import type { WorkflowStore } from "../workflow-store.js";

const CHALLENGE_PREFIX = "agoc1";
const CHALLENGE_TTL_MS = 60_000;
const OBSERVATION_MAX_AGE_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 5_000;

export interface HostObservationBindingV1 {
  invocationId: string;
  turnId: string;
  taskId: string;
  runId: string | null;
  attemptId: string | null;
  hostId: string;
  sessionId: string;
  instanceId: string;
}

/** The adapter reads this from a host-controlled invocation event, never from CLI stdin or MCP arguments. */
export interface HostInvocationObservationV1 {
  binding: HostObservationBindingV1;
  observationId: string;
  observedAt: string;
  model: string;
  reasoningEffort: string;
}

export interface ObservationChallengeBodyV1 extends HostInvocationObservationV1 {
  version: 1;
  domain: "host" | "test";
  challengeId: string;
  issuedAt: string;
  expiresAt: string;
}

/** Host adapter code owns this reader. A caller's format-valid JSON is never a reader. */
export interface HostObservationReader {
  readCurrentInvocation(): unknown;
}

type ChallengeStore = Pick<WorkflowStore, "getOrCreateSecret" | "claimExecutionObservation">;
const readerDomains = new WeakMap<HostObservationReader, "host" | "test">();

function registerReader(readCurrentInvocation: () => unknown, domain: "host" | "test"): HostObservationReader {
  if (typeof readCurrentInvocation !== "function") throw invalid("host observation reader must be a function");
  const reader = Object.freeze({ readCurrentInvocation });
  readerDomains.set(reader, domain);
  return reader;
}

/** Only privileged host adapter wiring may register its host-controlled event reader here. */
export function registerHostObservationReader(readCurrentInvocation: () => unknown): HostObservationReader {
  return registerReader(readCurrentInvocation, "host");
}

/** Test observations are permanently separated from the host challenge key and verifier. */
export function registerTestObservationReader(readCurrentInvocation: () => unknown): HostObservationReader {
  return registerReader(readCurrentInvocation, "test");
}

function invalid(message: string): Error { return new Error(`Invalid observation challenge: ${message}`); }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function optionalId(value: unknown): value is string | null { return value === null || nonempty(value); }
function isReasoningEffort(value: unknown): value is string {
  return typeof value === "string" && (REASONING_EFFORT as readonly string[]).includes(value);
}
function timestamp(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : NaN;
}

function observation(value: unknown): HostInvocationObservationV1 {
  const object = record(value);
  const binding = record(object?.binding);
  if (!object || !binding || !nonempty(binding.invocationId) || !nonempty(binding.turnId)
    || !nonempty(binding.taskId) || !optionalId(binding.runId) || !optionalId(binding.attemptId)
    || !nonempty(binding.hostId) || !nonempty(binding.sessionId) || !nonempty(binding.instanceId)
    || !nonempty(object.observationId) || !nonempty(object.model)
    || !isReasoningEffort(object.reasoningEffort) || !Number.isFinite(timestamp(object.observedAt))) {
    throw invalid("trusted host invocation observation is missing or malformed");
  }
  return {
    binding: {
      invocationId: binding.invocationId, turnId: binding.turnId, taskId: binding.taskId,
      runId: binding.runId, attemptId: binding.attemptId, hostId: binding.hostId,
      sessionId: binding.sessionId, instanceId: binding.instanceId,
    } as HostObservationBindingV1,
    observationId: object.observationId as string,
    observedAt: object.observedAt as string,
    model: object.model as string,
    reasoningEffort: object.reasoningEffort as string,
  };
}

function sameObservation(left: HostInvocationObservationV1, right: HostInvocationObservationV1): boolean {
  return left.observationId === right.observationId && left.observedAt === right.observedAt
    && left.model === right.model && left.reasoningEffort === right.reasoningEffort
    && Object.keys(left.binding).every((key) =>
      left.binding[key as keyof HostObservationBindingV1] === right.binding[key as keyof HostObservationBindingV1]);
}

/**
 * The real reader must be wired by a privileged host adapter to its current invocation event.
 * The test domain has a different key and is never accepted by a host authority. A challenge
 * binds an observation; it does not prove a self-report, authorize human approval, or authenticate
 * a requested model setting. The V04 signer and server verifier must use this same boundary.
 */
export class ObservationChallengeAuthority {
  private readonly key: Buffer;

  constructor(
    private readonly store: ChallengeStore,
    private readonly reader: HostObservationReader,
    private readonly domain: "host" | "test",
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (domain !== "host" && domain !== "test") throw invalid("challenge domain is unsupported");
    if (!reader || readerDomains.get(reader) !== domain) throw invalid("registered reader domain mismatch");
    const secretName = domain === "host" ? "host_observation_challenge_v1" : "test_observation_challenge_v1";
    this.key = Buffer.from(store.getOrCreateSecret(secretName, () => randomBytes(32).toString("base64url")), "base64url");
    if (this.key.length !== 32) throw invalid("stored challenge key is invalid");
  }

  private mac(encoded: string): Buffer {
    return createHmac("sha256", this.key).update(`${CHALLENGE_PREFIX}.${encoded}`, "utf8").digest();
  }

  issue(): string {
    const observed = observation(this.reader.readCurrentInvocation());
    const now = this.clock();
    const issuedAt = now.getTime();
    if (!Number.isFinite(issuedAt) || timestamp(observed.observedAt) > issuedAt + CLOCK_SKEW_MS
      || issuedAt - timestamp(observed.observedAt) > OBSERVATION_MAX_AGE_MS) {
      throw invalid("host observation is stale or from the future");
    }
    const body: ObservationChallengeBodyV1 = {
      ...observed, version: 1, domain: this.domain,
      challengeId: randomBytes(24).toString("base64url"),
      issuedAt: now.toISOString(), expiresAt: new Date(issuedAt + CHALLENGE_TTL_MS).toISOString(),
    };
    const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
    return `${CHALLENGE_PREFIX}.${encoded}.${this.mac(encoded).toString("base64url")}`;
  }

  verifyAndConsume(token: string): ObservationChallengeBodyV1 {
    if (typeof token !== "string" || token.length > 8192) throw invalid("token is malformed");
    const [prefix, encoded, signature, extra] = token.split(".");
    if (prefix !== CHALLENGE_PREFIX || !encoded || !signature || extra !== undefined) throw invalid("token is malformed");
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded) || !/^[A-Za-z0-9_-]+$/u.test(signature)
      || Buffer.from(encoded, "base64url").toString("base64url") !== encoded) throw invalid("token is malformed");
    const actual = Buffer.from(signature, "base64url");
    if (actual.toString("base64url") !== signature) throw invalid("token is malformed");
    const expected = this.mac(encoded);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid("signature mismatch");
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
    catch { throw invalid("body is malformed"); }
    const raw = record(parsed);
    const observed = observation(raw);
    if (!raw || raw.version !== 1 || raw.domain !== this.domain || !nonempty(raw.challengeId)
      || !Number.isFinite(timestamp(raw.issuedAt)) || !Number.isFinite(timestamp(raw.expiresAt))) {
      throw invalid("body is malformed");
    }
    const issuedAt = timestamp(raw.issuedAt);
    const expiresAt = timestamp(raw.expiresAt);
    const now = this.clock();
    const checkedAt = now.getTime();
    if (!Number.isFinite(checkedAt) || checkedAt < issuedAt - CLOCK_SKEW_MS || checkedAt >= expiresAt
      || expiresAt - issuedAt !== CHALLENGE_TTL_MS
      || timestamp(observed.observedAt) > issuedAt + CLOCK_SKEW_MS
      || issuedAt - timestamp(observed.observedAt) > OBSERVATION_MAX_AGE_MS) {
      throw invalid("challenge expired or has invalid lifetime");
    }
    const current = observation(this.reader.readCurrentInvocation());
    if (!sameObservation(observed, current)) throw invalid("different host invocation observation");
    if (!this.store.claimExecutionObservation(`host-challenge-v1:${raw.challengeId}`, raw.expiresAt as string, now.toISOString())) {
      throw invalid("challenge was already consumed");
    }
    return raw as unknown as ObservationChallengeBodyV1;
  }
}
