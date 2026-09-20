import fs, { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowContractError } from "../../contracts/types.js";
import {
  assertSupportedScopeEntry,
  pathWithin,
  repositoryCheckouts,
  repositoryInDirectory,
  resolveRootIdentity,
} from "../../mcp-server/src/workspace-identity.js";

const windows = process.platform === "win32";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "workspace-identity-"));
  temporaryDirectories.push(directory);
  return realpathSync.native(directory);
}

function key(...parts: string[]): string {
  const joined = join(...parts);
  return (windows ? joined.replaceAll("\\", "/").toLowerCase() : joined).replace(/\/+$/u, "");
}

function write(file: string, content = ""): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Main checkout with a `.git` directory and one tracked file. */
function mainCheckout(root: string, name = "main"): string {
  const checkout = join(root, name);
  mkdirSync(join(checkout, ".git"), { recursive: true });
  write(join(checkout, "src", "a.ts"));
  return checkout;
}

/** Linked worktree: `.git` file pointing at `<gitDir>/worktrees/<name>` whose commondir is `../..`, registered in its `gitdir`. */
function linkedWorktree(root: string, gitDir: string, name: string): string {
  const checkout = join(root, name);
  const worktreeGitDir = join(gitDir, "worktrees", name);
  write(join(worktreeGitDir, "commondir"), "../..\n");
  write(join(worktreeGitDir, "gitdir"), `${join(checkout, ".git")}\n`);
  write(join(checkout, ".git"), `gitdir: ${worktreeGitDir}\n`);
  write(join(checkout, "src", "a.ts"));
  return checkout;
}

function failure(run: () => unknown): { code: unknown; reason: unknown } {
  try {
    run();
  } catch (error) {
    if (error instanceof WorkflowContractError) return { code: error.code, reason: error.details?.reason };
    throw error;
  }
  return { code: null, reason: null };
}

const unresolved = { code: "INVALID_INPUT", reason: "WORKSPACE_IDENTITY_UNRESOLVED" };
const unsupported = { code: "INVALID_INPUT", reason: "UNSUPPORTED_SCOPE_ENTRY" };

describe("resolveRootIdentity Git discovery", () => {
  it("gives a main checkout and its linked worktree one commonDir and the same relative path", () => {
    const root = fixtureRoot();
    const main = mainCheckout(root);
    const worktree = linkedWorktree(root, join(main, ".git"), "w1");

    const left = resolveRootIdentity(main, ["src/a.ts"]);
    const right = resolveRootIdentity(worktree, ["src/a.ts"]);

    expect(left).toEqual({
      version: 1,
      workspacePhysical: key(main),
      surfaces: [{
        entry: "src/a.ts",
        physical: key(main, "src", "a.ts"),
        git: { commonDir: key(main, ".git"), checkoutRoot: key(main), relative: "src/a.ts" },
        conservative: null,
      }],
    });
    expect(right.surfaces[0]?.git).toEqual({ commonDir: key(main, ".git"), checkoutRoot: key(worktree), relative: "src/a.ts" });
    expect(right.surfaces[0]?.physical).toBe(key(worktree, "src", "a.ts"));
  });

  it("discovers Git per surface below a non-Git workspace and keeps entry order and duplicates", () => {
    const root = fixtureRoot();
    const main = mainCheckout(root);
    linkedWorktree(root, join(main, ".git"), "w1");
    const second = linkedWorktree(root, join(main, ".git"), "w2");

    const identity = resolveRootIdentity(root, ["w2/src/a.ts", join(main, "src"), "w2/src/a.ts"]);

    expect(identity.surfaces.map((surface) => surface.git)).toEqual([
      { commonDir: key(main, ".git"), checkoutRoot: key(second), relative: "src/a.ts" },
      { commonDir: key(main, ".git"), checkoutRoot: key(main), relative: "src" },
      { commonDir: key(main, ".git"), checkoutRoot: key(second), relative: "src/a.ts" },
    ]);
  });

  it("accepts a gitdir without commondir: submodule, separate git dir, bare repository worktree", () => {
    const root = fixtureRoot();
    const superproject = mainCheckout(root, "super");
    const moduleGitDir = join(superproject, ".git", "modules", "sub");
    mkdirSync(moduleGitDir, { recursive: true });
    write(join(superproject, "sub", ".git"), "gitdir: ../.git/modules/sub\n");

    const separateGitDir = join(root, "separate-store");
    mkdirSync(separateGitDir);
    write(join(root, "separate", ".git"), `gitdir: ${separateGitDir}\r\n`);

    const bare = join(root, "bare.git");
    const bareWorktree = linkedWorktree(root, bare, "bw");

    expect(resolveRootIdentity(superproject, ["sub/lib.ts", "."]).surfaces.map((surface) => surface.git)).toEqual([
      { commonDir: key(moduleGitDir), checkoutRoot: key(superproject, "sub"), relative: "lib.ts" },
      { commonDir: key(superproject, ".git"), checkoutRoot: key(superproject), relative: "" },
    ]);
    expect(resolveRootIdentity(join(root, "separate"), ["a.ts"]).surfaces[0]?.git)
      .toEqual({ commonDir: key(separateGitDir), checkoutRoot: key(root, "separate"), relative: "a.ts" });
    expect(resolveRootIdentity(bareWorktree, ["src/a.ts"]).surfaces[0]?.git)
      .toEqual({ commonDir: key(bare), checkoutRoot: key(bareWorktree), relative: "src/a.ts" });
  });

  it("throws WORKSPACE_IDENTITY_UNRESOLVED for damaged Git evidence", () => {
    const root = fixtureRoot();
    write(join(root, "no-pointer", ".git"), "not a pointer\n");
    write(join(root, "missing-gitdir", ".git"), `gitdir: ${join(root, "gone")}\n`);
    write(join(root, "file-gitdir", ".git"), `gitdir: ${join(root, "no-pointer", ".git")}\n`);
    const main = mainCheckout(root);
    const worktree = linkedWorktree(root, join(main, ".git"), "w1");
    write(join(main, ".git", "worktrees", "w1", "commondir"), "../../nowhere\n");
    const emptyCommon = linkedWorktree(root, join(main, ".git"), "w3");
    write(join(main, ".git", "worktrees", "w3", "commondir"), "\n");

    for (const workspace of ["no-pointer", "missing-gitdir", "file-gitdir"]) {
      expect(failure(() => resolveRootIdentity(join(root, workspace), ["a.ts"]))).toEqual(unresolved);
    }
    expect(failure(() => resolveRootIdentity(worktree, ["src/a.ts"]))).toEqual(unresolved);
    expect(failure(() => resolveRootIdentity(emptyCommon, ["src/a.ts"]))).toEqual(unresolved);
    expect(failure(() => resolveRootIdentity(root, ["w1/src/a.ts"]))).toEqual(unresolved);
  });

  it("throws WORKSPACE_IDENTITY_UNRESOLVED for an oversized .git pointer or commondir instead of parsing its head", () => {
    const root = fixtureRoot();
    const main = mainCheckout(root);
    const store = join(root, "store");
    mkdirSync(store);
    write(join(root, "big-pointer", ".git"), `gitdir: ${store}\n${"#".repeat(4096)}`);
    const worktree = linkedWorktree(root, join(main, ".git"), "w1");
    write(join(main, ".git", "worktrees", "w1", "commondir"), `../..\n${" ".repeat(4096)}`);

    expect(failure(() => resolveRootIdentity(join(root, "big-pointer"), ["a.ts"]))).toEqual(unresolved);
    expect(failure(() => resolveRootIdentity(worktree, ["src/a.ts"]))).toEqual(unresolved);
  });

  it("returns git null when no checkout contains the surface", () => {
    const root = fixtureRoot();
    write(join(root, "plain", "a.ts"));

    const identity = resolveRootIdentity(join(root, "plain"), ["a.ts"]);

    expect(identity.surfaces).toEqual([{ entry: "a.ts", physical: key(root, "plain", "a.ts"), git: null, conservative: null }]);
  });
});

describe("resolveRootIdentity physical keys", () => {
  it("resolves targets and workspaces that do not exist yet from the nearest existing ancestor", () => {
    const root = fixtureRoot();
    const main = mainCheckout(root);

    const target = resolveRootIdentity(main, ["new/deep/file.ts"]);
    const ghost = resolveRootIdentity(join(main, "ghost", "workspace"), ["a.ts"]);

    expect(target.surfaces[0]).toMatchObject({
      physical: key(main, "new", "deep", "file.ts"),
      git: { checkoutRoot: key(main), relative: "new/deep/file.ts" },
    });
    expect(ghost.workspacePhysical).toBe(key(main, "ghost", "workspace"));
    expect(ghost.surfaces[0]).toMatchObject({
      physical: key(main, "ghost", "workspace", "a.ts"),
      git: { checkoutRoot: key(main), relative: "ghost/workspace/a.ts" },
    });
    expect(resolveRootIdentity(join(main, "ghost", "workspace"), ["a.ts"])).toEqual(ghost);
  });

  it("falls back to the existing ancestor below a file, where realpath reports ENOTDIR or ENOENT", () => {
    const root = fixtureRoot();
    const main = mainCheckout(root);

    const surface = resolveRootIdentity(main, ["src/a.ts/child"]).surfaces[0];

    expect(surface).toMatchObject({
      physical: key(main, "src", "a.ts", "child"),
      git: { checkoutRoot: key(main), relative: "src/a.ts/child" },
    });
  });

  it("throws WORKSPACE_IDENTITY_UNRESOLVED for a link loop instead of falling back to an unresolved key", () => {
    const root = fixtureRoot();
    const main = mainCheckout(root);
    try {
      symlinkSync(join(main, "b"), join(main, "a"), "junction");
      symlinkSync(join(main, "a"), join(main, "b"), "junction");
    } catch {
      return; // The platform refuses links without elevation.
    }

    expect(failure(() => resolveRootIdentity(main, ["a/new.ts"]))).toEqual(unresolved);
    expect(failure(() => resolveRootIdentity(join(main, "a"), ["x.ts"]))).toEqual(unresolved);
  });

  it("reports the errno code when realpath fails for another reason than absence", () => {
    const root = fixtureRoot();
    const main = mainCheckout(root);
    const native = vi.spyOn(realpathSync, "native").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    let details: unknown = null;
    try {
      resolveRootIdentity(main, ["src/a.ts"]);
    } catch (error) {
      details = error instanceof WorkflowContractError ? error.details : error;
    } finally {
      native.mockRestore();
    }

    expect(details).toMatchObject({ reason: "WORKSPACE_IDENTITY_UNRESOLVED", cause: "EACCES" });
  });

  it("gives a junction or symlink alias the physical key of its target", () => {
    const root = fixtureRoot();
    const main = mainCheckout(root);
    const alias = join(root, "alias");
    try {
      symlinkSync(main, alias, "junction");
    } catch {
      return; // The platform refuses links without elevation.
    }

    const viaAlias = resolveRootIdentity(alias, ["src/a.ts", "src/new.ts"]);

    expect(viaAlias).toEqual(resolveRootIdentity(main, ["src/a.ts", "src/new.ts"]));
    expect(viaAlias.workspacePhysical).toBe(key(main));
  });

  it("compares case-insensitively on win32 only", () => {
    const root = fixtureRoot();
    const main = mainCheckout(root);

    const lower = resolveRootIdentity(main, ["new/file.ts"]).surfaces[0];
    const upper = resolveRootIdentity(main, ["NEW/File.ts"]).surfaces[0];

    expect(upper?.physical === lower?.physical).toBe(windows);
    expect(upper?.git?.relative === lower?.git?.relative).toBe(windows);
    expect(upper?.git?.relative).toBe(windows ? "new/file.ts" : "NEW/File.ts");
  });

  it("accepts absolute entries and plain paths with spaces", () => {
    const root = fixtureRoot();
    const main = mainCheckout(root);
    write(join(main, "my dir", "a file.ts"));

    const identity = resolveRootIdentity(root, [join(main, "my dir", "a file.ts")]);

    expect(identity.surfaces[0]).toMatchObject({
      physical: key(main, "my dir", "a file.ts"),
      git: { checkoutRoot: key(main), relative: "my dir/a file.ts" },
      conservative: null,
    });
  });
});

describe("resolveRootIdentity entry classes", () => {
  it("widens a glob to the directory before the first meta segment", () => {
    const root = fixtureRoot();
    const main = mainCheckout(root);

    const identity = resolveRootIdentity(main, ["src/**", "src/a/*.ts", "src/[ab]/x.ts", join(main, "src", "{a,b}.ts")]);

    expect(identity.surfaces.map((surface) => [surface.physical, surface.git?.relative, surface.conservative])).toEqual([
      [key(main, "src"), "src", "glob-prefix"],
      [key(main, "src", "a"), "src/a", "glob-prefix"],
      [key(main, "src"), "src", "glob-prefix"],
      [key(main, "src"), "src", "glob-prefix"],
    ]);
  });

  it("widens a leading glob to the checkout of the workspace, or to the workspace outside a checkout", () => {
    const root = fixtureRoot();
    const main = mainCheckout(root);
    mkdirSync(join(root, "plain"));

    const inside = resolveRootIdentity(join(main, "src"), ["**/*.ts"]);
    const outside = resolveRootIdentity(join(root, "plain"), ["*.ts"]);

    expect(inside.surfaces).toEqual([{
      entry: "**/*.ts",
      physical: key(main),
      git: { commonDir: key(main, ".git"), checkoutRoot: key(main), relative: "" },
      conservative: "leading-glob",
    }]);
    expect(outside.surfaces).toEqual([{ entry: "*.ts", physical: key(root, "plain"), git: null, conservative: "leading-glob" }]);
  });

  it("rejects URIs and control characters unless legacy widens them to the workspace", () => {
    const root = fixtureRoot();
    const main = mainCheckout(root);
    const entries = ["https://example.com/a.ts", "file:///c:/a.ts", "src/a\u0000.ts", "src/a\n.ts", "src/a\u007f.ts"];

    for (const entry of entries) {
      expect(failure(() => assertSupportedScopeEntry(entry))).toEqual(unsupported);
      expect(failure(() => resolveRootIdentity(main, ["src/a.ts", entry]))).toEqual(unsupported);
    }
    expect(() => assertSupportedScopeEntry("C:/repo/src/a.ts")).not.toThrow();
    expect(() => assertSupportedScopeEntry("src/my dir/a.ts")).not.toThrow();

    const legacy = resolveRootIdentity(join(main, "src"), ["a.ts", ...entries], { legacy: true });

    expect(legacy.surfaces[0]?.conservative).toBeNull();
    expect(legacy.surfaces.slice(1)).toEqual(entries.map((entry) => ({
      entry,
      physical: legacy.workspacePhysical,
      git: { commonDir: key(main, ".git"), checkoutRoot: key(main), relative: "src" },
      conservative: "legacy-unsupported",
    })));
  });
});

describe("repositoryCheckouts", () => {
  it("does not infer a complete checkout list from an external admin directory named .git", () => {
    const root = fixtureRoot();
    const admin = join(root, "admin", ".git");
    mkdirSync(dirname(admin));
    const original = join(root, "original");
    const initialized = spawnSync("git", ["init", "--separate-git-dir", admin, original], {
      encoding: "utf8", windowsHide: true, timeout: 10_000,
    });
    expect(initialized.status, initialized.stderr).toBe(0);
    const listing = repositoryCheckouts(key(admin));
    expect(listing.roots).not.toContain(key(original));
    expect(listing.complete).toBe(false);
  });
  it("lists the main checkout and its linked worktrees with the keys resolveRootIdentity reports", () => {
    const root = fixtureRoot();
    const main = mainCheckout(root);
    const first = linkedWorktree(root, join(main, ".git"), "w1");
    const second = linkedWorktree(root, join(main, ".git"), "w2");
    const commonDir = key(main, ".git");

    const listing = repositoryCheckouts(commonDir);
    const checkouts = [...listing.roots].sort();

    expect(listing.complete).toBe(false);
    expect(checkouts).toEqual([key(main), key(first), key(second)].sort());
    expect(checkouts).toEqual([main, first, second]
      .map((checkout) => resolveRootIdentity(checkout, ["src/a.ts"]).surfaces[0]?.git)
      .map((git) => (git?.commonDir === commonDir ? git.checkoutRoot : null))
      .sort());
  });

  it("keeps a deleted checkout, resolves a relative gitdir and lists no checkout twice", () => {
    const root = fixtureRoot();
    const main = mainCheckout(root);
    const gone = linkedWorktree(root, join(main, ".git"), "gone");
    rmSync(gone, { recursive: true, force: true });
    const relative = linkedWorktree(root, join(main, ".git"), "rel");
    write(join(main, ".git", "worktrees", "rel", "gitdir"), "../../../../rel/.git\n");
    write(join(main, ".git", "worktrees", "rel-again", "gitdir"), `${join(relative, ".git")}\r\n`);

    const listing = repositoryCheckouts(key(main, ".git"));
    expect([...listing.roots].sort()).toEqual([key(main), key(gone), key(relative)].sort());
    expect(listing.complete).toBe(false);
  });

  it("skips malformed, empty, oversized and missing gitdir registrations and reports the list as partial", () => {
    const root = fixtureRoot();
    const main = mainCheckout(root);
    const worktree = linkedWorktree(root, join(main, ".git"), "w1");
    const registry = join(main, ".git", "worktrees");
    write(join(registry, "empty", "gitdir"), "\n");
    write(join(registry, "two-lines", "gitdir"), `${join(root, "x", ".git")}\n${join(root, "y", ".git")}\n`);
    write(join(registry, "not-dot-git", "gitdir"), `${join(root, "z")}\n`);
    write(join(registry, "oversized", "gitdir"), `${join(root, "big", ".git")}\n${" ".repeat(4096)}`);
    mkdirSync(join(registry, "no-gitdir"));
    write(join(registry, "a-file"));

    const listing = repositoryCheckouts(key(main, ".git"));
    expect([...listing.roots].sort()).toEqual([key(main), key(worktree)].sort());
    // A registration that cannot be read may name a checkout, so the list must not be read as exhaustive.
    expect(listing.complete).toBe(false);
  });

  it("lists only the worktrees of a bare repository and nothing for a missing common dir", () => {
    const root = fixtureRoot();
    const bare = join(root, "bare.git");
    const worktree = linkedWorktree(root, bare, "bw");
    const main = mainCheckout(root);

    expect(repositoryCheckouts(key(bare))).toEqual({ roots: [key(worktree)], complete: false });
    // Reverse registrations cannot prove there are no additional Git-file checkouts.
    expect(repositoryCheckouts(key(main, ".git"))).toEqual({ roots: [key(main)], complete: false });
    for (const missing of [key(root, "nowhere", ".git"), key(root, "nowhere.git"), "", "bad\u0000dir/.git"]) {
      expect(repositoryCheckouts(missing)).toEqual({ roots: [], complete: false });
    }
  });
});

describe("bounded repository container inspection", () => {
  it("proves an unrelated directory and terminates a directory alias cycle", () => {
    const root = fixtureRoot();
    symlinkSync(root, join(root, "loop"), windows ? "junction" : "dir");
    expect(repositoryInDirectory(root, key(root, "unrelated-admin"))).toBe("none");
  });

  it("returns unknown on access failure or when the entry budget is exhausted", () => {
    const root = fixtureRoot();
    const inaccessible = vi.spyOn(fs, "opendirSync").mockImplementation(() => { throw new Error("EACCES"); });
    try { expect(repositoryInDirectory(root, "unrelated")).toBe("unknown"); }
    finally { inaccessible.mockRestore(); }
    const closeSync = vi.fn();
    const oversized = vi.spyOn(fs, "opendirSync").mockReturnValue({
      readSync: () => ({ name: "ordinary", isDirectory: () => false, isSymbolicLink: () => false }),
      closeSync,
    } as unknown as fs.Dir);
    try {
      expect(repositoryInDirectory(root, "unrelated")).toBe("unknown");
      expect(closeSync).toHaveBeenCalledOnce();
    } finally { oversized.mockRestore(); }
  });
});

describe("pathWithin", () => {
  it("matches equal paths and descendants on segment boundaries only", () => {
    expect(pathWithin("src/a", "src/a")).toBe(true);
    expect(pathWithin("src/a/b.ts", "src/a")).toBe(true);
    expect(pathWithin("src/ab", "src/a")).toBe(false);
    expect(pathWithin("src", "src/a")).toBe(false);
    expect(pathWithin("src/a", "")).toBe(true);
    expect(pathWithin("", "")).toBe(true);
    expect(pathWithin("", "src")).toBe(false);
  });
});
