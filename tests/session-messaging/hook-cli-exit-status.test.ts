import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type * as Diagnostics from "../../mcp-server/src/hook-error-diagnostics.js";
import type * as Fs from "node:fs";

// Drives the production CLI entry block of the source module (the code the bundled hook CLI runs), with only stdin
// and the broker request replaced by fixtures.
const f = vi.hoisted(() => ({ request: vi.fn(), stdin: "" as string | Error }));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof Fs>();
  const readFileSync = (file: unknown, ...rest: unknown[]): unknown => {
    if (file !== 0) return (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
    if (f.stdin instanceof Error) throw f.stdin;
    return f.stdin;
  };
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

const entry = fileURLToPath(new URL("../../mcp-server/src/session-message-hook.ts", import.meta.url));
const stop = JSON.stringify({ hook_event_name: "Stop", session_id: "cli-target", agent_id: "" });
const bindable = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "cli-target", agent_id: "",
  tool_name: "mcp__agent_governance_suite__prepare_session_message", tool_input: { schemaVersion: "1.0.0", marker: "cli-secret-marker" } });

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let written: string[] = [];
let stdoutError: Error | null = null;

beforeEach(() => {
  f.request.mockReset();
  f.request.mockResolvedValue({ messages: [] });
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
  vi.stubEnv("AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE", "0");
  written = [];
  stdoutError = null;
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, callback?: unknown) => {
    written.push(String(chunk));
    if (typeof callback === "function") (callback as (error?: Error | null) => void)(stdoutError);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function runCli(raw: string | Error, args: readonly string[] = ["--host=claude-code"],
  prepare?: (diagnostics: typeof Diagnostics) => void): Promise<void> {
  f.stdin = raw;
  process.argv = [originalArgv[0]!, entry, ...args];
  vi.resetModules();
  // Producer failures must come from the same module instance the freshly evaluated hook uses.
  prepare?.(await import("../../mcp-server/src/hook-error-diagnostics.js"));
  await import("../../mcp-server/src/session-message-hook.js");
}

function failures(): Array<Record<string, unknown>> {
  return vi.mocked(console.error).mock.calls.map((call) => String(call[0]))
    .filter((line) => line.includes("peer-hook-failure "))
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>);
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

it("keeps the broker failure diagnostic distinct while retaining fail-open exit 0", async () => {
  await runCli(stop, ["--host=claude-code"], ({ hookFailure }) => {
    f.request.mockRejectedValueOnce(hookFailure("BROKER_DEADLINE_EXPIRED", "The session message request deadline expired."));
  });
  await vi.waitFor(() => expect(failures()).toHaveLength(1));
  expect(process.exitCode).toBeUndefined();
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(written).toEqual([]);
  expect(failures()).toEqual([expect.objectContaining({ phase: "handle", reason: "BROKER_DEADLINE_EXPIRED" })]);
});

it("leaves the exit status unset for a successful claim with no message", async () => {
  await runCli(stop);
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));
  await settled();
  expect(process.exitCode).toBeUndefined();
  expect(written).toEqual([]);
  expect(failures()).toEqual([]);
});

it.each([
  ["input", "{", ["--host=claude-code"], "INVALID_JSON"],
  ["stdin", Object.assign(new Error("private-stdin-message"), { code: "EIO" }), ["--host=claude-code"], "EIO"],
  ["host-entry", stop, ["--host=../private-host-marker"], "INVALID_HOOK_HOST_SELECTION"],
] as const)("retains the failed %s stage diagnostic and fail-open exit 0", async (phase, raw, args, reason) => {
  await runCli(raw, args);
  await vi.waitFor(() => expect(failures()).toHaveLength(1));
  expect(process.exitCode).toBeUndefined();
  expect(written).toEqual([]);
  expect(failures()).toEqual([expect.objectContaining({ phase, reason })]);
  expect(f.request).not.toHaveBeenCalled();
  const lines = vi.mocked(console.error).mock.calls.map((call) => String(call[0])).join("\n");
  expect(lines).not.toContain("private-stdin-message");
  expect(lines).not.toContain("private-host-marker");
});

it("writes a successful hook output once and leaves the exit status unset", async () => {
  await runCli(bindable);
  await vi.waitFor(() => expect(written).toHaveLength(1));
  await settled();
  const output = JSON.parse(written[0]!);
  expect(output).toMatchObject({ hookSpecificOutput: {
    updatedInput: { _sessionBinding: { host: "claude-code", sessionId: "cli-target" } } } });
  expect(output.hookSpecificOutput).not.toHaveProperty("permissionDecision");
  expect(process.exitCode).toBeUndefined();
  expect(failures()).toEqual([]);
});

it("retains the stdout failure diagnostic and fail-open exit 0", async () => {
  stdoutError = Object.assign(new Error("private-stdout-message"), { code: "EPIPE" });
  await runCli(bindable);
  await vi.waitFor(() => expect(failures()).toHaveLength(1));
  expect(process.exitCode).toBeUndefined();
  expect(failures()).toEqual([expect.objectContaining({ phase: "stdout", reason: "EPIPE" })]);
  const lines = vi.mocked(console.error).mock.calls.map((call) => String(call[0])).join("\n");
  expect(lines).not.toContain("private-stdout-message");
  expect(lines).not.toContain("cli-secret-marker");
});
