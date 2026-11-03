import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as boardStore from "../../skills/session-board/scripts/board-store.mjs";
import { runGovernanceHook } from "../../mcp-server/src/governance-hook.js";
import { runContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import * as diagnostics from "../../mcp-server/src/hook-error-diagnostics.js";
import { claudeAdmissionIngress } from "../../mcp-server/src/builtin-caller-ingress.js";
import { RESERVED_CALLER_KEYS } from "../../mcp-server/src/caller-identity.js";
import { HOST_ATTESTATION_TOOLS, hostActorId } from "../../mcp-server/src/host-attestation.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";

// Engineering test plan: F1 = built CLI single owner/stdout + one persisted call admission (no proof, no rewrite);
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
    AGENT_GOVERNANCE_ANTIGRAVITY_QUEUE_WAKE: "0",
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

/** The denial names the actual cause; only a cause without any code is GOVERNANCE_HOOK_FAILED. */
function denied(outcome: { ok: boolean; output: string }, reasonCode = "GOVERNANCE_HOOK_FAILED") {
  expect(outcome.ok).toBe(false);
  const output = JSON.parse(outcome.output);
  expect(output).toEqual({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reasonCode,
  } });
  for (const key of RESERVED_CALLER_KEYS) expect(outcome.output).not.toContain(key);
}

function captureDiagnostics() {
  const reported: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(diagnostics, "writeFailureDiagnostic").mockImplementation(serialized => { reported.push(JSON.parse(serialized)); });
  return reported;
}

function closedWorkflows(failure?: Error, failOnClose = 1) {
  const closed: SqliteWorkflowStore[] = [];
  const original = SqliteWorkflowStore.prototype.close;
  vi.spyOn(SqliteWorkflowStore.prototype, "close").mockImplementation(function (this: SqliteWorkflowStore) {
    original.call(this); // Close the real handle before injecting the cleanup failure.
    closed.push(this);
    if (failure && closed.length === failOnClose) throw failure;
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
  // AGS-D-0352: 실행 순서는 배포 등록에서 읽는다. 불변조건: 한 native 이벤트에 등록 handler 하나가 답하고,
  // AGS 도구 입력을 고치거나 서명하지 않는다. 신원은 서버가 tools/call _meta에서 읽고 예약 키는 서버가 거부한다
  // (tests/mcp/caller-ingress.test.ts의 agy ingress·server ingress boundary).
  // 실제 AGY 사건의 중간 입력·계보를 재현한 시험은 아니다.
  function registeredAntigravityCall(environment: NodeJS.ProcessEnv, wrapped: boolean,
    args: Record<string, unknown> = { schemaVersion: "1.0.0" }, sessionId = "d0352-owned-hook-session", tool = "inspect_context") {
    const hooks = JSON.parse(readFileSync(path.join(repository, "hooks.json"), "utf8")) as Record<string, {
      enabled?: boolean; PreToolUse?: Array<{ hooks: Array<{ command: string }> }>;
    }>;
    const handlers = Object.values(hooks).filter(group => group.enabled !== false)
      .flatMap(group => group.PreToolUse ?? []).flatMap(group => group.hooks);
    let current: Record<string, unknown> = wrapped
      ? { ServerName: "agent-governance-suite", ToolName: tool, Arguments: args } : { ...args };
    const outputs: Array<{ decision: string; reason?: string; overwrite?: Record<string, unknown> }> = [];
    for (const handler of handlers) {
      const [binary, ...argv] = handler.command.split(" ");
      expect(binary).toBe("node");
      // 본문과 발급 토큰 없이 최초 발급/재호출 및 등록 handler별 멈춤을 구분한다.
      const started = performance.now();
      const stage = { test: expect.getState().currentTestName, wrapped, handler: outputs.length,
        reservedKeys: RESERVED_CALLER_KEYS.filter(key => Object.hasOwn(args, key)) };
      process.stderr.write(`[시험단계] ${JSON.stringify({ fixture: "native-registration", ...stage, event: "begin" })}\n`);
      const child = spawnSync(process.execPath, argv, {
        input: JSON.stringify({ conversationId: sessionId, workspacePaths: [path.dirname(environment.AGENT_GOVERNANCE_DB_PATH!)],
          toolCall: { name: wrapped ? "call_mcp_tool" : `mcp_agent-governance-suite_${tool}`, args: current } }),
        cwd: repository, env: environment, encoding: "utf8", timeout: 10_000, windowsHide: true,
      });
      process.stderr.write(`[시험단계] ${JSON.stringify({ fixture: "native-registration", ...stage, event: "end",
        elapsedMs: performance.now() - started, errorCode: (child.error as NodeJS.ErrnoException | undefined)?.code ?? null,
        status: child.status, signal: child.signal, stdoutUtf8Bytes: Buffer.byteLength(child.stdout ?? ""), stderrUtf8Bytes: Buffer.byteLength(child.stderr ?? "") })}\n`);
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.trim().split(/\r?\n/u)).toHaveLength(1);
      const output = JSON.parse(child.stdout);
      outputs.push(output);
      if (output.decision === "deny") break;
      current = { ...current, ...output.overwrite };
    }
    return { outputs, args: wrapped ? current.Arguments as Record<string, unknown> : current };
  }

  // 격리된 등록 실행기 경계: 종료 코드 0과 별도로 decision과 전달된 인자로 판정한다.
  // 실제 호스트·모델 실행 사례는 아니다. 호출자 신원 필드와 세션 ID 누락은 서버가 거부한다.
  it.each([
    { kind: "분류", tool: "classify_skills", args: { schemaVersion: "1.0.0" }, sessionId: undefined },
    { kind: "목록", tool: "list_skills", args: { schemaVersion: "1.0.0" }, sessionId: undefined },
    { kind: "연속성", tool: "inspect_context", args: { schemaVersion: "1.0.0" }, sessionId: undefined },
    ...RESERVED_CALLER_KEYS.map(key => ({ kind: `호출자 ${key}`, tool: "classify_skills", args: { schemaVersion: "1.0.0", [key]: "forged" }, sessionId: undefined })),
    { kind: "세션 ID 없음", tool: "inspect_context", args: { schemaVersion: "1.0.0" }, sessionId: "" },
  ])("AGS-D-0352: 격리된 등록 실행기는 $kind 호출을 handler 하나로 고치지 않고 통과시키며 서명·상태를 만들지 않는다", ({ tool, args, sessionId }) => {
    for (const wrapped of [true, false]) {
      const { environment } = fixture();
      const result = registeredAntigravityCall(environment, wrapped, args, sessionId, tool);
      expect(result.outputs).toEqual([{ decision: "allow" }]);
      expect(result.args).toEqual(args);
      // AGS 3.1.1: an observed tool's call leaves one call admission for the server to claim; nothing else is written.
      expect(existsSync(environment.AGENT_GOVERNANCE_DB_PATH!)).toBe(HOST_ATTESTATION_TOOLS.has(tool) && sessionId !== "");
      expect(existsSync(environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH!)).toBe(false);
    }
  });

  it("F1: the built Claude CLI prints nothing and records one call admission the server claims once as the root", () => {
    const { environment } = fixture();
    const payload = input("get_trust_capabilities", { schemaVersion: "1.0.0", _sessionBinding: { host: "forged", sessionId: "forged" } });
    const child = spawnSync(process.execPath, [path.join(repository, "mcp-server/dist/governance-hook.mjs"), "--host=claude-code"], {
      input: JSON.stringify(payload), env: environment, cwd: repository, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    // No updatedInput and no permission decision: the host's own approval flow runs unchanged, and the server
    // refuses the self-supplied binding as a reserved caller field.
    expect(child.stdout).toBe("");
    expect(existsSync(environment.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH!)).toBe(false);
    expect(existsSync(environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH!)).toBe(false);
    expect(existsSync(environment.AGENT_GOVERNANCE_TRUST_DB_PATH!)).toBe(false);
    expect(existsSync(environment.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR!)).toBe(false);

    const store = new SqliteWorkflowStore(environment.AGENT_GOVERNANCE_DB_PATH!);
    try {
      const ingress = claudeAdmissionIngress(store);
      const meta = { "claudecode/toolUseId": payload.tool_use_id };
      const admitted = ingress("get_trust_capabilities", meta);
      expect(admitted).toMatchObject({ provenance: "host-observed", caller: {
        host: "claude-code", sessionId: payload.session_id, callId: payload.tool_use_id,
        actor: { id: hostActorId("claude-code", payload.session_id), role: "root" }, parentChain: [],
      } });
      expect(ingress("get_trust_capabilities", meta)).toEqual({ provenance: "unavailable", reason: "CALL_ADMISSION_MISSING" });
    } finally { store.close(); }
  });

  // Codex names the caller in tools/call _meta; the plugin registers no Codex governance hook that could issue anything.
  it("F1: Codex registers no governance PreToolUse hook", () => {
    const config = JSON.parse(readFileSync(path.join(repository, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>>;
    };
    const commands = Object.values(config.hooks).flat().flatMap(group => group.hooks).flatMap(hook => [hook.command, hook.commandWindows ?? ""]);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command).not.toContain("governance-hook");
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

  // Board writes are the server's (caller-verified, board design D3); the governance hook opens no board even for board
  // tools, so an unusable board cannot deny them. Each call is only admitted under its own tool-use ID.
  it("F2: board tool admissions open no board, so an unusable board cannot deny them, and record each call", async () => {
    const { directory, environment } = fixture();
    const blocker = path.join(directory, "blocker");
    writeFileSync(blocker, "");
    const unusable = { ...environment, AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(blocker, "board.sqlite3") };
    isolateAmbient(unusable);
    const reported = captureDiagnostics();
    const workflows = closedWorkflows();
    const open = vi.spyOn(boardStore, "openBoard");
    const write = vi.spyOn(boardStore, "setSummary");
    const admit = vi.spyOn(SqliteWorkflowStore.prototype, "recordCallAdmission");
    for (const [tool, args] of [["update_session_status", { schemaVersion: "1.0.0", summary: "synthetic entry status" }], ["list_session_status", { schemaVersion: "1.0.0" }]] as const) {
      expect(await runGovernanceHook("claude-code", JSON.stringify({ ...input(tool, args), tool_use_id: `synthetic-entry-${tool}` }), unusable), tool)
        .toEqual({ ok: true, output: "" });
    }
    expect(open).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(admit).toHaveBeenCalledTimes(2);
    expect(admit.mock.calls.map(([admission]) => admission)).toMatchObject([
      { host: "claude-code", tool: "update_session_status", sessionId: "synthetic-entry-root", agentId: null },
      { host: "claude-code", tool: "list_session_status", sessionId: "synthetic-entry-root", agentId: null },
    ]);
    assertWorkflowClosed(workflows, 2);
    expect(reported).toEqual([]);
  });

  // The continuity hook still runs before an AGS continuity tool (deferred fork host read); its cleanup failure denies.
  it("F2: continuity close failure denies before the call is admitted", async () => {
    const { environment } = fixture();
    isolateAmbient(environment);
    const reported = captureDiagnostics();
    const closeFailure = diagnostics.hookFailure("ENTRY_CONTINUITY_CLOSE_FAILED", "synthetic continuity cleanup failure");
    // Only the continuity hook's inner workflow store opens: the admission store is never reached.
    const workflows = closedWorkflows();
    const continuities: SqliteContinuityStore[] = [];
    const originalClose = SqliteContinuityStore.prototype.close;
    vi.spyOn(SqliteContinuityStore.prototype, "close").mockImplementation(function (this: SqliteContinuityStore) {
      originalClose.call(this);
      continuities.push(this);
      throw closeFailure;
    });
    const admit = vi.spyOn(SqliteWorkflowStore.prototype, "recordCallAdmission");

    denied(await runGovernanceHook("claude-code", JSON.stringify(input("inspect_context")), environment), "ENTRY_CONTINUITY_CLOSE_FAILED");
    expect(continuities).toHaveLength(1);
    expect(() => continuities[0]!.getOrCreateSecret(() => "unused")).toThrow();
    assertWorkflowClosed(workflows, 1);
    expect(admit).not.toHaveBeenCalled();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ component: "governance-hook", reasonCode: "ENTRY_CONTINUITY_CLOSE_FAILED",
      context: { producerReason: "ENTRY_CONTINUITY_CLOSE_FAILED" } });
  });

  // Design ags30-phase-check 7.6: a start the hook refuses never reaches the server, so the hook records the failure.
  it("F2: a refused start_workflow lets the session's third product file pass instead of keeping it locked", async () => {
    const { environment } = fixture();
    isolateAmbient(environment);
    captureDiagnostics();
    const repo = path.resolve(process.platform === "win32" ? "C:\\work\\repo" : "/work/repo");
    const write = (name: string) => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "synthetic-entry-root", cwd: repo,
      tool_name: "Write", tool_input: { file_path: path.join(repo, name), content: "x" } });
    // Each edit opens and closes the workflow store once; the hook's own close (the third) fails.
    closedWorkflows(diagnostics.hookFailure("ENTRY_WORKFLOW_CLOSE_FAILED", "synthetic central cleanup failure"), 3);
    for (const name of ["a.ts", "b.ts"]) expect(runContinuityHook(write(name), environment, "claude-code")).toBe("");
    denied(await runGovernanceHook("claude-code", JSON.stringify(input("start_workflow", {})), environment), "ENTRY_WORKFLOW_CLOSE_FAILED");
    expect(runContinuityHook(write("c.ts"), environment, "claude-code")).toBe("");
  });

  it("F2: central workflow cleanup failure denies an otherwise admitted call", async () => {
    const { environment } = fixture();
    isolateAmbient(environment);
    const reported = captureDiagnostics();
    const closeFailure = diagnostics.hookFailure("ENTRY_WORKFLOW_CLOSE_FAILED", "synthetic central cleanup failure");
    const workflows = closedWorkflows(closeFailure);
    denied(await runGovernanceHook("claude-code", JSON.stringify(input()), environment), "ENTRY_WORKFLOW_CLOSE_FAILED");
    assertWorkflowClosed(workflows);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ component: "governance-hook", reasonCode: "ENTRY_WORKFLOW_CLOSE_FAILED",
      context: { producerReason: "ENTRY_WORKFLOW_CLOSE_FAILED" } });
  });


  it.each([undefined, null, 0, ""])("F2: falsy central workflow cleanup exception %j denies an otherwise admitted call", async failure => {
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
    // The fixture captures arguments only; it claims no native execution or real admission.
  });
});
