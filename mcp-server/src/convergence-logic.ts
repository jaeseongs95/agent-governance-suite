import { createHash } from "node:crypto";
import path from "node:path";

import {
  type ConvergenceFrameV1,
  type Sha256Digest,
  type TaskEnvelopeV1,
  WorkflowContractError,
} from "../../contracts/types.js";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new WorkflowContractError("INVALID_INPUT", "Convergence input contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new WorkflowContractError("INVALID_INPUT", "Convergence input contains a non-serializable value.");
}

export function convergenceDigest(value: unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function frameDigests(frame: ConvergenceFrameV1): {
  frameDigest: Sha256Digest;
  workspaceDigest: Sha256Digest;
  controlDigest: Sha256Digest;
  targetDigest: Sha256Digest;
  operationalDigest: Sha256Digest;
} {
  return {
    frameDigest: convergenceDigest(frame),
    workspaceDigest: convergenceDigest(frame.workspace),
    controlDigest: convergenceDigest(frame.controlArtifacts),
    targetDigest: convergenceDigest(frame.targetArtifacts),
    operationalDigest: convergenceDigest(frame.operationalSettings),
  };
}

function normalizedScope(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function scopeEntryOverlaps(left: string, right: string): boolean {
  const a = normalizedScope(left);
  const b = normalizedScope(right);
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function rootsOverlap(
  left: { taskEnvelope: TaskEnvelopeV1; frame: ConvergenceFrameV1 },
  right: { taskEnvelope: TaskEnvelopeV1; frame: ConvergenceFrameV1 },
): boolean {
  const sameWorkspace = left.frame.workspace.workspaceId === right.frame.workspace.workspaceId
    || normalizeWorkspaceLocator(left.frame.workspace.locator) === normalizeWorkspaceLocator(right.frame.workspace.locator);
  if (!sameWorkspace) return false;
  return left.taskEnvelope.scope.included.some((leftTarget) => (
    right.taskEnvelope.scope.included.some((rightTarget) => scopeEntryOverlaps(leftTarget, rightTarget))
  ));
}

export function normalizeWorkspaceLocator(locator: string): string {
  const resolved = path.resolve(locator);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
