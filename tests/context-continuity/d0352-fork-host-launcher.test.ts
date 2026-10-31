import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, constants, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// D0352 N1z on the real hook chain (review 902e 7e745764, tester c613 k2argv1-r01): the shipped Claude launcher
// (claude-plugin/hooks/continuity-hook.mjs) runs the bundled hook under the same node, so the bundled hook must pass
// that launcher and read the host process above it. The host here is a copy of node named like the CLI package's
// native binary, outside shared temporary directories; it starts the launcher through sh as Claude Code does.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const launcher = join(root, "claude-plugin", "hooks", "continuity-hook.mjs");
const work = join(root, "node_modules", ".cache", `ags-d0352-launcher-${randomUUID()}`);

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.runIf(process.platform === "linux")("D0352 fork host argv through the shipped Claude launcher (Linux)", () => {
  it("records the parent named by the host process argv, as (c, e) of that parent's task", () => {
    const data = join(work, "data");
    const host = join(work, "pkg", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    mkdirSync(dirname(host), { recursive: true });
    mkdirSync(data, { recursive: true });
    copyFileSync(process.execPath, host, constants.COPYFILE_FICLONE);
    chmodSync(host, 0o755);
    const script = join(work, "host.mjs");
    writeFileSync(script, [
      'import { spawnSync } from "node:child_process";',
      'const run = spawnSync("/bin/sh", ["-c", \'"$D0352_NODE" "$D0352_LAUNCHER"\'], { input: process.env.D0352_INPUT, encoding: "utf8" });',
      "process.stdout.write(JSON.stringify({ status: run.status, stderr: run.stderr }));",
      "",
    ].join("\n"), "utf8");
    const parent = randomUUID();
    const child = randomUUID();
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, D0352_NODE: process.execPath, D0352_LAUNCHER: launcher };

    const started = spawnSync(process.execPath, [launcher], { encoding: "utf8", env, timeout: 30_000,
      input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: parent, cwd: work }) });
    expect(started.status, started.stderr).toBe(0);
    const forked = spawnSync(host, [script, "--resume", parent, "--fork-session"], { encoding: "utf8", timeout: 30_000,
      env: { ...env, D0352_INPUT: JSON.stringify({ hook_event_name: "SessionStart", source: "fork", session_id: child, cwd: work }) } });
    expect(forked.status, forked.stderr).toBe(0);
    expect(JSON.parse(forked.stdout), forked.stdout).toMatchObject({ status: 0 });

    const database = new DatabaseSync(join(data, "continuity.sqlite3"), { readOnly: true });
    try {
      const records = database.prepare("SELECT task_correlation, event FROM continuity_observations WHERE event LIKE 'fork-host-parent:%'").all() as Array<{ task_correlation: string; event: string }>;
      expect(records).toHaveLength(1);
      const tasks = database.prepare("SELECT task_correlation, current_epoch FROM continuity_tasks").all() as Array<{ task_correlation: string; current_epoch: number }>;
      const named = tasks.find(task => task.task_correlation !== records[0]!.task_correlation);
      expect(tasks).toHaveLength(2);
      expect(JSON.parse(records[0]!.event.slice("fork-host-parent:".length))).toEqual({ c: named!.task_correlation, e: named!.current_epoch });
    } finally {
      database.close();
    }
  }, 90_000);
});
