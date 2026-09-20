#!/usr/bin/env node

// mcp-server/src/session-message-broker.ts
import { createHash as createHash2, createPublicKey, randomBytes as randomBytes2, timingSafeEqual, X509Certificate as X509Certificate2 } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path2 from "node:path";
import tls from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// mcp-server/src/session-message-protocol.ts
var SESSION_MESSAGE_PROTOCOL = "1.0.0";
var SESSION_MESSAGE_MAX_REQUEST_BYTES = 32 * 1024;
var SESSION_MESSAGE_MAX_RESPONSE_BYTES = 32 * 1024;

// mcp-server/src/session-message-store.ts
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
var MESSAGE_BODY_MAX_BYTES = 4096;
var MESSAGE_TTL_DEFAULT_SECONDS = 3600;
var MESSAGE_TTL_MAX_SECONDS = 86400;
var MESSAGE_LIMIT = 1e3;
var MESSAGE_BYTES_LIMIT = 4 * 1024 * 1024;
var CLAIM_LEASE_BASE_MS = 12e4;
var CLAIM_LEASE_MAX_MS = 30 * 6e4;
var RELAY_LEASE_MS = 15e3;
var WAKE_TTL_MS = 60 * 6e4;
var PRESENCE_LEASE_MS = 2e4;
var CLAIM_MAX_MESSAGES = 10;
function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}
function nonceDigest(nonce) {
  return createHash("sha256").update(nonce).digest("hex");
}
function boundedIdentity(value) {
  const hostPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
  const sessionPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
  if (!hostPattern.test(value.host) || !sessionPattern.test(value.sessionId)) {
    throw new Error("host and sessionId must use bounded identifier characters.");
  }
}
function claimedMessage(row) {
  return {
    messageId: String(row.message_id),
    sender: { host: String(row.sender_host), sessionId: String(row.sender_session_id) },
    body: String(row.body),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at)
  };
}
function claimResponseBytes(messages) {
  return Buffer.byteLength(JSON.stringify({ ok: true, data: { messages } }), "utf8") + 1;
}
var SessionMessageStore = class {
  database;
  constructor(databasePath) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 448 });
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
    ) STRICT;
    CREATE TABLE IF NOT EXISTS session_presence (
      host TEXT NOT NULL,
      session_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      transport TEXT NOT NULL,
      wake_visibility TEXT NOT NULL CHECK (wake_visibility IN ('silent', 'user-message', 'none')),
      can_wake_silently INTEGER NOT NULL CHECK (can_wake_silently IN (0, 1)),
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
    const messageColumns = this.database.prepare("PRAGMA table_info(messages)").all();
    if (!messageColumns.some((column) => column.name === "delivery_attempts")) {
      this.database.exec("ALTER TABLE messages ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;");
    }
  }
  close() {
    this.database.close();
  }
  prune(nowMs = Date.now()) {
    const now = iso(nowMs);
    const acknowledgedBefore = iso(nowMs - 36e5);
    this.database.prepare("DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at IS NOT NULL AND acknowledged_at <= ?)").run(now, acknowledgedBefore);
    this.database.prepare("DELETE FROM relay_leases WHERE lease_until <= ?").run(now);
    this.database.prepare("DELETE FROM wake_nonces WHERE expires_at <= ?").run(now);
  }
  send(input, nowMs = Date.now()) {
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
    const existing = this.database.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId);
    if (existing) {
      const same = existing.sender_host === input.sender.host && existing.sender_session_id === input.sender.sessionId && existing.target_host === input.target.host && existing.target_session_id === input.target.sessionId && existing.body === input.body && Date.parse(String(existing.expires_at)) - Date.parse(String(existing.created_at)) === ttlSeconds * 1e3;
      if (!same) throw new Error("messageId already belongs to a different message.");
      return { messageId, createdAt: String(existing.created_at), expiresAt: String(existing.expires_at), duplicate: true };
    }
    const totals = this.database.prepare("SELECT count(*) AS count, coalesce(sum(body_bytes), 0) AS bytes FROM messages WHERE acknowledged_at IS NULL AND expires_at > ?").get(iso(nowMs));
    if (totals.count >= MESSAGE_LIMIT || totals.bytes + bodyBytes > MESSAGE_BYTES_LIMIT) throw new Error("The bounded message spool is full.");
    const createdAt = iso(nowMs);
    const expiresAt = iso(nowMs + ttlSeconds * 1e3);
    this.database.prepare(`INSERT INTO messages (
      message_id, sender_host, sender_session_id, target_host, target_session_id,
      body, body_bytes, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      messageId,
      input.sender.host,
      input.sender.sessionId,
      input.target.host,
      input.target.sessionId,
      input.body,
      bodyBytes,
      createdAt,
      expiresAt
    );
    return { messageId, createdAt, expiresAt, duplicate: false };
  }
  claim(target, nowMs = Date.now(), limits = {}) {
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
    const statement = this.database.prepare("UPDATE messages SET claimed_at = ?, claim_until = ?, delivery_attempts = delivery_attempts + 1 WHERE message_id = ? AND acknowledged_at IS NULL AND (claim_until IS NULL OR claim_until <= ?)");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.database.prepare(`SELECT * FROM messages
        WHERE target_host = ? AND target_session_id = ? AND acknowledged_at IS NULL
          AND expires_at > ? AND (claim_until IS NULL OR claim_until <= ?)
        ORDER BY created_at ASC LIMIT ?`).all(target.host, target.sessionId, now, now, maxMessages);
      const selected = [];
      const projected = [];
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
      if (selected.length === 0) {
        this.database.exec("COMMIT");
        return [];
      }
      const claimed = selected.filter((row) => {
        const attempts = Number(row.delivery_attempts ?? 0);
        const leaseMs = Math.min(CLAIM_LEASE_MAX_MS, CLAIM_LEASE_BASE_MS * 2 ** Math.min(attempts, 4));
        return statement.run(now, iso(nowMs + leaseMs), String(row.message_id), now).changes === 1;
      });
      if (claimed.length > 0) {
        this.database.prepare(`UPDATE wake_nonces SET consumed_at = ?
          WHERE host = ? AND session_id = ? AND consumed_at IS NULL AND expires_at > ?`).run(now, target.host, target.sessionId, now);
      }
      this.database.exec("COMMIT");
      return claimed.map(claimedMessage);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  acknowledge(target, messageIds, nowMs = Date.now()) {
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
  status(sender, messageId, nowMs = Date.now()) {
    boundedIdentity(sender);
    this.prune(nowMs);
    const row = this.database.prepare(`SELECT message_id, target_host, target_session_id, created_at, expires_at,
      claimed_at, acknowledged_at FROM messages WHERE message_id = ? AND sender_host = ? AND sender_session_id = ?`).get(messageId, sender.host, sender.sessionId);
    if (!row) return null;
    return {
      messageId: row.message_id,
      target: { host: row.target_host, sessionId: row.target_session_id },
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      claimedAt: row.claimed_at ?? null,
      acknowledgedAt: row.acknowledged_at ?? null,
      state: row.acknowledged_at ? "acknowledged" : row.claimed_at ? "delivered" : "queued"
    };
  }
  pendingCount(target, nowMs = Date.now()) {
    boundedIdentity(target);
    this.prune(nowMs);
    const now = iso(nowMs);
    const row = this.database.prepare(`SELECT count(*) AS count FROM messages
      WHERE target_host = ? AND target_session_id = ? AND acknowledged_at IS NULL AND expires_at > ?
        AND (claim_until IS NULL OR claim_until <= ?)`).get(target.host, target.sessionId, now, now);
    return row.count;
  }
  acquireRelay(input, nowMs = Date.now()) {
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
        OR relay_leases.parent_pid = excluded.parent_pid`).run(input.host, input.sessionId, input.transport, input.relayId, input.pid, input.parentPid, until, now);
    return result.changes === 1;
  }
  heartbeatRelay(input, nowMs = Date.now()) {
    const result = this.database.prepare(`UPDATE relay_leases SET lease_until = ?, updated_at = ?
      WHERE host = ? AND session_id = ? AND transport = ? AND relay_id = ?`).run(iso(nowMs + RELAY_LEASE_MS), iso(nowMs), input.host, input.sessionId, input.transport, input.relayId);
    return result.changes === 1;
  }
  reserveWake(target, nonce, nowMs = Date.now()) {
    boundedIdentity(target);
    if (nonce.length < 16 || nonce.length > 200) throw new Error("Invalid wake nonce.");
    this.prune(nowMs);
    const now = iso(nowMs);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const outstanding = this.database.prepare(`SELECT 1 FROM wake_nonces
        WHERE host = ? AND session_id = ? AND consumed_at IS NULL AND expires_at > ? LIMIT 1`).get(target.host, target.sessionId, now);
      const delivering = this.database.prepare(`SELECT 1 FROM messages
        WHERE target_host = ? AND target_session_id = ? AND acknowledged_at IS NULL
          AND expires_at > ? AND claim_until > ? LIMIT 1`).get(target.host, target.sessionId, now, now);
      const claimable = this.database.prepare(`SELECT 1 FROM messages
        WHERE target_host = ? AND target_session_id = ? AND acknowledged_at IS NULL
          AND expires_at > ? AND (claim_until IS NULL OR claim_until <= ?) LIMIT 1`).get(target.host, target.sessionId, now, now);
      if (outstanding || delivering || !claimable) {
        this.database.exec("COMMIT");
        return false;
      }
      this.database.prepare("INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at) VALUES (?, ?, ?, ?)").run(nonceDigest(nonce), target.host, target.sessionId, iso(nowMs + WAKE_TTL_MS));
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  releaseWake(target, nonce) {
    boundedIdentity(target);
    if (nonce.length < 16 || nonce.length > 200) throw new Error("Invalid wake nonce.");
    return this.database.prepare(`DELETE FROM wake_nonces
      WHERE nonce_digest = ? AND host = ? AND session_id = ? AND consumed_at IS NULL`).run(nonceDigest(nonce), target.host, target.sessionId).changes === 1;
  }
  consumeWake(target, nonce, nowMs = Date.now()) {
    boundedIdentity(target);
    const digest = nonceDigest(nonce);
    const now = iso(nowMs);
    const existing = this.database.prepare(`SELECT consumed_at FROM wake_nonces
      WHERE nonce_digest = ? AND host = ? AND session_id = ? AND expires_at > ?`).get(digest, target.host, target.sessionId, now);
    if (!existing) return false;
    if (existing.consumed_at === null) {
      const unacknowledged = this.database.prepare(`SELECT
          count(*) AS count,
          coalesce(sum(CASE WHEN claim_until > ? THEN 1 ELSE 0 END), 0) AS live_claims
        FROM messages
        WHERE target_host = ? AND target_session_id = ? AND acknowledged_at IS NULL AND expires_at > ?`).get(now, target.host, target.sessionId, now);
      if (unacknowledged.count === 0 || unacknowledged.live_claims > 0) {
        this.database.prepare("UPDATE wake_nonces SET consumed_at = ? WHERE nonce_digest = ?").run(now, digest);
      }
    }
    return true;
  }
  startPresence(input, nowMs = Date.now()) {
    boundedIdentity(input);
    if (!input.instanceId || input.instanceId.length > 128 || !input.transport || input.transport.length > 64) throw new Error("Invalid presence identity.");
    for (const [name, value, maximum] of [
      ["collaborationId", input.collaborationId, 200],
      ["workspaceId", input.workspaceId, 500],
      ["role", input.role, 100]
    ]) {
      if (value !== void 0 && (!value || value.length > maximum)) throw new Error(`${name} is invalid.`);
    }
    const now = iso(nowMs);
    this.database.prepare(`INSERT INTO session_presence (
      host, session_id, instance_id, transport, wake_visibility, can_wake_silently,
      collaboration_id, workspace_id, role, started_at, heartbeat_at, lease_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (host, session_id, instance_id) DO UPDATE SET
      transport = excluded.transport, wake_visibility = excluded.wake_visibility,
      can_wake_silently = excluded.can_wake_silently, collaboration_id = excluded.collaboration_id,
      workspace_id = excluded.workspace_id, role = excluded.role,
      heartbeat_at = excluded.heartbeat_at, lease_until = excluded.lease_until,
      ended_at = NULL, end_reason = NULL`).run(
      input.host,
      input.sessionId,
      input.instanceId,
      input.transport,
      input.wakeVisibility,
      input.canWakeSilently ? 1 : 0,
      input.collaborationId ?? null,
      input.workspaceId ?? null,
      input.role ?? null,
      now,
      now,
      iso(nowMs + PRESENCE_LEASE_MS)
    );
    return this.presence(input, nowMs);
  }
  heartbeatPresence(target, instanceId, nowMs = Date.now()) {
    boundedIdentity(target);
    if (!instanceId) throw new Error("presence instanceId is required.");
    const row = this.database.prepare(`SELECT instance_id FROM session_presence
      WHERE host = ? AND session_id = ? AND instance_id = ? AND ended_at IS NULL`).get(target.host, target.sessionId, instanceId);
    const selected = row;
    if (!selected) return false;
    const now = iso(nowMs);
    return this.database.prepare(`UPDATE session_presence SET heartbeat_at = ?, lease_until = ?
      WHERE host = ? AND session_id = ? AND instance_id = ? AND ended_at IS NULL`).run(now, iso(nowMs + PRESENCE_LEASE_MS), target.host, target.sessionId, selected.instance_id).changes === 1;
  }
  endPresence(target, reason, instanceId, nowMs = Date.now()) {
    boundedIdentity(target);
    if (!reason || reason.length > 100) throw new Error("endReason is invalid.");
    if (!instanceId) throw new Error("presence instanceId is required.");
    const row = this.database.prepare(`SELECT instance_id FROM session_presence
      WHERE host = ? AND session_id = ? AND instance_id = ? AND ended_at IS NULL`).get(target.host, target.sessionId, instanceId);
    const selected = row;
    if (!selected) return false;
    const now = iso(nowMs);
    return this.database.prepare(`UPDATE session_presence SET heartbeat_at = ?, lease_until = ?, ended_at = ?, end_reason = ?
      WHERE host = ? AND session_id = ? AND instance_id = ? AND ended_at IS NULL`).run(now, now, now, reason, target.host, target.sessionId, selected.instance_id).changes === 1;
  }
  presence(target, nowMs = Date.now()) {
    boundedIdentity(target);
    const row = this.database.prepare(`SELECT * FROM session_presence
      WHERE host = ? AND session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(target.host, target.sessionId);
    if (!row) return {
      ...target,
      instanceId: null,
      transport: null,
      wakeVisibility: "none",
      canWakeSilently: false,
      collaborationId: null,
      workspaceId: null,
      role: null,
      startedAt: null,
      heartbeatAt: null,
      leaseUntil: null,
      endedAt: null,
      endReason: null,
      state: "unknown"
    };
    const endedAt = row.ended_at === null ? null : String(row.ended_at);
    const leaseUntil = String(row.lease_until);
    return {
      host: String(row.host),
      sessionId: String(row.session_id),
      instanceId: String(row.instance_id),
      transport: String(row.transport),
      wakeVisibility: row.wake_visibility,
      canWakeSilently: Boolean(row.can_wake_silently),
      collaborationId: row.collaboration_id === null ? null : String(row.collaboration_id),
      workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
      role: row.role === null ? null : String(row.role),
      startedAt: String(row.started_at),
      heartbeatAt: String(row.heartbeat_at),
      leaseUntil,
      endedAt,
      endReason: row.end_reason === null ? null : String(row.end_reason),
      state: endedAt ? "ended" : Date.parse(leaseUntil) > nowMs ? "online" : "unreachable"
    };
  }
  listPresence(nowMs = Date.now()) {
    const identities = this.database.prepare(`SELECT host, session_id FROM session_presence
      GROUP BY host, session_id ORDER BY host, session_id`).all();
    return identities.map((row) => this.presence({ host: row.host, sessionId: row.session_id }, nowMs));
  }
};

// mcp-server/src/self-signed-certificate.ts
import { generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
function length(value) {
  if (value < 128) return Buffer.from([value]);
  if (value < 256) return Buffer.from([129, value]);
  return Buffer.from([130, value >> 8, value & 255]);
}
function tlv(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}
var sequence = (...parts) => tlv(48, ...parts);
var objectIdentifier = (hex) => tlv(6, Buffer.from(hex, "hex"));
function integer(value) {
  const firstNonZero = value.findIndex((byte) => byte !== 0);
  const body = firstNonZero < 0 ? value.subarray(-1) : value.subarray(firstNonZero);
  return tlv(2, body[0] & 128 ? Buffer.concat([Buffer.from([0]), body]) : body);
}
var utf8 = (value) => tlv(12, Buffer.from(value, "utf8"));
function certificateTime(value) {
  const digits = value.toISOString().replace(/[-:T]/gu, "").slice(0, 14);
  return value.getUTCFullYear() < 2050 ? tlv(23, Buffer.from(`${digits.slice(2)}Z`)) : tlv(24, Buffer.from(`${digits}Z`));
}
var ECDSA_WITH_SHA256 = sequence(objectIdentifier("2a8648ce3d040302"));
var COMMON_NAME = sequence(tlv(49, sequence(objectIdentifier("550403"), utf8("agent-governance-suite local broker"))));
function createSelfSignedCertificate(now = /* @__PURE__ */ new Date()) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const serialNumber = randomBytes(16);
  if (serialNumber.every((byte) => byte === 0)) serialNumber[serialNumber.length - 1] = 1;
  const notBefore = new Date(now.getTime() - 6e4);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 5);
  const subjectAlternativeNames = sequence(
    tlv(130, Buffer.from("localhost", "ascii")),
    tlv(135, Buffer.from([127, 0, 0, 1]))
  );
  const extensions = tlv(163, sequence(sequence(
    objectIdentifier("551d11"),
    tlv(4, subjectAlternativeNames)
  )));
  const toBeSigned = sequence(
    tlv(160, integer(Buffer.from([2]))),
    integer(serialNumber),
    ECDSA_WITH_SHA256,
    COMMON_NAME,
    sequence(certificateTime(notBefore), certificateTime(notAfter)),
    COMMON_NAME,
    publicKey.export({ type: "spki", format: "der" }),
    extensions
  );
  const signature = sign("sha256", toBeSigned, privateKey);
  const der = sequence(toBeSigned, ECDSA_WITH_SHA256, tlv(3, Buffer.from([0]), signature));
  const encoded = der.toString("base64").match(/.{1,64}/gu)?.join("\n") ?? "";
  const certificatePem = `-----BEGIN CERTIFICATE-----
${encoded}
-----END CERTIFICATE-----
`;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { privateKeyPem, certificatePem, fingerprint256: new X509Certificate(certificatePem).fingerprint256 };
}

// mcp-server/src/session-message-broker.ts
var IDLE_EXIT_MS = 6e4;
function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
function identity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session identity is required.");
  const record = value;
  if (typeof record.host !== "string" || typeof record.sessionId !== "string") throw new Error("Session identity is invalid.");
  return { host: record.host, sessionId: record.sessionId };
}
function string(value, name) {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}
function integer2(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}
function optionalInteger(record, name) {
  return Object.hasOwn(record, name) ? integer2(record[name], name) : void 0;
}
function optionalString(record, name) {
  return Object.hasOwn(record, name) ? string(record[name], name) : void 0;
}
function boolean(value, name) {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}
function tokenMatches(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function acquireProcessLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx", 384);
      writeFileSync(descriptor, `${process.pid}
`, "utf8");
      return descriptor;
    } catch {
      try {
        const owner = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
        if (Number.isInteger(owner) && alive(owner)) return null;
        rmSync(lockPath, { force: true });
      } catch {
        return null;
      }
    }
  }
  return null;
}
async function credentials(stateDirectory) {
  const keyPath = path2.join(stateDirectory, "broker-key.pem");
  const certificatePath = path2.join(stateDirectory, "broker-cert.pem");
  const tokenPath = path2.join(stateDirectory, "broker.token");
  let key = "";
  let certificate = "";
  let regenerate = true;
  if (existsSync(keyPath) && existsSync(certificatePath)) {
    try {
      [key, certificate] = await Promise.all([readFile(keyPath, "utf8"), readFile(certificatePath, "utf8")]);
      const parsed = new X509Certificate2(certificate);
      const privatePublic = createPublicKey(key).export({ type: "spki", format: "der" });
      const certificatePublic = parsed.publicKey.export({ type: "spki", format: "der" });
      regenerate = Date.parse(parsed.validTo) <= Date.now() + 24 * 36e5 || !privatePublic.equals(certificatePublic);
    } catch {
      regenerate = true;
    }
  }
  if (regenerate) {
    const generated = createSelfSignedCertificate();
    key = generated.privateKeyPem;
    certificate = generated.certificatePem;
    if (existsSync(keyPath) || existsSync(certificatePath)) {
      await Promise.all([
        writeFile(keyPath, key, { encoding: "utf8", mode: 384 }),
        writeFile(certificatePath, certificate, { encoding: "utf8", mode: 384 })
      ]);
    } else {
      const suffix = `${process.pid}.${Date.now()}.tmp`;
      const temporaryKey = `${keyPath}.${suffix}`;
      const temporaryCertificate = `${certificatePath}.${suffix}`;
      await Promise.all([
        writeFile(temporaryKey, key, { encoding: "utf8", mode: 384 }),
        writeFile(temporaryCertificate, certificate, { encoding: "utf8", mode: 384 })
      ]);
      renameSync(temporaryKey, keyPath);
      renameSync(temporaryCertificate, certificatePath);
    }
  }
  let token;
  if (existsSync(tokenPath)) token = (await readFile(tokenPath, "utf8")).trim();
  else token = "";
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    token = randomBytes2(32).toString("base64url");
    await writeFile(tokenPath, `${token}
`, { encoding: "utf8", mode: 384 });
  }
  for (const target of [keyPath, certificatePath, tokenPath]) {
    try {
      await chmod(target, 384);
    } catch {
    }
  }
  return { key, certificate, token, fingerprint256: new X509Certificate2(certificate).fingerprint256 };
}
function dispatchSessionMessageBrokerOperation(store, operation, payload) {
  switch (operation) {
    case "ping":
      return { protocolVersion: SESSION_MESSAGE_PROTOCOL };
    case "send": {
      const messageId = optionalString(payload, "messageId");
      const ttlSeconds = optionalInteger(payload, "ttlSeconds");
      return store.send({
        ...messageId === void 0 ? {} : { messageId },
        sender: identity(payload.sender),
        target: identity(payload.target),
        body: string(payload.body, "body"),
        ...ttlSeconds === void 0 ? {} : { ttlSeconds }
      });
    }
    case "claim": {
      const maxMessages = optionalInteger(payload, "maxMessages");
      const maxBodyChars = optionalInteger(payload, "maxBodyChars");
      return { messages: store.claim(identity(payload.target), Date.now(), {
        ...maxMessages === void 0 ? {} : { maxMessages },
        ...maxBodyChars === void 0 ? {} : { maxBodyChars }
      }) };
    }
    case "acknowledge":
      return { acknowledged: store.acknowledge(identity(payload.target), Array.isArray(payload.messageIds) ? payload.messageIds.map((value) => string(value, "messageId")) : []) };
    case "status":
      return { status: store.status(identity(payload.sender), string(payload.messageId, "messageId")) };
    case "pending":
      return { count: store.pendingCount(identity(payload.target)) };
    case "acquire-relay": {
      const target = identity(payload.target);
      return { acquired: store.acquireRelay({
        ...target,
        transport: string(payload.transport, "transport"),
        relayId: string(payload.relayId, "relayId"),
        pid: integer2(payload.pid, "pid"),
        parentPid: integer2(payload.parentPid, "parentPid")
      }) };
    }
    case "heartbeat-relay": {
      const target = identity(payload.target);
      return { alive: store.heartbeatRelay({ ...target, transport: string(payload.transport, "transport"), relayId: string(payload.relayId, "relayId") }) };
    }
    case "presence-start": {
      const target = identity(payload.target);
      const wakeVisibility = string(payload.wakeVisibility, "wakeVisibility");
      const collaborationId = optionalString(payload, "collaborationId");
      const workspaceId = optionalString(payload, "workspaceId");
      const role = optionalString(payload, "role");
      if (wakeVisibility !== "silent" && wakeVisibility !== "user-message" && wakeVisibility !== "none") throw new Error("wakeVisibility is invalid.");
      return { presence: store.startPresence({
        ...target,
        instanceId: string(payload.instanceId, "instanceId"),
        transport: string(payload.transport, "transport"),
        wakeVisibility,
        canWakeSilently: boolean(payload.canWakeSilently, "canWakeSilently"),
        ...collaborationId === void 0 ? {} : { collaborationId },
        ...workspaceId === void 0 ? {} : { workspaceId },
        ...role === void 0 ? {} : { role }
      }) };
    }
    case "presence-heartbeat":
      return { alive: store.heartbeatPresence(
        identity(payload.target),
        string(payload.instanceId, "instanceId")
      ) };
    case "presence-end":
      return { ended: store.endPresence(
        identity(payload.target),
        string(payload.reason, "reason"),
        string(payload.instanceId, "instanceId")
      ) };
    case "presence":
      return { presence: store.presence(identity(payload.target)) };
    case "list-presence":
      return { sessions: store.listPresence() };
    case "reserve-wake":
      return { dispatch: store.reserveWake(identity(payload.target), string(payload.nonce, "nonce")) };
    case "release-wake":
      return { released: store.releaseWake(identity(payload.target), string(payload.nonce, "nonce")) };
    case "consume-wake":
      return { consumed: store.consumeWake(identity(payload.target), string(payload.nonce, "nonce")) };
    default:
      throw new Error("Unknown broker operation.");
  }
}
async function publishEndpoint(temporary, endpointPath) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temporary, endpointPath);
      return;
    } catch (error) {
      const code = error.code;
      if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      await delay(50 * 2 ** attempt);
    }
  }
}
async function startSessionMessageBroker(stateDirectory) {
  await mkdir(stateDirectory, { recursive: true, mode: 448 });
  try {
    await chmod(stateDirectory, 448);
  } catch {
  }
  const lockPath = path2.join(stateDirectory, "broker.lock");
  const lockDescriptor = acquireProcessLock(lockPath);
  if (lockDescriptor === null) return "already-running";
  const endpointPath = path2.join(stateDirectory, "endpoint.json");
  const databasePath = path2.join(stateDirectory, "session-messages.sqlite3");
  let store;
  let server;
  let temporary;
  let published = false;
  let cleaned = false;
  let idleTimer;
  const sockets = /* @__PURE__ */ new Set();
  const onSignal = () => {
    cleanup();
    process.exit(0);
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(idleTimer);
    for (const socket of sockets) socket.destroy();
    try {
      server?.close();
    } catch {
    }
    try {
      store?.close();
    } catch {
    }
    if (published) {
      try {
        rmSync(endpointPath, { force: true });
      } catch {
      }
    }
    if (temporary) {
      try {
        rmSync(temporary, { force: true });
      } catch {
      }
    }
    try {
      closeSync(lockDescriptor);
    } catch {
    }
    try {
      rmSync(lockPath, { force: true });
    } catch {
    }
    process.off("exit", cleanup);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
  process.once("exit", cleanup);
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    const { key, certificate, token, fingerprint256 } = await credentials(stateDirectory);
    const activeStore = new SessionMessageStore(databasePath);
    store = activeStore;
    let lastActivity = Date.now();
    const activeServer = tls.createServer({ key, cert: certificate, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, (socket) => {
      lastActivity = Date.now();
      let buffer = "";
      socket.setTimeout(5e3, () => socket.destroy());
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer, "utf8") > SESSION_MESSAGE_MAX_REQUEST_BYTES) {
          socket.end(`${JSON.stringify({ ok: false, error: "Request exceeds the broker limit." })}
`);
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = "";
        try {
          const request = JSON.parse(line);
          if (request.protocolVersion !== SESSION_MESSAGE_PROTOCOL || !tokenMatches(request.token ?? "", token)) throw new Error("Broker authentication failed.");
          const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload) ? request.payload : {};
          const data = dispatchSessionMessageBrokerOperation(activeStore, request.operation, payload);
          socket.end(`${JSON.stringify({ ok: true, data })}
`);
        } catch (error) {
          socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Broker request failed." })}
`);
        }
      });
    });
    server = activeServer;
    activeServer.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      activeServer.once("error", reject);
      activeServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = activeServer.address();
    if (!address || typeof address === "string") throw new Error("The broker did not receive a TCP port.");
    const endpoint = {
      protocolVersion: SESSION_MESSAGE_PROTOCOL,
      address: "127.0.0.1",
      port: address.port,
      pid: process.pid,
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      certificateFingerprint256: fingerprint256
    };
    temporary = `${endpointPath}.${process.pid}.${createHash2("sha256").update(String(Date.now())).digest("hex").slice(0, 8)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(endpoint)}
`, { encoding: "utf8", mode: 384 });
    await publishEndpoint(temporary, endpointPath);
    published = true;
    idleTimer = setInterval(() => {
      if (Date.now() - lastActivity < IDLE_EXIT_MS) return;
      cleanup();
      process.exit(0);
    }, 5e3);
    idleTimer.unref();
    return "started";
  } catch (error) {
    cleanup();
    throw error;
  }
}
if (path2.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const stateDirectory = argument("--state-directory");
  if (!stateDirectory) process.exitCode = 2;
  else void startSessionMessageBroker(path2.resolve(stateDirectory)).then((result) => {
    if (result === "already-running") process.exit(0);
  }).catch((error) => {
    const code = error?.code;
    const safeCode = typeof code === "string" && /^[A-Z0-9_]+$/u.test(code) ? code : "STARTUP_FAILED";
    process.stderr.write(`Session message broker startup failed (${safeCode}).
`);
    process.exitCode = 1;
  });
}
export {
  dispatchSessionMessageBrokerOperation,
  startSessionMessageBroker
};
