import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextLayerStore } from "../../mcp-server/src/context-layer-store.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";

// T-0033: a hook process opens these files on every event, so an open of a current file must not queue for the writer lock.
describe("store open from a hook process", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(os.tmpdir(), "ags-hook-open-")); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  /** Holds the writer lock on another connection and returns how long the open took and whether it threw. */
  function openUnderWriterLock(file: string, open: () => { close(): void }): { elapsedMs: number; failure: unknown } {
    const holder = new DatabaseSync(file);
    holder.exec("BEGIN IMMEDIATE;");
    const started = performance.now();
    let failure: unknown = null;
    try { open().close(); } catch (cause) { failure = cause; }
    const elapsedMs = performance.now() - started;
    holder.exec("ROLLBACK;");
    holder.close();
    return { elapsedMs, failure };
  }

  it("opens a current continuity store under another writer's lock", () => {
    const file = path.join(directory, "continuity.sqlite3");
    new SqliteContinuityStore(file).close();
    const trusted = openUnderWriterLock(file, () => new SqliteContinuityStore(file, [], { trustCurrentSchema: true }));
    expect(trusted.failure).toBeNull();
    expect(trusted.elapsedMs).toBeLessThan(2000);
  });

  it("creates the schema when a trusting open finds a new continuity file", () => {
    const file = path.join(directory, "new-continuity.sqlite3");
    const store = new SqliteContinuityStore(file, [], { trustCurrentSchema: true });
    expect(store.getSchemaVersion()).toBeGreaterThan(0);
    store.close();
  });

  it("still refuses a corrupt schema on the verifying open a context start uses", () => {
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
    const trusted = openUnderWriterLock(file, () => new SqliteWorkflowStore(file, { trustCurrentSchema: true }));
    expect(trusted.failure).toBeNull();
    expect(trusted.elapsedMs).toBeLessThan(2000);
    const created = path.join(directory, "new-workflows.sqlite3");
    new SqliteWorkflowStore(created, { trustCurrentSchema: true }).close();
    const database = new DatabaseSync(created);
    expect(database.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name='workflow_runs'").get()).toEqual({ n: 1 });
    database.close();
  });

  it("opens a current context-layer store under another writer's lock and still refuses a foreign file", () => {
    const file = path.join(directory, "context-layers.sqlite3");
    new ContextLayerStore(file).close();
    const opened = openUnderWriterLock(file, () => new ContextLayerStore(file));
    expect(opened.failure).toBeNull();
    expect(opened.elapsedMs).toBeLessThan(2000);
    const foreign = path.join(directory, "foreign-layers.sqlite3");
    const database = new DatabaseSync(foreign);
    database.exec("CREATE TABLE other (id INTEGER);");
    database.close();
    expect(() => new ContextLayerStore(foreign)).toThrow(/holds content/u);
  });
});
