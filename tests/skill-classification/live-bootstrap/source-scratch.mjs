import assert from "node:assert/strict";
import {copyFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";

function assertExternal(repo, root) {
  const relative = path.relative(realpathSync(repo), realpathSync(root));
  assert(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "SCRATCH_MUST_BE_OUTSIDE_REPOSITORY");
}

export function createSourceScratch(repo, prefix = "ags-bootstrap-source-") {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  try {assertExternal(repo, root); return root;}
  catch (error) {rmSync(root, {recursive: true, force: true}); throw error;}
}

export function prepareSourceScratch(repo, root) {
  assertExternal(repo, root);
  copyFileSync(path.join(repo, "package.json"), path.join(root, "package.json"));
  const dependencyLink = path.join(root, "node_modules/zod");
  mkdirSync(path.dirname(dependencyLink), {recursive: true});
  symlinkSync(realpathSync(path.join(repo, "node_modules/zod")), dependencyLink, process.platform === "win32" ? "junction" : "dir");
}

export function removeSourceScratch(root) {
  const dependencyLink = path.join(root, "node_modules/zod");
  const linked = lstatSync(dependencyLink, {throwIfNoEntry: false});
  if (linked) {
    assert(linked.isSymbolicLink(), "SCRATCH_ZOD_MUST_BE_LINK");
    unlinkSync(dependencyLink);
  }
  rmSync(root, {recursive: true, force: true});
}
