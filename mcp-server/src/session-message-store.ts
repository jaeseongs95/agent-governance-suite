import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { isBoundedIdentity, SESSION_MESSAGE_BODY_MAX_BYTES, SESSION_MESSAGE_MAX_RESPONSE_BYTES } from "./session-message-protocol.js";
import { isWakeHookObservation, verifyHistoricalWakeObservation, wakeBackoffDelay, type HistoricalWakeEvidence, type WakeDispatchOutcome, type WakeHookObservationReader } from "./session-message-wake-port.js";
import type { DeliveryCapabilities, InputObservation, InputObservationKind } from "./input-observation.js";
import type { SessionAutoWakeOutlookV1 } from "../../contracts/types.js";

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
export const WAKE_TTL_MS = 60 * 60_000;
/** Covers hook timeout, broker restart and receipt TTL after the injection expiry, and equals the longest retry backoff. */
export const WAKE_RETIRE_GRACE_MS = 10 * 60_000;
const MESSAGE_SCHEMA_VERSION = 1;
const ACTIVE_WAKE_STATES = "('reserved', 'started', 'submitted', 'unknown')";
const WAKE_STATE_CHECK = "CHECK (state IN ('legacy', 'reserved', 'started', 'submitted', 'unknown', 'observed', 'not-submitted', 'expired-unobserved'))";
const WAKE_COPY_COLUMNS = "nonce_digest, host, session_id, expires_at, consumed_at, state, nonce, instance_id, birth_generation, transport, relay_id, attempt_id, dispatch_epoch, retry_not_before, retry_count, started_at, outcome_at, observed_at, late_observed_at";
export const PRESENCE_LEASE_MS = 20_000;
/** Ended or lapsed presence rows stay this long after their lease end; matches the session board's 24-hour window. */
export const PRESENCE_RETENTION_MS = 24 * 3600_000;
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
}

/** Board and service view; autoWake is absent or null only when a previous broker did not report it. */
export type SessionPresenceView = SessionPresence & { autoWake?: SessionAutoWakeOutlookV1 | null };

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function nonceDigest(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

function boundedIdentity(value: SessionIdentity): void {
  if (!isBoundedIdentity(value)) throw new Error("host and sessionId must use bounded identifier characters.");
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
export type ManagedWakeState = "reserved" | "started" | "submitted" | "unknown" | "observed" | "not-submitted" | "expired-unobserved";

export interface MessageCapacityDetails {
  scope: "sender" | "global";
  earliestReleaseAt: string | null;
}

/** A capacity rejection rolls back its transaction: nothing was queued or drafted. */
export class MessageCapacityError extends Error {
  readonly details: MessageCapacityDetails;

  constructor(message: string, details: MessageCapacityDetails) {
    super(message);
    this.name = "MessageCapacityError";
    this.details = details;
  }
}

export interface ClaimLimits {
  maxMessages?: number;
  maxBodyChars?: number;
}

export class SessionMessageStore {
  readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA busy_timeout = 5000;");
    const storedVersion = (this.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (storedVersion > MESSAGE_SCHEMA_VERSION) {
      this.database.close();
      throw new Error(`The session message database schema ${storedVersion} is newer than this broker supports.`);
    }
    if (databasePath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
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
    CREATE TABLE IF NOT EXISTS relay_leases (
      host TEXT NOT NULL,
      session_id TEXT NOT NULL,
      transport TEXT NOT NULL,
      relay_id TEXT NOT NULL,
      pid INTEGER NOT NULL,
      parent_pid INTEGER NOT NULL,
      lease_until TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (host, session_id, transport)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS wake_nonces (
      nonce_digest TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      session_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    ) STRICT;
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
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const version = (this.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version > MESSAGE_SCHEMA_VERSION) throw new Error(`The session message database schema ${version} is newer than this broker supports.`);
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
      const presenceColumns = this.database.prepare("PRAGMA table_info(session_presence)").all() as Array<{ name: string }>;
      if (!presenceColumns.some((column) => column.name === "supported_injection")) {
        this.database.exec("ALTER TABLE session_presence ADD COLUMN supported_injection TEXT NOT NULL DEFAULT '[]';");
      }
      if (!presenceColumns.some((column) => column.name === "idle_wake")) {
        this.database.exec("ALTER TABLE session_presence ADD COLUMN idle_wake TEXT NOT NULL DEFAULT 'none';");
        this.database.exec("UPDATE session_presence SET idle_wake = wake_visibility;");
      }
      this.database.exec(`CREATE TABLE IF NOT EXISTS input_observations (
        host TEXT NOT NULL,
        session_id TEXT NOT NULL,
        deferred_tool_claim INTEGER NOT NULL DEFAULT 0 CHECK (deferred_tool_claim IN (0, 1)),
        observed_at TEXT NOT NULL,
        PRIMARY KEY (host, session_id)
      ) STRICT;`);
      // Additive, transactional migration: historical consumed_at is never an observation.
      const wakeColumns = this.database.prepare("PRAGMA table_info(wake_nonces)").all() as Array<{ name: string }>;
      for (const [name, definition] of [
        ["state", "TEXT NOT NULL DEFAULT 'legacy' CHECK (state IN ('legacy', 'reserved', 'started', 'submitted', 'unknown', 'observed', 'not-submitted'))"],
        ["nonce", "TEXT"], ["instance_id", "TEXT"], ["birth_generation", "TEXT"], ["transport", "TEXT"],
        ["relay_id", "TEXT"], ["attempt_id", "TEXT"], ["dispatch_epoch", "INTEGER NOT NULL DEFAULT 0"],
        ["retry_not_before", "TEXT"], ["retry_count", "INTEGER NOT NULL DEFAULT 0"],
        ["started_at", "TEXT"], ["outcome_at", "TEXT"], ["observed_at", "TEXT"], ["late_observed_at", "TEXT"],
      ]) {
        if (!wakeColumns.some((column) => column.name === name)) this.database.exec(`ALTER TABLE wake_nonces ADD COLUMN ${name} ${definition};`);
      }
      // Schema 1 admits the terminal expired-unobserved state. SQLite cannot widen a CHECK in place, so the
      // table is rebuilt once in this transaction, keeping every row, rowid and column value.
      if (version < 1) {
        this.database.exec(`CREATE TABLE wake_nonces_next (
          nonce_digest TEXT PRIMARY KEY, host TEXT NOT NULL, session_id TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT,
          state TEXT NOT NULL DEFAULT 'legacy' ${WAKE_STATE_CHECK},
          nonce TEXT, instance_id TEXT, birth_generation TEXT, transport TEXT, relay_id TEXT, attempt_id TEXT,
          dispatch_epoch INTEGER NOT NULL DEFAULT 0, retry_not_before TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
          started_at TEXT, outcome_at TEXT, observed_at TEXT, late_observed_at TEXT, retired_at TEXT
        ) STRICT;
        INSERT INTO wake_nonces_next (rowid, ${WAKE_COPY_COLUMNS}) SELECT rowid, ${WAKE_COPY_COLUMNS} FROM wake_nonces;
        DROP TABLE wake_nonces;`);
        this.database.exec("ALTER TABLE wake_nonces_next RENAME TO wake_nonces;");
      }
      this.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS wake_active_target ON wake_nonces (host, session_id)
        WHERE state IN ${ACTIVE_WAKE_STATES};`);
      // Last session-scoped hook or tool activity; retirement evidence only, never delivery evidence.
      this.database.exec(`CREATE TABLE IF NOT EXISTS session_activity (
        host TEXT NOT NULL,
        session_id TEXT NOT NULL,
        active_at TEXT NOT NULL,
        PRIMARY KEY (host, session_id)
      ) STRICT;`);
      if (version < MESSAGE_SCHEMA_VERSION) this.database.exec(`PRAGMA user_version = ${MESSAGE_SCHEMA_VERSION};`);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  prune(nowMs = Date.now()): void {
    const now = iso(nowMs);
    const acknowledgedBefore = iso(nowMs - 3600_000);
    this.database.prepare("DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at IS NOT NULL AND acknowledged_at <= ?)").run(now, acknowledgedBefore);
    this.database.prepare("DELETE FROM relay_leases WHERE lease_until <= ?").run(now);
    this.database.prepare("DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at <= ?").run(now);
    this.retireUnobservedWakes(nowMs);
    this.database.prepare(`DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submitted', 'expired-unobserved')
      AND coalesce(consumed_at, observed_at, retired_at, outcome_at) <= ?
      AND (retry_not_before IS NULL OR retry_not_before <= ?)`).run(acknowledgedBefore, now);
    this.database.prepare(`DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_digest FROM wake_nonces
      WHERE state IN ('observed', 'not-submitted', 'expired-unobserved') AND (retry_not_before IS NULL OR retry_not_before <= ?)
      ORDER BY coalesce(consumed_at, observed_at, retired_at, outcome_at) DESC LIMIT -1 OFFSET ?)`)
      .run(now, MESSAGE_LIMIT);
    this.database.prepare("DELETE FROM prepared_messages WHERE expires_at <= ?").run(now);
    // Only rows whose lease ended before the retention window go; a live row's lease is always in the future. The
    // identity's latest row also stays while another row of it is live, so a live identity's presence and retirement read
    // the same row. Without a live row, deleting the latest row can surface an earlier one or leave the identity unknown.
    this.database.prepare(`DELETE FROM session_presence WHERE lease_until <= ?
      AND NOT (EXISTS (SELECT 1 FROM session_presence live WHERE live.host = session_presence.host
          AND live.session_id = session_presence.session_id AND live.ended_at IS NULL AND live.lease_until > ?)
        AND session_presence.rowid = (SELECT latest.rowid FROM session_presence latest WHERE latest.host = session_presence.host
          AND latest.session_id = session_presence.session_id ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1))`)
      .run(iso(nowMs - PRESENCE_RETENTION_MS), now);
  }

  /**
   * Retires an unobserved managed wake only after its injection expiry plus grace, and only with evidence that the
   * host moved past it: a newer live presence birth, or session activity after the expiry. The row keeps its original
   * binding, epoch and times; expired-unobserved is neither observation nor delivery. One UPDATE commits it atomically.
   */
  private retireUnobservedWakes(nowMs: number): void {
    const now = iso(nowMs);
    this.database.prepare(`UPDATE wake_nonces SET state = 'expired-unobserved', retired_at = ?
      WHERE state IN ${ACTIVE_WAKE_STATES} AND expires_at <= ?
        AND (EXISTS (SELECT 1 FROM session_activity activity WHERE activity.host = wake_nonces.host
            AND activity.session_id = wake_nonces.session_id AND activity.active_at > wake_nonces.expires_at)
          OR coalesce((SELECT latest.ended_at IS NULL AND latest.lease_until > ? AND latest.started_at > wake_nonces.birth_generation
            FROM session_presence latest WHERE latest.host = wake_nonces.host AND latest.session_id = wake_nonces.session_id
            ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1), 0))`)
      .run(now, iso(nowMs - WAKE_RETIRE_GRACE_MS), now);
  }

  private recordActivity(target: SessionIdentity, nowMs: number): void {
    this.database.prepare(`INSERT INTO session_activity (host, session_id, active_at) VALUES (?, ?, ?)
      ON CONFLICT (host, session_id) DO UPDATE SET active_at = max(active_at, excluded.active_at)`)
      .run(target.host, target.sessionId, iso(nowMs));
  }

  /** Sender quota first, then the global pool; call inside the caller's transaction after prune. */
  private assertReceiptCapacity(sender: SessionIdentity, suffix: string): void {
    const owned = this.database.prepare("SELECT count(*) AS count, min(expires_at) AS earliest FROM prepared_messages WHERE receipt IS NOT NULL AND sender_host = ? AND sender_session_id = ?")
      .get(sender.host, sender.sessionId) as { count: number; earliest: string | null };
    if (owned.count >= MESSAGE_SENDER_RECEIPT_LIMIT) {
      throw new MessageCapacityError(`The bounded message receipt store is full for this sender${suffix}`, { scope: "sender", earliestReleaseAt: owned.earliest });
    }
    const all = this.database.prepare("SELECT count(*) AS count, min(expires_at) AS earliest FROM prepared_messages WHERE receipt IS NOT NULL")
      .get() as { count: number; earliest: string | null };
    if (all.count >= MESSAGE_RECEIPT_LIMIT) throw new MessageCapacityError(`The bounded message receipt store is full${suffix}`, { scope: "global", earliestReleaseAt: all.earliest });
  }

  /** Preparation is durable but has no queue, peer-relation or wake effect. */
  prepare(input: { sender: SessionIdentity; target: SessionIdentity; body: string; ttlSeconds?: number }, nowMs = Date.now()): { messageId: string; preparedAt: string; expiresAt: string } {
    boundedIdentity(input.sender);
    boundedIdentity(input.target);
    const ttlSeconds = input.ttlSeconds ?? MESSAGE_TTL_DEFAULT_SECONDS;
    if (typeof input.body !== "string" || !input.body.trim() || Buffer.byteLength(input.body, "utf8") > MESSAGE_BODY_MAX_BYTES) throw new Error("body must contain 1-4096 UTF-8 bytes.");
    if (input.body.includes("\0")) throw new Error("body must not contain NUL characters.");
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > MESSAGE_TTL_MAX_SECONDS) throw new Error("ttlSeconds must be an integer from 30 to 86400.");
    const result = { messageId: randomUUID(), preparedAt: iso(nowMs), expiresAt: iso(nowMs + MESSAGE_DRAFT_TTL_MS) };
    const recordBytes = Buffer.byteLength(JSON.stringify({ ...input, ttlSeconds, ...result }), "utf8");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.prune(nowMs);
      // Admission only; submitPrepared repeats the authoritative check.
      this.assertReceiptCapacity(input.sender, "; no draft was created.");
      const drafts = this.database.prepare("SELECT count(*) AS count FROM prepared_messages WHERE receipt IS NULL").get() as { count: number };
      const owned = this.database.prepare("SELECT count(*) AS count FROM prepared_messages WHERE receipt IS NULL AND sender_host = ? AND sender_session_id = ?").get(input.sender.host, input.sender.sessionId) as { count: number };
      const bytes = this.database.prepare("SELECT coalesce(sum(record_bytes), 0) AS bytes FROM prepared_messages").get() as { bytes: number };
      if (drafts.count >= MESSAGE_DRAFT_LIMIT || owned.count >= MESSAGE_SENDER_DRAFT_LIMIT || bytes.bytes + recordBytes > MESSAGE_ID_RECORD_BYTES_LIMIT) throw new Error("The bounded message preparation store is full.");
      this.database.prepare(`INSERT INTO prepared_messages (message_id, sender_host, sender_session_id, target_host, target_session_id, body, ttl_seconds, prepared_at, expires_at, record_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(result.messageId, input.sender.host, input.sender.sessionId, input.target.host, input.target.sessionId, input.body, ttlSeconds, result.preparedAt, result.expiresAt, recordBytes);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** ID ownership, capacity, queue insert and first receipt share one transaction. */
  submitPrepared(sender: SessionIdentity, messageId: string, nowMs = Date.now()): {
    messageId: string; createdAt: string; expiresAt: string; duplicate: boolean; autoWake: SessionAutoWakeOutlookV1;
  } {
    boundedIdentity(sender);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.prune(nowMs);
      const row = this.database.prepare("SELECT * FROM prepared_messages WHERE message_id = ? AND sender_host = ? AND sender_session_id = ? AND expires_at > ?")
        .get(messageId, sender.host, sender.sessionId, iso(nowMs)) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Issued message ID is unavailable; delivery may be unknown. Compare saved receipts/status; prepare only a new intent.");
      const target = { host: String(row.target_host), sessionId: String(row.target_session_id) };
      if (row.receipt !== null) {
        const receipt = JSON.parse(String(row.receipt)) as { messageId: string; createdAt: string; expiresAt: string };
        const autoWake = this.autoWakeOutlook(target, nowMs);
        this.database.exec("COMMIT");
        return { ...receipt, duplicate: true, autoWake };
      }
      this.assertReceiptCapacity(sender, ".");
      const receipt = this.send({ messageId, sender, target, body: String(row.body), ttlSeconds: Number(row.ttl_seconds) }, nowMs);
      const receiptJson = JSON.stringify({ messageId: receipt.messageId, createdAt: receipt.createdAt, expiresAt: receipt.expiresAt });
      const expiresAt = iso(Date.parse(receipt.expiresAt) + MESSAGE_RECEIPT_EXTRA_MS);
      const recordBytes = Buffer.byteLength(JSON.stringify({ messageId, sender, target: { host: row.target_host, sessionId: row.target_session_id }, preparedAt: row.prepared_at, ttlSeconds: row.ttl_seconds, receipt: receiptJson, expiresAt }), "utf8");
      const bytes = this.database.prepare("SELECT coalesce(sum(record_bytes), 0) AS bytes, min(expires_at) AS earliest FROM prepared_messages WHERE message_id <> ?").get(messageId) as { bytes: number; earliest: string | null };
      if (bytes.bytes + recordBytes > MESSAGE_ID_RECORD_BYTES_LIMIT) throw new MessageCapacityError("The bounded message receipt store is full.", { scope: "global", earliestReleaseAt: bytes.earliest });
      this.database.prepare("UPDATE prepared_messages SET body = NULL, receipt = ?, expires_at = ?, record_bytes = ? WHERE message_id = ?")
        .run(receiptJson, expiresAt, recordBytes, messageId);
      const autoWake = this.autoWakeOutlook(target, nowMs);
      this.database.exec("COMMIT");
      return { ...receipt, autoWake };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Internal queue primitive, also retained for existing-data fixtures; public send uses submitPrepared. */
  send(input: {
    messageId?: string;
    sender: SessionIdentity;
    target: SessionIdentity;
    body: string;
    ttlSeconds?: number;
  }, nowMs = Date.now()): { messageId: string; createdAt: string; expiresAt: string; duplicate: boolean } {
    boundedIdentity(input.sender);
    boundedIdentity(input.target);
    const bodyBytes = Buffer.byteLength(input.body, "utf8");
    if (input.body.includes("\0")) throw new Error("body must not contain NUL characters.");
    if (!input.body.trim() || bodyBytes > MESSAGE_BODY_MAX_BYTES) throw new Error(`body must contain 1-${MESSAGE_BODY_MAX_BYTES} UTF-8 bytes.`);
    const ttlSeconds = input.ttlSeconds ?? MESSAGE_TTL_DEFAULT_SECONDS;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > MESSAGE_TTL_MAX_SECONDS) {
      throw new Error(`ttlSeconds must be an integer from 30 to ${MESSAGE_TTL_MAX_SECONDS}.`);
    }
    const messageId = input.messageId ?? randomUUID();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(messageId)) throw new Error("messageId must be 8-128 safe identifier characters.");
    this.prune(nowMs);
    const existing = this.database.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId) as Record<string, unknown> | undefined;
    if (existing) {
      const same = existing.sender_host === input.sender.host
        && existing.sender_session_id === input.sender.sessionId
        && existing.target_host === input.target.host
        && existing.target_session_id === input.target.sessionId
        && existing.body === input.body
        && Date.parse(String(existing.expires_at)) - Date.parse(String(existing.created_at)) === ttlSeconds * 1000;
      if (!same) throw new Error("messageId already belongs to a different message.");
      return { messageId, createdAt: String(existing.created_at), expiresAt: String(existing.expires_at), duplicate: true };
    }
    const totals = this.database.prepare("SELECT count(*) AS count, coalesce(sum(body_bytes), 0) AS bytes FROM messages WHERE acknowledged_at IS NULL AND expires_at > ?").get(iso(nowMs)) as { count: number; bytes: number };
    if (totals.count >= MESSAGE_LIMIT || totals.bytes + bodyBytes > MESSAGE_BYTES_LIMIT) throw new Error("The bounded message spool is full.");
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
      throw new Error(`maxMessages must be an integer from 1 to ${CLAIM_MAX_MESSAGES}.`);
    }
    if (!Number.isInteger(maxBodyChars) || maxBodyChars < 1 || maxBodyChars > SESSION_MESSAGE_MAX_RESPONSE_BYTES) {
      throw new Error(`maxBodyChars must be an integer from 1 to ${SESSION_MESSAGE_MAX_RESPONSE_BYTES}.`);
    }
    const now = iso(nowMs);
    const statement = this.database.prepare(`UPDATE messages SET claimed_at = ?, claim_until = ?,
      delivery_attempts = delivery_attempts + 1,
      first_delivered_at = CASE WHEN delivery_attempts = 0 THEN COALESCE(first_delivered_at, ?) ELSE first_delivered_at END
      WHERE message_id = ? AND acknowledged_at IS NULL AND (claim_until IS NULL OR claim_until <= ?)`);
    const rows = this.database.prepare(`SELECT * FROM messages
        WHERE target_host = ? AND target_session_id = ? AND acknowledged_at IS NULL
          AND expires_at > ? AND (claim_until IS NULL OR claim_until <= ?)
        ORDER BY created_at ASC LIMIT ?`).all(target.host, target.sessionId, now, now, maxMessages) as Array<Record<string, unknown>>;
    const selected: Array<Record<string, unknown>> = [];
    const projected: SessionMessage[] = [];
    let bodyChars = 0;
    for (const row of rows) {
      const attempts = Number(row.delivery_attempts ?? 0);
      const firstDeliveredAt = row.first_delivered_at ? String(row.first_delivered_at) : attempts === 0 ? now : null;
      const message = claimedMessage(row, attempts + 1, firstDeliveredAt);
      const next = [...projected, message];
      if (bodyChars + message.body.length > maxBodyChars || claimResponseBytes(next) > SESSION_MESSAGE_MAX_RESPONSE_BYTES) {
        if (selected.length === 0) throw new Error("The next message exceeds the caller claim budget.");
        break;
      }
      selected.push(row);
      projected.push(message);
      bodyChars += message.body.length;
    }
    return selected.flatMap((row) => {
      const attempts = Number(row.delivery_attempts ?? 0);
      const leaseMs = Math.min(CLAIM_LEASE_MAX_MS, CLAIM_LEASE_BASE_MS * 2 ** Math.min(attempts, 4));
      const firstDeliveredAt = row.first_delivered_at ? String(row.first_delivered_at) : attempts === 0 ? now : null;
      return statement.run(now, iso(nowMs + leaseMs), now, String(row.message_id), now).changes === 1
        ? [claimedMessage(row, attempts + 1, firstDeliveredAt)]
        : [];
    });
  }

  private consumePendingWakes(target: SessionIdentity, nowMs: number): void {
    const now = iso(nowMs);
    this.database.prepare(`UPDATE wake_nonces SET consumed_at = ?
      WHERE host = ? AND session_id = ? AND state = 'legacy' AND consumed_at IS NULL AND expires_at > ?`)
      .run(now, target.host, target.sessionId, now);
  }

  claim(target: SessionIdentity, nowMs = Date.now(), limits: ClaimLimits = {}): SessionMessage[] {
    boundedIdentity(target);
    this.prune(nowMs);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const claimed = this.claimLocked(target, nowMs, limits);
      if (claimed.length > 0) this.consumePendingWakes(target, nowMs);
      this.recordActivity(target, nowMs);
      this.database.exec("COMMIT");
      return claimed;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimWake(target: SessionIdentity, nonces: string[], nowMs = Date.now(), limits: ClaimLimits = {}): { recognized: boolean; messages: SessionMessage[] } {
    boundedIdentity(target);
    if (nonces.length < 1 || nonces.length > 10 || nonces.some((nonce) => nonce.length < 16 || nonce.length > 200)) {
      throw new Error("wake nonces are invalid.");
    }
    const digests = [...new Set(nonces.map(nonceDigest))];
    this.prune(nowMs);
    const now = iso(nowMs);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const recognized = digests.every((digest) => Boolean(this.database.prepare(`SELECT 1 FROM wake_nonces
        WHERE nonce_digest = ? AND host = ? AND session_id = ? AND state = 'legacy' AND consumed_at IS NULL AND expires_at > ?`)
        .get(digest, target.host, target.sessionId, now)));
      if (!recognized) {
        this.database.exec("COMMIT");
        return { recognized: false, messages: [] };
      }
      const messages = this.claimLocked(target, nowMs, limits);
      const consume = this.database.prepare("UPDATE wake_nonces SET consumed_at = ? WHERE nonce_digest = ? AND consumed_at IS NULL");
      for (const digest of digests) consume.run(now, digest);
      this.database.exec("COMMIT");
      return { recognized: true, messages };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  observeNativeInput(target: SessionIdentity, nowMs = Date.now()): void {
    boundedIdentity(target);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO input_observations (host, session_id, deferred_tool_claim, observed_at)
        VALUES (?, ?, 1, ?) ON CONFLICT (host, session_id) DO UPDATE SET deferred_tool_claim = 1, observed_at = excluded.observed_at`)
        .run(target.host, target.sessionId, iso(nowMs));
      this.recordActivity(target, nowMs);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  claimDeferred(target: SessionIdentity, nowMs = Date.now(), limits: ClaimLimits = {}): SessionMessage[] {
    boundedIdentity(target);
    this.prune(nowMs);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const skipped = this.database.prepare(`UPDATE input_observations SET deferred_tool_claim = 0
        WHERE host = ? AND session_id = ? AND deferred_tool_claim = 1`).run(target.host, target.sessionId).changes === 1;
      const messages = skipped ? [] : this.claimLocked(target, nowMs, limits);
      if (messages.length > 0) this.consumePendingWakes(target, nowMs);
      this.recordActivity(target, nowMs);
      this.database.exec("COMMIT");
      return messages;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimTurnEnd(target: SessionIdentity, nowMs = Date.now(), limits: ClaimLimits = {}): SessionMessage[] {
    boundedIdentity(target);
    this.prune(nowMs);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM input_observations WHERE host = ? AND session_id = ?").run(target.host, target.sessionId);
      const messages = this.claimLocked(target, nowMs, limits);
      if (messages.length > 0) this.consumePendingWakes(target, nowMs);
      this.recordActivity(target, nowMs);
      this.database.exec("COMMIT");
      return messages;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  clearDeferred(target: SessionIdentity, nowMs = Date.now()): void {
    boundedIdentity(target);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM input_observations WHERE host = ? AND session_id = ?").run(target.host, target.sessionId);
      this.recordActivity(target, nowMs);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  acknowledge(target: SessionIdentity, messageIds: string[], nowMs = Date.now()): number {
    boundedIdentity(target);
    if (messageIds.length < 1 || messageIds.length > 50 || messageIds.some((id) => typeof id !== "string" || id.length > 128)) {
      throw new Error("messageIds must contain 1-50 bounded identifiers.");
    }
    const statement = this.database.prepare(`UPDATE messages SET acknowledged_at = ?, claim_until = NULL
      WHERE message_id = ? AND target_host = ? AND target_session_id = ? AND acknowledged_at IS NULL`);
    // Only the first ACK shortens the receipt, and min() never extends it.
    const receipt = this.database.prepare("UPDATE prepared_messages SET expires_at = min(expires_at, ?) WHERE message_id = ? AND receipt IS NOT NULL");
    let count = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const messageId of new Set(messageIds)) {
        if (statement.run(iso(nowMs), messageId, target.host, target.sessionId).changes !== 1) continue;
        receipt.run(iso(nowMs + MESSAGE_RECEIPT_EXTRA_MS), messageId);
        count++;
      }
      this.recordActivity(target, nowMs);
      this.database.exec("COMMIT");
      return count;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  status(sender: SessionIdentity, messageId: string, nowMs = Date.now()): Record<string, unknown> | null {
    boundedIdentity(sender);
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
      wake: this.managedWakeStatus({ host: String(row.target_host), sessionId: String(row.target_session_id) }, nowMs),
      autoWake: row.acknowledged_at ? null : this.autoWakeOutlook({ host: String(row.target_host), sessionId: String(row.target_session_id) }, nowMs),
    };
  }

  /** Metadata only; peer relation is not work completion or permission. */
  peerWaitState(sender: SessionIdentity, target: SessionIdentity, nowMs = Date.now()): { related: boolean; fingerprint: string } {
    boundedIdentity(sender);
    boundedIdentity(target);
    const rows = this.database.prepare(`SELECT message_id, sender_host, sender_session_id, target_host, target_session_id,
      created_at, claimed_at, acknowledged_at, delivery_attempts, first_delivered_at FROM messages
      WHERE expires_at > ? AND ((sender_host = ? AND sender_session_id = ? AND target_host = ? AND target_session_id = ?)
        OR (sender_host = ? AND sender_session_id = ? AND target_host = ? AND target_session_id = ?))
      ORDER BY created_at DESC, message_id DESC LIMIT 20`)
      .all(iso(nowMs), sender.host, sender.sessionId, target.host, target.sessionId, target.host, target.sessionId, sender.host, sender.sessionId);
    return { related: rows.length > 0, fingerprint: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
  }

  liveRelay(target: SessionIdentity, transport: string, nowMs = Date.now()): { relayId: string; pid: number; parentPid: number; updatedAt: string } | null {
    boundedIdentity(target);
    const row = this.database.prepare("SELECT relay_id, pid, parent_pid, updated_at FROM relay_leases WHERE host = ? AND session_id = ? AND transport = ? AND lease_until > ?")
      .get(target.host, target.sessionId, transport, iso(nowMs)) as { relay_id: string; pid: number; parent_pid: number; updated_at: string } | undefined;
    return row ? { relayId: row.relay_id, pid: row.pid, parentPid: row.parent_pid, updatedAt: row.updated_at } : null;
  }

  /**
   * Advisory view of the recipient's idle auto-wake path, read from stored presence, relay lease and wake rows.
   * Callers prune first so due retirements are visible. It grants nothing and proves no delivery.
   */
  autoWakeOutlook(target: SessionIdentity, nowMs = Date.now()): SessionAutoWakeOutlookV1 {
    boundedIdentity(target);
    const now = iso(nowMs);
    const outlook = (state: SessionAutoWakeOutlookV1["state"], reason: SessionAutoWakeOutlookV1["reason"], basisAt: unknown): SessionAutoWakeOutlookV1 =>
      ({ state, reason, basisAt: basisAt === null || basisAt === undefined ? null : String(basisAt), checkedAt: now, authorityEffect: "none" });
    const presence = this.presence(target, nowMs);
    if (presence.state === "unknown") return outlook("no-live-relay", "presence-unknown", null);
    const capabilities = presence.deliveryCapabilities;
    if (capabilities.idleWake === "none" || !capabilities.supportedInjection.includes("peer-wake")) return outlook("unsupported", "no-idle-wake", presence.startedAt);
    if (presence.state !== "online") return outlook("no-live-relay", "presence-not-online", presence.endedAt ?? presence.leaseUntil);
    const relay = this.liveRelay(target, presence.transport!, nowMs);
    if (!relay) return outlook("no-live-relay", "relay-lease-missing", presence.heartbeatAt);
    const active = this.database.prepare(`SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AND state IN ${ACTIVE_WAKE_STATES}`)
      .get(target.host, target.sessionId) as Record<string, unknown> | undefined;
    if (active) {
      const current = active.instance_id === presence.instanceId && active.birth_generation === presence.startedAt && active.transport === presence.transport;
      return current && String(active.expires_at) > now ? outlook("available", "wake-in-flight", active.expires_at)
        : outlook("latched", "wake-unobserved", active.expires_at);
    }
    const legacy = this.database.prepare(`SELECT expires_at FROM wake_nonces WHERE host = ? AND session_id = ?
      AND state = 'legacy' AND consumed_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`).get(target.host, target.sessionId, now) as { expires_at: string } | undefined;
    if (legacy) return outlook("available", "wake-in-flight", legacy.expires_at);
    const cooldown = this.database.prepare(`SELECT max(retry_not_before) AS until FROM wake_nonces WHERE host = ? AND session_id = ?
      AND state = 'not-submitted' AND retry_not_before > ?`).get(target.host, target.sessionId, now) as { until: string | null };
    if (cooldown.until !== null) return outlook("available", "retry-backoff", cooldown.until);
    return outlook("available", "relay-live", relay.updatedAt);
  }

  pendingCount(target: SessionIdentity, nowMs = Date.now()): number {
    boundedIdentity(target);
    this.prune(nowMs);
    const now = iso(nowMs);
    const row = this.database.prepare(`SELECT count(*) AS count FROM messages
      WHERE target_host = ? AND target_session_id = ? AND acknowledged_at IS NULL AND expires_at > ?
        AND (claim_until IS NULL OR claim_until <= ?)`)
      .get(target.host, target.sessionId, now, now) as { count: number };
    return row.count;
  }

  acquireRelay(input: SessionIdentity & { transport: string; relayId: string; pid: number; parentPid: number }, nowMs = Date.now()): boolean {
    boundedIdentity(input);
    if (!input.transport || input.transport.length > 64 || !input.relayId || input.relayId.length > 128) throw new Error("Invalid relay identity.");
    this.prune(nowMs);
    const now = iso(nowMs);
    const until = iso(nowMs + RELAY_LEASE_MS);
    const result = this.database.prepare(`INSERT INTO relay_leases
      (host, session_id, transport, relay_id, pid, parent_pid, lease_until, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (host, session_id, transport) DO UPDATE SET
        relay_id = excluded.relay_id, pid = excluded.pid, parent_pid = excluded.parent_pid,
        lease_until = excluded.lease_until, updated_at = excluded.updated_at
      WHERE relay_leases.lease_until <= excluded.updated_at
        OR relay_leases.relay_id = excluded.relay_id
        OR relay_leases.parent_pid = excluded.parent_pid`)
      .run(input.host, input.sessionId, input.transport, input.relayId, input.pid, input.parentPid, until, now);
    return result.changes === 1;
  }

  heartbeatRelay(input: SessionIdentity & { transport: string; relayId: string }, nowMs = Date.now()): boolean {
    const result = this.database.prepare(`UPDATE relay_leases SET lease_until = ?, updated_at = ?
      WHERE host = ? AND session_id = ? AND transport = ? AND relay_id = ?`)
      .run(iso(nowMs + RELAY_LEASE_MS), iso(nowMs), input.host, input.sessionId, input.transport, input.relayId);
    return result.changes === 1;
  }

  /** One relay cycle; an old generation cannot renew either lease. */
  relayTick(input: SessionIdentity & { transport: string; relayId: string; instanceId: string; includePending: boolean }, nowMs = Date.now()): { alive: boolean; count: number } {
    boundedIdentity(input);
    if (!input.transport || input.transport.length > 64 || !input.relayId || input.relayId.length > 128 || !input.instanceId || input.instanceId.length > 128 || typeof input.includePending !== "boolean") throw new Error("Invalid relay tick identity or includePending.");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const presence = this.presence(input, nowMs);
      const relay = this.liveRelay(input, input.transport, nowMs);
      if (presence.state !== "online" || presence.instanceId !== input.instanceId || presence.transport !== input.transport || relay?.relayId !== input.relayId) {
        this.database.exec("ROLLBACK");
        return { alive: false, count: 0 };
      }
      this.heartbeatRelay(input, nowMs);
      this.heartbeatPresence(input, input.instanceId, nowMs);
      const count = input.includePending ? this.pendingCount(input, nowMs) : 0;
      this.database.exec("COMMIT");
      return { alive: true, count };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  reserveWake(target: SessionIdentity, nonce: string, nowMs = Date.now()): boolean {
    boundedIdentity(target);
    if (nonce.length < 16 || nonce.length > 200) throw new Error("Invalid wake nonce.");
    this.prune(nowMs);
    const now = iso(nowMs);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const outstanding = this.database.prepare(`SELECT 1 FROM wake_nonces
        WHERE host = ? AND session_id = ? AND (state IN ('reserved', 'started', 'submitted', 'unknown')
          OR (state = 'legacy' AND consumed_at IS NULL AND expires_at > ?)) LIMIT 1`)
        .get(target.host, target.sessionId, now);
      const delivering = this.database.prepare(`SELECT 1 FROM messages
        WHERE target_host = ? AND target_session_id = ? AND acknowledged_at IS NULL
          AND expires_at > ? AND claim_until > ? LIMIT 1`)
        .get(target.host, target.sessionId, now, now);
      const claimable = this.database.prepare(`SELECT 1 FROM messages
        WHERE target_host = ? AND target_session_id = ? AND acknowledged_at IS NULL
          AND expires_at > ? AND (claim_until IS NULL OR claim_until <= ?) LIMIT 1`)
        .get(target.host, target.sessionId, now, now);
      if (outstanding || delivering || !claimable) {
        this.database.exec("COMMIT");
        return false;
      }
      this.database.prepare("INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at) VALUES (?, ?, ?, ?)")
        .run(nonceDigest(nonce), target.host, target.sessionId, iso(nowMs + WAKE_TTL_MS));
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseWake(target: SessionIdentity, nonce: string): boolean {
    boundedIdentity(target);
    if (nonce.length < 16 || nonce.length > 200) throw new Error("Invalid wake nonce.");
    return this.database.prepare(`DELETE FROM wake_nonces
      WHERE nonce_digest = ? AND host = ? AND session_id = ? AND state = 'legacy' AND consumed_at IS NULL`)
      .run(nonceDigest(nonce), target.host, target.sessionId).changes === 1;
  }

  /** Board classification checks ownership; only the host hook can record observation. */
  consumeWake(target: SessionIdentity, nonce: string, nowMs = Date.now()): boolean {
    boundedIdentity(target);
    return Boolean(this.database.prepare(`SELECT 1 FROM wake_nonces
      WHERE nonce_digest = ? AND host = ? AND session_id = ? AND expires_at > ?`)
      .get(nonceDigest(nonce), target.host, target.sessionId, iso(nowMs)));
  }

  private wakeBindingCurrent(input: WakeRelayBinding, generation: string | null, nowMs: number): boolean {
    boundedIdentity(input);
    const presence = this.presence(input, nowMs);
    const relay = this.liveRelay(input, input.transport, nowMs);
    return presence.state === "online" && presence.instanceId === input.instanceId && presence.transport === input.transport
      && (generation === null || presence.startedAt === generation) && relay?.relayId === input.relayId
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

  reserveManagedWake(input: WakeRelayBinding & { nonce: string; resume?: boolean }, nowMs = Date.now()): WakeReservation {
    boundedIdentity(input);
    if (!/^[A-Za-z0-9_-]{22,128}$/u.test(input.nonce)) throw new Error("Invalid wake nonce.");
    for (const value of [input.instanceId, input.relayId, input.transport]) {
      if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new Error("Invalid wake relay binding.");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.prune(nowMs);
      let attempt: WakeAttempt | null = null;
      let active = this.database.prepare(`SELECT * FROM wake_nonces WHERE host = ? AND session_id = ?
        AND state IN ('reserved', 'started', 'submitted', 'unknown')`).get(input.host, input.sessionId) as Record<string, unknown> | undefined;
      const currentPending = this.wakeBindingCurrent(input, null, nowMs) && this.wakeClaimable(input, nowMs);
      if (active?.state === "reserved" && currentPending && active.late_observed_at === null
        && active.observed_at === null && active.consumed_at === null
        && ((active.dispatch_epoch === 0 && active.started_at === null)
          || (Number(active.retry_count) > 0 && active.retry_not_before !== null && active.outcome_at !== null))
        && this.wakeGenerationReplaced(this.wakeAttempt(active), nowMs)) {
        // Pre-start or exact definite-failure rows prove no effect; retain the old binding and cooldown.
        this.database.prepare(`UPDATE wake_nonces SET state = 'not-submitted', outcome_at = coalesce(outcome_at, ?)
          WHERE nonce_digest = ? AND state = 'reserved'`).run(iso(nowMs), String(active.nonce_digest));
        active = undefined;
      }
      if (active) {
        // Lease replacement fences a crashed dispatcher; uncertain external effects remain latched.
        if (active.state === "started" && !this.wakeBindingCurrent(this.wakeAttempt(active), String(active.birth_generation), nowMs)) {
          this.database.prepare("UPDATE wake_nonces SET state = 'unknown' WHERE nonce_digest = ? AND state = 'started'").run(String(active.nonce_digest));
        }
        if (active.state === "reserved" && input.resume === true
          && input.instanceId === active.instance_id && input.transport === active.transport
          && this.wakeBindingCurrent(input, String(active.birth_generation), nowMs)
          && (active.retry_not_before === null || String(active.retry_not_before) <= iso(nowMs))) {
          // Before started there is no external effect. Transfer ownership only to the current lease.
          this.database.prepare("UPDATE wake_nonces SET relay_id = ? WHERE nonce_digest = ? AND state = 'reserved'")
            .run(input.relayId, String(active.nonce_digest));
          attempt = { ...this.wakeAttempt(active), relayId: input.relayId };
        }
      } else if (currentPending) {
        const legacy = this.database.prepare(`SELECT 1 FROM wake_nonces WHERE host = ? AND session_id = ?
          AND state = 'legacy' AND consumed_at IS NULL AND expires_at > ?`).get(input.host, input.sessionId, iso(nowMs));
        const cooldown = this.database.prepare(`SELECT 1 FROM wake_nonces WHERE host = ? AND session_id = ?
          AND state = 'not-submitted' AND retry_not_before > ? LIMIT 1`).get(input.host, input.sessionId, iso(nowMs));
        if (!legacy && !cooldown) {
          const count = this.database.prepare(`SELECT count(*) AS n FROM wake_nonces
            WHERE state IN ('reserved', 'started', 'submitted', 'unknown')
              OR (state = 'not-submitted' AND retry_not_before > ?)`).get(iso(nowMs)) as { n: number };
          if (count.n >= MESSAGE_LIMIT) throw new Error("The bounded active wake store is full.");
          const generation = this.presence(input, nowMs).startedAt!;
          const attemptId = randomUUID();
          this.database.prepare(`INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at, state, nonce,
            instance_id, birth_generation, transport, relay_id, attempt_id) VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?)`)
            .run(nonceDigest(input.nonce), input.host, input.sessionId, iso(nowMs + WAKE_TTL_MS), input.nonce,
              input.instanceId, generation, input.transport, input.relayId, attemptId);
          attempt = { ...input, generation, attemptId, dispatchEpoch: 0 };
        }
      }
      this.database.exec("COMMIT");
      return { dispatch: attempt !== null, attempt };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  /** CAS succeeds once. The caller must not call a host adapter without this committed start. */
  startManagedWake(attempt: WakeAttempt, nowMs = Date.now()): WakeReservation {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`SELECT * FROM wake_nonces WHERE nonce_digest = ? AND host = ? AND session_id = ?
        AND state = 'reserved' AND instance_id = ? AND birth_generation = ? AND transport = ? AND relay_id = ? AND attempt_id = ? AND dispatch_epoch = ?`)
        .get(nonceDigest(attempt.nonce), attempt.host, attempt.sessionId, attempt.instanceId, attempt.generation,
          attempt.transport, attempt.relayId, attempt.attemptId, attempt.dispatchEpoch) as Record<string, unknown> | undefined;
      if (!row || !this.wakeBindingCurrent(attempt, attempt.generation, nowMs)
        || (row.retry_not_before !== null && String(row.retry_not_before) > iso(nowMs))) {
        this.database.exec("COMMIT"); return { dispatch: false, attempt: null };
      }
      if (String(row.expires_at) <= iso(nowMs) || !this.wakeClaimable(attempt, nowMs)) {
        this.database.prepare("UPDATE wake_nonces SET state = 'not-submitted', outcome_at = ? WHERE nonce_digest = ? AND state = 'reserved'")
          .run(iso(nowMs), nonceDigest(attempt.nonce));
        this.database.exec("COMMIT"); return { dispatch: false, attempt: null };
      }
      this.database.prepare("UPDATE wake_nonces SET state = 'started', started_at = ?, dispatch_epoch = dispatch_epoch + 1 WHERE nonce_digest = ?")
        .run(iso(nowMs), nonceDigest(attempt.nonce));
      this.database.exec("COMMIT");
      return { dispatch: true, attempt: { ...attempt, dispatchEpoch: attempt.dispatchEpoch + 1 } };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  recordManagedWakeOutcome(attempt: WakeAttempt, outcome: WakeDispatchOutcome, nowMs = Date.now()): boolean {
    if (!["submitted", "definite-failure", "accepted-or-unknown"].includes(outcome)) throw new Error("Invalid wake dispatch outcome.");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`SELECT retry_count FROM wake_nonces WHERE nonce_digest = ? AND host = ? AND session_id = ?
        AND instance_id = ? AND birth_generation = ? AND transport = ? AND relay_id = ? AND attempt_id = ? AND dispatch_epoch = ?
        AND late_observed_at IS NULL AND observed_at IS NULL AND consumed_at IS NULL
        AND state IN ('started', 'unknown')`).get(nonceDigest(attempt.nonce), attempt.host, attempt.sessionId,
          attempt.instanceId, attempt.generation, attempt.transport, attempt.relayId, attempt.attemptId, attempt.dispatchEpoch) as { retry_count: number } | undefined;
      if (!row) { this.database.exec("COMMIT"); return false; }
      const retry = outcome === "definite-failure";
      const nextState = retry ? this.wakeGenerationReplaced(attempt, nowMs) ? "not-submitted" : "reserved"
        : outcome === "submitted" ? "submitted" : "unknown";
      this.database.prepare(`UPDATE wake_nonces SET state = ?, outcome_at = ?, retry_not_before = ?, retry_count = ?
        WHERE nonce_digest = ?`).run(nextState, iso(nowMs),
          retry ? iso(nowMs + wakeBackoffDelay(row.retry_count)) : null, row.retry_count + (retry ? 1 : 0), nonceDigest(attempt.nonce));
      this.database.exec("COMMIT"); return true;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  managedWakeStatus(target: SessionIdentity, nowMs = Date.now()): Record<string, unknown> | null {
    boundedIdentity(target);
    const row = this.database.prepare(`SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AND state <> 'legacy'
      ORDER BY CASE WHEN state IN ('reserved', 'started', 'submitted', 'unknown') THEN 0 ELSE 1 END, rowid DESC LIMIT 1`)
      .get(target.host, target.sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const active = ["reserved", "started", "submitted", "unknown"].includes(String(row.state));
    const retired = row.state === "expired-unobserved";
    return { state: row.state, observation: row.state === "observed" ? "observed" : retired ? "expired-unobserved"
      : row.late_observed_at !== null ? "unknown" : active && String(row.expires_at) <= iso(nowMs) ? "observation-overdue"
      : active ? "pending" : "not-submitted",
      deliveryState: row.state === "started" || row.state === "unknown" || retired ? "unknown" : row.state,
      retiredAt: row.retired_at,
      instanceId: row.instance_id, generation: row.birth_generation, attemptId: row.attempt_id,
      dispatchEpoch: row.dispatch_epoch, retryNotBefore: row.retry_not_before, expiresAt: row.expires_at,
      observedAt: row.observed_at, lateObservedAt: row.late_observed_at };
  }

  /** Terminal-only maintenance. Historical evidence cannot claim bodies or observe a current relay. */
  reconcileHistoricalWake(target: SessionIdentity, attemptId: string, sourceReceiptId: string, nowMs = Date.now(),
    verify = verifyHistoricalWakeObservation): {
      reconciled: boolean;
      evidence: (HistoricalWakeEvidence & { oldBinding: Omit<WakeAttempt, "nonce">; lateObservedAt: string; reconciledAt: string }) | null;
    } {
    boundedIdentity(target);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(attemptId)
      || !/^source-[A-Za-z0-9-]{1,128}$/u.test(sourceReceiptId)) throw new Error("Invalid historical wake identity.");
    const rejected = { reconciled: false, evidence: null };
    const isOldGeneration = (row: Record<string, unknown>) => {
      const presence = this.presence(target, nowMs);
      return presence.instanceId !== null && presence.startedAt !== null
        && (row.instance_id !== presence.instanceId || row.birth_generation !== presence.startedAt);
    };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AND attempt_id = ?
        AND state = 'unknown' AND late_observed_at IS NOT NULL AND consumed_at IS NULL AND observed_at IS NULL`)
        .get(target.host, target.sessionId, attemptId) as Record<string, unknown> | undefined;
      if (!row || ![row.nonce, row.instance_id, row.birth_generation, row.transport, row.relay_id, row.started_at].every((value) => typeof value === "string")
        || row.nonce_digest !== nonceDigest(String(row.nonce)) || Number(row.dispatch_epoch) < 1 || !isOldGeneration(row)) {
        this.database.exec("COMMIT"); return rejected;
      }
      const proof = verify(target, String(row.nonce), sourceReceiptId, String(row.started_at), String(row.late_observed_at), nowMs);
      if (!proof || !isOldGeneration(row)) { this.database.exec("COMMIT"); return rejected; }
      // Recheck every original binding and observation field after the separate read-only trust snapshot.
      const changed = this.database.prepare(`UPDATE wake_nonces SET state = 'observed', observed_at = ?, consumed_at = ?
        WHERE nonce_digest = ? AND nonce = ? AND host = ? AND session_id = ? AND attempt_id = ?
        AND instance_id = ? AND birth_generation = ? AND transport = ? AND relay_id = ? AND dispatch_epoch = ?
        AND state = 'unknown' AND started_at = ? AND late_observed_at = ? AND consumed_at IS NULL AND observed_at IS NULL`)
        .run(proof.observedAt, iso(nowMs), String(row.nonce_digest), String(row.nonce), target.host, target.sessionId, attemptId,
          String(row.instance_id), String(row.birth_generation), String(row.transport), String(row.relay_id), Number(row.dispatch_epoch),
          String(row.started_at), String(row.late_observed_at)).changes;
      this.database.exec("COMMIT");
      if (changed !== 1) return rejected;
      const attempt = this.wakeAttempt(row);
      const oldBinding = { host: attempt.host, sessionId: attempt.sessionId, instanceId: attempt.instanceId,
        generation: attempt.generation, transport: attempt.transport, relayId: attempt.relayId,
        attemptId: attempt.attemptId, dispatchEpoch: attempt.dispatchEpoch };
      return { reconciled: true, evidence: { ...proof, oldBinding, lateObservedAt: String(row.late_observed_at), reconciledAt: iso(nowMs) } };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  /** Verified arrival retires its attempt; only current bindings may claim bodies in the same transaction. */
  claimHostWake(target: SessionIdentity, observation: InputObservation, receiptId: string, reader: WakeHookObservationReader | undefined, nowMs = Date.now(), limits: ClaimLimits = {}): {
    recognized: boolean; messages: SessionMessage[]; binding: WakeAttempt | null; retired?: true;
  } {
    boundedIdentity(target);
    const rejected = { recognized: false, messages: [], binding: null };
    if (!isWakeHookObservation(observation, target) || !reader) return rejected;
    const digests = [...new Set(observation.wakeCandidates!.map(nonceDigest))];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!reader.verifyObservation(target, observation, receiptId, nowMs)) { this.database.exec("COMMIT"); return rejected; }
      const rows = digests.map((digest) => this.database.prepare("SELECT * FROM wake_nonces WHERE nonce_digest = ? AND host = ? AND session_id = ?")
        .get(digest, target.host, target.sessionId) as Record<string, unknown> | undefined);
      if (rows.some((row) => !row || !["legacy", "started", "submitted", "unknown", "expired-unobserved"].includes(String(row.state)))) {
        this.database.exec("COMMIT"); return rejected;
      }
      this.recordActivity(target, nowMs);
      const presence = this.presence(target, nowMs);
      // A retired attempt stays retired; its verified late arrival is recorded as evidence only and it takes no part
      // in the decision, so a current marker in the same prompt still claims. Only an all-retired prompt reports retired.
      this.database.prepare(`UPDATE wake_nonces SET late_observed_at = coalesce(late_observed_at, ?)
        WHERE host = ? AND session_id = ? AND state = 'expired-unobserved' AND nonce_digest IN (SELECT value FROM json_each(?))`)
        .run(iso(nowMs), target.host, target.sessionId, JSON.stringify(digests));
      const live = rows.filter((row) => row!.state !== "expired-unobserved");
      if (live.length === 0) { this.database.exec("COMMIT"); return { ...rejected, retired: true }; }
      const valid = live.every((row) => row!.state === "legacy" ? row!.consumed_at === null && String(row!.expires_at) > iso(nowMs)
        : row!.instance_id === presence.instanceId && row!.birth_generation === presence.startedAt
          && row!.transport === presence.transport && presence.state === "online"
          && presence.deliveryCapabilities.supportedInjection.includes("peer-wake") && String(row!.expires_at) > iso(nowMs));
      if (!valid) {
        // Arrival is proven, but it cannot authorize this generation's body claim or resume evidence.
        for (const row of live) if (row!.state !== "legacy") this.database.prepare(`UPDATE wake_nonces
          SET late_observed_at = coalesce(late_observed_at, ?), state = 'observed', consumed_at = ?, observed_at = ?
          WHERE nonce_digest = ? AND state IN ('started', 'submitted', 'unknown')`)
          .run(iso(nowMs), iso(nowMs), iso(nowMs), String(row!.nonce_digest));
        this.database.exec("COMMIT"); return rejected;
      }
      const messages = this.claimLocked(target, nowMs, limits);
      let binding: WakeAttempt | null = null;
      for (const row of live) {
        if (row!.state === "legacy") this.database.prepare("UPDATE wake_nonces SET consumed_at = ? WHERE nonce_digest = ?").run(iso(nowMs), String(row!.nonce_digest));
        else {
          this.database.prepare("UPDATE wake_nonces SET state = 'observed', consumed_at = ?, observed_at = ? WHERE nonce_digest = ?")
            .run(iso(nowMs), iso(nowMs), String(row!.nonce_digest));
          binding = this.wakeAttempt(row!);
        }
      }
      this.database.exec("COMMIT"); return { recognized: true, messages, binding };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
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
  }, nowMs = Date.now()): SessionPresence {
    boundedIdentity(input);
    if (!input.instanceId || input.instanceId.length > 128 || !input.transport || input.transport.length > 64) throw new Error("Invalid presence identity.");
    for (const [name, value, maximum] of [
      ["collaborationId", input.collaborationId, 200],
      ["workspaceId", input.workspaceId, 500],
      ["role", input.role, 100],
    ] as const) {
      if (value !== undefined && (!value || value.length > maximum)) throw new Error(`${name} is invalid.`);
    }
    const now = iso(nowMs);
    this.database.prepare(`INSERT INTO session_presence (
      host, session_id, instance_id, transport, wake_visibility, can_wake_silently, supported_injection, idle_wake,
      collaboration_id, workspace_id, role, started_at, heartbeat_at, lease_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      ended_at = NULL, end_reason = NULL`).run(
      input.host, input.sessionId, input.instanceId, input.transport, input.wakeVisibility,
      input.canWakeSilently ? 1 : 0, JSON.stringify(input.deliveryCapabilities?.supportedInjection ?? []),
      input.deliveryCapabilities?.idleWake ?? input.wakeVisibility, input.collaborationId ?? null, input.workspaceId ?? null,
      input.role ?? null, now, now, iso(nowMs + PRESENCE_LEASE_MS),
    );
    return this.presence(input, nowMs);
  }

  heartbeatPresence(target: SessionIdentity, instanceId: string, nowMs = Date.now()): boolean {
    boundedIdentity(target);
    if (!instanceId) throw new Error("presence instanceId is required.");
    const row = this.database.prepare(`SELECT instance_id FROM session_presence
      WHERE host = ? AND session_id = ? AND instance_id = ? AND ended_at IS NULL AND lease_until > ?`).get(target.host, target.sessionId, instanceId, iso(nowMs));
    const selected = row as { instance_id: string } | undefined;
    if (!selected) return false;
    const now = iso(nowMs);
    return this.database.prepare(`UPDATE session_presence SET heartbeat_at = ?, lease_until = ?
      WHERE host = ? AND session_id = ? AND instance_id = ? AND ended_at IS NULL AND lease_until > ?`)
      .run(now, iso(nowMs + PRESENCE_LEASE_MS), target.host, target.sessionId, selected.instance_id, now).changes === 1;
  }

  endPresence(target: SessionIdentity, reason: string, instanceId: string, nowMs = Date.now()): boolean {
    boundedIdentity(target);
    if (!reason || reason.length > 100) throw new Error("endReason is invalid.");
    if (!instanceId) throw new Error("presence instanceId is required.");
    const row = this.database.prepare(`SELECT instance_id FROM session_presence
      WHERE host = ? AND session_id = ? AND instance_id = ? AND ended_at IS NULL`).get(target.host, target.sessionId, instanceId);
    const selected = row as { instance_id: string } | undefined;
    if (!selected) return false;
    const now = iso(nowMs);
    return this.database.prepare(`UPDATE session_presence SET heartbeat_at = ?, lease_until = ?, ended_at = ?, end_reason = ?
      WHERE host = ? AND session_id = ? AND instance_id = ? AND ended_at IS NULL`)
      .run(now, now, now, reason, target.host, target.sessionId, selected.instance_id).changes === 1;
  }

  presence(target: SessionIdentity, nowMs = Date.now()): SessionPresence {
    boundedIdentity(target);
    const row = this.database.prepare(`SELECT * FROM session_presence
      WHERE host = ? AND session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`)
      .get(target.host, target.sessionId) as Record<string, unknown> | undefined;
    if (!row) return {
      ...target, instanceId: null, transport: null, wakeVisibility: "none", canWakeSilently: false,
      deliveryCapabilities: { supportedInjection: [], idleWake: "none" },
      collaborationId: null, workspaceId: null, role: null, startedAt: null, heartbeatAt: null,
      leaseUntil: null, endedAt: null, endReason: null, state: "unknown",
    };
    const endedAt = row.ended_at === null ? null : String(row.ended_at);
    const leaseUntil = String(row.lease_until);
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
      state: endedAt ? "ended" : Date.parse(leaseUntil) > nowMs ? "online" : "unreachable",
    };
  }

  /** Without targets every stored identity is listed (the pre-2.7.4 request); callers bound the batch themselves. */
  listPresence(nowMs = Date.now(), targets?: SessionIdentity[]): SessionPresenceView[] {
    this.prune(nowMs);
    const identities = targets ?? (this.database.prepare(`SELECT host, session_id FROM session_presence
      GROUP BY host, session_id ORDER BY host, session_id`).all() as Array<{ host: string; session_id: string }>)
      .map((row) => ({ host: row.host, sessionId: row.session_id }));
    return identities.map((target) => ({ ...this.presence(target, nowMs), autoWake: this.autoWakeOutlook(target, nowMs) }));
  }
}
