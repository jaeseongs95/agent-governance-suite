import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  for (const [launcher, exportName] of [["session-message-hook.mjs", "runSessionMessageHook"], ["session-board-hook.mjs", "runSessionBoardHook"]]) {
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
      const directory = await install(launcher, `export async function ${exportName}(host, raw) { return JSON.stringify({ host, length: raw.length }); }\n`);
      const result = run(directory, launcher);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ host: "claude-code" });
      expect(diagnostics(result.stderr)).toEqual([]);
    });
  }

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
