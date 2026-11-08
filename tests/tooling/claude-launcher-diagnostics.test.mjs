import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Installs one overlay launcher next to an optional fake shared bundle and the shared diagnostics runtime, as installed. */
async function install(launcher, bundle, { runtime = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-launcher-"));
  directories.push(directory);
  await mkdir(path.join(directory, "hooks"));
  await mkdir(path.join(directory, "mcp-server", "dist"), { recursive: true });
  if (runtime) {
    await mkdir(path.join(directory, "runtime"));
    for (const file of ["diagnostic-record.mjs", "failure-diagnostics.mjs"]) {
      await writeFile(path.join(directory, "runtime", file), await readFile(path.join(root, "runtime", file)));
    }
  }
  await writeFile(path.join(directory, "hooks", launcher), await readFile(path.join(root, "claude-overlay", "hooks", launcher)));
  if (bundle !== null) await writeFile(path.join(directory, "mcp-server", "dist", launcher), bundle);
  return directory;
}

function run(directory, launcher, env = process.env) {
  return spawnSync(process.execPath, [path.join(directory, "hooks", launcher)], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "PRIVATE_SESSION" }), encoding: "utf8", env, windowsHide: true,
  });
}

/** Launcher records in the one common format (AGS3-D-0023); no product line may use the retired prefix form. */
function diagnostics(stderr) {
  expect(stderr).not.toContain("[agent-governance-suite]");
  return stderr.split(/\r?\n/u).flatMap((line) => {
    try { const record = JSON.parse(line); return record && typeof record === "object" && !Array.isArray(record) ? [record] : []; }
    catch { return []; }
  }).filter((record) => record.event === "launcher-failure").map(({ component, ...rest }) => {
    delete rest.event;
    expect(typeof component).toBe("string");
    return { launcher: component, ...rest };
  });
}

describe("Claude launcher stage diagnostics", () => {
  // Both launchers preserve public exit 0; stage diagnostics distinguish failures from empty successes.
  for (const [launcher, exportName, returns] of [
    ["session-message-hook.mjs", "runSessionMessageHookOutcome", (value) => `({ ok: true, output: ${value} })`],
    ["session-board-hook.mjs", "runSessionBoardHook", (value) => value],
  ]) {
    const name = launcher.replace(/\.mjs$/u, "");

    it(`${name}: reports a missing bundle as the import stage and stays fail-open`, async () => {
      const directory = await install(launcher, null);
      const result = run(directory, launcher);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(diagnostics(result.stderr)).toEqual([{ launcher: name, stage: "import", code: "ERR_MODULE_NOT_FOUND" }]);
      expect(result.stderr).not.toContain(directory);
    });

    it(`${name}: reports a renamed export as the export stage`, async () => {
      const directory = await install(launcher, `export async function ${exportName}Renamed() { return "never"; }\n`);
      const result = run(directory, launcher);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(diagnostics(result.stderr)).toEqual([{ launcher: name, stage: "export", code: "LAUNCHER_EXPORT_MISSING" }]);
    });

    it(`${name}: reports a rejected run with its original code but no message or input`, async () => {
      const directory = await install(launcher, `export async function ${exportName}() { throw Object.assign(new Error("PRIVATE_RUN_MESSAGE"), { code: "EACCES" }); }\n`);
      const result = run(directory, launcher);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(diagnostics(result.stderr)).toEqual([{ launcher: name, stage: "run", code: "EACCES" }]);
      expect(result.stderr).not.toContain("PRIVATE_");
    });

    it(`${name}: passes the bundle output through without diagnostics`, async () => {
      const directory = await install(launcher, `export async function ${exportName}(host, raw) { return ${returns("JSON.stringify({ host, length: raw.length })")}; }\n`);
      const result = run(directory, launcher);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ host: "claude-code" });
      expect(diagnostics(result.stderr)).toEqual([]);
    });
  }

  // Fake bundles export both entries like the real bundle, so the launcher's choice of entry is what is tested.
  const messageBundle = (outcome, diagnostic) => [
    'export async function runSessionMessageHook() { return ""; }',
    `export async function runSessionMessageHookOutcome() { ${diagnostic ? `console.error(${JSON.stringify(JSON.stringify(diagnostic))});` : ""} return ${outcome}; }`,
    "",
  ].join("\n");

  it("session-message-hook: a failed bundle outcome retains exit 0 and its bounded diagnostic", async () => {
    const failure = { phase: "handle", reason: "BROKER_DEADLINE_EXPIRED", reasonBasis: "producer", producerReason: "BROKER_DEADLINE_EXPIRED",
      component: "session-message-hook", event: "peer-hook-failure" };
    const directory = await install("session-message-hook.mjs", messageBundle(
      `{ ok: false, output: "", failure: ${JSON.stringify(failure)} }`, failure));
    const result = run(directory, "session-message-hook.mjs");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    // The bundle owns the phase/reason diagnostic; the launcher adds no duplicate stage failure.
    expect(result.stderr.trim()).toBe(JSON.stringify(failure));
    expect(diagnostics(result.stderr)).toEqual([]);
  });

  it("session-message-hook: an empty successful outcome exits 0 without diagnostics", async () => {
    const directory = await install("session-message-hook.mjs", messageBundle('{ ok: true, output: "" }'));
    const result = run(directory, "session-message-hook.mjs");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(diagnostics(result.stderr)).toEqual([]);
  });

  it("session-message-hook: 비동기 시작이 자식 종료까지 실제 relay 조상으로 남는다", async () => {
    // 무해한 자식으로 실행기 소유권과 OS 계보를 검사한다. CLI·중개기·수신 소켓은 실행하지 않는다.
    const directory = await install("session-message-hook.mjs", `
      import { spawn } from "node:child_process";
      import { once } from "node:events";
      export async function runSessionMessageHookOutcome(host, raw, pid, options) {
        const child = spawn(process.execPath, ["-e", "process.send({pid:process.pid,ppid:process.ppid});process.on('disconnect',()=>process.exit(0));setInterval(()=>{},1000)"],
          { detached: false, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
        options.relayOwner(child);
        const [identity] = await once(child, "message");
        return { ok: true, output: JSON.stringify(identity) + "\\n" };
      }
    `);
    const launcher = spawn(process.execPath, [path.join(directory, "hooks", "session-message-hook.mjs"), "--own-relay"],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const closed = once(launcher, "close");
    const lines = createInterface({ input: launcher.stdout });
    const ready = once(lines, "line", { signal: globalThis.AbortSignal.timeout(5000) });
    launcher.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: "owned-relay-fixture" }));
    let relayPid;
    try {
      const [line] = await ready;
      const identity = JSON.parse(line);
      relayPid = identity.pid;
      expect(identity.ppid).toBe(launcher.pid);
      expect(launcher.exitCode).toBeNull();
      expect(process.kill(launcher.pid, 0)).toBe(true);
      process.kill(relayPid, "SIGTERM");
      const [status] = await closed;
      expect(status).toBe(0);
      expect(() => process.kill(relayPid, 0)).toThrow();
    } finally {
      lines.close();
      // 실패 정리는 보관한 실행기 핸들로만 한다. 자식은 IPC 단절 때 종료하므로 PID를 재사용해 죽이지 않는다.
      if (launcher.exitCode === null) launcher.kill("SIGKILL");
      await closed;
    }
  });

  it("session-message-hook: reports an invalid bundle outcome as the outcome stage", async () => {
    const directory = await install("session-message-hook.mjs", messageBundle('{ ok: "yes" }'));
    const result = run(directory, "session-message-hook.mjs");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(diagnostics(result.stderr)).toEqual([{ launcher: "session-message-hook", stage: "outcome", code: "LAUNCHER_OUTCOME_INVALID" }]);
  });

  it("continuity-hook: stays quiet without plugin data and never loads the bundle", async () => {
    const directory = await install("continuity-hook.mjs", 'throw Object.assign(new Error("loaded"), { code: "BUNDLE_LOADED" });\n');
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_DATA;
    const absent = run(directory, "continuity-hook.mjs", env);
    expect(absent.status).toBe(0);
    expect(absent.stdout).toBe("");
    expect(diagnostics(absent.stderr)).toEqual([]);
  });

  it("DG07 every Claude launcher keeps the common record when the shared diagnostics runtime is missing", async () => {
    const launchers = (await readdir(path.join(root, "claude-overlay", "hooks"))).filter((file) => file.endsWith(".mjs"));
    expect(launchers.length).toBeGreaterThan(5);
    for (const launcher of launchers) {
      const directory = await install(launcher, null, { runtime: false });
      // A plugin data path that is a file and unparsable input make every launcher fail at its first own stage.
      await writeFile(path.join(directory, "data-file"), "fixture");
      const result = spawnSync(process.execPath, [path.join(directory, "hooks", launcher)], {
        input: "{", encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(directory, "data-file") }, windowsHide: true,
      });
      const lines = result.stderr.split(/\r?\n/u).filter(Boolean);
      expect(lines.length, launcher).toBe(1);
      expect(JSON.parse(lines[0]), launcher).toMatchObject({ component: launcher.replace(/\.mjs$/u, ""), event: "launcher-failure",
        stage: expect.any(String), reason: "DIAGNOSTIC_RUNTIME_UNAVAILABLE" });
    }
  });

});

// AGS3-D-0079: the continuity and attestation launchers ran their bundle in a second node process, which doubled each
// hook's start-up cost. They now call the bundle's export in their own process, with the plugin databases and the host.
describe("Claude launchers run the shared bundle in their own process", () => {
  for (const [launcher, exportName, databases, output] of [
    ["continuity-hook.mjs", "runContinuityHook",
      { AGENT_GOVERNANCE_DB_PATH: "workflows.sqlite3", AGENT_GOVERNANCE_CONTINUITY_DB_PATH: "continuity.sqlite3" },
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "D0079-CONTEXT" } })],
    ["host-attestation-hook.mjs", "runHostAttestationHook", { AGENT_GOVERNANCE_DB_PATH: "workflows.sqlite3" }, ""],
  ]) {
    const name = launcher.replace(/\.mjs$/u, "");
    const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "d0079-session", model: "d0079-model" });
    const launch = (directory) => spawnSync(process.execPath, [path.join(directory, "hooks", launcher)], {
      input, encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(directory, "data") }, windowsHide: true,
    });

    it(`${name}: calls ${exportName} in the launcher process with the plugin databases and host`, async () => {
      const directory = await install(launcher, "");
      const seen = path.join(directory, "seen.json");
      await writeFile(path.join(directory, "mcp-server", "dist", launcher), [
        'import { writeFileSync } from "node:fs";',
        `export function ${exportName}(raw, environment, host) {`,
        `  writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ pid: process.pid, host, raw,`,
        `    databases: Object.fromEntries(${JSON.stringify(Object.keys(databases))}.map((key) => [key, environment[key]])) }));`,
        `  return ${JSON.stringify(output)};`,
        "}",
        "",
      ].join("\n"));
      const result = launch(directory);
      expect(result.status).toBe(0);
      expect(existsSync(seen), "the bundle export was not called").toBe(true);
      expect(JSON.parse(await readFile(seen, "utf8"))).toEqual({ pid: result.pid, host: "claude-code", raw: input,
        databases: Object.fromEntries(Object.entries(databases).map(([key, file]) => [key, path.join(directory, "data", file)])) });
      expect(result.stdout).toBe(output);
      expect(diagnostics(result.stderr)).toEqual([]);
    });

    for (const [stage, bundle, code] of [
      ["import", null, "ERR_MODULE_NOT_FOUND"],
      ["export", `export function ${exportName}Renamed() { return ""; }\n`, "LAUNCHER_EXPORT_MISSING"],
      ["run", `export function ${exportName}() { throw Object.assign(new Error("PRIVATE_RUN_MESSAGE"), { code: "EACCES" }); }\n`, "EACCES"],
    ]) {
      it(`${name}: reports a failed ${stage} stage with its code, prints nothing and exits 0`, async () => {
        const directory = await install(launcher, bundle);
        const result = launch(directory);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(diagnostics(result.stderr)).toEqual([{ launcher: name, stage, code }]);
        expect(result.stderr).not.toContain("PRIVATE_");
        expect(result.stderr).not.toContain(directory);
      });
    }
  }

  it("continuity-hook: reports an output that is not text as the outcome stage", async () => {
    const directory = await install("continuity-hook.mjs", "export function runContinuityHook() { return { ok: true }; }\n");
    const result = spawnSync(process.execPath, [path.join(directory, "hooks", "continuity-hook.mjs")], {
      input: "{}", encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(directory, "data") }, windowsHide: true,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(diagnostics(result.stderr)).toEqual([{ launcher: "continuity-hook", stage: "outcome", code: "LAUNCHER_OUTCOME_INVALID" }]);
  });
});

describe("attestation launcher diagnostic proposal (parent-owned shared test)", () => {
  const launcher = "host-attestation-hook.mjs";
  const raw = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "PRIVATE_SESSION",
    tool_input: { taskId: "fixture-task", _hostAttestation: "PRIVATE_FORGED_TOKEN" } });
  const invoke = (directory, dataDirectory) => {
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_DATA;
    if (dataDirectory !== undefined) env.CLAUDE_PLUGIN_DATA = dataDirectory;
    return spawnSync(process.execPath, [path.join(directory, "hooks", launcher)], {
      input: raw, encoding: "utf8", env, windowsHide: true,
    });
  };

  // The server refuses caller-supplied identity fields; the launcher never rewrites tool input, even on failure.
  it("keeps missing plugin data quiet, leaves the tool input alone, and exits 0", async () => {
    const directory = await install(launcher, null);
    const result = invoke(directory);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(diagnostics(result.stderr)).toEqual([]);
  });

  it("reports data-directory failure without path or input and prints nothing", async () => {
    const directory = await install(launcher, null);
    const data = path.join(directory, "data-file");
    await writeFile(data, "fixture");
    const result = invoke(directory, data);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(diagnostics(result.stderr)).toEqual([{ launcher: "host-attestation-hook", stage: "data-directory", code: "EEXIST" }]);
    expect(result.stderr).not.toContain(directory);
    expect(result.stderr).not.toContain("PRIVATE_");
  });

  // The in-process stages (import, export, run) are covered in "Claude launchers run the shared bundle in their own process".
  it("reports a failed shared hook without rewriting the tool input and exits 0", async () => {
    const directory = await install(launcher, "export function runHostAttestationHook() { throw Object.assign(new Error(\"PRIVATE_X\"), { code: \"EIO\" }); }\n");
    const result = invoke(directory, path.join(directory, "data"));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(diagnostics(result.stderr)).toEqual([{ launcher: "host-attestation-hook", stage: "run", code: "EIO" }]);
    expect(result.stderr).not.toContain("PRIVATE_");
    expect(result.stderr).not.toContain(directory);
  });
});
