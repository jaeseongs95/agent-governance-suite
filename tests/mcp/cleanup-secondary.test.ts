import { expect, it } from "vitest";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { failureContext } from "../../mcp-server/src/failure-diagnostics.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";

// AGS 3.0 error model P3: a failed ROLLBACK never replaces the primary failure and is never silently dropped.
type Exec = (sql: string) => void;
type Prepare = (sql: string) => unknown;
type Patchable = { database: { exec: Exec; prepare: Prepare } };

function failRollback(store: object): () => void {
  const database = (store as Patchable).database;
  const exec = database.exec.bind(database);
  database.exec = (sql: string) => {
    if (sql.trim().toUpperCase().startsWith("ROLLBACK")) throw new Error("PRIVATE rollback failure text");
    return exec(sql);
  };
  return () => { database.exec = exec; try { exec("ROLLBACK"); } catch { /* Fixture cleanup only: no transaction may remain. */ } };
}

it("workflow store keeps the primary failure and attaches the failed ROLLBACK as a secondary", () => {
  const store = new SqliteWorkflowStore(":memory:");
  const restore = failRollback(store);
  const primary = new Error("primary failure");
  let caught: unknown;
  try { store.withWorkflowTransaction(() => { throw primary; }); }
  catch (error) { caught = error; }
  finally { restore(); }
  try {
    expect(caught).toBe(primary);
    const context = failureContext(caught);
    expect(context.secondary).toEqual([expect.objectContaining({ type: "error", producerReason: "WORKFLOW_ROLLBACK_FAILED" })]);
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  } finally { store.close(); }
});

it("continuity store keeps its wrapped primary failure and attaches the failed ROLLBACK as a secondary", () => {
  const store = new SqliteContinuityStore(":memory:");
  const database = (store as unknown as Patchable).database;
  const prepare = database.prepare.bind(database);
  database.prepare = (sql: string) => {
    if (sql.includes("UPDATE continuity_tasks SET root_id")) throw Object.assign(new Error("PRIVATE primary"), { code: "ERR_SQLITE_ERROR", errcode: 10 });
    return prepare(sql);
  };
  const restore = failRollback(store);
  let caught: unknown;
  try { store.bindRoot("task-fixture", 1, "root-fixture", new Date(0).toISOString()); }
  catch (error) { caught = error; }
  finally { restore(); database.prepare = prepare; }
  try {
    expect(caught).toMatchObject({ name: "ContinuityStoreError", message: "Cannot bind the continuity root.", reason: "STORE_UNAVAILABLE" });
    const context = failureContext(caught);
    expect(context.secondary).toEqual([expect.objectContaining({ type: "error", producerReason: "CONTINUITY_ROLLBACK_FAILED" })]);
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  } finally { store.close(); }
});
