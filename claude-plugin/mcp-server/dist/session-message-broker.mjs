#!/usr/bin/env node

// mcp-server/src/session-message-broker.ts
import { createHash as createHash3, createPublicKey, randomBytes as randomBytes3, timingSafeEqual as timingSafeEqual2, X509Certificate as X509Certificate2 } from "node:crypto";
import { closeSync, existsSync as existsSync2, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path4 from "node:path";
import tls from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// mcp-server/src/session-message-protocol.ts
var SESSION_MESSAGE_PROTOCOL = "1.0.0";
var SESSION_MESSAGE_MAX_REQUEST_BYTES = 32 * 1024;
var SESSION_MESSAGE_MAX_RESPONSE_BYTES = 32 * 1024;
var SESSION_MESSAGE_BODY_MAX_BYTES = 4096;

// mcp-server/src/session-message-store.ts
import { mkdirSync as mkdirSync2 } from "node:fs";
import path3 from "node:path";
import { createHash as createHash2, randomUUID as randomUUID3 } from "node:crypto";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// mcp-server/src/session-message-wake-port.ts
import { createHash, randomUUID as randomUUID2 } from "node:crypto";
import { existsSync } from "node:fs";

// mcp-server/src/trust-store.ts
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// contracts/types.ts
var CONTRACT_VERSION = "1.0.0";
var WorkflowContractError = class extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "WorkflowContractError";
  }
  code;
  details;
  toBody() {
    return { code: this.code, message: this.message, details: this.details };
  }
};

// mcp-server/src/workspace-identity.ts
var SEGMENT_SEPARATOR = process.platform === "win32" ? /[\\/]/u : /\//u;

// mcp-server/src/convergence-logic.ts
function canonicalJson(value, subject = "Convergence input") {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new WorkflowContractError("INVALID_INPUT", `${subject} contains a non-finite number.`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, subject)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], subject)}`).join(",")}}`;
  }
  throw new WorkflowContractError("INVALID_INPUT", `${subject} contains a non-serializable value.`);
}

// mcp-server/src/trust-store.ts
var TRUST_SIGNING_KEY = "trust-signing-key";
var SCHEMA_VERSION = 1;
var INPUT_SOURCE_KEYS = /* @__PURE__ */ new Set([
  "originKind",
  "host",
  "sessionId",
  "eventId",
  "contentDigest",
  "observedAt",
  "expiresAt",
  "authorityEffect",
  "attestation"
]);
var ATTESTATION_KEYS = /* @__PURE__ */ new Set(["kind", "adapter", "capabilityVersion"]);
function verifyInputSource(receipt, signingKey) {
  try {
    const { integrityToken, ...unsigned } = receipt;
    const actual = Buffer.from(integrityToken, "base64url");
    const expected = createHmac("sha256", signingKey).update(canonicalJson(unsigned, "Input source receipt")).digest();
    return signingKey.length === 32 && actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
function rejectUnexpectedKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new WorkflowContractError("INVALID_INPUT", `${label} contains unsupported fields.`, { unexpected });
  }
}
var TrustStore = class {
  constructor(databasePath) {
    this.databasePath = databasePath;
    if (!databasePath.trim()) throw new WorkflowContractError("INVALID_INPUT", "Trust database path must not be empty.");
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 448 });
    this.database = new DatabaseSync(databasePath);
    try {
      this.database.exec("PRAGMA busy_timeout = 5000;");
      this.database.exec("PRAGMA synchronous = FULL;");
      if (databasePath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
      this.initializeSchema();
      this.signingKey = Buffer.from(this.getOrCreateSecret(TRUST_SIGNING_KEY), "base64url");
      if (this.signingKey.length !== 32) throw new Error("Stored trust signing key is invalid.");
      if (databasePath !== ":memory:" && process.platform !== "win32") chmodSync(path.resolve(databasePath), 384);
    } catch (cause) {
      try {
        this.database.close();
      } catch {
      }
      if (cause instanceof WorkflowContractError) throw cause;
      throw this.storageError("Cannot initialize the trust database.", cause);
    }
  }
  databasePath;
  database;
  signingKey;
  closed = false;
  recordInputSource(input) {
    rejectUnexpectedKeys(input, INPUT_SOURCE_KEYS, "Input source metadata");
    if (!input.attestation || typeof input.attestation !== "object" || Array.isArray(input.attestation)) {
      throw new WorkflowContractError("INVALID_INPUT", "Input source attestation must be an object.");
    }
    rejectUnexpectedKeys(input.attestation, ATTESTATION_KEYS, "Input source attestation");
    if (input.originKind === "user-turn" || input.attestation.kind === "host-direct-user-event") {
      throw new WorkflowContractError("BINDING_INVALID", "This release cannot attest direct-user approval sources.");
    }
    if (input.originKind === "peer" && (input.authorityEffect !== "none" || input.attestation.kind !== "broker-peer-envelope")) {
      throw new WorkflowContractError("BINDING_INVALID", "Peer input must be a non-authorizing broker envelope.");
    }
    if (input.originKind !== "peer" && input.attestation.kind === "broker-peer-envelope") {
      throw new WorkflowContractError("BINDING_INVALID", "Broker peer attestations must be classified as peer input.");
    }
    const receipt = this.seal({
      schemaVersion: CONTRACT_VERSION,
      receiptId: `source-${randomUUID()}`,
      originKind: input.originKind,
      host: input.host,
      sessionId: input.sessionId,
      eventId: input.eventId,
      contentDigest: input.contentDigest,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt,
      authorityEffect: input.authorityEffect,
      attestation: {
        kind: input.attestation.kind,
        adapter: input.attestation.adapter,
        capabilityVersion: input.attestation.capabilityVersion
      }
    });
    return this.guard("Cannot record the input source receipt.", { receiptId: receipt.receiptId }, () => this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT receipt_json FROM input_source_receipts
        WHERE host = ? AND session_id = ? AND event_id = ?
      `).get(receipt.host, receipt.sessionId, receipt.eventId);
      if (existing) {
        const prior = JSON.parse(existing.receipt_json);
        const sameSecurityMetadata = prior.contentDigest === receipt.contentDigest && prior.originKind === receipt.originKind && prior.authorityEffect === receipt.authorityEffect && canonicalJson(prior.attestation, "Source attestation") === canonicalJson(receipt.attestation, "Source attestation");
        if (sameSecurityMetadata) return structuredClone(prior);
        throw new WorkflowContractError("REQUEST_CONFLICT", "The input event was already recorded with different content or provenance metadata.", {
          host: receipt.host,
          sessionId: receipt.sessionId,
          eventId: receipt.eventId
        });
      }
      this.database.prepare(`
        INSERT INTO input_source_receipts (
          receipt_id, host, session_id, event_id, origin_kind,
          authority_effect, observed_at, expires_at, receipt_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.receiptId,
        receipt.host,
        receipt.sessionId,
        receipt.eventId,
        receipt.originKind,
        receipt.authorityEffect,
        receipt.observedAt,
        receipt.expiresAt,
        JSON.stringify(receipt)
      );
      return structuredClone(receipt);
    }));
  }
  latestInputSource(binding) {
    return this.guard("Cannot read the latest input source receipt.", { ...binding }, () => {
      const row = this.database.prepare(`
        SELECT receipt_json FROM input_source_receipts
        WHERE host = ? AND session_id = ?
        ORDER BY observed_at DESC, receipt_id DESC LIMIT 1
      `).get(binding.host, binding.sessionId);
      return row ? JSON.parse(row.receipt_json) : null;
    });
  }
  getInputSource(receiptId) {
    return this.guard("Cannot read the input source receipt.", { receiptId }, () => {
      const row = this.database.prepare("SELECT receipt_json FROM input_source_receipts WHERE receipt_id = ?").get(receiptId);
      return row ? JSON.parse(row.receipt_json) : null;
    });
  }
  verify(receipt) {
    return verifyInputSource(receipt, this.signingKey);
  }
  /** Existing key/receipt snapshot only: no schema, journal mode, key creation or receipt issuance. */
  static readVerifiedInputSource(databasePath, receiptId) {
    let database;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      database.exec("PRAGMA query_only = ON; BEGIN;");
      const version = database.prepare("PRAGMA user_version").get().user_version;
      if (version > SCHEMA_VERSION) return null;
      const key = database.prepare("SELECT value FROM trust_metadata WHERE key = ?").get(TRUST_SIGNING_KEY);
      const row = database.prepare("SELECT receipt_json FROM input_source_receipts WHERE receipt_id = ?").get(receiptId);
      if (!key || !row) return null;
      const receipt = JSON.parse(row.receipt_json);
      return receipt?.receiptId === receiptId && verifyInputSource(receipt, Buffer.from(key.value, "base64url")) ? receipt : null;
    } catch {
      return null;
    } finally {
      database?.close();
    }
  }
  close() {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
  seal(unsigned) {
    return {
      ...unsigned,
      integrityToken: createHmac("sha256", this.signingKey).update(canonicalJson(unsigned, "Input source receipt")).digest("base64url")
    };
  }
  initializeSchema() {
    const version = this.database.prepare("PRAGMA user_version").get().user_version;
    if (version > SCHEMA_VERSION) {
      throw new WorkflowContractError("INVALID_INPUT", "Trust database schema is newer than this server supports.", {
        databasePath: this.databasePath,
        supportedVersion: SCHEMA_VERSION,
        actualVersion: version
      });
    }
    this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS trust_metadata (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS input_source_receipts (
        receipt_id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        origin_kind TEXT NOT NULL,
        authority_effect TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        UNIQUE(host, session_id, event_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS input_source_latest
        ON input_source_receipts(host, session_id, observed_at DESC);
      PRAGMA user_version = ${SCHEMA_VERSION};
      COMMIT;
    `);
  }
  getOrCreateSecret(name) {
    return this.transaction(() => {
      const existing = this.database.prepare("SELECT value FROM trust_metadata WHERE key = ?").get(name);
      if (existing) return existing.value;
      const value = randomBytes(32).toString("base64url");
      this.database.prepare("INSERT INTO trust_metadata (key, value, updated_at) VALUES (?, ?, ?)").run(name, value, (/* @__PURE__ */ new Date()).toISOString());
      return value;
    });
  }
  transaction(operation) {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (cause) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
      }
      throw cause;
    }
  }
  guard(message, details, operation) {
    try {
      return operation();
    } catch (cause) {
      if (cause instanceof WorkflowContractError) throw cause;
      throw this.storageError(message, cause, details);
    }
  }
  storageError(message, cause, details = {}) {
    return new WorkflowContractError("INVALID_INPUT", message, {
      ...details,
      databasePath: this.databasePath,
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  }
};

// mcp-server/src/runtime-config.ts
import { homedir } from "node:os";
import path2 from "node:path";
function sharedUserStateDirectory(environment, homeDirectory) {
  const configured = environment.AGENT_GOVERNANCE_SHARED_STATE_DIR?.trim();
  if (configured) {
    if (!path2.isAbsolute(configured)) {
      throw new Error("AGENT_GOVERNANCE_SHARED_STATE_DIR must be an absolute path.");
    }
    return path2.normalize(configured);
  }
  return path2.resolve(homeDirectory, ".agent-governance-suite");
}
function resolveSessionMessageStateDirectory(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  void platform;
  const configured = environment.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR?.trim();
  if (configured) return path2.resolve(currentWorkingDirectory, configured);
  return path2.join(sharedUserStateDirectory(environment, homeDirectory), "session-messaging");
}
function resolveTrustDatabasePath(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  void platform;
  const configured = environment.AGENT_GOVERNANCE_TRUST_DB_PATH?.trim();
  if (configured) return path2.resolve(currentWorkingDirectory, configured);
  return path2.join(
    resolveSessionMessageStateDirectory(environment, platform, homeDirectory, currentWorkingDirectory),
    "trust.sqlite3"
  );
}

// mcp-server/src/session-message-wake-port.ts
function wakeBackoffDelay(attempt) {
  return Math.min(10 * 6e4, 3e4 * 2 ** Math.max(0, attempt));
}
var WAKE_ACTOR_KINDS = ["main", "unknown"];
var WAKE_ACTOR_ASSURANCES = ["observed", "unknown"];
function isWakeHookObservation(value, target) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value;
  return event.host === target.host && event.sessionId === target.sessionId && event.kind === "user-input" && event.wakeOnly === true && event.actor?.observedBy === `${target.host}:hook-payload` && WAKE_ACTOR_KINDS.some((kind) => kind === event.actor.kind) && WAKE_ACTOR_ASSURANCES.some((assurance) => assurance === event.actor.assurance) && Array.isArray(event.wakeCandidates) && event.wakeCandidates.length > 0 && event.wakeCandidates.length <= 10 && event.wakeCandidates.every((nonce) => typeof nonce === "string" && /^[A-Za-z0-9_-]{22,128}$/u.test(nonce));
}
function observationDigest(event) {
  const normalized = [
    event.host,
    event.sessionId,
    event.kind,
    event.wakeOnly,
    event.actor.kind,
    event.actor.observedBy,
    event.actor.assurance,
    [...new Set(event.wakeCandidates)].sort()
  ];
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}
function verifyHistoricalWakeObservation(target, nonce, sourceReceiptId, startedAt, lateObservedAt, nowMs, databasePath = resolveTrustDatabasePath()) {
  const receipt = TrustStore.readVerifiedInputSource(databasePath, sourceReceiptId);
  if (!receipt || receipt.schemaVersion !== "1.0.0" || receipt.host !== target.host || receipt.sessionId !== target.sessionId || receipt.originKind !== "peer" || receipt.authorityEffect !== "none" || receipt.attestation?.kind !== "broker-peer-envelope" || receipt.attestation.adapter !== "session-message-wake-hook" || receipt.attestation.capabilityVersion !== "1.0.0") return null;
  const [started, observed, late, expires] = [
    Date.parse(startedAt),
    Date.parse(receipt.observedAt),
    Date.parse(lateObservedAt),
    Date.parse(receipt.expiresAt)
  ];
  if (![started, observed, late, expires, nowMs].every(Number.isFinite) || !(started <= observed && observed <= late && late < expires && expires <= nowMs)) return null;
  let matches = 0;
  for (const kind of WAKE_ACTOR_KINDS) for (const assurance of WAKE_ACTOR_ASSURANCES) {
    const observation = {
      ...target,
      kind: "user-input",
      wakeOnly: true,
      wakeCandidates: [nonce],
      actor: { kind, assurance, observedBy: `${target.host}:hook-payload` }
    };
    if (isWakeHookObservation(observation, target) && observationDigest(observation) === receipt.contentDigest) matches++;
  }
  return matches === 1 ? {
    sourceReceiptId,
    contentDigest: receipt.contentDigest,
    observedAt: receipt.observedAt,
    receiptExpiresAt: receipt.expiresAt
  } : null;
}
function createWakeHookObservationReader(databasePath = resolveTrustDatabasePath()) {
  return {
    verifyObservation(target, observation, receiptId, nowMs) {
      if (!isWakeHookObservation(observation, target) || !receiptId || !existsSync(databasePath)) return false;
      const trust = new TrustStore(databasePath);
      try {
        const receipt = trust.getInputSource(receiptId);
        return receipt !== null && trust.verify(receipt) && receipt.host === target.host && receipt.sessionId === target.sessionId && receipt.originKind === "peer" && receipt.authorityEffect === "none" && receipt.attestation.kind === "broker-peer-envelope" && receipt.attestation.adapter === "session-message-wake-hook" && receipt.attestation.capabilityVersion === "1.0.0" && receipt.contentDigest === observationDigest(observation) && Date.parse(receipt.observedAt) <= nowMs && Date.parse(receipt.expiresAt) > nowMs;
      } finally {
        trust.close();
      }
    }
  };
}

// mcp-server/src/session-message-store.ts
var MESSAGE_BODY_MAX_BYTES = SESSION_MESSAGE_BODY_MAX_BYTES;
var MESSAGE_TTL_DEFAULT_SECONDS = 3600;
var MESSAGE_TTL_MAX_SECONDS = 86400;
var MESSAGE_LIMIT = 1e3;
var MESSAGE_BYTES_LIMIT = 4 * 1024 * 1024;
var MESSAGE_DRAFT_TTL_MS = 10 * 6e4;
var MESSAGE_DRAFT_LIMIT = 1e3;
var MESSAGE_SENDER_DRAFT_LIMIT = 100;
var MESSAGE_RECEIPT_LIMIT = 1e3;
var MESSAGE_ID_RECORD_BYTES_LIMIT = 4 * 1024 * 1024;
var MESSAGE_RECEIPT_EXTRA_MS = 36e5;
var CLAIM_LEASE_BASE_MS = 12e4;
var CLAIM_LEASE_MAX_MS = 30 * 6e4;
var RELAY_LEASE_MS = 15e3;
var WAKE_TTL_MS = 60 * 6e4;
var WAKE_RETIRE_GRACE_MS = 10 * 6e4;
var MESSAGE_SCHEMA_VERSION = 1;
var ACTIVE_WAKE_STATES = "('reserved', 'started', 'submitted', 'unknown')";
var WAKE_STATE_CHECK = "CHECK (state IN ('legacy', 'reserved', 'started', 'submitted', 'unknown', 'observed', 'not-submitted', 'expired-unobserved'))";
var WAKE_COPY_COLUMNS = "nonce_digest, host, session_id, expires_at, consumed_at, state, nonce, instance_id, birth_generation, transport, relay_id, attempt_id, dispatch_epoch, retry_not_before, retry_count, started_at, outcome_at, observed_at, late_observed_at";
var PRESENCE_LEASE_MS = 2e4;
var CLAIM_MAX_MESSAGES = 10;
function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}
function nonceDigest(nonce) {
  return createHash2("sha256").update(nonce).digest("hex");
}
function boundedIdentity(value) {
  const hostPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
  const sessionPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
  if (!hostPattern.test(value.host) || !sessionPattern.test(value.sessionId)) {
    throw new Error("host and sessionId must use bounded identifier characters.");
  }
}
function claimedMessage(row, deliveryAttempt = Number(row.delivery_attempts), firstDeliveredAt = row.first_delivered_at === null ? null : String(row.first_delivered_at)) {
  return {
    messageId: String(row.message_id),
    sender: { host: String(row.sender_host), sessionId: String(row.sender_session_id) },
    recipient: { host: String(row.target_host), sessionId: String(row.target_session_id) },
    body: String(row.body),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    deliveryAttempt,
    firstDeliveredAt
  };
}
function claimResponseBytes(messages) {
  return Buffer.byteLength(JSON.stringify({ ok: true, data: { messages } }), "utf8") + 1;
}
var SessionMessageStore = class {
  database;
  constructor(databasePath) {
    if (databasePath !== ":memory:") mkdirSync2(path3.dirname(path3.resolve(databasePath)), { recursive: true, mode: 448 });
    this.database = new DatabaseSync2(databasePath);
    this.database.exec("PRAGMA busy_timeout = 5000;");
    const storedVersion = this.database.prepare("PRAGMA user_version").get().user_version;
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
      const version = this.database.prepare("PRAGMA user_version").get().user_version;
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
      const messageColumns = this.database.prepare("PRAGMA table_info(messages)").all();
      if (!messageColumns.some((column) => column.name === "delivery_attempts")) {
        this.database.exec("ALTER TABLE messages ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;");
      }
      if (!messageColumns.some((column) => column.name === "first_delivered_at")) {
        this.database.exec("ALTER TABLE messages ADD COLUMN first_delivered_at TEXT;");
      }
      const presenceColumns = this.database.prepare("PRAGMA table_info(session_presence)").all();
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
      const wakeColumns = this.database.prepare("PRAGMA table_info(wake_nonces)").all();
      for (const [name, definition] of [
        ["state", "TEXT NOT NULL DEFAULT 'legacy' CHECK (state IN ('legacy', 'reserved', 'started', 'submitted', 'unknown', 'observed', 'not-submitted'))"],
        ["nonce", "TEXT"],
        ["instance_id", "TEXT"],
        ["birth_generation", "TEXT"],
        ["transport", "TEXT"],
        ["relay_id", "TEXT"],
        ["attempt_id", "TEXT"],
        ["dispatch_epoch", "INTEGER NOT NULL DEFAULT 0"],
        ["retry_not_before", "TEXT"],
        ["retry_count", "INTEGER NOT NULL DEFAULT 0"],
        ["started_at", "TEXT"],
        ["outcome_at", "TEXT"],
        ["observed_at", "TEXT"],
        ["late_observed_at", "TEXT"]
      ]) {
        if (!wakeColumns.some((column) => column.name === name)) this.database.exec(`ALTER TABLE wake_nonces ADD COLUMN ${name} ${definition};`);
      }
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
  close() {
    this.database.close();
  }
  prune(nowMs = Date.now()) {
    const now = iso(nowMs);
    const acknowledgedBefore = iso(nowMs - 36e5);
    this.database.prepare("DELETE FROM messages WHERE expires_at <= ? OR (acknowledged_at IS NOT NULL AND acknowledged_at <= ?)").run(now, acknowledgedBefore);
    this.database.prepare("DELETE FROM relay_leases WHERE lease_until <= ?").run(now);
    this.database.prepare("DELETE FROM wake_nonces WHERE state = 'legacy' AND expires_at <= ?").run(now);
    this.retireUnobservedWakes(nowMs);
    this.database.prepare(`DELETE FROM wake_nonces WHERE state IN ('observed', 'not-submitted', 'expired-unobserved')
      AND coalesce(consumed_at, observed_at, retired_at, outcome_at) <= ?
      AND (retry_not_before IS NULL OR retry_not_before <= ?)`).run(acknowledgedBefore, now);
    this.database.prepare(`DELETE FROM wake_nonces WHERE nonce_digest IN (SELECT nonce_digest FROM wake_nonces
      WHERE state IN ('observed', 'not-submitted', 'expired-unobserved') AND (retry_not_before IS NULL OR retry_not_before <= ?)
      ORDER BY coalesce(consumed_at, observed_at, retired_at, outcome_at) DESC LIMIT -1 OFFSET ?)`).run(now, MESSAGE_LIMIT);
    this.database.prepare("DELETE FROM prepared_messages WHERE expires_at <= ?").run(now);
  }
  /**
   * Retires an unobserved managed wake only after its injection expiry plus grace, and only with evidence that the
   * host moved past it: a newer live presence birth, or session activity after the expiry. The row keeps its original
   * binding, epoch and times; expired-unobserved is neither observation nor delivery. One UPDATE commits it atomically.
   */
  retireUnobservedWakes(nowMs) {
    const now = iso(nowMs);
    this.database.prepare(`UPDATE wake_nonces SET state = 'expired-unobserved', retired_at = ?
      WHERE state IN ${ACTIVE_WAKE_STATES} AND expires_at <= ?
        AND (EXISTS (SELECT 1 FROM session_activity activity WHERE activity.host = wake_nonces.host
            AND activity.session_id = wake_nonces.session_id AND activity.active_at > wake_nonces.expires_at)
          OR coalesce((SELECT latest.ended_at IS NULL AND latest.lease_until > ? AND latest.started_at > wake_nonces.birth_generation
            FROM session_presence latest WHERE latest.host = wake_nonces.host AND latest.session_id = wake_nonces.session_id
            ORDER BY latest.started_at DESC, latest.rowid DESC LIMIT 1), 0))`).run(now, iso(nowMs - WAKE_RETIRE_GRACE_MS), now);
  }
  recordActivity(target, nowMs) {
    this.database.prepare(`INSERT INTO session_activity (host, session_id, active_at) VALUES (?, ?, ?)
      ON CONFLICT (host, session_id) DO UPDATE SET active_at = max(active_at, excluded.active_at)`).run(target.host, target.sessionId, iso(nowMs));
  }
  /** Preparation is durable but has no queue, peer-relation or wake effect. */
  prepare(input, nowMs = Date.now()) {
    boundedIdentity(input.sender);
    boundedIdentity(input.target);
    const ttlSeconds = input.ttlSeconds ?? MESSAGE_TTL_DEFAULT_SECONDS;
    if (typeof input.body !== "string" || !input.body.trim() || Buffer.byteLength(input.body, "utf8") > MESSAGE_BODY_MAX_BYTES) throw new Error("body must contain 1-4096 UTF-8 bytes.");
    if (input.body.includes("\0")) throw new Error("body must not contain NUL characters.");
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > MESSAGE_TTL_MAX_SECONDS) throw new Error("ttlSeconds must be an integer from 30 to 86400.");
    const result = { messageId: randomUUID3(), preparedAt: iso(nowMs), expiresAt: iso(nowMs + MESSAGE_DRAFT_TTL_MS) };
    const recordBytes = Buffer.byteLength(JSON.stringify({ ...input, ttlSeconds, ...result }), "utf8");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.prune(nowMs);
      const drafts = this.database.prepare("SELECT count(*) AS count FROM prepared_messages WHERE receipt IS NULL").get();
      const owned = this.database.prepare("SELECT count(*) AS count FROM prepared_messages WHERE receipt IS NULL AND sender_host = ? AND sender_session_id = ?").get(input.sender.host, input.sender.sessionId);
      const bytes = this.database.prepare("SELECT coalesce(sum(record_bytes), 0) AS bytes FROM prepared_messages").get();
      if (drafts.count >= MESSAGE_DRAFT_LIMIT || owned.count >= MESSAGE_SENDER_DRAFT_LIMIT || bytes.bytes + recordBytes > MESSAGE_ID_RECORD_BYTES_LIMIT) throw new Error("The bounded message preparation store is full.");
      this.database.prepare(`INSERT INTO prepared_messages (message_id, sender_host, sender_session_id, target_host, target_session_id, body, ttl_seconds, prepared_at, expires_at, record_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(result.messageId, input.sender.host, input.sender.sessionId, input.target.host, input.target.sessionId, input.body, ttlSeconds, result.preparedAt, result.expiresAt, recordBytes);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  /** ID ownership, capacity, queue insert and first receipt share one transaction. */
  submitPrepared(sender, messageId, nowMs = Date.now()) {
    boundedIdentity(sender);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.prune(nowMs);
      const row = this.database.prepare("SELECT * FROM prepared_messages WHERE message_id = ? AND sender_host = ? AND sender_session_id = ? AND expires_at > ?").get(messageId, sender.host, sender.sessionId, iso(nowMs));
      if (!row) throw new Error("Issued message ID is unavailable; delivery may be unknown. Compare saved receipts/status; prepare only a new intent.");
      const target = { host: String(row.target_host), sessionId: String(row.target_session_id) };
      if (row.receipt !== null) {
        const receipt2 = JSON.parse(String(row.receipt));
        const autoWake2 = this.autoWakeOutlook(target, nowMs);
        this.database.exec("COMMIT");
        return { ...receipt2, duplicate: true, autoWake: autoWake2 };
      }
      const receipts = this.database.prepare("SELECT count(*) AS count FROM prepared_messages WHERE receipt IS NOT NULL").get();
      if (receipts.count >= MESSAGE_RECEIPT_LIMIT) throw new Error("The bounded message receipt store is full.");
      const receipt = this.send({ messageId, sender, target, body: String(row.body), ttlSeconds: Number(row.ttl_seconds) }, nowMs);
      const receiptJson = JSON.stringify({ messageId: receipt.messageId, createdAt: receipt.createdAt, expiresAt: receipt.expiresAt });
      const expiresAt = iso(Date.parse(receipt.expiresAt) + MESSAGE_RECEIPT_EXTRA_MS);
      const recordBytes = Buffer.byteLength(JSON.stringify({ messageId, sender, target: { host: row.target_host, sessionId: row.target_session_id }, preparedAt: row.prepared_at, ttlSeconds: row.ttl_seconds, receipt: receiptJson, expiresAt }), "utf8");
      const bytes = this.database.prepare("SELECT coalesce(sum(record_bytes), 0) AS bytes FROM prepared_messages WHERE message_id <> ?").get(messageId);
      if (bytes.bytes + recordBytes > MESSAGE_ID_RECORD_BYTES_LIMIT) throw new Error("The bounded message receipt store is full.");
      this.database.prepare("UPDATE prepared_messages SET body = NULL, receipt = ?, expires_at = ?, record_bytes = ? WHERE message_id = ?").run(receiptJson, expiresAt, recordBytes, messageId);
      const autoWake = this.autoWakeOutlook(target, nowMs);
      this.database.exec("COMMIT");
      return { ...receipt, autoWake };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  /** Internal queue primitive, also retained for existing-data fixtures; public send uses submitPrepared. */
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
    const messageId = input.messageId ?? randomUUID3();
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
  claimLocked(target, nowMs, limits) {
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
        ORDER BY created_at ASC LIMIT ?`).all(target.host, target.sessionId, now, now, maxMessages);
    const selected = [];
    const projected = [];
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
      return statement.run(now, iso(nowMs + leaseMs), now, String(row.message_id), now).changes === 1 ? [claimedMessage(row, attempts + 1, firstDeliveredAt)] : [];
    });
  }
  consumePendingWakes(target, nowMs) {
    const now = iso(nowMs);
    this.database.prepare(`UPDATE wake_nonces SET consumed_at = ?
      WHERE host = ? AND session_id = ? AND state = 'legacy' AND consumed_at IS NULL AND expires_at > ?`).run(now, target.host, target.sessionId, now);
  }
  claim(target, nowMs = Date.now(), limits = {}) {
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
  claimWake(target, nonces, nowMs = Date.now(), limits = {}) {
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
        WHERE nonce_digest = ? AND host = ? AND session_id = ? AND state = 'legacy' AND consumed_at IS NULL AND expires_at > ?`).get(digest, target.host, target.sessionId, now)));
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
  observeNativeInput(target, nowMs = Date.now()) {
    boundedIdentity(target);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO input_observations (host, session_id, deferred_tool_claim, observed_at)
        VALUES (?, ?, 1, ?) ON CONFLICT (host, session_id) DO UPDATE SET deferred_tool_claim = 1, observed_at = excluded.observed_at`).run(target.host, target.sessionId, iso(nowMs));
      this.recordActivity(target, nowMs);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  claimDeferred(target, nowMs = Date.now(), limits = {}) {
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
  claimTurnEnd(target, nowMs = Date.now(), limits = {}) {
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
  clearDeferred(target, nowMs = Date.now()) {
    boundedIdentity(target);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM input_observations WHERE host = ? AND session_id = ?").run(target.host, target.sessionId);
      this.recordActivity(target, nowMs);
      this.database.exec("COMMIT");
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
      this.recordActivity(target, nowMs);
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
      claimed_at, acknowledged_at, delivery_attempts, first_delivered_at FROM messages WHERE message_id = ? AND sender_host = ? AND sender_session_id = ?`).get(messageId, sender.host, sender.sessionId);
    if (!row) {
      const prepared = this.database.prepare("SELECT prepared_at, expires_at, receipt FROM prepared_messages WHERE message_id = ? AND sender_host = ? AND sender_session_id = ? AND expires_at > ?").get(messageId, sender.host, sender.sessionId, iso(nowMs));
      if (!prepared) return null;
      return prepared.receipt === null ? { messageId, state: "prepared", preparedAt: prepared.prepared_at, expiresAt: prepared.expires_at } : { ...JSON.parse(prepared.receipt), state: "submitted", deliveryState: "unknown", receiptExpiresAt: prepared.expires_at };
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
      autoWake: row.acknowledged_at ? null : this.autoWakeOutlook({ host: String(row.target_host), sessionId: String(row.target_session_id) }, nowMs)
    };
  }
  /** Metadata only; peer relation is not work completion or permission. */
  peerWaitState(sender, target, nowMs = Date.now()) {
    boundedIdentity(sender);
    boundedIdentity(target);
    const rows = this.database.prepare(`SELECT message_id, sender_host, sender_session_id, target_host, target_session_id,
      created_at, claimed_at, acknowledged_at, delivery_attempts, first_delivered_at FROM messages
      WHERE expires_at > ? AND ((sender_host = ? AND sender_session_id = ? AND target_host = ? AND target_session_id = ?)
        OR (sender_host = ? AND sender_session_id = ? AND target_host = ? AND target_session_id = ?))
      ORDER BY created_at DESC, message_id DESC LIMIT 20`).all(iso(nowMs), sender.host, sender.sessionId, target.host, target.sessionId, target.host, target.sessionId, sender.host, sender.sessionId);
    return { related: rows.length > 0, fingerprint: createHash2("sha256").update(JSON.stringify(rows)).digest("hex") };
  }
  liveRelay(target, transport, nowMs = Date.now()) {
    boundedIdentity(target);
    const row = this.database.prepare("SELECT relay_id, pid, parent_pid, updated_at FROM relay_leases WHERE host = ? AND session_id = ? AND transport = ? AND lease_until > ?").get(target.host, target.sessionId, transport, iso(nowMs));
    return row ? { relayId: row.relay_id, pid: row.pid, parentPid: row.parent_pid, updatedAt: row.updated_at } : null;
  }
  /**
   * Advisory view of the recipient's idle auto-wake path, read from stored presence, relay lease and wake rows.
   * Callers prune first so due retirements are visible. It grants nothing and proves no delivery.
   */
  autoWakeOutlook(target, nowMs = Date.now()) {
    boundedIdentity(target);
    const now = iso(nowMs);
    const outlook = (state, reason, basisAt) => ({ state, reason, basisAt: basisAt === null || basisAt === void 0 ? null : String(basisAt), checkedAt: now, authorityEffect: "none" });
    const presence = this.presence(target, nowMs);
    if (presence.state === "unknown") return outlook("no-live-relay", "presence-unknown", null);
    const capabilities = presence.deliveryCapabilities;
    if (capabilities.idleWake === "none" || !capabilities.supportedInjection.includes("peer-wake")) return outlook("unsupported", "no-idle-wake", presence.startedAt);
    if (presence.state !== "online") return outlook("no-live-relay", "presence-not-online", presence.endedAt ?? presence.leaseUntil);
    const relay = this.liveRelay(target, presence.transport, nowMs);
    if (!relay) return outlook("no-live-relay", "relay-lease-missing", presence.heartbeatAt);
    const active = this.database.prepare(`SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AND state IN ${ACTIVE_WAKE_STATES}`).get(target.host, target.sessionId);
    if (active) {
      const current = active.instance_id === presence.instanceId && active.birth_generation === presence.startedAt && active.transport === presence.transport;
      return current && String(active.expires_at) > now ? outlook("available", "wake-in-flight", active.expires_at) : outlook("latched", "wake-unobserved", active.expires_at);
    }
    const legacy = this.database.prepare(`SELECT expires_at FROM wake_nonces WHERE host = ? AND session_id = ?
      AND state = 'legacy' AND consumed_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`).get(target.host, target.sessionId, now);
    if (legacy) return outlook("available", "wake-in-flight", legacy.expires_at);
    const cooldown = this.database.prepare(`SELECT max(retry_not_before) AS until FROM wake_nonces WHERE host = ? AND session_id = ?
      AND state = 'not-submitted' AND retry_not_before > ?`).get(target.host, target.sessionId, now);
    if (cooldown.until !== null) return outlook("available", "retry-backoff", cooldown.until);
    return outlook("available", "relay-live", relay.updatedAt);
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
  /** One relay cycle; an old generation cannot renew either lease. */
  relayTick(input, nowMs = Date.now()) {
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
  reserveWake(target, nonce, nowMs = Date.now()) {
    boundedIdentity(target);
    if (nonce.length < 16 || nonce.length > 200) throw new Error("Invalid wake nonce.");
    this.prune(nowMs);
    const now = iso(nowMs);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const outstanding = this.database.prepare(`SELECT 1 FROM wake_nonces
        WHERE host = ? AND session_id = ? AND (state IN ('reserved', 'started', 'submitted', 'unknown')
          OR (state = 'legacy' AND consumed_at IS NULL AND expires_at > ?)) LIMIT 1`).get(target.host, target.sessionId, now);
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
      WHERE nonce_digest = ? AND host = ? AND session_id = ? AND state = 'legacy' AND consumed_at IS NULL`).run(nonceDigest(nonce), target.host, target.sessionId).changes === 1;
  }
  /** Board classification checks ownership; only the host hook can record observation. */
  consumeWake(target, nonce, nowMs = Date.now()) {
    boundedIdentity(target);
    return Boolean(this.database.prepare(`SELECT 1 FROM wake_nonces
      WHERE nonce_digest = ? AND host = ? AND session_id = ? AND expires_at > ?`).get(nonceDigest(nonce), target.host, target.sessionId, iso(nowMs)));
  }
  wakeBindingCurrent(input, generation, nowMs) {
    boundedIdentity(input);
    const presence = this.presence(input, nowMs);
    const relay = this.liveRelay(input, input.transport, nowMs);
    return presence.state === "online" && presence.instanceId === input.instanceId && presence.transport === input.transport && (generation === null || presence.startedAt === generation) && relay?.relayId === input.relayId && presence.deliveryCapabilities.idleWake !== "none" && presence.deliveryCapabilities.supportedInjection.includes("peer-wake");
  }
  wakeGenerationReplaced(attempt, nowMs) {
    const presence = this.presence(attempt, nowMs);
    return presence.instanceId !== null && presence.startedAt !== null && (presence.instanceId !== attempt.instanceId || presence.startedAt !== attempt.generation || presence.transport !== attempt.transport);
  }
  wakeClaimable(target, nowMs) {
    const now = iso(nowMs);
    const delivering = this.database.prepare(`SELECT 1 FROM messages WHERE target_host = ? AND target_session_id = ?
      AND acknowledged_at IS NULL AND expires_at > ? AND claim_until > ? LIMIT 1`).get(target.host, target.sessionId, now, now);
    const claimable = this.database.prepare(`SELECT 1 FROM messages WHERE target_host = ? AND target_session_id = ?
      AND acknowledged_at IS NULL AND expires_at > ? AND (claim_until IS NULL OR claim_until <= ?) LIMIT 1`).get(target.host, target.sessionId, now, now);
    return !delivering && Boolean(claimable);
  }
  wakeAttempt(row) {
    return {
      host: String(row.host),
      sessionId: String(row.session_id),
      instanceId: String(row.instance_id),
      transport: String(row.transport),
      relayId: String(row.relay_id),
      nonce: String(row.nonce),
      generation: String(row.birth_generation),
      attemptId: String(row.attempt_id),
      dispatchEpoch: Number(row.dispatch_epoch)
    };
  }
  reserveManagedWake(input, nowMs = Date.now()) {
    boundedIdentity(input);
    if (!/^[A-Za-z0-9_-]{22,128}$/u.test(input.nonce)) throw new Error("Invalid wake nonce.");
    for (const value of [input.instanceId, input.relayId, input.transport]) {
      if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new Error("Invalid wake relay binding.");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.prune(nowMs);
      let attempt = null;
      let active = this.database.prepare(`SELECT * FROM wake_nonces WHERE host = ? AND session_id = ?
        AND state IN ('reserved', 'started', 'submitted', 'unknown')`).get(input.host, input.sessionId);
      const currentPending = this.wakeBindingCurrent(input, null, nowMs) && this.wakeClaimable(input, nowMs);
      if (active?.state === "reserved" && currentPending && active.late_observed_at === null && active.observed_at === null && active.consumed_at === null && (active.dispatch_epoch === 0 && active.started_at === null || Number(active.retry_count) > 0 && active.retry_not_before !== null && active.outcome_at !== null) && this.wakeGenerationReplaced(this.wakeAttempt(active), nowMs)) {
        this.database.prepare(`UPDATE wake_nonces SET state = 'not-submitted', outcome_at = coalesce(outcome_at, ?)
          WHERE nonce_digest = ? AND state = 'reserved'`).run(iso(nowMs), String(active.nonce_digest));
        active = void 0;
      }
      if (active) {
        if (active.state === "started" && !this.wakeBindingCurrent(this.wakeAttempt(active), String(active.birth_generation), nowMs)) {
          this.database.prepare("UPDATE wake_nonces SET state = 'unknown' WHERE nonce_digest = ? AND state = 'started'").run(String(active.nonce_digest));
        }
        if (active.state === "reserved" && input.resume === true && input.instanceId === active.instance_id && input.transport === active.transport && this.wakeBindingCurrent(input, String(active.birth_generation), nowMs) && (active.retry_not_before === null || String(active.retry_not_before) <= iso(nowMs))) {
          this.database.prepare("UPDATE wake_nonces SET relay_id = ? WHERE nonce_digest = ? AND state = 'reserved'").run(input.relayId, String(active.nonce_digest));
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
              OR (state = 'not-submitted' AND retry_not_before > ?)`).get(iso(nowMs));
          if (count.n >= MESSAGE_LIMIT) throw new Error("The bounded active wake store is full.");
          const generation = this.presence(input, nowMs).startedAt;
          const attemptId = randomUUID3();
          this.database.prepare(`INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at, state, nonce,
            instance_id, birth_generation, transport, relay_id, attempt_id) VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?)`).run(
            nonceDigest(input.nonce),
            input.host,
            input.sessionId,
            iso(nowMs + WAKE_TTL_MS),
            input.nonce,
            input.instanceId,
            generation,
            input.transport,
            input.relayId,
            attemptId
          );
          attempt = { ...input, generation, attemptId, dispatchEpoch: 0 };
        }
      }
      this.database.exec("COMMIT");
      return { dispatch: attempt !== null, attempt };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  /** CAS succeeds once. The caller must not call a host adapter without this committed start. */
  startManagedWake(attempt, nowMs = Date.now()) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`SELECT * FROM wake_nonces WHERE nonce_digest = ? AND host = ? AND session_id = ?
        AND state = 'reserved' AND instance_id = ? AND birth_generation = ? AND transport = ? AND relay_id = ? AND attempt_id = ? AND dispatch_epoch = ?`).get(
        nonceDigest(attempt.nonce),
        attempt.host,
        attempt.sessionId,
        attempt.instanceId,
        attempt.generation,
        attempt.transport,
        attempt.relayId,
        attempt.attemptId,
        attempt.dispatchEpoch
      );
      if (!row || !this.wakeBindingCurrent(attempt, attempt.generation, nowMs) || row.retry_not_before !== null && String(row.retry_not_before) > iso(nowMs)) {
        this.database.exec("COMMIT");
        return { dispatch: false, attempt: null };
      }
      if (String(row.expires_at) <= iso(nowMs) || !this.wakeClaimable(attempt, nowMs)) {
        this.database.prepare("UPDATE wake_nonces SET state = 'not-submitted', outcome_at = ? WHERE nonce_digest = ? AND state = 'reserved'").run(iso(nowMs), nonceDigest(attempt.nonce));
        this.database.exec("COMMIT");
        return { dispatch: false, attempt: null };
      }
      this.database.prepare("UPDATE wake_nonces SET state = 'started', started_at = ?, dispatch_epoch = dispatch_epoch + 1 WHERE nonce_digest = ?").run(iso(nowMs), nonceDigest(attempt.nonce));
      this.database.exec("COMMIT");
      return { dispatch: true, attempt: { ...attempt, dispatchEpoch: attempt.dispatchEpoch + 1 } };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  recordManagedWakeOutcome(attempt, outcome, nowMs = Date.now()) {
    if (!["submitted", "definite-failure", "accepted-or-unknown"].includes(outcome)) throw new Error("Invalid wake dispatch outcome.");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`SELECT retry_count FROM wake_nonces WHERE nonce_digest = ? AND host = ? AND session_id = ?
        AND instance_id = ? AND birth_generation = ? AND transport = ? AND relay_id = ? AND attempt_id = ? AND dispatch_epoch = ?
        AND late_observed_at IS NULL AND observed_at IS NULL AND consumed_at IS NULL
        AND state IN ('started', 'unknown')`).get(
        nonceDigest(attempt.nonce),
        attempt.host,
        attempt.sessionId,
        attempt.instanceId,
        attempt.generation,
        attempt.transport,
        attempt.relayId,
        attempt.attemptId,
        attempt.dispatchEpoch
      );
      if (!row) {
        this.database.exec("COMMIT");
        return false;
      }
      const retry = outcome === "definite-failure";
      const nextState = retry ? this.wakeGenerationReplaced(attempt, nowMs) ? "not-submitted" : "reserved" : outcome === "submitted" ? "submitted" : "unknown";
      this.database.prepare(`UPDATE wake_nonces SET state = ?, outcome_at = ?, retry_not_before = ?, retry_count = ?
        WHERE nonce_digest = ?`).run(
        nextState,
        iso(nowMs),
        retry ? iso(nowMs + wakeBackoffDelay(row.retry_count)) : null,
        row.retry_count + (retry ? 1 : 0),
        nonceDigest(attempt.nonce)
      );
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  managedWakeStatus(target, nowMs = Date.now()) {
    boundedIdentity(target);
    const row = this.database.prepare(`SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AND state <> 'legacy'
      ORDER BY CASE WHEN state IN ('reserved', 'started', 'submitted', 'unknown') THEN 0 ELSE 1 END, rowid DESC LIMIT 1`).get(target.host, target.sessionId);
    if (!row) return null;
    const active = ["reserved", "started", "submitted", "unknown"].includes(String(row.state));
    const retired = row.state === "expired-unobserved";
    return {
      state: row.state,
      observation: row.state === "observed" ? "observed" : retired ? "expired-unobserved" : row.late_observed_at !== null ? "unknown" : active && String(row.expires_at) <= iso(nowMs) ? "observation-overdue" : active ? "pending" : "not-submitted",
      deliveryState: row.state === "started" || row.state === "unknown" || retired ? "unknown" : row.state,
      retiredAt: row.retired_at,
      instanceId: row.instance_id,
      generation: row.birth_generation,
      attemptId: row.attempt_id,
      dispatchEpoch: row.dispatch_epoch,
      retryNotBefore: row.retry_not_before,
      expiresAt: row.expires_at,
      observedAt: row.observed_at,
      lateObservedAt: row.late_observed_at
    };
  }
  /** Terminal-only maintenance. Historical evidence cannot claim bodies or observe a current relay. */
  reconcileHistoricalWake(target, attemptId, sourceReceiptId, nowMs = Date.now(), verify = verifyHistoricalWakeObservation) {
    boundedIdentity(target);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(attemptId) || !/^source-[A-Za-z0-9-]{1,128}$/u.test(sourceReceiptId)) throw new Error("Invalid historical wake identity.");
    const rejected = { reconciled: false, evidence: null };
    const isOldGeneration = (row) => {
      const presence = this.presence(target, nowMs);
      return presence.instanceId !== null && presence.startedAt !== null && (row.instance_id !== presence.instanceId || row.birth_generation !== presence.startedAt);
    };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`SELECT * FROM wake_nonces WHERE host = ? AND session_id = ? AND attempt_id = ?
        AND state = 'unknown' AND late_observed_at IS NOT NULL AND consumed_at IS NULL AND observed_at IS NULL`).get(target.host, target.sessionId, attemptId);
      if (!row || ![row.nonce, row.instance_id, row.birth_generation, row.transport, row.relay_id, row.started_at].every((value) => typeof value === "string") || row.nonce_digest !== nonceDigest(String(row.nonce)) || Number(row.dispatch_epoch) < 1 || !isOldGeneration(row)) {
        this.database.exec("COMMIT");
        return rejected;
      }
      const proof = verify(target, String(row.nonce), sourceReceiptId, String(row.started_at), String(row.late_observed_at), nowMs);
      if (!proof || !isOldGeneration(row)) {
        this.database.exec("COMMIT");
        return rejected;
      }
      const changed = this.database.prepare(`UPDATE wake_nonces SET state = 'observed', observed_at = ?, consumed_at = ?
        WHERE nonce_digest = ? AND nonce = ? AND host = ? AND session_id = ? AND attempt_id = ?
        AND instance_id = ? AND birth_generation = ? AND transport = ? AND relay_id = ? AND dispatch_epoch = ?
        AND state = 'unknown' AND started_at = ? AND late_observed_at = ? AND consumed_at IS NULL AND observed_at IS NULL`).run(
        proof.observedAt,
        iso(nowMs),
        String(row.nonce_digest),
        String(row.nonce),
        target.host,
        target.sessionId,
        attemptId,
        String(row.instance_id),
        String(row.birth_generation),
        String(row.transport),
        String(row.relay_id),
        Number(row.dispatch_epoch),
        String(row.started_at),
        String(row.late_observed_at)
      ).changes;
      this.database.exec("COMMIT");
      if (changed !== 1) return rejected;
      const attempt = this.wakeAttempt(row);
      const oldBinding = {
        host: attempt.host,
        sessionId: attempt.sessionId,
        instanceId: attempt.instanceId,
        generation: attempt.generation,
        transport: attempt.transport,
        relayId: attempt.relayId,
        attemptId: attempt.attemptId,
        dispatchEpoch: attempt.dispatchEpoch
      };
      return { reconciled: true, evidence: { ...proof, oldBinding, lateObservedAt: String(row.late_observed_at), reconciledAt: iso(nowMs) } };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  /** Verified arrival retires its attempt; only current bindings may claim bodies in the same transaction. */
  claimHostWake(target, observation, receiptId, reader, nowMs = Date.now(), limits = {}) {
    boundedIdentity(target);
    const rejected = { recognized: false, messages: [], binding: null };
    if (!isWakeHookObservation(observation, target) || !reader) return rejected;
    const digests = [...new Set(observation.wakeCandidates.map(nonceDigest))];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!reader.verifyObservation(target, observation, receiptId, nowMs)) {
        this.database.exec("COMMIT");
        return rejected;
      }
      const rows = digests.map((digest) => this.database.prepare("SELECT * FROM wake_nonces WHERE nonce_digest = ? AND host = ? AND session_id = ?").get(digest, target.host, target.sessionId));
      if (rows.some((row) => !row || !["legacy", "started", "submitted", "unknown", "expired-unobserved"].includes(String(row.state)))) {
        this.database.exec("COMMIT");
        return rejected;
      }
      this.recordActivity(target, nowMs);
      const presence = this.presence(target, nowMs);
      const retired = rows.some((row) => row.state === "expired-unobserved");
      const valid = !retired && rows.every((row) => row.state === "legacy" ? row.consumed_at === null && String(row.expires_at) > iso(nowMs) : row.instance_id === presence.instanceId && row.birth_generation === presence.startedAt && row.transport === presence.transport && presence.state === "online" && presence.deliveryCapabilities.supportedInjection.includes("peer-wake") && String(row.expires_at) > iso(nowMs));
      if (!valid) {
        for (const row of rows) if (row.state !== "legacy") this.database.prepare(`UPDATE wake_nonces
          SET late_observed_at = coalesce(late_observed_at, ?), state = 'observed', consumed_at = ?, observed_at = ?
          WHERE nonce_digest = ? AND state IN ('started', 'submitted', 'unknown')`).run(iso(nowMs), iso(nowMs), iso(nowMs), String(row.nonce_digest));
        this.database.prepare(`UPDATE wake_nonces SET late_observed_at = coalesce(late_observed_at, ?)
          WHERE host = ? AND session_id = ? AND state = 'expired-unobserved' AND nonce_digest IN (SELECT value FROM json_each(?))`).run(iso(nowMs), target.host, target.sessionId, JSON.stringify(digests));
        this.database.exec("COMMIT");
        return retired ? { ...rejected, retired: true } : rejected;
      }
      const messages = this.claimLocked(target, nowMs, limits);
      let binding = null;
      for (const row of rows) {
        if (row.state === "legacy") this.database.prepare("UPDATE wake_nonces SET consumed_at = ? WHERE nonce_digest = ?").run(iso(nowMs), String(row.nonce_digest));
        else {
          this.database.prepare("UPDATE wake_nonces SET state = 'observed', consumed_at = ?, observed_at = ? WHERE nonce_digest = ?").run(iso(nowMs), iso(nowMs), String(row.nonce_digest));
          binding = this.wakeAttempt(row);
        }
      }
      this.database.exec("COMMIT");
      return { recognized: true, messages, binding };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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
      input.host,
      input.sessionId,
      input.instanceId,
      input.transport,
      input.wakeVisibility,
      input.canWakeSilently ? 1 : 0,
      JSON.stringify(input.deliveryCapabilities?.supportedInjection ?? []),
      input.deliveryCapabilities?.idleWake ?? input.wakeVisibility,
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
      WHERE host = ? AND session_id = ? AND instance_id = ? AND ended_at IS NULL AND lease_until > ?`).get(target.host, target.sessionId, instanceId, iso(nowMs));
    const selected = row;
    if (!selected) return false;
    const now = iso(nowMs);
    return this.database.prepare(`UPDATE session_presence SET heartbeat_at = ?, lease_until = ?
      WHERE host = ? AND session_id = ? AND instance_id = ? AND ended_at IS NULL AND lease_until > ?`).run(now, iso(nowMs + PRESENCE_LEASE_MS), target.host, target.sessionId, selected.instance_id, now).changes === 1;
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
      deliveryCapabilities: { supportedInjection: [], idleWake: "none" },
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
      deliveryCapabilities: {
        supportedInjection: JSON.parse(String(row.supported_injection)),
        idleWake: row.idle_wake
      },
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
    this.prune(nowMs);
    const identities = this.database.prepare(`SELECT host, session_id FROM session_presence
      GROUP BY host, session_id ORDER BY host, session_id`).all();
    return identities.map((row) => {
      const target = { host: row.host, sessionId: row.session_id };
      return { ...this.presence(target, nowMs), autoWake: this.autoWakeOutlook(target, nowMs) };
    });
  }
};

// mcp-server/src/peer-wait-policy.ts
var RECORD_TTL_MS = 3e4;
var RECORD_LIMIT = 1e3;
function identityKey(identity2) {
  return JSON.stringify([identity2.host, identity2.sessionId]);
}
function normalizePeerWaitTargets(targets) {
  const unique = new Map(targets.map((target) => [identityKey(target), { host: target.host, sessionId: target.sessionId }]));
  return [...unique.keys()].sort().map((key) => unique.get(key));
}
var PeerWaitPolicy = class {
  snapshots = /* @__PURE__ */ new Map();
  reset(sender) {
    const owner = identityKey(sender);
    for (const [key, record] of this.snapshots) if (record.owner === owner) this.snapshots.delete(key);
  }
  decide(input, nowMs = Date.now()) {
    for (const [key2, record] of this.snapshots) if (record.expiresAt <= nowMs) this.snapshots.delete(key2);
    const transmission = input.peersObserved ? "observed" : "unknown";
    const resume = input.resumeObserved ? "observed" : "unknown";
    const guidance = input.resumeObserved && input.peersObserved ? "Use one immediate snapshot (timeoutMs: 0), then continue independent work or return; peer delivery can resume this session. A receipt or ACK is not task completion or approval." : "Async resume is unconfirmed. Use a bounded query or bounded wait and continue on the next user turn; do not assume returning will wake this session.";
    if (!input.peersObserved || !input.resumeObserved) return {
      action: "bounded",
      reason: input.peersObserved ? "resume-unconfirmed" : "peer-unconfirmed",
      transmission,
      resume,
      guidance
    };
    if (input.timeoutMs > 0) return { action: "deny", reason: "async-resume", transmission, resume, guidance };
    const owner = identityKey(input.sender);
    const key = JSON.stringify([owner, normalizePeerWaitTargets(input.targets).map(identityKey)]);
    const previous = this.snapshots.get(key);
    if (previous?.fingerprint === input.fingerprint) return { action: "deny", reason: "unchanged-peer-state", transmission, resume, guidance };
    if (this.snapshots.size >= RECORD_LIMIT) this.snapshots.delete(this.snapshots.keys().next().value);
    this.snapshots.set(key, { owner, fingerprint: input.fingerprint, expiresAt: nowMs + RECORD_TTL_MS });
    return { action: "snapshot", reason: "async-resume", transmission, resume, guidance };
  }
};

// mcp-server/src/self-signed-certificate.ts
import { generateKeyPairSync, randomBytes as randomBytes2, sign, X509Certificate } from "node:crypto";
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
  const serialNumber = randomBytes2(16);
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
var SESSION_MESSAGE_BROKER_CAPABILITIES = ["atomic-wake-claim", "deferred-boundary", "delivery-capabilities", "peer-wait-policy"];
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
function wakeAttempt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Wake attempt is required.");
  const attempt = value;
  const result = {
    ...identity(attempt),
    nonce: string(attempt.nonce, "nonce"),
    instanceId: string(attempt.instanceId, "instanceId"),
    transport: string(attempt.transport, "transport"),
    relayId: string(attempt.relayId, "relayId"),
    generation: string(attempt.generation, "generation"),
    attemptId: string(attempt.attemptId, "attemptId"),
    dispatchEpoch: integer2(attempt.dispatchEpoch, "dispatchEpoch")
  };
  if (result.nonce.length > 128 || result.generation.length > 100 || result.attemptId.length > 128 || result.instanceId.length > 128 || result.transport.length > 64 || result.relayId.length > 128 || result.dispatchEpoch < 0) throw new Error("Invalid wake attempt.");
  return result;
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
function supportedInjection(value) {
  const allowed = /* @__PURE__ */ new Set(["user-input", "peer-wake", "tool-boundary", "turn-end", "unknown"]);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !allowed.has(item))) {
    throw new Error("supportedInjection is invalid.");
  }
  return [...new Set(value)];
}
function tokenMatches(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual2(left, right);
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
  const keyPath = path4.join(stateDirectory, "broker-key.pem");
  const certificatePath = path4.join(stateDirectory, "broker-cert.pem");
  const tokenPath = path4.join(stateDirectory, "broker.token");
  let key = "";
  let certificate = "";
  let regenerate = true;
  if (existsSync2(keyPath) && existsSync2(certificatePath)) {
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
    if (existsSync2(keyPath) || existsSync2(certificatePath)) {
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
  if (existsSync2(tokenPath)) token = (await readFile(tokenPath, "utf8")).trim();
  else token = "";
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    token = randomBytes3(32).toString("base64url");
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
var peerWaitRuntimes = /* @__PURE__ */ new WeakMap();
function peerWaitRuntime(store) {
  let runtime = peerWaitRuntimes.get(store);
  if (!runtime) {
    runtime = { policy: new PeerWaitPolicy(), relays: /* @__PURE__ */ new Map(), wakes: /* @__PURE__ */ new Map() };
    peerWaitRuntimes.set(store, runtime);
  }
  for (const [key, value] of runtime.relays) if (value.expiresAt <= Date.now()) runtime.relays.delete(key);
  for (const [key, value] of runtime.wakes) if (value.expiresAt <= Date.now()) runtime.wakes.delete(key);
  return runtime;
}
function observePeerRelay(store, payload, accepted) {
  if (!accepted || typeof payload.instanceId !== "string") return;
  const target = identity(payload.target);
  const presence = store.presence(target);
  const relay = store.liveRelay(target, string(payload.transport, "transport"));
  if (presence.instanceId !== payload.instanceId || presence.transport !== payload.transport || presence.state !== "online" || relay === null || relay.relayId !== payload.relayId) return;
  const runtime = peerWaitRuntime(store);
  if (runtime.relays.size >= 1e3) runtime.relays.delete(runtime.relays.keys().next().value);
  const key = JSON.stringify(target);
  const previous = runtime.relays.get(key);
  const wakeObservedAt = previous?.instanceId === payload.instanceId && previous.relayId === relay.relayId ? previous.wakeObservedAt : void 0;
  runtime.relays.set(key, {
    instanceId: payload.instanceId,
    relayId: relay.relayId,
    expiresAt: Date.now() + 15e3,
    ...wakeObservedAt === void 0 ? {} : { wakeObservedAt }
  });
}
function dispatchSessionMessageBrokerOperation(store, operation, payload, wakeObserver, historicalWakeVerifier = verifyHistoricalWakeObservation) {
  switch (operation) {
    case "ping":
      return { protocolVersion: SESSION_MESSAGE_PROTOCOL, capabilities: SESSION_MESSAGE_BROKER_CAPABILITIES };
    case "prepare": {
      if (Object.keys(payload).some((key) => !["sender", "target", "body", "ttlSeconds"].includes(key))) throw new Error("prepare accepts sender, target, body and ttlSeconds; IDs are system-issued.");
      const ttlSeconds = optionalInteger(payload, "ttlSeconds");
      return store.prepare({
        sender: identity(payload.sender),
        target: identity(payload.target),
        body: string(payload.body, "body"),
        ...ttlSeconds === void 0 ? {} : { ttlSeconds }
      });
    }
    case "send": {
      if (Object.keys(payload).some((key) => !["sender", "messageId"].includes(key))) throw new Error("send accepts only sender and the ID returned by prepare; message content is immutable. Retry the known ID or compare saved receipts/status if delivery is unknown.");
      return store.submitPrepared(identity(payload.sender), string(payload.messageId, "messageId"));
    }
    case "claim": {
      const maxMessages = optionalInteger(payload, "maxMessages");
      const maxBodyChars = optionalInteger(payload, "maxBodyChars");
      return { messages: store.claim(identity(payload.target), Date.now(), {
        ...maxMessages === void 0 ? {} : { maxMessages },
        ...maxBodyChars === void 0 ? {} : { maxBodyChars }
      }) };
    }
    case "claim-wake": {
      const maxMessages = optionalInteger(payload, "maxMessages");
      const maxBodyChars = optionalInteger(payload, "maxBodyChars");
      const nonces = Array.isArray(payload.nonces) ? payload.nonces.map((value) => string(value, "nonce")) : [];
      const target = identity(payload.target);
      const result = store.claimWake(target, nonces, Date.now(), {
        ...maxMessages === void 0 ? {} : { maxMessages },
        ...maxBodyChars === void 0 ? {} : { maxBodyChars }
      });
      const runtime = peerWaitRuntime(store);
      const owner = JSON.stringify(target);
      const binding = runtime.relays.get(owner);
      const presence = store.presence(target);
      const wakeKeys = nonces.map((nonce) => createHash3("sha256").update(nonce).digest("hex"));
      const sameGeneration = wakeKeys.length > 0 && wakeKeys.every((key) => {
        const wake = runtime.wakes.get(key);
        return wake?.owner === owner && wake.instanceId === binding?.instanceId && wake.relayId === binding?.relayId;
      });
      if (result.recognized && sameGeneration && binding?.instanceId === presence.instanceId && presence.state === "online") binding.wakeObservedAt = Date.now();
      for (const key of wakeKeys) runtime.wakes.delete(key);
      return result;
    }
    case "claim-host-wake": {
      if (Object.keys(payload).some((key) => !["target", "observation", "sourceReceiptId", "maxMessages", "maxBodyChars"].includes(key))) {
        throw new Error("Host wake claim requires a non-authorizing hook source receipt.");
      }
      const target = identity(payload.target);
      const maxMessages = optionalInteger(payload, "maxMessages");
      const maxBodyChars = optionalInteger(payload, "maxBodyChars");
      const result = store.claimHostWake(
        target,
        payload.observation,
        typeof payload.sourceReceiptId === "string" ? payload.sourceReceiptId : "",
        wakeObserver,
        Date.now(),
        {
          ...maxMessages === void 0 ? {} : { maxMessages },
          ...maxBodyChars === void 0 ? {} : { maxBodyChars }
        }
      );
      const runtime = peerWaitRuntime(store);
      const binding = runtime.relays.get(JSON.stringify(target));
      if (result.recognized && result.binding && binding?.instanceId === result.binding.instanceId && binding.relayId === result.binding.relayId) binding.wakeObservedAt = Date.now();
      if (result.recognized && !result.binding && binding) {
        const nonces = payload.observation.wakeCandidates ?? [];
        const owner = JSON.stringify(target);
        const presence = store.presence(target);
        const keys = nonces.map((nonce) => createHash3("sha256").update(nonce).digest("hex"));
        if (keys.length > 0 && keys.every((key) => {
          const wake = runtime.wakes.get(key);
          return wake?.owner === owner && wake.instanceId === binding.instanceId && wake.relayId === binding.relayId;
        }) && presence.state === "online" && presence.instanceId === binding.instanceId) binding.wakeObservedAt = Date.now();
        for (const key of keys) runtime.wakes.delete(key);
      }
      return { recognized: result.recognized, messages: result.messages, managed: result.binding !== null, ...result.retired ? { retired: true } : {} };
    }
    case "observe-native-input": {
      peerWaitRuntime(store).policy.reset(identity(payload.target));
      store.observeNativeInput(identity(payload.target));
      return { observed: true };
    }
    case "claim-deferred": {
      const maxMessages = optionalInteger(payload, "maxMessages");
      const maxBodyChars = optionalInteger(payload, "maxBodyChars");
      return { messages: store.claimDeferred(identity(payload.target), Date.now(), {
        ...maxMessages === void 0 ? {} : { maxMessages },
        ...maxBodyChars === void 0 ? {} : { maxBodyChars }
      }) };
    }
    case "claim-turn-end": {
      const maxMessages = optionalInteger(payload, "maxMessages");
      const maxBodyChars = optionalInteger(payload, "maxBodyChars");
      return { messages: store.claimTurnEnd(identity(payload.target), Date.now(), {
        ...maxMessages === void 0 ? {} : { maxMessages },
        ...maxBodyChars === void 0 ? {} : { maxBodyChars }
      }) };
    }
    case "clear-deferred": {
      store.clearDeferred(identity(payload.target));
      return { cleared: true };
    }
    case "acknowledge":
      return { acknowledged: store.acknowledge(identity(payload.target), Array.isArray(payload.messageIds) ? payload.messageIds.map((value) => string(value, "messageId")) : []) };
    case "status": {
      const status = store.status(identity(payload.sender), string(payload.messageId, "messageId"));
      return { status, ...status === null ? { guidance: "Delivery is unknown; compare saved receipts. Prepare only a new intent, not an automatic resend." } : {} };
    }
    case "peer-wait": {
      const sender = identity(payload.sender);
      if (!Array.isArray(payload.targets) || payload.targets.length < 1 || payload.targets.length > 8) throw new Error("targets must contain 1..8 identities.");
      const targets = normalizePeerWaitTargets(payload.targets.map(identity));
      const timeoutMs = integer2(payload.timeoutMs, "timeoutMs");
      if (timeoutMs < 0 || timeoutMs > 36e5) throw new Error("timeoutMs is out of range.");
      const queryRevision = optionalString(payload, "queryRevision") ?? "";
      if (queryRevision.length > 256) throw new Error("queryRevision is too long.");
      const runtime = peerWaitRuntime(store);
      const presence = store.presence(sender);
      const binding = runtime.relays.get(JSON.stringify(sender));
      const relay = presence.transport ? store.liveRelay(sender, presence.transport) : null;
      const resumeObserved = presence.state === "online" && presence.instanceId !== null && binding?.instanceId === presence.instanceId && binding.wakeObservedAt !== void 0 && Date.now() - binding.wakeObservedAt < 3e4 && binding.relayId === relay?.relayId && relay !== null && alive(relay.pid) && alive(relay.parentPid) && presence.deliveryCapabilities.idleWake !== "none" && presence.wakeVisibility === presence.deliveryCapabilities.idleWake && presence.deliveryCapabilities.supportedInjection.includes("peer-wake");
      const states = targets.map((target) => store.peerWaitState(sender, target));
      const decision = runtime.policy.decide({
        sender,
        targets,
        timeoutMs,
        peersObserved: states.every((state) => state.related),
        resumeObserved,
        fingerprint: JSON.stringify([presence.instanceId, queryRevision, states.map((state) => state.fingerprint)])
      });
      return { ...decision, peers: targets.map((target, index) => ({ target, related: states[index].related, stateDigest: states[index].fingerprint })) };
    }
    case "pending":
      return { count: store.pendingCount(identity(payload.target)) };
    case "acquire-relay": {
      const target = identity(payload.target);
      const acquired = store.acquireRelay({
        ...target,
        transport: string(payload.transport, "transport"),
        relayId: string(payload.relayId, "relayId"),
        pid: integer2(payload.pid, "pid"),
        parentPid: integer2(payload.parentPid, "parentPid")
      });
      observePeerRelay(store, payload, acquired);
      return { acquired };
    }
    case "heartbeat-relay": {
      const target = identity(payload.target);
      const isAlive = store.heartbeatRelay({ ...target, transport: string(payload.transport, "transport"), relayId: string(payload.relayId, "relayId") });
      observePeerRelay(store, payload, isAlive);
      return { alive: isAlive };
    }
    case "relay-tick": {
      const result = store.relayTick({
        ...identity(payload.target),
        transport: string(payload.transport, "transport"),
        relayId: string(payload.relayId, "relayId"),
        instanceId: string(payload.instanceId, "instanceId"),
        includePending: boolean(payload.includePending, "includePending")
      });
      observePeerRelay(store, payload, result.alive);
      return result;
    }
    case "presence-start": {
      const target = identity(payload.target);
      const wakeVisibility = string(payload.wakeVisibility, "wakeVisibility");
      const collaborationId = optionalString(payload, "collaborationId");
      const workspaceId = optionalString(payload, "workspaceId");
      const role = optionalString(payload, "role");
      const idleWake = optionalString(payload, "idleWake") ?? wakeVisibility;
      const injection = Object.hasOwn(payload, "supportedInjection") ? supportedInjection(payload.supportedInjection) : [];
      if (wakeVisibility !== "silent" && wakeVisibility !== "user-message" && wakeVisibility !== "none") throw new Error("wakeVisibility is invalid.");
      if (idleWake !== "silent" && idleWake !== "user-message" && idleWake !== "none") throw new Error("idleWake is invalid.");
      return { presence: store.startPresence({
        ...target,
        instanceId: string(payload.instanceId, "instanceId"),
        transport: string(payload.transport, "transport"),
        wakeVisibility,
        canWakeSilently: boolean(payload.canWakeSilently, "canWakeSilently"),
        deliveryCapabilities: { supportedInjection: injection, idleWake },
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
    case "reserve-wake": {
      const target = identity(payload.target);
      const nonce = string(payload.nonce, "nonce");
      if (["instanceId", "relayId", "transport", "resume"].some((key) => Object.hasOwn(payload, key))) {
        return store.reserveManagedWake({
          ...target,
          nonce,
          instanceId: string(payload.instanceId, "instanceId"),
          relayId: string(payload.relayId, "relayId"),
          transport: string(payload.transport, "transport"),
          ...payload.resume === void 0 ? {} : { resume: boolean(payload.resume, "resume") }
        }, Date.now());
      }
      const shouldDispatch = store.reserveWake(target, nonce);
      const runtime = peerWaitRuntime(store);
      const owner = JSON.stringify(target);
      const binding = runtime.relays.get(owner);
      if (shouldDispatch && binding && binding.instanceId === store.presence(target).instanceId) {
        if (runtime.wakes.size >= 1e3) runtime.wakes.delete(runtime.wakes.keys().next().value);
        runtime.wakes.set(createHash3("sha256").update(nonce).digest("hex"), { owner, instanceId: binding.instanceId, relayId: binding.relayId, expiresAt: Date.now() + 36e5 });
      }
      return { dispatch: shouldDispatch };
    }
    case "start-wake":
      return store.startManagedWake(wakeAttempt(payload.attempt), Date.now());
    case "record-wake-outcome": {
      const outcome = string(payload.outcome, "outcome");
      if (outcome !== "submitted" && outcome !== "definite-failure" && outcome !== "accepted-or-unknown") throw new Error("Invalid wake dispatch outcome.");
      return { recorded: store.recordManagedWakeOutcome(wakeAttempt(payload.attempt), outcome) };
    }
    case "reconcile-wake-observation": {
      if (Object.keys(payload).some((key) => !["target", "attemptId", "sourceReceiptId"].includes(key)) || !payload.target || typeof payload.target !== "object" || Array.isArray(payload.target) || Object.keys(payload.target).some((key) => !["host", "sessionId"].includes(key))) {
        throw new Error("Historical wake reconciliation contains unsupported fields.");
      }
      return store.reconcileHistoricalWake(
        identity(payload.target),
        string(payload.attemptId, "attemptId"),
        string(payload.sourceReceiptId, "sourceReceiptId"),
        Date.now(),
        historicalWakeVerifier
      );
    }
    case "wake-status":
      return { wake: store.managedWakeStatus(identity(payload.target)) };
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
  const lockPath = path4.join(stateDirectory, "broker.lock");
  const lockDescriptor = acquireProcessLock(lockPath);
  if (lockDescriptor === null) return "already-running";
  const endpointPath = path4.join(stateDirectory, "endpoint.json");
  const databasePath = path4.join(stateDirectory, "session-messages.sqlite3");
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
    const trustDatabasePath = process.env.AGENT_GOVERNANCE_TRUST_DB_PATH?.trim() ? path4.resolve(process.env.AGENT_GOVERNANCE_TRUST_DB_PATH.trim()) : path4.join(stateDirectory, "trust.sqlite3");
    const wakeHookObservationReader = createWakeHookObservationReader(trustDatabasePath);
    const historicalWakeVerifier = (target, nonce, sourceReceiptId, startedAt, lateObservedAt, nowMs) => verifyHistoricalWakeObservation(target, nonce, sourceReceiptId, startedAt, lateObservedAt, nowMs, trustDatabasePath);
    let lastActivity = Date.now();
    const activeServer = tls.createServer({ key, cert: certificate, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, (socket) => {
      lastActivity = Date.now();
      let buffer = "";
      socket.on("error", () => socket.destroy());
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
          const data = dispatchSessionMessageBrokerOperation(activeStore, request.operation, payload, wakeHookObservationReader, historicalWakeVerifier);
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
    temporary = `${endpointPath}.${process.pid}.${createHash3("sha256").update(String(Date.now())).digest("hex").slice(0, 8)}.tmp`;
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
if (path4.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const stateDirectory = argument("--state-directory");
  if (!stateDirectory) process.exitCode = 2;
  else void startSessionMessageBroker(path4.resolve(stateDirectory)).then((result) => {
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
  SESSION_MESSAGE_BROKER_CAPABILITIES,
  dispatchSessionMessageBrokerOperation,
  startSessionMessageBroker
};
