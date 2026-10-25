import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleCodexHostAttestationHook, handleRegisteredHostAttestationHook } from "../../mcp-server/src/host-attestation-hook.js";
import { HOST_ATTESTATION_FIELD, HostAttestationProvider, type HostExecutionAdapter } from "../../mcp-server/src/host-attestation.js";
import { isGovernanceHookTool, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

const model = "al05-approval-neutral-model";
const adapter: HostExecutionAdapter = {
  host: "al05-approval-neutral-model-policy",
  modelClassForModel: (value) => value === model ? "deep" : null,
};
const clean = { taskId: "al05-approval-neutral-task" };
const hook = {
  hook_event_name: "PreToolUse", session_id: "al05-session", turn_id: "al05-turn",
  tool_use_id: "al05-call", model, transcript_path: "synthetic-only.jsonl",
  tool_name: "mcp__agent_governance_suite__plan_workflow",
  tool_input: { ...clean, [HOST_ATTESTATION_FIELD]: "caller-forged-token", _hostSkillObservation: { caller: true } },
};
const metadata = () => ({
  head: JSON.stringify({ type: "session_meta", payload: { id: hook.session_id, source: "vscode" } }),
  tail: JSON.stringify({ type: "turn_context", payload: { turn_id: hook.turn_id, model, effort: "high" } }),
});
const ownedHost = "al05-explicit-tool-owner";
const ownedTool = "mcp__al05_owned_boundary__plan_workflow";
const ownsTool = vi.fn((name: string) => name === ownedTool);
registerHookHostAdapter(ownedHost, {
  ownsTool,
  deliveryProfile: () => { throw new Error("Unused delivery capability in attestation fixture."); },
  processPid: () => undefined,
});
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("AGS-D-0020 attestation updates arguments without deciding approval", () => {
  it("issues a verifiable observation, replaces caller claims, and leaves permissionDecision absent", () => {
    const store = new InMemoryWorkflowStore();
    const output = handleCodexHostAttestationHook(hook, store, { adapter, readMetadata: metadata });
    const update = output.hookSpecificOutput as { updatedInput: Record<string, unknown>; permissionDecision?: string };
    expect(update).not.toHaveProperty("permissionDecision");
    expect(update.updatedInput).toEqual({ ...clean, [HOST_ATTESTATION_FIELD]: expect.any(String) });
    expect(update.updatedInput[HOST_ATTESTATION_FIELD]).not.toBe("caller-forged-token");
    const provider = new HostAttestationProvider(store, adapter);
    const observed = provider.run("plan_workflow", update.updatedInput, () => provider.observe({
      phase: "bootstrap", taskId: clean.taskId, runId: null, stageId: null, revision: null,
    }));
    expect(observed).toMatchObject({ model, modelClass: "deep", reasoningEffort: "high" });
    expect(output).not.toHaveProperty("systemMessage");
  });

  it("retains the unavailable diagnostic and removes claims without granting approval or creating a key", () => {
    const store = new InMemoryWorkflowStore();
    const key = vi.spyOn(store, "getOrCreateSecret");
    const output = handleCodexHostAttestationHook(hook, store, { adapter, readMetadata: () => null });
    expect(output).toEqual({ systemMessage: expect.stringContaining("host-metadata-unreadable"),
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: clean } });
    expect(key).not.toHaveBeenCalled();
  });

  it("keeps an unregistered strategy neutral, strips claims, and opens no store", () => {
    const openStore = vi.fn(() => new InMemoryWorkflowStore());
    expect(handleRegisteredHostAttestationHook("al05-no-such-strategy", { ...hook, tool_name: ownedTool },
      { host: ownedHost, databasePath: "unused.sqlite3", openStore }))
      .toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: clean } });
    expect(openStore).not.toHaveBeenCalled();
  });

  it("keeps the packaged storage-failure callback diagnostic and claim stripping neutral", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ags-al05-neutral-storage-"));
    directories.push(directory);
    const bundle = fileURLToPath(new URL("../../mcp-server/dist/host-attestation-hook.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [bundle, "--host=codex"], {
      input: JSON.stringify(hook), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, NODE_NO_WARNINGS: "1", AGENT_GOVERNANCE_DB_PATH: directory }, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toEqual({ systemMessage: expect.stringContaining("AGS execution observation unavailable: storage:"),
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: clean } });
    const diagnostics = result.stderr.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    expect(diagnostics).toContainEqual(expect.objectContaining({ component: "host-attestation-hook", phase: "storage" }));
  });
});

describe("AGS-D-0021 explicit host tool ownership", () => {
  it.each([
    "mcp__another_server__plan_workflow",
    "mcp__agent_governance_suite_shadow__plan_workflow",
    "mcp__agent_governance_suite__foreign__plan_workflow",
    "mcp__agent-governance-suite__foreign__plan_workflow",
    "mcp__plugin_agent-governance-suite_agent-governance-suite__foreign__plan_workflow",
    "plan_workflow",
  ])("leaves foreign or nested namespace %s untouched without observation or signing", (toolName) => {
    expect(isGovernanceHookTool("codex", toolName)).toBe(false);
    const readMetadata = vi.fn(metadata);
    const store = new InMemoryWorkflowStore();
    const key = vi.spyOn(store, "getOrCreateSecret");
    expect(handleCodexHostAttestationHook({ ...hook, tool_name: toolName, host: ownedHost }, store,
      { adapter, readMetadata })).toEqual({});
    expect(readMetadata).not.toHaveBeenCalled();
    expect(key).not.toHaveBeenCalled();
  });

  it("uses an explicit opaque host adapter's ownership rather than a common namespace regex", () => {
    const output = handleCodexHostAttestationHook({ ...hook, tool_name: ownedTool }, new InMemoryWorkflowStore(),
      { host: ownedHost, adapter, readMetadata: metadata });
    expect(ownsTool).toHaveBeenCalledWith(ownedTool);
    expect(output).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse",
      updatedInput: { ...clean, [HOST_ATTESTATION_FIELD]: expect.any(String) } } });
    const readMetadata = vi.fn(metadata);
    expect(handleCodexHostAttestationHook(hook, new InMemoryWorkflowStore(),
      { host: ownedHost, adapter, readMetadata })).toEqual({});
    expect(readMetadata).not.toHaveBeenCalled();
  });
});
