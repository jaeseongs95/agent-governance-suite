import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import type { Stats } from "node:fs";
import type { ArtifactRefV1 } from "../../../contracts/types.js";
import { WorkflowContractError } from "../../../contracts/types.js";
import { ContractValidator, sameArtifactRefIdentity, verifyArtifactRefContent } from "../schema-validator.js";

export interface ArtifactAccessGrant {
  /** Server-owned grant, bound to the complete reference and its namespace. */
  ref: ArtifactRefV1;
  workspaceId: string;
  /** Required for task and checkpoint-evidence references. */
  taskId?: string;
}

export interface ArtifactAccessPrincipal {
  /** Verified server-side scope, never copied from an artifact request. */
  workspaceId: string;
  taskId?: string;
}

/**
 * Reads an A02 object only when a server-owned grant matches the caller's scope.
 * The approved root, principal and grants must come from trusted application state, never a request.
 * On POSIX, O_NOFOLLOW rejects a final-component symlink. Node has no portable openat2/
 * directory-handle-relative open (or Windows reparse-point open) here: lstat/realpath and
 * fd identity checks reject persistent path replacement, but a same-user attacker who can
 * mutate ancestor paths between checks remains outside this API's security guarantee.
 * Protect the root and its ancestors with OS ACLs against such writers.
 */
export class ArtifactReferenceAccess {
  private readonly root: string;
  private readonly principal: ArtifactAccessPrincipal;
  private readonly grants: readonly ArtifactAccessGrant[];
  private readonly validator = new ContractValidator();

  constructor(approvedRoot: string, principal: ArtifactAccessPrincipal, grants: readonly ArtifactAccessGrant[]) {
    if (!path.isAbsolute(approvedRoot)) {
      throw new WorkflowContractError("INVALID_INPUT", "Artifact root must be an approved absolute path.");
    }
    this.root = path.resolve(approvedRoot);
    validateScope(principal);
    this.principal = { ...principal };
    this.grants = grants.map((grant) => {
      const ref = this.validator.artifactRef(grant.ref);
      validateScope(grant);
      if (ref.namespace !== "workspace" && !grant.taskId) {
        throw new WorkflowContractError("INVALID_INPUT", "A task-scoped grant requires a task ID.");
      }
      if (ref.namespace === "workspace" && grant.taskId !== undefined) {
        throw new WorkflowContractError("INVALID_INPUT", "A workspace grant cannot carry a task ID.");
      }
      return { ref: { ...ref }, workspaceId: grant.workspaceId,
        ...(grant.taskId === undefined ? {} : { taskId: grant.taskId }) };
    });
  }

  async read(value: unknown): Promise<Buffer> {
    const ref = this.validator.artifactRef(value);
    if (ref.hashDomain !== "raw-bytes") {
      throw new WorkflowContractError("INVALID_INPUT", "Raw content access requires a raw-bytes reference.");
    }
    const authorized = this.grants.some((grant) =>
      sameArtifactRefIdentity(grant.ref, ref)
      && grant.ref.size === ref.size && grant.ref.mediaType === ref.mediaType
      && grant.workspaceId === this.principal.workspaceId
      && (ref.namespace === "workspace" || (this.principal.taskId !== undefined && grant.taskId === this.principal.taskId)));
    if (!authorized) throw new WorkflowContractError("GATE_FAILED", "Artifact reference access denied.");

    await Promise.all(ancestorPaths(this.root).map(requireDirectory));
    const root = await realpath(this.root);
    const directory = path.join(root, "objects", ref.namespace, ref.digest.slice(7, 9));
    const target = path.join(directory, ref.digest.slice(7));
    const directories = ancestorPaths(root).concat([
      path.join(root, "objects"), path.join(root, "objects", ref.namespace), directory,
    ]);
    const before = await Promise.all(directories.map(requireDirectory));
    const targetBefore = await requireFile(target);
    await this.afterPathCheck();

    // O_NOFOLLOW is effective on POSIX; on Windows the path/fd identity checks are required.
    const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat();
      if (!opened.isFile() || !sameObject(opened, targetBefore)) {
        throw new WorkflowContractError("INTEGRITY_FAILED", "Opened artifact differs from the checked object.");
      }
      await requireUnchanged(directories, before, target, opened);
      const bytes = await file.readFile();
      verifyArtifactRefContent(this.validator, ref, bytes);
      await requireUnchanged(directories, before, target, opened);
      return bytes;
    } finally {
      await file.close();
    }
  }

  /** A test seam for replacing a checked path before open; production instances do nothing. */
  protected async afterPathCheck(): Promise<void> {}
}

function validateScope(value: ArtifactAccessPrincipal): void {
  if (!validId(value.workspaceId) || (value.taskId !== undefined && !validTaskId(value.taskId))) {
    throw new WorkflowContractError("INVALID_INPUT", "Artifact access scope contains an invalid ID.");
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value);
}

function validTaskId(value: unknown): value is string {
  return validId(value) || (typeof value === "string" && /^hmac-sha256:[a-f0-9]{64}$/u.test(value));
}

function ancestorPaths(root: string): string[] {
  const paths: string[] = [];
  for (let current = root; current !== path.parse(current).root; current = path.dirname(current)) paths.push(current);
  if (paths.length === 0) paths.push(root);
  return paths.reverse();
}

async function requireDirectory(directory: string): Promise<Stats> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory()) throw new WorkflowContractError("INTEGRITY_FAILED", "Artifact path contains a link or non-directory.");
  return metadata;
}

async function requireFile(target: string): Promise<Stats> {
  const metadata = await lstat(target);
  if (!metadata.isFile()) throw new WorkflowContractError("INTEGRITY_FAILED", "Artifact path is not a regular file.");
  return metadata;
}

function sameObject(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

async function requireUnchanged(directories: string[], before: Stats[], target: string, opened: Stats): Promise<void> {
  const after = await Promise.all(directories.map(requireDirectory));
  if (after.some((metadata, index) => !sameObject(metadata, before[index]!))
    || !sameObject(await requireFile(target), opened)) {
    throw new WorkflowContractError("INTEGRITY_FAILED", "Artifact path changed during access.");
  }
}
