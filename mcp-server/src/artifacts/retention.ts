import { DatabaseSync } from "node:sqlite";

import type { ArtifactRefV1 } from "../../../contracts/types.js";
import { WorkflowContractError } from "../../../contracts/types.js";
import { canonicalJson } from "../convergence-logic.js";
import { ContractValidator } from "../schema-validator.js";

type PinPhase = "pending" | "published" | "closed-retain" | "closed-release" | "released";
interface PinRow { ref_json: string; phase: PinPhase }
interface ObjectRow { size: number; tombstoned: number }

export interface RetentionCandidate { namespace: ArtifactRefV1["namespace"]; digest: ArtifactRefV1["digest"]; size: number }

/**
 * Metadata only. GC is off; this class never opens or deletes artifact bytes.
 * The database path and its parent must be OS ACL protected for this store's sole writer.
 * Arbitrary SQL writers can bypass the lifecycle transitions; PK/CHECK constraints are not authorization.
 */
export class ArtifactRetentionStore {
  readonly gcEnabled = false;
  private readonly database: DatabaseSync;
  private readonly validator = new ContractValidator();

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS artifact_retention_objects (
        namespace TEXT NOT NULL, digest TEXT NOT NULL, size INTEGER NOT NULL,
        tombstoned INTEGER NOT NULL DEFAULT 0 CHECK (tombstoned IN (0, 1)),
        PRIMARY KEY(namespace, digest)
      );
      CREATE TABLE IF NOT EXISTS artifact_retention_pins (
        owner TEXT NOT NULL, reference_id TEXT NOT NULL, namespace TEXT NOT NULL,
        digest TEXT NOT NULL, ref_json TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('pending', 'published', 'closed-retain', 'closed-release', 'released')),
        PRIMARY KEY(owner, reference_id),
        FOREIGN KEY(namespace, digest) REFERENCES artifact_retention_objects(namespace, digest)
      );
      CREATE INDEX IF NOT EXISTS artifact_retention_live_object
        ON artifact_retention_pins(namespace, digest, phase);
    `);
  }

  /** The producer pins before publishing a reference. A retry cannot repoint an owner/reference. */
  pin(value: unknown, owner: string, referenceId: string): "created" | "existing" {
    const ref = this.rawRef(value);
    this.identifiers(owner, referenceId);
    const refJson = canonicalJson(ref);
    return this.transaction(() => {
      const prior = this.pinRow(owner, referenceId);
      if (prior) {
        if (prior.ref_json !== refJson || prior.phase === "released") {
          throw new WorkflowContractError("GATE_FAILED", "Retention pin cannot be repointed or resurrected.");
        }
        return "existing";
      }
      const object = this.objectRow(ref);
      if (object?.tombstoned) throw new WorkflowContractError("GATE_FAILED", "Artifact is replay-unavailable.");
      if (object && object.size !== ref.size) {
        throw new WorkflowContractError("INTEGRITY_FAILED", "Artifact size changed for an immutable digest.");
      }
      if (!object) this.database.prepare(`
        INSERT INTO artifact_retention_objects(namespace, digest, size) VALUES (?, ?, ?)
      `).run(ref.namespace, ref.digest, ref.size);
      this.database.prepare(`
        INSERT INTO artifact_retention_pins(owner, reference_id, namespace, digest, ref_json, phase)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `).run(owner, referenceId, ref.namespace, ref.digest, refJson);
      return "created";
    });
  }

  /** Called only after the producer has durably published the named reference. */
  referencePublished(owner: string, referenceId: string): void {
    this.transition(owner, referenceId, "pending", "published");
  }

  /** A terminal owner decision records whether policy permits a later release. */
  referenceClosed(owner: string, referenceId: string, policy: "retain" | "release"): void {
    if (policy !== "retain" && policy !== "release") {
      throw new WorkflowContractError("INVALID_INPUT", "Unknown retention release policy.");
    }
    this.transition(owner, referenceId, "published", policy === "retain" ? "closed-retain" : "closed-release");
  }

  /** Pending, published and retained references remain pinned. */
  release(owner: string, referenceId: string): "released" | "already-released" {
    this.identifiers(owner, referenceId);
    return this.transaction(() => {
      const row = this.pinRow(owner, referenceId);
      if (!row) throw new WorkflowContractError("GATE_FAILED", "Retention pin does not exist.");
      if (row.phase === "released") return "already-released";
      if (row.phase !== "closed-release") {
        throw new WorkflowContractError("GATE_FAILED", "Reference is in flight or policy retains its pin.");
      }
      this.database.prepare(`
        UPDATE artifact_retention_pins SET phase = 'released' WHERE owner = ? AND reference_id = ? AND phase = 'closed-release'
      `).run(owner, referenceId);
      return "released";
    });
  }

  /** Read-only candidate listing; it does not change metadata or bytes. */
  dryRun(): RetentionCandidate[] {
    return this.database.prepare(`
      SELECT o.namespace, o.digest, o.size FROM artifact_retention_objects o
      WHERE o.tombstoned = 0 AND NOT EXISTS (
        SELECT 1 FROM artifact_retention_pins p
        WHERE p.namespace = o.namespace AND p.digest = o.digest AND p.phase != 'released'
      ) ORDER BY o.namespace, o.digest
    `).all().map((row) => {
      const item = row as unknown as RetentionCandidate;
      return { namespace: item.namespace, digest: item.digest, size: item.size };
    });
  }

  /** Metadata tombstone only. Rechecks active pins under the write lock. */
  tombstone(value: unknown): "tombstoned" | "already-tombstoned" | "pinned" | "unknown" {
    const ref = this.rawRef(value);
    return this.transaction(() => {
      const object = this.objectRow(ref);
      if (!object) return "unknown";
      if (object.size !== ref.size) throw new WorkflowContractError("INTEGRITY_FAILED", "Artifact size differs from retention metadata.");
      if (object.tombstoned) return "already-tombstoned";
      const live = this.database.prepare(`
        SELECT 1 FROM artifact_retention_pins
        WHERE namespace = ? AND digest = ? AND phase != 'released' LIMIT 1
      `).get(ref.namespace, ref.digest);
      if (live) return "pinned";
      this.database.prepare(`
        UPDATE artifact_retention_objects SET tombstoned = 1 WHERE namespace = ? AND digest = ? AND tombstoned = 0
      `).run(ref.namespace, ref.digest);
      return "tombstoned";
    });
  }

  /** Not tombstoned does not assert that bytes exist. */
  replayState(value: unknown): "replay-unavailable" | "not-tombstoned" | "unknown" {
    const ref = this.rawRef(value);
    const row = this.objectRow(ref);
    if (!row) return "unknown";
    if (row.size !== ref.size) throw new WorkflowContractError("INTEGRITY_FAILED", "Artifact size differs from retention metadata.");
    return row.tombstoned ? "replay-unavailable" : "not-tombstoned";
  }

  close(): void { this.database.close(); }

  private rawRef(value: unknown): ArtifactRefV1 {
    const ref = this.validator.artifactRef(value);
    if (ref.hashDomain !== "raw-bytes") throw new WorkflowContractError("INVALID_INPUT", "Retention requires a raw-bytes object reference.");
    return ref;
  }

  private identifiers(owner: string, referenceId: string): void {
    if (![owner, referenceId].every((item) => typeof item === "string" && item.length > 0
      && item.length <= 256 && !Array.from(item).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) {
      throw new WorkflowContractError("INVALID_INPUT", "Invalid retention owner or reference ID.");
    }
  }

  private pinRow(owner: string, referenceId: string): PinRow | null {
    return this.database.prepare(`
      SELECT ref_json, phase FROM artifact_retention_pins WHERE owner = ? AND reference_id = ?
    `).get(owner, referenceId) as PinRow | undefined ?? null;
  }

  private objectRow(ref: ArtifactRefV1): ObjectRow | null {
    return this.database.prepare(`
      SELECT size, tombstoned FROM artifact_retention_objects WHERE namespace = ? AND digest = ?
    `).get(ref.namespace, ref.digest) as ObjectRow | undefined ?? null;
  }

  private transition(owner: string, referenceId: string, from: PinPhase, to: PinPhase): void {
    this.identifiers(owner, referenceId);
    this.transaction(() => {
      const row = this.pinRow(owner, referenceId);
      if (!row || (row.phase !== from && row.phase !== to)) {
        throw new WorkflowContractError("GATE_FAILED", "Retention reference transition is not allowed.");
      }
      if (row.phase === to) return;
      this.database.prepare(`
        UPDATE artifact_retention_pins SET phase = ? WHERE owner = ? AND reference_id = ? AND phase = ?
      `).run(to, owner, referenceId, from);
    });
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the primary error. */ }
      throw error;
    }
  }
}
