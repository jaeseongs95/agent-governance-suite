import fs from "node:fs";
import path from "node:path";

import { WorkflowContractError } from "../../contracts/types.js";

export type ConservativeReason = "glob-prefix" | "leading-glob" | "legacy-unsupported";

export interface SurfaceIdentityV1 {
  entry: string;
  physical: string;
  git: { commonDir: string; checkoutRoot: string; relative: string } | null;
  conservative: ConservativeReason | null;
}

export interface RootIdentityV1 {
  version: 1;
  workspacePhysical: string;
  surfaces: SurfaceIdentityV1[];
}

const WALK_LIMIT = 256;
const READ_LIMIT = 4096;
const URI_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]+:\/\//u;
const GLOB_META = /[*?[\]{}]/u;
const SEGMENT_SEPARATOR = process.platform === "win32" ? /[\\/]/u : /\//u;

function isUnsupported(entry: string): boolean {
  if (URI_PATTERN.test(entry)) return true;
  for (let index = 0; index < entry.length; index += 1) {
    const code = entry.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Throws INVALID_INPUT (details.reason "UNSUPPORTED_SCOPE_ENTRY") for URIs and control characters. */
export function assertSupportedScopeEntry(entry: string): void {
  if (isUnsupported(entry)) {
    throw new WorkflowContractError(
      "INVALID_INPUT",
      "Scope entries must be file system paths without control characters.",
      { reason: "UNSUPPORTED_SCOPE_ENTRY", entry },
    );
  }
}

/** True when `child` equals `parent` or lies below it. Both are normalized keys; "" contains everything. */
export function pathWithin(child: string, parent: string): boolean {
  return parent === "" || child === parent || child.startsWith(`${parent}/`);
}

function unresolved(target: string, cause: string): WorkflowContractError {
  return new WorkflowContractError(
    "INVALID_INPUT",
    `Workspace identity cannot be resolved for ${target}: ${cause}.`,
    { reason: "WORKSPACE_IDENTITY_UNRESOLVED", path: target, cause },
  );
}

function normalizedKey(value: string): string {
  const slashed = process.platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value;
  return slashed.replace(/\/+$/u, "");
}

/** Real path of the nearest existing ancestor, plus the suffix that does not exist yet. */
function physicalPath(target: string): { real: string; existing: string } {
  let current = path.resolve(target);
  const suffix: string[] = [];
  for (let depth = 0; depth < WALK_LIMIT; depth += 1) {
    try {
      const existing = fs.realpathSync.native(current);
      return { real: path.join(existing, ...suffix), existing };
    } catch (error) {
      const parent = path.dirname(current);
      if (parent === current) throw unresolved(target, (error as NodeJS.ErrnoException).code ?? "unreadable");
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
  throw unresolved(target, "walk limit reached");
}

function isDirectory(target: string): boolean {
  return fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() === true;
}

function readHead(file: string): string {
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(READ_LIMIT);
    return buffer.toString("utf8", 0, fs.readSync(descriptor, buffer, 0, READ_LIMIT, 0));
  } finally {
    fs.closeSync(descriptor);
  }
}

function discoverGit(physical: { real: string; existing: string }): SurfaceIdentityV1["git"] {
  let evidence = physical.existing;
  try {
    let directory = isDirectory(physical.existing) ? physical.existing : path.dirname(physical.existing);
    for (let depth = 0; depth < WALK_LIMIT; depth += 1) {
      evidence = path.join(directory, ".git");
      const stat = fs.statSync(evidence, { throwIfNoEntry: false });
      if (stat) {
        let gitDir = evidence;
        if (!stat.isDirectory()) {
          const pointer = /^gitdir: ([^\r\n]+)/u.exec(readHead(evidence))?.[1];
          if (!pointer) throw unresolved(evidence, "missing gitdir line");
          gitDir = path.resolve(directory, pointer);
          if (!isDirectory(gitDir)) throw unresolved(gitDir, "gitdir is not a directory");
        }
        // A gitdir without `commondir` is normal: submodule, separate git dir, main side of a bare repository.
        let commonDir = gitDir;
        evidence = path.join(gitDir, "commondir");
        if (fs.statSync(evidence, { throwIfNoEntry: false })) {
          const pointer = readHead(evidence).trim();
          if (!pointer) throw unresolved(evidence, "empty commondir");
          commonDir = path.resolve(gitDir, pointer);
          if (!isDirectory(commonDir)) throw unresolved(commonDir, "commondir is not a directory");
        }
        return {
          commonDir: normalizedKey(fs.realpathSync.native(commonDir)),
          checkoutRoot: normalizedKey(directory),
          relative: normalizedKey(path.relative(directory, physical.real)),
        };
      }
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
    throw unresolved(physical.existing, "walk limit reached");
  } catch (error) {
    if (error instanceof WorkflowContractError) throw error;
    throw unresolved(evidence, (error as NodeJS.ErrnoException).code ?? "unreadable");
  }
}

function identify(target: string): Pick<SurfaceIdentityV1, "physical" | "git"> {
  const physical = physicalPath(target);
  return { physical: normalizedKey(physical.real), git: discoverGit(physical) };
}

export function resolveRootIdentity(
  workspaceLocator: string,
  entries: readonly string[],
  options: { legacy?: boolean } = {},
): RootIdentityV1 {
  if (!options.legacy) for (const entry of entries) assertSupportedScopeEntry(entry);
  const workspace = identify(workspaceLocator);
  const surfaces = entries.map((entry): SurfaceIdentityV1 => {
    if (isUnsupported(entry)) return { entry, ...workspace, conservative: "legacy-unsupported" };
    const segments = entry.split(SEGMENT_SEPARATOR);
    const globIndex = segments.findIndex((segment) => GLOB_META.test(segment));
    if (globIndex === 0) {
      return workspace.git
        ? { entry, physical: workspace.git.checkoutRoot, git: { ...workspace.git, relative: "" }, conservative: "leading-glob" }
        : { entry, ...workspace, conservative: "leading-glob" };
    }
    // The trailing slash keeps a bare drive or root prefix ("C:", "") absolute.
    const target = globIndex < 0 ? entry : `${segments.slice(0, globIndex).join("/")}/`;
    return {
      entry,
      ...identify(path.resolve(workspaceLocator, target)),
      conservative: globIndex < 0 ? null : "glob-prefix",
    };
  });
  return { version: 1, workspacePhysical: workspace.physical, surfaces };
}
