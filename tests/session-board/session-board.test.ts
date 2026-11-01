import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiResultV1 } from "../../contracts/types.js";

import {
  gateDecision,
  isReadOnlyCommand,
  listSessions,
  openBoard,
  pruneSessions,
  recordPrompt,
  setSummary,
  touchSession,
} from "../../skills/session-board/scripts/board-store.mjs";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { resolveSessionBoardDatabasePath } from "../../mcp-server/src/runtime-config.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { handleSessionBoardHook, runSessionBoardHook } from "../../mcp-server/src/session-board-hook.js";
import { SessionMessageService, type SessionPresenceList } from "../../mcp-server/src/session-message-service.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { CURRENT_VERSION, STABLE_VERSION } from "../mcp/version-fixtures.js";
import { callerMeta, metaIngress } from "../helpers/caller.js";
import { adaptHostInput, isGovernanceHookTool, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";

// Second host core fixture only: native Codex remains capture-required.
const syntheticHost = "synthetic-board-root";
registerHookHostAdapter(syntheticHost, {
  processPid: () => undefined,
  deliveryProfile: () => ({ transport: "claude-inbox", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false }),
  ownsTool: name => isGovernanceHookTool("codex", name),
  adaptInput: (payload, host) => {
    const mapped = adaptHostInput(payload, "codex");
    return { ...mapped, observation: { ...mapped.observation, host,
      actor: { role: "root", basis: "observed", reasonCode: "SYNTHETIC_BOARD_ROOT" } } };
  },
});

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const directories: string[] = [];
const boards: Array<ReturnType<typeof openBoard>> = [];

afterEach(() => {
  for (const board of boards.splice(0)) board.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function boardPath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "session-board-"));
  directories.push(directory);
  return path.join(directory, "session-board.sqlite3");
}

function open(databasePath = boardPath()): ReturnType<typeof openBoard> {
  const board = openBoard(databasePath);
  boards.push(board);
  return board;
}

const at = (minute: number): string => new Date(Date.UTC(2026, 8, 19, 5, minute)).toISOString();
const session = (now: string, sessionId = "s1") => ({ host: "claude-code", sessionId, cwd: "D:/work/repo", now });
const decision = (output: Record<string, unknown>) => (output.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision ?? null;

describe("session board store", () => {
  it("denies the first gated call of each request once until the line is written for that request", () => {
    const board = open();
    recordPrompt(board, session(at(0)));
    expect(gateDecision(board, session(at(1)))).toBe("deny");
    expect(gateDecision(board, session(at(2)))).toBe("allow");
    setSummary(board, session(at(3)), "v1.21.0 준비 · claude/session-board");
    expect(gateDecision(board, session(at(4)))).toBe("allow");
    recordPrompt(board, session(at(5)));
    expect(gateDecision(board, session(at(6)))).toBe("deny");
    setSummary(board, session(at(7)), "v1.21.0 준비 · claude/session-board");
    expect(gateDecision(board, session(at(8)))).toBe("allow");
  });

  it("uses the session start as the request marker when the host has no request event", () => {
    const board = open();
    touchSession(board, session(at(0)));
    expect(gateDecision(board, session(at(1)))).toBe("deny");
    expect(gateDecision(board, session(at(2)))).toBe("allow");
    setSummary(board, session(at(3)), "Codex 작업");
    expect(listSessions(board, at(4))[0]).toMatchObject({ summary: "Codex 작업", stale: false });
  });

  it("accepts only one bounded line", () => {
    const board = open();
    for (const bad of ["", "   ", "첫 줄\n둘째 줄", "x".repeat(201), 42]) {
      expect(() => setSummary(board, session(at(0)), bad)).toThrow(/one non-empty line/u);
    }
    expect(setSummary(board, session(at(0)), `  ${"x".repeat(200)}  `)).toHaveLength(200);
  });

  it("lists recent sessions newest first with stale and current flags and prunes day-old rows", () => {
    const board = open();
    setSummary(board, session(at(0), "old"), "어제 작업");
    setSummary(board, session(at(10), "a"), "A 작업");
    recordPrompt(board, session(at(11), "a"));
    setSummary(board, session(at(12), "b"), "B 작업");
    const rows = listSessions(board, at(13), { host: "claude-code", sessionId: "b" });
    expect(rows.map((row) => [row.sessionId, row.stale, row.current])).toEqual([["b", false, true], ["a", true, false], ["old", false, false]]);
    const nextDay = new Date(Date.parse(at(5)) + 24 * 3600_000).toISOString();
    pruneSessions(board, nextDay);
    expect(listSessions(board, nextDay).map((row) => row.sessionId)).toEqual(["b", "a"]);
  });

  it("keeps rows intact and denies once when two connections race on the same request", () => {
    const databasePath = boardPath();
    const first = open(databasePath);
    const second = open(databasePath);
    recordPrompt(first, session(at(0)));
    const decisions = [gateDecision(first, session(at(1))), gateDecision(second, session(at(1)))];
    expect(decisions.filter((value) => value === "deny")).toHaveLength(1);
    setSummary(second, session(at(2)), "두 번째 연결이 쓴 줄");
    setSummary(first, session(at(3), "s2"), "다른 세션");
    expect(listSessions(first, at(4)).map((row) => [row.sessionId, row.summary])).toEqual([["s2", "다른 세션"], ["s1", "두 번째 연결이 쓴 줄"]]);
  });

  it("recognizes only single read-only commands", () => {
    for (const command of ["git status", "git log --oneline -3", "git diff --stat", "git show HEAD", "git branch", "git branch --list", "ls -la", "cat README.md", "pwd", "rg foo src", "grep -n x file"]) {
      expect(isReadOnlyCommand(command)).toBe(true);
    }
    for (const command of [
      "git status && rm -rf x", "cat a > b", "ls | xargs rm", "echo $(whoami)", "git branch -D main", "git commit -m x", "pnpm test", "cat `x`", "ls; rm a", "git status\nrm a", "", null,
      "rg --pre ./x.sh foo", "rg foo --pre=./x.sh", "git diff --output=README.md", "git log --output a.txt", "git diff --ext-diff", "cat (Remove-Item x)", "ls @(rm x)", "cat $HOME/x", "ls {a,b}",
      "git diff \"--output=o.txt\"", "git diff '--output=o.txt'", "git diff \\--output=o.txt", "rg '--pre=./x.sh' foo",
    ]) {
      expect(isReadOnlyCommand(command)).toBe(false);
    }
  });
});

describe("session board hook", () => {
  const input = (event: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: event, session_id: "s1", cwd: "D:/work/repo", ...extra });
  const tool = (name: string, toolInput: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => input("PreToolUse", { tool_name: name, tool_input: toolInput, ...extra });
  const boardTool = (name: string) => `mcp__plugin_agent-governance-suite_agent-governance-suite__${name}`;

  it("never denies ordinary tool calls for a missing or stale board line, and leaves AGS board tool calls to the server", () => {
    const board = open();
    const run = (hookInput: Record<string, unknown>, minute: number) => handleSessionBoardHook(hookInput, board, "claude-code", at(minute));
    expect(run(input("UserPromptSubmit", { prompt: "비밀 요청 원문" }), 0)).toEqual({});
    expect(run(tool("Bash", { command: "git status" }), 1)).toEqual({});
    expect(run(tool("Edit", {}, { agent_id: "sub-1" }), 2)).toEqual({});
    expect(run(tool("Read"), 3)).toEqual({});
    expect(run(tool("Bash", { command: "git status && rm x" }), 4)).toEqual({});
    expect(run(tool("Write"), 5)).toEqual({});

    // The hook neither denies, rewrites nor writes AGS board calls; the server checks the caller and the summary.
    expect(run(tool(boardTool("update_session_status"), { schemaVersion: "1.0.0", summary: "x" }, { agent_id: "sub-1" }), 6)).toEqual({});
    expect(run(tool(boardTool("update_session_status"), { schemaVersion: "1.0.0", summary: "둘\n줄" }), 7)).toEqual({});
    const updated = run(tool(boardTool("update_session_status"), { schemaVersion: "1.0.0", summary: "현황판 구현", _sessionBinding: { host: "x", sessionId: "forged" } }), 8);
    expect(updated).toEqual({});
    expect(listSessions(board, at(8)).map((row) => [row.host, row.sessionId, row.summary])).toEqual([["claude-code", "s1", null]]);
    // Stands in for the server's caller-verified write (server.ts sessionBoardResult).
    setSummary(board, session(at(8)), "현황판 구현");

    run(input("UserPromptSubmit", { agent_id: "sub-1", prompt: "서브에이전트 입력" }), 9);
    expect(listSessions(board, at(9))[0]).toMatchObject({ summary: "현황판 구현", stale: false });
    run(input("SessionStart", { agent_id: "sub-1" }), 10);
    expect(listSessions(board, at(10))[0]).toMatchObject({ summary: "현황판 구현", stale: false });

    run(input("UserPromptSubmit"), 11);
    expect(decision(run(tool("Agent"), 12))).toBe(null);
    const row = listSessions(board, at(13))[0];
    expect(row).toMatchObject({ sessionId: "s1", cwd: "D:/work/repo", summary: "현황판 구현", stale: true });
    expect(JSON.stringify(listSessions(board, at(11)))).not.toContain("비밀 요청 원문");

    expect(run(tool(boardTool("list_session_status"), { schemaVersion: "1.0.0" }, { agent_id: "sub-1" }), 14)).toEqual({});
  });

  it("does not create a new request boundary for a broker-verified wake bell", () => {
    const board = open();
    handleSessionBoardHook(input("SessionStart"), board, "claude-code", at(0));
    setSummary(board, session(at(1)), "메시지 대기");
    handleSessionBoardHook(input("UserPromptSubmit", { prompt: "verified wake" }), board, "claude-code", at(2), true);
    expect(decision(handleSessionBoardHook(tool("Edit"), board, "claude-code", at(3)))).toBe(null);
    handleSessionBoardHook(input("UserPromptSubmit", { prompt: "ordinary prompt" }), board, "claude-code", at(4));
    expect(decision(handleSessionBoardHook(tool("Edit"), board, "claude-code", at(5)))).toBe(null);
  });

  it("does not consume a parent wake from an observed subagent prompt", async () => {
    const store = new SessionMessageStore(":memory:");
    const target = { host: "claude-code", sessionId: "parent" };
    const nonce = "subagent-wake-nonce-abcdefghijklmnop";
    store.send({ messageId: "subagent-wake-0001", sender: { host: "peer", sessionId: "sender" }, target, body: "pending" }, 1000);
    store.startPresence({ ...target, instanceId: "parent-instance", transport: "claude-inbox", wakeVisibility: "silent", canWakeSilently: true,
      deliveryCapabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "silent" } }, 2000);
    expect(store.acquireRelay({ ...target, transport: "claude-inbox", relayId: "parent-relay", pid: process.pid, parentPid: process.pid }, 2000)).toBe(true);
    expect(store.reserveManagedWake({ ...target, nonce, instanceId: "parent-instance", transport: "claude-inbox", relayId: "parent-relay" }, 2000).dispatch).toBe(true);
    const before = store.database.prepare("SELECT * FROM wake_nonces").all();
    let requests = 0;
    const request = (async <T>() => {
      requests += 1;
      return { consumed: store.consumeWake(target, nonce) } as T;
    }) as typeof import("../../mcp-server/src/session-message-client.js").sessionMessageRequest;
    const previous = process.env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH;
    process.env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH = boardPath();
    try {
      await runSessionBoardHook("claude-code", JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: target.sessionId,
        agent_id: "sub-1",
        prompt: `[agent-governance-suite:wake:${nonce}]`,
      }), request);
      expect(requests).toBe(0);
      // The parent's marker and body are untouched by the subagent prompt.
      expect(store.database.prepare("SELECT * FROM wake_nonces").all()).toEqual(before);
      expect(store.pendingCount(target, 2002)).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH;
      else process.env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH = previous;
      store.close();
    }
  });

  it("does not reject any ordinary call when several hook processes observe the same request", async () => {
    const databasePath = boardPath();
    open(databasePath); // The schema exists, so the processes race on the session row itself.
    const bundle = fileURLToPath(new URL("../../mcp-server/src/session-board-hook.ts", import.meta.url));
    const hookInput = JSON.stringify(tool("Edit"));
    const outputs = await Promise.all(Array.from({ length: 4 }, () => new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", bundle], { env: { ...process.env, AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: databasePath }, windowsHide: true });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.on("close", (status) => resolve({ status, stdout }));
      child.stdin.end(hookInput);
    })));
    expect(outputs.every((output) => output.status === 0)).toBe(true);
    // Native Codex cannot write a board row without capture; ordinary tools still fail open.
    expect(outputs.filter((output) => output.stdout.includes('"deny"'))).toHaveLength(0);
    expect(listSessions(open(databasePath), at(0))).toEqual([]);
  });

  it("points every Codex hook command at a bundle that exists", () => {
    const repository = fileURLToPath(new URL("../../", import.meta.url));
    const config = JSON.parse(readFileSync(path.join(repository, "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string; commandWindows: string }> }>> };
    expect(config.hooks.UserPromptSubmit?.some((group) => group.hooks.some((hook) => hook.command.includes("session-board-hook.mjs")))).toBe(true);
    for (const hook of Object.values(config.hooks).flat().flatMap((group) => group.hooks)) {
      const posix = /^node "\$PLUGIN_ROOT\/([^"]+)"(?: .*)?$/u.exec(hook.command)?.[1];
      const windows = /^node "\$env:PLUGIN_ROOT\\([^"]+)"(?: .*)?$/u.exec(hook.commandWindows)?.[1];
      expect(posix, hook.command).toBeTruthy();
      expect(windows?.split("\\").join("/"), hook.commandWindows).toBe(posix);
      expect(existsSync(path.join(repository, posix!))).toBe(true);
    }
    const messageStart = config.hooks.SessionStart?.[0]?.hooks[0];
    expect(messageStart).toBeDefined();
    expect(messageStart!.command).toContain('--host-pid "$PPID"');
    expect(messageStart!.commandWindows).toContain('Get-CimInstance Win32_Process');
    expect(messageStart!.commandWindows).toContain('.ParentProcessId');
  });

  it("fails open on unreadable input or an unusable board", async () => {
    expect(await runSessionBoardHook("claude-code", "not json")).toBe("");
    const directory = mkdtempSync(path.join(tmpdir(), "session-board-blocked-"));
    directories.push(directory);
    const blocker = path.join(directory, "file");
    writeFileSync(blocker, "");
    const previous = process.env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH;
    process.env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH = path.join(blocker, "session-board.sqlite3");
    try {
      expect(await runSessionBoardHook("claude-code", JSON.stringify(tool("Edit")))).toBe("");
    } finally {
      if (previous === undefined) delete process.env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH;
      else process.env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH = previous;
    }
  });
});

describe("session board MCP tools", () => {
  type Identity = { host: string; sessionId: string };
  const reader: Identity = { host: "synthetic-board-reader", sessionId: "reader" };
  // The caller comes only from tools/call `_meta`; omitting it leaves the caller unobserved.
  const call = (client: Client, name: string, args: Record<string, unknown>, identity: Identity | null = reader, agentKey?: string) =>
    client.callTool({ name, arguments: args, ...(identity === null ? {} : { _meta: callerMeta(identity, agentKey) }) });
  function sessionMessages(
    presence: ApiResultV1<SessionPresenceList> = { schemaVersion: "1.0.0", ok: false, data: null, error: { code: "MCP_UNAVAILABLE", message: "unavailable", details: null } },
  ) {
    const service = new SessionMessageService();
    service.listPresence = async () => presence;
    return service;
  }

  async function connect(databasePath: string | null, messages = sessionMessages()): Promise<Client> {
    const validator = new ContractValidator();
    const updates = new InMemoryPluginUpdateStore();
    updates.putPluginUpdateState({
      targetId: "agent-governance-suite", currentVersion: CURRENT_VERSION, latestVersion: STABLE_VERSION, latestTag: `v${STABLE_VERSION}`,
      latestCommit: "d".repeat(40), etag: "session-board", comparison: "up-to-date", lastAttemptAt: "2026-09-19T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-09-19T00:00:00.000Z", nextCheckAt: "2099-01-01T00:00:00.000Z", lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null,
    });
    const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore());
    const server = createMcpServer(service, new PluginUpdateService(updates), undefined, undefined, undefined, validator, "default", null, databasePath, messages, undefined, undefined, metaIngress());
    const client = new Client({ name: "session-board", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }
  const payload = (response: unknown) => JSON.parse((response as { content: Array<{ text: string }> }).content[0]!.text) as {
    ok: boolean; data: unknown; error: { code: string; details?: Record<string, unknown> | null } | null;
  };

  it("shares one board between the Claude launcher and a synthetic second host while unsupported Gemini touches nothing", async () => {
    const state = mkdtempSync(path.join(tmpdir(), "session-board-state-"));
    directories.push(state);
    const env: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: state, XDG_STATE_HOME: state, HOME: state, AGENT_GOVERNANCE_SHARED_STATE_DIR: state, CLAUDE_PLUGIN_DATA: path.join(state, "plugin-data") };
    delete env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH;
    delete env.AGENT_GOVERNANCE_DB_PATH;
    const repository = fileURLToPath(new URL("../../", import.meta.url));
    const hostFields = (host: "codex" | "claude-code") => host === "claude-code" ? {} : { agent_id: "" };
    const start = (sessionId: string, host: "codex" | "claude-code") => JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, ...hostFields(host), cwd: "D:/work/repo", source: "startup" });
    const update = (sessionId: string, toolName: string, summary: string, host: "codex" | "claude-code") => JSON.stringify({ hook_event_name: "PreToolUse", session_id: sessionId, ...hostFields(host), cwd: "D:/work/repo", tool_name: toolName, tool_input: { schemaVersion: "1.0.0", summary } });
    const run = (script: string, input: string, args: string[] = []) => spawnSync(process.execPath, [path.join(repository, script), ...args], { env, input, encoding: "utf8", windowsHide: true });
    const claudeStart = run("claude-plugin/hooks/session-board-hook.mjs", start("claude-1", "claude-code"));
    const claude = run("claude-plugin/hooks/session-board-hook.mjs", update("claude-1", "mcp__plugin_agent-governance-suite_agent-governance-suite__update_session_status", "Claude 작업", "claude-code"));
    const geminiStart = run("mcp-server/dist/session-board-hook.mjs", start("gemini-1", "codex"), ["--host=gemini"]);
    const gemini = run("mcp-server/dist/session-board-hook.mjs", update("gemini-1", "mcp__agent-governance-suite__update_session_status", "Gemini 작업", "codex"), ["--host=gemini"]);
    expect([claudeStart.status, claude.status, geminiStart.status, gemini.status]).toEqual([0, 0, 0, 0]);
    // No hook rewrites, denies or answers an AGS board call; the server verifies the caller.
    expect([claudeStart.stdout, claude.stdout, geminiStart.stdout, gemini.stdout]).toEqual(["", "", "", ""]);
    const shared = resolveSessionBoardDatabasePath(env);
    expect(existsSync(shared)).toBe(true);
    expect(existsSync(env.CLAUDE_PLUGIN_DATA!)).toBe(false);

    const syntheticBoard = open(shared);
    expect(handleSessionBoardHook(JSON.parse(start("synthetic-1", "codex")), syntheticBoard, syntheticHost)).toEqual({});
    expect(handleSessionBoardHook(JSON.parse(update("synthetic-1", "mcp__agent-governance-suite__update_session_status", "두 번째 호스트 작업", "codex")), syntheticBoard, syntheticHost)).toEqual({});
    // The hooks recorded the rows only (none for the unsupported host); none wrote the summary its tool input carried.
    expect(listSessions(syntheticBoard, new Date().toISOString()).map((row) => [row.host, row.sessionId, row.summary]).sort()).toEqual([
      ["claude-code", "claude-1", null],
      [syntheticHost, "synthetic-1", null],
    ]);
    const client = await connect(shared);
    expect(payload(await call(client, "update_session_status", { schemaVersion: "1.0.0", summary: "Claude 작업" }, { host: "claude-code", sessionId: "claude-1" })).ok).toBe(true);
    expect(payload(await call(client, "update_session_status", { schemaVersion: "1.0.0", summary: "두 번째 호스트 작업" }, { host: syntheticHost, sessionId: "synthetic-1" })).ok).toBe(true);
    const listed = payload(await call(client, "list_session_status", { schemaVersion: "1.0.0" }, { host: syntheticHost, sessionId: "synthetic-1" }));
    const sessions = (listed.data as { sessions: Array<{ host: string; sessionId: string; summary: string; current: boolean }> }).sessions;
    expect(sessions.map((row) => [row.host, row.sessionId, row.summary, row.current]).sort()).toEqual([
      ["claude-code", "claude-1", "Claude 작업", false],
      [syntheticHost, "synthetic-1", "두 번째 호스트 작업", true],
    ]);
  });

  it("writes only the verified caller's own line, lists the host board and refuses unobserved or self-named callers", async () => {
    const databasePath = boardPath();
    const board = open(databasePath);
    const hookUpdate = { hook_event_name: "PreToolUse", session_id: "s1", cwd: "D:/work/repo", tool_name: "mcp__agent_governance_suite__update_session_status", tool_input: { summary: "릴리스 준비" } };
    expect(handleSessionBoardHook(hookUpdate, board, "claude-code")).toEqual({});
    expect(listSessions(board, new Date().toISOString())).toEqual([]);
    handleSessionBoardHook({ hook_event_name: "SessionStart", session_id: "s1", cwd: "D:/work/repo" }, board, "claude-code");
    const client = await connect(databasePath);
    const binding = { host: "claude-code", sessionId: "s1" };
    const summaryOf = (sessionId: string) => listSessions(board, new Date().toISOString()).find((row) => row.sessionId === sessionId)?.summary;
    const tool = (await client.listTools()).tools.find((item) => item.name === "update_session_status");
    expect(tool?.description).toContain("Do not repeat it for an unchanged task.");
    expect(tool?.description).not.toContain("when a request starts");

    expect(payload(await call(client, "update_session_status", { schemaVersion: "1.0.0", summary: "다른 줄" }, binding))).toMatchObject({ ok: true, data: { sessionId: "s1", summary: "다른 줄", current: true } });
    const recorded = payload(await call(client, "update_session_status", { schemaVersion: "1.0.0", summary: "릴리스 준비" }, binding));
    expect(recorded).toMatchObject({ ok: true, data: { sessionId: "s1", summary: "릴리스 준비", current: true } });
    // A child acts in its root session's name (design 2.1): it writes the root's row, never a row of its own.
    expect(payload(await call(client, "update_session_status", { schemaVersion: "1.0.0", summary: "하위 갱신" }, binding, "sub-1"))).toMatchObject({ ok: true, data: { host: "claude-code", sessionId: "s1", summary: "하위 갱신" } });
    expect(payload(await call(client, "update_session_status", { schemaVersion: "1.0.0", summary: "릴리스 준비" }, binding)).ok).toBe(true);

    const unobserved = payload(await call(client, "update_session_status", { schemaVersion: "1.0.0", summary: "관측 없음" }, null));
    expect(unobserved.error).toMatchObject({ code: "BINDING_REQUIRED", details: { reasonCode: "CALLER_PROVENANCE_UNAVAILABLE" } });
    expect(payload(await call(client, "update_session_status", { summary: "스키마 없음" }, binding)).error?.code).toBe("INVALID_INPUT");
    expect(payload(await call(client, "update_session_status", { schemaVersion: "1.0.0", summary: "둘\n줄" }, binding)).error?.code).toBe("INVALID_INPUT");
    // A caller cannot name another session: a self-supplied binding is refused, and another verified session has no row here.
    for (const identity of [reader, null]) {
      const forged = payload(await call(client, "update_session_status", { schemaVersion: "1.0.0", summary: "위조", _sessionBinding: binding }, identity));
      expect(forged.error).toMatchObject({ code: "INVALID_INPUT", details: { reasonCode: "RESERVED_CALLER_FIELD", field: "_sessionBinding" } });
    }
    expect(payload(await call(client, "update_session_status", { schemaVersion: "1.0.0", summary: "다른 세션" })).error?.code).toBe("MCP_UNAVAILABLE");
    expect(summaryOf("s1")).toBe("릴리스 준비");

    const listed = payload(await call(client, "list_session_status", { schemaVersion: "1.0.0" }));
    expect(listed).toMatchObject({ ok: true, data: { sessions: [{ sessionId: "s1", summary: "릴리스 준비", current: false, presence: { state: "unknown", instanceId: null, wakeVisibility: "none", canWakeSilently: false } }] } });
    expect(payload(await call(client, "list_session_status", { schemaVersion: "1.0.0" }, null)).error?.code).toBe("BINDING_REQUIRED");
    const unavailable = await connect(null);
    expect(payload(await call(unavailable, "list_session_status", { schemaVersion: "1.0.0" })).error?.code).toBe("MCP_UNAVAILABLE");
    const missing = boardPath();
    const absent = await connect(missing);
    expect(payload(await call(absent, "list_session_status", { schemaVersion: "1.0.0" }))).toMatchObject({ ok: true, data: { sessions: [] } });
    expect(payload(await call(absent, "update_session_status", { schemaVersion: "1.0.0", summary: "x" }, binding)).error?.code).toBe("MCP_UNAVAILABLE");
    expect(existsSync(missing)).toBe(false);
  });

  it("overlays matching broker presence and leaves missing sessions unknown", async () => {
    const databasePath = boardPath();
    const board = open(databasePath);
    const now = new Date().toISOString();
    setSummary(board, session(now, "online"), "온라인 작업");
    setSummary(board, session(now, "missing"), "누락 작업");
    setSummary(board, session(now, "unasked"), "묻지 못한 작업");
    const client = await connect(databasePath, sessionMessages({
      schemaVersion: "1.0.0",
      ok: true,
      data: {
        sessions: [{
          host: "claude-code", sessionId: "online", instanceId: "instance-1", transport: "tls", relayLive: true, wakeVisibility: "silent",
          canWakeSilently: true, deliveryCapabilities: { supportedInjection: ["peer-wake", "tool-boundary", "turn-end"], idleWake: "silent" },
          collaborationId: "collaboration-1", workspaceId: "workspace-1", role: "worker",
          startedAt: now, heartbeatAt: now, leaseUntil: now, endedAt: null, endReason: null, state: "online",
        }],
        // A failed batch or an identity the broker would refuse: never asked, so its autoWake stays null.
        unanswered: [{ host: "claude-code", sessionId: "unasked" }],
      },
      error: null,
    }));

    const listed = payload(await call(client, "list_session_status", { schemaVersion: "1.0.0" }));
    const sessions = (listed.data as { sessions: Array<{ sessionId: string; presence: unknown }> }).sessions;
    expect(sessions.find((row) => row.sessionId === "online")?.presence).toEqual({
      host: "claude-code", sessionId: "online", instanceId: "instance-1", transport: "tls", relayLive: true, wakeVisibility: "silent",
      canWakeSilently: true, deliveryCapabilities: { supportedInjection: ["peer-wake", "tool-boundary", "turn-end"], idleWake: "silent" },
      collaborationId: "collaboration-1", workspaceId: "workspace-1", role: "worker",
      startedAt: now, heartbeatAt: now, leaseUntil: now, endedAt: null, endReason: null, state: "online",
    });
    expect(sessions.find((row) => row.sessionId === "missing")?.presence).toEqual({
      host: "claude-code", sessionId: "missing", instanceId: null, transport: null, wakeVisibility: "none",
      canWakeSilently: false, deliveryCapabilities: { supportedInjection: [], idleWake: "none" }, collaborationId: null, workspaceId: null, role: null,
      startedAt: null, heartbeatAt: null, leaseUntil: null, endedAt: null, endReason: null, state: "unknown",
      autoWake: { state: "no-live-relay", reason: "presence-unknown", basisAt: null, checkedAt: expect.any(String), authorityEffect: "none" },
    });
    expect(sessions.find((row) => row.sessionId === "unasked")?.presence).toMatchObject({ state: "unknown", instanceId: null, autoWake: null });
  });

  it("counts instead of listing rows with no summary and no live presence", async () => {
    const databasePath = boardPath();
    const board = open(databasePath);
    const now = new Date().toISOString();
    setSummary(board, session(now, "worker"), "작업 중");
    for (const sessionId of ["child", "online", "caller"]) recordPrompt(board, session(now, sessionId));
    const client = await connect(databasePath, sessionMessages({ schemaVersion: "1.0.0", ok: true, data: { sessions: [{
      host: "claude-code", sessionId: "online", instanceId: "instance-1", transport: "tls", relayLive: true, wakeVisibility: "silent",
      canWakeSilently: true, deliveryCapabilities: { supportedInjection: ["peer-wake"], idleWake: "silent" },
      collaborationId: null, workspaceId: null, role: null,
      startedAt: now, heartbeatAt: now, leaseUntil: now, endedAt: null, endReason: null, state: "online",
    }], unanswered: [] }, error: null }));

    const listed = payload(await call(client, "list_session_status", { schemaVersion: "1.0.0" }, { host: "claude-code", sessionId: "caller" }));
    const data = listed.data as { sessions: Array<{ sessionId: string }>; omittedWithoutSummary: number };
    expect(data.sessions.map((row) => row.sessionId).sort()).toEqual(["caller", "online", "worker"]);
    expect(data.omittedWithoutSummary).toBe(1);
  });
});
