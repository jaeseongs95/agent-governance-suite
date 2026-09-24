import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { REASONING_EFFORT } from "../../../contracts/types.js";
import { canonicalJson, convergenceDigest } from "../convergence-logic.js";
import { ContractValidator } from "../schema-validator.js";
import type { WorkflowStore } from "../workflow-store.js";
import type { FlowmarshalProfile } from "./flowmarshal-profile.js";
import { verifyFlowmarshalReceipt, type FlowmarshalVerifiedReceipt } from "./observation-challenge.js";

type JsonObject = Record<string, unknown>;
type Reservation = { body: JsonObject; envelope: JsonObject; digest: string; expiresAt: number; used: boolean };
type Current = { callId: string; reservation: Reservation; tool: string; arguments: JsonObject; validated: boolean };
const DISPATCH_DOMAIN = "ags-fm-same-user-dispatch-registration-v1";
const PROFILE_ID = "flowmarshal-same-user-v1";
function reject(reason: string): never { throw new Error(`FlowMarshal A2 dispatch unavailable: ${reason}`); }
const object = (value: unknown): JsonObject | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const exact = (value: JsonObject | null, keys: string[]): boolean => !!value && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const required = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const optional = (value: unknown): value is string | null => value === null || required(value);
const timestamp = (value: unknown): number => {
  if (typeof value !== "string") return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
};
const encoded = (value: unknown): Buffer => {
  if (typeof value !== "string" || value.length > 128 * 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) reject("signed envelope encoding is malformed");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) reject("signed envelope encoding is not canonical");
  return bytes;
};
const safeJson = (value: unknown): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(safeJson);
  const record = object(value);
  return !!record && Object.values(record).every(safeJson);
};

/** A2 registration ledger. It has its own file, pins and domain; no VM verifier or env pin path is used. */
export class FlowmarshalCurrentInvocation {
  readonly serverEpoch = randomBytes(32).toString("base64url");
  private readonly database: DatabaseSync;
  private readonly current = new AsyncLocalStorage<Current>();
  private readonly active = new Set<string>();

  constructor(private readonly profile: FlowmarshalProfile, private readonly store: WorkflowStore,
    private readonly clock: () => number = Date.now) {
    if (profile.profileId !== PROFILE_ID || profile.assuranceTier !== "same-user"
        || !/^sha256:[0-9a-f]{64}$/u.test(profile.freezeIdentity)
        || profile.resources.state.namespace !== PROFILE_ID) reject("A2 profile is unavailable");
    const state = profile.resources.state.location;
    let created = false;
    try {
      const fd = openSync(state, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      closeSync(fd);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") reject("A2 state file cannot be created");
    }
    const status = lstatSync(state);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1
        || (process.platform !== "win32" && (status.uid !== process.getuid?.() || (status.mode & 0o077) !== 0))) {
      reject("A2 state file is unsafe");
    }
    this.database = new DatabaseSync(state);
    if (created) {
      this.database.exec("CREATE TABLE a2_profile_identity (profile_id TEXT PRIMARY KEY CHECK (profile_id = 'flowmarshal-same-user-v1'), freeze_identity TEXT NOT NULL) STRICT");
      this.database.prepare("INSERT INTO a2_profile_identity VALUES (?, ?)").run(PROFILE_ID, profile.freezeIdentity);
    } else {
      let identity: { profile_id: string; freeze_identity: string } | undefined;
      try {
        identity = this.database.prepare("SELECT profile_id, freeze_identity FROM a2_profile_identity").get() as
          { profile_id: string; freeze_identity: string } | undefined;
      } catch {
        this.database.close();
        reject("A2 state namespace is unrecognized");
      }
      if (identity?.profile_id !== PROFILE_ID || identity.freeze_identity !== profile.freezeIdentity) {
        this.database.close();
        reject("A2 state profile identity mismatch");
      }
    }
    this.database.exec(`CREATE TABLE IF NOT EXISTS a2_dispatch_reservations (
      call_id TEXT PRIMARY KEY, nonce_key TEXT NOT NULL UNIQUE, server_epoch TEXT NOT NULL,
      registration_digest TEXT NOT NULL, body_json TEXT NOT NULL, signed_envelope_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1))
    ) STRICT`);
    this.database.exec(`CREATE TABLE IF NOT EXISTS a2_receipt_claims (
      nonce_key TEXT PRIMARY KEY, receipt_digest TEXT NOT NULL, call_id TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL, claimed_at INTEGER NOT NULL
    ) STRICT`);
  }

  close(): void { this.database.close(); }
  hasCurrentRequest(): boolean { return this.current.getStore() !== undefined; }

  verifySignedEnvelope(value: unknown): { body: JsonObject; bytes: Buffer; signature: Buffer; keyId: string } {
    const envelope = object(value);
    if (!exact(envelope, ["body", "signature", "keyId"]) || !required(envelope!.keyId)) reject("signed registration is malformed");
    const pin = this.profile.pins.find((item) => item.keyId === envelope!.keyId && item.status === "active");
    if (!pin) reject("A2 producer key is not pinned");
    const bytes = encoded(envelope!.body), signature = encoded(envelope!.signature);
    const key = createPublicKey({ key: Buffer.from(pin.publicKeySpki, "base64"), format: "der", type: "spki" });
    if (signature.length !== 64 || !verify(null, bytes, key, signature)) reject("registration signature mismatch");
    let decoded: unknown;
    try { decoded = JSON.parse(bytes.toString("utf8")); } catch { reject("registration body is malformed"); }
    const body = object(decoded);
    if (!body || !safeJson(body) || !bytes.equals(Buffer.from(canonicalJson(body), "utf8"))) reject("registration body is not canonical");
    return { body, bytes, signature, keyId: envelope!.keyId as string };
  }

  reserve(signedRegistration: unknown): { callId: string; serverEpoch: string } {
    const { body, bytes, signature, keyId } = this.verifySignedEnvelope(signedRegistration);
    const producer = object(body.producer), binding = object(body.binding);
    const terminal = object(body.terminal), core = object(body.core), invocation = object(body.invocation);
    const now = this.clock(), issued = timestamp(body.issuedAt), expires = timestamp(body.expiresAt);
    const observed = timestamp(terminal?.observedAt);
    if (!exact(body, ["version", "domain", "profileId", "freezeIdentity", "serverEpoch", "nonce", "issuedAt", "expiresAt", "producer", "binding", "terminal", "core", "invocation"])
        || body.version !== 1 || body.domain !== DISPATCH_DOMAIN || body.profileId !== PROFILE_ID
        || body.freezeIdentity !== this.profile.freezeIdentity || body.serverEpoch !== this.serverEpoch
        || !required(body.nonce) || !Number.isFinite(now) || !Number.isFinite(issued) || !Number.isFinite(expires)
        || issued > now + 5_000 || now >= expires || expires - issued !== 60_000
        || !exact(producer, ["installationId", "keyId", "hostId", "instanceId"])
        || producer!.keyId !== keyId || producer!.hostId !== "flowmarshal"
        || !required(producer!.installationId) || !required(producer!.instanceId)
        || !exact(binding, ["turnId", "taskId", "runId", "attemptId", "hostId", "sessionId", "instanceId"])
        || !required(binding!.turnId) || !required(binding!.taskId) || !optional(binding!.runId)
        || !optional(binding!.attemptId) || binding!.hostId !== "flowmarshal"
        || !required(binding!.sessionId) || binding!.instanceId !== producer!.instanceId
        || !exact(terminal, ["eventId", "callId", "threadId", "turnId", "status", "observedAt", "model", "effort", "provenance", "digest"])
        || terminal!.turnId !== binding!.turnId || !required(terminal!.eventId) || !required(terminal!.callId)
        || !required(terminal!.threadId) || !required(terminal!.model)
        || !(REASONING_EFFORT as readonly string[]).includes(String(terminal!.effort))
        || !["succeeded", "completed"].includes(String(terminal!.status))
        || !["provider_raw_response", "claude_session_transcript"].includes(String(terminal!.provenance))
        || !/^sha256:[0-9a-f]{64}$/u.test(String(terminal!.digest))
        || !Number.isFinite(observed) || observed > issued
        || !exact(core, ["goalRevision", "taskRevision", "attemptOrdinal", "gateOperationKey", "stage"])
        || !Number.isSafeInteger(core!.goalRevision) || Number(core!.goalRevision) < 1
        || !Number.isSafeInteger(core!.taskRevision) || Number(core!.taskRevision) < 1
        || !(core!.attemptOrdinal === null || (Number.isSafeInteger(core!.attemptOrdinal) && Number(core!.attemptOrdinal) > 0))
        || !required(core!.gateOperationKey) || !required(core!.stage)
        || !["bootstrap", "baseline", "implementation", "scope", "acceptance"].includes(core!.stage)
        || !exact(invocation, ["tool", "inputDigest", "observedAt"])
        || !["plan_workflow", "record_stage_result"].includes(String(invocation!.tool))
        || !/^sha256:[0-9a-f]{64}$/u.test(String(invocation!.inputDigest))
        || invocation!.observedAt !== body.issuedAt
        || (core!.stage === "bootstrap" && (invocation!.tool !== "plan_workflow" || binding!.runId !== null || binding!.attemptId !== null))
        || (core!.stage !== "bootstrap" && (invocation!.tool !== "record_stage_result" || !required(binding!.runId)))
        || (["bootstrap", "baseline"].includes(String(core!.stage)) && binding!.attemptId !== null)
        || (["implementation", "scope", "acceptance"].includes(String(core!.stage)) && !required(binding!.attemptId))) {
      reject("registration binding is invalid");
    }
    const callId = `fmr-${randomBytes(24).toString("base64url")}`;
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    try {
      this.database.prepare("INSERT INTO a2_dispatch_reservations (call_id, nonce_key, server_epoch, registration_digest, body_json, signed_envelope_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(callId, `${PROFILE_ID}:${keyId}:${body.nonce}`, this.serverEpoch, digest, JSON.stringify(body),
          JSON.stringify({ body: bytes.toString("base64url"), signature: signature.toString("base64url"), keyId }), expires);
    } catch { reject("registration nonce already reserved or A2 state unavailable"); }
    return { callId, serverEpoch: this.serverEpoch };
  }

  private reservation(callId: string): Reservation | null {
    const row = this.database.prepare("SELECT nonce_key, body_json, signed_envelope_json, registration_digest, expires_at, used FROM a2_dispatch_reservations WHERE call_id=? AND server_epoch=?")
      .get(callId, this.serverEpoch) as { nonce_key: string; body_json: string; signed_envelope_json: string;
        registration_digest: string; expires_at: number; used: number } | undefined;
    if (!row) return null;
    const envelope = JSON.parse(row.signed_envelope_json) as JsonObject;
    const verified = this.verifySignedEnvelope(envelope);
    if (JSON.stringify(verified.body) !== row.body_json
        || `sha256:${createHash("sha256").update(verified.bytes).digest("hex")}` !== row.registration_digest
        || verified.body.profileId !== PROFILE_ID || verified.body.freezeIdentity !== this.profile.freezeIdentity
        || verified.body.serverEpoch !== this.serverEpoch
        || row.nonce_key !== `${PROFILE_ID}:${verified.keyId}:${verified.body.nonce}`
        || row.expires_at !== timestamp(verified.body.expiresAt)) reject("stored registration evidence mismatch");
    return { body: verified.body, envelope, digest: row.registration_digest,
      expiresAt: row.expires_at, used: row.used === 1 };
  }

  async runCurrentRequest<T>(requestId: string | number | undefined, tool: string, args: JsonObject,
    run: () => Promise<T>): Promise<T> {
    const callId = typeof requestId === "string" ? requestId : "";
    const reservation = this.reservation(callId);
    if (!reservation) {
      if (Object.hasOwn(args, "_hostAttestation")) reject("current reserved request is unavailable");
      return run();
    }
    if (reservation.used || this.active.has(callId) || this.clock() >= reservation.expiresAt) reject("reservation expired or already used");
    this.active.add(callId);
    try {
      return await this.current.run({ callId, reservation, tool, arguments: args, validated: false }, async () => {
        this.readCurrentInvocation();
        return run();
      });
    } finally { this.active.delete(callId); }
  }

  readCurrentInvocation(): { callId: string; registration: JsonObject; signedRegistration: JsonObject; registrationDigest: string;
    serverEpoch: string; tool: string; arguments: JsonObject } {
    const current = this.current.getStore();
    if (!current || !this.active.has(current.callId) || this.clock() >= current.reservation.expiresAt
        || this.reservation(current.callId)?.digest !== current.reservation.digest
        || this.reservation(current.callId)?.used) reject("current reserved request is unavailable");
    const body = current.reservation.body, binding = object(body.binding)!;
    const core = object(body.core)!, invocation = object(body.invocation)!;
    const unsigned = { ...current.arguments };
    delete unsigned._hostAttestation;
    if (invocation.tool !== current.tool || invocation.inputDigest !== convergenceDigest(unsigned)) {
      reject("current tool or input differs from registration");
    }
    const validator = new ContractValidator();
    if (current.tool === "plan_workflow") {
      const parsed = validator.planWorkflowRequest(unsigned);
      const task = "taskEnvelope" in parsed ? parsed.taskEnvelope : parsed;
      if (task.taskId !== binding.taskId || binding.runId !== null || binding.attemptId !== null
          || core.stage !== "bootstrap") reject("bootstrap task binding mismatch");
    } else if (current.tool === "record_stage_result") {
      const input = { ...unsigned };
      delete input.responseMode;
      const result = validator.stageResult(input);
      const run = this.store.getRun(result.runId);
      const stage = run?.plan.stages.find((item) => item.stageId === result.stageId);
      if (!run || run.state !== "running" || run.revision !== result.expectedRevision
          || run.plan.taskId !== binding.taskId || result.runId !== binding.runId
          || !stage || stage.state !== "ready") reject("stored workflow stage binding mismatch");
    } else reject("tool is not an A2 workflow call");
    current.validated = true;
    return { callId: current.callId, registration: body, signedRegistration: current.reservation.envelope,
      registrationDigest: current.reservation.digest,
      serverEpoch: this.serverEpoch, tool: current.tool, arguments: current.arguments };
  }

  /** F03-b calls this only after receipt validation; invalid receipt must not burn a reservation. */
  claimCurrentReservation(): void {
    const current = this.current.getStore();
    if (!current || !current.validated || !this.active.has(current.callId) || this.clock() >= current.reservation.expiresAt) {
      reject("current reserved request is unavailable");
    }
    const claimed = this.database.prepare("UPDATE a2_dispatch_reservations SET used=1 WHERE call_id=? AND server_epoch=? AND used=0")
      .run(current.callId, this.serverEpoch);
    if (claimed.changes !== 1) reject("reservation already used");
  }

  verifyCurrentReceipt(): FlowmarshalVerifiedReceipt {
    const current = this.current.getStore();
    if (!current || !current.validated || !this.active.has(current.callId)) {
      reject("current reserved request is unavailable");
    }
    const observed = this.readCurrentInvocation();
    const verified = verifyFlowmarshalReceipt({
      envelope: current.arguments._hostAttestation, profile: this.profile,
      registration: observed.registration, registrationDigest: observed.registrationDigest,
      callId: observed.callId, serverEpoch: observed.serverEpoch, tool: observed.tool,
      arguments: observed.arguments, now: this.clock(),
      verifyEnvelope: (envelope) => this.verifySignedEnvelope(envelope),
    });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const now = this.clock();
      if (now >= current.reservation.expiresAt || now >= Date.parse(verified.expiresAt)) {
        reject("A2 receipt expired");
      }
      this.database.prepare("INSERT INTO a2_receipt_claims VALUES (?, ?, ?, ?, ?)")
        .run(verified.nonceKey, verified.receiptDigest, current.callId, Date.parse(verified.expiresAt), now);
      const claimed = this.database.prepare("UPDATE a2_dispatch_reservations SET used=1 WHERE call_id=? AND server_epoch=? AND used=0")
        .run(current.callId, this.serverEpoch);
      if (claimed.changes !== 1) reject("reservation already used");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return verified;
  }
}
