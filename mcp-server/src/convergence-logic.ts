import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  type ConvergenceFrameV1,
  type ConvergenceRootV1,
  type Sha256Digest,
  type TaskEnvelopeV1,
  WorkflowContractError,
} from "../../contracts/types.js";
import {
  pathWithin,
  resolveRootIdentity,
  type RootIdentityV1,
  type SurfaceIdentityV1,
} from "./workspace-identity.js";

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

/**
 * Server-derived identity of a root's write surface. The workspace id and locator a caller
 * sends are display values; conflicts are decided on what the paths resolve to. `legacy`
 * is for roots stored before scope entries were validated.
 */
export function rootIdentity(
  root: { taskEnvelope: TaskEnvelopeV1; frame: ConvergenceFrameV1 },
  legacy = false,
): RootIdentityV1 {
  return resolveRootIdentity(root.frame.workspace.locator, writeSurface(root), { legacy });
}

export interface IdentifiedRoot {
  root: ConvergenceRootV1;
  identity: RootIdentityV1;
  /** false: the repository this root belongs to can no longer be read, so its lineage is unknown. */
  resolved: boolean;
}

function normalizedScope(value: string, workspaceLocator: string): string {
  const normalized = path.resolve(workspaceLocator, value).replaceAll("\\", "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Identity of a root that is already stored. A stored identity wins because the paths may be
 * gone by now. Without one it is derived and the caller persists it when `fresh`. A root
 * stored before identities existed is unresolved when its Git evidence is unreadable or its
 * workspace is gone: "no Git" and "cannot tell" are different answers. Nothing is stored for
 * it, so a later open retries.
 */
export function activeRootIdentity(
  root: ConvergenceRootV1,
  stored: RootIdentityV1 | null,
): IdentifiedRoot & { fresh: boolean } {
  if (stored) return { root, identity: stored, resolved: true, fresh: false };
  try {
    const resolved = existsSync(root.frame.workspace.locator);
    return { root, identity: rootIdentity(root, true), resolved, fresh: resolved };
  } catch (cause) {
    if (!(cause instanceof WorkflowContractError)) throw cause;
    const locator = root.frame.workspace.locator;
    return {
      root,
      identity: {
        version: 1,
        workspacePhysical: normalizedScope(".", locator),
        surfaces: writeSurface(root).map((entry) => ({ entry, physical: normalizedScope(entry, locator), git: null, conservative: null })),
      },
      resolved: false,
      fresh: false,
    };
  }
}

export interface RootConflict {
  root: ConvergenceRootV1;
  /**
   * physical: the same files. lineage: the same checkout-relative files of a gated root in another
   * checkout of one repository. lineage-unresolved: a gated root whose repository cannot be read.
   */
  kind: "physical" | "lineage" | "lineage-unresolved";
  requested: SurfaceIdentityV1;
  existing: SurfaceIdentityV1;
}

const GATED_STATES: ReadonlyArray<ConvergenceRootV1["state"]> = ["needs-review", "needs-user"];

function overlaps(left: string, right: string): boolean {
  return pathWithin(left, right) || pathWithin(right, left);
}

function sharesLineage(left: SurfaceIdentityV1, right: SurfaceIdentityV1): boolean {
  return left.git !== null && right.git !== null && left.git.commonDir === right.git.commonDir;
}

function insideParentSurface(surface: SurfaceIdentityV1, parent: RootIdentityV1): boolean {
  return parent.surfaces.some((owned) => pathWithin(surface.physical, owned.physical)
    || (sharesLineage(surface, owned) && pathWithin(surface.git!.relative, owned.git!.relative)));
}

/**
 * The first active root that blocks the candidate. The same physical target always conflicts.
 * A gated root also blocks the same checkout-relative surface in every other checkout of its
 * repository, so moving to a sibling worktree does not lift the gate. An explicit replacement
 * keeps its parent's surface: two gated roots must not block each other's replacement, while
 * anything the replacement adds beyond that surface is still checked. A gated root of unknown
 * lineage blocks every surface that lies in a repository, because it cannot be shown unrelated;
 * surfaces outside any repository cannot share its lineage.
 */
export function findRootConflict(
  candidate: IdentifiedRoot,
  parent: RootIdentityV1 | null,
  actives: readonly IdentifiedRoot[],
): RootConflict | null {
  for (const active of actives) {
    if (active.root.rootId === candidate.root.parentRootId) continue;
    const added = GATED_STATES.includes(active.root.state)
      ? candidate.identity.surfaces.filter((surface) => !(parent && insideParentSurface(surface, parent)))
      : [];
    for (const requested of candidate.identity.surfaces) {
      for (const existing of active.identity.surfaces) {
        if (overlaps(requested.physical, existing.physical)) {
          return { root: active.root, kind: "physical", requested, existing };
        }
      }
    }
    for (const requested of added) {
      if (requested.git === null) continue;
      for (const existing of active.identity.surfaces) {
        if (!active.resolved) return { root: active.root, kind: "lineage-unresolved", requested, existing };
        if (sharesLineage(requested, existing) && overlaps(requested.git.relative, existing.git!.relative)) {
          return { root: active.root, kind: "lineage", requested, existing };
        }
      }
    }
  }
  return null;
}

/**
 * How a replacement stays bound to its parent: the same physical workspace, or every surface
 * inside a repository the parent's stored identity already names. The stored identity is what
 * makes a deleted worktree replaceable from a sibling checkout.
 */
export function replacementMatch(candidate: RootIdentityV1, parent: RootIdentityV1): "physical" | "lineage" | null {
  if (candidate.workspacePhysical === parent.workspacePhysical) return "physical";
  const parentRepositories = new Set(parent.surfaces.flatMap((surface) => (surface.git ? [surface.git.commonDir] : [])));
  const sameLineage = candidate.surfaces.length > 0
    && candidate.surfaces.every((surface) => surface.git !== null && parentRepositories.has(surface.git.commonDir));
  return sameLineage ? "lineage" : null;
}

/**
 * Decides one insertion against every active root. Stores call it inside the transaction that
 * also abandons the parent and inserts the root, so two connections cannot both pass.
 */
export function planRootInsertion(
  root: ConvergenceRootV1,
  actives: readonly IdentifiedRoot[],
): { identity: RootIdentityV1; match: "physical" | "lineage" | null; conflict: RootConflict | null } {
  const identity = rootIdentity(root);
  let parent: IdentifiedRoot | null = null;
  let match: "physical" | "lineage" | null = null;
  if (root.parentRootId) {
    parent = actives.find((active) => active.root.rootId === root.parentRootId) ?? null;
    if (!parent || !GATED_STATES.includes(parent.root.state)) {
      throw new WorkflowContractError("INVALID_TRANSITION", "Only a gated convergence root may be replaced.", {
        parentRootId: root.parentRootId,
        parentState: parent?.root.state ?? null,
      });
    }
    match = replacementMatch(identity, parent.identity);
    if (!match) {
      throw new WorkflowContractError("INVALID_INPUT", "A replacement root must remain bound to the same workspace.", {
        parentRootId: root.parentRootId,
        ...(parent.resolved ? {} : { reason: "WORKSPACE_IDENTITY_UNRESOLVED" }),
      });
    }
  }
  return { identity, match, conflict: findRootConflict({ root, identity, resolved: true }, parent?.identity ?? null, actives) };
}

/** ROOT_CONFLICT details: which root blocks, whether it is gated, and why the entries collide. */
export function conflictDetails(conflict: RootConflict): Record<string, unknown> {
  return {
    rootId: conflict.root.rootId,
    workspaceId: conflict.root.frame.workspace.workspaceId,
    scope: conflict.root.taskEnvelope.scope.included,
    blockerState: conflict.root.state,
    conflictKind: conflict.kind,
    ...(conflict.kind === "lineage-unresolved" ? { reason: "WORKSPACE_IDENTITY_UNRESOLVED" } : {}),
    requestedEntry: conflict.requested.entry,
    existingEntry: conflict.existing.entry,
    conservativeExpansion: [conflict.requested.conservative, conflict.existing.conservative].filter((reason) => reason !== null),
  };
}

export function normalizeWorkspaceLocator(locator: string): string {
  const resolved = path.resolve(locator);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
