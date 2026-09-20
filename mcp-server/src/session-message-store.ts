import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { SESSION_MESSAGE_MAX_RESPONSE_BYTES } from "./session-message-protocol.js";

export const MESSAGE_BODY_MAX_BYTES = 4096;
export const MESSAGE_TTL_DEFAULT_SECONDS = 3600;
export const MESSAGE_TTL_MAX_SECONDS = 86400;
const MESSAGE_LIMIT = 1000;
const MESSAGE_BYTES_LIMIT = 4 * 1024 * 1024;
const CLAIM_LEASE_BASE_MS = 120_000;
const CLAIM_LEASE_MAX_MS = 30 * 60_000;
const RELAY_LEASE_MS = 15_000;
const WAKE_TTL_MS = MESSAGE_TTL_MAX_SECONDS * 1000;
const CLAIM_MAX_MESSAGES = 10;

export interface SessionIdentity {
  host: string;
  sessionId: string;
}

export interface SessionMessage {
  messageId: string;
  sender: SessionIdentity;
  body: string;
  createdAt: string;
  expiresAt: string;
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function nonceDigest(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

function boundedIdentity(value: SessionIdentity): void {
  if (!value.host || value.host.length > 64 || !value.sessionId || value.sessionId.length > 200) {
    throw new Error("A host and bounded sessionId are required.");
  }
}

function claimedMessage(row: Record<string, unknown>): SessionMessage {
  return {
    messageId: String(row.message_id),
    sender: { host: String(row.sender_host), sessionId: String(row.sender_session_id) },
    body: String(row.body),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
  };
}

function claimResponseBytes(messages: SessionMessage[]): number {
  return Buffer.byteLength(JSON.stringify({ ok: true, data: { messages } }), "utf8") + 1;
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
    ) STRICT;`);
    const messageColumns = this.database.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!messageColumns.some((column) => column.name === "delivery_attempts")) {
      this.database.exec("ALTER TABLE messages ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;");
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
    this.database.prepare("DELETE FROM wake_nonces WHERE expires_at <= ?").run(now);
  }

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

  claim(target: SessionIdentity, nowMs = Date.now(), limits: ClaimLimits = {}): SessionMessage[] {
    boundedIdentity(target);
    const maxMessages = limits.maxMessages ?? CLAIM_MAX_MESSAGES;
    const maxBodyChars = limits.maxBodyChars ?? SESSION_MESSAGE_MAX_RESPONSE_BYTES;
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > CLAIM_MAX_MESSAGES) {
      throw new Error(`maxMessages must be an integer from 1 to ${CLAIM_MAX_MESSAGES}.`);
    }
    if (!Number.isInteger(maxBodyChars) || maxBodyChars < 1 || maxBodyChars > SESSION_MESSAGE_MAX_RESPONSE_BYTES) {
      throw new Error(`maxBodyChars must be an integer from 1 to ${SESSION_MESSAGE_MAX_RESPONSE_BYTES}.`);
    }
    this.prune(nowMs);
    const now = iso(nowMs);
    const rows = this.database.prepare(`SELECT * FROM messages
      WHERE target_host = ? AND target_session_id = ? AND acknowledged_at IS NULL
        AND expires_at > ? AND (claim_until IS NULL OR claim_until <= ?)
      ORDER BY created_at ASC LIMIT ?`).all(target.host, target.sessionId, now, now, maxMessages) as Array<Record<string, unknown>>;
    const selected: Array<Record<string, unknown>> = [];
    const projected: SessionMessage[] = [];
    let bodyChars = 0;
    for (const row of rows) {
      const message = claimedMessage(row);
      const next = [...projected, message];
      if (bodyChars + message.body.length > maxBodyChars || claimResponseBytes(next) > SESSION_MESSAGE_MAX_RESPONSE_BYTES) {
        if (selected.length === 0) throw new Error("The next message exceeds the caller claim budget.");
        break;
      }
      selected.push(row);
      projected.push(message);
      bodyChars += message.body.length;
    }
    if (selected.length === 0) return [];
    const statement = this.database.prepare("UPDATE messages SET claimed_at = ?, claim_until = ?, delivery_attempts = delivery_attempts + 1 WHERE message_id = ? AND acknowledged_at IS NULL AND (claim_until IS NULL OR claim_until <= ?)");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const claimed = selected.filter((row) => {
        const attempts = Number(row.delivery_attempts ?? 0);
        const leaseMs = Math.min(CLAIM_LEASE_MAX_MS, CLAIM_LEASE_BASE_MS * 2 ** Math.min(attempts, 4));
        return statement.run(now, iso(nowMs + leaseMs), String(row.message_id), now).changes === 1;
      });
      this.database.exec("COMMIT");
      return claimed.map(claimedMessage);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  acknowledge(target: SessionIdentity, messageIds: string[], nowMs = Date.now()): number {
    boundedIdentity(target);
    if (messageIds.length < 1 || messageIds.length > 50 || messageIds.some((id) => typeof id !== "string" || id.length > 128)) {
      throw new Error("messageIds must contain 1-50 bounded identifiers.");
    }
    const statement = this.database.prepare(`UPDATE messages SET acknowledged_at = ?, claim_until = NULL
      WHERE message_id = ? AND target_host = ? AND target_session_id = ? AND acknowledged_at IS NULL`);
    let count = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const messageId of new Set(messageIds)) count += Number(statement.run(iso(nowMs), messageId, target.host, target.sessionId).changes);
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
      claimed_at, acknowledged_at FROM messages WHERE message_id = ? AND sender_host = ? AND sender_session_id = ?`)
      .get(messageId, sender.host, sender.sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      messageId: row.message_id,
      target: { host: row.target_host, sessionId: row.target_session_id },
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      claimedAt: row.claimed_at ?? null,
      acknowledgedAt: row.acknowledged_at ?? null,
      state: row.acknowledged_at ? "acknowledged" : row.claimed_at ? "delivered" : "queued",
    };
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
      WHERE relay_leases.lease_until <= excluded.updated_at OR relay_leases.relay_id = excluded.relay_id`)
      .run(input.host, input.sessionId, input.transport, input.relayId, input.pid, input.parentPid, until, now);
    return result.changes === 1;
  }

  heartbeatRelay(input: SessionIdentity & { transport: string; relayId: string }, nowMs = Date.now()): boolean {
    const result = this.database.prepare(`UPDATE relay_leases SET lease_until = ?, updated_at = ?
      WHERE host = ? AND session_id = ? AND transport = ? AND relay_id = ?`)
      .run(iso(nowMs + RELAY_LEASE_MS), iso(nowMs), input.host, input.sessionId, input.transport, input.relayId);
    return result.changes === 1;
  }

  issueWake(target: SessionIdentity, nonce: string, nowMs = Date.now()): void {
    boundedIdentity(target);
    if (nonce.length < 16 || nonce.length > 200) throw new Error("Invalid wake nonce.");
    this.database.prepare("INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at) VALUES (?, ?, ?, ?)")
      .run(nonceDigest(nonce), target.host, target.sessionId, iso(nowMs + WAKE_TTL_MS));
  }

  reserveWake(target: SessionIdentity, nonce: string, nowMs = Date.now()): boolean {
    boundedIdentity(target);
    if (nonce.length < 16 || nonce.length > 200) throw new Error("Invalid wake nonce.");
    this.prune(nowMs);
    const now = iso(nowMs);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const outstanding = this.database.prepare(`SELECT 1 FROM wake_nonces
        WHERE host = ? AND session_id = ? AND consumed_at IS NULL AND expires_at > ? LIMIT 1`)
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
      WHERE nonce_digest = ? AND host = ? AND session_id = ? AND consumed_at IS NULL`)
      .run(nonceDigest(nonce), target.host, target.sessionId).changes === 1;
  }

  consumeWake(target: SessionIdentity, nonce: string, nowMs = Date.now()): boolean {
    boundedIdentity(target);
    const digest = nonceDigest(nonce);
    const now = iso(nowMs);
    const existing = this.database.prepare(`SELECT consumed_at FROM wake_nonces
      WHERE nonce_digest = ? AND host = ? AND session_id = ? AND expires_at > ?`)
      .get(digest, target.host, target.sessionId, now) as { consumed_at: string | null } | undefined;
    if (!existing) return false;
    if (existing.consumed_at === null) {
      this.database.prepare("UPDATE wake_nonces SET consumed_at = ? WHERE nonce_digest = ?").run(now, digest);
    }
    return true;
  }
}
