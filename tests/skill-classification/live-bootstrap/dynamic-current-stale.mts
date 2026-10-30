import assert from "node:assert/strict";
import {appendFile, cp, mkdir, mkdtemp, realpath, rm, symlink, unlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {readyEstimateMock} from "./prepared-fixture.mts";

const repo = path.resolve(process.argv[2] ?? ".");
const helper = path.resolve(process.argv[3] ?? path.join(import.meta.dirname, "bootstrap.mts"));
const api = await import(pathToFileURL(helper).href) as typeof import("./bootstrap.mts");
const parentOwnsRoot = process.argv[4] !== undefined;
const root = parentOwnsRoot ? path.resolve(process.argv[4]!) : await mkdtemp(path.join(os.tmpdir(), "ags-current-stale-"));
const dependencyLink = path.join(root, "node_modules/zod");
let dependencyLinked = false;
try {
  const relative = path.relative(await realpath(repo), await realpath(root));
  assert(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "SCRATCH_MUST_BE_OUTSIDE_REPOSITORY");
  await cp(path.join(repo, "package.json"), path.join(root, "package.json"));
  // Fresh imports of copied TypeScript need only zod, not a node_modules copy.
  await mkdir(path.dirname(dependencyLink), {recursive: true});
  await symlink(await realpath(path.join(repo, "node_modules/zod")), dependencyLink, process.platform === "win32" ? "junction" : "dir");
  dependencyLinked = true;
  await cp(path.join(repo, "skills"), path.join(root, "skills"), {recursive: true});
  await cp(path.join(repo, "mcp-server/src"), path.join(root, "mcp-server/src"), {recursive: true});
  await mkdir(path.join(root, "tests/skill-classification"), {recursive: true});
  for (const name of ["evaluation.ts", "fixtures.json", "fixtures.source-successor.json", "fixtures.unavailable-source-successor.json"]) await cp(path.join(repo, "tests/skill-classification", name), path.join(root, "tests/skill-classification", name));
  const {config} = await readyEstimateMock(api, root, path.join(root, "out"), "current-stale-registry");
  const baseline = await api.preflight(config, await api.prepare(config));
  assert(!baseline.blocked.includes("ESTIMATE_SOURCE_OR_INPUT_UNBOUND"), "BASELINE_ESTIMATE_BOUND");
  await appendFile(path.join(root, "skills/registry.json"), "\n");
  let envReads = 0, calls = 0;
  const result = await api.run(config, {executionKind: "offline-mock", env: new Proxy({}, {get() {envReads++; throw new Error("UNEXPECTED_ENV_READ");}}),
    fetcher: async () => {calls++; throw new Error("UNEXPECTED_FETCH");}});
  assert.equal(result.status, "BLOCKED");
  if (result.status !== "BLOCKED") throw new Error("Expected stale source to block");
  assert(result.blocked.includes("ESTIMATE_SOURCE_OR_INPUT_UNBOUND"), "STALE_REGISTRY_ESTIMATE_UNBOUND");
  assert.equal(envReads, 0); assert.equal(calls, 0);
  console.log(JSON.stringify({status: "CURRENT_STALE_REGISTRY_PASS", actualApiCalls: 0, actualCredentialLookups: 0}));
} finally {
  if (!parentOwnsRoot) {
    if (dependencyLinked) await unlink(dependencyLink);
    await rm(root, {recursive: true, force: true});
  }
}
