import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../mcp-server/src/builtin-hook-host-adapters.js";
import {hookFailureReason} from "../../mcp-server/src/hook-error-diagnostics.js";
import * as hostInput from "../../mcp-server/src/host-input-adapter.js";
import { handleSessionMessageHook, sessionMessageTransport } from "../../mcp-server/src/session-message-hook.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function settingsFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-queue-default-")); directories.push(directory);
  return { directory, file: path.join(directory, "session-messaging.json") };
}

describe("L5 queue default origin and precedence", () => {
  it("uses automatic defaults only after explicit bounded file settings or absence", async () => {
    const f = await settingsFixture(); const diagnose = vi.fn();
    const environment = { PLUGIN_DATA: f.directory, ANTIGRAVITY_AGENT: "1" };
    expect(hostInput.hostDeliveryProfile("gemini", {}, diagnose).transport).toBe("codex-deferred");
    expect(hostInput.hostDeliveryProfile("gemini", {}, diagnose, true).transport).toBe("gemini-queue");
    expect(hostInput.hostDeliveryProfile("gemini", environment, diagnose).transport).toBe("gemini-queue");
    for (const queueWake of [false, true]) {
      await writeFile(f.file, JSON.stringify({ schemaVersion: "1.0.0", gemini: { queueWake } }), "utf8");
      for (const signal of [false, true]) {
        expect(hostInput.hostDeliveryProfile("gemini", { PLUGIN_DATA: f.directory }, diagnose, signal).transport)
          .toBe(queueWake ? "gemini-queue" : "codex-deferred");
        expect(hostInput.hostDeliveryProfile("gemini", environment, diagnose, signal).transport)
          .toBe(queueWake ? "gemini-queue" : "codex-deferred");
      }
    }
    expect(diagnose).not.toHaveBeenCalled();
    expect(environment).toEqual({ PLUGIN_DATA: f.directory, ANTIGRAVITY_AGENT: "1" });
  });

  it("keeps explicit zero, one and invalid overrides ahead of file and automatic defaults", async () => {
    const f = await settingsFixture(); const diagnose = vi.fn();
    for (const content of [JSON.stringify({ schemaVersion: "1.0.0", gemini: { queueWake: false } }), "private-malformed-marker"]) {
      await writeFile(f.file, content, "utf8");
      for (const signal of [false, true]) {
        for (const [explicit, transport] of [["0", "codex-deferred"], ["1", "gemini-queue"], ["invalid", "codex-deferred"]]) {
          diagnose.mockClear();
          expect(hostInput.hostDeliveryProfile("gemini", { PLUGIN_DATA: f.directory, ANTIGRAVITY_AGENT: "1",
            AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE: explicit }, diagnose, signal).transport).toBe(transport);
          if (explicit === "invalid") expect(diagnose).toHaveBeenCalledExactlyOnceWith("invalid-environment");
          else expect(diagnose).not.toHaveBeenCalled();
        }
      }
    }
  });

  it("never falls through malformed settings, read errors or invalid paths to an automatic true", async () => {
    const f = await settingsFixture(); const diagnose = vi.fn();
    const environment = { PLUGIN_DATA: f.directory, ANTIGRAVITY_CONVERSATION_ID: "synthetic" };
    for (const content of ["private-malformed-marker", "null", JSON.stringify({ schemaVersion: "1.0.0", gemini: { queueWake: "false" } })]) {
      diagnose.mockClear(); await writeFile(f.file, content, "utf8");
      expect(hostInput.hostDeliveryProfile("gemini", environment, diagnose, true).transport).toBe("codex-deferred");
      expect(diagnose).toHaveBeenCalledExactlyOnceWith("invalid-settings");
    }
    diagnose.mockClear();
    expect(hostInput.hostDeliveryProfile("gemini", { ...environment, PLUGIN_DATA: "relative" }, diagnose, true).transport).toBe("codex-deferred");
    expect(diagnose).toHaveBeenCalledExactlyOnceWith("invalid-plugin-data");
    diagnose.mockClear();
    expect(hostInput.hostDeliveryProfile("gemini", { ...environment, PLUGIN_DATA: f.directory + "\0" }, diagnose, true).transport).toBe("codex-deferred");
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(diagnose.mock.calls[0]![0]).toBe("read-failed");
    expect(diagnose.mock.calls[0]![1]).toMatchObject({phase: "directory-stat", cleanup: "not-acquired"});
    expect(hookFailureReason(diagnose.mock.calls[0]![1].failure)).toBe("QUEUE_SETTINGS_DIRECTORY_STAT_FAILED");
    await rm(f.file); await mkdir(f.file); diagnose.mockClear();
    expect(hostInput.hostDeliveryProfile("gemini", environment, diagnose, true).transport).toBe("codex-deferred");
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(["read-failed", "invalid-file-type"]).toContain(diagnose.mock.calls[0]![0]);
  });

  it("does not make another host inherit the Gemini adapter default", () => {
    expect(hostInput.hostDeliveryProfile("codex", {}, vi.fn(), true).transport).toBe("codex-deferred");
    expect(hostInput.hostDeliveryProfile("claude-code", {}, vi.fn(), true).transport).toBe("claude-inbox");
    expect(() => hostInput.hostDeliveryProfile("unregistered-L5-host", {}, vi.fn(), true)).toThrow();
  });

  it("passes the call-local default through the real hook to the shared reader without ENV mutation or broker I/O", async () => {
    const f = await settingsFixture();
    vi.stubEnv("PLUGIN_DATA", f.directory);
    for (const key of ["AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE", "ANTIGRAVITY_AGENT", "ANTIGRAVITY_CONVERSATION_ID", "ANTIGRAVITY_AGENTAPI_EXE"])
      vi.stubEnv(key, undefined);
    await writeFile(f.file, JSON.stringify({ schemaVersion: "1.0.0", gemini: { queueWake: false } }), "utf8");
    const actual = hostInput.hostDeliveryProfile;
    const observed: Array<{ supplied: boolean | undefined; transport: string }> = [];
    vi.spyOn(hostInput, "hostDeliveryProfile").mockImplementation((host, environment, diagnose, supplied) => {
      const profile = actual(host, environment, diagnose, supplied); observed.push({ supplied, transport: profile.transport }); return profile;
    });
    // A non-AGS tool boundary computes its profile but returns before any broker request.
    expect(await handleSessionMessageHook({ hook_event_name: "PreToolUse", session_id: "synthetic-L5-hook", agent_id: "",
      tool_name: "read_file", tool_input: {} }, "gemini", undefined, { defaultQueueWake: true })).toEqual({});
    await rm(f.file);
    const input = { hook_event_name: "PreToolUse", session_id: "synthetic-L5-hook", agent_id: "", tool_name: "read_file", tool_input: {} };
    expect(await handleSessionMessageHook(input, "gemini", undefined, { defaultQueueWake: true })).toEqual({});
    expect(await handleSessionMessageHook(input, "gemini")).toEqual({});
    expect(observed).toEqual([{ supplied: true, transport: "codex-deferred" },
      { supplied: true, transport: "gemini-queue" }, { supplied: undefined, transport: "codex-deferred" }]);
    expect(process.env.AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE).toBeUndefined();
  });

  it("threads runner-owned defaults into the same-process adapter callback while import leaves ENV unchanged", async () => {
    const before = process.env.AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE;
    // Nonliteral import keeps this cross-runner JS fixture independent of TypeScript declaration generation.
    const runner = await import(new URL("../../antigravity-connector/hooks/antigravity-hook-runner.mjs", import.meta.url).href);
    expect(process.env.AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE).toBe(before);
    const f = await settingsFixture();
    await writeFile(f.file, JSON.stringify({ schemaVersion: "1.0.0", gemini: { queueWake: false } }), "utf8");
    const seen: Array<{ host: string; supplied: boolean; transport: string }> = [];
    for (const event of ["SessionStart", "PreInvocation", "PostInvocation", "Stop"]) {
      await runner.executeAntigravityHookEvent({ conversationId: "synthetic-L5-runner", agent_id: "" }, event, "session-message", {
        now: () => 100, entryMonotonicMs: 100,
        resolveHostProcess: () => ({ pid: 1234, startToken: "synthetic-generation" }),
        sessionMessageHook: async (_input: unknown, host: string, _pid: unknown, options: { defaultQueueWake: boolean }) => {
          const transport = hostInput.hostDeliveryProfile(host, { PLUGIN_DATA: f.directory }, vi.fn(), options.defaultQueueWake).transport;
          seen.push({ host, supplied: options.defaultQueueWake, transport }); return {};
        },
      });
    }
    expect(seen).toEqual(Array.from({ length: 4 }, () => ({ host: "antigravity", supplied: true, transport: "codex-deferred" })));
    expect(process.env.AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE).toBe(before);
  });
});


it("reports a host-neutral settings diagnostic without inventing an adapter fallback transport", () => {
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const transport = hostInput.hostDeliveryProfile("gemini", { AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE: "invalid" }, undefined, true).transport;
  expect(transport).toBe("codex-deferred");
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith("[agent-governance-suite] gemini queue settings: invalid-environment.");
  expect(diagnostic.mock.calls[0]![0]).not.toContain("using codex");
});

it("queries transport under the same call-local default contract as the hook", async () => {
  const f = await settingsFixture(); const environment = { PLUGIN_DATA: f.directory };
  expect(sessionMessageTransport("gemini", environment)).toBe("codex-deferred");
  expect(sessionMessageTransport("gemini", environment, true)).toBe("gemini-queue");
  expect(sessionMessageTransport("gemini", environment)).toBe("codex-deferred");
  await writeFile(f.file, JSON.stringify({ schemaVersion: "1.0.0", gemini: { queueWake: false } }), "utf8");
  expect(sessionMessageTransport("gemini", environment, true)).toBe("codex-deferred");
  expect(sessionMessageTransport("codex", {}, true)).toBe("codex-deferred");
  expect(sessionMessageTransport("claude-code", {}, true)).toBe("claude-inbox");
});
