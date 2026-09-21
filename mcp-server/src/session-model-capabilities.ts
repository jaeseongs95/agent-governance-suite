/** Optional capability exchange over the existing broker. No dispatch, approval or model execution. */
import { createHmac } from "node:crypto";
import type { HostModelCapabilitiesV1 } from "../../contracts/types.js";
import { RoutingObservationSigner, type RoutingObserverReceipt } from "../../skills/coordinate-subagents/scripts/model-routing-store.mjs";
import { canonicalJson, convergenceDigest } from "./convergence-logic.js";
import { ContractValidator } from "./schema-validator.js";
import { SESSION_MESSAGE_MAX_RESPONSE_BYTES } from "./session-message-protocol.js";
import type { SessionIdentity, SessionMessageStore } from "./session-message-store.js";

export const MODEL_CAPABILITY_FEATURE = "model-capabilities.v1";
export const MODEL_CAPABILITY_MAX_BYTES = 16 * 1024;
export const MODEL_CAPABILITY_MAX_SLOTS = 256;
export type CapabilityIdentity = SessionIdentity & { instanceId: string };
export interface CapabilityPublication {
  schemaVersion: "1.0.0";
  identity: CapabilityIdentity;
  snapshot: HostModelCapabilitiesV1;
}
export interface CapabilityEntry extends CapabilityPublication { presenceLeaseUntil: string; }
export interface CapabilityCursor { revision: number; presenceDigest: string; after: string; }
export interface CapabilityPage {
  schemaVersion: "1.0.0";
  revision: number;
  presenceDigest: string;
  entries: CapabilityEntry[];
  nextCursor: CapabilityCursor | null;
}

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value), "Expected a capability object.");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: string[]): void {
  check(Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)), "Invalid capability fields.");
}
export function capabilitySlot(identity: CapabilityIdentity): string { return convergenceDigest(identity).slice(7); }

/** Domain-separated from transport authentication; never sent in a publication or returned by the broker. */
export function capabilitySigner(brokerToken: string): RoutingObservationSigner {
  check(/^[A-Za-z0-9_-]{43}$/u.test(brokerToken), "Invalid broker credential.");
  return new RoutingObservationSigner(createHmac("sha256", brokerToken).update("ags:session-model-capabilities:v1").digest());
}

/** Common validation is used again by consumers, without promoting configuration to observation. */
export function validateCapabilityPublication(raw: unknown, validator: ContractValidator, nowMs: number): CapabilityPublication {
  const value = object(raw); exact(value, ["schemaVersion", "identity", "snapshot"]);
  check(value.schemaVersion === "1.0.0", "Unsupported capability exchange version.");
  const identity = object(value.identity); exact(identity, ["host", "sessionId", "instanceId"]);
  for (const field of ["host", "sessionId", "instanceId"]) {
    const maximum = field === "host" ? 64 : field === "instanceId" ? 128 : 200;
    check(typeof identity[field] === "string" && identity[field].length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(identity[field]), "Invalid capability transport identity.");
  }
  check(Buffer.byteLength(canonicalJson(value), "utf8") <= MODEL_CAPABILITY_MAX_BYTES, "Capability publication exceeds the size limit.");
  const snapshot = validator.hostModelCapabilitiesV1(value.snapshot);
  check(snapshot.sessionId === identity.sessionId && snapshot.instanceId === identity.instanceId, "Capability session/instance mismatch.");
  const { snapshotDigest, ...unsigned } = snapshot;
  check(convergenceDigest(unsigned) === snapshotDigest, "Capability digest mismatch.");
  const start = Date.parse(snapshot.observedAt), end = Date.parse(snapshot.expiresAt);
  check(Number.isFinite(nowMs) && start <= nowMs && end > nowMs && end - start <= 300000, "Capability is expired, future-dated or exceeds the five-minute sharing lifetime.");
  return { schemaVersion: "1.0.0", identity: { host: String(identity.host), sessionId: String(identity.sessionId), instanceId: String(identity.instanceId) }, snapshot };
}

export function validateCapabilityEntry(raw: unknown, validator: ContractValidator, nowMs: number): CapabilityEntry {
  const entry = object(raw); exact(entry, ["schemaVersion", "identity", "snapshot", "presenceLeaseUntil"]);
  const { presenceLeaseUntil, ...publication } = entry;
  check(typeof presenceLeaseUntil === "string" && Date.parse(presenceLeaseUntil) > nowMs, "Shared capability presence lease expired.");
  return { ...validateCapabilityPublication(publication, validator, nowMs), presenceLeaseUntil };
}

/** Additive, bounded state in the existing session-messaging DB. Legacy messages and user_version are untouched. */
export class SessionModelCapabilityStore {
  private readonly validator = new ContractValidator();

  constructor(private readonly sessions: SessionMessageStore, private readonly signer: RoutingObservationSigner) {
    sessions.database.exec(`
      CREATE TABLE IF NOT EXISTS ags_session_model_capabilities_v1 (
        slot TEXT PRIMARY KEY, observed_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL, receipt TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ags_session_model_capability_nonces_v1 (
        nonce TEXT PRIMARY KEY, receipt_digest TEXT NOT NULL, expires_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ags_session_model_capability_revision_v1 (
        id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO ags_session_model_capability_revision_v1 VALUES (1,0);
    `);
  }

  private transaction<T>(write: boolean, action: () => T): T {
    const db = this.sessions.database;
    db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  private revision(): number {
    return (this.sessions.database.prepare("SELECT revision FROM ags_session_model_capability_revision_v1 WHERE id=1").get() as { revision: number }).revision;
  }
  private active(publication: CapabilityPublication, nowMs: number): string | null {
    const current = this.sessions.presence(publication.identity, nowMs);
    return current.state === "online" && current.instanceId === publication.identity.instanceId ? current.leaseUntil : null;
  }

  publish(receipt: RoutingObserverReceipt, nowMs = Date.now()): { snapshotDigest: string; revision: number; duplicate: boolean } {
    const now = new Date(nowMs).toISOString();
    const publication = validateCapabilityPublication(this.signer.verify(receipt, "capability", now), this.validator, nowMs);
    check(publication.snapshot.expiresAt <= receipt.expiresAt, "The publication outlives its signed receipt.");
    return this.transaction(true, () => {
      check(this.active(publication, nowMs), "Capability does not belong to a live session instance.");
      const db = this.sessions.database, slot = capabilitySlot(publication.identity), hash = convergenceDigest(receipt);
      db.prepare("DELETE FROM ags_session_model_capability_nonces_v1 WHERE expires_at <= ?").run(now);
      const pruned = db.prepare("DELETE FROM ags_session_model_capabilities_v1 WHERE expires_at <= ?").run(now).changes;
      const old = db.prepare("SELECT observed_at,snapshot_digest FROM ags_session_model_capabilities_v1 WHERE slot=?").get(slot) as { observed_at: string; snapshot_digest: string } | undefined;
      const nonce = db.prepare("SELECT receipt_digest FROM ags_session_model_capability_nonces_v1 WHERE nonce=?").get(receipt.nonce) as { receipt_digest: string } | undefined;
      check(!nonce || nonce.receipt_digest === hash, "Capability nonce was reused for different contents.");
      check(!old || old.observed_at < publication.snapshot.observedAt || old.snapshot_digest === publication.snapshot.snapshotDigest,
        "Capability publication is stale or conflicts at the same observation time.");
      check(!nonce || old?.snapshot_digest === publication.snapshot.snapshotDigest, "Capability receipt was superseded.");
      const duplicate = old?.snapshot_digest === publication.snapshot.snapshotDigest;
      if (!old) {
        const count = db.prepare("SELECT COUNT(*) AS n FROM ags_session_model_capabilities_v1").get() as { n: number };
        check(count.n < MODEL_CAPABILITY_MAX_SLOTS, "Capability slot limit reached.");
      }
      if (!nonce) {
        const count = db.prepare("SELECT COUNT(*) AS n FROM ags_session_model_capability_nonces_v1").get() as { n: number };
        check(count.n < 4096, "Capability publication rate limit reached.");
        db.prepare("INSERT INTO ags_session_model_capability_nonces_v1 VALUES (?,?,?)").run(receipt.nonce, hash, receipt.expiresAt);
      }
      if (!duplicate) {
        db.prepare(`INSERT INTO ags_session_model_capabilities_v1 VALUES (?,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET
          observed_at=excluded.observed_at,expires_at=excluded.expires_at,snapshot_digest=excluded.snapshot_digest,receipt=excluded.receipt`)
          .run(slot, publication.snapshot.observedAt, publication.snapshot.expiresAt, publication.snapshot.snapshotDigest, canonicalJson(receipt));
      }
      if (!duplicate || pruned) db.exec("UPDATE ags_session_model_capability_revision_v1 SET revision=revision+1 WHERE id=1");
      return { snapshotDigest: publication.snapshot.snapshotDigest, revision: this.revision(), duplicate };
    });
  }

  list(raw: Record<string, unknown>, nowMs = Date.now()): CapabilityPage {
    check(Object.keys(raw).every(key => key === "cursor"), "Only a capability cursor may be supplied.");
    const cursor = raw.cursor == null ? null : object(raw.cursor);
    if (cursor) {
      exact(cursor, ["revision", "presenceDigest", "after"]);
      check(typeof cursor.presenceDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(cursor.presenceDigest) && Number.isSafeInteger(cursor.revision) && Number(cursor.revision) >= 0 && typeof cursor.after === "string" && /^[a-f0-9]{64}$/u.test(cursor.after), "Invalid capability cursor.");
    }
    return this.transaction(false, () => {
      const revision = this.revision();
      check(cursor === null || cursor.revision === revision, "Capability set changed while paging; discard the partial set.");
      const rows = this.sessions.database.prepare("SELECT slot,receipt FROM ags_session_model_capabilities_v1 WHERE expires_at>? ORDER BY slot")
        .all(new Date(nowMs).toISOString()) as Array<{ slot: string; receipt: string }>;
      check(rows.length <= MODEL_CAPABILITY_MAX_SLOTS, "Capability store exceeds the slot limit.");
      const members = rows.map(row => {
        const receipt = JSON.parse(row.receipt) as RoutingObserverReceipt;
        const publication = validateCapabilityPublication(this.signer.verify(receipt, "capability", new Date(nowMs).toISOString()), this.validator, nowMs);
        check(capabilitySlot(publication.identity) === row.slot, "Corrupted capability slot binding.");
        const presence = this.sessions.presence(publication.identity, nowMs);
        const lease = presence.state === "online" && presence.instanceId === publication.identity.instanceId ? presence.leaseUntil : null;
        return { slot: row.slot, publication, presence, lease };
      });
      // Session end/replacement/lease expiry can change eligibility without any new model publication.
      const presenceDigest = convergenceDigest(members.map(item => [item.slot, item.presence.instanceId, item.presence.state]));
      check(cursor === null || cursor.presenceDigest === presenceDigest, "Session presence changed while paging; discard the partial set.");
      const page: CapabilityPage = { schemaVersion: "1.0.0", revision, presenceDigest, entries: [], nextCursor: null };
      let previous = cursor?.after as string ?? "";
      for (const { slot, publication, lease } of members) {
        if (slot <= (cursor?.after as string ?? "")) continue;
        if (!lease) { previous = slot; continue; }
        const entry: CapabilityEntry = { ...publication, presenceLeaseUntil: lease };
        const proposed = { ...page, entries: [...page.entries, entry], nextCursor: { revision, presenceDigest, after: slot } };
        // Leave room for the broker's normal response envelope; do not raise the existing wire limit.
        if (Buffer.byteLength(JSON.stringify({ ok: true, data: proposed }), "utf8") + 1 > SESSION_MESSAGE_MAX_RESPONSE_BYTES - 512) {
          check(page.entries.length > 0, "Capability cannot fit in a broker response.");
          page.nextCursor = { revision, presenceDigest, after: previous }; break;
        }
        page.entries.push(entry); previous = slot;
      }
      return page;
    });
  }
}
