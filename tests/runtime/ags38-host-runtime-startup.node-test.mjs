import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(import.meta.dirname, "../..");
const marker = "AGS38_HOST_RUNTIME ";

// Test-only boundaries: never print SQL, arguments, input bytes, paths, or environment values.
const preload = `
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
const started = performance.now();
const cpu = process.cpuUsage();
let records = 0;
const observe = (stage, event, detail = {}) => {
  if (++records <= 96 || stage === 'lifetime') fs.writeSync(2, ${JSON.stringify(marker)} + JSON.stringify({stage, event, elapsedMs: Math.round(performance.now()-started), ...detail})+'\\n');
};
observe('preload', 'complete');
const read = fs.readFileSync;
fs.readFileSync = function(...args) {
  if (args[0] !== 0) return Reflect.apply(read, this, args);
  observe('stdin-sync', 'enter');
  try { const value = Reflect.apply(read, this, args); observe('stdin-sync', 'complete'); return value; }
  catch (error) { observe('stdin-sync', 'failed'); throw error; }
};
for (const name of ['exec', 'prepare', 'close']) {
  const original = DatabaseSync.prototype[name];
  DatabaseSync.prototype[name] = function(...args) {
    observe('sqlite-'+name, 'enter');
    try { const value = Reflect.apply(original, this, args); observe('sqlite-'+name, 'complete'); return value; }
    catch (error) { observe('sqlite-'+name, 'failed'); throw error; }
  };
}
const spawnSync = cp.spawnSync;
cp.spawnSync = function(...args) {
  observe('subprocess-sync', 'enter');
  const result = Reflect.apply(spawnSync, this, args);
  observe('subprocess-sync', 'complete', {status: result.status, signal: result.signal});
  return result;
};
syncBuiltinESMExports();
const iterator = process.stdin[Symbol.asyncIterator].bind(process.stdin);
process.stdin[Symbol.asyncIterator] = async function*() {
  observe('stdin-async', 'enter');
  let first = true;
  for await (const chunk of iterator()) {
    yield chunk;
    if (first) { first = false; observe('stdin-async', 'first-consumed'); }
  }
  observe('stdin-async', 'eof');
};
process.once('beforeExit', () => observe('lifetime', 'beforeExit', {cpu: process.cpuUsage(cpu)}));
process.once('exit', code => observe('lifetime', 'exit', {code, cpu: process.cpuUsage(cpu)}));
`;

function observation(caseId, stage, event, started, details = {}) {
  process.stderr.write(JSON.stringify({ observation: "ags38-host-runtime", caseId, stage, event,
    elapsedMs: Math.round(performance.now() - started), ...details }) + "\n");
}

async function probe(caseId, script, input, environment, splitAt) {
  const started = performance.now();
  observation(caseId, "child", "enter", started);
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script], {
    cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"], timeout: 10_000, windowsHide: true,
  });
  let stdout = "", stderr = "", inputError, launchError;
  const stages = [];
  let pending = "", firstConsumed;
  const first = new Promise(resolve => { firstConsumed = resolve; });
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => {
    stderr += chunk;
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop();
    for (const line of lines) {
      if (!line.startsWith(marker)) continue;
      const stage = JSON.parse(line.slice(marker.length));
      stages.push(stage);
      if (stage.stage === "stdin-async" && stage.event === "first-consumed") firstConsumed();
    }
  });
  child.stdin.on("error", error => { inputError = error; });
  child.on("error", error => { launchError = error; });
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  let assertionError;
  try {
    if (splitAt === undefined) child.stdin.end(input);
    else {
      child.stdin.write(input.subarray(0, splitAt));
      await Promise.race([first, closed]);
      assert.ok(stages.some(stage => stage.event === "first-consumed"), "first stdin chunk was not consumed");
      await delay(50);
      assert.equal(stdout, "", "profile must wait for EOF");
      child.stdin.end(input.subarray(splitAt));
    }
  } catch (error) {
    assertionError = error;
    child.kill();
  }
  const result = await closed;
  observation(caseId, "child", "complete", started, { ...result, launchError: launchError?.code ?? null,
    inputError: inputError?.code ?? null, stdoutBytes: Buffer.byteLength(stdout), stages });
  if (assertionError) throw assertionError;
  assert.equal(launchError, undefined);
  assert.equal(inputError, undefined);
  assert.equal(result.signal, null, stderr);
  assert.equal(result.code, 0, stderr);
  // Keep native runtime warnings and product diagnostics visible, separately from bounded boundary records.
  const diagnostics = stderr.split(/\r?\n/u).filter(line => line && !line.startsWith(marker));
  if (diagnostics.length) process.stderr.write(diagnostics.join("\n") + "\n");
  return { stdout, stages };
}

test("AGS38 Windows startup discriminators retain original 10s child deadlines", { timeout: 90_000 }, async t => {
  const started = performance.now();
  const cleanRoot = await mkdtemp(path.join(tmpdir(), "ags38-host-runtime-"));
  let primary;
  try {
    observation("HR-SETUP", "copy", "enter", started);
    await mkdir(path.join(cleanRoot, "mcp-server/dist"), { recursive: true });
    await Promise.all([
      ...["contracts", "runtime", "skills"].map(directory => cp(path.join(root, directory), path.join(cleanRoot, directory), { recursive: true })),
      ...["server.mjs", "continuity-hook.mjs"].map(file => cp(path.join(root, "mcp-server/dist", file), path.join(cleanRoot, "mcp-server/dist", file))),
    ]);
    observation("HR-SETUP", "copy", "complete", started);
    const environment = { ...process.env, SKILL_REGISTRY_PATH: path.join(cleanRoot, "skills/registry.json"),
      AGENT_GOVERNANCE_DB_PATH: path.join(cleanRoot, "state/workflow.sqlite3"),
      AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(cleanRoot, "state/continuity.sqlite3"),
      AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(cleanRoot, "state/trust.sqlite3"),
      AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(cleanRoot, "state/board.sqlite3"),
      AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(cleanRoot, "state/shared"),
      AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(cleanRoot, "state/messaging"),
    };
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "AGENT_GOVERNANCE_ROOT", "AGENT_GOVERNANCE_CLASSIFICATION_CONFIG", "AGENT_GOVERNANCE_HOST_ATTESTATION"]) delete environment[name];
    await t.test("HR14 SessionStart stdin/storage/exit", async () => {
      const result = await probe("HR14", path.join(cleanRoot, "mcp-server/dist/continuity-hook.mjs"),
        JSON.stringify({ hook_event_name: "SessionStart", session_id: "ags38-clean-room", source: "startup" }) + "\n", environment);
      assert.equal(result.stdout, "");
      assert.ok(result.stages.some(stage => stage.stage === "stdin-sync" && stage.event === "complete"));
      assert.ok(result.stages.some(stage => stage.stage === "lifetime" && stage.event === "exit"));
    });
    for (const distribution of ["skills", "claude-plugin/skills"]) {
      await t.test(`HR16 ${distribution} UTF-8/EOF/Git/exit`, async () => {
        const text = "리¢😀";
        const input = Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", workspaceRoot: path.join(root, "tests/workspace-convention-profiler/fixtures/python"),
          taskObjective: text, targetPaths: ["src"], resolvedInstructionRefs: [], knownConstraints: [],
          evidenceLimits: { maxFiles: 100, maxBytesPerFile: 100000, excludedPatterns: [] } }));
        const ascii = input.toString("utf8").replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
        const reference = await probe("HR16-ASCII", path.join(root, distribution, "workspace-convention-profiler/scripts/profile-workspace.mjs"), ascii, environment);
        const result = await probe("HR16", path.join(root, distribution, "workspace-convention-profiler/scripts/profile-workspace.mjs"),
          input, environment, input.indexOf(Buffer.from(text)) + 1);
        assert.equal(JSON.parse(result.stdout).verdict, "PASS");
        assert.equal(JSON.parse(result.stdout).profileFingerprint, JSON.parse(reference.stdout).profileFingerprint,
          "split UTF-8 must preserve the same profile as ASCII escapes");
        assert.ok(result.stages.some(stage => stage.stage === "stdin-async" && stage.event === "eof"));
        assert.ok(result.stages.some(stage => stage.stage === "subprocess-sync" && stage.event === "complete"));
      });
    }
    await t.test("HR27 bundled initialize/tools-list/exit", async () => {
      const messages = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ags38-startup", version: "1" } } },
        { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ];
      const result = await probe("HR27", path.join(cleanRoot, "mcp-server/dist/server.mjs"), messages.map(message => JSON.stringify(message)).join("\n") + "\n", environment);
      const replies = result.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line));
      assert.equal(replies.find(reply => reply.id === 1)?.result?.protocolVersion, "2025-03-26");
      assert.ok(replies.find(reply => reply.id === 2)?.result?.tools.some(tool => tool.name === "plan_workflow"));
    });
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    observation("HR-CLEANUP", "cleanup", "enter", started);
    try {
      assert.equal(path.dirname(cleanRoot), path.resolve(tmpdir()));
      assert.ok(path.basename(cleanRoot).startsWith("ags38-host-runtime-"));
      await rm(cleanRoot, { recursive: true, force: true });
      observation("HR-CLEANUP", "cleanup", "complete", started);
    } catch (error) {
      if (primary) throw new AggregateError([primary, error], "Startup discriminator and cleanup failed", { cause: primary });
      throw error;
    }
  }
});
