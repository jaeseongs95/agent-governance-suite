import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const owned = [];
afterEach(() => { for (const directory of owned.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const names = ["alpha.node-test.mjs", "beta.node-test.mjs", "gamma.node-test.mjs"];

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-runner-main-")); owned.push(directory);
  mkdirSync(path.join(directory, "scripts"));
  for (const name of ["run-tests.mjs", "python-runner.mjs", "test-subreaper.py"]) {
    copyFileSync(path.join(root, "scripts", name), path.join(directory, "scripts", name));
  }
  mkdirSync(path.join(directory, "node_modules", "vitest"), { recursive: true });
  const calls = path.join(directory, "calls.jsonl");
  writeFileSync(path.join(directory, "node_modules", "vitest", "vitest.mjs"),
    'import{appendFileSync}from"node:fs";appendFileSync(' + JSON.stringify(calls) +
    ',JSON.stringify({kind:"vitest",temp:process.env.TMPDIR})+"\\n");', "utf8");
  return { directory, calls };
}
function launch(f, preload) {
  return spawnSync(process.execPath, [...(preload ? ["--import", pathToFileURL(preload).href] : []),
    path.join(f.directory, "scripts", "run-tests.mjs")],
  { encoding: "utf8", timeout: 20_000, windowsHide: true });
}
function diagnostics(result) {
  const records = result.stderr.trim().split(/\r?\n/u).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).filter(record => record.component === "test-runner");
  return records;
}
function diagnostic(result) {
  const records = diagnostics(result);
  expect(records).toHaveLength(1);
  return records[0];
}
function calls(f) { return readFileSync(f.calls, "utf8").trim().split(/\r?\n/u).map(line => JSON.parse(line)); }

it("main reports the actual missing-collection cause after one successful Vitest child", () => {
  const f = fixture();
  const result = launch(f);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(diagnostic(result)).toEqual({ component: "test-runner", phase: "node-collection",
    reason: "RUNNER_UNAVAILABLE" });
  expect(result.stderr).toContain("ENOENT");
  expect(result.stderr).toContain("scandir");
  expect(result.stderr).toContain(path.join(f.directory, "tests"));
  const visits = calls(f);
  expect(visits).toHaveLength(1);
  expect(visits[0].kind).toBe("vitest");
  expect(existsSync(visits[0].temp)).toBe(false);
});

it("main distinguishes an empty collection from an unavailable reader and does not run Node", () => {
  const f = fixture(); mkdirSync(path.join(f.directory, "tests"));
  const result = launch(f);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(diagnostic(result)).toEqual({ component: "test-runner", phase: "node-collection",
    reason: "NODE_TEST_COLLECTION_EMPTY" });
  expect(result.stderr).toContain("No node:test suites were collected.");
  expect(calls(f)).toHaveLength(1);
  expect(JSON.parse(result.stdout.trim())).toEqual({ runner: "node:test", fileCount: 0, files: [] });
});

it.each([...names, null])("main collects generic native fixtures and propagates the controlled outcome (%s)", failing => {
  const f = fixture();
  const tests = path.join(f.directory, "tests", "native-fixtures");
  mkdirSync(tests, { recursive: true });
  for (const name of names) {
    writeFileSync(path.join(tests, name), 'import test from"node:test";import assert from"node:assert/strict";import{appendFileSync}from"node:fs";' +
      'appendFileSync(' + JSON.stringify(f.calls) + ',JSON.stringify({kind:"node",name:' + JSON.stringify(name) + '})+"\\n");' +
      'test(' + JSON.stringify(name) + ',()=>{assert.equal(' + JSON.stringify(name === failing) + ',false)});', "utf8");
  }
  writeFileSync(path.join(tests, "helper.node.mjs"), 'throw new Error("unselected helper");', "utf8");
  const result = launch(f);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(failing === null ? 0 : 1);
  const collection = result.stdout.split(/\r?\n/u).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }).find(record => record.runner === "node:test");
  expect(collection).toEqual({ runner: "node:test", fileCount: 3,
    files: names.map(name => path.join(tests, name)).sort() });
  const visits = calls(f);
  expect(visits.filter(visit => visit.kind === "vitest")).toHaveLength(1);
  expect(visits.filter(visit => visit.kind === "node").map(visit => visit.name).sort()).toEqual([...names].sort());
  expect(visits).toHaveLength(4);
  if (failing !== null) expect(result.stdout).toContain(failing);
  else expect(result.stderr).not.toContain('"component":"test-runner"');
  expect(result.stderr).not.toContain("unselected helper");
});

function dualFailureFixture(cleanupFails = true) {
  const f = fixture();
  const preload = path.join(f.directory, "controlled-preload.mjs");
  const marker = path.join(f.directory, "controlled.json");
  writeFileSync(preload, [
    'import fs from"node:fs";import cp from"node:child_process";import{syncBuiltinESMExports}from"node:module";import{EventEmitter}from"node:events";',
    'const primary=Object.freeze(Object.assign(new Error("controlled spawn failure"),{code:"ENOENT",syscall:"spawn"}));globalThis.__runnerTestPrimary=primary;',
    'const cleanup=Object.freeze(Object.assign(new Error("controlled cleanup failure"),{code:"EPERM",syscall:"unlink"}));globalThis.__runnerTestCleanup=cleanup;',
    'const originalRemove=fs.rmSync;let cleanupAttempts=0;cp.spawnSync=()=>({status:0,stdout:"Python 3.12.0",stderr:""});',
    'cp.spawn=()=>{const child=new EventEmitter();child.exitCode=null;child.kill=()=>true;queueMicrotask(()=>{child.emit("error",primary);child.emit("close",null,null)});return child};',
    'fs.rmSync=directory=>{fs.writeFileSync(' + JSON.stringify(marker) +
      ',JSON.stringify({directory,cleanupAttempts:++cleanupAttempts}));' + (cleanupFails ? 'throw cleanup' : 'originalRemove(directory,{recursive:true,force:true})') + '};syncBuiltinESMExports();',
  ].join("\n"), "utf8");
  return { ...f, preload, marker };
}
function reclaimFailedCleanup(f) {
  const record = JSON.parse(readFileSync(f.marker, "utf8"));
  owned.push(record.directory);
  expect(record.cleanupAttempts).toBe(1);
}
it("actual main reports the first native Error and the separate cleanup Error in readable form", () => {
  const f = dualFailureFixture();
  const result = launch(f, f.preload);
  reclaimFailedCleanup(f);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(diagnostics(result)).toEqual([
    { component: "test-runner", phase: "vitest", reason: "RUNNER_UNAVAILABLE" },
    { component: "test-runner", phase: "cleanup", reason: "RUNNER_CLEANUP_FAILED" },
  ]);
  for (const detail of ["controlled spawn failure", "ENOENT", "spawn", "controlled cleanup failure", "EPERM", "unlink"]) {
    expect(result.stderr).toContain(detail);
  }
  for (const message of ["controlled spawn failure", "controlled cleanup failure"]) {
    expect(result.stderr.split(message).length - 1).toBe(1);
  }
  expect(result.stderr).not.toContain("Test execution and temporary cleanup both failed.");
  expect(existsSync(f.calls)).toBe(false);
});
it.each([true, false])("the public runTests boundary exposes real dual failures or the original single Error (%s)", cleanupFails => {
  const f = dualFailureFixture(cleanupFails);
  const moduleUrl = pathToFileURL(path.join(f.directory, "scripts", "run-tests.mjs")).href;
  const body = 'import{runTests}from' + JSON.stringify(moduleUrl) +
    ';let caught;try{await runTests([])}catch(error){caught=error}const first=globalThis.__runnerTestPrimary;' +
    'const dual=caught instanceof AggregateError;const singleSame=caught===first;' +
    'const causeSame=caught?.cause===first;const firstSame=dual&&caught.errors[0]===first;' +
    'const cleanupSame=dual&&caught.errors[1]===globalThis.__runnerTestCleanup;' +
    'console.log(JSON.stringify({dual,singleSame,causeSame,firstSame,cleanupSame,count:dual?caught.errors.length:0,code:first.code,frozen:Object.isFrozen(first)}));';
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(f.preload).href, "--input-type=module", "-e", body],
    { encoding: "utf8", timeout: 20_000, windowsHide: true });
  reclaimFailedCleanup(f);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual(cleanupFails
    ? { dual: true, singleSame: false, causeSame: true, firstSame: true, cleanupSame: true, count: 2, code: "ENOENT", frozen: true }
    : { dual: false, singleSame: true, causeSame: false, firstSame: false, cleanupSame: false, count: 0, code: "ENOENT", frozen: true });
});

it.each([0, 23])("cleanup failure preserves a failed numeric child outcome but rejects child success (%s)", childExitCode => {
  const f = fixture();
  const vitest = path.join(f.directory, "node_modules", "vitest", "vitest.mjs");
  writeFileSync(vitest, readFileSync(vitest, "utf8") + "\nprocess.exitCode=" + childExitCode + ";", "utf8");
  const preload = path.join(f.directory, "cleanup-preload.mjs");
  const marker = path.join(f.directory, "cleanup.json");
  writeFileSync(preload, [
    'import fs from"node:fs";import{syncBuiltinESMExports}from"node:module";let attempts=0;',
    'fs.rmSync=directory=>{fs.writeFileSync(' + JSON.stringify(marker) +
      ',JSON.stringify({directory,cleanupAttempts:++attempts}));throw Object.assign(new Error("controlled cleanup failure"),{code:"EPERM",syscall:"unlink"})};syncBuiltinESMExports();',
  ].join("\n"), "utf8");
  const result = launch(f, preload);
  const record = JSON.parse(readFileSync(marker, "utf8")); owned.push(record.directory);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(childExitCode === 0 ? 1 : 23);
  expect(record.cleanupAttempts).toBe(1);
  expect(calls(f)).toHaveLength(1);
  expect(result.stderr).toContain("EPERM");
  expect(result.stderr).toContain("controlled cleanup failure");
  expect(diagnostic(result)).toEqual(childExitCode === 0
    ? { component: "test-runner", phase: "cleanup", reason: "RUNNER_CLEANUP_FAILED" }
    : { component: "test-runner", phase: "cleanup", reason: "RUNNER_CLEANUP_FAILED", childExitCode: 23 });
});

it("the public runTests cleanup-only failure exposes its own code and the exact native cause", () => {
  const f = dualFailureFixture();
  const preload = readFileSync(f.preload, "utf8").replace(
    'child.emit("error",primary);child.emit("close",null,null)', 'child.emit("close",0,null)');
  writeFileSync(f.preload, preload, "utf8");
  const moduleUrl = pathToFileURL(path.join(f.directory, "scripts", "run-tests.mjs")).href;
  const body = 'import{runTests}from' + JSON.stringify(moduleUrl) +
    ';let caught;try{await runTests([])}catch(error){caught=error}' +
    'console.log(JSON.stringify({code:caught?.code,causeSame:caught?.cause===globalThis.__runnerTestCleanup,' +
    'sameAsNative:caught===globalThis.__runnerTestCleanup,nativeCode:caught?.cause?.code}));';
  const result = spawnSync(process.execPath,
    ["--import", pathToFileURL(f.preload).href, "--input-type=module", "-e", body],
    { encoding: "utf8", timeout: 20_000, windowsHide: true });
  reclaimFailedCleanup(f);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout.trim())).toEqual({
    code: "RUNNER_CLEANUP_FAILED", causeSame: true, sameAsNative: false, nativeCode: "EPERM",
  });
});
