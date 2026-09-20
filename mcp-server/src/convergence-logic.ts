import { createHash } from "node:crypto";
import path from "node:path";

import {
  type ConvergenceFrameV1,
  type Sha256Digest,
  type TaskEnvelopeV1,
  WorkflowContractError,
} from "../../contracts/types.js";

export function canonicalJson(value: unknown, subject = "Convergence input"): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new WorkflowContractError("INVALID_INPUT", `${subject} contains a non-finite number.`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, subject)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], subject)}`).join(",")}}`;
  }
  throw new WorkflowContractError("INVALID_INPUT", `${subject} contains a non-serializable value.`);
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

function normalizedScope(value: string, workspaceLocator: string): string {
  const normalized = path.resolve(workspaceLocator, value).replaceAll("\\", "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function scopeEntryOverlaps(left: string, leftWorkspace: string, right: string, rightWorkspace: string): boolean {
  const a = normalizedScope(left, leftWorkspace);
  const b = normalizedScope(right, rightWorkspace);
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Every path a root may write. Rescoping to a sibling path leaves the work units and the
 * frame targets pointing at the same files, so all three are compared. Control artifacts are
 * excluded: unrelated tasks legitimately share a validator or rubric.
 */
function writeSurface(root: { taskEnvelope: TaskEnvelopeV1; frame: ConvergenceFrameV1 }): string[] {
  return [
    ...root.taskEnvelope.scope.included,
    ...root.taskEnvelope.workUnits.flatMap((unit) => unit.writeTargets),
    ...root.frame.targetArtifacts.map((artifact) => artifact.locator),
  ];
}

export function rootsOverlap(
  left: { taskEnvelope: TaskEnvelopeV1; frame: ConvergenceFrameV1 },
  right: { taskEnvelope: TaskEnvelopeV1; frame: ConvergenceFrameV1 },
): boolean {
  const sameWorkspace = left.frame.workspace.workspaceId === right.frame.workspace.workspaceId
    || normalizeWorkspaceLocator(left.frame.workspace.locator) === normalizeWorkspaceLocator(right.frame.workspace.locator);
  if (!sameWorkspace) return false;
  const rightSurface = writeSurface(right);
  return writeSurface(left).some((leftTarget) => (
    rightSurface.some((rightTarget) => scopeEntryOverlaps(
      leftTarget,
      left.frame.workspace.locator,
      rightTarget,
      right.frame.workspace.locator,
    ))
  ));
}

export function normalizeWorkspaceLocator(locator: string): string {
  const resolved = path.resolve(locator);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
