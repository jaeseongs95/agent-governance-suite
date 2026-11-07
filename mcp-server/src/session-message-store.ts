import { relayCodeDigest } from "./relay-code-identity.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { types as utilTypes } from "node:util";
import { retainFailureSecondary, tagProducerFailure } from "./failure-diagnostics.js";
import { startNotAfter } from "./host-process-watch.js";
import type { SharedModuleContext, SqlDatabase } from "../../runtime/unified-state/shared-connection.mjs";

import { isBoundedIdentity, SESSION_MESSAGE_BODY_MAX_BYTES, SESSION_MESSAGE_MAX_RESPONSE_BYTES, SessionMessageError } from "./session-message-protocol.js";
import { isWakeDispatchOutcome, isWakeHookObservation, wakeBackoffDelay, type WakeDispatchOutcome, type WakeHookObservationReader } from "./session-message-wake-port.js";
import type { DeliveryCapabilities, InputObservation, InputObservationKind } from "./input-observation.js";
import type { SessionAutoWakeOutlookV2 } from "../../contracts/types.js";
import { msg, type MessageRef } from "./i18n.js";

export const MESSAGE_BODY_MAX_BYTES = SESSION_MESSAGE_BODY_MAX_BYTES;
export const MESSAGE_TTL_DEFAULT_SECONDS = 3600;
export const MESSAGE_TTL_MAX_SECONDS = 86400;
const MESSAGE_LIMIT = 1000;
const MESSAGE_BYTES_LIMIT = 4 * 1024 * 1024;
export const MESSAGE_DRAFT_TTL_MS = 10 * 60_000;
export const MESSAGE_DRAFT_LIMIT = 1000;
export const MESSAGE_SENDER_DRAFT_LIMIT = 100;
export const MESSAGE_RECEIPT_LIMIT = 1000;
/** Fairness between cooperating sender sessions; the sender identity is the bound session, not an authenticated principal. */
export const MESSAGE_SENDER_RECEIPT_LIMIT = 250;
export const MESSAGE_ID_RECORD_BYTES_LIMIT = 4 * 1024 * 1024;
const MESSAGE_RECEIPT_EXTRA_MS = 3600_000;
const CLAIM_LEASE_BASE_MS = 120_000;
const CLAIM_LEASE_MAX_MS = 30 * 60_000;
const RELAY_LEASE_MS = 15_000;
/** Injection expiry of a reserved attempt; an arrival of the current birth still claims after it (2.7). */
export const WAKE_TTL_MS = 60 * 60_000;
/** Reporting only: a hand-off younger than this is in flight, older is unanswered. */
export const WAKE_OBSERVATION_WINDOW_MS = 60_000;
/** Optimization, not correctness: a birth that passed a claim boundary this recently is not rung. */
export const WAKE_QUIET_MS = 60_000;
/** The quiet gate yields once the oldest claimable body has waited this long. */
export const WAKE_QUIET_MAX_MS = 600_000;
/** A started attempt without an outcome becomes unknown after this; longer than any adapter call timeout. */
export const WAKE_START_TIMEOUT_MS = 60_000;
/** Upper bound of the resend delay and the retention of ended attempt rows. */
export const WAKE_RESEND_MAX_MS = 86_400_000;
/** Consecutive transient failures of one birth after which the path is reported degraded. */
export const WAKE_FAILURE_LIMIT = 5;
const WAKE_ENDED_ROW_LIMIT = 1000;
const MESSAGE_SCHEMA_VERSION = 4;
/** Default time argument: the store samples its clock after BEGIN IMMEDIATE. An explicit number is a fixture time. */
export const AUTHORITY_NOW = Number.NaN;
/** A granted relay must heartbeat within this window; until then the grant holds the lease and keeps the birth online. */
export const RELAY_START_GRACE_MS = 30_000;
/** Peer-wait repeat suppression (2.6.0 policy) records, shared by every process of this state directory. */
const PEER_WAIT_SNAPSHOT_LIMIT = 1000;
const PEER_WAIT_RESUME_WINDOW_MS = 30_000;
/** Schema 4: the holder is a random relay_id issued per grant, never reused, so it fences a replaced relay. No PID. */
const RELAY_LEASES_TABLE = `(
  host TEXT NOT NULL, session_id TEXT NOT NULL, transport TEXT NOT NULL, instance_id TEXT NOT NULL, relay_id TEXT NOT NULL,
  code_digest TEXT, granted_at TEXT NOT NULL, lease_until TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (host, session_id, transport)
) STRICT`;
const ACTIVE_WAKE_STATE_LIST: readonly string[] = ["reserved", "started", "handed-off", "unknown"];
const ACTIVE_WAKE_STATES = `(${ACTIVE_WAKE_STATE_LIST.map((state) => `'${state}'`).join(", ")})`;
const WAKE_NONCES_TABLE = `(
  nonce_digest TEXT PRIMARY KEY, host TEXT NOT NULL, session_id TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'started', 'handed-off', 'unknown', 'observed', 'released', 'not-delivered')),
  release_reason TEXT CHECK (release_reason IN ('expired', 'claimed-after-handoff', 'birth-ended', 'resend-due', 'migrated')),
  nonce TEXT, instance_id TEXT, birth_generation TEXT, transport TEXT, relay_id TEXT, attempt_id TEXT,
  dispatch_epoch INTEGER NOT NULL DEFAULT 0, started_at TEXT, outcome_at TEXT, observed_at TEXT, late_observed_at TEXT,
  released_at TEXT, resend_base_ms INTEGER, resend_due_at TEXT
) STRICT`;
const WAKE_COPY_COLUMNS = ["nonce_digest", "host", "session_id", "expires_at", "consumed_at", "state", "nonce", "instance_id",
  "birth_generation", "transport", "relay_id", "attempt_id", "dispatch_epoch", "started_at", "outcome_at", "observed_at",
  "late_observed_at", "retired_at"] as const;
const resendDelay = (baseMs: number, streak: number): number => Math.min(baseMs * 2 ** streak, WAKE_RESEND_MAX_MS);
function assertResendBase(resendBaseMs: number): void {
  if (!Number.isSafeInteger(resendBaseMs) || resendBaseMs < 1 || resendBaseMs > WAKE_RESEND_MAX_MS) throw new SessionMessageError(msg("services.sessionMessage.wake.resendBaseInvalid", {}));
}
export const PRESENCE_LEASE_MS = 20_000;
/** Ended or lapsed presence rows stay this long after their lease end (message-broker housekeeping). */
export const PRESENCE_RETENTION_MS = 24 * 3600_000;
/** The session board lists a lapsed, not ended birth this long after its lease ended (its relay may have died alone). */
export const PRESENCE_UNREACHABLE_VISIBLE_MS = 10 * 60_000;
/** Byte budget of the board's presence list, below the broker response limit. */
export const CURRENT_PRESENCE_MAX_BYTES = SESSION_MESSAGE_MAX_RESPONSE_BYTES - 4096;
const CLAIM_MAX_MESSAGES = 10;

export interface SessionIdentity {
  host: string;
  sessionId: string;
}

export interface SessionMessage {
  messageId: string;
  sender: SessionIdentity;
  recipient: SessionIdentity;
  body: string;
  createdAt: string;
  expiresAt: string;
  deliveryAttempt: number;
  firstDeliveredAt: string | null;
  /** 이 인수 회차의 불투명 영수증. 이전 형식의 역사 행에는 없을 수 있다. */
  claimReceipt?: string;
}

export interface MessageClaimReceipt {
  messageId: string;
  claimReceipt: string;
}

export type WakeVisibility = "silent" | "user-message" | "none";
export type SessionPresenceState = "online" | "unreachable" | "ended" | "unknown";

export interface SessionPresence {
  host: string;
  sessionId: string;
  instanceId: string | null;
  transport: string | null;
  wakeVisibility: WakeVisibility;
  canWakeSilently: boolean;
  deliveryCapabilities: DeliveryCapabilities;
  collaborationId: string | null;
  workspaceId: string | null;
  role: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  leaseUntil: string | null;
  endedAt: string | null;
  endReason: string | null;
  state: SessionPresenceState;
  /** The current birth is online and its transport's relay lease is live. */
  relayLive: boolean;
}

/** Compact presence row of the session board: the current birth of one session. */
export interface CurrentPresence {
  host: string;
  sessionId: string;
  state: SessionPresenceState;
  startedAt: string | null;
  heartbeatAt: string | null;
  leaseUntil: string | null;
  workspaceId: string | null;
  transport: string | null;
  autoWake: SessionAutoWakeOutlookV2;
}

/** Board and service view; autoWake is absent or null only when a previous broker did not report it. */
export type SessionPresenceView = SessionPresence & {
  autoWake?: SessionAutoWakeOutlookV2 | null;
  /** Advisory entry-file identity; absent on older brokers, never proof of runtime replacement. */
  relayCode?: { status: "current" | "outdated" | "unknown"; runningDigest: string | null; expectedDigest: string | null };
};

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function nonceDigest(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

function boundedIdentity(value: SessionIdentity): void {
  if (!isBoundedIdentity(value)) throw new SessionMessageError(msg("services.sessionMessage.identity.unbounded", {}));
}

function claimedMessage(
  row: Record<string, unknown>,
  deliveryAttempt = Number(row.delivery_attempts),
  firstDeliveredAt = row.first_delivered_at === null ? null : String(row.first_delivered_at),
): SessionMessage {
  return {
    messageId: String(row.message_id),
    sender: { host: String(row.sender_host), sessionId: String(row.sender_session_id) },
    recipient: { host: String(row.target_host), sessionId: String(row.target_session_id) },
    body: String(row.body),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    deliveryAttempt,
    firstDeliveredAt,
  };
}

function claimResponseBytes(messages: SessionMessage[]): number {
  return Buffer.byteLength(JSON.stringify({ ok: true, data: { messages } }), "utf8") + 1;
}

export interface WakeRelayBinding extends SessionIdentity {
  instanceId: string;
  transport: string;
  relayId: string;
}
export interface WakeAttempt extends WakeRelayBinding {
  nonce: string;
  generation: string;
  attemptId: string;
  dispatchEpoch: number;
}
export interface WakeReservation {
  dispatch: boolean;
  attempt: WakeAttempt | null;
}
type WakePathKey = SessionIdentity & { instanceId: string; generation: string };
export type ManagedWakeState = "reserved" | "started" | "handed-off" | "unknown" | "observed" | "released" | "not-delivered";

export interface MessageCapacityDetails {
  scope: "sender" | "global";
  earliestReleaseAt: string | null;
}

/** A capacity rejection rolls back its transaction: nothing was queued or drafted. */
export class MessageCapacityError extends SessionMessageError {
  readonly details: MessageCapacityDetails;

  constructor(message: MessageRef, details: MessageCapacityDetails) {
    super(message);
    this.name = "MessageCapacityError";
    this.details = details;
  }
}

export interface ClaimLimits {
  maxMessages?: number;
  maxBodyChars?: number;
  /** Adapter-observed host process generation; never a model-supplied authorization. */
  instanceId?: string;
}

/** Why a relay grant was refused; diagnostic only, never an authority input. */
export type RelayGrantRefusal = "GENERATION_CHANGED" | "GENERATION_SUPERSEDED" | "CURRENT_GENERATION_PROTECTED" | "HOST_MISMATCH"
  | "RELAY_ALIVE" | "PRESENCE_NOT_ONLINE";
export type RelayGrant = { relayId: string; reason?: undefined } | { relayId: null; reason: RelayGrantRefusal };
export interface PeerWaitSnapshotRecord { owner: string; fingerprint: string; expiresAt: number }
/** Storage port of PeerWaitPolicy: the store keeps records durable across short-lived hook and CLI processes. */
export interface PeerWaitSnapshotStore {
  now(): number;
  get(key: string): PeerWaitSnapshotRecord | undefined;
  set(key: string, record: PeerWaitSnapshotRecord): void;
  resetOwner(owner: string): void;
}

export class SessionMessageStore<Input extends string | SharedModuleContext = string> {
  readonly database: Input extends string ? DatabaseSync : SqlDatabase;
  private readonly shared: SharedModuleContext | undefined;
  private readonly clock: () => number;
  /** Standalone authority time, sampled once per outermost transaction after BEGIN IMMEDIATE (D0031/D0060). */
  private transactionNow: number | undefined;
  private savepoints = 0;

  /** clock is a fixture input; production reads Date.now() only under the writer lock. */
  constructor(input: Input, options: { clock?: () => number; busyTimeoutMs?: number } = {}) {
    this.shared = typeof input === "string" ? undefined : input;
    this.clock = options.clock ?? Date.now;
    const databasePath = typeof input === "string" ? input : input.databasePath;
    if (!this.shared && databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
    this.database = (this.shared?.database ?? new DatabaseSync(databasePath)) as Input extends string ? DatabaseSync : SqlDatabase;
    if (!this.shared) {
      try {
        // receipts and ACKs must survive power loss; a per-call busy wait is set by the in-process client.
        this.database.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}; PRAGMA synchronous = FULL;`);
        const storedVersion = (this.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
        if (storedVersion > MESSAGE_SCHEMA_VERSION) throw new SessionMessageError(msg("services.sessionMessage.store.schemaNewer", { version: storedVersion }));
        if (databasePath !== ":memory:") {
          // Several processes share this file. A file system without WAL shared memory is refused, never silently downgraded.
          const mode = (this.database.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string }).journal_mode;
          if (mode !== "wal") throw tagProducerFailure(new SessionMessageError(msg("services.sessionMessage.store.walUnsupported", {})), "MESSAGING_STATE_UNSUPPORTED");
        }
        // D0059: a current file opens without a write lock; otherwise the version is read again under the lock below.
        if (storedVersion === MESSAGE_SCHEMA_VERSION) return;
      } catch (error) {
        this.database.close();
        throw error;
      }
    }
    const initialize = () => this.transaction(() => {
      const version = (this.shared?.getSchemaVersion() ?? (this.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
      if (version > MESSAGE_SCHEMA_VERSION) throw new SessionMessageError(msg("services.sessionMessage.store.schemaNewer", { version }));
      if (!this.shared) this.database.exec("CREATE TABLE IF NOT EXISTS authority_time (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), last_ms INTEGER NOT NULL) STRICT; INSERT OR IGNORE INTO authority_time VALUES (1, 0);");
      this.database.exec(`CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        sender_host TEXT NOT NULL,
        sender_session_id TEXT NOT NULL,
        target_host TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        body TEXT NOT NULL,
        body_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        claimed_at TEXT,
        claim_until TEXT,
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        first_delivered_at TEXT,
        acknowledged_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS messages_target_pending
        ON messages (target_host, target_session_id, acknowledged_at, expires_at, claim_until);
      CREATE TABLE IF NOT EXISTS relay_leases ${RELAY_LEASES_TABLE};
      CREATE TABLE IF NOT EXISTS wake_nonces ${WAKE_NONCES_TABLE};
      CREATE TABLE IF NOT EXISTS session_presence (
        host TEXT NOT NULL,
        session_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        wake_visibility TEXT NOT NULL CHECK (wake_visibility IN ('silent', 'user-message', 'none')),
        can_wake_silently INTEGER NOT NULL CHECK (can_wake_silently IN (0, 1)),
        supported_injection TEXT NOT NULL DEFAULT '[]',
        idle_wake TEXT NOT NULL DEFAULT 'none' CHECK (idle_wake IN ('silent', 'user-message', 'none')),
        collaboration_id TEXT,
        workspace_id TEXT,
        role TEXT,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        lease_until TEXT NOT NULL,
        ended_at TEXT,
        end_reason TEXT,
        PRIMARY KEY (host, session_id, instance_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS session_presence_latest
        ON session_presence (host, session_id, started_at DESC);`);
      this.database.exec(`CREATE TABLE IF NOT EXISTS prepared_messages (
        message_id TEXT PRIMARY KEY,
        sender_host TEXT NOT NULL,
        sender_session_id TEXT NOT NULL,
        target_host TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        body TEXT,
        ttl_seconds INTEGER NOT NULL,
        prepared_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        receipt TEXT,
        record_bytes INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS prepared_messages_expiry ON prepared_messages (expires_at);
      CREATE INDEX IF NOT EXISTS prepared_messages_owner ON prepared_messages (sender_host, sender_session_id, receipt);`);
      const messageColumns = this.database.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      if (!messageColumns.some((column) => column.name === "delivery_attempts")) {
        this.database.exec("ALTER TABLE messages ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;");
      }
      if (!messageColumns.some((column) => column.name === "first_delivered_at")) {
        this.database.exec("ALTER TABLE messages ADD COLUMN first_delivered_at TEXT;");
      }
      if (!messageColumns.some(column => column.name === "legacy_claim_attempt")) {
        this.database.exec("ALTER TABLE messages ADD COLUMN legacy_claim_attempt INTEGER NOT NULL DEFAULT 0;");
        // 이전 때 이미 인수된 회차만 보존한다. 대기 행과 이후 재인수는 이 상한을 넘을 수 없다.
        this.database.exec("UPDATE messages SET legacy_claim_attempt = delivery_attempts WHERE claimed_at IS NOT NULL;");
      }
      if (!messageColumns.some(column => column.name === "claim_receipt")) {
        this.database.exec(`ALTER TABLE messages ADD COLUMN claim_receipt TEXT
          CHECK ((claim_receipt IS NULL AND delivery_attempts <= legacy_claim_attempt) OR (claim_receipt IS NOT NULL AND delivery_attempts > 0
            AND substr(claim_receipt, 1, instr(claim_receipt, ':') - 1) = CAST(delivery_attempts AS TEXT)));`);
      }
      if (!messageColumns.some(column => column.name === "acknowledgement_receipt")) {
        // 기존 연결의 구 SQL도 새 회차를 영수증 없이 확정할 수 없게 한다.
        this.database.exec(`ALTER TABLE messages ADD COLUMN acknowledgement_receipt TEXT
          CHECK (acknowledged_at IS NULL OR claim_receipt IS NULL
            OR coalesce(acknowledgement_receipt = claim_receipt, 0));`);
      }
      const presenceColumns = this.database.prepare("PRAGMA table_info(session_presence)").all() as Array<{ name: string }>;
      if (!presenceColumns.some((column) => column.name === "supported_injection")) {
        this.database.exec("ALTER TABLE session_presence ADD COLUMN supported_injection TEXT NOT NULL DEFAULT '[]';");
      }
      if (!presenceColumns.some((column) => column.name === "idle_wake")) {
        this.database.exec("ALTER TABLE session_presence ADD COLUMN idle_wake TEXT NOT NULL DEFAULT 'none';");
        this.database.exec("UPDATE session_presence SET idle_wake = wake_visibility;");
      }
      for (const [name, definition] of [["superseded_at", "TEXT"], ["host_pid", "INTEGER"], ["host_start", "TEXT"]]) {
        if (!presenceColumns.some(column => column.name === name)) this.database.exec(`ALTER TABLE session_presence ADD COLUMN ${name} ${definition};`);
      }
      this.database.exec(`CREATE TABLE IF NOT EXISTS input_observations (
        host TEXT NOT NULL,
        session_id TEXT NOT NULL,
        deferred_tool_claim INTEGER NOT NULL DEFAULT 0 CHECK (deferred_tool_claim IN (0, 1)),
        observed_at TEXT NOT NULL,
        PRIMARY KEY (host, session_id)
      ) STRICT;`);
      // One wake path state per host birth (2.3): the same key as the arrival binding check.
      this.database.exec(`CREATE TABLE IF NOT EXISTS wake_paths (
        host TEXT NOT NULL, session_id TEXT NOT NULL, instance_id TEXT NOT NULL, birth_generation TEXT NOT NULL,
        streak INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, last_failure_at TEXT, retry_not_before TEXT,
        prerequisite_missing TEXT, claim_boundary_at TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (host, session_id, instance_id, birth_generation)
      ) STRICT;`);
      // Schema 3 (AGS 3.0 doorbell): SQLite cannot rewrite a CHECK or DEFAULT in place, so wake_nonces is rebuilt once in
      // this transaction. Legacy rows are dropped, states are renamed and every migrated hand-off gets a resend deadline,
      // so no migrated row stays active forever. Columns an older shape lacks read as NULL (state as legacy).
      if (version < 3) {
        // Only rows to migrate need a time: a fresh file observes (and needs) no clock while it initializes.
        const migrating = this.database.prepare("SELECT 1 FROM wake_nonces LIMIT 1").get() !== undefined;
        const migratedAt = migrating ? iso(this.time(AUTHORITY_NOW)) : null;
        const existing = new Set((this.database.prepare("PRAGMA table_info(wake_nonces)").all() as Array<{ name: string }>).map((column) => column.name));
        const source = WAKE_COPY_COLUMNS.map((name) => existing.has(name) ? name
          : `${name === "state" ? "'legacy'" : name === "dispatch_epoch" ? "0" : "NULL"} AS ${name}`).join(", ");
        const handed = "next_state IN ('handed-off', 'unknown')";
        this.database.exec(`DROP INDEX IF EXISTS wake_active_target; CREATE TABLE wake_nonces_next ${WAKE_NONCES_TABLE};`);
        this.database.prepare(`INSERT INTO wake_nonces_next (rowid, nonce_digest, host, session_id, expires_at, consumed_at, state,
            release_reason, nonce, instance_id, birth_generation, transport, relay_id, attempt_id, dispatch_epoch, started_at, outcome_at,
            observed_at, late_observed_at, released_at, resend_base_ms, resend_due_at)
          SELECT old_rowid, nonce_digest, host, session_id, expires_at, consumed_at, next_state,
            CASE WHEN next_state = 'released' THEN 'migrated' END, nonce, instance_id, birth_generation,
            CASE WHEN transport = 'gemini-queue' THEN 'antigravity-queue' ELSE transport END, relay_id, attempt_id, dispatch_epoch, started_at,
            CASE WHEN ${handed} THEN coalesce(outcome_at, started_at, ?1) ELSE outcome_at END, observed_at, late_observed_at,
            CASE WHEN next_state = 'released' THEN coalesce(retired_at, ?1) ELSE retired_at END,
            CASE WHEN ${handed} THEN 600000 END,
            CASE WHEN ${handed} THEN strftime('%Y-%m-%dT%H:%M:%fZ', coalesce(outcome_at, started_at, ?1), '+600 seconds') END
          FROM (SELECT *, CASE state WHEN 'submitted' THEN 'handed-off' WHEN 'not-submitted' THEN 'not-delivered'
              WHEN 'expired-unobserved' THEN 'released' WHEN 'started' THEN 'unknown'
              WHEN 'unknown' THEN CASE WHEN late_observed_at IS NULL THEN 'unknown' ELSE 'released' END ELSE state END AS next_state
            FROM (SELECT rowid AS old_rowid, ${source} FROM wake_nonces)) WHERE next_state <> 'legacy'`).run(migratedAt);
        this.database.exec("DROP TABLE wake_nonces;");
        this.database.exec("ALTER TABLE wake_nonces_next RENAME TO wake_nonces;");
        this.database.exec("UPDATE session_presence SET transport = 'antigravity-queue' WHERE transport = 'gemini-queue';");
        this.database.exec("UPDATE relay_leases SET transport = 'antigravity-queue' WHERE transport = 'gemini-queue';");
        this.database.exec("DROP TABLE IF EXISTS session_activity;");
        this.database.prepare(`INSERT OR IGNORE INTO wake_paths (host, session_id, instance_id, birth_generation, updated_at)
          SELECT DISTINCT host, session_id, instance_id, birth_generation, ? FROM wake_nonces
          WHERE state IN ${ACTIVE_WAKE_STATES} AND instance_id IS NOT NULL AND birth_generation IS NOT NULL`).run(migratedAt);
      }
      this.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS wake_active_target ON wake_nonces (host, session_id)
        WHERE state IN ${ACTIVE_WAKE_STATES};`);
      // Schema 4 (AGS 3.0 broker removal): leases are transient and every relay restarts after the 3.0 install, so the
      // PID-bound lease table is rebuilt empty. Presence loses its PID/start-token proof columns.
      const leaseColumns = new Set((this.database.prepare("PRAGMA table_info(relay_leases)").all() as Array<{ name: string }>).map((column) => column.name));
      if (leaseColumns.has("pid") || !leaseColumns.has("instance_id")) {
        this.database.exec(`DROP TABLE relay_leases; CREATE TABLE relay_leases ${RELAY_LEASES_TABLE};`);
      }
      const presenceNow = new Set((this.database.prepare("PRAGMA table_info(session_presence)").all() as Array<{ name: string }>).map((column) => column.name));
      for (const column of ["verified_parent_pid", "verified_parent_token", "reported_parent_pid", "reported_parent_token"]) {
        if (presenceNow.has(column)) this.database.exec(`ALTER TABLE session_presence DROP COLUMN ${column};`);
      }
      this.database.exec(`CREATE TABLE IF NOT EXISTS peer_wait_snapshots (
        query_key TEXT PRIMARY KEY, owner_key TEXT NOT NULL, fingerprint TEXT NOT NULL, expires_at TEXT NOT NULL
      ) STRICT;`);
      if (this.shared) this.shared.setSchemaVersion(MESSAGE_SCHEMA_VERSION);
      else if (version < MESSAGE_SCHEMA_VERSION) this.database.exec(`PRAGMA user_version = ${MESSAGE_SCHEMA_VERSION};`);
    });
    if (this.shared) { this.shared.initialize(initialize); return; }
    try { initialize(); } catch (error) { this.database.close(); throw error; }
  }

  close(): void {
    this.database.close();
  }

  prune(nowMs = AUTHORITY_NOW): void {
    if (!this.inTransaction) return this.transaction(() => this.prune(nowMs));
    nowMs = this.time(nowMs);
    const now = iso(nowMs);
    const acknowledgedBefore = iso(nowMs - 3600_000);
    // Reuse the already-admitted message row as the ACK slot. Only receipt-backed public
    // messages outlive their payload TTL; receipt limits/deadlines bound these metadata rows.
    this.database.prepare(`DELETE FROM messages WHERE (acknowledged_at IS NOT NULL AND acknowledged_at <= ?)
      OR (expires_at <= ? AND (acknowledged_at IS NULL OR NOT EXISTS (
        SELECT 1 FROM prepared_messages p WHERE p.message_id = messages.message_id AND p.receipt IS NOT NULL
          AND p.sender_host = messages.sender_host AND p.sender_session_id = messages.sender_session_id
          AND p.target_host = messages.target_host AND p.target_session_id = messages.target_session_id AND p.expires_at > ?)))`)
      .run(acknowledgedBefore, now, now);
    this.database.prepare("UPDATE messages SET body = '', body_bytes = 0 WHERE acknowledged_at IS NOT NULL AND expires_at <= ?")
      .run(now);
    this.database.prepare("DELETE FROM relay_leases WHERE lease_until <= ?").run(now);
    this.settleWakes(nowMs);
    // Ended rows stay recognizable for WAKE_RESEND_MAX_MS, at most WAKE_ENDED_ROW_LIMIT rows (2.7).
    const endedAt = "coalesce(released_at, observed_at, outcome_at, started_at, expires_at)";
    this.database.prepare(`DELETE FROM wake_nonces WHERE state NOT IN ${ACTIVE_WAKE_STATES} AND ${endedAt} <= ?`)
      .run(iso(nowMs - WAKE_RESEND_MAX_MS));
    this.database.prepare(`DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_digest FROM wake_nonces
      WHERE state NOT IN ${ACTIVE_WAKE_STATES} ORDER BY ${endedAt} DESC LIMIT -1 OFFSET ?)`).run(WAKE_ENDED_ROW_LIMIT);
    // A path outlives its attempts while its birth is the latest unended presence row, so a lapsed relay lease
    // does not reset the streak (I8); a replaced or ended birth without an active attempt is dropped.
    this.database.prepare(`DELETE FROM wake_paths WHERE NOT EXISTS (SELECT 1 FROM wake_nonces w WHERE w.host = wake_paths.host
        AND w.session_id = wake_paths.session_id AND w.instance_id = wake_paths.instance_id
        AND w.birth_generation = wake_paths.birth_generation AND w.state IN ${ACTIVE_WAKE_STATES})
      AND NOT coalesce((SELECT latest.ended_at IS NULL AND latest.instance_id = wake_paths.instance_id
          AND latest.started_at = wake_paths.birth_generation FROM session_presence latest
        WHERE latest.host = wake_paths.host AND latest.session_id = wake_paths.session_id AND latest.superseded_at IS NULL
        ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1), 0)`).run();
    this.database.prepare("DELETE FROM prepared_messages WHERE expires_at <= ?").run(now);
    // Only rows whose lease ended before the retention window go; a live row's lease is always in the future. The
    // identity's latest row also stays while another row of it is live, so a live identity's presence and retirement read
    // the same row. Without a live row, deleting the latest row can surface an earlier one or leave the identity unknown.
    this.database.prepare(`DELETE FROM session_presence WHERE lease_until <= ?
      AND NOT (EXISTS (SELECT 1 FROM session_presence live WHERE live.host = session_presence.host
          AND live.session_id = session_presence.session_id AND live.ended_at IS NULL AND live.lease_until > ?)
        AND session_presence.rowid = (SELECT latest.rowid FROM session_presence latest WHERE latest.host = session_presence.host
          AND latest.session_id = session_presence.session_id AND latest.superseded_at IS NULL ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1))`)
      .run(iso(nowMs - PRESENCE_RETENTION_MS), now);
  }

  /**
   * Ends active attempts (2.2, 2.6). reserved: expired -> released(expired); a replaced birth or no claimable body left ->
   * not-delivered (no external effect). started: only the start timeout makes it unknown, with outcome_at and
   * resend_due_at. handed-off/unknown: released by a later claim boundary, the end of its birth, or its resend deadline.
   * Every UPDATE re-checks the state, so an ended row never reopens (I11).
   */
  private settleWakes(nowMs: number): void {
    const now = iso(nowMs);
    const rows = this.database.prepare(`SELECT * FROM wake_nonces WHERE state IN ${ACTIVE_WAKE_STATES}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const digest = String(row.nonce_digest);
      const target = { host: String(row.host), sessionId: String(row.session_id) };
      const attempt = this.wakeAttempt(row);
      if (row.state === "reserved") {
        if (String(row.expires_at) <= now) {
          this.database.prepare(`UPDATE wake_nonces SET state = 'released', release_reason = 'expired', released_at = ?
            WHERE nonce_digest = ? AND state = 'reserved'`).run(now, digest);
        } else if (this.wakeGenerationReplaced(attempt, nowMs) || !this.wakeClaimable(target, nowMs)) {
          this.database.prepare("UPDATE wake_nonces SET state = 'not-delivered', outcome_at = ? WHERE nonce_digest = ? AND state = 'reserved'")
            .run(now, digest);
        }
        continue;
      }
      const path = this.wakePath(attempt);
      if (row.state === "started") {
        if (String(row.started_at) > iso(nowMs - WAKE_START_TIMEOUT_MS)) continue;
        row.outcome_at = now;
        row.resend_due_at = iso(nowMs + resendDelay(Number(row.resend_base_ms), Number(path?.streak ?? 0)));
        this.database.prepare("UPDATE wake_nonces SET state = 'unknown', outcome_at = ?, resend_due_at = ? WHERE nonce_digest = ? AND state = 'started'")
          .run(now, String(row.resend_due_at), digest);
      }
      const presence = this.presence(target, nowMs);
      const liveBirth = presence.state === "online" && presence.instanceId === row.instance_id && presence.startedAt === row.birth_generation;
      const reason = typeof path?.claim_boundary_at === "string" && path.claim_boundary_at > String(row.outcome_at) ? "claimed-after-handoff"
        : !liveBirth ? "birth-ended" : String(row.resend_due_at) <= now ? "resend-due" : null;
      if (!reason) continue;
      const released = this.database.prepare(`UPDATE wake_nonces SET state = 'released', release_reason = ?, released_at = ?
        WHERE nonce_digest = ? AND state IN ('handed-off', 'unknown')`).run(reason, now, digest).changes === 1;
      // birth-ended keeps the streak; the path outlives row deletion, so only these two change it (2.6).
      if (released && reason !== "birth-ended") {
        this.updateWakePath(attempt, reason === "resend-due" ? "streak = streak + 1" : "streak = 0", [], nowMs);
      }
    }
  }

  private wakePath(key: WakePathKey): Record<string, unknown> | undefined {
    return this.database.prepare("SELECT * FROM wake_paths WHERE host = ? AND session_id = ? AND instance_id = ? AND birth_generation = ?")
      .get(key.host, key.sessionId, key.instanceId, key.generation) as Record<string, unknown> | undefined;
  }

  /** Upserts the birth's path (a new birth starts at zero) and applies one assignment list. */
  private updateWakePath(key: WakePathKey, assignments: string, values: Array<string | number | null>, nowMs: number): void {
    this.database.prepare(`INSERT INTO wake_paths (host, session_id, instance_id, birth_generation, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (host, session_id, instance_id, birth_generation) DO UPDATE SET updated_at = excluded.updated_at`)
      .run(key.host, key.sessionId, key.instanceId, key.generation, iso(nowMs));
    if (assignments) this.database.prepare(`UPDATE wake_paths SET ${assignments}
      WHERE host = ? AND session_id = ? AND instance_id = ? AND birth_generation = ?`)
      .run(...values, key.host, key.sessionId, key.instanceId, key.generation);
  }

  /**
   * A real claim boundary of the current live birth (2.3): claimTurnEnd, claimHostWake, claim and an unskipped
   * claimDeferred. The MCP claim tool has no hook instance check, so without a live birth nothing is written.
   */
  private markClaimBoundary(target: SessionIdentity, nowMs: number): void {
    const presence = this.presence(target, nowMs);
    if (presence.state !== "online" || presence.instanceId === null || presence.startedAt === null) return;
    this.updateWakePath({ ...target, instanceId: presence.instanceId, generation: presence.startedAt },
      "claim_boundary_at = max(coalesce(claim_boundary_at, ''), ?)", [iso(nowMs)], nowMs);
  }

  /**
   * 3.5.2: a prompt or a wake of this birth started a turn whose end has not run (observeNativeInput or claimHostWake,
   * cleared by claimTurnEnd and clearDeferred). A host that reports no prompt or turn end never opens one.
   */
  private openTurnSince(key: WakePathKey): string | null {
    const row = this.database.prepare("SELECT observed_at FROM input_observations WHERE host = ? AND session_id = ?")
      .get(key.host, key.sessionId) as { observed_at: string } | undefined;
    return row !== undefined && row.observed_at >= key.generation ? row.observed_at : null;
  }

  /**
   * Reserve/start gates 4 and 5 (2.5): no prerequisite loss, backoff over, and quiet unless a body waited too long.
   * Quiet is a recent claim boundary or an open turn: a marker rung into a running turn reaches the host after that
   * turn's own boundary took the body, as an empty wake (3.5.2).
   */
  // ponytail: a turn ended without a turn-end hook (an interrupt) stays open until the oldest body waited WAKE_QUIET_MAX_MS.
  private wakePathOpen(key: WakePathKey, nowMs: number): boolean {
    const path = this.wakePath(key);
    if (path && (path.prerequisite_missing !== null || (path.retry_not_before !== null && String(path.retry_not_before) > iso(nowMs)))) return false;
    const recentBoundary = path?.claim_boundary_at != null && String(path.claim_boundary_at) >= iso(nowMs - WAKE_QUIET_MS);
    if (!recentBoundary && this.openTurnSince(key) === null) return true;
    const now = iso(nowMs);
    const oldest = this.database.prepare(`SELECT min(created_at) AS oldest FROM messages WHERE target_host = ? AND target_session_id = ?
      AND acknowledged_at IS NULL AND expires_at > ? AND (claim_until IS NULL OR claim_until <= ?)`)
      .get(key.host, key.sessionId, now, now) as { oldest: string | null };
    return oldest.oldest !== null && oldest.oldest <= iso(nowMs - WAKE_QUIET_MAX_MS);
  }

  /** Sender quota first, then the global pool; call inside the caller's transaction after prune. */
  private assertReceiptCapacity(sender: SessionIdentity, phase: "prepare" | "submit"): void {
    const owned = this.database.prepare("SELECT count(*) AS count, min(expires_at) AS earliest FROM prepared_messages WHERE receipt IS NOT NULL AND sender_host = ? AND sender_session_id = ?")
      .get(sender.host, sender.sessionId) as { count: number; earliest: string | null };
    if (owned.count >= MESSAGE_SENDER_RECEIPT_LIMIT) {
      throw new MessageCapacityError(phase === "prepare" ? msg("services.sessionMessage.capacity.senderReceiptsFullNoDraft", {})
        : msg("services.sessionMessage.capacity.senderReceiptsFull", {}), { scope: "sender", earliestReleaseAt: owned.earliest });
    }
    const all = this.database.prepare("SELECT count(*) AS count, min(expires_at) AS earliest FROM prepared_messages WHERE receipt IS NOT NULL")
      .get() as { count: number; earliest: string | null };
    if (all.count >= MESSAGE_RECEIPT_LIMIT) {
      throw new MessageCapacityError(phase === "prepare" ? msg("services.sessionMessage.capacity.receiptsFullNoDraft", {})
        : msg("services.sessionMessage.capacity.receiptsFull", {}), { scope: "global", earliestReleaseAt: all.earliest });
    }
  }

  /** Preparation is durable but has no queue, peer-relation or wake effect. */
  prepare(input: { sender: SessionIdentity; target: SessionIdentity; body: string; ttlSeconds?: number }, nowMs = AUTHORITY_NOW): { messageId: string; preparedAt: string; expiresAt: string } {
    boundedIdentity(input.sender);
    boundedIdentity(input.target);
    const ttlSeconds = input.ttlSeconds ?? MESSAGE_TTL_DEFAULT_SECONDS;
    if (typeof input.body !== "string" || !input.body.trim() || Buffer.byteLength(input.body, "utf8") > MESSAGE_BODY_MAX_BYTES) throw new SessionMessageError(msg("services.sessionMessage.message.bodySize", { maxBytes: MESSAGE_BODY_MAX_BYTES }));
    if (input.body.includes("\0")) throw new SessionMessageError(msg("services.sessionMessage.message.bodyNul", {}));
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > MESSAGE_TTL_MAX_SECONDS) throw new SessionMessageError(msg("services.sessionMessage.message.ttlRange", { maxSeconds: MESSAGE_TTL_MAX_SECONDS }));
    if (!this.inTransaction) return this.transaction(() => this.prepare(input, nowMs));
    nowMs = this.time(nowMs);
    const result = { messageId: randomUUID(), preparedAt: iso(nowMs), expiresAt: iso(nowMs + MESSAGE_DRAFT_TTL_MS) };
    const recordBytes = Buffer.byteLength(JSON.stringify({ ...input, ttlSeconds, ...result }), "utf8");
    return this.transaction(() => {
      this.prune(nowMs);
      // Admission only; submitPrepared repeats the authoritative check.
      this.assertReceiptCapacity(input.sender, "prepare");
      const drafts = this.database.prepare("SELECT count(*) AS count FROM prepared_messages WHERE receipt IS NULL").get() as { count: number };
      const owned = this.database.prepare("SELECT count(*) AS count FROM prepared_messages WHERE receipt IS NULL AND sender_host = ? AND sender_session_id = ?").get(input.sender.host, input.sender.sessionId) as { count: number };
      const bytes = this.database.prepare("SELECT coalesce(sum(record_bytes), 0) AS bytes FROM prepared_messages").get() as { bytes: number };
      if (drafts.count >= MESSAGE_DRAFT_LIMIT || owned.count >= MESSAGE_SENDER_DRAFT_LIMIT || bytes.bytes + recordBytes > MESSAGE_ID_RECORD_BYTES_LIMIT) throw new SessionMessageError(msg("services.sessionMessage.capacity.preparationFull", {}));
      this.database.prepare(`INSERT INTO prepared_messages (message_id, sender_host, sender_session_id, target_host, target_session_id, body, ttl_seconds, prepared_at, expires_at, record_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(result.messageId, input.sender.host, input.sender.sessionId, input.target.host, input.target.sessionId, input.body, ttlSeconds, result.preparedAt, result.expiresAt, recordBytes);

      return result;

    });
  }

  /** ID ownership, capacity, queue insert and first receipt share one transaction. */
  submitPrepared(sender: SessionIdentity, messageId: string, nowMs = AUTHORITY_NOW): {
    messageId: string; createdAt: string; expiresAt: string; duplicate: boolean; autoWake: SessionAutoWakeOutlookV2;
  } {
    boundedIdentity(sender);
    if (!this.inTransaction) return this.transaction(() => this.submitPrepared(sender, messageId, nowMs));
    nowMs = this.time(nowMs);
    return this.transaction(() => {
      this.prune(nowMs);
      const row = this.database.prepare("SELECT * FROM prepared_messages WHERE message_id = ? AND sender_host = ? AND sender_session_id = ? AND expires_at > ?")
        .get(messageId, sender.host, sender.sessionId, iso(nowMs)) as Record<string, unknown> | undefined;
      if (!row) throw new SessionMessageError(msg("services.sessionMessage.message.issuedIdUnavailable", {}));
      const target = { host: String(row.target_host), sessionId: String(row.target_session_id) };
      if (row.receipt !== null) {
        const receipt = JSON.parse(String(row.receipt)) as { messageId: string; createdAt: string; expiresAt: string };
        const autoWake = this.autoWakeOutlook(target, nowMs);

        return { ...receipt, duplicate: true, autoWake };
      }
      this.assertReceiptCapacity(sender, "submit");
      const receipt = this.send({ messageId, sender, target, body: String(row.body), ttlSeconds: Number(row.ttl_seconds) }, nowMs);
      const receiptJson = JSON.stringify({ messageId: receipt.messageId, createdAt: receipt.createdAt, expiresAt: receipt.expiresAt });
      const expiresAt = iso(Date.parse(receipt.expiresAt) + MESSAGE_RECEIPT_EXTRA_MS);
      const recordBytes = Buffer.byteLength(JSON.stringify({ messageId, sender, target: { host: row.target_host, sessionId: row.target_session_id }, preparedAt: row.prepared_at, ttlSeconds: row.ttl_seconds, receipt: receiptJson, expiresAt }), "utf8");
      const bytes = this.database.prepare("SELECT coalesce(sum(record_bytes), 0) AS bytes, min(expires_at) AS earliest FROM prepared_messages WHERE message_id <> ?").get(messageId) as { bytes: number; earliest: string | null };
      if (bytes.bytes + recordBytes > MESSAGE_ID_RECORD_BYTES_LIMIT) throw new MessageCapacityError(msg("services.sessionMessage.capacity.receiptsFull", {}), { scope: "global", earliestReleaseAt: bytes.earliest });
      this.database.prepare("UPDATE prepared_messages SET body = NULL, receipt = ?, expires_at = ?, record_bytes = ? WHERE message_id = ?")
        .run(receiptJson, expiresAt, recordBytes, messageId);
      const autoWake = this.autoWakeOutlook(target, nowMs);

      return { ...receipt, autoWake };

    });
  }

  /** Internal queue primitive, also retained for existing-data fixtures; public send uses submitPrepared. */
  send(input: {
    messageId?: string;
    sender: SessionIdentity;
    target: SessionIdentity;
    body: string;
    ttlSeconds?: number;
  }, nowMs = AUTHORITY_NOW): { messageId: string; createdAt: string; expiresAt: string; duplicate: boolean } {
    boundedIdentity(input.sender);
    boundedIdentity(input.target);
    const bodyBytes = Buffer.byteLength(input.body, "utf8");
    if (input.body.includes("\0")) throw new SessionMessageError(msg("services.sessionMessage.message.bodyNul", {}));
    if (!input.body.trim() || bodyBytes > MESSAGE_BODY_MAX_BYTES) throw new SessionMessageError(msg("services.sessionMessage.message.bodySize", { maxBytes: MESSAGE_BODY_MAX_BYTES }));
    const ttlSeconds = input.ttlSeconds ?? MESSAGE_TTL_DEFAULT_SECONDS;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > MESSAGE_TTL_MAX_SECONDS) {
      throw new SessionMessageError(msg("services.sessionMessage.message.ttlRange", { maxSeconds: MESSAGE_TTL_MAX_SECONDS }));
    }
    const messageId = input.messageId ?? randomUUID();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(messageId)) throw new SessionMessageError(msg("services.sessionMessage.message.idShape", {}));
    if (!this.inTransaction) return this.transaction(() => this.send(input, nowMs));
    nowMs = this.time(nowMs);
    this.prune(nowMs);
    const existing = this.database.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId) as Record<string, unknown> | undefined;
    if (existing) {
      const same = existing.sender_host === input.sender.host
        && existing.sender_session_id === input.sender.sessionId
        && existing.target_host === input.target.host
        && existing.target_session_id === input.target.sessionId
        && existing.body === input.body
        && Date.parse(String(existing.expires_at)) - Date.parse(String(existing.created_at)) === ttlSeconds * 1000;
      if (!same) throw new SessionMessageError(msg("services.sessionMessage.message.idTaken", {}));
      return { messageId, createdAt: String(existing.created_at), expiresAt: String(existing.expires_at), duplicate: true };
    }
    const totals = this.database.prepare("SELECT count(*) AS count, coalesce(sum(body_bytes), 0) AS bytes FROM messages WHERE acknowledged_at IS NULL AND expires_at > ?").get(iso(nowMs)) as { count: number; bytes: number };
    if (totals.count >= MESSAGE_LIMIT || totals.bytes + bodyBytes > MESSAGE_BYTES_LIMIT) throw new SessionMessageError(msg("services.sessionMessage.capacity.spoolFull", {}));
    const createdAt = iso(nowMs);
    const expiresAt = iso(nowMs + ttlSeconds * 1000);
    this.database.prepare(`INSERT INTO messages (
      message_id, sender_host, sender_session_id, target_host, target_session_id,
      body, body_bytes, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      messageId, input.sender.host, input.sender.sessionId, input.target.host, input.target.sessionId,
      input.body, bodyBytes, createdAt, expiresAt,
    );
    return { messageId, createdAt, expiresAt, duplicate: false };
  }

  private claimLocked(target: SessionIdentity, nowMs: number, limits: ClaimLimits): SessionMessage[] {
    const maxMessages = limits.maxMessages ?? CLAIM_MAX_MESSAGES;
    const maxBodyChars = limits.maxBodyChars ?? SESSION_MESSAGE_MAX_RESPONSE_BYTES;
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > CLAIM_MAX_MESSAGES) {
      throw new SessionMessageError(msg("services.sessionMessage.claim.maxMessagesRange", { max: CLAIM_MAX_MESSAGES }));
    }
    if (!Number.isInteger(maxBodyChars) || maxBodyChars < 1 || maxBodyChars > SESSION_MESSAGE_MAX_RESPONSE_BYTES) {
      throw new SessionMessageError(msg("services.sessionMessage.claim.maxBodyCharsRange", { max: SESSION_MESSAGE_MAX_RESPONSE_BYTES }));
    }
    const now = iso(nowMs);
    const statement = this.database.prepare(`UPDATE messages SET claimed_at = ?, claim_until = ?, claim_receipt = ?,
      delivery_attempts = delivery_attempts + 1,
      first_delivered_at = CASE WHEN delivery_attempts = 0 THEN COALESCE(first_delivered_at, ?) ELSE first_delivered_at END
      WHERE message_id = ? AND acknowledged_at IS NULL AND (claim_until IS NULL OR claim_until <= ?)`);
    const rows = this.database.prepare(`SELECT * FROM messages
        WHERE target_host = ? AND target_session_id = ? AND acknowledged_at IS NULL
          AND expires_at > ? AND (claim_until IS NULL OR claim_until <= ?)
        ORDER BY created_at ASC LIMIT ?`).all(target.host, target.sessionId, now, now, maxMessages) as Array<Record<string, unknown>>;
    const selected: Array<{ row: Record<string, unknown>; claimReceipt: string }> = [];
    const projected: SessionMessage[] = [];
    let bodyChars = 0;
    for (const row of rows) {
      const attempts = Number(row.delivery_attempts ?? 0);
      const firstDeliveredAt = row.first_delivered_at ? String(row.first_delivered_at) : attempts === 0 ? now : null;
      const claimReceipt = `${attempts + 1}:${randomUUID()}`;
      const message = { ...claimedMessage(row, attempts + 1, firstDeliveredAt), claimReceipt };
      const next = [...projected, message];
      if (bodyChars + message.body.length > maxBodyChars || claimResponseBytes(next) > SESSION_MESSAGE_MAX_RESPONSE_BYTES) {
        if (selected.length === 0) throw new SessionMessageError(msg("services.sessionMessage.claim.budgetExceeded", {}));
        break;
      }
      selected.push({ row, claimReceipt });
      projected.push(message);
      bodyChars += message.body.length;
    }
    return selected.flatMap(({ row, claimReceipt }) => {
      const attempts = Number(row.delivery_attempts ?? 0);
      const leaseMs = Math.min(CLAIM_LEASE_MAX_MS, CLAIM_LEASE_BASE_MS * 2 ** Math.min(attempts, 4));
      const firstDeliveredAt = row.first_delivered_at ? String(row.first_delivered_at) : attempts === 0 ? now : null;
      return statement.run(now, iso(nowMs + leaseMs), claimReceipt, now, String(row.message_id), now).changes === 1
        ? [{ ...claimedMessage(row, attempts + 1, firstDeliveredAt), claimReceipt }]
        : [];
    });
  }

  claim(target: SessionIdentity, nowMs = AUTHORITY_NOW, limits: ClaimLimits = {}): SessionMessage[] {
    boundedIdentity(target);
    if (!this.inTransaction) return this.transaction(() => this.claim(target, nowMs, limits));
    nowMs = this.time(nowMs);
    this.prune(nowMs);
    return this.transaction(() => {
      const claimed = this.claimLocked(target, nowMs, limits);
      this.markClaimBoundary(target, nowMs);
      return claimed;
    });
  }

  /** Check inside the same transaction as claim/deferral mutations, before pruning or activity writes.
   * Legacy presences retain their existing contract; verified births never adopt an unknown hook. */
  private assertHookInstance(target: SessionIdentity, instanceId: string | undefined, nowMs: number): void {
    const current = this.presence(target, nowMs);
    const verifiedBirth = current.instanceId?.startsWith("host-process-v1:")
      || (current.instanceId === null && this.database.prepare(`SELECT 1 FROM relay_leases
        WHERE host = ? AND session_id = ? LIMIT 1`)
        .get(target.host, target.sessionId) !== undefined);
    if ((verifiedBirth || instanceId !== undefined)
      && (!instanceId || current.instanceId !== instanceId || current.endedAt !== null)) {
      throw tagProducerFailure(new SessionMessageError(msg("services.sessionMessage.hook.generationMismatch", {})),
        "SESSION_MESSAGE_HOOK_INSTANCE_MISMATCH");
    }
  }

  observeNativeInput(target: SessionIdentity, nowMs = AUTHORITY_NOW, instanceId?: string): void {
    boundedIdentity(target);
    if (!this.inTransaction) return this.transaction(() => this.observeNativeInput(target, nowMs, instanceId));
    nowMs = this.time(nowMs);
    return this.transaction(() => {
      this.assertHookInstance(target, instanceId, nowMs);
      this.database.prepare(`INSERT INTO input_observations (host, session_id, deferred_tool_claim, observed_at)
        VALUES (?, ?, 1, ?) ON CONFLICT (host, session_id) DO UPDATE SET deferred_tool_claim = 1, observed_at = excluded.observed_at`)
        .run(target.host, target.sessionId, iso(nowMs));
    });
  }

  claimDeferred(target: SessionIdentity, nowMs = AUTHORITY_NOW, limits: ClaimLimits = {}): SessionMessage[] {
    boundedIdentity(target);
    if (!this.inTransaction) return this.transaction(() => this.claimDeferred(target, nowMs, limits));
    nowMs = this.time(nowMs);
    return this.transaction(() => {
      this.assertHookInstance(target, limits.instanceId, nowMs);
      this.prune(nowMs);
      const skipped = this.database.prepare(`UPDATE input_observations SET deferred_tool_claim = 0
        WHERE host = ? AND session_id = ? AND deferred_tool_claim = 1`).run(target.host, target.sessionId).changes === 1;
      if (skipped) return [];
      const messages = this.claimLocked(target, nowMs, limits);
      this.markClaimBoundary(target, nowMs);
      return messages;

    });
  }

  claimTurnEnd(target: SessionIdentity, nowMs = AUTHORITY_NOW, limits: ClaimLimits = {}): SessionMessage[] {
    boundedIdentity(target);
    if (!this.inTransaction) return this.transaction(() => this.claimTurnEnd(target, nowMs, limits));
    nowMs = this.time(nowMs);
    return this.transaction(() => {
      this.assertHookInstance(target, limits.instanceId, nowMs);
      this.prune(nowMs);
      this.database.prepare("DELETE FROM input_observations WHERE host = ? AND session_id = ?").run(target.host, target.sessionId);
      const messages = this.claimLocked(target, nowMs, limits);
      this.markClaimBoundary(target, nowMs);
      return messages;

    });
  }

  /**
   * D0015: a wake-only prompt whose marker claimHostWake did not recognize (unknown, pruned, another birth's or
   * unverifiable) still starts a turn of the hook's generation. Like a tool boundary, the hook instance is the fence, and
   * the bodies are claimed under the same lease, so a concurrent boundary cannot deliver them twice before their ACK.
   * The marker authorizes nothing: no wake row changes (I1, I2). The turn opens as claimHostWake opens it.
   */
  claimWakeInput(target: SessionIdentity, nowMs = AUTHORITY_NOW, limits: ClaimLimits = {}): SessionMessage[] {
    boundedIdentity(target);
    if (!this.inTransaction) return this.transaction(() => this.claimWakeInput(target, nowMs, limits));
    nowMs = this.time(nowMs);
    return this.transaction(() => {
      this.assertHookInstance(target, limits.instanceId, nowMs);
      this.prune(nowMs);
      const messages = this.claimLocked(target, nowMs, limits);
      this.markClaimBoundary(target, nowMs);
      this.database.prepare(`INSERT INTO input_observations (host, session_id, deferred_tool_claim, observed_at) VALUES (?, ?, 0, ?)
        ON CONFLICT (host, session_id) DO UPDATE SET observed_at = excluded.observed_at`)
        .run(target.host, target.sessionId, iso(nowMs));
      return messages;
    });
  }

  clearDeferred(target: SessionIdentity, nowMs = AUTHORITY_NOW, instanceId?: string): void {
    boundedIdentity(target);
    if (!this.inTransaction) return this.transaction(() => this.clearDeferred(target, nowMs, instanceId));
    nowMs = this.time(nowMs);
    return this.transaction(() => {
      this.assertHookInstance(target, instanceId, nowMs);
      this.database.prepare("DELETE FROM input_observations WHERE host = ? AND session_id = ?").run(target.host, target.sessionId);
    });
  }

  acknowledge(target: SessionIdentity, messageIds: string[], nowMs = AUTHORITY_NOW, claims: readonly MessageClaimReceipt[] = []): number {
    boundedIdentity(target);
    if (messageIds.length < 1 || messageIds.length > 50 || messageIds.some((id) => typeof id !== "string" || id.length > 128)) {
      throw new SessionMessageError(msg("services.sessionMessage.acknowledge.messageIdsRange", {}));
    }
    if (!Array.isArray(claims) || claims.length > 50) throw new SessionMessageError(msg("services.sessionMessage.acknowledge.claimsRange", {}));
    const receipts = new Map<string, string>();
    for (const claim of claims) {
      if (!claim || typeof claim.messageId !== "string" || !messageIds.includes(claim.messageId)
        || typeof claim.claimReceipt !== "string" || !/^[1-9][0-9]{0,15}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(claim.claimReceipt)
        || receipts.has(claim.messageId)) throw new SessionMessageError(msg("services.sessionMessage.acknowledge.claimReceiptInvalid", {}));
      receipts.set(claim.messageId, claim.claimReceipt);
    }
    if (!this.inTransaction) return this.transaction(() => this.acknowledge(target, messageIds, nowMs, claims));
    nowMs = this.time(nowMs);
    // 역사 행의 NULL 영수증만 이전 ACK 형식을 유지한다. 새 인수는 회차별 영수증을 요구한다.
    // 임대 만료는 재전달 조건이며, 같은 원소유자의 늦은 ACK를 무효화하지 않는다.
    const statement = this.database.prepare(`UPDATE messages SET acknowledged_at = ?, claim_until = NULL, acknowledgement_receipt = ?
      WHERE message_id = ? AND target_host = ? AND target_session_id = ?
        AND claimed_at IS NOT NULL AND acknowledged_at IS NULL
        AND ((claim_receipt IS NULL AND ? IS NULL) OR claim_receipt = ?)`);
    // Only the first ACK shortens the receipt, and min() never extends it.
    const receipt = this.database.prepare("UPDATE prepared_messages SET expires_at = min(expires_at, ?) WHERE message_id = ? AND receipt IS NOT NULL");
    let count = 0;
    return this.transaction(() => {
      for (const messageId of new Set(messageIds)) {
        const claimReceipt = receipts.get(messageId) ?? null;
        if (statement.run(iso(nowMs), claimReceipt, messageId, target.host, target.sessionId, claimReceipt, claimReceipt).changes !== 1) continue;
        receipt.run(iso(nowMs + MESSAGE_RECEIPT_EXTRA_MS), messageId);
        count++;
      }
      return count;

    });
  }

  status(sender: SessionIdentity, messageId: string, nowMs = AUTHORITY_NOW): Record<string, unknown> | null {
    boundedIdentity(sender);
    if (!this.inTransaction) return this.transaction(() => this.status(sender, messageId, nowMs));
    nowMs = this.time(nowMs);
    this.prune(nowMs);
    const row = this.database.prepare(`SELECT message_id, target_host, target_session_id, created_at, expires_at,
      claimed_at, acknowledged_at, delivery_attempts, first_delivered_at FROM messages WHERE message_id = ? AND sender_host = ? AND sender_session_id = ?`)
      .get(messageId, sender.host, sender.sessionId) as Record<string, unknown> | undefined;
    if (!row) {
      const prepared = this.database.prepare("SELECT prepared_at, expires_at, receipt FROM prepared_messages WHERE message_id = ? AND sender_host = ? AND sender_session_id = ? AND expires_at > ?")
        .get(messageId, sender.host, sender.sessionId, iso(nowMs)) as { prepared_at: string; expires_at: string; receipt: string | null } | undefined;
      if (!prepared) return null;
      return prepared.receipt === null
        ? { messageId, state: "prepared", preparedAt: prepared.prepared_at, expiresAt: prepared.expires_at }
        : { ...JSON.parse(prepared.receipt) as Record<string, unknown>, state: "submitted", deliveryState: "unknown", receiptExpiresAt: prepared.expires_at };
    }
    return {
      messageId: row.message_id,
      target: { host: row.target_host, sessionId: row.target_session_id },
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      claimedAt: row.claimed_at ?? null,
      acknowledgedAt: row.acknowledged_at ?? null,
      deliveryAttempts: Number(row.delivery_attempts),
      firstDeliveredAt: row.first_delivered_at ?? null,
      state: row.acknowledged_at ? "acknowledged" : row.claimed_at ? "delivered" : "queued",
      // Only an attempt this message started (it was pending when the attempt started), or null (3.6.0).
      wake: this.managedWakeStatus({ host: String(row.target_host), sessionId: String(row.target_session_id) }, nowMs,
        { startedFrom: String(row.created_at), startedUntil: row.acknowledged_at === null ? null : String(row.acknowledged_at) }),
      autoWake: row.acknowledged_at ? null : this.autoWakeOutlook({ host: String(row.target_host), sessionId: String(row.target_session_id) }, nowMs),
    };
  }

  /** Metadata only; peer relation is not work completion or permission. */
  peerWaitState(sender: SessionIdentity, target: SessionIdentity, nowMs = AUTHORITY_NOW): { related: boolean; fingerprint: string } {
    boundedIdentity(sender);
    boundedIdentity(target);
    if (!this.inTransaction) return this.transaction(() => this.peerWaitState(sender, target, nowMs));
    nowMs = this.time(nowMs);
    const rows = this.database.prepare(`SELECT message_id, sender_host, sender_session_id, target_host, target_session_id,
      created_at, claimed_at, acknowledged_at, delivery_attempts, first_delivered_at FROM messages
      WHERE expires_at > ? AND ((sender_host = ? AND sender_session_id = ? AND target_host = ? AND target_session_id = ?)
        OR (sender_host = ? AND sender_session_id = ? AND target_host = ? AND target_session_id = ?))
      ORDER BY created_at DESC, message_id DESC LIMIT 20`)
      .all(iso(nowMs), sender.host, sender.sessionId, target.host, target.sessionId, target.host, target.sessionId, sender.host, sender.sessionId);
    return { related: rows.length > 0, fingerprint: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
  }

  /** The live lease of a transport. Its holder is the only relay that may renew it or dispatch for this birth. */
  liveRelay(target: SessionIdentity, transport: string, nowMs = AUTHORITY_NOW): { relayId: string; instanceId: string; codeDigest: string | null; updatedAt: string } | null {
    boundedIdentity(target);
    if (!this.inTransaction) return this.transaction(() => this.liveRelay(target, transport, nowMs));
    nowMs = this.time(nowMs);
    const row = this.database.prepare("SELECT relay_id, instance_id, code_digest, updated_at FROM relay_leases WHERE host = ? AND session_id = ? AND transport = ? AND lease_until > ?")
      .get(target.host, target.sessionId, transport, iso(nowMs)) as { relay_id: string; instance_id: string; code_digest: string | null; updated_at: string } | undefined;
    return row ? { relayId: row.relay_id, instanceId: row.instance_id, codeDigest: row.code_digest, updatedAt: row.updated_at } : null;
  }

  /** Current unverified generation that lost its relay (never acquired or died); null while any relay lease is live. */
  relayRecoveryInstance(target: SessionIdentity, nowMs = AUTHORITY_NOW): string | null {
    if (!this.inTransaction) return this.transaction(() => this.relayRecoveryInstance(target, nowMs));
    const presence = this.presence(target, nowMs);
    if (presence.state !== "unreachable" || !presence.instanceId || !presence.transport
      || presence.instanceId.startsWith("host-process-v1:")) return null;
    return this.liveRelay(target, presence.transport, nowMs) ? null : presence.instanceId;
  }

  /**
   * D0354: the current generation a start event of the same host process keeps instead of replacing (compact, or any
   * start in a process that already runs this session). It is kept only while its own relay serves it: the presence
   * is online and was heartbeated after its start (only that generation's relay can), the reported host PID matches,
   * the relay bound that host's birth, and the relay runs the caller's entry code. Windows keeps the PID from reuse while
   * the relay's host watcher holds its handle; a caller that read the birth (Linux /proc) must match it exactly.
   */
  liveRelayGeneration(input: SessionIdentity & { transport: string; hostPid: number; hostStart?: string; codeDigest: string }, nowMs = AUTHORITY_NOW): string | null {
    boundedIdentity(input);
    relayCodeDigest(input.codeDigest);
    if (!this.inTransaction) return this.transaction(() => this.liveRelayGeneration(input, nowMs));
    nowMs = this.time(nowMs);
    const current = this.presence(input, nowMs);
    if (current.state !== "online" || current.transport !== input.transport || current.instanceId === null
      || current.startedAt === null || current.heartbeatAt === null || Date.parse(current.heartbeatAt) <= Date.parse(current.startedAt)) return null;
    const host = this.presenceHost(input, current.instanceId);
    if (!host || host.pid !== input.hostPid || host.start === null || (input.hostStart !== undefined && host.start !== input.hostStart)) return null;
    const lease = this.liveRelay(input, input.transport, nowMs);
    if (!lease || lease.instanceId !== current.instanceId || lease.codeDigest !== input.codeDigest) return null;
    return current.instanceId;
  }

  /** The host process this generation reported (pid) and the birth its relay bound (start, null until bound). */
  presenceHost(target: SessionIdentity, instanceId: string): { pid: number; start: string | null } | null {
    boundedIdentity(target);
    if (!this.inTransaction) return this.transaction(() => this.presenceHost(target, instanceId));
    const row = this.database.prepare(`SELECT host_pid, host_start FROM session_presence
      WHERE host = ? AND session_id = ? AND instance_id = ?`).get(target.host, target.sessionId, instanceId) as
      { host_pid: number | null; host_start: string | null } | undefined;
    return row && row.host_pid !== null ? { pid: row.host_pid, start: row.host_start } : null;
  }

  /**
   * Advisory view of the recipient's idle auto-wake path (2.8): facts from presence, relay lease, the birth's path and
   * its active attempt, never a prediction. Callers prune first so due releases are visible. It grants nothing and
   * proves no delivery; handed-off is not delivery (I10).
   */
  autoWakeOutlook(target: SessionIdentity, nowMs = AUTHORITY_NOW): SessionAutoWakeOutlookV2 {
    boundedIdentity(target);
    if (!this.inTransaction) return this.transaction(() => this.autoWakeOutlook(target, nowMs));
    nowMs = this.time(nowMs);
    const now = iso(nowMs);
    const outlook = (state: SessionAutoWakeOutlookV2["state"], reason: SessionAutoWakeOutlookV2["reason"], basisAt: unknown): SessionAutoWakeOutlookV2 =>
      ({ state, reason, basisAt: basisAt === null || basisAt === undefined ? null : String(basisAt), checkedAt: now, authorityEffect: "none" });
    const presence = this.presence(target, nowMs);
    if (presence.state === "unknown") return outlook("no-live-relay", "presence-unknown", null);
    const capabilities = presence.deliveryCapabilities;
    if (capabilities.idleWake === "none" || !capabilities.supportedInjection.includes("peer-wake")) return outlook("unsupported", "no-idle-wake", presence.startedAt);
    if (presence.state !== "online") return outlook("no-live-relay", "presence-not-online", presence.endedAt ?? presence.leaseUntil);
    const relay = this.liveRelay(target, presence.transport!, nowMs);
    if (!relay) return outlook("no-live-relay", "relay-lease-missing", presence.heartbeatAt);
    const birth = { ...target, instanceId: presence.instanceId!, generation: presence.startedAt! };
    const path = this.wakePath(birth);
    if (path?.prerequisite_missing != null) return outlook("degraded", "wake-prerequisite-missing", path.last_failure_at ?? now);
    if (Number(path?.failures ?? 0) >= WAKE_FAILURE_LIMIT) return outlook("degraded", "wake-failing", path!.last_failure_at);
    const active = this.database.prepare(`SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AND instance_id = ?
      AND birth_generation = ? AND state IN ${ACTIVE_WAKE_STATES}`).get(target.host, target.sessionId, birth.instanceId, birth.generation) as Record<string, unknown> | undefined;
    if (active?.state === "handed-off" || active?.state === "unknown") {
      return Date.parse(String(active.outcome_at)) + WAKE_OBSERVATION_WINDOW_MS > nowMs
        ? outlook("available", "wake-in-flight", active.outcome_at) : outlook("available", "wake-unanswered", active.resend_due_at);
    }
    if (active) return outlook("available", "wake-in-flight", active.started_at);
    if (path?.retry_not_before != null && String(path.retry_not_before) > now) return outlook("available", "retry-backoff", path.retry_not_before);
    if (path?.claim_boundary_at != null && String(path.claim_boundary_at) > iso(nowMs - WAKE_QUIET_MS)) {
      return outlook("available", "recipient-active", path.claim_boundary_at);
    }
    const openTurn = this.openTurnSince(birth);
    if (openTurn !== null) return outlook("available", "recipient-active", openTurn);
    return outlook("available", "relay-live", relay.updatedAt);
  }

  pendingCount(target: SessionIdentity, nowMs = AUTHORITY_NOW): number {
    boundedIdentity(target);
    if (!this.inTransaction) return this.transaction(() => this.pendingCount(target, nowMs));
    nowMs = this.time(nowMs);
    this.prune(nowMs);
    const now = iso(nowMs);
    const row = this.database.prepare(`SELECT count(*) AS count FROM messages
      WHERE target_host = ? AND target_session_id = ? AND acknowledged_at IS NULL AND expires_at > ?
        AND (claim_until IS NULL OR claim_until <= ?)`)
      .get(target.host, target.sessionId, now, now) as { count: number };
    return row.count;
  }

  /**
   * Issues a fresh, never reused relay_id for the current birth (3.3). Refused while that birth's lease is live and
   * either runs the same entry code or is still inside its start grace; a different installed code replaces it once
   * per grace (D0348). The previous holder is fenced: its next tick, reservation or start no longer matches.
   */
  grantRelay(input: SessionIdentity & { transport: string; instanceId: string; codeDigest: string | null; hostPid?: number }, nowMs = AUTHORITY_NOW): RelayGrant {
    boundedIdentity(input);
    relayCodeDigest(input.codeDigest);
    if (!input.instanceId || input.instanceId.length > 128 || !input.transport || input.transport.length > 64) throw new SessionMessageError(msg("services.sessionMessage.relay.grantIdentityInvalid", {}));
    if (input.hostPid !== undefined && (!Number.isSafeInteger(input.hostPid) || input.hostPid < 1)) throw new SessionMessageError(msg("services.sessionMessage.relay.hostProcessInvalid", {}));
    if (!this.inTransaction) return this.transaction(() => this.grantRelay(input, nowMs));
    nowMs = this.time(nowMs);
    const presence = this.presence(input, nowMs);
    if (presence.instanceId !== input.instanceId || presence.transport !== input.transport || presence.endedAt !== null) return { relayId: null, reason: "GENERATION_CHANGED" };
    const host = this.presenceHost(input, input.instanceId);
    if (input.hostPid !== undefined && host !== null && host.pid !== input.hostPid) return { relayId: null, reason: "HOST_MISMATCH" };
    const lease = this.database.prepare("SELECT * FROM relay_leases WHERE host = ? AND session_id = ? AND transport = ?")
      .get(input.host, input.sessionId, input.transport) as Record<string, unknown> | undefined;
    if (lease && lease.instance_id === input.instanceId && Date.parse(String(lease.lease_until)) > nowMs
      && (lease.code_digest === input.codeDigest || Date.parse(String(lease.granted_at)) + RELAY_START_GRACE_MS > nowMs)) {
      return { relayId: null, reason: "RELAY_ALIVE" };
    }
    const relayId = randomUUID();
    const now = iso(nowMs);
    const until = iso(nowMs + RELAY_START_GRACE_MS);
    this.database.prepare(`INSERT INTO relay_leases (host, session_id, transport, instance_id, relay_id, code_digest, granted_at, lease_until, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (host, session_id, transport) DO UPDATE SET instance_id = excluded.instance_id,
      relay_id = excluded.relay_id, code_digest = excluded.code_digest, granted_at = excluded.granted_at,
      lease_until = excluded.lease_until, updated_at = excluded.updated_at`)
      .run(input.host, input.sessionId, input.transport, input.instanceId, relayId, input.codeDigest, now, until, now);
    // The birth stays online until its relay's first tick; heartbeat_at is not touched so D0354 still sees "never served".
    this.database.prepare(`UPDATE session_presence SET lease_until = max(lease_until, ?)
      WHERE host = ? AND session_id = ? AND instance_id = ? AND ended_at IS NULL AND superseded_at IS NULL`)
      .run(until, input.host, input.sessionId, input.instanceId);
    if (input.hostPid !== undefined && host === null) {
      this.database.prepare("UPDATE session_presence SET host_pid = ? WHERE host = ? AND session_id = ? AND instance_id = ? AND host_pid IS NULL")
        .run(input.hostPid, input.host, input.sessionId, input.instanceId);
    }
    return { relayId };
  }

  /**
   * A verified host birth (adapter-observed pid and start token, e.g. Antigravity) ensures its own generation and relay.
   * Generation rules: an expected-presence mismatch, a superseded own row, or an own row behind another current birth is
   * refused; a live (online) verified current birth is protected from an unexpected replacement. No OS query happens
   * here: the relay's host watcher binds the birth and is fenced if it differs from hostStart.
   */
  ensureVerifiedGeneration(input: Parameters<SessionMessageStore["startPresence"]>[0] & {
    hostPid: number; hostStart: string; codeDigest: string | null; expectedPresenceInstanceId?: string | null;
  }, nowMs = AUTHORITY_NOW): { spawn: boolean; relayId: string | null; instanceId: string; reason?: RelayGrantRefusal } {
    boundedIdentity(input);
    if (!Number.isInteger(input.hostPid) || input.hostPid < 1 || !/^host-process-v1:[0-9a-f]{64}$/u.test(input.instanceId)
      || !input.hostStart.trim() || input.hostStart.length > 200
      || input.instanceId !== "host-process-v1:" + createHash("sha256").update(JSON.stringify([input.host, input.sessionId, input.hostPid, input.hostStart])).digest("hex")) {
      throw new SessionMessageError(msg("services.sessionMessage.relay.hostBirthInvalid", {}));
    }
    if (!this.inTransaction) return this.transaction(() => this.ensureVerifiedGeneration(input, nowMs));
    nowMs = this.time(nowMs);
    const refuse = (reason: RelayGrantRefusal) => ({ spawn: false, relayId: null, instanceId: input.instanceId, reason });
    const current = this.presence(input, nowMs);
    if (input.expectedPresenceInstanceId !== undefined && current.instanceId !== input.expectedPresenceInstanceId) return refuse("GENERATION_CHANGED");
    const ownBirth = this.database.prepare("SELECT superseded_at FROM session_presence WHERE host=? AND session_id=? AND instance_id=?")
      .get(input.host, input.sessionId, input.instanceId) as { superseded_at: string | null } | undefined;
    if (ownBirth?.superseded_at != null) return refuse("GENERATION_SUPERSEDED");
    if (current.instanceId !== null && current.instanceId !== input.instanceId) {
      // A process already superseded by a later registered birth is not a new resume.
      if (ownBirth !== undefined) return refuse("GENERATION_SUPERSEDED");
      const currentHost = this.presenceHost(input, current.instanceId);
      if (current.state === "online" && current.instanceId.startsWith("host-process-v1:") && currentHost?.start != null
        && input.expectedPresenceInstanceId !== current.instanceId) return refuse("CURRENT_GENERATION_PROTECTED");
    }
    if (current.instanceId !== input.instanceId) {
      this.database.prepare("UPDATE session_presence SET superseded_at=? WHERE host=? AND session_id=? AND instance_id<>? AND superseded_at IS NULL")
        .run(iso(nowMs), input.host, input.sessionId, input.instanceId);
    }
    const lease = this.liveRelay(input, input.transport, nowMs);
    if (!(current.instanceId === input.instanceId && current.state === "online" && lease?.instanceId === input.instanceId)) {
      const presence = this.startPresence(input, nowMs);
      if (presence.state !== "online" || presence.instanceId !== input.instanceId || presence.transport !== input.transport) return refuse("PRESENCE_NOT_ONLINE");
    }
    const grant = this.grantRelay({ host: input.host, sessionId: input.sessionId, transport: input.transport, instanceId: input.instanceId,
      codeDigest: input.codeDigest, hostPid: input.hostPid }, nowMs);
    return grant.relayId !== null ? { spawn: true, relayId: grant.relayId, instanceId: input.instanceId } : refuse(grant.reason);
  }

  /** The relay's own end: drop only its lease (its relay_id) and end its own birth, atomically. */
  releaseRelay(input: SessionIdentity & { transport: string; relayId: string; instanceId: string; reason: string }, nowMs = AUTHORITY_NOW): boolean {
    boundedIdentity(input);
    if (!input.relayId || input.relayId.length > 128 || !input.reason || input.reason.length > 100) throw new SessionMessageError(msg("services.sessionMessage.relay.releaseInvalid", {}));
    if (!this.inTransaction) return this.transaction(() => this.releaseRelay(input, nowMs));
    nowMs = this.time(nowMs);
    const removed = this.database.prepare("DELETE FROM relay_leases WHERE host=? AND session_id=? AND transport=? AND relay_id=?")
      .run(input.host, input.sessionId, input.transport, input.relayId).changes === 1;
    const presence = this.presence(input, nowMs);
    if (removed && presence.instanceId === input.instanceId && presence.transport === input.transport) this.endPresence(input, input.reason, input.instanceId, nowMs);
    return removed;
  }

  /**
   * The host's own SessionEnd ends the current birth it serves (R5 Windows forced end, R10 `/clear`). The hook payload
   * carries no instance, so the birth must be this hook's host: the reported host PID matches, the relay bound a host
   * start no later than the hook's own start (the watcher's bound; two live processes never share a PID), and the
   * birth started before the hook. A late SessionEnd therefore cannot end a newer resume generation of another process
   * or a generation started after it. Ends and drops that birth's lease together; the first of this and the relay's
   * release wins (endPresence keeps an existing end).
   */
  endHostSession(input: SessionIdentity & { hostPid: number; hostAliveAt: string; hookStartedAt: number; reason: string }, nowMs = AUTHORITY_NOW): boolean {
    boundedIdentity(input);
    if (!Number.isSafeInteger(input.hostPid) || input.hostPid < 1 || typeof input.hostAliveAt !== "string" || input.hostAliveAt.length > 64
      || !Number.isSafeInteger(input.hookStartedAt) || input.hookStartedAt < 0 || !input.reason || input.reason.length > 100) {
      throw new SessionMessageError(msg("services.sessionMessage.relay.sessionEndInvalid", {}));
    }
    if (!this.inTransaction) return this.transaction(() => this.endHostSession(input, nowMs));
    nowMs = this.time(nowMs);
    const current = this.presence(input, nowMs);
    if (current.instanceId === null || current.state === "ended" || Date.parse(current.startedAt!) > input.hookStartedAt) return false;
    const host = this.presenceHost(input, current.instanceId);
    if (!host || host.pid !== input.hostPid || host.start === null || !startNotAfter(host.start, input.hostAliveAt)) return false;
    this.database.prepare("DELETE FROM relay_leases WHERE host = ? AND session_id = ? AND instance_id = ?")
      .run(input.host, input.sessionId, current.instanceId);
    return this.endPresence(input, input.reason, current.instanceId, nowMs);
  }

  /**
   * One relay cycle (3.3). Only the lease holder of the current online birth renews the lease and the birth. The first
   * tick that carries the watcher's hostStart binds the birth; a different stored birth fences the relay. A tick that
   * carries prerequisiteMissing (a reason code the relay's port knew before any wake) records it on the birth's path,
   * exactly as a prerequisite-missing outcome would (2.4): the outlook is degraded and the birth is not rung.
   */
  relayTick(input: SessionIdentity & { transport: string; relayId: string; instanceId: string; includePending: boolean; hostStart?: string; prerequisiteMissing?: string }, nowMs = AUTHORITY_NOW): { alive: boolean; count: number; hostBound: boolean; ended?: true } {
    boundedIdentity(input);
    if (!input.transport || input.transport.length > 64 || !input.relayId || input.relayId.length > 128 || !input.instanceId || input.instanceId.length > 128
      || typeof input.includePending !== "boolean" || (input.hostStart !== undefined && (!input.hostStart.trim() || input.hostStart.length > 200))
      || (input.prerequisiteMissing !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/u.test(input.prerequisiteMissing))) {
      throw new SessionMessageError(msg("services.sessionMessage.relay.tickInvalid", {}));
    }
    if (!this.inTransaction) return this.transaction(() => this.relayTick(input, nowMs));
    nowMs = this.time(nowMs);
    const dead = { alive: false, count: 0, hostBound: false };
    const presence = this.presence(input, nowMs);
    // Its birth was ended (the host's SessionEnd): a normal end for the relay, not a lost lease.
    if (presence.state === "ended" && presence.instanceId === input.instanceId) return { ...dead, ended: true };
    const lease = this.database.prepare("SELECT relay_id, instance_id, lease_until FROM relay_leases WHERE host = ? AND session_id = ? AND transport = ?")
      .get(input.host, input.sessionId, input.transport) as { relay_id: string; instance_id: string; lease_until: string } | undefined;
    // An expired lease is dead whether or not prune already removed it; the relay ends and a new grant takes over.
    if (presence.state !== "online" || presence.instanceId !== input.instanceId || presence.transport !== input.transport
      || lease?.relay_id !== input.relayId || lease.instance_id !== input.instanceId || Date.parse(lease.lease_until) <= nowMs) return dead;
    const host = this.presenceHost(input, input.instanceId);
    let start = host?.start ?? null;
    // A birth bound without a reported host process could never be woken (wakeBindingCurrent needs both), so nothing is bound.
    if (input.hostStart !== undefined && host !== null) {
      if (start === null) {
        this.database.prepare("UPDATE session_presence SET host_start = ? WHERE host = ? AND session_id = ? AND instance_id = ? AND host_start IS NULL")
          .run(input.hostStart, input.host, input.sessionId, input.instanceId);
        start = input.hostStart;
      } else if (start !== input.hostStart) return dead;
    }
    const now = iso(nowMs);
    if (input.prerequisiteMissing !== undefined) {
      // The first loss stays the basis; SET reads the old prerequisite_missing for both assignments.
      this.updateWakePath({ host: input.host, sessionId: input.sessionId, instanceId: input.instanceId, generation: presence.startedAt! },
        "last_failure_at = CASE WHEN prerequisite_missing IS NULL THEN ? ELSE last_failure_at END, prerequisite_missing = coalesce(prerequisite_missing, ?)",
        [now, input.prerequisiteMissing], nowMs);
    }
    this.database.prepare("UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE host = ? AND session_id = ? AND transport = ? AND relay_id = ?")
      .run(iso(nowMs + RELAY_LEASE_MS), now, input.host, input.sessionId, input.transport, input.relayId);
    this.heartbeatPresence(input, input.instanceId, nowMs);
    return { alive: true, count: input.includePending ? this.pendingCount(input, nowMs) : 0, hostBound: start !== null };
  }

  /**
   * Peer-wait resume evidence (docs/peer-wait-policy.md 3-4) from durable rows only: the sender's current online birth,
   * its live lease bound to a host birth, and an attempt of that birth and relay observed by a verified host hook within
   * 30 seconds. No PID is consulted; a relay that died loses the lease within RELAY_LEASE_MS.
   */
  peerWaitResumeObserved(sender: SessionIdentity, nowMs = AUTHORITY_NOW): boolean {
    boundedIdentity(sender);
    if (!this.inTransaction) return this.transaction(() => this.peerWaitResumeObserved(sender, nowMs));
    nowMs = this.time(nowMs);
    const presence = this.presence(sender, nowMs);
    if (presence.state !== "online" || presence.instanceId === null || presence.transport === null) return false;
    const relay = this.liveRelay(sender, presence.transport, nowMs);
    if (!relay || relay.instanceId !== presence.instanceId || this.presenceHost(sender, presence.instanceId)?.start == null) return false;
    return this.database.prepare(`SELECT 1 FROM wake_nonces WHERE host = ? AND session_id = ? AND instance_id = ? AND relay_id = ?
      AND state = 'observed' AND observed_at > ? LIMIT 1`)
      .get(sender.host, sender.sessionId, presence.instanceId, relay.relayId, iso(nowMs - PEER_WAIT_RESUME_WINDOW_MS)) !== undefined;
  }

  /** Durable repeat-suppression records for PeerWaitPolicy, shared by every process; bounded, expired rows pruned on access. */
  peerWaitSnapshots(nowMs = AUTHORITY_NOW): PeerWaitSnapshotStore {
    const run = <T>(work: (now: number) => T): T => this.inTransaction ? work(this.time(nowMs)) : this.transaction(() => work(this.time(nowMs)));
    return {
      now: () => run((now) => now),
      get: (key) => run((now) => {
        this.database.prepare("DELETE FROM peer_wait_snapshots WHERE expires_at <= ?").run(iso(now));
        const row = this.database.prepare("SELECT owner_key, fingerprint, expires_at FROM peer_wait_snapshots WHERE query_key = ?").get(key) as
          { owner_key: string; fingerprint: string; expires_at: string } | undefined;
        return row ? { owner: row.owner_key, fingerprint: row.fingerprint, expiresAt: Date.parse(row.expires_at) } : undefined;
      }),
      set: (key, record) => run(() => {
        this.database.prepare(`INSERT INTO peer_wait_snapshots (query_key, owner_key, fingerprint, expires_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (query_key) DO UPDATE SET owner_key = excluded.owner_key, fingerprint = excluded.fingerprint, expires_at = excluded.expires_at`)
          .run(key, record.owner, record.fingerprint, iso(record.expiresAt));
        this.database.prepare(`DELETE FROM peer_wait_snapshots WHERE query_key IN (SELECT query_key FROM peer_wait_snapshots
          ORDER BY expires_at DESC LIMIT -1 OFFSET ?)`).run(PEER_WAIT_SNAPSHOT_LIMIT);
      }),
      resetOwner: (owner) => run(() => { this.database.prepare("DELETE FROM peer_wait_snapshots WHERE owner_key = ?").run(owner); }),
    };
  }

  /** Board classification (2.2): the marker names an attempt row of this target, whatever its state or expiry. */
  consumeWake(target: SessionIdentity, nonce: string): boolean {
    boundedIdentity(target);
    if (!this.inTransaction) return this.transaction(() => this.consumeWake(target, nonce));
    return Boolean(this.database.prepare("SELECT 1 FROM wake_nonces WHERE nonce_digest = ? AND host = ? AND session_id = ?")
      .get(nonceDigest(nonce), target.host, target.sessionId));
  }

  private wakeBindingCurrent(input: WakeRelayBinding, generation: string | null, nowMs: number): boolean {
    boundedIdentity(input);
    const presence = this.presence(input, nowMs);
    const relay = this.liveRelay(input, input.transport, nowMs);
    return presence.state === "online" && presence.instanceId === input.instanceId && presence.transport === input.transport
      && (generation === null || presence.startedAt === generation) && relay?.relayId === input.relayId && relay.instanceId === input.instanceId
      // Only a relay whose watcher bound the host birth may ring it (3.3).
      && this.presenceHost(input, input.instanceId)?.start != null
      && presence.deliveryCapabilities.idleWake !== "none" && presence.deliveryCapabilities.supportedInjection.includes("peer-wake");
  }

  private wakeGenerationReplaced(attempt: WakeAttempt, nowMs: number): boolean {
    const presence = this.presence(attempt, nowMs);
    return presence.instanceId !== null && presence.startedAt !== null
      && (presence.instanceId !== attempt.instanceId || presence.startedAt !== attempt.generation || presence.transport !== attempt.transport);
  }

  private wakeClaimable(target: SessionIdentity, nowMs: number): boolean {
    const now = iso(nowMs);
    const delivering = this.database.prepare(`SELECT 1 FROM messages WHERE target_host = ? AND target_session_id = ?
      AND acknowledged_at IS NULL AND expires_at > ? AND claim_until > ? LIMIT 1`).get(target.host, target.sessionId, now, now);
    const claimable = this.database.prepare(`SELECT 1 FROM messages WHERE target_host = ? AND target_session_id = ?
      AND acknowledged_at IS NULL AND expires_at > ? AND (claim_until IS NULL OR claim_until <= ?) LIMIT 1`)
      .get(target.host, target.sessionId, now, now);
    return !delivering && Boolean(claimable);
  }

  private wakeAttempt(row: Record<string, unknown>): WakeAttempt {
    return { host: String(row.host), sessionId: String(row.session_id), instanceId: String(row.instance_id),
      transport: String(row.transport), relayId: String(row.relay_id), nonce: String(row.nonce),
      generation: String(row.birth_generation), attemptId: String(row.attempt_id), dispatchEpoch: Number(row.dispatch_epoch) };
  }

  /** Gates 1-5 of 2.5. Retries always reserve a new row and nonce; only an unstarted row of the same birth resumes. */
  reserveManagedWake(input: WakeRelayBinding & { nonce: string; resume?: boolean }, atMs?: number): WakeReservation {
    boundedIdentity(input);
    if (!/^[A-Za-z0-9_-]{22,128}$/u.test(input.nonce)) throw new SessionMessageError(msg("services.sessionMessage.wake.nonceInvalid", {}));
    for (const value of [input.instanceId, input.relayId, input.transport]) {
      if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new SessionMessageError(msg("services.sessionMessage.wake.relayBindingInvalid", {}));
    }
    if (!this.inTransaction) return this.transaction(() => this.reserveManagedWake(input, atMs));
    return this.transaction(() => {
      // Production time is sampled after the writer lock; fixtures may supply an explicit clock.
      const nowMs = this.time(atMs ?? AUTHORITY_NOW);
      this.prune(nowMs);
      const none: WakeReservation = { dispatch: false, attempt: null };
      const generation = this.presence(input, nowMs).startedAt;
      const open = generation !== null && this.wakeBindingCurrent(input, generation, nowMs) && this.wakeClaimable(input, nowMs)
        && this.wakePathOpen({ ...input, generation }, nowMs);
      const active = this.database.prepare(`SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AND state IN ${ACTIVE_WAKE_STATES}`)
        .get(input.host, input.sessionId) as Record<string, unknown> | undefined;
      if (active) {
        // Before started there is no external effect. Transfer ownership only to the current lease of the same birth.
        if (active.state !== "reserved" || input.resume !== true || !open || active.instance_id !== input.instanceId
          || active.transport !== input.transport || active.birth_generation !== generation) return none;
        this.database.prepare("UPDATE wake_nonces SET relay_id = ? WHERE nonce_digest = ? AND state = 'reserved'")
          .run(input.relayId, String(active.nonce_digest));
        return { dispatch: true, attempt: { ...this.wakeAttempt(active), relayId: input.relayId } };
      }
      if (!open) return none;
      const count = this.database.prepare(`SELECT count(*) AS n FROM wake_nonces WHERE state IN ${ACTIVE_WAKE_STATES}`).get() as { n: number };
      if (count.n >= MESSAGE_LIMIT) throw new SessionMessageError(msg("services.sessionMessage.capacity.wakeFull", {}));
      const attemptId = randomUUID();
      this.database.prepare(`INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at, state, nonce,
        instance_id, birth_generation, transport, relay_id, attempt_id) VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?)`)
        .run(nonceDigest(input.nonce), input.host, input.sessionId, iso(nowMs + WAKE_TTL_MS), input.nonce,
          input.instanceId, generation, input.transport, input.relayId, attemptId);
      this.updateWakePath({ ...input, generation }, "", [], nowMs);
      return { dispatch: true, attempt: { host: input.host, sessionId: input.sessionId, instanceId: input.instanceId,
        transport: input.transport, relayId: input.relayId, nonce: input.nonce, generation, attemptId, dispatchEpoch: 0 } };
    });
  }

  /** CAS succeeds once (I3) and re-checks gates 1, 2, 4 and 5. The caller must not call a host adapter without this committed start. */
  startManagedWake(attempt: WakeAttempt, resendBaseMs: number, atMs?: number): WakeReservation {
    assertResendBase(resendBaseMs);
    if (!this.inTransaction) return this.transaction(() => this.startManagedWake(attempt, resendBaseMs, atMs));
    return this.transaction(() => {
      const nowMs = this.time(atMs ?? AUTHORITY_NOW);
      // Ends an expired or no-longer-claimable reservation first; the reserved row below is then still due.
      this.prune(nowMs);
      const none: WakeReservation = { dispatch: false, attempt: null };
      const row = this.database.prepare(`SELECT 1 FROM wake_nonces WHERE nonce_digest = ? AND host = ? AND session_id = ?
        AND state = 'reserved' AND instance_id = ? AND birth_generation = ? AND transport = ? AND relay_id = ? AND attempt_id = ? AND dispatch_epoch = ?`)
        .get(nonceDigest(attempt.nonce), attempt.host, attempt.sessionId, attempt.instanceId, attempt.generation,
          attempt.transport, attempt.relayId, attempt.attemptId, attempt.dispatchEpoch);
      if (!row || !this.wakeBindingCurrent(attempt, attempt.generation, nowMs) || !this.wakeClaimable(attempt, nowMs)
        || !this.wakePathOpen(attempt, nowMs)) return none;
      const started = this.database.prepare(`UPDATE wake_nonces SET state = 'started', started_at = ?, dispatch_epoch = dispatch_epoch + 1,
        resend_base_ms = ? WHERE nonce_digest = ? AND state = 'reserved' AND dispatch_epoch = ?`)
        .run(iso(nowMs), resendBaseMs, nonceDigest(attempt.nonce), attempt.dispatchEpoch).changes === 1;
      return started ? { dispatch: true, attempt: { ...attempt, dispatchEpoch: attempt.dispatchEpoch + 1 } } : none;
    });
  }

  /**
   * 2.2/2.4: the row changes only from started or unknown with the same attempt and epoch; an ended row never reopens
   * (I11). The birth's path takes the outcome of this exact attempt even when it arrives after the row ended.
   */
  recordManagedWakeOutcome(attempt: WakeAttempt, outcome: WakeDispatchOutcome, resendBaseMs: number, nowMs = AUTHORITY_NOW): boolean {
    if (!isWakeDispatchOutcome(outcome)) throw new SessionMessageError(msg("services.sessionMessage.wake.outcomeInvalid", {}));
    assertResendBase(resendBaseMs);
    if (!this.inTransaction) return this.transaction(() => this.recordManagedWakeOutcome(attempt, outcome, resendBaseMs, nowMs));
    nowMs = this.time(nowMs);
    return this.transaction(() => {
      const now = iso(nowMs);
      const digest = nonceDigest(attempt.nonce);
      const row = this.database.prepare(`SELECT state FROM wake_nonces WHERE nonce_digest = ? AND host = ? AND session_id = ?
        AND instance_id = ? AND birth_generation = ? AND transport = ? AND relay_id = ? AND attempt_id = ? AND dispatch_epoch = ?`)
        .get(digest, attempt.host, attempt.sessionId, attempt.instanceId, attempt.generation, attempt.transport,
          attempt.relayId, attempt.attemptId, attempt.dispatchEpoch) as { state: string } | undefined;
      if (!row || attempt.dispatchEpoch < 1) return false;
      const path = this.wakePath(attempt);
      // ponytail: a replayed record of the same attempt counts its transient failure twice (one extra backoff step);
      // add a per-attempt recorded flag if replays become common.
      if (outcome.result !== "not-delivered") this.updateWakePath(attempt, "failures = 0", [], nowMs);
      else if (outcome.kind === "transient") {
        this.updateWakePath(attempt, "failures = failures + 1, last_failure_at = ?, retry_not_before = ?",
          [now, iso(nowMs + wakeBackoffDelay(Number(path?.failures ?? 0)))], nowMs);
      } else this.updateWakePath(attempt, "prerequisite_missing = ?, last_failure_at = ?", [outcome.reasonCode, now], nowMs);
      if (row.state !== "started" && row.state !== "unknown") return false;
      if (outcome.result === "not-delivered") {
        this.database.prepare("UPDATE wake_nonces SET state = 'not-delivered', outcome_at = ? WHERE nonce_digest = ? AND state IN ('started', 'unknown')")
          .run(now, digest);
      } else {
        this.database.prepare(`UPDATE wake_nonces SET state = ?, outcome_at = ?, resend_base_ms = ?, resend_due_at = ?
          WHERE nonce_digest = ? AND state IN ('started', 'unknown')`)
          .run(outcome.result, now, resendBaseMs, iso(nowMs + resendDelay(resendBaseMs, Number(path?.streak ?? 0))), digest);
      }
      return true;
    });
  }

  /**
   * The target's latest wake attempt; with `started`, only an attempt a message caused: one that started while the
   * message was pending (from its creation to its acknowledgement). A wake starts only while the target has a claimable
   * body, so such an attempt rang for this message among others; an attempt of an earlier or later message is not shown.
   * Times are the store's monotonic authority time in one ISO format, so they compare as text.
   */
  managedWakeStatus(target: SessionIdentity, nowMs = AUTHORITY_NOW, started?: { startedFrom: string; startedUntil: string | null }): Record<string, unknown> | null {
    boundedIdentity(target);
    if (!this.inTransaction) return this.transaction(() => this.managedWakeStatus(target, nowMs, started));
    const row = (started
      ? this.database.prepare(`SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AND started_at IS NOT NULL
        AND started_at >= ? AND (? IS NULL OR started_at <= ?)
        ORDER BY CASE WHEN state IN ${ACTIVE_WAKE_STATES} THEN 0 ELSE 1 END, rowid DESC LIMIT 1`)
        .get(target.host, target.sessionId, started.startedFrom, started.startedUntil, started.startedUntil)
      : this.database.prepare(`SELECT * FROM wake_nonces WHERE host = ? AND session_id = ?
        ORDER BY CASE WHEN state IN ${ACTIVE_WAKE_STATES} THEN 0 ELSE 1 END, rowid DESC LIMIT 1`)
        .get(target.host, target.sessionId)) as Record<string, unknown> | undefined;
    if (!row) return null;
    const active = ACTIVE_WAKE_STATE_LIST.includes(String(row.state));
    return { state: row.state, releaseReason: row.release_reason,
      observation: row.state === "observed" ? "observed" : row.late_observed_at !== null ? "late-observed" : active ? "pending" : "unobserved",
      // handed-off is not delivery (I10).
      deliveryState: row.state === "observed" || row.state === "not-delivered" ? row.state : "unknown",
      instanceId: row.instance_id, generation: row.birth_generation, attemptId: row.attempt_id,
      startedAt: row.started_at, outcomeAt: row.outcome_at, resendDueAt: row.resend_due_at, releasedAt: row.released_at,
      dispatchEpoch: row.dispatch_epoch, expiresAt: row.expires_at, observedAt: row.observed_at, lateObservedAt: row.late_observed_at };
  }

  /**
   * Verified arrival (2.7). A marker of the current birth (instance, birth, transport, online, peer-wake) claims the
   * pending bodies whatever its row state or nonce expiry, ends its active row as observed and passes a claim boundary.
   * A marker of another birth claims nothing (I2) and, like an ended row, only records its first late arrival.
   * An unknown or pruned marker authorizes nothing (I1).
   */
  claimHostWake(target: SessionIdentity, observation: InputObservation, receiptId: string, reader: WakeHookObservationReader | undefined, nowMs = AUTHORITY_NOW, limits: ClaimLimits = {}): {
    recognized: boolean; messages: SessionMessage[]; binding: WakeAttempt | null; retired?: true; observedNow?: true; rejectionReason?: string;
  } {
    boundedIdentity(target);
    const rejected = { recognized: false, messages: [], binding: null };
    if (!isWakeHookObservation(observation, target)) return { ...rejected, rejectionReason: "WAKE_OBSERVATION_INVALID" };
    if (!reader) return { ...rejected, rejectionReason: "WAKE_READER_UNAVAILABLE" };
    const digests = [...new Set(observation.wakeCandidates!.map(nonceDigest))];
    if (!this.inTransaction) return this.transaction(() => this.claimHostWake(target, observation, receiptId, reader, nowMs, limits));
    nowMs = this.time(nowMs);
    return this.transaction(() => {
      if (!reader.verifyObservation(target, observation, receiptId, nowMs)) return { ...rejected, rejectionReason: "WAKE_RECEIPT_REJECTED" };
      const found = digests.map((digest) => this.database.prepare("SELECT * FROM wake_nonces WHERE nonce_digest = ? AND host = ? AND session_id = ?")
        .get(digest, target.host, target.sessionId) as Record<string, unknown> | undefined);
      if (found.some((row) => !row)) return { ...rejected, rejectionReason: "WAKE_NONCE_UNKNOWN" };
      const rows = found as Array<Record<string, unknown>>;
      const now = iso(nowMs);
      const presence = this.presence(target, nowMs);
      const current = (row: Record<string, unknown>) => presence.state === "online" && row.instance_id === presence.instanceId
        && row.birth_generation === presence.startedAt && row.transport === presence.transport
        && presence.deliveryCapabilities.supportedInjection.includes("peer-wake");
      const ended = (row: Record<string, unknown>) => !ACTIVE_WAKE_STATE_LIST.includes(String(row.state));
      const allEnded = rows.every(ended);
      for (const row of rows) {
        if (ended(row) || !current(row)) this.database.prepare("UPDATE wake_nonces SET late_observed_at = coalesce(late_observed_at, ?) WHERE nonce_digest = ?")
          .run(now, String(row.nonce_digest));
      }
      const live = rows.filter(current);
      if (live.length === 0) return { ...rejected, rejectionReason: "WAKE_GENERATION_NOT_CURRENT", ...(allEnded ? { retired: true as const } : {}) };
      const messages = this.claimLocked(target, nowMs, limits);
      // Only an attempt that was still in flight is a new observation; a repeated marker claims bodies but refreshes nothing.
      const observedNow = live.some((row) => !ended(row));
      for (const row of live) {
        this.database.prepare(`UPDATE wake_nonces SET state = 'observed', consumed_at = ?, observed_at = ?
          WHERE nonce_digest = ? AND state IN ${ACTIVE_WAKE_STATES}`).run(now, now, String(row.nonce_digest));
      }
      this.markClaimBoundary(target, nowMs);
      // The wake starts a turn as a prompt does; its turn end clears this.
      this.database.prepare(`INSERT INTO input_observations (host, session_id, deferred_tool_claim, observed_at) VALUES (?, ?, 0, ?)
        ON CONFLICT (host, session_id) DO UPDATE SET observed_at = excluded.observed_at`).run(target.host, target.sessionId, now);
      this.updateWakePath(this.wakeAttempt(live[0]!), "streak = 0", [], nowMs);
      return { recognized: true, messages, binding: this.wakeAttempt(live[0]!), ...(messages.length === 0 && allEnded ? { retired: true as const } : {}),
        ...(observedNow ? { observedNow: true as const } : {}) };
    });
  }

  startPresence(input: SessionIdentity & {
    instanceId: string;
    transport: string;
    wakeVisibility: WakeVisibility;
    canWakeSilently: boolean;
    deliveryCapabilities?: DeliveryCapabilities;
    collaborationId?: string;
    workspaceId?: string;
    role?: string;
    /** The host process the hook resolved; hostStart only when the caller already read its birth. */
    hostPid?: number;
    hostStart?: string;
  }, nowMs = AUTHORITY_NOW): SessionPresence {
    boundedIdentity(input);
    if (!input.instanceId || input.instanceId.length > 128 || !input.transport || input.transport.length > 64) throw new SessionMessageError(msg("services.sessionMessage.presence.identityInvalid", {}));
    if ((input.hostPid !== undefined && (!Number.isSafeInteger(input.hostPid) || input.hostPid < 1))
      || (input.hostStart !== undefined && (input.hostPid === undefined || typeof input.hostStart !== "string" || !input.hostStart.trim() || input.hostStart.length > 200))) {
      throw new SessionMessageError(msg("services.sessionMessage.presence.hostProcessInvalid", {}));
    }
    for (const [name, value, maximum] of [
      ["collaborationId", input.collaborationId, 200],
      ["workspaceId", input.workspaceId, 500],
      ["role", input.role, 100],
    ] as const) {
      if (value !== undefined && (!value || value.length > maximum)) throw new SessionMessageError(msg("services.sessionMessage.field.invalid", { field: name }));
    }
    if (!this.inTransaction) return this.transaction(() => this.startPresence(input, nowMs));
    nowMs = this.time(nowMs);
    const now = iso(nowMs);
    this.database.prepare(`INSERT INTO session_presence (
      host, session_id, instance_id, transport, wake_visibility, can_wake_silently, supported_injection, idle_wake,
      collaboration_id, workspace_id, role, started_at, heartbeat_at, lease_until, host_pid, host_start
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (host, session_id, instance_id) DO UPDATE SET
      transport = excluded.transport, wake_visibility = excluded.wake_visibility,
      can_wake_silently = excluded.can_wake_silently, supported_injection = excluded.supported_injection,
      idle_wake = excluded.idle_wake, collaboration_id = excluded.collaboration_id,
      workspace_id = excluded.workspace_id, role = excluded.role,
      started_at = CASE WHEN session_presence.ended_at IS NOT NULL OR session_presence.lease_until <= excluded.heartbeat_at
        THEN CASE WHEN excluded.started_at > session_presence.started_at THEN excluded.started_at
          -- A rebirth in the same millisecond still gets a later, distinct generation.
          ELSE strftime('%Y-%m-%dT%H:%M:%fZ', session_presence.started_at, '+0.001 seconds') END
        ELSE session_presence.started_at END,
      heartbeat_at = excluded.heartbeat_at, lease_until = excluded.lease_until,
      host_pid = coalesce(session_presence.host_pid, excluded.host_pid), host_start = coalesce(session_presence.host_start, excluded.host_start),
      ended_at = NULL, end_reason = NULL
      WHERE session_presence.superseded_at IS NULL`).run(
      input.host, input.sessionId, input.instanceId, input.transport, input.wakeVisibility,
      input.canWakeSilently ? 1 : 0, JSON.stringify(input.deliveryCapabilities?.supportedInjection ?? []),
      input.deliveryCapabilities?.idleWake ?? input.wakeVisibility, input.collaborationId ?? null, input.workspaceId ?? null,
      input.role ?? null, now, now, iso(nowMs + PRESENCE_LEASE_MS), input.hostPid ?? null, input.hostStart ?? null,
    );
    return this.presence(input, nowMs);
  }

  heartbeatPresence(target: SessionIdentity, instanceId: string, nowMs = AUTHORITY_NOW): boolean {
    boundedIdentity(target);
    if (!instanceId) throw new SessionMessageError(msg("services.sessionMessage.presence.instanceIdRequired", {}));
    if (!this.inTransaction) return this.transaction(() => this.heartbeatPresence(target, instanceId, nowMs));
    nowMs = this.time(nowMs);
    const row = this.database.prepare(`SELECT instance_id FROM session_presence
      WHERE host = ? AND session_id = ? AND instance_id = ? AND superseded_at IS NULL AND ended_at IS NULL AND lease_until > ?`).get(target.host, target.sessionId, instanceId, iso(nowMs));
    const selected = row as { instance_id: string } | undefined;
    if (!selected) return false;
    const now = iso(nowMs);
    return this.database.prepare(`UPDATE session_presence SET heartbeat_at = ?, lease_until = ?
      WHERE host = ? AND session_id = ? AND instance_id = ? AND superseded_at IS NULL AND ended_at IS NULL AND lease_until > ?`)
      .run(now, iso(nowMs + PRESENCE_LEASE_MS), target.host, target.sessionId, selected.instance_id, now).changes === 1;
  }

  endPresence(target: SessionIdentity, reason: string, instanceId: string, nowMs = AUTHORITY_NOW): boolean {
    boundedIdentity(target);
    if (!reason || reason.length > 100) throw new SessionMessageError(msg("services.sessionMessage.presence.endReasonInvalid", {}));
    if (!instanceId) throw new SessionMessageError(msg("services.sessionMessage.presence.instanceIdRequired", {}));
    if (!this.inTransaction) return this.transaction(() => this.endPresence(target, reason, instanceId, nowMs));
    nowMs = this.time(nowMs);
    const row = this.database.prepare(`SELECT instance_id FROM session_presence
      WHERE host = ? AND session_id = ? AND instance_id = ? AND ended_at IS NULL`).get(target.host, target.sessionId, instanceId);
    const selected = row as { instance_id: string } | undefined;
    if (!selected) return false;
    const now = iso(nowMs);
    return this.database.prepare(`UPDATE session_presence SET heartbeat_at = ?, lease_until = ?, ended_at = ?, end_reason = ?
      WHERE host = ? AND session_id = ? AND instance_id = ? AND ended_at IS NULL`)
      .run(now, now, now, reason, target.host, target.sessionId, selected.instance_id).changes === 1;
  }

  presence(target: SessionIdentity, nowMs = AUTHORITY_NOW): SessionPresence {
    boundedIdentity(target);
    if (!this.inTransaction) return this.transaction(() => this.presence(target, nowMs));
    nowMs = this.time(nowMs);
    const row = this.database.prepare(`SELECT * FROM session_presence
      WHERE host = ? AND session_id = ? AND superseded_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1`)
      .get(target.host, target.sessionId) as Record<string, unknown> | undefined;
    if (!row) return {
      ...target, instanceId: null, transport: null, wakeVisibility: "none", canWakeSilently: false,
      deliveryCapabilities: { supportedInjection: [], idleWake: "none" },
      collaborationId: null, workspaceId: null, role: null, startedAt: null, heartbeatAt: null,
      leaseUntil: null, endedAt: null, endReason: null, state: "unknown", relayLive: false,
    };
    const endedAt = row.ended_at === null ? null : String(row.ended_at);
    const leaseUntil = String(row.lease_until);
    const state: SessionPresenceState = endedAt ? "ended" : Date.parse(leaseUntil) > nowMs ? "online" : "unreachable";
    return {
      host: String(row.host), sessionId: String(row.session_id), instanceId: String(row.instance_id),
      transport: String(row.transport), wakeVisibility: row.wake_visibility as WakeVisibility,
      canWakeSilently: Boolean(row.can_wake_silently), collaborationId: row.collaboration_id === null ? null : String(row.collaboration_id),
      deliveryCapabilities: {
        supportedInjection: JSON.parse(String(row.supported_injection)) as InputObservationKind[],
        idleWake: row.idle_wake as DeliveryCapabilities["idleWake"],
      },
      workspaceId: row.workspace_id === null ? null : String(row.workspace_id), role: row.role === null ? null : String(row.role),
      startedAt: String(row.started_at), heartbeatAt: String(row.heartbeat_at), leaseUntil,
      endedAt, endReason: row.end_reason === null ? null : String(row.end_reason),
      state, relayLive: state === "online" && this.liveRelay(target, String(row.transport), nowMs) !== null,
    };
  }

  /**
   * The session board's liveness view: the current birth of every session that is online, or lapsed (not ended) for at
   * most PRESENCE_UNREACHABLE_VISIBLE_MS, newest heartbeat first. `self` comes first whatever its state. Rows that do
   * not fit the byte budget are only counted.
   */
  listCurrentPresence(nowMs = AUTHORITY_NOW, self: SessionIdentity, maxBytes = CURRENT_PRESENCE_MAX_BYTES): { sessions: CurrentPresence[]; truncated: number } {
    boundedIdentity(self);
    if (!this.inTransaction) return this.transaction(() => this.listCurrentPresence(nowMs, self, maxBytes));
    nowMs = this.time(nowMs);
    this.prune(nowMs);
    const visibleSince = iso(nowMs - PRESENCE_UNREACHABLE_VISIBLE_MS);
    const others = (this.database.prepare(`SELECT DISTINCT host, session_id FROM session_presence
      WHERE superseded_at IS NULL AND ended_at IS NULL AND lease_until > ?`).all(visibleSince) as Array<{ host: string; session_id: string }>)
      .filter((row) => row.host !== self.host || row.session_id !== self.sessionId)
      .map((row) => this.presence({ host: row.host, sessionId: row.session_id }, nowMs))
      // Only the latest birth counts: an older live birth of a session that has since ended or lapsed is not shown.
      .filter((presence) => presence.state === "online" || (presence.state === "unreachable" && presence.leaseUntil! > visibleSince))
      .sort((left, right) => (right.heartbeatAt ?? "").localeCompare(left.heartbeatAt ?? ""));
    const compact = (presence: SessionPresence): CurrentPresence => ({
      host: presence.host, sessionId: presence.sessionId, state: presence.state, startedAt: presence.startedAt,
      heartbeatAt: presence.heartbeatAt, leaseUntil: presence.leaseUntil, workspaceId: presence.workspaceId,
      transport: presence.transport, autoWake: this.autoWakeOutlook(presence, nowMs),
    });
    const sessions = [compact(this.presence(self, nowMs))];
    let bytes = Buffer.byteLength(JSON.stringify(sessions[0]), "utf8");
    let truncated = 0;
    for (const presence of others) {
      const row = compact(presence);
      const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
      if (truncated > 0 || bytes + size > maxBytes) { truncated++; continue; }
      sessions.push(row);
      bytes += size;
    }
    return { sessions, truncated };
  }

  /**
   * The latest birth of every session presence still keeps (online, lapsed, or ended until housekeeping drops it
   * PRESENCE_RETENTION_MS after its lease end). Root ownership reads it to tell whether a root's owner session still
   * runs; a session never seen here, or already dropped, is not listed (its presence is unknown).
   */
  listKnownPresence(nowMs = AUTHORITY_NOW): Array<Pick<SessionPresence, "host" | "sessionId" | "state" | "heartbeatAt" | "endedAt">> {
    if (!this.inTransaction) return this.transaction(() => this.listKnownPresence(nowMs));
    nowMs = this.time(nowMs);
    this.prune(nowMs);
    const rows = this.database.prepare("SELECT DISTINCT host, session_id FROM session_presence WHERE superseded_at IS NULL")
      .all() as Array<{ host: string; session_id: string }>;
    return rows.map((row) => {
      const presence = this.presence({ host: row.host, sessionId: row.session_id }, nowMs);
      return { host: presence.host, sessionId: presence.sessionId, state: presence.state, heartbeatAt: presence.heartbeatAt, endedAt: presence.endedAt };
    });
  }

  listPresence(nowMs = AUTHORITY_NOW, targets: SessionIdentity[], expectedCodeDigest: string | null = null): SessionPresenceView[] {
    if (!this.inTransaction) return this.transaction(() => this.listPresence(nowMs, targets, expectedCodeDigest));
    nowMs = this.time(nowMs);
    this.prune(nowMs);
    relayCodeDigest(expectedCodeDigest);
    return targets.map((target) => {
      const presence = this.presence(target, nowMs);
      const lease = presence.transport ? this.liveRelay(target, presence.transport, nowMs) : null;
      // The digest belongs to the grant of the current holder; a replaced grant carries its own.
      const runningDigest = lease && lease.instanceId === presence.instanceId ? lease.codeDigest : null;
      const status = !runningDigest || !expectedCodeDigest ? "unknown" : runningDigest === expectedCodeDigest ? "current" : "outdated";
      return { ...presence, autoWake: this.autoWakeOutlook(target, nowMs), relayCode: {status,runningDigest,expectedDigest:expectedCodeDigest} };
    });
  }
  private get inTransaction(): boolean {
    return this.shared ? this.shared.inTransaction : (this.database as DatabaseSync).isTransaction;
  }

  /**
   * Every time and expiry decision reads this inside the writer transaction (D0031/D0060). Standalone production time is
   * Date.now() sampled once after BEGIN IMMEDIATE and raised to the persisted high-water mark, so a clock step back or a
   * process with an older sample cannot decide with an earlier time. An explicit number is a fixture time and is used as is.
   */
  private time(nowMs: number): number {
    if (this.shared) return this.shared.time(Number.isNaN(nowMs) ? 0 : nowMs);
    if (!this.inTransaction) throw new SessionMessageError(msg("services.sessionMessage.store.writerTransactionRequired", {}));
    if (!Number.isNaN(nowMs)) return nowMs;
    if (this.transactionNow === undefined) {
      const stored = (this.database.prepare("SELECT last_ms FROM authority_time WHERE singleton = 1").get() as { last_ms: number } | undefined)?.last_ms ?? 0;
      const sampled = this.clock();
      if (!Number.isSafeInteger(sampled) || sampled < 0) throw new SessionMessageError(msg("services.sessionMessage.store.clockInvalid", {}));
      this.transactionNow = Math.max(stored, sampled);
      this.database.prepare("UPDATE authority_time SET last_ms = ? WHERE singleton = 1").run(this.transactionNow);
    }
    return this.transactionNow;
  }

  /** Runs several store calls as one writer transaction with one authority time. */
  atomically<T>(operation: () => T): T {
    return this.transaction(operation);
  }

  /** Outermost: BEGIN IMMEDIATE. Nested: a savepoint, so an inner domain rejection rolls back only its own writes. */
  private transaction<T>(operation: () => T): T {
    if (this.shared) return this.shared.transaction(operation);
    if (this.inTransaction) {
      const savepoint = `messaging_${++this.savepoints}`;
      this.database.exec(`SAVEPOINT ${savepoint}`);
      try { const result = operation(); this.database.exec(`RELEASE ${savepoint}`); return result; }
      catch (error) {
        try { this.database.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint};`); } catch (rollbackError) {
          retainFailureSecondary(error, utilTypes.isNativeError(rollbackError)
            ? tagProducerFailure(rollbackError, "SESSION_MESSAGE_ROLLBACK_FAILED") : rollbackError);
        }
        throw error;
      }
    }
    this.database.exec("BEGIN IMMEDIATE");
    this.transactionNow = undefined;
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) {
      // The domain or COMMIT failure stays primary; a failed ROLLBACK is retained only as a secondary diagnostic.
      try { this.database.exec("ROLLBACK"); } catch (rollbackError) {
        retainFailureSecondary(error, utilTypes.isNativeError(rollbackError)
          ? tagProducerFailure(rollbackError, "SESSION_MESSAGE_ROLLBACK_FAILED") : rollbackError);
      }
      throw error;
    } finally { this.transactionNow = undefined; }
  }


}
