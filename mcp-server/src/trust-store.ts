import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  CONTRACT_VERSION,
  type InputSourceReceiptV1,
  type SessionBindingV1,
  WorkflowContractError,
} from "../../contracts/types.js";
import { canonicalJson } from "./convergence-logic.js";

type UnsignedInputSource = Omit<InputSourceReceiptV1, "schemaVersion" | "receiptId" | "integrityToken">;
interface ReceiptRow { receipt_json: string }

const TRUST_SIGNING_KEY = "trust-signing-key";
const SCHEMA_VERSION = 1;
const INPUT_SOURCE_KEYS = new Set([
  "originKind", "host", "sessionId", "eventId", "contentDigest", "observedAt", "expiresAt", "authorityEffect", "attestation",
]);
const ATTESTATION_KEYS = new Set(["kind", "adapter", "capabilityVersion"]);

function rejectUnexpectedKeys(value: object, allowed: Set<string>, label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new WorkflowContractError("INVALID_INPUT", `${label} contains unsupported fields.`, { unexpected });
  }
}

/** Stores source provenance metadata and content digests only; raw prompt and message bodies are never accepted. */
export class TrustStore {
  private readonly database: DatabaseSync;
  private readonly signingKey: Buffer;
  private closed = false;

  constructor(readonly databasePath: string) {
    if (!databasePath.trim()) throw new WorkflowContractError("INVALID_INPUT", "Trust database path must not be empty.");
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    try {
      this.database.exec("PRAGMA busy_timeout = 5000;");
      this.database.exec("PRAGMA synchronous = FULL;");
      if (databasePath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
      this.initializeSchema();
      this.signingKey = Buffer.from(this.getOrCreateSecret(TRUST_SIGNING_KEY), "base64url");
      if (this.signingKey.length !== 32) throw new Error("Stored trust signing key is invalid.");
      if (databasePath !== ":memory:" && process.platform !== "win32") chmodSync(path.resolve(databasePath), 0o600);
    } catch (cause) {
      try { this.database.close(); } catch { /* Preserve initialization failure. */ }
      if (cause instanceof WorkflowContractError) throw cause;
      throw this.storageError("Cannot initialize the trust database.", cause);
    }
  }

  recordInputSource(input: UnsignedInputSource): InputSourceReceiptV1 {
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
        capabilityVersion: input.attestation.capabilityVersion,
      },
    });
    return this.guard("Cannot record the input source receipt.", { receiptId: receipt.receiptId }, () => this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT receipt_json FROM input_source_receipts
        WHERE host = ? AND session_id = ? AND event_id = ?
      `).get(receipt.host, receipt.sessionId, receipt.eventId) as ReceiptRow | undefined;
      if (existing) {
        const prior = JSON.parse(existing.receipt_json) as InputSourceReceiptV1;
        const sameSecurityMetadata = prior.contentDigest === receipt.contentDigest
          && prior.originKind === receipt.originKind
          && prior.authorityEffect === receipt.authorityEffect
          && canonicalJson(prior.attestation, "Source attestation") === canonicalJson(receipt.attestation, "Source attestation");
        if (sameSecurityMetadata) return structuredClone(prior);
        throw new WorkflowContractError("REQUEST_CONFLICT", "The input event was already recorded with different content or provenance metadata.", {
          host: receipt.host,
          sessionId: receipt.sessionId,
          eventId: receipt.eventId,
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
        JSON.stringify(receipt),
      );
      return structuredClone(receipt);
    }));
  }

  latestInputSource(binding: SessionBindingV1): InputSourceReceiptV1 | null {
    return this.guard("Cannot read the latest input source receipt.", { ...binding }, () => {
      const row = this.database.prepare(`
        SELECT receipt_json FROM input_source_receipts
        WHERE host = ? AND session_id = ?
        ORDER BY observed_at DESC, receipt_id DESC LIMIT 1
      `).get(binding.host, binding.sessionId) as ReceiptRow | undefined;
      return row ? JSON.parse(row.receipt_json) as InputSourceReceiptV1 : null;
    });
  }

  getInputSource(receiptId: string): InputSourceReceiptV1 | null {
    return this.guard("Cannot read the input source receipt.", { receiptId }, () => {
      const row = this.database.prepare("SELECT receipt_json FROM input_source_receipts WHERE receipt_id = ?")
        .get(receiptId) as ReceiptRow | undefined;
      return row ? JSON.parse(row.receipt_json) as InputSourceReceiptV1 : null;
    });
  }

  verify(receipt: InputSourceReceiptV1): boolean {
    try {
      const { integrityToken, ...unsigned } = receipt;
      const actual = Buffer.from(integrityToken, "base64url");
      const expected = createHmac("sha256", this.signingKey).update(canonicalJson(unsigned, "Input source receipt")).digest();
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private seal(unsigned: Omit<InputSourceReceiptV1, "integrityToken">): InputSourceReceiptV1 {
    return {
      ...unsigned,
      integrityToken: createHmac("sha256", this.signingKey)
        .update(canonicalJson(unsigned, "Input source receipt"))
        .digest("base64url"),
    };
  }

  private initializeSchema(): void {
    const version = (this.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > SCHEMA_VERSION) {
      throw new WorkflowContractError("INVALID_INPUT", "Trust database schema is newer than this server supports.", {
        databasePath: this.databasePath,
        supportedVersion: SCHEMA_VERSION,
        actualVersion: version,
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

  private getOrCreateSecret(name: string): string {
    return this.transaction(() => {
      const existing = this.database.prepare("SELECT value FROM trust_metadata WHERE key = ?").get(name) as { value: string } | undefined;
      if (existing) return existing.value;
      const value = randomBytes(32).toString("base64url");
      this.database.prepare("INSERT INTO trust_metadata (key, value, updated_at) VALUES (?, ?, ?)")
        .run(name, value, new Date().toISOString());
      return value;
    });
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (cause) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the original failure. */ }
      throw cause;
    }
  }

  private guard<T>(message: string, details: Record<string, unknown>, operation: () => T): T {
    try {
      return operation();
    } catch (cause) {
      if (cause instanceof WorkflowContractError) throw cause;
      throw this.storageError(message, cause, details);
    }
  }

  private storageError(message: string, cause: unknown, details: Record<string, unknown> = {}): WorkflowContractError {
    return new WorkflowContractError("INVALID_INPUT", message, {
      ...details,
      databasePath: this.databasePath,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
