import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
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
  repositoryCheckouts,
  repositoryInDirectory,
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

/** Binds a stored identity to the inputs it was derived from; a review may replace the frame of a stored root. */
export function surfaceDigest(root: { taskEnvelope: TaskEnvelopeV1; frame: ConvergenceFrameV1 }): Sha256Digest {
  return convergenceDigest({ locator: root.frame.workspace.locator, entries: writeSurface(root) });
}

export interface StoredIdentity {
  identity: RootIdentityV1;
  surfaceDigest: string;
  /**
   * Per surface: true while its path has never existed. Its identity was then read from the
   * nearest existing ancestor, which is an inference, not an observation of where it will live.
   */
  inferred: boolean[];
}

export interface IdentifiedRoot {
  root: ConvergenceRootV1;
  identity: RootIdentityV1;
  /** false: the repository this root belongs to cannot be told any more, so its lineage is unknown. */
  resolved: boolean;
  /** true: stored before identities existed, so nothing was ever observed about where it lives. */
  legacy: boolean;
  /** true: the workspace key is the one stored for the root's current inputs, not one derived just now. */
  observedWorkspace: boolean;
}

function normalizedScope(value: string, workspaceLocator: string): string {
  const normalized = path.resolve(workspaceLocator, value).replaceAll("\\", "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Whether what is derived for a surface now was really seen. Identity is read from the nearest
 * existing ancestor, so below a path that is gone it describes that ancestor: a deleted worktree
 * nested in another checkout would be taken for a path of the outer checkout. With nothing
 * observed earlier, a missing target cannot be told from a deleted checkout directory, so the
 * path itself has to exist. The same holds for a checkout that shows up above a surface which
 * was observed outside any checkout: that is a new observation. Only a surface that is still
 * outside any checkout, as it was observed at creation, gets by with its directory, because a
 * target file may not have been written yet.
 */
/** Per surface: the path does not exist, so whatever was derived for it was read from an ancestor. */
function inferredSurfaces(identity: RootIdentityV1): boolean[] {
  return identity.surfaces.map((surface) => !existsSync(surface.physical || "/"));
}

/** A checkout seen earlier that is more specific than what is found now has disappeared; that does not lift a gate. */
function coversEarlierCheckout(current: SurfaceIdentityV1, earlier: SurfaceIdentityV1): boolean {
  if (earlier.git === null) return false;
  if (current.git === null) return true;
  return earlier.git.checkoutRoot !== current.git.checkoutRoot && pathWithin(earlier.git.checkoutRoot, current.git.checkoutRoot);
}

function surfaceBacked(surface: SurfaceIdentityV1, observedOutsideCheckouts: boolean): boolean {
  const unchanged = observedOutsideCheckouts && surface.git === null && !surface.conservative;
  return existsSync((unchanged ? path.posix.dirname(surface.physical) : surface.physical) || "/");
}

/**
 * Identity of a root that is already stored. What was observed for the same inputs is kept as
 * it was, surface by surface, because an observed checkout may be gone by now. A surface that
 * was seen outside any checkout is looked at again, so a checkout created since is picked up. A
 * changed frame invalidates the stored identity without making the root a legacy one. Whatever
 * is derived now counts only when the workspace and the surface's directory exist; otherwise,
 * or when Git evidence is unreadable, the root is unresolved: "no Git" and "cannot tell" are
 * different answers. A surface whose path never existed when the root was created carries an
 * inferred identity: it is derived again on every open, so a checkout created at that path since
 * is followed, while a more specific checkout seen in between is kept after it disappears. The
 * caller persists the identity when `fresh`; an unresolved one is never stored, so a later open
 * retries.
 */
export function activeRootIdentity(
  root: ConvergenceRootV1,
  stored: StoredIdentity | null,
): IdentifiedRoot & { fresh: boolean; surfaceDigest: Sha256Digest; inferred: boolean[] } {
  const digest = surfaceDigest(root);
  const observed = stored && stored.surfaceDigest === digest ? stored.identity : null;
  const wasInferred = (index: number): boolean => observed !== null && stored!.inferred[index] === true;
  const known = { root, legacy: stored === null, observedWorkspace: observed !== null, surfaceDigest: digest };
  if (observed && observed.surfaces.every((surface, index) => surface.git !== null && !wasInferred(index))) {
    return { ...known, identity: observed, resolved: true, fresh: false, inferred: stored!.inferred };
  }
  let derived: RootIdentityV1 | null = null;
  try {
    derived = rootIdentity(root, true);
  } catch (cause) {
    if (!(cause instanceof WorkflowContractError)) throw cause;
  }
  const locator = root.frame.workspace.locator;
  if (!observed && !derived) {
    const identity: RootIdentityV1 = {
      version: 1,
      workspacePhysical: normalizedScope(".", locator),
      surfaces: writeSurface(root).map((entry) => ({ entry, physical: normalizedScope(entry, locator), git: null, conservative: null })),
    };
    return { ...known, identity, resolved: false, fresh: false, inferred: [] };
  }
  const workspaceExists = existsSync(locator);
  let resolved = true;
  const surfaces = (observed ?? derived!).surfaces.map((surface, index) => {
    const current = derived?.surfaces[index];
    if (wasInferred(index)) {
      if (!current) resolved = false;
      return current && !coversEarlierCheckout(current, surface) ? current : surface;
    }
    if (observed && surface.git !== null) return surface;
    if (current && workspaceExists && surfaceBacked(current, observed !== null)) return current;
    resolved = false;
    return surface;
  });
  const identity: RootIdentityV1 = {
    version: 1,
    workspacePhysical: observed?.workspacePhysical ?? derived!.workspacePhysical,
    surfaces,
  };
  // Once its path exists a surface has been observed; nothing unobserved starts out as inferred.
  const inferred = surfaces.map((surface, index) => wasInferred(index) && !existsSync(surface.physical || "/"));
  const fresh = resolved && JSON.stringify({ identity, inferred }) !== JSON.stringify({ identity: observed, inferred: stored?.inferred });
  return { ...known, identity, resolved, fresh, inferred };
}

export interface RootConflict {
  root: ConvergenceRootV1;
  /**
   * physical: the same files. lineage: the same checkout-relative files of a gated root in another
   * checkout of one repository. lineage-unresolved: a gated root whose repository cannot be told.
   */
  kind: "physical" | "lineage" | "lineage-unresolved";
  requested: SurfaceIdentityV1;
  existing: SurfaceIdentityV1;
}

export type ReplacementMatch = "physical" | "lineage" | "legacy-locator";

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
 * A directory can contain nested checkouts even when it belongs to a different repository.
 * Registered checkouts prove overlap; incomplete registration cannot prove disjointness.
 */
function lineageRelation(
  left: SurfaceIdentityV1,
  right: SurfaceIdentityV1,
  checkouts: Map<string, ReturnType<typeof repositoryCheckouts>>,
  scans: Map<string, ReturnType<typeof repositoryInDirectory>>,
): "overlap" | "unknown" | "none" {
  if (sharesLineage(left, right) && overlaps(left.git!.relative, right.git!.relative)) {
    return "overlap";
  }
  let uncertain = false;
  for (const [container, member] of [[left, right], [right, left]] as const) {
    if (!member.git || (container.conservative === null
      && statSync(container.physical || "/", { throwIfNoEntry: false })?.isDirectory() !== true)) continue;
    const commonDir = member.git.commonDir;
    if (!checkouts.has(commonDir)) checkouts.set(commonDir, repositoryCheckouts(commonDir));
    const listing = checkouts.get(commonDir)!;
    if (listing.roots.some((checkout) => pathWithin(checkout, container.physical))) return "overlap";
    if (!listing.complete) {
      const scanKey = `${commonDir}\u0000${container.physical}`;
      if (!scans.has(scanKey)) scans.set(scanKey, repositoryInDirectory(container.physical || "/", commonDir));
      const scanned = scans.get(scanKey)!;
      if (scanned === "overlap") return "overlap";
      uncertain ||= scanned === "unknown";
    }
  }
  return uncertain ? "unknown" : "none";
}

/** A plain file path outside any checkout cannot share a repository's lineage; a directory there may hold checkouts. */
function outsideEveryRepository(surface: SurfaceIdentityV1): boolean {
  return surface.git === null
    && surface.conservative === null
    && statSync(surface.physical || "/", { throwIfNoEntry: false })?.isDirectory() !== true;
}

/**
 * The first active root that blocks the candidate. The same physical target always conflicts.
 * A gated root also blocks the same checkout-relative surface in every other checkout of its
 * repository, so moving to a sibling worktree does not lift the gate. An explicit replacement
 * keeps its parent's surface: two gated roots must not block each other's replacement, while
 * anything the replacement adds beyond that surface is still checked. A gated root of unknown
 * lineage blocks every surface that cannot be shown to lie outside all repositories.
 */
export function findRootConflict(
  candidate: { root: ConvergenceRootV1; identity: RootIdentityV1 },
  parent: RootIdentityV1 | null,
  actives: readonly IdentifiedRoot[],
): RootConflict | null {
  const checkouts = new Map<string, ReturnType<typeof repositoryCheckouts>>();
  const scans = new Map<string, ReturnType<typeof repositoryInDirectory>>();
  for (const active of actives) {
    if (active.root.rootId === candidate.root.parentRootId) continue;
    for (const requested of candidate.identity.surfaces) {
      for (const existing of active.identity.surfaces) {
        if (overlaps(requested.physical, existing.physical)) {
          return { root: active.root, kind: "physical", requested, existing };
        }
      }
    }
    if (!GATED_STATES.includes(active.root.state)) continue;
    for (const requested of candidate.identity.surfaces) {
      if (parent && insideParentSurface(requested, parent)) continue;
      for (const existing of active.identity.surfaces) {
        if (!active.resolved) {
          if (outsideEveryRepository(requested)) continue;
          return { root: active.root, kind: "lineage-unresolved", requested, existing };
        }
        const relation = lineageRelation(requested, existing, checkouts, scans);
        if (relation !== "none") {
          return { root: active.root, kind: relation === "overlap" ? "lineage" : "lineage-unresolved", requested, existing };
        }
      }
    }
  }
  return null;
}

/**
 * How a replacement stays bound to its parent: the same physical workspace, or every surface
 * inside a repository the parent's stored identity already names. The stored identity is what
 * makes a deleted worktree replaceable from a sibling checkout. An unresolved root offers no
 * lineage. If it was stored before identities existed, only the rule that predates identities
 * applies (the same workspace id and the same locator string), recorded as `legacy-locator`,
 * never as an observed binding; a root that ever had an identity does not gain that exception
 * and stays bound to the workspace key stored for its current inputs.
 */
export function replacementMatch(
  candidate: { root: ConvergenceRootV1; identity: RootIdentityV1 },
  parent: IdentifiedRoot,
): ReplacementMatch | null {
  if (!parent.resolved) {
    if (!parent.legacy) {
      return parent.observedWorkspace && candidate.identity.workspacePhysical === parent.identity.workspacePhysical ? "physical" : null;
    }
    const sameNamedWorkspace = parent.root.frame.workspace.workspaceId === candidate.root.frame.workspace.workspaceId
      && normalizeWorkspaceLocator(parent.root.frame.workspace.locator) === normalizeWorkspaceLocator(candidate.root.frame.workspace.locator);
    return sameNamedWorkspace ? "legacy-locator" : null;
  }
  if (candidate.identity.workspacePhysical === parent.identity.workspacePhysical) return "physical";
  const parentRepositories = new Set(parent.identity.surfaces.flatMap((surface) => (surface.git ? [surface.git.commonDir] : [])));
  const sameLineage = candidate.identity.surfaces.length > 0
    && candidate.identity.surfaces.every((surface) => surface.git !== null && parentRepositories.has(surface.git.commonDir));
  return sameLineage ? "lineage" : null;
}

/**
 * Decides one insertion against every active root. Stores call it inside the transaction that
 * also abandons the parent and inserts the root, so two connections cannot both pass.
 */
export function planRootInsertion(
  root: ConvergenceRootV1,
  actives: readonly IdentifiedRoot[],
): {
  identity: RootIdentityV1;
  surfaceDigest: Sha256Digest;
  inferred: boolean[];
  match: ReplacementMatch | null;
  conflict: RootConflict | null;
} {
  const identity = rootIdentity(root);
  let parent: IdentifiedRoot | null = null;
  let match: ReplacementMatch | null = null;
  if (root.parentRootId) {
    parent = actives.find((active) => active.root.rootId === root.parentRootId) ?? null;
    if (!parent || !GATED_STATES.includes(parent.root.state)) {
      throw new WorkflowContractError("INVALID_TRANSITION", "Only a gated convergence root may be replaced.", {
        parentRootId: root.parentRootId,
        parentState: parent?.root.state ?? null,
      });
    }
    match = replacementMatch({ root, identity }, parent);
    if (!match) {
      throw new WorkflowContractError("INVALID_INPUT", "A replacement root must remain bound to the same workspace.", {
        parentRootId: root.parentRootId,
        ...(parent.resolved ? {} : { reason: "WORKSPACE_IDENTITY_UNRESOLVED" }),
      });
    }
  }
  return {
    identity,
    surfaceDigest: surfaceDigest(root),
    inferred: inferredSurfaces(identity),
    match,
    conflict: findRootConflict({ root, identity }, parent?.identity ?? null, actives),
  };
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
