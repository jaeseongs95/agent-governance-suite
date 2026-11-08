import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextLayerService } from "../../mcp-server/src/context-layer-service.js";
import { ContextLayerStore } from "../../mcp-server/src/context-layer-store.js";
import { runContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { runGovernanceHook } from "../../mcp-server/src/governance-hook.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";

// T-0033: a hook process opens these files on every event, so an open of a current file must not queue for the writer lock.
describe("store open from a hook process", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(os.tmpdir(), "ags-hook-open-")); });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  /** Holds the writer lock on another connection and returns what the open threw; waiting for that lock ends in SQLITE_BUSY. */
  function failureUnderWriterLock(file: string, open: () => { close(): void }): unknown {
    const holder = new DatabaseSync(file);
    holder.exec("BEGIN IMMEDIATE;");
    let failure: unknown = null;
    try { open().close(); } catch (cause) { failure = cause; }
    holder.exec("ROLLBACK;");
    holder.close();
    return failure;
  }

  function userVersion(file: string): number {
    const database = new DatabaseSync(file);
    try { return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version; }
    finally { database.close(); }
  }

  function setUserVersion(file: string, version: number): void {
    const database = new DatabaseSync(file);
    try { database.exec(`PRAGMA user_version = ${version};`); }
    finally { database.close(); }
  }

  /** What an open did to a file, in a form two opens can be compared by. */
  function outcome(file: string, open: () => { close(): void }): { failure: string | null; version: number } {
    let failure: string | null = null;
    try { open().close(); } catch (cause) {
      const error = cause as Error & { code?: unknown; reason?: unknown };
      failure = `${error.name}:${String(error.code ?? "")}:${String(error.reason ?? "")}`;
    }
    return { failure, version: userVersion(file) };
  }

  it("opens a current continuity store under another writer's lock", () => {
    const file = path.join(directory, "continuity.sqlite3");
    new SqliteContinuityStore(file).close();
    expect(failureUnderWriterLock(file, () => new SqliteContinuityStore(file, [], { trustCurrentSchema: true }))).toBeNull();
  });

  it("creates the schema when a trusting open finds a new continuity file", () => {
    const file = path.join(directory, "new-continuity.sqlite3");
    const store = new SqliteContinuityStore(file, [], { trustCurrentSchema: true });
    expect(store.getSchemaVersion()).toBeGreaterThan(0);
    store.close();
  });

  it("still refuses a corrupt schema on the verifying open", () => {
    const file = path.join(directory, "foreign.sqlite3");
    new SqliteContinuityStore(file).close();
    const database = new DatabaseSync(file);
    database.exec("ALTER TABLE continuity_observations ADD COLUMN extra TEXT;");
    database.close();
    expect(() => new SqliteContinuityStore(file)).toThrow();
  });

  it("opens a current workflow store under another writer's lock, and creates a new file's schema", () => {
    const file = path.join(directory, "workflows.sqlite3");
    new SqliteWorkflowStore(file).close();
    expect(failureUnderWriterLock(file, () => new SqliteWorkflowStore(file, { trustCurrentSchema: true }))).toBeNull();
    const created = path.join(directory, "new-workflows.sqlite3");
    new SqliteWorkflowStore(created, { trustCurrentSchema: true }).close();
    const database = new DatabaseSync(created);
    expect(database.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name='workflow_runs'").get()).toEqual({ n: 1 });
    database.close();
  });

  it("opens a current context-layer store under another writer's lock and still refuses a foreign file", () => {
    const file = path.join(directory, "context-layers.sqlite3");
    new ContextLayerStore(file).close();
    expect(failureUnderWriterLock(file, () => new ContextLayerStore(file))).toBeNull();
    const foreign = path.join(directory, "foreign-layers.sqlite3");
    const database = new DatabaseSync(foreign);
    database.exec("CREATE TABLE other (id INTEGER);");
    database.close();
    expect(() => new ContextLayerStore(foreign)).toThrow(/holds content/u);
  });

  // A file at another version takes the same path as the verifying open: an older file is migrated, a newer one refused.
  describe.each([
    ["continuity", (file: string, trustCurrentSchema: boolean) => new SqliteContinuityStore(file, [], { trustCurrentSchema })],
    ["workflow", (file: string, trustCurrentSchema: boolean) => new SqliteWorkflowStore(file, { trustCurrentSchema })],
  ] as const)("a trusting open of a %s file at another version", (_name, open) => {
    function atVersion(name: string, offset: number): { file: string; current: number } {
      const file = path.join(directory, name);
      open(file, false).close();
      const current = userVersion(file);
      setUserVersion(file, current + offset);
      return { file, current };
    }

    it("handles an older file as the verifying open does, and does not leave it unconverted", () => {
      const verifying = atVersion("older-verifying.sqlite3", -1);
      const trusting = atVersion("older-trusting.sqlite3", -1);
      const verified = outcome(verifying.file, () => open(verifying.file, false));
      const trusted = outcome(trusting.file, () => open(trusting.file, true));
      expect(trusted).toEqual(verified);
      expect(trusted.failure !== null || trusted.version === trusting.current).toBe(true);
    });

    it("refuses a newer file as the verifying open does", () => {
      const verifying = atVersion("newer-verifying.sqlite3", 50);
      const trusting = atVersion("newer-trusting.sqlite3", 50);
      const verified = outcome(verifying.file, () => open(verifying.file, false));
      const trusted = outcome(trusting.file, () => open(trusting.file, true));
      expect(trusted).toEqual(verified);
      expect(trusted.failure).not.toBeNull();
    });
  });

  describe("which hook verifies the stores", () => {
    function currentStores(): NodeJS.ProcessEnv {
      const environment = {
        AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH: path.join(directory, "layers.sqlite3"),
        AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflow.sqlite3"),
        AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"),
        AGENT_GOVERNANCE_LOCALE: "en",
      };
      new SqliteWorkflowStore(environment.AGENT_GOVERNANCE_DB_PATH).close();
      new SqliteContinuityStore(environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH).close();
      return environment;
    }

    type Initializing = { initializeSchema(...args: unknown[]): void };
    const initializing = (store: { prototype: object }) => vi.spyOn(store.prototype as unknown as Initializing, "initializeSchema");

    it("trusts a current file inside a session and verifies it at a context start", () => {
      const environment = currentStores();
      const continuity = initializing(SqliteContinuityStore);
      const workflow = initializing(SqliteWorkflowStore);
      const opened = vi.spyOn(SqliteContinuityStore.prototype, "getSchemaVersion");
      runContinuityHook(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: os.tmpdir(), tool_name: "Edit", tool_input: { file_path: "a.txt" }, tool_use_id: "c1" }), environment, "claude-code", true);
      expect(opened).toHaveBeenCalled();
      expect(continuity).not.toHaveBeenCalled();
      expect(workflow).not.toHaveBeenCalled();
      runContinuityHook(JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd: os.tmpdir() }), environment, "claude-code", true);
      expect(continuity).toHaveBeenCalled();
      expect(workflow).toHaveBeenCalled();
    });

    it("records a governed call without verifying a current workflow file", async () => {
      const environment = currentStores();
      const workflow = initializing(SqliteWorkflowStore);
      const hook = { hook_event_name: "PreToolUse", session_id: "s2", turn_id: "t2", tool_use_id: "c2", transcript_path: "synthetic-only.jsonl", effort: { level: "high" },
        tool_name: "mcp__agent_governance_suite__plan_workflow", tool_input: { taskId: "hook-open-task" } };
      expect(await runGovernanceHook("claude-code", JSON.stringify(hook), environment)).toEqual({ ok: true, output: "" });
      expect(workflow).not.toHaveBeenCalled();
    });
  });

  it("refreshes a session's activity stamp at a step only once the stamp has aged", () => {
    const file = path.join(directory, "layers.sqlite3");
    new ContextLayerStore(file).close();
    let clock = Date.parse("2026-11-01T00:00:00.000Z");
    const service = new ContextLayerService(create => ContextLayerStore.open(file, create), () => new Date(clock), "http://localhost:47615/");
    const seen = () => {
      const store = new ContextLayerStore(file);
      try { return store.sessionSeen("codex", "s1"); } finally { store.close(); }
    };
    service.hookText("codex", "s1", "actor", true);
    const first = new Date(clock).toISOString();
    expect(seen()).toBe(first);
    clock += 60_000;
    service.hookText("codex", "s1", "actor", false);
    expect(seen()).toBe(first);
    clock += 2 * 3600_000;
    service.hookText("codex", "s1", "actor", false);
    expect(seen()).toBe(new Date(clock).toISOString());
  });
});
