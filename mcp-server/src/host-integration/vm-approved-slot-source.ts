import { createHash } from "node:crypto";

import type { VmCurrentInvocation } from "./vm-current-invocation.js";

type RecordValue = Record<string, unknown>;
type SignedSource = { body: string; signature: string; keyId: string };
type Pending = { envelope: SignedSource; expiresAt: number; scope: string; revision: number; digest: string };

const DOMAIN = "ags-vm-approved-slot-source-v1";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}
function exact(value: RecordValue | null, keys: string[]): boolean {
  return !!value && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function digest(value: unknown): value is string { return typeof value === "string" && DIGEST.test(value); }
function timestamp(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
}
function deny(reason: string): never { throw new Error(`VM approved slot source unavailable: ${reason}`); }

// VM snapshot_digest uses Python json.dumps(sort_keys=True), whose key order is Unicode code point order.
function pythonCanonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(pythonCanonical).join(",")}]`;
  const object = record(value);
  if (!object) deny("snapshot JSON is invalid");
  const compare = (left: string, right: string): number => {
    const a = Array.from(left, (char) => char.codePointAt(0)!);
    const b = Array.from(right, (char) => char.codePointAt(0)!);
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      if (a[index] !== b[index]) return a[index]! - b[index]!;
    }
    return a.length - b.length;
  };
  return `{${Object.keys(object).sort(compare).map((key) => `${JSON.stringify(key)}:${pythonCanonical(object[key])}`).join(",")}}`;
}

export type ApprovedSlotSource = RecordValue & { snapshot_digest: string };
export type ApprovedSlotExpectation = { invocationId: string; projectId: string; taskId: string; snapshotDigest: string };

/** Server-owned, one-use source on the dedicated VM child pipe. It grants no dispatch authority. */
export class VmApprovedSlotSource {
  private readonly pending = new Map<string, Pending>();
  private readonly usedNonces = new Map<string, number>();
  private readonly usedInvocations = new Map<string, number>();
  private readonly latest = new Map<string, { revision: number; digest: string; expiresAt: number }>();

  constructor(private readonly vm: Pick<VmCurrentInvocation, "serverEpoch" | "verifySignedEnvelope">,
    private readonly clock: () => number = Date.now) {}

  private verify(requestId: string, envelope: unknown): { source: ApprovedSlotSource; body: RecordValue; expiresAt: number } {
    const signed = record(envelope);
    if (!exact(signed, ["body", "signature", "keyId"]) || typeof signed!.body !== "string"
        || signed!.body.length > 1_400_000) deny("signed envelope is invalid");
    const { body } = this.vm.verifySignedEnvelope(envelope);
    const producer = record(body.producer), binding = record(body.binding), source = record(body.source);
    const participation = record(source?.participation);
    const now = this.clock(), issued = timestamp(body.issuedAt), expiresAt = timestamp(body.expiresAt);
    if (!exact(body, ["version", "domain", "producer", "binding", "nonce", "issuedAt", "expiresAt", "source"])
        || body.version !== 1 || body.domain !== DOMAIN
        || !exact(producer, ["installationId", "keyId", "hostId", "instanceId", "sessionId"])
        || !nonempty(producer!.instanceId) || !nonempty(producer!.sessionId)
        || !exact(binding, ["invocationId", "serverEpoch", "projectId", "taskId", "snapshotDigest"])
        || binding!.invocationId !== requestId || binding!.serverEpoch !== this.vm.serverEpoch
        || !nonempty(binding!.projectId) || !nonempty(binding!.taskId) || !digest(binding!.snapshotDigest)
        || !nonempty(body.nonce) || body.nonce.length < 24 || body.nonce.length > 256
        || !Number.isFinite(now) || !Number.isFinite(issued) || !Number.isFinite(expiresAt)
        || issued > now + 5_000 || now >= expiresAt || expiresAt - issued !== 60_000
        || !exact(source, ["owner", "project_id", "task_id", "run_id", "plan_revision_id", "plan_id",
          "revision_no", "definition_digest", "activation_digest", "activation_id",
          "activation_authorization_id", "authorization_id", "authorization_revision_no",
          "authorization_digest", "revoked", "stages", "participation", "source_revision", "snapshot_digest"])
        || source!.owner !== "flowmarshal-engine" || source!.project_id !== binding!.projectId
        || source!.task_id !== binding!.taskId || source!.revoked !== false
        || !nonempty(source!.run_id) || !nonempty(source!.plan_revision_id) || !nonempty(source!.plan_id)
        || !nonempty(source!.activation_id) || !nonempty(source!.activation_authorization_id)
        || !nonempty(source!.authorization_id)
        || !Number.isSafeInteger(source!.revision_no) || Number(source!.revision_no) < 1
        || !Number.isSafeInteger(source!.authorization_revision_no) || Number(source!.authorization_revision_no) < 1
        || !digest(source!.definition_digest) || !digest(source!.activation_digest)
        || !digest(source!.authorization_digest) || !digest(source!.snapshot_digest)
        || source!.snapshot_digest !== binding!.snapshotDigest
        || !Array.isArray(source!.stages) || source!.stages.length < 1 || source!.stages.length > 64
        || !exact(participation, ["entries", "complete", "watermark"])
        || participation!.complete !== true || !Array.isArray(participation!.entries)
        || participation!.entries.length > 256
        || !Number.isSafeInteger(participation!.watermark) || Number(participation!.watermark) < 0
        || source!.source_revision !== participation!.watermark) deny("source binding is invalid");
    const { snapshot_digest: snapshotDigest, ...unsignedSource } = source!;
    const computed = `sha256:${createHash("sha256").update(pythonCanonical(unsignedSource)).digest("hex")}`;
    if (computed !== snapshotDigest) deny("source digest is invalid");
    return { source: structuredClone(source) as ApprovedSlotSource, body, expiresAt };
  }

  register(requestId: string | number | undefined, envelope: unknown) {
    if (typeof requestId !== "string" || !/^vm-approved-slot-[A-Za-z0-9_-]{24,128}$/u.test(requestId)) {
      deny("invocation ID is invalid");
    }
    const { source, body, expiresAt } = this.verify(requestId, envelope);
    const now = this.clock();
    for (const [key, expiry] of this.usedNonces) if (expiry <= now) this.usedNonces.delete(key);
    for (const [key, expiry] of this.usedInvocations) if (expiry <= now) this.usedInvocations.delete(key);
    for (const [key, pending] of this.pending) if (pending.expiresAt <= now) this.pending.delete(key);
    for (const [key, value] of this.latest) if (value.expiresAt <= now) this.latest.delete(key);
    const producer = record(body.producer)!;
    const nonceKey = `${producer.installationId}:${producer.keyId}:${body.nonce}`;
    const scope = `${source.project_id}\u0000${source.task_id}`;
    const revision = source.source_revision as number;
    const previous = this.latest.get(scope);
    if (previous && (revision < previous.revision
        || (revision === previous.revision && source.snapshot_digest !== previous.digest))) {
      deny("source revision is stale or conflicting");
    }
    if (this.usedInvocations.has(requestId) || this.usedNonces.has(nonceKey)) deny("source replay is unavailable");
    if (this.pending.size >= 4096 || this.usedNonces.size >= 8192 || this.usedInvocations.size >= 8192
        || (!previous && this.latest.size >= 4096)) {
      deny("source registry is full");
    }
    this.usedNonces.set(nonceKey, expiresAt);
    this.usedInvocations.set(requestId, expiresAt);
    if (!previous || revision > previous.revision) {
      for (const [key, pending] of this.pending) if (pending.scope === scope) this.pending.delete(key);
    }
    this.latest.set(scope, { revision, digest: source.snapshot_digest, expiresAt });
    this.pending.set(requestId, { envelope: structuredClone(envelope) as SignedSource, expiresAt,
      scope, revision, digest: source.snapshot_digest });
    return { accepted: true, invocationId: requestId, serverEpoch: this.vm.serverEpoch,
      snapshotDigest: source.snapshot_digest, projectId: source.project_id as string,
      taskId: source.task_id as string };
  }

  consume(expected: ApprovedSlotExpectation): ApprovedSlotSource {
    const pending = this.pending.get(expected.invocationId);
    if (!pending) deny("pending source is unavailable");
    this.pending.delete(expected.invocationId);
    const { source } = this.verify(expected.invocationId, pending.envelope);
    const latest = this.latest.get(pending.scope);
    if (!latest || latest.revision !== pending.revision || latest.digest !== pending.digest) {
      deny("pending source is stale");
    }
    if (source.project_id !== expected.projectId || source.task_id !== expected.taskId
        || source.snapshot_digest !== expected.snapshotDigest) deny("pending source binding changed");
    return source;
  }
}
