import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContinuitySnapshotV1, WorkflowReceiptV1 } from "../../contracts/types.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { StateCleanupService } from "../../mcp-server/src/state-cleanup-service.js";

const directories: string[] = [];
const OLD = "2025-01-01T00:00:00.000Z";
const NOW = new Date("2026-09-14T00:00:00.000Z");

function receipt(runId: string, state: WorkflowReceiptV1["state"] = "passed"): WorkflowReceiptV1 {
  return {
    schemaVersion: "1.0.0",
    runId,
    revision: 1,
    state,
    plan: {
      schemaVersion: "1.0.0", taskId: `task-${runId}`, integrityToken: "token", executionMode: "orchestrated",
      state, selectedSkills: [], stages: [], currentStageId: null, nextStageId: null, errors: [],
    },
    stageResults: [], blockers: [], unresolved: [], error: null,
  };
}

function snapshot(taskCorrelation: string, status: "active" | "paused" | "completed"): ContinuitySnapshotV1 {
  return {
    schemaVersion: "1.0.0", source: "direct", taskCorrelation, epoch: 1, revision: 1, status,
    core: { objective: "test", completionCriteria: [], constraints: [], decisions: [], progress: [], blockers: [], nextActions: [] },
    evidenceRefs: [], snapshotDigest: `sha256:${"a".repeat(64)}`, createdAt: OLD, updatedAt: OLD,
  };
}

function linkRun(databasePath: string, rootId: string, runId: string, state: "open" | "completed"): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000;");
    database.prepare(`
      INSERT INTO convergence_roots(root_id, revision, state, workspace_id, workspace_locator, root_json, created_at, updated_at)
      VALUES (?, 1, ?, ?, ?, '{}', ?, ?)
    `).run(rootId, state, `workspace-${rootId}`, `/tmp/${rootId}`, OLD, OLD);
    database.prepare(`INSERT INTO convergence_epochs(root_id, epoch, frame_digest, created_at) VALUES (?, 1, ?, ?)`)
      .run(rootId, `sha256:${"b".repeat(64)}`, OLD);
    database.prepare(`
      INSERT INTO convergence_leases(lease_id, root_id, root_revision, epoch, ordinal, state, lease_json, proposal_json, issued_at, expires_at)
      VALUES (?, ?, 1, 1, 1, 'consumed', '{}', '{}', ?, ?)
    `).run(`lease-${rootId}`, rootId, OLD, "2027-01-01T00:00:00.000Z");
    database.prepare(`
      INSERT INTO convergence_attempts(root_id, epoch, ordinal, lease_id, run_id, state, outcome_json, started_at, updated_at)
      VALUES (?, 1, 1, ?, ?, 'passed', '{}', ?, ?)
    `).run(rootId, `lease-${rootId}`, runId, OLD, OLD);
    database.prepare(`
      INSERT INTO workflow_attempt_links(run_id, root_id, lease_id, epoch, ordinal)
      VALUES (?, ?, ?, 1, 1)
    `).run(runId, rootId, `lease-${rootId}`);
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("state cleanup", () => {
  it("backs up and deletes only preview-bound inactive terminal state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "state-cleanup-"));
    directories.push(directory);
    const workflowPath = path.join(directory, "workflows.sqlite3");
    const continuityPath = path.join(directory, "continuity.sqlite3");
    const workflow = new SqliteWorkflowStore(workflowPath);
    const continuity = new SqliteContinuityStore(continuityPath);
    try {
      workflow.insertRun(receipt("completed-linked"));
      workflow.insertRun(receipt("active-linked"));
      workflow.insertRun(receipt("standalone"));
      const raw = new DatabaseSync(workflowPath);
      raw.prepare("UPDATE workflow_runs SET created_at = ?, updated_at = ?").run(OLD, OLD);
      raw.close();
      linkRun(workflowPath, "completed-root", "completed-linked", "completed");
      linkRun(workflowPath, "active-root", "active-linked", "open");

      continuity.ensureTask("expired", "2026-06-01T00:00:00.000Z");
      continuity.checkpoint("expired", 1, 0, "request-expired", "command-expired", snapshot("expired", "completed"));
      continuity.ensureTask("old-task", OLD);
      continuity.ensureTask("recent-metadata", OLD);
      continuity.recordObservation("recent-metadata", 1, "resume", null, true, "2026-09-01T00:00:00.000Z");
      continuity.ensureTask("active", OLD);
      continuity.checkpoint("active", 1, 0, "request-active", "command-active", snapshot("active", "active"));

      const service = new StateCleanupService(workflow, continuity, new ContractValidator(), () => new Date(NOW));
      const preview = service.prepare({ schemaVersion: "1.0.0" });
      expect(preview.ok).toBe(true);
      expect(preview.data?.counts).toMatchObject({
        workflowRoots: 1, workflowRuns: 2, continuitySnapshots: 1, continuityTasks: 1, protectedActiveRoots: 1,
      });
      const executed = service.execute({ schemaVersion: "1.0.0", planToken: preview.data!.planToken });
      expect(executed.ok, JSON.stringify(executed.error)).toBe(true);
      expect(executed.data?.status).toBe("completed");
      expect(workflow.getRun("completed-linked")).toBeNull();
      expect(workflow.getRun("standalone")).toBeNull();
      expect(workflow.getRun("active-linked")).not.toBeNull();
      expect(continuity.getSnapshot("expired", 1)).toBeNull();
      expect(continuity.getTombstone("expired", 1)?.payloadDigest).toBe(`sha256:${"a".repeat(64)}`);
      expect(continuity.getSnapshot("active", 1)).not.toBeNull();
      expect(continuity.getTask("old-task")).toBeNull();
      expect(continuity.getTask("recent-metadata")).not.toBeNull();

      const workflowBackup = executed.data!.databases.workflow.backupPath!;
      const continuityBackup = executed.data!.databases.continuity.backupPath!;
      await expect(stat(workflowBackup)).resolves.toBeTruthy();
      await expect(stat(continuityBackup)).resolves.toBeTruthy();
      const backup = new DatabaseSync(workflowBackup, { readOnly: true });
      expect((backup.prepare("SELECT COUNT(*) AS count FROM workflow_runs WHERE run_id = 'standalone'").get() as { count: number }).count).toBe(1);
      backup.close();

      const reused = service.execute({ schemaVersion: "1.0.0", planToken: preview.data!.planToken });
      expect(reused.ok).toBe(false);
      expect(reused.error?.code).toBe("STALE_REVISION");
    } finally {
      continuity.close();
      workflow.close();
    }
  });

  it("rejects stale and tampered tokens before deletion", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "state-cleanup-stale-"));
    directories.push(directory);
    const workflow = new SqliteWorkflowStore(path.join(directory, "workflows.sqlite3"));
    try {
      workflow.insertRun(receipt("candidate"));
      const raw = new DatabaseSync(workflow.databasePath);
      raw.prepare("UPDATE workflow_runs SET created_at = ?, updated_at = ?").run(OLD, OLD);
      raw.close();
      const service = new StateCleanupService(workflow, null, new ContractValidator(), () => new Date(NOW));
      const preview = service.prepare({ schemaVersion: "1.0.0" }).data!;
      const tampered = `${preview.planToken.slice(0, -1)}x`;
      expect(service.execute({ schemaVersion: "1.0.0", planToken: tampered }).error?.code).toBe("INVALID_INPUT");
      const changed = receipt("candidate");
      changed.revision = 2;
      workflow.updateRun(changed, 1);
      expect(service.execute({ schemaVersion: "1.0.0", planToken: preview.planToken }).error?.code).toBe("STALE_REVISION");
      expect(workflow.getRun("candidate")).not.toBeNull();
    } finally {
      workflow.close();
    }
  });

  it("migrates workflow v3 and continuity v1 databases without losing rows", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "state-cleanup-migration-"));
    directories.push(directory);
    const workflowPath = path.join(directory, "workflow-v3.sqlite3");
    const legacyWorkflow = new DatabaseSync(workflowPath);
    legacyWorkflow.exec(`
      CREATE TABLE workflow_runs(run_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, receipt_json TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      PRAGMA user_version = 3;
    `);
    legacyWorkflow.prepare("INSERT INTO workflow_runs VALUES (?, 1, ?, ?)").run("legacy", JSON.stringify(receipt("legacy")), OLD);
    legacyWorkflow.close();
    const workflow = new SqliteWorkflowStore(workflowPath);
    expect(workflow.getSchemaVersion()).toBe(4);
    expect(workflow.getRun("legacy")?.state).toBe("passed");
    workflow.close();

    const continuityPath = path.join(directory, "continuity-v1.sqlite3");
    const legacyContinuity = new DatabaseSync(continuityPath);
    legacyContinuity.exec("CREATE TABLE continuity_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1;");
    legacyContinuity.close();
    const continuity = new SqliteContinuityStore(continuityPath);
    expect(continuity.getSchemaVersion()).toBe(2);
    continuity.ensureTask("preserved", OLD);
    expect(continuity.getTask("preserved")).not.toBeNull();
    continuity.close();
    expect(await readFile(workflowPath)).toBeTruthy();
  });

  it("claims a no-op plan only once across two database connections", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "state-cleanup-claim-"));
    directories.push(directory);
    const databasePath = path.join(directory, "workflows.sqlite3");
    const firstStore = new SqliteWorkflowStore(databasePath);
    const secondStore = new SqliteWorkflowStore(databasePath);
    try {
      const first = new StateCleanupService(firstStore, null, new ContractValidator(), () => new Date(NOW));
      const second = new StateCleanupService(secondStore, null, new ContractValidator(), () => new Date(NOW));
      const plan = first.prepare({ schemaVersion: "1.0.0" }).data!;
      expect(first.execute({ schemaVersion: "1.0.0", planToken: plan.planToken }).data?.status).toBe("no-op");
      const duplicate = second.execute({ schemaVersion: "1.0.0", planToken: plan.planToken });
      expect(duplicate.ok).toBe(false);
      expect(duplicate.error?.code).toBe("STALE_REVISION");
    } finally {
      secondStore.close();
      firstStore.close();
    }
  });

  it("keeps candidates when backup verification fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "state-cleanup-backup-failure-"));
    directories.push(directory);
    const workflow = new SqliteWorkflowStore(path.join(directory, "workflows.sqlite3"));
    try {
      workflow.insertRun(receipt("preserved"));
      const raw = new DatabaseSync(workflow.databasePath);
      raw.prepare("UPDATE workflow_runs SET created_at = ?, updated_at = ?").run(OLD, OLD);
      raw.close();
      const service = new StateCleanupService(workflow, null, new ContractValidator(), () => new Date(NOW));
      const plan = service.prepare({ schemaVersion: "1.0.0" }).data!;
      vi.spyOn(workflow, "backupTo").mockImplementationOnce(() => { throw new Error("simulated backup failure"); });
      const result = service.execute({ schemaVersion: "1.0.0", planToken: plan.planToken });
      expect(result.ok).toBe(true);
      expect(result.data?.status).toBe("partial");
      expect(result.data?.databases.workflow.status).toBe("failed");
      expect(workflow.getRun("preserved")).not.toBeNull();
    } finally {
      workflow.close();
    }
  });

  it("expires an unused plan after fifteen minutes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "state-cleanup-expiry-"));
    directories.push(directory);
    const workflow = new SqliteWorkflowStore(path.join(directory, "workflows.sqlite3"));
    let clock = new Date(NOW);
    try {
      const service = new StateCleanupService(workflow, null, new ContractValidator(), () => new Date(clock));
      const plan = service.prepare({ schemaVersion: "1.0.0" }).data!;
      clock = new Date(NOW.getTime() + 15 * 60 * 1000);
      const expired = service.execute({ schemaVersion: "1.0.0", planToken: plan.planToken });
      expect(expired.ok).toBe(false);
      expect(expired.error?.code).toBe("STALE_REVISION");
    } finally {
      workflow.close();
    }
  });
});
