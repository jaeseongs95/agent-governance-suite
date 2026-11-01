import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkflowReceiptV1 } from "../../contracts/types.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-storage-errors-"));
  directories.push(directory);
  return directory;
}

function receipt(runId: string): WorkflowReceiptV1 {
  return {
    schemaVersion: "1.0.0",
    runId,
    revision: 0,
    state: "running",
    plan: {
      schemaVersion: "1.0.0", taskId: "storage-fault", integrityToken: "token", executionMode: "orchestrated",
      state: "running", selectedSkills: [], stages: [], currentStageId: null, nextStageId: null, errors: [],
    },
    stageResults: [], blockers: [], unresolved: [], error: null, unverifiedClaims: [],
  };
}

function capture(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("SqliteWorkflowStore storage failures", () => {
  it("reports a SQLite write failure as a storage error, not invalid input", async () => {
    const directory = await tempDirectory();
    const databasePath = path.join(directory, "workflows.sqlite3");
    const store = new SqliteWorkflowStore(databasePath);
    try {
      const fault = new DatabaseSync(databasePath);
      try {
        fault.exec("CREATE TRIGGER synthetic_storage_fault BEFORE INSERT ON workflow_runs BEGIN SELECT RAISE(ABORT, 'synthetic-storage-fault'); END;");
      } finally {
        fault.close();
      }
      const error = capture(() => store.insertRun(receipt("faulted-run")));
      expect(error).toMatchObject({
        name: "WorkflowContractError",
        code: "MCP_UNAVAILABLE",
        message: "Cannot persist the workflow run.",
        details: {
          runId: "faulted-run",
          reason: "STORE_CONSTRAINT",
          cause: expect.objectContaining({ code: expect.objectContaining({ type: "string" }) }),
        },
      });
      // The public details never carry the database path or the driver message (AGS 3.0 error model R5).
      const serialized = JSON.stringify((error as { details: unknown }).details);
      expect(serialized).not.toContain(directory);
      expect(serialized).not.toContain("synthetic-storage-fault");
      expect(store.getRun("faulted-run")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("reports a corrupt database file as a storage error at initialization", async () => {
    const directory = await tempDirectory();
    const databasePath = path.join(directory, "workflows.sqlite3");
    await writeFile(databasePath, "x".repeat(4096), "utf8");
    const error = capture(() => new SqliteWorkflowStore(databasePath));
    expect(error).toMatchObject({
      code: "MCP_UNAVAILABLE",
      message: "Cannot initialize the workflow database.",
      details: { reason: "STORE_CORRUPT", cause: expect.any(Object) },
    });
    expect(JSON.stringify((error as { details: unknown }).details)).not.toContain(directory);
  });

  it("keeps the original contract code when initialization rejects a newer schema", async () => {
    const directory = await tempDirectory();
    const databasePath = path.join(directory, "workflows.sqlite3");
    const fixture = new DatabaseSync(databasePath);
    try {
      fixture.exec("PRAGMA user_version = 99;");
    } finally {
      fixture.close();
    }
    const error = capture(() => new SqliteWorkflowStore(databasePath));
    expect(error).toMatchObject({
      code: "MCP_UNAVAILABLE",
      message: "Cannot initialize the workflow database.",
      details: { reason: "SCHEMA_NEWER" },
    });
  });
});
