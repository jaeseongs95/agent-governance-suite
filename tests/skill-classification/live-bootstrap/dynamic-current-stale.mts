import assert from "node:assert/strict";
import {appendFile, cp, mkdir, mkdtemp, rm} from "node:fs/promises";
import path from "node:path";
import * as api from "./bootstrap.mts";
import {readyEstimateMock} from "./prepared-fixture.mts";

const repo = path.resolve(process.argv[2] ?? ".");
// The isolated child uses the repository's Node dependency resolution.
const root = await mkdtemp(path.join(repo, ".ags-current-stale-"));
try {
  await cp(path.join(repo, "skills"), path.join(root, "skills"), {recursive: true});
  await cp(path.join(repo, "mcp-server/src"), path.join(root, "mcp-server/src"), {recursive: true});
  await mkdir(path.join(root, "tests/skill-classification"), {recursive: true});
  for (const name of ["evaluation.ts", "fixtures.json"]) await cp(path.join(repo, "tests/skill-classification", name), path.join(root, "tests/skill-classification", name));
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
} finally {await rm(root, {recursive: true, force: true});}
