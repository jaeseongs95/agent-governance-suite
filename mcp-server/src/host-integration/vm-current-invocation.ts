import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";

import { convergenceDigest } from "../convergence-logic.js";
import { readPinnedVmEnvelope, registerVmObservationReader, type HostObservationBindingV1, type HostObservationReader, type VmInvocationSource } from "./observation-challenge.js";

type JsonObject = Record<string, unknown>;
type Pending = { registration: JsonObject; digest: string; expiresAt: number; active: boolean };
type Current = { callId: string; pending: Pending; tool: string; arguments: JsonObject };

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
function exact(value: JsonObject | null, keys: string[]): boolean {
  return !!value && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function required(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function optional(value: unknown): value is string | null { return value === null || required(value); }
function date(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
}
function reject(reason: string): never { throw new Error(`VM dispatch unavailable: ${reason}`); }

/** One AGS process and its dedicated VM stdio connection own this epoch and request ledger. */
export class VmCurrentInvocation implements VmInvocationSource {
  readonly serverEpoch = randomBytes(32).toString("base64url");
  readonly observationReader: HostObservationReader;
  private readonly pending = new Map<string, Pending>();
  private readonly usedNonces = new Map<string, number>();
  private readonly current = new AsyncLocalStorage<Current>();

  constructor(private readonly clock: () => number = Date.now) {
    this.observationReader = registerVmObservationReader(this);
  }

  reserve(registrationEnvelope: unknown): { callId: string; serverEpoch: string } {
    const { body, bytes } = readPinnedVmEnvelope(registrationEnvelope);
    const producer = object(body.producer), binding = object(body.binding);
    const terminal = object(body.terminal), core = object(body.core), invocation = object(body.invocation);
    const now = this.clock(), issued = date(body.issuedAt), expires = date(body.expiresAt);
    const terminalTime = typeof terminal?.observedAt === "string" ? Date.parse(terminal.observedAt) : NaN;
    if (!exact(body, ["version", "domain", "serverEpoch", "nonce", "issuedAt", "expiresAt", "producer", "binding", "terminal", "core", "invocation"])
        || body.version !== 1 || body.domain !== "ags-vm-dispatch-registration-v1"
        || body.serverEpoch !== this.serverEpoch || !required(body.nonce)
        || !Number.isFinite(now) || !Number.isFinite(issued) || !Number.isFinite(expires)
        || issued > now + 5_000 || now >= expires || expires - issued !== 60_000
        || !exact(producer, ["installationId", "keyId", "hostId", "instanceId"])
        || !exact(binding, ["turnId", "taskId", "runId", "attemptId", "hostId", "sessionId", "instanceId"])
        || !exact(terminal, ["eventId", "callId", "threadId", "turnId", "status", "observedAt", "model", "effort", "provenance", "digest"])
        || !exact(core, ["goalRevision", "taskRevision", "attemptOrdinal", "gateOperationKey", "stage"])
        || !exact(invocation, ["tool", "inputDigest", "observedAt"])
        || !required(binding!.turnId) || !required(binding!.taskId) || !optional(binding!.runId)
        || !optional(binding!.attemptId) || binding!.hostId !== "flowmarshal-engine"
        || !required(binding!.sessionId) || !required(binding!.instanceId)
        || binding!.instanceId !== producer!.instanceId || terminal!.turnId !== binding!.turnId
        || !required(terminal!.eventId) || !required(terminal!.callId)
        || !required(terminal!.model) || !required(terminal!.effort)
        || !Number.isFinite(terminalTime) || terminalTime > issued
        || !Number.isSafeInteger(core!.goalRevision) || Number(core!.goalRevision) < 1
        || !Number.isSafeInteger(core!.taskRevision) || Number(core!.taskRevision) < 1
        || !(core!.attemptOrdinal === null || (Number.isSafeInteger(core!.attemptOrdinal) && Number(core!.attemptOrdinal) > 0))
        || !required(core!.gateOperationKey) || !required(core!.stage)
        || !["bootstrap", "baseline", "implementation", "scope", "acceptance"].includes(core!.stage)
        || (core!.stage === "bootstrap" && (invocation!.tool !== "plan_workflow" || binding!.runId !== null || binding!.attemptId !== null))
        || (core!.stage !== "bootstrap" && (invocation!.tool !== "record_stage_result" || !required(binding!.runId)))
        || (["bootstrap", "baseline"].includes(core!.stage as string) && binding!.attemptId !== null)
        || (["implementation", "scope", "acceptance"].includes(core!.stage as string) && !required(binding!.attemptId))
        || !required(invocation!.tool) || !/^sha256:[0-9a-f]{64}$/u.test(String(invocation!.inputDigest))
        || invocation!.observedAt !== body.issuedAt) {
      reject("registration binding is invalid");
    }
    const nonceKey = `${producer!.keyId}:${body.nonce}`;
    for (const [key, expiry] of this.usedNonces) if (expiry <= now) this.usedNonces.delete(key);
    for (const [key, value] of this.pending) if (value.expiresAt <= now && !value.active) this.pending.delete(key);
    if (this.usedNonces.has(nonceKey)) reject("registration nonce already reserved");
    if (this.pending.size >= 4096 || this.usedNonces.size >= 8192) reject("registration ledger is full");
    const callId = `vmr-${randomBytes(24).toString("base64url")}`;
    this.usedNonces.set(nonceKey, expires);
    this.pending.set(callId, {
      registration: structuredClone(body),
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      expiresAt: expires, active: false,
    });
    return { callId, serverEpoch: this.serverEpoch };
  }

  async runCurrentRequest<T>(requestId: string | number | undefined, tool: string, args: JsonObject, run: () => Promise<T>): Promise<T> {
    const callId = typeof requestId === "string" ? requestId : "";
    const pending = this.pending.get(callId);
    if (!pending) return run();
    if (pending.active || this.clock() >= pending.expiresAt) reject("reservation expired or already active");
    pending.active = true;
    try { return await this.current.run({ callId, pending, tool, arguments: args }, run); }
    finally { this.pending.delete(callId); }
  }

  readCurrentInvocation() {
    const current = this.current.getStore();
    if (!current || this.pending.get(current.callId) !== current.pending || !current.pending.active
        || this.clock() >= current.pending.expiresAt) reject("current reserved request is unavailable");
    const registration = current.pending.registration;
    const binding = object(registration.binding)!;
    const unsigned = { ...current.arguments };
    delete unsigned._hostAttestation;
    const invocation = object(registration.invocation)!;
    if (invocation.tool !== current.tool || invocation.inputDigest !== convergenceDigest(unsigned)) {
      reject("current tool or input differs from registration");
    }
    return {
      receipt: current.arguments._hostAttestation,
      tool: current.tool,
      arguments: current.arguments,
      binding: { invocationId: current.callId, ...binding } as HostObservationBindingV1,
      registration,
      registrationDigest: current.pending.digest,
      serverEpoch: this.serverEpoch,
    };
  }
}
