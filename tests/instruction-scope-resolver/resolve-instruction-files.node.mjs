import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isPathWithin, pathFlavor, resolveInstructionFiles } from "../../skills/instruction-scope-resolver/scripts/resolve-instruction-files.mjs";

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "instruction-scope-"));
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  return root;
}

function request(root, target = "src/nested") {
  return {
    schemaVersion: "1.0.0",
    workspaceRoot: root,
    instructionRoots: [{ path: root, precedence: 10, authorized: true }],
    targets: [{ path: target, mayNotExist: false }],
    externalPolicyRefs: [],
  };
}

test("orders root and nested instructions and uses a non-empty override", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "AGENTS.md"), "root rule\n");
  await writeFile(path.join(root, "src", "AGENTS.md"), "sibling rule\n");
  await writeFile(path.join(root, "src", "AGENTS.override.md"), "override rule\n");
  const before = (await stat(path.join(root, "AGENTS.md"))).mtimeMs;
  const result = await resolveInstructionFiles(request(root));
  assert.equal(result.verdict, "ANALYSIS_REQUIRED");
  assert.equal(result.analysisStatus, "required");
  assert.deepEqual(result.targets[0].instructionChain.map((item) => item.kind), ["agents", "override"]);
  assert.equal(result.targets[0].instructionChain[1].replacesSiblingAgents, true);
  assert.equal((await stat(path.join(root, "AGENTS.md"))).mtimeMs, before, "resolver must be read-only");
});

test("does not claim PASS before instruction semantics are analyzed", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "AGENTS.md"), "Only edit files under src.\n");
  const result = await resolveInstructionFiles(request(root));
  assert.equal(result.instructionFileManifest.length, 1);
  assert.equal(result.targets[0].activeRules.length, 0);
  assert.equal(result.analysisStatus, "required");
  assert.equal(result.verdict, "ANALYSIS_REQUIRED");
  assert.notEqual(result.verdict, "PASS");
});

test("ignores a whitespace override and marks a planned path absent", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "AGENTS.md"), "root\n");
  await writeFile(path.join(root, "src", "AGENTS.md"), "src\n");
  await writeFile(path.join(root, "src", "AGENTS.override.md"), "  \r\n");
  const planned = request(root, "src/nested/new-package/file.ts");
  planned.targets[0].mayNotExist = true;
  const result = await resolveInstructionFiles(planned);
  assert.equal(result.targets[0].exists, false);
  assert.deepEqual(result.targets[0].instructionChain.map((item) => item.kind), ["agents", "agents"]);
  assert.match(result.findings[0], /future nested instructions/u);
});

test("deduplicates the manifest while keeping per-target chains", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "other"));
  await writeFile(path.join(root, "AGENTS.md"), "root\n");
  const input = request(root);
  input.targets.push({ path: "other", mayNotExist: false });
  const result = await resolveInstructionFiles(input);
  assert.equal(result.targets.length, 2);
  assert.equal(result.instructionFileManifest.length, 1);
});

test("rejects traversal and an external symlink", async (t) => {
  const root = await workspace();
  const outside = await mkdtemp(path.join(os.tmpdir(), "instruction-outside-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await assert.rejects(resolveInstructionFiles(request(root, "../outside")), /outside workspaceRoot/u);
  try {
    await symlink(outside, path.join(root, "external"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(resolveInstructionFiles(request(root, "external")), /outside workspaceRoot/u);
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error;
  }
});

test("rejects an absent target without mayNotExist", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(resolveInstructionFiles(request(root, "missing/file.ts")), /mayNotExist is false/u);
});

test("Windows path containment is case-insensitive and separator aware", () => {
  assert.equal(pathFlavor("C:\\Work\\Repo"), path.win32);
  assert.equal(isPathWithin("C:\\Work\\Repo", "c:\\work\\repo\\src\\a.ts", path.win32), true);
  assert.equal(isPathWithin("C:\\Work\\Repo", "C:\\Work\\Repository\\a.ts", path.win32), false);
  assert.equal(isPathWithin("C:\\Work\\Repo", "D:\\Work\\Repo", path.win32), false);
});
