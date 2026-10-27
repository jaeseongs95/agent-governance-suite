import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runContinuityHook as runNativeContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { adaptHostInput, isGovernanceHookTool, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";

// Owned fake core observation only; this adapter is not native role evidence.
const syntheticHost = "synthetic-continuity-failure";
registerHookHostAdapter(syntheticHost, {
  processPid: () => undefined,
  deliveryProfile: () => ({ transport: "claude-inbox", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false }),
  ownsTool: name => isGovernanceHookTool("codex", name),
  adaptInput: (payload, host) => {
    const mapped = adaptHostInput(payload, "codex");
    return { ...mapped, observation: { ...mapped.observation, host,
      actor: { role: "root", basis: "observed", reasonCode: "SYNTHETIC_CONTINUITY_ROOT" } } };
  },
});

const runContinuityHook = (raw: string, env: NodeJS.ProcessEnv) => runNativeContinuityHook(raw, env, syntheticHost);

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function environment() {
  const directory = await mkdtemp(join(tmpdir(), "continuity-hook-failure-"));
  directories.push(directory);
  return {
    directory,
    env: {
      AGENT_GOVERNANCE_DB_PATH: join(directory, "workflows.sqlite3"),
      AGENT_GOVERNANCE_CONTINUITY_DB_PATH: join(directory, "continuity.sqlite3"),
    } as NodeJS.ProcessEnv,
  };
}

function toolInput() {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "private-session-marker",
    tool_name: "mcp__agent-governance-suite__inspect_context",
    tool_input: { schemaVersion: "1.0.0", marker: "private-input-marker" },
  });
}

function failureLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((args: unknown[]) => args[0])
    .filter((value: unknown): value is string => typeof value === "string" && value.includes("continuity-hook-failure "));
}

describe("continuity hook failure reporting (AGS-D-0055)", () => {
  it("fails open but reports the original store failure reason and SQLite cause", async () => {
    const { directory, env } = await environment();
    await writeFile(join(directory, "continuity.sqlite3"), "not a sqlite database\n".repeat(200), "utf8");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runContinuityHook(toolInput(), env)).toBe("");
    const lines = failureLines(spy);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    const value = JSON.parse(line.slice(line.indexOf("{")));
    expect(value).toMatchObject({ phase: "storage", reason: "CORRUPT_DATABASE" });
    expect([11, 26]).toContain(value.storeCause?.sqlite?.primaryCode);
    for (const marker of ["private-session-marker", "private-input-marker", directory]) expect(line).not.toContain(marker);
  });

  it("does not issue a binding for an unsupported native Gemini actor", async () => {
    const { env } = await environment();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runNativeContinuityHook(toolInput(), env, "gemini")).toBe("");
    expect(failureLines(spy)).toHaveLength(0);
  });

  it("reports invalid hook JSON as an input failure", async () => {
    const { env } = await environment();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runContinuityHook("{not-json", env)).toBe("");
    const lines = failureLines(spy);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!.slice(lines[0]!.indexOf("{")))).toMatchObject({ phase: "input", reason: "INVALID_JSON" });
  });

  it("issues a binding without diagnostics for an explicit synthetic root when the store is healthy", async () => {
    const { env } = await environment();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const output = runContinuityHook(toolInput(), env);
    expect(JSON.parse(output)).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse",
      updatedInput: { _continuityBinding: expect.any(String) } } });
    expect(JSON.parse(output).hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(failureLines(spy)).toHaveLength(0);
  });
});
