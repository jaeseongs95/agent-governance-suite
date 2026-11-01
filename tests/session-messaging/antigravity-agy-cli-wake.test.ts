import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock, presentPaths } = vi.hoisted(() => ({ execFileMock: vi.fn(), presentPaths: new Set<string>() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: execFileMock,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: (candidate: string) => presentPaths.has(String(candidate)) || actual.existsSync(candidate) };
});

import { resolveGeminiAgentApi } from "../../mcp-server/src/wake-transport-antigravity.js";
import { transportWakePort } from "../../mcp-server/src/wake-transports.js";

// agy CLI 1.4.12, observed on the Linux and Windows test hosts (2026-11-01):
// - Linux ships ~/.gemini/antigravity-cli/bin/agentapi = `exec "<home>/.local/bin/agy" agentapi "$@"`;
//   Windows ships no agentapi shim, only %LOCALAPPDATA%\agy\bin\agy.exe, and `agy.exe agentapi --help` works.
// - Without a language-server connection agentapi exits 1 with JSON on stdout (bodies below are verbatim).
const AGY_LS_ADDRESS_UNSET = '{\n  "error": "ANTIGRAVITY_LS_ADDRESS is not set"\n}\n';
const AGY_CSRF_MISSING = '{\n  "response": {},\n  "error": "rpc error: code = Unauthenticated desc = unauthenticated: missing CSRF token"\n}\n';
const AGY_LS_UNAVAILABLE = '{\n  "response": {},\n  "error": "rpc error: code = Unavailable desc = connection error: desc = \\"error reading server preface: EOF\\""\n}\n';

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
const target = { host: "antigravity", sessionId: "agy-conversation" };
const dispatch = () => transportWakePort("antigravity-queue").dispatch(target, "wake-body");
const exitOne = () => Object.assign(new Error("Command failed"), { code: 1 });

function metadataReply(error: Error | null, stdout: string): void {
  execFileMock.mockImplementationOnce((_command: string, _args: string[], _options: unknown, callback: Callback) => {
    queueMicrotask(() => callback(error, stdout, ""));
    return new EventEmitter();
  });
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try { return await run(); } finally { spy.mockRestore(); }
}

beforeEach(() => {
  execFileMock.mockReset();
  presentPaths.clear();
});
afterEach(() => vi.unstubAllEnvs());

describe("agy CLI agentapi location", () => {
  it("finds the agy CLI shim on POSIX after the IDE shim and before PATH", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ags-agy-cli-"));
    try {
      expect(resolveGeminiAgentApi({ HOME: home }, "linux")).toEqual({ command: "agentapi", argsPrefix: [] });
      const cliShim = path.join(home, ".gemini", "antigravity-cli", "bin", "agentapi");
      mkdirSync(path.dirname(cliShim), { recursive: true });
      writeFileSync(cliShim, "#!/bin/sh\nexec agy agentapi \"$@\"\n");
      expect(resolveGeminiAgentApi({ HOME: home }, "linux")).toEqual({ command: cliShim, argsPrefix: [] });
      const ideShim = path.join(home, ".gemini", "antigravity", "bin", "agentapi");
      mkdirSync(path.dirname(ideShim), { recursive: true });
      writeFileSync(ideShim, "#!/bin/sh\n");
      expect(resolveGeminiAgentApi({ HOME: home }, "linux")).toEqual({ command: ideShim, argsPrefix: [] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("uses the installer-default agy.exe natively on Windows when no agentapi.bat exists", () => {
    const localAppData = "C:\\Users\\fixture\\AppData\\Local";
    const agyExe = "C:\\Users\\fixture\\AppData\\Local\\agy\\bin\\agy.exe";
    const environment = { USERPROFILE: "C:\\Users\\fixture-missing-home", LOCALAPPDATA: localAppData };
    expect(resolveGeminiAgentApi(environment, "win32")).toBeNull();
    presentPaths.add(agyExe);
    expect(resolveGeminiAgentApi(environment, "win32")).toEqual({ command: agyExe, argsPrefix: ["agentapi"] });
    // A same-named file in a temp directory is never launched.
    presentPaths.add("C:\\Users\\fixture\\AppData\\Local\\Temp\\agy\\bin\\agy.exe");
    expect(resolveGeminiAgentApi({ ...environment, LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local\\Temp" }, "win32")).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("agy CLI agentapi without a language-server connection", () => {
  beforeEach(() => {
    vi.stubEnv("ANTIGRAVITY_AGENTAPI_EXE", "/home/fixture/.local/bin/agy");
    vi.stubEnv("ANTIGRAVITY_PROJECT_ID", "default-cli-project");
  });

  it.each([
    ["exit 1, LS address unset", exitOne(), AGY_LS_ADDRESS_UNSET],
    ["exit 1, CSRF token missing", exitOne(), AGY_CSRF_MISSING],
    ["exit 0, LS address unset", null, AGY_LS_ADDRESS_UNSET],
  ])("reports a missing prerequisite and never sends (%s)", async (_label, error, stdout) => {
    metadataReply(error, stdout);
    expect(await quietly(dispatch)).toEqual({ result: "not-delivered", kind: "prerequisite-missing", reasonCode: "GEMINI_LS_CONNECTION_MISSING" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]!.slice(0, 2)).toEqual(["/home/fixture/.local/bin/agy", ["agentapi", "get-conversation-metadata", "agy-conversation"]]);
  });

  it("keeps an unreachable language server a recoverable lookup failure", async () => {
    metadataReply(exitOne(), AGY_LS_UNAVAILABLE);
    expect(await quietly(dispatch)).toEqual({ result: "not-delivered", kind: "transient", reasonCode: "GEMINI_METADATA_FAILED" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
