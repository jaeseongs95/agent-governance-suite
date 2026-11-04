// Session board 3.0 (docs/ags30-session-board-design.md 6.1, U1-U10). Real SQLite throughout; the only replaced boundary
// is the messaging call in the MCP cases, where a real SessionMessageStore answers listCurrentPresence at a fixed clock.
// Clocks are explicit; nothing waits on wall time.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  BOARD_FORMAT_VERSION,
  listPromptMarkers,
  locateRepository,
  openBoard,
  pruneBoard,
  readEntry,
  recordInput,
  setSummary,
} from "../../skills/session-board/scripts/board-store.mjs";
import { hostActorId } from "../../mcp-server/src/host-attestation.js";
import { createInactiveSharedStores } from "../../mcp-server/src/inactive-shared-stores.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { handleSessionBoardHook } from "../../mcp-server/src/session-board-hook.js";
import { SESSION_MESSAGE_MAX_RESPONSE_BYTES } from "../../mcp-server/src/session-message-protocol.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import { PRESENCE_LEASE_MS, PRESENCE_UNREACHABLE_VISIBLE_MS, SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { CURRENT_VERSION, STABLE_VERSION } from "../mcp/version-fixtures.js";
import { callerMeta, metaIngress } from "../helpers/caller.js";
import "../../mcp-server/src/builtin-hook-host-adapters.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const directories: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temp(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "session-board-"));
  directories.push(directory);
  return directory;
}
const boardPath = () => path.join(temp(), "session-board.sqlite3");
function open(file = boardPath()) {
  const board = openBoard(file);
  closers.push(() => { if (board.isOpen) board.close(); });
  return board;
}
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 5, minute)).toISOString();
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const tables = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map((row) => String(row.name));
const LEGACY_SESSIONS = `CREATE TABLE sessions (host TEXT NOT NULL, session_id TEXT NOT NULL, cwd TEXT NOT NULL, summary TEXT, summary_at TEXT,
  last_prompt_at TEXT, denied_for TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (host, session_id)) STRICT;`;

describe("U1 standalone board reset", () => {
  it("resets a 2.x board file to the empty 3.0 format once, then reopens unchanged", () => {
    const file = boardPath();
    const legacy = new DatabaseSync(file);
    legacy.exec(LEGACY_SESSIONS);
    legacy.prepare("INSERT INTO sessions VALUES ('codex', 'ghost', '/w', 'old line', ?, ?, NULL, ?, ?)").run(at(0), at(0), at(0), at(0));
    legacy.close();

    const board = open(file);
    expect(tables(board)).toEqual(["board_sessions"]);
    expect(board.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(BOARD_FORMAT_VERSION).toBe(1);
    expect(readEntry(board, "codex", "ghost")).toBeNull();
    setSummary(board, { host: "codex", sessionId: "kept", now: at(1) }, "3.0 line");
    board.close();

    const reopened = open(file);
    expect(readEntry(reopened, "codex", "kept")).toMatchObject({ summary: "3.0 line", summaryAt: at(1) });
  });

  it.each([
    ["a foreign table next to the old board table", (db: DatabaseSync) => { db.exec(LEGACY_SESSIONS); db.exec("CREATE TABLE messages (id TEXT)"); }],
    ["an unrelated database", (db: DatabaseSync) => db.exec("CREATE TABLE workflow_runs (run_id TEXT PRIMARY KEY)")],
    ["a newer board format", (db: DatabaseSync) => { db.exec("CREATE TABLE board_sessions (x TEXT)"); db.exec("PRAGMA user_version = 2"); }],
  ])("refuses %s and leaves the file bytes untouched", (_label, build) => {
    const file = boardPath();
    const db = new DatabaseSync(file);
    build(db);
    db.close();
    const before = sha(file);
    expect(() => openBoard(file)).toThrow(expect.objectContaining({ code: "BOARD_FOREIGN_DATABASE" }));
    expect(sha(file)).toBe(before);
  });
});

describe("U2 shared board reset", () => {
  const keys = { workflow: Buffer.alloc(32, 1).toString("base64url"), continuity: Buffer.alloc(32, 2).toString("base64url"), trust: Buffer.alloc(32, 3).toString("base64url") };
  const shape = (db: DatabaseSync, names: string[]) => JSON.stringify(names.map((name) => ({ name, columns: db.prepare(`PRAGMA table_info(${name})`).all(),
    sql: (db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name) as { sql?: string } | undefined)?.sql,
    indexes: (db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' AND tbl_name=? ORDER BY name").all(name) as Array<{ name: string }>)
      .map((index) => ({ ...index, columns: db.prepare("SELECT * FROM pragma_index_xinfo(?)").all(index.name) })) })));

  it("empties only the board module when a v0 board is upgraded; every other module keeps its schema and rows", () => {
    const directory = temp();
    const first = createInactiveSharedStores({ directory, mode: "fixture-only", clock: () => 100, syntheticKeys: keys });
    first.workflow.nextRunSequence();
    first.continuity.ensureTask("synthetic-correlation", new Date(100).toISOString());
    first.messaging.send({ sender: { host: "a", sessionId: "s" }, target: { host: "b", sessionId: "r" }, messageId: "kept-message", body: "kept" }, 100);
    const file = first.owner.databasePath;
    first.owner.close();

    // Downgrade the board module to the 2.x layout (version 0, table sessions) with one stale row.
    const legacy = new DatabaseSync(file);
    try {
      legacy.exec("DROP TABLE board_sessions;");
      legacy.exec(LEGACY_SESSIONS);
      legacy.prepare("INSERT INTO sessions VALUES ('codex', 'ghost', '/w', 'old line', ?, ?, NULL, ?, ?)").run(at(0), at(0), at(0), at(0));
      legacy.prepare("UPDATE shared_module_schema SET version = 0, schema_json = ? WHERE module = 'board'").run(shape(legacy, ["sessions"]));
    } finally { legacy.close(); }
    const reader = new DatabaseSync(file, { readOnly: true });
    const others = () => reader.prepare("SELECT module, version, schema_json FROM shared_module_schema WHERE module <> 'board' ORDER BY module").all();
    const otherTables = () => tables(reader).filter((name) => !["sessions", "board_sessions"].includes(name))
      .map((name) => [name, (reader.prepare(`SELECT count(*) AS n FROM ${name}`).get() as { n: number }).n]);
    const before = { modules: others(), counts: otherTables() };
    expect(before.counts).toContainEqual(["messages", 1]);
    expect(before.counts).toContainEqual(["continuity_tasks", 1]);

    const upgraded = createInactiveSharedStores({ directory, mode: "fixture-only", clock: () => 200, syntheticKeys: keys });
    closers.push(() => upgraded.owner.close());
    const snapshot = upgraded.owner.inspect();
    expect(snapshot.modules.find((row) => row.module === "board")?.version).toBe(1);
    expect(snapshot.counts.board_sessions).toBe(0);
    expect(snapshot.counts).not.toHaveProperty("sessions");
    expect({ modules: others(), counts: otherTables() }).toEqual(before);
    reader.close();
    expect(readEntry(upgraded.board, "codex", "ghost")).toBeNull();
  });
});

describe("U3/U4 summary and retention rules", () => {
  const who = { host: "claude-code", sessionId: "s1" };
  it("accepts one bounded line and reports staleness only against an observed prompt", () => {
    const board = open();
    for (const bad of ["", "   ", "둘\n줄", "a\rb", "x".repeat(201), 42]) expect(() => setSummary(board, { ...who, now: at(0) }, bad)).toThrow();
    expect(setSummary(board, { ...who, now: at(1) }, ` ${"x".repeat(200)} `)).toEqual({ summary: "x".repeat(200), summaryAt: at(1) });
    // No prompt observed (e.g. a host without a prompt hook): unknown, never false.
    expect(readEntry(board, who.host, who.sessionId)).toMatchObject({ summaryStale: null, lastPromptAt: null, cwd: null });
    recordInput(board, { ...who, cwd: "/work/a", now: at(2) }, { prompt: true });
    expect(readEntry(board, who.host, who.sessionId)).toMatchObject({ summaryStale: true, lastPromptAt: at(2), cwd: "/work/a" });
    setSummary(board, { ...who, now: at(3) }, "새 줄");
    expect(readEntry(board, who.host, who.sessionId)).toMatchObject({ summary: "새 줄", summaryStale: false, cwd: "/work/a" });
    // A verified wake bell refreshes the directory but is not a new request.
    recordInput(board, { ...who, cwd: "/work/b", now: at(4) }, { prompt: false });
    expect(readEntry(board, who.host, who.sessionId)).toMatchObject({ summaryStale: false, lastPromptAt: at(2), cwd: "/work/b" });
  });

  it("prunes rows not seen for seven days and keeps a six-day-old row", () => {
    const board = open();
    const day = 24 * 60 * 60_000;
    const base = Date.parse(at(0));
    setSummary(board, { host: "h", sessionId: "old", now: new Date(base - 7 * day - 1).toISOString() }, "old");
    setSummary(board, { host: "h", sessionId: "recent", now: new Date(base - 6 * day).toISOString() }, "recent");
    pruneBoard(board, at(0));
    expect(readEntry(board, "h", "old")).toBeNull();
    expect(readEntry(board, "h", "recent")).not.toBeNull();
  });
});

describe("U5 prompt hook", () => {
  const prompt = (extra: Record<string, unknown> = {}) => ({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/work/repo", prompt: "비밀 요청 원문", ...extra });
  it("records only a main prompt's time and directory; child, wake and other events write nothing", () => {
    const board = open();
    for (const event of ["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]) {
      expect(handleSessionBoardHook({ ...prompt(), hook_event_name: event, tool_name: "mcp__agent_governance_suite__update_session_status", tool_input: { summary: "x" } }, board, "codex", at(0))).toEqual({});
    }
    expect(handleSessionBoardHook(prompt({ agent_id: "child" }), board, "codex", at(0))).toEqual({});
    expect(readEntry(board, "codex", "s1")).toBeNull();
    expect(handleSessionBoardHook(prompt(), board, "codex", at(1))).toEqual({});
    expect(readEntry(board, "codex", "s1")).toMatchObject({ cwd: "/work/repo", lastPromptAt: at(1), summary: null });
    handleSessionBoardHook(prompt(), board, "codex", at(2), true);
    expect(readEntry(board, "codex", "s1")).toMatchObject({ lastPromptAt: at(1) });
    expect(JSON.stringify(board.prepare("SELECT * FROM board_sessions").all())).not.toContain("비밀 요청 원문");
  });

  it("registers the board hook only on prompts (no SessionStart or tool registrations)", () => {
    const repository = fileURLToPath(new URL("../../", import.meta.url));
    for (const file of ["hooks/hooks.json", "claude-overlay/hooks/hooks.json"]) {
      const config = JSON.parse(readFileSync(path.join(repository, file), "utf8")) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };
      const events = Object.entries(config.hooks).filter(([, groups]) => JSON.stringify(groups).includes("session-board-hook")).map(([event]) => event);
      expect(events, file).toEqual(["UserPromptSubmit"]);
    }
  });
});

const T = Date.parse(at(30));
function presenceStore() {
  const store = new SessionMessageStore(":memory:");
  closers.push(() => store.close());
  return store;
}
function born(store: SessionMessageStore, sessionId: string, startedMs: number, instanceId = sessionId, workspaceId?: string) {
  store.startPresence({ host: "claude-code", sessionId, instanceId, transport: "claude-inbox", wakeVisibility: "silent", canWakeSilently: true,
    ...(workspaceId ? { workspaceId } : {}) }, startedMs);
}
const self = { host: "claude-code", sessionId: "caller" };

describe("U6 listCurrentPresence", () => {
  it("lists online and recently lapsed current births only, self first whatever its state", () => {
    const store = presenceStore();
    born(store, "online", T - 1000);
    born(store, "ended", T - 2000);
    store.endPresence({ host: "claude-code", sessionId: "ended" }, "session-end", "ended", T - 1500);
    // Lease ends PRESENCE_LEASE_MS after the start; lapse is measured from the lease end.
    born(store, "lapsed-inside", T - PRESENCE_LEASE_MS - PRESENCE_UNREACHABLE_VISIBLE_MS + 1000);
    born(store, "lapsed-outside", T - PRESENCE_LEASE_MS - PRESENCE_UNREACHABLE_VISIBLE_MS - 1000);
    // An older birth that is still live must not show once a newer birth of the session has ended.
    born(store, "rebirth-ended", T - 5000, "a");
    born(store, "rebirth-ended", T - 4000, "b");
    store.endPresence({ host: "claude-code", sessionId: "rebirth-ended" }, "session-end", "b", T - 3000);
    // Restart: the new birth is listed with its own start.
    born(store, "restarted", T - 900_000, "old");
    born(store, "restarted", T - 3000, "new");

    const listed = store.listCurrentPresence(T, self);
    expect(listed.truncated).toBe(0);
    expect(listed.sessions.map((row) => [row.sessionId, row.state])).toEqual([
      ["caller", "unknown"], ["online", "online"], ["restarted", "online"], ["lapsed-inside", "unreachable"],
    ]);
    expect(listed.sessions.find((row) => row.sessionId === "restarted")?.startedAt).toBe(new Date(T - 3000).toISOString());
    expect(store.listCurrentPresence(T, { host: "claude-code", sessionId: "ended" }).sessions[0]).toMatchObject({ sessionId: "ended", state: "ended" });
  });

  it("keeps the reply inside the broker response limit with maximum-length fields and counts the rest", () => {
    const store = presenceStore();
    const sessions = Array.from({ length: 60 }, (_, index) => `s${index}`.padEnd(200, "s"));
    sessions.forEach((sessionId, index) => born(store, sessionId, T - 1000 - index, sessionId.slice(0, 120), "w".repeat(500)));
    const listed = store.listCurrentPresence(T, { host: "claude-code", sessionId: sessions[0]! });
    expect(Buffer.byteLength(`${JSON.stringify({ ok: true, data: listed })}\n`, "utf8")).toBeLessThanOrEqual(SESSION_MESSAGE_MAX_RESPONSE_BYTES);
    expect(listed.sessions.length).toBeGreaterThan(1);
    expect(listed.sessions.length + listed.truncated).toBe(60);
    expect(listed.truncated).toBeGreaterThan(0);
  });
});

describe("U7/U8 MCP board tools", () => {
  // The caller comes only from tools/call `_meta` (docs/ags30-session-binding-design.md 2.1); a child names its agent key.
  const call = async (client: Client, tool: string, args: Record<string, unknown>, identity = self, agentKey?: string) => {
    const response = await client.callTool({ name: tool, arguments: args, _meta: callerMeta(identity, agentKey) });
    return JSON.parse((response as { content: Array<{ text: string }> }).content[0]!.text) as { ok: boolean; data: unknown; error: { code: string; details: Record<string, unknown> | null } | null };
  };
  async function connect(databasePath: string | null, store: SessionMessageStore | null) {
    const validator = new ContractValidator();
    const updates = new InMemoryPluginUpdateStore();
    updates.putPluginUpdateState({
      targetId: "agent-governance-suite", currentVersion: CURRENT_VERSION, latestVersion: STABLE_VERSION, latestTag: `v${STABLE_VERSION}`,
      latestCommit: "d".repeat(40), etag: "session-board", comparison: "up-to-date", lastAttemptAt: "2026-09-19T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-09-19T00:00:00.000Z", nextCheckAt: "2099-01-01T00:00:00.000Z", lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null,
    });
    const messages = new SessionMessageService();
    // The messaging call answered by the real store at clock T; a null store is unavailable messaging.
    messages.listCurrentPresence = async (identity) => {
      if (!store) throw new Error("connect ECONNREFUSED (synthetic broker down)");
      return store.listCurrentPresence(T, identity);
    };
    const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore());
    const server = createMcpServer(service, new PluginUpdateService(updates), undefined, undefined, undefined, validator, "default", null, databasePath, messages, undefined, undefined, metaIngress());
    const client = new Client({ name: "session-board", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, validator };
  }

  it("lists running sessions with location, summary and wake, and never lists an ended session that has a summary", async () => {
    const store = presenceStore();
    const repo = temp();
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(path.join(repo, "src"));
    born(store, "caller", T - 1000);
    born(store, "worker", T - 2000, "worker", path.join(repo, "src"));
    born(store, "gone", T - 3000);
    store.endPresence({ host: "claude-code", sessionId: "gone" }, "session-end", "gone", T - 2500);
    const databasePath = boardPath();
    const board = open(databasePath);
    setSummary(board, { host: "claude-code", sessionId: "gone", now: at(29) }, "끝난 세션의 줄");
    setSummary(board, { host: "claude-code", sessionId: "worker", now: at(28) }, "릴리스 준비");
    recordInput(board, { host: "claude-code", sessionId: "worker", cwd: null, now: at(29) }, { prompt: true });
    board.close();

    const { client, validator } = await connect(databasePath, store);
    const listed = await call(client, "list_session_status", { schemaVersion: "1.0.0" });
    expect(listed.ok).toBe(true);
    expect(validator.sessionBoardList(listed.data)).toBeTruthy();
    const data = listed.data as { sessions: Array<Record<string, unknown>>; truncated: number; board: unknown };
    expect(data.sessions.map((row) => row.sessionId)).toEqual(["caller", "worker"]);
    expect(data.board).toEqual({ status: "ok" });
    expect(data.sessions[0]).toMatchObject({ current: true, presence: "online", summary: null, summaryStale: null });
    expect(data.sessions[1]).toEqual({
      host: "claude-code", sessionId: "worker", current: false, presence: "online",
      startedAt: new Date(T - 2000).toISOString(), lastSeenAt: new Date(T - 2000).toISOString(),
      cwd: path.join(repo, "src"), repo: { root: repo, repoId: realpathSync(path.join(repo, ".git")), branch: "main" },
      summary: "릴리스 준비", summaryAt: at(28), summaryStale: true, lastPromptAt: at(29),
      wake: { state: "unsupported", reason: "no-idle-wake" },
    });
  });

  it("reports missing liveness instead of guessing, and lists without summaries when only the board file is unreadable", async () => {
    const down = await connect(boardPath(), null);
    expect(await call(down.client, "list_session_status", { schemaVersion: "1.0.0" })).toMatchObject({ ok: false, error: { code: "MCP_UNAVAILABLE", details: { step: "presence" } } });

    const store = presenceStore();
    born(store, "caller", T - 1000);
    const damaged = boardPath();
    writeFileSync(damaged, "x".repeat(4096));
    const { client, validator } = await connect(damaged, store);
    const listed = await call(client, "list_session_status", { schemaVersion: "1.0.0" });
    expect(listed).toMatchObject({ ok: true, data: { sessions: [{ sessionId: "caller", presence: "online", summary: null }], board: { status: "unavailable", step: "open" } } });
    expect(validator.sessionBoardList(listed.data)).toBeTruthy();

    const missing = boardPath();
    const absent = await connect(missing, store);
    expect(await call(absent.client, "list_session_status", { schemaVersion: "1.0.0" })).toMatchObject({ ok: true, data: { board: { status: "ok" } } });
    expect(existsSync(missing)).toBe(false);
  });

  it("writes the summary under the verified binding, creates the file, and reports an unwritable board", async () => {
    const databasePath = boardPath();
    const { client } = await connect(databasePath, presenceStore());
    const written = await call(client, "update_session_status", { schemaVersion: "1.0.0", summary: "현황판 구현" });
    expect(written).toMatchObject({ ok: true, data: { summary: "현황판 구현", summaryAt: expect.any(String) } });
    const board = open(databasePath);
    expect(readEntry(board, self.host, self.sessionId)).toMatchObject({ summary: "현황판 구현" });
    // A child acts in its root session's name (session binding 2.1): it writes the root's line, never one of its own.
    expect(await call(client, "update_session_status", { schemaVersion: "1.0.0", summary: "하위 갱신" }, self, "sub-1"))
      .toMatchObject({ ok: true, data: { summary: "하위 갱신" } });
    expect(readEntry(board, self.host, self.sessionId)).toMatchObject({ summary: "하위 갱신" });
    // A call whose caller the host did not observe is refused; nothing is written.
    const unobserved = await client.callTool({ name: "update_session_status", arguments: { schemaVersion: "1.0.0", summary: "x" } });
    expect(JSON.parse((unobserved as { content: Array<{ text: string }> }).content[0]!.text))
      .toMatchObject({ ok: false, error: { code: "BINDING_REQUIRED", details: { reasonCode: "CALLER_PROVENANCE_UNAVAILABLE" } } });
    // Identity is host-owned: a caller-supplied binding is a reserved argument (session binding 2.1).
    expect(await call(client, "update_session_status", { schemaVersion: "1.0.0", summary: "x", _sessionBinding: { host: "x", sessionId: "y" } }))
      .toMatchObject({ ok: false, error: { code: "INVALID_INPUT", details: { reasonCode: "RESERVED_CALLER_FIELD", field: "_sessionBinding" } } });
    expect(readEntry(board, self.host, self.sessionId)).toMatchObject({ summary: "하위 갱신" });

    const blocker = path.join(temp(), "file");
    writeFileSync(blocker, "");
    const blocked = await connect(path.join(blocker, "session-board.sqlite3"), presenceStore());
    expect(await call(blocked.client, "update_session_status", { schemaVersion: "1.0.0", summary: "x" })).toMatchObject({ ok: false, error: { code: "MCP_UNAVAILABLE", details: { step: "open" } } });
  });

  // R9 (docs/ags30-session-board-design.md 6): each answer names the step that actually failed. A board the server can
  // read but not write (Linux chmod 0444) still lists its summary with board.status "ok"; an update fails at "write".
  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)("R9: a read-only board still lists its summary, and an update reports the write step", async () => {
    const store = presenceStore();
    born(store, "caller", T - 1000);
    const databasePath = boardPath();
    const { client } = await connect(databasePath, store);
    expect(await call(client, "update_session_status", { schemaVersion: "1.0.0", summary: "읽기 전용 전" })).toMatchObject({ ok: true });
    chmodSync(databasePath, 0o444);
    expect(await call(client, "list_session_status", { schemaVersion: "1.0.0" }))
      .toMatchObject({ ok: true, data: { sessions: [{ sessionId: "caller", summary: "읽기 전용 전" }], board: { status: "ok" } } });
    expect(await call(client, "update_session_status", { schemaVersion: "1.0.0", summary: "x" }))
      .toMatchObject({ ok: false, error: { code: "MCP_UNAVAILABLE", details: { step: "write" } } });
  });
});

describe("U5/D5 repository location", () => {
  it("reads branch and a worktree-shared repository id from git files only", () => {
    const repo = temp();
    mkdirSync(path.join(repo, ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(repo, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/feat/board\n");
    writeFileSync(path.join(repo, ".git", "worktrees", "wt", "commondir"), "../..\n");
    const worktree = temp();
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "wt")}\n`);
    mkdirSync(path.join(worktree, "a", "b"), { recursive: true });
    const detached = temp();
    mkdirSync(path.join(detached, ".git"));
    writeFileSync(path.join(detached, ".git", "HEAD"), `${"a".repeat(40)}\n`);

    const main = locateRepository(repo);
    const linked = locateRepository(path.join(worktree, "a", "b"));
    expect(main).toEqual({ root: repo, repoId: realpathSync(path.join(repo, ".git")), branch: "main" });
    expect(linked).toEqual({ root: worktree, repoId: main!.repoId, branch: "feat/board" });
    expect(locateRepository(detached)).toMatchObject({ branch: null });
    expect(locateRepository(temp())).toBeNull();
    expect(locateRepository(null)).toBeNull();
    expect(locateRepository("relative/path")).toBeNull();
  });
});

describe("U10 classification prompt marker", () => {
  it("exposes the prompt marker by actor and keeps it across a verified wake", () => {
    const board = open();
    const input = { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/w", prompt: "요청" };
    handleSessionBoardHook(input, board, "claude-code", at(1));
    const marker = () => listPromptMarkers(board).find((row) => hostActorId(row.host, row.sessionId) === hostActorId("claude-code", "s1"))?.lastPromptAt;
    expect(marker()).toBe(at(1));
    handleSessionBoardHook(input, board, "claude-code", at(2), true);
    expect(marker()).toBe(at(1));
    handleSessionBoardHook(input, board, "claude-code", at(3));
    expect(marker()).toBe(at(3));
  });
});
