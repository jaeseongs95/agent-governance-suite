import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as boardStore from "../../skills/session-board/scripts/board-store.mjs";
import { runGovernanceHook } from "../../mcp-server/src/governance-hook.js";
import { runContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import * as diagnostics from "../../mcp-server/src/hook-error-diagnostics.js";
import { SessionActorProofs } from "../../mcp-server/src/session-actor-proof.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";

// Engineering test plan: F1 = built CLI single owner/stdout + real persisted HMAC;
// F2 = real SQLite resources with handle/close failpoints at the public hook boundary;
// F3 = real wrapper child with a synthetic environment-capture bundle, not native evidence.
// Intended run after build: pnpm exec vitest run tests/mcp/governance-hook-entry.test.ts
// Proposal only: no execution or red/green evidence has been produced by its author.
const repository = fileURLToPath(new URL("../../", import.meta.url));
const scratchDirectories: string[] = [];
const namespace = "mcp__plugin_agent-governance-suite_agent-governance-suite__";

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-governance-entry-"));
  expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
  scratchDirectories.push(directory);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflows.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"),
    AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(directory, "board.sqlite3"),
    AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"),
    AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(directory, "messages"),
    AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(directory, "shared"),
    AGENT_GOVERNANCE_CODEX_QUEUE_WAKE: "0",
    AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE: "0",
    CLAUDE_PLUGIN_DATA: path.join(directory, "claude-data"),
    PLUGIN_DATA: path.join(directory, "plugin-data"),
  };
  return { directory, environment };
}

function isolateAmbient(environment: NodeJS.ProcessEnv) {
  for (const [key, value] of Object.entries(environment)) {
    if (key.startsWith("AGENT_GOVERNANCE_") || key === "CLAUDE_PLUGIN_DATA" || key === "PLUGIN_DATA") {
      vi.stubEnv(key, value);
    }
  }
}

function input(tool = "get_trust_capabilities", args: Record<string, unknown> = {}) {
  return {
    hook_event_name: "PreToolUse", session_id: "synthetic-entry-root", tool_use_id: "synthetic-entry-call",
    tool_name: `${namespace}${tool}`, tool_input: args,
  };
}

function denied(outcome: { ok: boolean; output: string }) {
  expect(outcome.ok).toBe(false);
  const output = JSON.parse(outcome.output);
  expect(output).toEqual({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "GOVERNANCE_HOOK_FAILED",
  } });
  expect(outcome.output).not.toContain("_sessionProof");
}

function captureDiagnostics() {
  const reported: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(diagnostics, "writeFailureDiagnostic").mockImplementation(serialized => { reported.push(JSON.parse(serialized)); });
  return reported;
}

function closedWorkflows(failure?: Error) {
  const closed: SqliteWorkflowStore[] = [];
  const original = SqliteWorkflowStore.prototype.close;
  vi.spyOn(SqliteWorkflowStore.prototype, "close").mockImplementation(function (this: SqliteWorkflowStore) {
    original.call(this); // Close the real handle before injecting the cleanup failure.
    closed.push(this);
    if (failure) throw failure;
  });
  return closed;
}

function assertWorkflowClosed(stores: SqliteWorkflowStore[], expected = 1) {
  expect(stores).toHaveLength(expected);
  for (const store of stores) expect(() => store.getOrCreateSecret("closed-probe", () => "unused")).toThrow();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of scratchDirectories.splice(0)) {
    expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("governance hook entry regressions (synthetic Node 24 fixtures)", () => {
  it("F1: the built Claude CLI emits exactly one JSON object and a verifiable persisted root proof", () => {
    const { environment } = fixture();
    const payload = input();
    const child = spawnSync(process.execPath, [path.join(repository, "mcp-server/dist/governance-hook.mjs"), "--host=claude-code"], {
      input: JSON.stringify(payload), env: environment, cwd: repository, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim().split(/\r?\n/u)).toHaveLength(1);
    // Parsing all stdout rejects concatenated JSON from imported domain-hook CLI guards.
    const output = JSON.parse(child.stdout);
    expect(Object.keys(output)).toEqual(["hookSpecificOutput"]);
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    const args = output.hookSpecificOutput.updatedInput as Record<string, unknown>;
    expect(typeof args._sessionProof).toBe("string");
    expect(args).not.toHaveProperty("_sessionBinding");
    expect(existsSync(environment.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH!)).toBe(false);
    expect(existsSync(environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH!)).toBe(false);
    expect(existsSync(environment.AGENT_GOVERNANCE_TRUST_DB_PATH!)).toBe(false);
    expect(existsSync(environment.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR!)).toBe(false);

    const store = new SqliteWorkflowStore(environment.AGENT_GOVERNANCE_DB_PATH!);
    try {
      const verifier = new SessionActorProofs(store);
      const [prefix, body, signature] = (args._sessionProof as string).split(".");
      const changed = `${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
      expect(() => verifier.verify("get_trust_capabilities", { ...args, _sessionProof: `${prefix}.${body}.${changed}` }))
        .toThrow(expect.objectContaining({ code: "BINDING_INVALID", details: { reasonCode: "ROOT_PROOF_SIGNATURE_INVALID" } }));
      expect(verifier.verify("get_trust_capabilities", args)).toEqual({
        host: "claude-code", sessionId: payload.session_id,
        actor: { role: "root", basis: "inferred", reasonCode: "CLAUDE_NATIVE_ROOT_AGENT_ID_ABSENT" },
      });
    } finally { store.close(); }
  });

  it("F1: the built Codex CLI emits one capture-required denial and opens no domain state", () => {
    const { environment } = fixture();
    const child = spawnSync(process.execPath, [path.join(repository, "mcp-server/dist/governance-hook.mjs"), "--host=codex"], {
      input: JSON.stringify({ ...input(), tool_name: "mcp__agent_governance_suite__get_trust_capabilities" }),
      env: environment, cwd: repository, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim().split(/\r?\n/u)).toHaveLength(1);
    expect(JSON.parse(child.stdout)).toEqual({ hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "CODEX_NATIVE_CAPTURE_REQUIRED",
    } });
    expect(child.stdout).not.toContain("_sessionProof");
    for (const key of ["AGENT_GOVERNANCE_DB_PATH", "AGENT_GOVERNANCE_CONTINUITY_DB_PATH", "AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH",
      "AGENT_GOVERNANCE_TRUST_DB_PATH", "AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", "AGENT_GOVERNANCE_SHARED_STATE_DIR"]) {
      expect(existsSync(environment[key]!)).toBe(false);
    }
  });

  it.each([[], ["--host"], ["--host=claude-code", "--host=codex"]])("requires an explicit unambiguous CLI host: %j", (...args) => {
    const { environment } = fixture();
    const child = spawnSync(process.execPath, [path.join(repository, "mcp-server/dist/governance-hook.mjs"), ...args], {
      input: JSON.stringify(input()), env: environment, cwd: repository, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(2);
    expect(child.stdout).toBe("");
    expect(existsSync(environment.AGENT_GOVERNANCE_DB_PATH!)).toBe(false);
  });

  it.each(["close", "handle-and-close"] as const)("F2: board %s failure prevents central proof issuance after actually closing both stores", async mode => {
    const { environment } = fixture();
    isolateAmbient(environment);
    const reported = captureDiagnostics();
    const handleFailure = diagnostics.hookFailure("ENTRY_BOARD_HANDLE_FAILED", "synthetic board handle failure");
    const closeFailure = diagnostics.hookFailure("ENTRY_BOARD_CLOSE_FAILED", "synthetic board cleanup failure");
    const workflows = closedWorkflows();
    const boards: DatabaseSync[] = [];
    const originalOpen = boardStore.openBoard;
    vi.spyOn(boardStore, "openBoard").mockImplementation((...args: Parameters<typeof boardStore.openBoard>) => {
      const board = originalOpen(...args);
      boards.push(board);
      const originalClose = board.close.bind(board);
      vi.spyOn(board, "close").mockImplementation(() => { originalClose(); throw closeFailure; });
      return board;
    });
    if (mode === "handle-and-close") vi.spyOn(boardStore, "setSummary").mockImplementation(() => { throw handleFailure; });

    denied(await runGovernanceHook("claude-code", JSON.stringify(input("update_session_status", { summary: "synthetic entry status" })), environment));
    expect(boards).toHaveLength(1);
    expect(boards[0]!.isOpen).toBe(false);
    assertWorkflowClosed(workflows);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ component: "governance-hook", context: {
      producerReason: mode === "close" ? "ENTRY_BOARD_CLOSE_FAILED" : "ENTRY_BOARD_HANDLE_FAILED",
      ...(mode === "handle-and-close" ? { secondary: [{ producerReason: "ENTRY_BOARD_CLOSE_FAILED" }] } : {}),
    } });
  });

  it.each(["close", "handle-and-close"] as const)("F2: continuity %s failure denies and preserves primary plus cleanup failures", async mode => {
    const { environment } = fixture();
    isolateAmbient(environment);
    const reported = captureDiagnostics();
    const handleFailure = diagnostics.hookFailure("ENTRY_CONTINUITY_HANDLE_FAILED", "synthetic continuity handle failure");
    const closeFailure = diagnostics.hookFailure("ENTRY_CONTINUITY_CLOSE_FAILED", "synthetic continuity cleanup failure");
    const workflowFailure = diagnostics.hookFailure("ENTRY_WORKFLOW_CLOSE_FAILED", "synthetic workflow cleanup failure");
    const workflows = closedWorkflows(workflowFailure);
    const continuities: SqliteContinuityStore[] = [];
    const originalClose = SqliteContinuityStore.prototype.close;
    vi.spyOn(SqliteContinuityStore.prototype, "close").mockImplementation(function (this: SqliteContinuityStore) {
      originalClose.call(this);
      continuities.push(this);
      throw closeFailure;
    });
    if (mode === "handle-and-close") vi.spyOn(ContinuityService.prototype, "issueToolBinding").mockImplementation(() => { throw handleFailure; });

    denied(await runGovernanceHook("claude-code", JSON.stringify(input("inspect_context")), environment));
    expect(continuities).toHaveLength(1);
    expect(() => continuities[0]!.getOrCreateSecret(() => "unused")).toThrow();
    assertWorkflowClosed(workflows);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ component: "governance-hook", context: mode === "close" ? {
      producerReason: "ENTRY_CONTINUITY_CLOSE_FAILED", secondary: [{ producerReason: "ENTRY_WORKFLOW_CLOSE_FAILED" }],
    } : {
      producerReason: "ENTRY_CONTINUITY_HANDLE_FAILED",
      secondary: [{ producerReason: "ENTRY_CONTINUITY_CLOSE_FAILED" }, { producerReason: "ENTRY_WORKFLOW_CLOSE_FAILED" }],
    } });
  });

  it("F2: central workflow cleanup failure discards an otherwise complete root proof", async () => {
    const { environment } = fixture();
    isolateAmbient(environment);
    const reported = captureDiagnostics();
    const closeFailure = diagnostics.hookFailure("ENTRY_WORKFLOW_CLOSE_FAILED", "synthetic central cleanup failure");
    const workflows = closedWorkflows(closeFailure);
    denied(await runGovernanceHook("claude-code", JSON.stringify(input()), environment));
    assertWorkflowClosed(workflows);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ component: "governance-hook", context: { producerReason: "ENTRY_WORKFLOW_CLOSE_FAILED" } });
  });


  it.each([undefined, null, 0, ""])("F2: falsy central workflow cleanup exception %j discards an otherwise complete root proof", async failure => {
    const { environment } = fixture();
    isolateAmbient(environment);
    const reported = captureDiagnostics();
    const workflows: SqliteWorkflowStore[] = [];
    const originalClose = SqliteWorkflowStore.prototype.close;
    vi.spyOn(SqliteWorkflowStore.prototype, "close").mockImplementation(function (this: SqliteWorkflowStore) {
      originalClose.call(this); // Finalize the real resource before throwing even a falsy value.
      workflows.push(this);
      throw failure;
    });

    const outcome = await runGovernanceHook("claude-code", JSON.stringify(input()), environment);
    assertWorkflowClosed(workflows);
    denied(outcome);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ component: "governance-hook", context: {
      type: failure === null ? "null" : typeof failure,
    } });
  });
  it("F2: strict continuity cleanup attempts both real resources even when the first close throws", () => {
    const { environment } = fixture();
    isolateAmbient(environment);
    captureDiagnostics();
    const primary = diagnostics.hookFailure("ENTRY_CONTINUITY_HANDLE_FAILED", "synthetic lifecycle handle failure");
    const workflowFailure = diagnostics.hookFailure("ENTRY_WORKFLOW_CLOSE_FAILED", "synthetic workflow cleanup failure");
    const continuityFailure = diagnostics.hookFailure("ENTRY_CONTINUITY_CLOSE_FAILED", "synthetic continuity cleanup failure");
    const workflows = closedWorkflows(workflowFailure);
    let continuity: SqliteContinuityStore | undefined;
    const originalClose = SqliteContinuityStore.prototype.close;
    vi.spyOn(ContinuityService.prototype, "candidateForSession").mockImplementation(function (this: ContinuityService) {
      continuity = this.store;
      throw primary;
    });
    const close = vi.spyOn(SqliteContinuityStore.prototype, "close").mockImplementation(function (this: SqliteContinuityStore) {
      originalClose.call(this);
      throw continuityFailure;
    });
    try {
      expect(() => runContinuityHook(JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: "synthetic-entry-root" }), environment, "claude-code", true))
        .toThrow(primary);
      expect(close).toHaveBeenCalledTimes(1);
      assertWorkflowClosed(workflows);
      expect(continuity).toBeDefined();
      expect(() => continuity!.getOrCreateSecret(() => "unused")).toThrow();
      expect(diagnostics.hookFailureContext(primary)).toMatchObject({
        producerReason: "ENTRY_CONTINUITY_HANDLE_FAILED", secondary: [{
          producerReason: "ENTRY_WORKFLOW_CLOSE_FAILED", secondary: [{ producerReason: "ENTRY_CONTINUITY_CLOSE_FAILED" }],
        }],
      });
    } finally {
      // A regressed early-abort cleanup must not leak the second real handle into teardown.
      if (continuity) originalClose.call(continuity);
    }
  });

  it("F3: the actual Claude wrapper pins both state paths over ambient overrides (synthetic child bundle)", () => {
    const { directory, environment } = fixture();
    const plugin = path.join(directory, "plugin");
    mkdirSync(path.join(plugin, "hooks"), { recursive: true });
    mkdirSync(path.join(plugin, "mcp-server/dist"), { recursive: true });
    const wrapper = path.join(plugin, "hooks/governance-hook.mjs");
    copyFileSync(path.join(repository, "claude-overlay/hooks/governance-hook.mjs"), wrapper);
    writeFileSync(path.join(plugin, "mcp-server/dist/governance-hook.mjs"), `
export async function runGovernanceHook(host, raw, environment) {
  return { ok: true, output: JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "SYNTHETIC_ENV_CAPTURE" },
    capture: { host, sessionId: JSON.parse(raw).session_id, workflow: environment.AGENT_GOVERNANCE_DB_PATH,
      continuity: environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH, ambientContinuity: process.env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH }
  }) };
}
`, "utf8");
    const data = path.join(directory, "claude-data");
    const ambient = path.join(directory, "ambient-continuity.sqlite3");
    const child = spawnSync(process.execPath, [wrapper], {
      input: JSON.stringify(input()), env: { ...environment, CLAUDE_PLUGIN_DATA: data, AGENT_GOVERNANCE_CONTINUITY_DB_PATH: ambient },
      cwd: directory, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout).capture).toEqual({
      host: "claude-code", sessionId: "synthetic-entry-root", workflow: path.join(data, "workflows.sqlite3"),
      continuity: path.join(data, "continuity.sqlite3"), ambientContinuity: ambient,
    });
    expect(existsSync(ambient)).toBe(false);
    // The fixture captures arguments only; it claims no native execution or real proof.
  });
});
