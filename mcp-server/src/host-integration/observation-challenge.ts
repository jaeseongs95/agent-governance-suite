import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { REASONING_EFFORT } from "../../../contracts/types.js";
import { canonicalJson, convergenceDigest } from "../convergence-logic.js";
import type { WorkflowStore } from "../workflow-store.js";

const CHALLENGE_PREFIX = "agoc1";
const CHALLENGE_TTL_MS = 60_000;
const OBSERVATION_MAX_AGE_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 5_000;
const VM_PIN_PATH_ENV = "AGENT_GOVERNANCE_VM_PIN_PATH";
const VM_DOMAIN = "vm-provider-terminal-to-governance";
const VM_HOST = "flowmarshal-engine";

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
const testReaders = new WeakSet<HostObservationReader>();
interface VerifiedVmObservation { observation: HostInvocationObservationV1; nonceClaimId: string; expiresAt: string }
const hostReaders = new WeakMap<HostObservationReader, () => VerifiedVmObservation>();

/** This source is supplied by the server invocation boundary, not decoded from MCP arguments. */
export interface VmInvocationSource {
  readCurrentInvocation(): {
    receipt: unknown;
    tool: string;
    arguments: Record<string, unknown>;
    binding: HostObservationBindingV1;
    registration?: Record<string, unknown>;
    registrationDigest?: string;
    serverEpoch?: string;
  };
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function terminalMicros(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(seconds)) return null;
  return BigInt(seconds) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0") || "0");
}
function encodedBytes(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) throw invalid("receipt encoding is malformed");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw invalid("receipt encoding is not canonical");
  return bytes;
}
function safeJson(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(safeJson);
  const object = record(value);
  return !!object && Object.values(object).every(safeJson);
}

/** Only operator configuration supplies pins; MCP input and VM caller data never select a key. */
export function readPinnedVmEnvelope(envelopeValue: unknown): { body: Record<string, unknown>; bytes: Buffer; pin: { installationId: string; hostId: string } } {
  const envelope = record(envelopeValue);
  if (!envelope || !exactKeys(envelope, ["body", "signature", "keyId"]) || !nonempty(envelope.keyId)) throw invalid("VM signed envelope is malformed");
  const pinPath = process.env[VM_PIN_PATH_ENV];
  if (!pinPath || !path.isAbsolute(pinPath)) throw invalid("operator VM pin file is unavailable");
  const readPins = () => {
    try {
      const status = lstatSync(pinPath);
      if (!status.isFile() || status.isSymbolicLink()) throw Error("not a regular file");
    } catch { throw invalid("operator VM pin file is unavailable"); }
    let configuration: unknown;
    try { configuration = JSON.parse(readFileSync(pinPath, "utf8")); }
    catch { throw invalid("operator VM pin file is malformed"); }
    const config = record(configuration);
    if (!config || !exactKeys(config, ["version", "pins"]) || config.version !== 1
        || !Array.isArray(config.pins)) throw invalid("operator VM pins are malformed");
    const pins = new Map<string, { installationId: string; hostId: string; key: ReturnType<typeof createPublicKey> }>();
    for (const entry of config.pins) {
      const pin = record(entry);
      if (!pin || !exactKeys(pin, ["keyId", "installationId", "hostId", "publicKeySpki"])
          || !nonempty(pin.keyId) || !nonempty(pin.installationId) || pin.hostId !== VM_HOST
          || typeof pin.publicKeySpki !== "string" || pins.has(pin.keyId)) throw invalid("operator VM pin is malformed");
      let key: ReturnType<typeof createPublicKey>;
      try {
        const bytes = Buffer.from(pin.publicKeySpki, "base64");
        if (bytes.toString("base64") !== pin.publicKeySpki) throw Error("noncanonical key");
        key = createPublicKey({ key: bytes, format: "der", type: "spki" });
        if (key.asymmetricKeyType !== "ed25519") throw Error("wrong key type");
      } catch { throw invalid("operator VM public key is malformed"); }
      pins.set(pin.keyId, { installationId: pin.installationId, hostId: VM_HOST, key });
    }
    return pins;
  };
  const pin = readPins().get(envelope.keyId);
  if (!pin) throw invalid("VM producer key is not pinned");
  const bytes = encodedBytes(envelope.body);
  const signature = encodedBytes(envelope.signature);
  if (signature.length !== 64 || !verify(null, bytes, pin.key, signature)) throw invalid("VM receipt signature mismatch");
  let decoded: unknown;
  try { decoded = JSON.parse(bytes.toString("utf8")); }
  catch { throw invalid("VM receipt body is malformed"); }
  const body = record(decoded);
  if (!body || !safeJson(body) || Buffer.from(canonicalJson(body), "utf8").compare(bytes) !== 0) throw invalid("VM receipt body is not canonical");
  const producer = record(body.producer);
  if (!producer || producer.keyId !== envelope.keyId || producer.installationId !== pin.installationId
      || producer.hostId !== pin.hostId) throw invalid("VM receipt source or binding is invalid");
  return { body, bytes, pin };
}

export function registerVmObservationReader(source: VmInvocationSource): HostObservationReader {
  if (!source || typeof source.readCurrentInvocation !== "function") throw invalid("VM invocation source is unavailable");
  // Fail at registration when the operator has not supplied a usable pin file.
  const pinPath = process.env[VM_PIN_PATH_ENV];
  if (!pinPath || !path.isAbsolute(pinPath)) throw invalid("operator VM pin file is unavailable");
  try { JSON.parse(readFileSync(pinPath, "utf8")); } catch { throw invalid("operator VM pin file is unavailable"); }
  const readVerified = (): VerifiedVmObservation => {
    const current = source.readCurrentInvocation();
    const envelope = record(current?.receipt);
    const argumentsValue = record(current?.arguments);
    const expected = record(current?.binding);
    if (!envelope || !exactKeys(envelope, ["body", "signature", "keyId"])
        || !nonempty(envelope.keyId) || !argumentsValue || !expected
        || !exactKeys(expected, ["invocationId", "turnId", "taskId", "runId", "attemptId", "hostId", "sessionId", "instanceId"])
        || !nonempty(current.tool)) throw invalid("VM invocation context is malformed");
    const { body, bytes, pin } = readPinnedVmEnvelope(envelope);
    const v2 = body.version === 2;
    if (current.registration && !v2) throw invalid("VM authenticated dispatch requires receipt version 2");
    if (!exactKeys(body, ["version", "domain", "producer", "binding", "terminal", "core", "invocation", "nonce", "issuedAt", "expiresAt", ...(v2 ? ["transport"] : [])])) throw invalid("VM receipt body is not canonical");
    const producer = record(body.producer), binding = record(body.binding);
    const terminal = record(body.terminal), core = record(body.core), invocation = record(body.invocation);
    if ((body.version !== 1 && body.version !== 2) || body.domain !== VM_DOMAIN || !producer || !binding || !terminal || !core || !invocation
        || !exactKeys(producer, ["installationId", "keyId", "hostId", "instanceId"])
        || !exactKeys(binding, ["invocationId", "turnId", "taskId", "runId", "attemptId", "hostId", "sessionId", "instanceId"])
        || !exactKeys(terminal, ["eventId", "callId", "threadId", "turnId", "status", "observedAt", "model", "effort", "provenance", "digest"])
        || !exactKeys(core, ["goalRevision", "taskRevision", "attemptOrdinal", "gateOperationKey", "stage"])
        || !exactKeys(invocation, ["tool", "inputDigest", "observedAt"])
        || producer.keyId !== envelope.keyId || producer.installationId !== pin.installationId
        || producer.hostId !== pin.hostId || binding.hostId !== VM_HOST || binding.instanceId !== producer.instanceId
        || !nonempty(producer.instanceId) || !nonempty(body.nonce)
        || !nonempty(binding.invocationId) || !nonempty(binding.turnId)
        || !nonempty(binding.taskId) || !optionalId(binding.runId) || !optionalId(binding.attemptId)
        || !nonempty(binding.sessionId) || !nonempty(binding.instanceId)
        || !nonempty(terminal.eventId) || !nonempty(terminal.callId)
        || !nonempty(terminal.threadId) || terminal.turnId !== binding.turnId
        || typeof terminal.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(terminal.digest)
        || !Number.isSafeInteger(core.goalRevision) || Number(core.goalRevision) < 1
        || !Number.isSafeInteger(core.taskRevision) || Number(core.taskRevision) < 1
        || !(core.attemptOrdinal === null || (Number.isSafeInteger(core.attemptOrdinal) && Number(core.attemptOrdinal) > 0))
        || !nonempty(core.gateOperationKey) || !nonempty(core.stage) || !nonempty(terminal.model)
        || !isReasoningEffort(terminal.effort) || typeof terminal.status !== "string"
        || !["completed", "succeeded"].includes(terminal.status)
        || typeof terminal.provenance !== "string"
        || !["provider_raw_response", "claude_session_transcript"].includes(terminal.provenance)) {
      throw invalid("VM receipt source or binding is invalid");
    }
    for (const field of ["invocationId", "turnId", "taskId", "runId", "attemptId", "hostId", "sessionId", "instanceId"]) {
      if (binding[field] !== expected[field]) throw invalid(`VM ${field} binding mismatch`);
    }
    if (v2) {
      const registration = record(current.registration);
      const transport = record(body.transport);
      if (!registration || !transport || !exactKeys(transport, ["serverEpoch", "registrationDigest"])
          || transport.serverEpoch !== current.serverEpoch || transport.registrationDigest !== current.registrationDigest
          || registration.serverEpoch !== current.serverEpoch) throw invalid("VM transport binding mismatch");
      for (const field of ["producer", "terminal", "core", "invocation"]) {
        if (canonicalJson(body[field]) !== canonicalJson(registration[field])) throw invalid(`VM ${field} registration mismatch`);
      }
      const registeredBinding = record(registration.binding);
      if (!registeredBinding || Object.keys(registeredBinding).some((field) => registeredBinding[field] !== binding[field])
          || Object.keys(binding).some((field) => field !== "invocationId" && !Object.hasOwn(registeredBinding, field))) {
        throw invalid("VM registration binding mismatch");
      }
    }
    const { _hostAttestation, ...unsignedArguments } = argumentsValue;
    if (_hostAttestation === undefined || canonicalJson(_hostAttestation) !== canonicalJson(envelope)
        || invocation.tool !== current.tool || invocation.inputDigest !== convergenceDigest(unsignedArguments)) {
      throw invalid("VM tool or input mismatch");
    }
    const issued = timestamp(body.issuedAt), expires = timestamp(body.expiresAt);
    const observedAt = terminalMicros(terminal.observedAt);
    // VM checks raw microsecond time before serializing issuedAt down to milliseconds.
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || observedAt === null
        || observedAt >= BigInt(issued) * 1000n + 1000n
        || invocation.observedAt !== body.issuedAt || expires - issued !== CHALLENGE_TTL_MS) {
      throw invalid("VM receipt causal time is invalid");
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    return {
      observation: observation({
        binding, observationId: `vm-producer-v1:${hash}`, observedAt: body.issuedAt,
        model: terminal.model, reasoningEffort: terminal.effort,
      }),
      nonceClaimId: `vm-producer-v1:${envelope.keyId}:${body.nonce}`,
      expiresAt: body.expiresAt as string,
    };
  };
  const reader = Object.freeze({ readCurrentInvocation: () => readVerified().observation });
  hostReaders.set(reader, readVerified);
  return reader;
}

/** No VM host producer is wired yet. A callback cannot authenticate its own provenance. */
export function registerHostObservationReader(readCurrentInvocation: () => unknown): HostObservationReader {
  void readCurrentInvocation;
  throw invalid("trusted host observation unavailable: no privileged host producer is connected");
}

/** Test observations exercise the binding contract but never create host authority. */
export function registerTestObservationReader(readCurrentInvocation: () => unknown): HostObservationReader {
  if (typeof readCurrentInvocation !== "function") throw invalid("test observation reader must be a function");
  const reader = Object.freeze({ readCurrentInvocation });
  testReaders.add(reader);
  return reader;
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
 * Host issuance remains closed until a privileged adapter can supply independently verified
 * invocation observations. Test readers cannot be promoted through a source string or callback.
 * The test domain uses its own key and no host authority is constructible yet. A challenge
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
    private readonly onObservationClaim?: () => void,
  ) {
    if (domain !== "host" && domain !== "test") throw invalid("challenge domain is unsupported");
    if (!reader || !(domain === "host" ? hostReaders.has(reader) : testReaders.has(reader))) {
      throw invalid("registered reader domain mismatch or trusted host observation unavailable");
    }
    this.key = Buffer.from(store.getOrCreateSecret(`${domain}_observation_challenge_v1`, () => randomBytes(32).toString("base64url")), "base64url");
    if (this.key.length !== 32) throw invalid("stored challenge key is invalid");
  }

  private mac(encoded: string): Buffer {
    return createHmac("sha256", this.key).update(`${CHALLENGE_PREFIX}.${encoded}`, "utf8").digest();
  }

  issue(): string {
    const verified = this.domain === "host" ? hostReaders.get(this.reader)!() : null;
    const observed = verified?.observation ?? observation(this.reader.readCurrentInvocation());
    const now = this.clock();
    const issuedAt = now.getTime();
    if (!Number.isFinite(issuedAt) || timestamp(observed.observedAt) > issuedAt + CLOCK_SKEW_MS
      || issuedAt - timestamp(observed.observedAt) > OBSERVATION_MAX_AGE_MS) {
      throw invalid("host observation is stale or from the future");
    }
    if (verified) {
      if (issuedAt < timestamp(verified.expiresAt) - CHALLENGE_TTL_MS - CLOCK_SKEW_MS
          || issuedAt >= timestamp(verified.expiresAt)
          || !this.store.claimExecutionObservation(verified.nonceClaimId, verified.expiresAt, now.toISOString())) {
        throw invalid("VM receipt expired or already consumed");
      }
      this.onObservationClaim?.();
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
    const verified = this.domain === "host" ? hostReaders.get(this.reader)!() : null;
    if (verified && (checkedAt < timestamp(verified.expiresAt) - CHALLENGE_TTL_MS - CLOCK_SKEW_MS
        || checkedAt >= timestamp(verified.expiresAt))) throw invalid("VM receipt expired");
    const current = verified?.observation ?? observation(this.reader.readCurrentInvocation());
    if (!sameObservation(observed, current)) throw invalid("different host invocation observation");
    if (!this.store.claimExecutionObservation(`${this.domain}-challenge-v1:${raw.challengeId}`, raw.expiresAt as string, now.toISOString())) {
      throw invalid("challenge was already consumed");
    }
    return raw as unknown as ObservationChallengeBodyV1;
  }
}
