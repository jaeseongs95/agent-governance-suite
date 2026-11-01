import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { claudeAdmissionIngress } from "../../mcp-server/src/builtin-caller-ingress.js";
import { runGovernanceHook } from "../../mcp-server/src/governance-hook.js";
import { hostActorId } from "../../mcp-server/src/host-attestation.js";
import { isGovernanceHookTool, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";

const TOOL = "mcp__agent_governance_suite__plan_workflow";
const hook = {
  hook_event_name: "PreToolUse", session_id: "al05-session", turn_id: "al05-turn",
  tool_use_id: "toolu_al05_call", transcript_path: "synthetic-only.jsonl", effort: { level: "high" },
  tool_name: TOOL,
  tool_input: { taskId: "al05-approval-neutral-task", _hostAttestation: "caller-forged-token", _hostSkillObservation: { caller: true } },
};
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
function database(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-al05-neutral-"));
  directories.push(directory);
  return path.join(directory, "workflows.sqlite3");
}
const bundle = (name: string) => fileURLToPath(new URL(`../../mcp-server/dist/${name}`, import.meta.url));
function packaged(name: string, input: unknown, databasePath: string) {
  return spawnSync(process.execPath, [bundle(name), "--host=claude-code"], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 10_000,
    env: { ...process.env, NODE_NO_WARNINGS: "1", AGENT_GOVERNANCE_DB_PATH: databasePath }, windowsHide: true,
  });
}

describe("AGS-D-0020 the governance hook records the call without deciding approval", () => {
  it("prints nothing, leaves the caller's arguments to the server, and records only host-observed facts", async () => {
    const databasePath = database();
    expect(await runGovernanceHook("claude-code", JSON.stringify(hook), { ...process.env, AGENT_GOVERNANCE_DB_PATH: databasePath }))
      .toEqual({ ok: true, output: "" });
    const store = new SqliteWorkflowStore(databasePath);
    try {
      const admitted = claudeAdmissionIngress(store)("plan_workflow", { "claudecode/toolUseId": hook.tool_use_id });
      expect(admitted).toMatchObject({ provenance: "host-observed", caller: { sessionId: hook.session_id, callId: hook.tool_use_id,
        actor: { id: hostActorId("claude-code", hook.session_id), role: "root" } } });
      // Caller arguments are never copied into the admission: the server validates them itself.
      expect(JSON.stringify(admitted)).not.toContain("caller-forged-token");
    } finally { store.close(); }
  });

  it("keeps the packaged governance and execution-observation hooks silent for an AGS tool call", () => {
    const databasePath = database();
    for (const name of ["governance-hook.mjs", "host-attestation-hook.mjs"]) {
      const result = packaged(name, hook, databasePath);
      expect(result.error, name).toBeUndefined();
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
      expect(result.stdout, name).toBe("");
    }
  });

  it("fails closed with a deny, never an allow, when the admission cannot be stored", () => {
    const databasePath = database();
    mkdirSync(databasePath); // A directory where the SQLite file belongs: opening the store fails.
    const result = packaged("governance-hook.mjs", hook, databasePath);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    const output = JSON.parse(result.stdout) as { hookSpecificOutput: Record<string, unknown> };
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(output.hookSpecificOutput).not.toHaveProperty("updatedInput");
    expect(result.stdout).not.toContain("caller-forged-token");
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
  ])("leaves foreign or nested namespace %s untouched without recording an admission", async (toolName) => {
    expect(isGovernanceHookTool("claude-code", toolName)).toBe(false);
    const databasePath = database();
    expect(await runGovernanceHook("claude-code", JSON.stringify({ ...hook, tool_name: toolName }), { ...process.env, AGENT_GOVERNANCE_DB_PATH: databasePath }))
      .toEqual({ ok: true, output: "" });
    const store = new SqliteWorkflowStore(databasePath);
    try { expect(store.claimCallAdmission("claude-code", hook.tool_use_id)).toBeNull(); } finally { store.close(); }
  });

  it("uses an explicit opaque host adapter's ownership rather than a common namespace regex", () => {
    expect(isGovernanceHookTool(ownedHost, ownedTool)).toBe(true);
    expect(ownsTool).toHaveBeenCalledWith(ownedTool);
    expect(isGovernanceHookTool(ownedHost, TOOL)).toBe(false);
  });
});
