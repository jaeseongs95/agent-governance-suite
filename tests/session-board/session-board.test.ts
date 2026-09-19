import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

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
import { GATE_REASON, handleSessionBoardHook, runSessionBoardHook } from "../../mcp-server/src/session-board-hook.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { CURRENT_VERSION } from "../mcp/version-fixtures.js";

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

  it("gates edits once per request, lets read-only commands and subagents through, and records the line", () => {
    const board = open();
    const run = (hookInput: Record<string, unknown>, minute: number) => handleSessionBoardHook(hookInput, board, "claude-code", at(minute));
    expect(run(input("UserPromptSubmit", { prompt: "비밀 요청 원문" }), 0)).toEqual({});
    expect(run(tool("Bash", { command: "git status" }), 1)).toEqual({});
    expect(run(tool("Edit", {}, { agent_id: "sub-1" }), 2)).toEqual({});
    expect(run(tool("Read"), 3)).toEqual({});
    const denied = run(tool("Bash", { command: "git status && rm x" }), 4);
    expect(decision(denied)).toBe("deny");
    expect((denied.hookSpecificOutput as { permissionDecisionReason: string }).permissionDecisionReason).toBe(GATE_REASON);
    expect(run(tool("Write"), 5)).toEqual({});

    expect(decision(run(tool(boardTool("update_session_status"), { schemaVersion: "1.0.0", summary: "x" }, { agent_id: "sub-1" }), 6))).toBe("deny");
    expect(decision(run(tool(boardTool("update_session_status"), { schemaVersion: "1.0.0", summary: "둘\n줄" }), 7))).toBe("deny");
    const updated = run(tool(boardTool("update_session_status"), { schemaVersion: "1.0.0", summary: "현황판 구현", _sessionBinding: { host: "x", sessionId: "forged" } }), 8);
    expect(updated).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { schemaVersion: "1.0.0", summary: "현황판 구현", _sessionBinding: { host: "claude-code", sessionId: "s1" } } } });

    run(input("UserPromptSubmit"), 9);
    expect(decision(run(tool("Agent"), 10))).toBe("deny");
    const row = listSessions(board, at(11))[0];
    expect(row).toMatchObject({ sessionId: "s1", cwd: "D:/work/repo", summary: "현황판 구현", stale: true });
    expect(JSON.stringify(listSessions(board, at(11)))).not.toContain("비밀 요청 원문");

    const listed = run(tool(boardTool("list_session_status"), { schemaVersion: "1.0.0" }, { agent_id: "sub-1" }), 12);
    expect(listed).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { _sessionBinding: { host: "claude-code", sessionId: "s1" } } } });
  });

  it("denies exactly once when several hook processes race on the same request", async () => {
    const databasePath = boardPath();
    open(databasePath); // The schema exists, so the processes race on the session row itself.
    const bundle = fileURLToPath(new URL("../../mcp-server/dist/session-board-hook.mjs", import.meta.url));
    const hookInput = JSON.stringify(tool("Edit"));
    const outputs = await Promise.all(Array.from({ length: 4 }, () => new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [bundle], { env: { ...process.env, AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: databasePath }, windowsHide: true });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.on("close", (status) => resolve({ status, stdout }));
      child.stdin.end(hookInput);
    })));
    expect(outputs.every((output) => output.status === 0)).toBe(true);
    // Run directly, the bundle is the Codex host: a fresh row whose session start is the request marker.
    expect(outputs.filter((output) => output.stdout.includes('"deny"'))).toHaveLength(1);
  });

  it("points every Codex hook command at a bundle that exists", () => {
    const repository = fileURLToPath(new URL("../../", import.meta.url));
    const config = JSON.parse(readFileSync(path.join(repository, "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string; commandWindows: string }> }>> };
    expect(config.hooks.UserPromptSubmit).toHaveLength(1);
    expect(config.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toContain("session-board-hook.mjs");
    for (const hook of Object.values(config.hooks).flat().flatMap((group) => group.hooks)) {
      const posix = /^node "\$PLUGIN_ROOT\/([^"]+)"$/u.exec(hook.command)?.[1];
      const windows = /^node "\$env:PLUGIN_ROOT\\([^"]+)"$/u.exec(hook.commandWindows)?.[1];
      expect(posix, hook.command).toBeTruthy();
      expect(windows?.split("\\").join("/"), hook.commandWindows).toBe(posix);
      expect(existsSync(path.join(repository, posix!))).toBe(true);
    }
  });

  it("fails open on unreadable input or an unusable board", () => {
    expect(runSessionBoardHook("claude-code", "not json")).toBe("");
    const directory = mkdtempSync(path.join(tmpdir(), "session-board-blocked-"));
    directories.push(directory);
    const blocker = path.join(directory, "file");
    writeFileSync(blocker, "");
    const previous = process.env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH;
    process.env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH = path.join(blocker, "session-board.sqlite3");
    try {
      expect(runSessionBoardHook("claude-code", JSON.stringify(tool("Edit")))).toBe("");
    } finally {
      if (previous === undefined) delete process.env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH;
      else process.env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH = previous;
    }
  });
});

describe("session board MCP tools", () => {
  async function connect(databasePath: string | null): Promise<Client> {
    const validator = new ContractValidator();
    const updates = new InMemoryPluginUpdateStore();
    updates.putPluginUpdateState({
      targetId: "agent-governance-suite", currentVersion: CURRENT_VERSION, latestVersion: CURRENT_VERSION, latestTag: `v${CURRENT_VERSION}`,
      latestCommit: "d".repeat(40), etag: "session-board", comparison: "up-to-date", lastAttemptAt: "2026-09-19T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-09-19T00:00:00.000Z", nextCheckAt: "2099-01-01T00:00:00.000Z", lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null,
    });
    const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore());
    const server = createMcpServer(service, new PluginUpdateService(updates), undefined, undefined, undefined, validator, "default", null, databasePath);
    const client = new Client({ name: "session-board", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }
  const payload = (response: unknown) => JSON.parse((response as { content: Array<{ text: string }> }).content[0]!.text) as { ok: boolean; data: unknown; error: { code: string } | null };

  it("shares one board between the Claude launcher and the Codex hook and lists both hosts", async () => {
    const state = mkdtempSync(path.join(tmpdir(), "session-board-state-"));
    directories.push(state);
    const env: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: state, XDG_STATE_HOME: state, HOME: state, CLAUDE_PLUGIN_DATA: path.join(state, "plugin-data") };
    delete env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH;
    delete env.AGENT_GOVERNANCE_DB_PATH;
    const repository = fileURLToPath(new URL("../../", import.meta.url));
    const update = (sessionId: string, toolName: string, summary: string) => JSON.stringify({ hook_event_name: "PreToolUse", session_id: sessionId, cwd: "D:/work/repo", tool_name: toolName, tool_input: { schemaVersion: "1.0.0", summary } });
    const run = (script: string, input: string) => spawnSync(process.execPath, [path.join(repository, script)], { env, input, encoding: "utf8", windowsHide: true });
    const claude = run("claude-plugin/hooks/session-board-hook.mjs", update("claude-1", "mcp__plugin_agent-governance-suite_agent-governance-suite__update_session_status", "Claude 작업"));
    const codex = run("mcp-server/dist/session-board-hook.mjs", update("codex-1", "mcp__agent-governance-suite__update_session_status", "Codex 작업"));
    expect([claude.status, codex.status]).toEqual([0, 0]);
    expect(claude.stdout).toContain('"host":"claude-code"');
    expect(codex.stdout).toContain('"host":"codex"');
    const shared = resolveSessionBoardDatabasePath(env);
    expect(existsSync(shared)).toBe(true);
    expect(existsSync(env.CLAUDE_PLUGIN_DATA!)).toBe(false);

    const listed = payload(await (await connect(shared)).callTool({ name: "list_session_status", arguments: { schemaVersion: "1.0.0", _sessionBinding: { host: "codex", sessionId: "codex-1" } } }));
    const sessions = (listed.data as { sessions: Array<{ host: string; sessionId: string; summary: string; current: boolean }> }).sessions;
    expect(sessions.map((row) => [row.host, row.sessionId, row.summary, row.current]).sort()).toEqual([
      ["claude-code", "claude-1", "Claude 작업", false],
      ["codex", "codex-1", "Codex 작업", true],
    ]);
  });

  it("reads back the hook-written line, lists the host board and refuses unbound updates", async () => {
    const databasePath = boardPath();
    const board = open(databasePath);
    handleSessionBoardHook({ hook_event_name: "PreToolUse", session_id: "s1", cwd: "D:/work/repo", tool_name: "mcp__x__update_session_status", tool_input: { summary: "릴리스 준비" } }, board, "claude-code");
    const client = await connect(databasePath);
    const binding = { host: "claude-code", sessionId: "s1" };

    const recorded = payload(await client.callTool({ name: "update_session_status", arguments: { schemaVersion: "1.0.0", summary: "릴리스 준비", _sessionBinding: binding } }));
    expect(recorded).toMatchObject({ ok: true, data: { sessionId: "s1", summary: "릴리스 준비", current: true } });
    expect(payload(await client.callTool({ name: "update_session_status", arguments: { schemaVersion: "1.0.0", summary: "다른 줄", _sessionBinding: binding } })).error?.code).toBe("MCP_UNAVAILABLE");
    expect(payload(await client.callTool({ name: "update_session_status", arguments: { schemaVersion: "1.0.0", summary: "릴리스 준비" } })).error?.code).toBe("BINDING_REQUIRED");
    expect(payload(await client.callTool({ name: "update_session_status", arguments: { summary: "릴리스 준비", _sessionBinding: binding } })).error?.code).toBe("INVALID_INPUT");

    const listed = payload(await client.callTool({ name: "list_session_status", arguments: { schemaVersion: "1.0.0" } }));
    expect(listed).toMatchObject({ ok: true, data: { sessions: [{ sessionId: "s1", summary: "릴리스 준비", current: false }] } });
    expect(payload(await (await connect(null)).callTool({ name: "list_session_status", arguments: { schemaVersion: "1.0.0" } })).error?.code).toBe("MCP_UNAVAILABLE");
    const missing = boardPath();
    expect(payload(await (await connect(missing)).callTool({ name: "list_session_status", arguments: { schemaVersion: "1.0.0" } }))).toMatchObject({ ok: true, data: { sessions: [] } });
    expect(payload(await (await connect(missing)).callTool({ name: "update_session_status", arguments: { schemaVersion: "1.0.0", summary: "x", _sessionBinding: binding } })).error?.code).toBe("MCP_UNAVAILABLE");
    expect(existsSync(missing)).toBe(false);
  });
});
