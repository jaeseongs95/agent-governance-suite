import { createHash } from "node:crypto";

import type { ArtifactRefV1 } from "../../../contracts/types.js";
import { WorkflowContractError } from "../../../contracts/types.js";
import { canonicalJson } from "../convergence-logic.js";
import { ContractValidator } from "../schema-validator.js";
import { RawContentStore } from "./content-store.js";
import { ArtifactReferenceAccess, type ArtifactAccessGrant, type ArtifactAccessPrincipal } from "./reference-access.js";

const roles = ["request", "policy", "catalog", "capability", "advice"] as const;
type SnapshotRole = (typeof roles)[number];
export type SnapshotInputs = Record<SnapshotRole, ArtifactRefV1>;

export interface SnapshotSetManifestV1 {
  schemaVersion: "1.0.0";
  kind: "decision-input-snapshot";
  inputs: SnapshotInputs;
}

/**
 * A snapshot is addressed by its own content digest. A changed member yields a different
 * manifest reference; the A02 put-if-absent store never replaces an existing digest.
 * Unreferenced members may remain after a failed publish, but no partial manifest is returned.
 */
export class SnapshotSetStore {
  private readonly validator = new ContractValidator();
  private readonly store: RawContentStore;
  private readonly access: ArtifactReferenceAccess;

  constructor(approvedRoot: string, principal: ArtifactAccessPrincipal, grants: readonly ArtifactAccessGrant[]) {
    this.store = new RawContentStore(approvedRoot);
    this.access = new ArtifactReferenceAccess(approvedRoot, principal, grants);
  }

  async publish(value: unknown): Promise<ArtifactRefV1> {
    const inputs = this.inputs(value);
    await Promise.all(roles.map((role) => this.access.read(inputs[role])));
    const manifest: SnapshotSetManifestV1 = {
      schemaVersion: "1.0.0", kind: "decision-input-snapshot", inputs,
    };
    const bytes = Buffer.from(canonicalJson(manifest), "utf8");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    const ref: ArtifactRefV1 = {
      schemaVersion: "1.0.0", namespace: "task", id: `snapshot-${digest.slice(7)}`,
      digest, hashDomain: "raw-bytes", size: bytes.length, mediaType: "application/json",
    };
    await this.store.put(ref, bytes);
    return ref;
  }

  async load(value: unknown): Promise<SnapshotSetManifestV1> {
    const ref = this.validator.artifactRef(value);
    if (ref.namespace !== "task" || ref.hashDomain !== "raw-bytes"
      || ref.mediaType !== "application/json" || ref.id !== `snapshot-${ref.digest.slice(7)}`) {
      throw new WorkflowContractError("INVALID_INPUT", "Not a decision input snapshot reference.");
    }
    const bytes = await this.access.read(ref);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new WorkflowContractError("INTEGRITY_FAILED", "Snapshot manifest is not JSON.");
    }
    const record = plainRecord(parsed);
    if (!record || !exactKeys(record, ["schemaVersion", "kind", "inputs"])
      || record.schemaVersion !== "1.0.0" || record.kind !== "decision-input-snapshot") {
      throw new WorkflowContractError("INTEGRITY_FAILED", "Snapshot manifest does not match its contract.");
    }
    const inputs = this.inputs(record.inputs);
    const manifest: SnapshotSetManifestV1 = { schemaVersion: "1.0.0", kind: "decision-input-snapshot", inputs };
    if (Buffer.from(canonicalJson(manifest), "utf8").compare(bytes) !== 0) {
      throw new WorkflowContractError("INTEGRITY_FAILED", "Snapshot manifest is not canonical.");
    }
    await Promise.all(roles.map((role) => this.access.read(inputs[role])));
    return manifest;
  }

  private inputs(value: unknown): SnapshotInputs {
    const record = plainRecord(value);
    if (!record || !exactKeys(record, roles)) {
      throw new WorkflowContractError("INVALID_INPUT", "Snapshot requires exactly five input references.");
    }
    const result = {} as SnapshotInputs;
    for (const role of roles) {
      const ref = this.validator.artifactRef(record[role]);
      result[role] = {
        schemaVersion: ref.schemaVersion, namespace: ref.namespace, id: ref.id,
        digest: ref.digest, hashDomain: ref.hashDomain, size: ref.size, mediaType: ref.mediaType,
      };
    }
    return result;
  }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
