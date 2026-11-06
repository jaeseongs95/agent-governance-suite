import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { profileWorkspace } from "../../skills/workspace-convention-profiler/scripts/profile-workspace.mjs";

const request = workspaceRoot => ({ schemaVersion: "1.0.0", workspaceRoot,
  taskObjective: "nested workspace Git scope", targetPaths: ["src"], resolvedInstructionRefs: [], knownConstraints: [],
  evidenceLimits: { maxFiles: 100, maxBytesPerFile: 100000, excludedPatterns: [] } });

test("AGS38 profile Git state stays inside its requested workspace", { timeout: 30_000 }, async () => {
  const repository = await mkdtemp(path.join(tmpdir(), "ags38-host-git-scope-"));
  const git = args => execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8", timeout: 5_000, windowsHide: true,
  });
  try {
    const workspace = path.join(repository, "nested");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "README.md"), "# Nested workspace\n");
    await writeFile(path.join(workspace, "src/index.js"), "export const value = 1;\n");
    await writeFile(path.join(repository, "outside.txt"), "original\n");
    git(["init", "-b", "main"]);
    git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
    const clean = await profileWorkspace(request(workspace));
    assert.equal(clean.verdict, "PASS");
    assert.equal(clean.workspace.dirtyState, "clean");

    // Neither sibling tracked edits nor sibling untracked files belong to the nested request.
    await writeFile(path.join(repository, "outside.txt"), "modified\n");
    await writeFile(path.join(repository, "outside-untracked.txt"), "untracked\n");
    const before = git(["status", "--porcelain=v1", "--untracked-files=all"]);
    const outside = await profileWorkspace(request(workspace));
    assert.equal(outside.verdict, "PASS");
    assert.equal(outside.workspace.dirtyState, "clean");
    assert.equal(outside.profileFingerprint, clean.profileFingerprint);
    assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"]), before, "profiling is read-only");
    const wholeRepository = await profileWorkspace(request(repository));
    assert.equal(wholeRepository.workspace.dirtyState, "dirty", "root requests still see root edits");

    await writeFile(path.join(workspace, "src/index.js"), "export const value = 2;\n");
    const inside = await profileWorkspace(request(workspace));
    assert.equal(inside.verdict, "PASS");
    assert.equal(inside.workspace.dirtyState, "dirty");
    assert.notEqual(inside.profileFingerprint, clean.profileFingerprint);
  } finally {
    assert.equal(path.dirname(repository), path.resolve(tmpdir()));
    assert.ok(path.basename(repository).startsWith("ags38-host-git-scope-"));
    await rm(repository, { recursive: true, force: true });
  }
});
