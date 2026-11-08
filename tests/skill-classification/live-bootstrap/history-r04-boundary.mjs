import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {writeSync} from "node:fs";
import {cp, mkdir, readdir, readFile, rm} from "node:fs/promises";
import {spawn} from "node:child_process";
import path from "node:path";
import {clearTimeout, setTimeout} from "node:timers";
import {fileURLToPath} from "node:url";
import {createSourceScratch, prepareSourceScratch, removeSourceScratch} from "./source-scratch.mjs";

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    let observationError, sequence = 0;
    const observe = (event, details = {}) => {
      if (!options.observation) return;
      try {
        const bytes = Buffer.from(`${JSON.stringify({observation: "history-tar-r01", sequence: ++sequence,
          monoMs: Number(process.hrtime.bigint() / 1_000_000n), event, ...details})}\n`);
        if (bytes.length > 384) throw new Error("HISTORY_OBSERVATION_LIMIT");
        if (writeSync(2, bytes) !== bytes.length) throw new Error("HISTORY_OBSERVATION_SHORT_WRITE");
      }
      catch (error) { observationError ??= error; }
    };
    const finish = result => resolve({...result, error: observationError
      ? new AggregateError([result.error, observationError].filter(Boolean), "HISTORY_OBSERVATION_FAILED") : result.error});
    observe("spawn-request");
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "", stderr = "", error;
    if (options.input !== undefined) {
      child.stdin.on("error", err => {observe("stdin-error", {code: String(err.code ?? "UNKNOWN").slice(0, 32)}); error ??= err;});
      child.stdin.once("finish", () => observe("stdin-finish"));
      child.stdin.end(options.input);
    }
    child.stdout.on("data", chunk => {stdout += String(chunk);});
    child.stderr.on("data", chunk => {stderr += String(chunk);});
    const timer = setTimeout(() => {
      observe("timeout");
      error = new Error(`SPAWN_TIMEOUT:${options.timeout}`);
      child.kill();
    }, options.timeout);
    child.once("spawn", () => observe("spawn", {childPid: child.pid}));
    child.once("exit", (status, signal) => observe("exit", {status, signal}));
    child.once("error", err => {observe("error", {code: String(err.code ?? "UNKNOWN").slice(0, 32)}); clearTimeout(timer); finish({status: null, stdout, stderr, error: err});});
    child.once("close", (status, signal) => {observe("close", {status, signal}); clearTimeout(timer); finish({status, stdout, stderr, error});});
  });
}

// Reuse the existing coherent historical input with the current helper, never current source plus old gold.
async function prepareHistoricalSource(repo, temporary, observation = false) {
  const archiveBytes = await readFile(path.join(repo, "tests/skill-classification/live-bootstrap/history-r04/frozen-input.tar.gz"));
  assert.equal(createHash("sha256").update(archiveBytes).digest("hex"),
    "e8981a1534b06d8638c018b9cd360b563dd1d177ef04d03c5e345209af14260c", "history-r04 archive");
  prepareSourceScratch(repo, temporary);
  await cp(path.join(repo, "mcp-server/src"), path.join(temporary, "mcp-server/src"), {recursive: true});
  await mkdir(path.join(temporary, "tests/skill-classification"), {recursive: true});
  await cp(path.join(repo, "tests/skill-classification/evaluation.ts"), path.join(temporary, "tests/skill-classification/evaluation.ts"));
  // All historical inventory sources, membership, corpus and oracles come from
  // the verified 521aa Git snapshot; current source changes cannot rewrite it.
  const unpack = await runProcess("tar", ["-xzf", "-"], {cwd: temporary, input: archiveBytes, timeout: 30000, observation});
  assert.equal(unpack.error, undefined);
  assert.equal(unpack.status, 0, `history-r04 extract: ${unpack.stderr}`);
}

/** Default-purpose historical projection: current approved successor pins, pre-purpose roles and registry. */
async function prepareDefaultSourceFixture(repo, temporary) {
  prepareSourceScratch(repo, temporary);
  await cp(path.join(repo, "mcp-server/src"), path.join(temporary, "mcp-server/src"), {recursive: true});
  await cp(path.join(repo, "skills"), path.join(temporary, "skills"), {recursive: true});
  const {loadCurrentSourceBindings} = await import(new URL("../evaluation.ts", import.meta.url).href);
  const {PROVIDER_RETENTION_SOURCE_CHANGES} = await import(new URL("./provider-retention-sources.mts", import.meta.url).href);
  const bindings = loadCurrentSourceBindings(repo);
  for (const file of new Set([path.join(repo, "tests/skill-classification/evaluation.ts"),
    path.join(repo, "tests/skill-classification/fixtures.json"), ...bindings.files])) {
    const target = path.join(temporary, path.relative(repo, file));
    await mkdir(path.dirname(target), {recursive: true});
    await cp(file, target);
  }
  // Existing retirement provenance, not a replacement oracle: restore complete skill trees and their registry.
  const predecessor = "14549a2e83fd9143cf8184bd71979db23fd43172";
  // The restored registry fixes the skill membership too: a skill retired after the predecessor (4.0.0: ponytail)
  // comes back from the predecessor, and a skill added after it (4.0.0: minimal-implementation) is not part of it.
  const registryShow = await runProcess("git", ["show", `${predecessor}:skills/registry.json`], {cwd: repo, timeout: 30000});
  assert.equal(registryShow.error, undefined);
  assert.equal(registryShow.status, 0, `historical registry: ${registryShow.stderr}`);
  const historicalIds = new Set(JSON.parse(registryShow.stdout).skills.map(({skillId}) => skillId));
  const currentIds = (await readdir(path.join(temporary, "skills"), {withFileTypes: true})).filter(entry => entry.isDirectory()).map(entry => entry.name);
  for (const id of currentIds.filter(id => !historicalIds.has(id))) await rm(path.join(temporary, "skills", id), {recursive: true, force: true});
  const skillRoots = [...new Set([...PROVIDER_RETENTION_SOURCE_CHANGES.map(({path: file}) => file.split("/").slice(0, 2).join("/")),
    ...[...historicalIds].filter(id => !currentIds.includes(id)).map(id => `skills/${id}`)])];
  for (const skill of skillRoots) await rm(path.join(temporary, skill), {recursive: true, force: true});
  const archive = path.join(temporary, "pre-purpose-source.tar");
  const archived = await runProcess("git", ["archive", "--format=tar", `--output=${archive}`, predecessor, "--", ...skillRoots, "skills/registry.json"],
    {cwd: repo, timeout: 30000});
  assert.equal(archived.error, undefined);
  assert.equal(archived.status, 0, `historical role source: ${archived.stderr}`);
  const unpack = await runProcess("tar", ["-xf", archive], {cwd: temporary, timeout: 30000});
  assert.equal(unpack.error, undefined);
  assert.equal(unpack.status, 0, `historical role extract: ${unpack.stderr}`);
  await rm(archive);
  // All seven historical inputs remain bound to the original predecessors; do not use retention's replacement gold.
  for (const source of PROVIDER_RETENTION_SOURCE_CHANGES) {
    const bytes = await readFile(path.join(temporary, source.path));
    assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, source.previousDigest, source.path);
  }
}

/** Each caller owns one fresh default-purpose fixture; no cross-case source or authority cache is shared. */
export async function withHistoricalSource(repo, action) {
  const temporary = createSourceScratch(repo);
  try {
    await prepareDefaultSourceFixture(repo, temporary);
    return await action(temporary);
  } finally {removeSourceScratch(temporary);}
}

const entry = process.argv[1] && path.resolve(process.argv[1]);
if (["history-r04-boundary.mjs", "history-r04-budget.mjs"].some(name => entry === path.join(import.meta.dirname, name))) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const history = path.join(repo, "tests/skill-classification/live-bootstrap/history-r04");
  const budgetMode = process.argv.includes("--budget");
  const parentOwnsRoot = process.argv[4] !== undefined && process.argv[4] !== "--budget";
  const temporary = parentOwnsRoot ? path.resolve(process.argv[4]) : createSourceScratch(repo);
  try {
    await prepareHistoricalSource(repo, temporary, !budgetMode);
    const childTemp = path.join(temporary, "children");
    await mkdir(childTemp);
    const copied = path.join(temporary, "tests/skill-classification/live-bootstrap");
    if (budgetMode) {
      const original = await readFile(path.join(history, "budget-regression.mts"));
      assert.equal(createHash("sha256").update(original).digest("hex"), "e91a7828e2e22f116dbeea2763a2099e4a06327a77ea37e1fac9d4ccb0dd9d5d", "history-r04 budget test");
      await cp(path.join(history, "budget-regression.mts"), path.join(copied, "budget-regression.mts"));
    }
    const result = await runProcess(process.execPath, ["--import", "tsx", path.join(copied, budgetMode ? "budget-regression.mts" : "precision-regression.mts"), temporary,
      path.join(repo, "tests/skill-classification/live-bootstrap/bootstrap.mts")], {cwd: repo, timeout: budgetMode ? 90000 : 180000,
      env: {...process.env, TEMP: childTemp, TMP: childTemp, TMPDIR: childTemp}});
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, "R04_EXACT_BOUNDARY_CURRENT_HELPER_FAILED");
  } finally {
    if (!parentOwnsRoot) removeSourceScratch(temporary);
  }
}
