import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ execFile: vi.fn(), present: new Set<string>() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFile: f.execFile }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, existsSync: (file: string) => f.present.has(file) || fs.existsSync(file) };
});
import { codexQueueWakePort } from "../../mcp-server/src/wake-transport-codex.js";

// An npm install on Windows puts only codex.cmd on PATH; execFile("codex") cannot start it (ENOENT, and a .cmd needs
// cmd.exe, CVE-2024-27980), so every Windows idle wake ended not-delivered.
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const target = { host: "codex", sessionId: "01a19746-754a-7120-84da-937020a95835" };
// Shell metacharacters must reach Codex unchanged: nothing on this path may reparse them.
const message = "[wake \"a\" & echo b | c ^ %PATH% !x!]";
let root: string;

function windows(packageRoot?: string) {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  if (packageRoot !== undefined) vi.stubEnv("CODEX_MANAGED_PACKAGE_ROOT", packageRoot);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ags-codex-launch-"));
  f.execFile.mockReset();
  f.present.clear();
  f.execFile.mockImplementation((_command: string, _args: string[], _options: unknown, done: (error: Error | null, stdout: string, stderr: string) => void) => {
    queueMicrotask(() => done(null, "", ""));
    return { once: vi.fn() };
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Codex queue wake launch on Windows", () => {
  it("runs the npm launcher of the running Codex with this node, without a shell, and passes the arguments verbatim", async () => {
    const launcher = path.join(root, "bin", "codex.js");
    fs.mkdirSync(path.dirname(launcher));
    fs.writeFileSync(launcher, "");
    windows(root);
    await expect(codexQueueWakePort.dispatch(target, message)).resolves.toEqual({ result: "handed-off" });
    expect(f.execFile).toHaveBeenCalledTimes(1);
    const [command, args, options] = f.execFile.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([launcher, "queue", "--thread", target.sessionId, "--message", message]);
    expect(options.shell).toBeUndefined();
  });

  it("reports a missing launcher as its own prerequisite without starting anything", async () => {
    windows(root);
    await expect(codexQueueWakePort.dispatch(target, message)).resolves
      .toEqual({ result: "not-delivered", kind: "prerequisite-missing", reasonCode: "CODEX_NPM_LAUNCHER_MISSING" });
    // A relative root is refused even when its launcher exists from the current directory.
    f.present.add(path.join("relative-root", "bin", "codex.js"));
    windows("relative-root");
    await expect(codexQueueWakePort.dispatch(target, message)).resolves.toMatchObject({ reasonCode: "CODEX_NPM_LAUNCHER_MISSING" });
    expect(f.execFile).not.toHaveBeenCalled();
  });

  it("keeps `codex` from PATH without the npm launcher variable and on other platforms", async () => {
    windows("");
    await codexQueueWakePort.dispatch(target, message);
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    vi.stubEnv("CODEX_MANAGED_PACKAGE_ROOT", root);
    await codexQueueWakePort.dispatch(target, message);
    expect(f.execFile.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ["codex", ["queue", "--thread", target.sessionId, "--message", message]],
      ["codex", ["queue", "--thread", target.sessionId, "--message", message]],
    ]);
  });
});
