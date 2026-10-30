import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { SessionActorProofs, withoutSessionProof } from "../../mcp-server/src/session-actor-proof.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";

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
  // AGS-D-0352: 실행 순서는 배포 등록에서 읽고, 도구 입력 갱신은 호스트의 overwrite 계약으로 전달한다.
  // 불변조건: 한 native 이벤트의 발급자는 하나이며, 재호출은 기존 예약키 거부를 그대로 통과해야 한다.
  // 같은 테스트에서 hooks.json만 원 6944aa45로 되돌린 TEST 사본은 두 번째 handler 거부로 실패해야 한다.
  // 실제 AGY 사건의 중간 입력·계보를 재현한 시험은 아니다. 자식/판정불가 정책은 기존 공통 시험을 함께 실행한다.
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
      const stage = { test: expect.getState().currentTestName, wrapped, handler: outputs.length, hasSessionProof: Object.hasOwn(args, "_sessionProof"),
        hasContinuityBinding: Object.hasOwn(args, "_continuityBinding") };
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

  // 격리된 등록 실행기 경계: 종료 코드 0과 별도로 decision 및 서명 검증으로 판정한다.
  // 실제 호스트·모델 실행이나 분류 실패 뒤 반복 방지 동작을 검증하는 사례는 아니다.
  it.each([true, false])("AGS-D-0352: 격리된 등록 실행기는 분류 거부를 대체 서명으로 바꾸지 않는다 (wrapped=%s)", wrapped => {
    const { environment } = fixture();
    const result = registeredAntigravityCall(environment, wrapped, undefined, undefined, "classify_skills");
    expect(result.outputs).toEqual([{ decision: "deny", reason: "GOVERNANCE_HOOK_FAILED" }]);
    expect(result.args).toEqual({ schemaVersion: "1.0.0" });
  });

  it.each([true, false])("AGS-D-0352: 격리된 등록 실행기의 목록 허용 서명은 실제 검증을 통과한다 (wrapped=%s)", wrapped => {
    const { environment } = fixture();
    const result = registeredAntigravityCall(environment, wrapped, undefined, undefined, "list_skills");
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({ decision: "allow" });
    expect(result.args).toMatchObject({ schemaVersion: "1.0.0", _sessionProof: expect.any(String) });
    expect(result.args).not.toHaveProperty("_hostAttestation");
    const workflow = new SqliteWorkflowStore(environment.AGENT_GOVERNANCE_DB_PATH!);
    try {
      expect(new SessionActorProofs(workflow).verify("list_skills", result.args)).toMatchObject({ host: "antigravity",
        sessionId: "d0352-owned-hook-session", actor: { role: "root", basis: "inferred" } });
    } finally { workflow.close(); }
  });

  it.each([true, false])("AGS-D-0352: 격리된 등록 실행기는 호출자의 호스트 관측값을 거부하고 서명을 발급하지 않는다 (wrapped=%s)", wrapped => {
    const { environment } = fixture();
    const args = { schemaVersion: "1.0.0", _hostAttestation: "forged" };
    const result = registeredAntigravityCall(environment, wrapped, args, undefined, "classify_skills");
    expect(result.outputs).toEqual([{ decision: "deny", reason: "Unverified caller _hostAttestation rejected." }]);
    expect(result.args).toEqual(args);
    expect(existsSync(environment.AGENT_GOVERNANCE_DB_PATH!)).toBe(false);
  });

  it.each([true, false])("AGS-D-0352: native registration preserves one usable root and continuity binding (wrapped=%s)", wrapped => {
    const { environment } = fixture();
    const result = registeredAntigravityCall(environment, wrapped);
    expect(result.outputs.at(-1)).toMatchObject({ decision: "allow" });
    expect(result.outputs).toHaveLength(1);
    expect(result.args).toMatchObject({ schemaVersion: "1.0.0", _sessionProof: expect.any(String), _continuityBinding: expect.any(String) });
    const workflow = new SqliteWorkflowStore(environment.AGENT_GOVERNANCE_DB_PATH!);
    const continuity = new SqliteContinuityStore(environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH!);
    try {
      const proofs = new SessionActorProofs(workflow);
      expect(proofs.verify("inspect_context", result.args)).toMatchObject({ host: "antigravity",
        sessionId: "d0352-owned-hook-session", actor: { role: "root", basis: "inferred" } });
      const service = new ContinuityService(continuity, new ContractValidator(), workflow);
      expect(service.inspectContext(withoutSessionProof(result.args)).ok).toBe(true);
      expect(() => proofs.verify("inspect_context", result.args)).toThrow(expect.objectContaining({ code: "BINDING_INVALID" }));
      // 정상 발급값도 새 native 호출의 호출자 입력으로 재사용하면 거부한다.
      const replay = registeredAntigravityCall(environment, wrapped, result.args);
      expect(replay.outputs).toHaveLength(1);
      expect(replay.outputs[0]).toMatchObject({ decision: "deny" });
      expect(replay.outputs[0]!.overwrite).toBeUndefined();
    } finally { continuity.close(); workflow.close(); }
  });

  it.each(["_continuityBinding", "_sessionProof"])("AGS-D-0352: native registration rejects caller %s without issuing replacement fields", field => {
    for (const wrapped of [true, false]) {
      const { environment } = fixture();
      const result = registeredAntigravityCall(environment, wrapped, { schemaVersion: "1.0.0", [field]: "forged" });
      expect(result.outputs).toEqual([{ decision: "deny", reason: `Unverified caller ${field} rejected.` }]);
      expect(existsSync(environment.AGENT_GOVERNANCE_DB_PATH!)).toBe(false);
    }
  });

  it("AGS-D-0352: native registration preserves missing-session indeterminate denial without binding issuance", () => {
    const { environment } = fixture();
    const result = registeredAntigravityCall(environment, true, { schemaVersion: "1.0.0" }, "");
    expect(result.outputs).toEqual([{ decision: "deny", reason: "ANTIGRAVITY_NATIVE_SESSION_ID_INVALID" }]);
    expect(existsSync(environment.AGENT_GOVERNANCE_DB_PATH!)).toBe(false);
  });

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
    expect(output.hookSpecificOutput).not.toHaveProperty("permissionDecision");
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

  it("F1: the built Codex CLI emits a root/inferred proof while child blocking is deferred", () => {
    const { environment } = fixture();
    const payload = { ...input(), tool_name: "mcp__agent_governance_suite__get_trust_capabilities" };
    const child = spawnSync(process.execPath, [path.join(repository, "mcp-server/dist/governance-hook.mjs"), "--host=codex"], {
      input: JSON.stringify(payload), env: environment, cwd: repository, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim().split(/\r?\n/u)).toHaveLength(1);
    const specific = JSON.parse(child.stdout).hookSpecificOutput;
    // Codex drops updatedInput without permissionDecision "allow", so the proof never reaches the server.
    expect(specific.permissionDecision).toBe("allow");
    const args = specific.updatedInput as Record<string, unknown>;
    const store = new SqliteWorkflowStore(environment.AGENT_GOVERNANCE_DB_PATH!);
    try {
      expect(new SessionActorProofs(store).verify("get_trust_capabilities", args)).toEqual({
        host: "codex", sessionId: payload.session_id,
        actor: { role: "root", basis: "inferred", reasonCode: "CODEX_ROOT_INFERRED_CHILD_GATE_DEFERRED" },
      });
    } finally { store.close(); }
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
    // The continuity hook owns an inner workflow store; the outer governance store closes second.
    const workflows = closedWorkflows(workflowFailure, 2);
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
    assertWorkflowClosed(workflows, 2);
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
