import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { WorkflowContractError } from "../../contracts/types.js";
import { msg } from "./i18n.js";
import { resolveHostIdPath } from "./runtime-config.js";

export type ConservativeReason = "glob-prefix" | "leading-glob" | "legacy-unsupported";

export interface SurfaceIdentityV1 {
  entry: string;
  physical: string;
  git: { commonDir: string; checkoutRoot: string; relative: string } | null;
  conservative: ConservativeReason | null;
}

export interface RootIdentityV1 {
  version: 1;
  /** hostIdentity() of the machine that first stored the root; an identity without it is taken as this host's. */
  host?: string;
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
      msg("services.workspace.unsupportedScopeEntry", {}),
      { reason: "UNSUPPORTED_SCOPE_ENTRY", entry },
    );
  }
}

/** True when `child` equals `parent` or lies below it. Both are normalized keys; "" contains everything. */
export function pathWithin(child: string, parent: string): boolean {
  return parent === "" || child === parent || child.startsWith(`${parent}/`);
}

/** Fixed causes have their own sentence; any other cause is an OS error code, shown as it is. */
const UNRESOLVED_CAUSES = {
  "walk limit reached": "services.workspace.unresolvedWalkLimit",
  "pointer file too large": "services.workspace.unresolvedPointerTooLarge",
  "missing gitdir line": "services.workspace.unresolvedMissingGitdir",
  "gitdir is not a directory": "services.workspace.unresolvedGitdirNotDirectory",
  "empty commondir": "services.workspace.unresolvedEmptyCommondir",
  "commondir is not a directory": "services.workspace.unresolvedCommondirNotDirectory",
} as const;

function unresolved(target: string, cause: string): WorkflowContractError {
  const fixed = Object.hasOwn(UNRESOLVED_CAUSES, cause) ? UNRESOLVED_CAUSES[cause as keyof typeof UNRESOLVED_CAUSES] : null;
  return new WorkflowContractError(
    "INVALID_INPUT",
    fixed ? msg(fixed, { target }) : msg("services.workspace.unresolved", { target, cause }),
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
      // Only "no such path yet" walks up; EACCES, EPERM, ELOOP and the like mean "cannot tell".
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) throw unresolved(target, code ?? "unreadable");
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
    const buffer = Buffer.alloc(READ_LIMIT + 1);
    const length = fs.readSync(descriptor, buffer, 0, READ_LIMIT + 1, 0);
    if (length > READ_LIMIT) throw unresolved(file, "pointer file too large");
    return buffer.toString("utf8", 0, length);
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

/**
 * Checkout roots registered for a repository: the main checkout when the common dir is a
 * `.git` directory, plus every linked worktree listed under `<commonDir>/worktrees`.
 * Bounded; never throws. Git files can point to this admin directory without a reverse
 * registration, including an external admin directory named `.git`. Thus this list can
 * establish overlap but cannot prove that a container has no checkout of this repository.
 */
export function repositoryCheckouts(commonDir: string): { roots: string[]; complete: boolean } {
  const roots = new Set<string>();
  const complete = false;
  try {
    if (!isDirectory(commonDir)) return { roots: [], complete: false };
    if (path.basename(commonDir) === ".git") roots.add(normalizedKey(physicalPath(path.dirname(commonDir)).real));
    const worktrees = path.join(commonDir, "worktrees");
    // A repository without linked worktrees has no `worktrees` directory.
    if (fs.statSync(worktrees, { throwIfNoEntry: false })) {
      const listing = fs.opendirSync(worktrees);
      try {
        for (let count = 0; ; count += 1) {
          const name = listing.readSync()?.name;
          if (name === undefined) break;
          if (count >= WALK_LIMIT) {
            break;
          }
          try {
            // `gitdir` names the worktree's `.git` file; like Git, anything else is an invalid registration.
            const pointer = readHead(path.join(worktrees, name, "gitdir")).trim();
            if (!pointer || isUnsupported(pointer) || normalizedKey(path.basename(pointer)) !== ".git") {
              continue;
            }
            roots.add(normalizedKey(physicalPath(path.dirname(path.resolve(worktrees, name, pointer))).real));
          } catch { /* The partial result remains explicitly incomplete. */ }
        }
      } finally {
        listing.closeSync();
      }
    }
  } catch { /* The partial result remains explicitly incomplete. */ }
  return { roots: [...roots], complete };
}

/** Inspect only the requested container, with a fixed entry budget and cycle detection. */
export function repositoryInDirectory(container: string, commonDir: string): "overlap" | "unknown" | "none" {
  const pending = [container];
  const visited = new Set<string>();
  let inspected = 0;
  try {
    while (pending.length > 0) {
      if (++inspected > READ_LIMIT) return "unknown";
      const directory = fs.realpathSync.native(pending.pop()!);
      const key = normalizedKey(directory);
      if (visited.has(key)) continue;
      visited.add(key);
      if (fs.statSync(path.join(directory, ".git"), { throwIfNoEntry: false })) {
        if (discoverGit({ real: directory, existing: directory })?.commonDir === commonDir) return "overlap";
      }
      const listing = fs.opendirSync(directory);
      try {
        for (let entry = listing.readSync(); entry; entry = listing.readSync()) {
          if (++inspected > READ_LIMIT) return "unknown";
          if (entry.name === ".git") continue;
          const child = path.join(directory, entry.name);
          if (entry.isDirectory()) pending.push(child);
          else if (entry.isSymbolicLink()) {
            if (isDirectory(child)) pending.push(child);
            else if (identify(child).git?.commonDir === commonDir) return "overlap";
          }
        }
      } finally { listing.closeSync(); }
    }
    return "none";
  } catch { return "unknown"; }
}

/** The physical key and checkout of one path, as a root surface resolves it (also the edit gate's target). */
export function identify(target: string): Pick<SurfaceIdentityV1, "physical" | "git"> {
  const physical = physicalPath(target);
  return { physical: normalizedKey(physical.real), git: discoverGit(physical) };
}

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
let cachedHost: { file: string; id: string } | null = null;

function readHostId(file: string): string | null {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return HOST_ID.test(value) ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The OS's own machine ID, or null where none is readable (a container without /etc/machine-id). */
export function osMachineId(): string | null {
  try {
    if (process.platform === "win32") {
      const reg = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
      const out = execFileSync(reg, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      return /MachineGuid\s+REG_SZ\s+(\S+)/u.exec(out)?.[1] ?? null;
    }
    if (process.platform === "darwin") {
      const out = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 5000 });
      return /"IOPlatformUUID" = "([^"]+)"/u.exec(out)?.[1] ?? null;
    }
    for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try { const value = fs.readFileSync(file, "utf8").trim(); if (value) return value; } catch { /* next source */ }
    }
  } catch { /* no machine ID */ }
  return null;
}

/** A stable UUID-shaped digest of the machine ID; the raw ID never leaves this function. */
function derivedHostId(machineId: string): string {
  const hex = createHash("sha256").update(`agent-governance-suite/host-id/v1\0${machineId}`, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * This machine's AGS host ID. It is derived from the OS machine ID, so deleting or resetting the AGS state directory,
 * or a hook and a server reading different state directories, give back the same ID and stored roots keep blocking.
 * The `host-id` file in the shared AGS state directory only caches it (and is read first, so most calls spawn
 * nothing). Without an OS machine ID a random UUID is created once and published with a hard link, so two first
 * readers end with the one that won. ponytail: that fallback ID is lost with the file, and copying the state
 * directory copies it (which only makes the two machines' roots block each other).
 */
export function hostIdentity(environment: NodeJS.ProcessEnv = process.env, machineId: () => string | null = osMachineId): string {
  const unresolved = (cause?: unknown) => new WorkflowContractError("INVALID_INPUT", msg("services.workspace.hostUnresolved", {}),
    { reason: "HOST_IDENTITY_UNRESOLVED", ...(cause ? { cause: (cause as NodeJS.ErrnoException).code ?? "unreadable" } : {}) });
  let file: string;
  try { file = resolveHostIdPath(environment); } catch (error) { throw unresolved(error); }
  if (cachedHost?.file === file) return cachedHost.id;
  let id: string | null = null;
  try { id = readHostId(file); } catch { /* derive or create below */ }
  if (!id) {
    const machine = machineId();
    if (machine) {
      id = derivedHostId(machine);
      // The same bytes on every attempt, so a plain rename publishes it; failing to cache only costs a re-derivation.
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const draft = `${file}.${process.pid}.${randomUUID()}`;
        fs.writeFileSync(draft, `${id}\n`, { flag: "wx", mode: 0o600 });
        try { fs.renameSync(draft, file); } finally { fs.rmSync(draft, { force: true }); }
      } catch { /* uncached */ }
    } else {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const draft = `${file}.${process.pid}.${randomUUID()}`;
        fs.writeFileSync(draft, `${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
        try { fs.linkSync(draft, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        finally { fs.rmSync(draft, { force: true }); }
        id = readHostId(file);
      } catch (error) {
        throw unresolved(error);
      }
    }
  }
  if (!id) throw unresolved();
  cachedHost = { file, id };
  return id;
}

/** Paths on different hosts never overlap; an identity without a host is this host's. */
export function sameHost(left: { host?: string }, right: { host?: string }): boolean {
  return !left.host || !right.host || left.host === right.host;
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
