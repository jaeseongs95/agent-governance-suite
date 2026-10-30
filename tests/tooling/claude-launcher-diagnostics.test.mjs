import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const directories = [];
const PREFIX = "[agent-governance-suite] launcher-failure ";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Installs one overlay launcher next to an optional fake shared bundle, as in the installed tree. */
async function install(launcher, bundle) {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-launcher-"));
  directories.push(directory);
  await mkdir(path.join(directory, "hooks"));
  await mkdir(path.join(directory, "mcp-server", "dist"), { recursive: true });
  await writeFile(path.join(directory, "hooks", launcher), await readFile(path.join(root, "claude-overlay", "hooks", launcher)));
  if (bundle !== null) await writeFile(path.join(directory, "mcp-server", "dist", launcher), bundle);
  return directory;
}

function run(directory, launcher, env = process.env) {
  return spawnSync(process.execPath, [path.join(directory, "hooks", launcher)], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "PRIVATE_SESSION" }), encoding: "utf8", env, windowsHide: true,
  });
}

function diagnostics(stderr) {
  return stderr.split(/\r?\n/u).filter((line) => line.startsWith(PREFIX)).map((line) => JSON.parse(line.slice(PREFIX.length)));
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
    `export async function runSessionMessageHookOutcome() { ${diagnostic ? `console.error("[agent-governance-suite] peer-hook-failure " + ${JSON.stringify(JSON.stringify(diagnostic))});` : ""} return ${outcome}; }`,
    "",
  ].join("\n");

  it("session-message-hook: a failed bundle outcome retains exit 0 and its bounded diagnostic", async () => {
    const failure = { phase: "handle", reason: "BROKER_DEADLINE_EXPIRED", reasonBasis: "producer", producerReason: "BROKER_DEADLINE_EXPIRED" };
    const directory = await install("session-message-hook.mjs", messageBundle(
      `{ ok: false, output: "", failure: ${JSON.stringify(failure)} }`, failure));
    const result = run(directory, "session-message-hook.mjs");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    // The bundle owns the phase/reason diagnostic; the launcher adds no duplicate stage failure.
    expect(result.stderr.trim()).toBe("[agent-governance-suite] peer-hook-failure " + JSON.stringify(failure));
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

  it("continuity-hook: reports a failing shared hook exit and stays quiet without plugin data", async () => {
    const directory = await install("continuity-hook.mjs", "process.exit(3);\n");
    const data = path.join(directory, "data");
    const failed = run(directory, "continuity-hook.mjs", { ...process.env, CLAUDE_PLUGIN_DATA: data });
    expect(failed.status).toBe(0);
    expect(failed.stdout).toBe("");
    expect(diagnostics(failed.stderr)).toEqual([{ launcher: "continuity-hook", stage: "hook-exit", status: 3 }]);
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_DATA;
    const absent = run(directory, "continuity-hook.mjs", env);
    expect(absent.status).toBe(0);
    expect(diagnostics(absent.stderr)).toEqual([]);
  });

  it("continuity-hook: a successful shared hook emits no diagnostic", async () => {
    const directory = await install("continuity-hook.mjs", "process.exit(0);\n");
    const result = run(directory, "continuity-hook.mjs", { ...process.env, CLAUDE_PLUGIN_DATA: path.join(directory, "data") });
    expect(result.status).toBe(0);
    expect(diagnostics(result.stderr)).toEqual([]);
  });
});

describe("attestation launcher diagnostic proposal (parent-owned shared test)", () => {
  const launcher = "host-attestation-hook.mjs";
  const raw = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "PRIVATE_SESSION",
    tool_input: { taskId: "fixture-task", _hostAttestation: "PRIVATE_FORGED_TOKEN" } });
  const fallback = { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { taskId: "fixture-task" } } };
  const invoke = (directory, dataDirectory) => {
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_DATA;
    if (dataDirectory !== undefined) env.CLAUDE_PLUGIN_DATA = dataDirectory;
    return spawnSync(process.execPath, [path.join(directory, "hooks", launcher)], {
      input: raw, encoding: "utf8", env, windowsHide: true,
    });
  };

  it("keeps missing plugin data quiet, strips caller token, and exits 0", async () => {
    const directory = await install(launcher, null);
    const result = invoke(directory);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(fallback);
    expect(diagnostics(result.stderr)).toEqual([]);
  });

  it("reports data-directory failure without path or input and retains stripped fail-open output", async () => {
    const directory = await install(launcher, null);
    const data = path.join(directory, "data-file");
    await writeFile(data, "fixture");
    const result = invoke(directory, data);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(fallback);
    expect(diagnostics(result.stderr)).toEqual([{ launcher: "host-attestation-hook", stage: "data-directory", code: "EEXIST" }]);
    expect(result.stderr).not.toContain(directory);
    expect(result.stderr).not.toContain("PRIVATE_");
  });

  for (const [label, bundle, status] of [["missing shared bundle", null, 1], ["failed shared hook", "process.exit(3);\n", 3]]) {
    it(`reports ${label} status while stripping the token and exiting 0`, async () => {
      const directory = await install(launcher, bundle);
      const result = invoke(directory, path.join(directory, "data"));
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(fallback);
      expect(diagnostics(result.stderr)).toEqual([{ launcher: "host-attestation-hook", stage: "hook-exit", status }]);
      expect(JSON.stringify(diagnostics(result.stderr))).not.toContain("PRIVATE_");
      expect(JSON.stringify(diagnostics(result.stderr))).not.toContain(directory);
    });
  }

  it("passes successful hook output through without a launcher diagnostic", async () => {
    const output = { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { fixture: true } } };
    const directory = await install(launcher, `process.stdout.write(${JSON.stringify(JSON.stringify(output))});\n`);
    const result = invoke(directory, path.join(directory, "data"));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(output);
    expect(diagnostics(result.stderr)).toEqual([]);
  });
});
