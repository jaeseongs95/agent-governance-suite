import { createHmac } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContinuitySnapshotV1, WorkflowReceiptV1 } from "../../contracts/types.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator, contractSchemas } from "../../mcp-server/src/schema-validator.js";
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
  vi.restoreAllMocks();
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
      continuity.ensureTask("root-protected", "2026-06-01T00:00:00.000Z");
      continuity.checkpoint("root-protected", 1, 0, "request-protected", "command-protected", snapshot("root-protected", "paused"));
      continuity.bindRoot("root-protected", 1, "active-root", "2026-06-01T00:00:00.000Z");

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
      expect(continuity.getSnapshot("root-protected", 1)).not.toBeNull();
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
    expect(workflow.getSchemaVersion()).toBe(5);
    expect(workflow.getRun("legacy")?.state).toBe("passed");
    workflow.close();

    const continuityPath = path.join(directory, "continuity-v1.sqlite3");
    const legacyContinuity = new DatabaseSync(continuityPath);
    legacyContinuity.exec(`
      CREATE TABLE continuity_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE continuity_tasks(
        task_correlation TEXT PRIMARY KEY, current_epoch INTEGER NOT NULL, root_id TEXT, suppressed INTEGER NOT NULL DEFAULT 0,
        last_auto_injected_revision INTEGER, pending_source TEXT, pending_revision INTEGER, pending_digest TEXT,
        pending_root_id TEXT, pending_consumed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      );
      CREATE TABLE continuity_snapshots(
        task_correlation TEXT NOT NULL, epoch INTEGER NOT NULL, revision INTEGER NOT NULL, snapshot_digest TEXT NOT NULL,
        snapshot_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(task_correlation, epoch)
      );
      CREATE TABLE continuity_requests(
        task_correlation TEXT NOT NULL, epoch INTEGER NOT NULL, request_hash TEXT NOT NULL, command_digest TEXT NOT NULL,
        result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_correlation, epoch, request_hash)
      );
      CREATE TABLE continuity_tombstones(
        task_correlation TEXT NOT NULL, epoch INTEGER NOT NULL, revision INTEGER NOT NULL, payload_digest TEXT NOT NULL,
        purged_at TEXT NOT NULL, PRIMARY KEY(task_correlation, epoch)
      );
      CREATE TABLE continuity_observations(
        observation_id INTEGER PRIMARY KEY AUTOINCREMENT, task_correlation TEXT NOT NULL, epoch INTEGER NOT NULL,
        event TEXT NOT NULL, turn_hash TEXT, success INTEGER NOT NULL, observed_at TEXT NOT NULL
      );
      INSERT INTO continuity_metadata VALUES ('signing-secret', 'preserved-secret');
      INSERT INTO continuity_tasks VALUES ('preserved', 2, 'root-preserved', 1, 3, 'direct', 4, 'digest', NULL, 1, '${OLD}');
      INSERT INTO continuity_snapshots VALUES ('preserved', 1, 1, 'sha256:${"c".repeat(64)}', '${JSON.stringify(snapshot("preserved", "paused")).replaceAll("'", "''")}', '${OLD}');
      INSERT INTO continuity_requests VALUES ('preserved', 1, 'request', 'command', '{"kind":"legacy"}', '${OLD}');
      INSERT INTO continuity_tombstones VALUES ('preserved', 2, 2, 'sha256:${"d".repeat(64)}', '${OLD}');
      INSERT INTO continuity_observations(task_correlation, epoch, event, turn_hash, success, observed_at)
        VALUES ('preserved', 2, 'resume', 'turn', 1, '${OLD}');
      PRAGMA user_version = 1;
    `);
    legacyContinuity.close();
    const continuity = new SqliteContinuityStore(continuityPath);
    expect(continuity.getSchemaVersion()).toBe(2);
    expect(continuity.getOrCreateSecret(() => "replacement")).toBe("preserved-secret");
    expect(continuity.getTask("preserved")).toMatchObject({ currentEpoch: 2, rootId: "root-preserved", suppressed: true });
    expect(continuity.getSnapshot("preserved", 1)?.status).toBe("paused");
    expect(continuity.getRequest("preserved", 1, "request")).toEqual({ commandDigest: "command", resultJson: '{"kind":"legacy"}' });
    expect(continuity.getTombstone("preserved", 2)?.payloadDigest).toBe(`sha256:${"d".repeat(64)}`);
    continuity.close();
    const migratedContinuity = new DatabaseSync(continuityPath, { readOnly: true });
    expect((migratedContinuity.prepare("SELECT COUNT(*) AS count FROM continuity_observations").get() as { count: number }).count).toBe(1);
    expect((migratedContinuity.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name LIKE 'continuity_%_cleanup'").get() as { count: number }).count).toBe(5);
    migratedContinuity.close();
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
      expect(result.data?.rootProtection).toEqual(plan.rootProtection);
      expect(result.data?.databases.workflow.deletedRoots).toBe(0);
      expect(workflow.getRun("preserved")).not.toBeNull();
    } finally {
      workflow.close();
    }
  });

  it("keeps a continuity task when a recent child record appears after backup", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "state-cleanup-child-race-"));
    directories.push(directory);
    const workflow = new SqliteWorkflowStore(path.join(directory, "workflows.sqlite3"));
    const continuity = new SqliteContinuityStore(path.join(directory, "continuity.sqlite3"));
    try {
      continuity.ensureTask("raced-task", OLD);
      const service = new StateCleanupService(workflow, continuity, new ContractValidator(), () => new Date(NOW));
      const plan = service.prepare({ schemaVersion: "1.0.0" }).data!;
      const originalBackup = continuity.backupTo.bind(continuity);
      vi.spyOn(continuity, "backupTo").mockImplementationOnce((targetPath) => {
        originalBackup(targetPath);
        const concurrent = new DatabaseSync(continuity.databasePath);
        try {
          concurrent.prepare(`
            INSERT INTO continuity_observations(task_correlation, epoch, event, turn_hash, success, observed_at)
            VALUES (?, 1, 'resume', NULL, 1, ?)
          `).run("raced-task", "2026-09-01T00:00:00.000Z");
        } finally {
          concurrent.close();
        }
      });

      const result = service.execute({ schemaVersion: "1.0.0", planToken: plan.planToken });
      expect(result.ok).toBe(true);
      expect(result.data?.status).toBe("partial");
      expect(result.data?.databases.continuity.status).toBe("failed");
      expect(continuity.getTask("raced-task")).not.toBeNull();
      const raw = new DatabaseSync(continuity.databasePath, { readOnly: true });
      expect((raw.prepare(`
        SELECT COUNT(*) AS count FROM continuity_observations WHERE task_correlation = 'raced-task'
      `).get() as { count: number }).count).toBe(1);
      raw.close();
    } finally {
      continuity.close();
      workflow.close();
    }
  });

  it("keeps continuity state when its workflow root becomes active after preview", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "state-cleanup-root-race-"));
    directories.push(directory);
    const workflowPath = path.join(directory, "workflows.sqlite3");
    const workflow = new SqliteWorkflowStore(workflowPath);
    const continuity = new SqliteContinuityStore(path.join(directory, "continuity.sqlite3"));
    try {
      workflow.insertRun(receipt("recent-root-run"));
      linkRun(workflowPath, "raced-root", "recent-root-run", "completed");
      const raw = new DatabaseSync(workflowPath);
      raw.prepare("UPDATE convergence_roots SET updated_at = ? WHERE root_id = 'raced-root'")
        .run("2026-09-01T00:00:00.000Z");
      raw.close();
      continuity.ensureTask("root-raced-task", OLD);
      continuity.checkpoint("root-raced-task", 1, 0, "request", "command", snapshot("root-raced-task", "paused"));
      continuity.bindRoot("root-raced-task", 1, "raced-root", OLD);
      const continuityRaw = new DatabaseSync(continuity.databasePath);
      continuityRaw.prepare("UPDATE continuity_tasks SET updated_at = ? WHERE task_correlation = 'root-raced-task'")
        .run("2026-09-01T00:00:00.000Z");
      continuityRaw.close();

      const service = new StateCleanupService(workflow, continuity, new ContractValidator(), () => new Date(NOW));
      const plan = service.prepare({ schemaVersion: "1.0.0" }).data!;
      expect(plan.counts.continuitySnapshots).toBe(1);
      const originalBackup = continuity.backupTo.bind(continuity);
      vi.spyOn(continuity, "backupTo").mockImplementationOnce((targetPath) => {
        originalBackup(targetPath);
        const concurrent = new DatabaseSync(workflowPath);
        try {
          concurrent.prepare("UPDATE convergence_roots SET state = 'open' WHERE root_id = 'raced-root'").run();
        } finally {
          concurrent.close();
        }
      });

      const result = service.execute({ schemaVersion: "1.0.0", planToken: plan.planToken });
      expect(result.ok).toBe(true);
      expect(result.data?.status).toBe("partial");
      expect(result.data?.databases.continuity.status).toBe("failed");
      expect(continuity.getSnapshot("root-raced-task", 1)).not.toBeNull();
    } finally {
      continuity.close();
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


async function linkedCleanupFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "state-cleanup-linked-fence-"));
  directories.push(directory);
  const workflowPath = path.join(directory, "workflows.sqlite3");
  const workflow = new SqliteWorkflowStore(workflowPath);
  const other = new SqliteWorkflowStore(workflowPath);
  try {
    for (const id of ["linked-a", "linked-b", "standalone-safe"]) workflow.insertRun(receipt(id));
    linkRun(workflowPath, "terminal-root", "linked-a", "completed");
    const raw = new DatabaseSync(workflowPath);
    try {
      raw.exec("PRAGMA foreign_keys = ON");
      raw.prepare("INSERT INTO convergence_leases(lease_id,root_id,root_revision,epoch,ordinal,state,lease_json,proposal_json,issued_at,expires_at) VALUES ('sibling-lease','terminal-root',1,1,2,'consumed','{}','{}',?,?)").run(OLD, "2027-01-01T00:00:00.000Z");
      raw.prepare("INSERT INTO convergence_attempts(root_id,epoch,ordinal,lease_id,run_id,state,outcome_json,started_at,updated_at) VALUES ('terminal-root',1,2,'sibling-lease','linked-b','passed','{}',?,?)").run(OLD, OLD);
      raw.exec("INSERT INTO workflow_attempt_links(run_id,root_id,lease_id,epoch,ordinal) VALUES ('linked-b','terminal-root','sibling-lease',1,2)");
      raw.prepare("UPDATE workflow_runs SET created_at=?, updated_at=?").run(OLD, OLD);
    } finally { raw.close(); }
    const service = new StateCleanupService(workflow, null, new ContractValidator(), () => new Date(NOW));
    return { workflowPath, workflow, other, service };
  } catch (error) { other.close(); workflow.close(); throw error; }
}
function linkedRowMetadata(workflowPath: string, change: { state?: string; revision?: number; updatedAt?: string }) {
  const raw = new DatabaseSync(workflowPath);
  try {
    const row = raw.prepare("SELECT state,revision,receipt_json,updated_at FROM workflow_runs WHERE run_id='linked-b'").get() as { state: string; revision: number; receipt_json: string; updated_at: string };
    const image = JSON.parse(row.receipt_json) as WorkflowReceiptV1;
    image.state = (change.state ?? row.state) as WorkflowReceiptV1["state"];
    image.plan.state = image.state;
    image.revision = change.revision ?? row.revision;
    raw.prepare("UPDATE workflow_runs SET state=?,revision=?,receipt_json=?,updated_at=? WHERE run_id='linked-b'")
      .run(image.state, image.revision, JSON.stringify(image), change.updatedAt ?? row.updated_at);
  } finally { raw.close(); }
}
function expectLinkedBatchPreserved(workflowPath: string) {
  const raw = new DatabaseSync(workflowPath, { readOnly: true });
  try {
    expect(raw.prepare("SELECT count(*) AS n FROM convergence_roots WHERE root_id='terminal-root'").get()).toMatchObject({ n: 1 });
    expect(raw.prepare("SELECT count(*) AS n FROM workflow_runs").get()).toMatchObject({ n: 3 });
    expect(raw.prepare("SELECT count(*) AS n FROM workflow_attempt_links WHERE root_id='terminal-root'").get()).toMatchObject({ n: 2 });
  } finally { raw.close(); }
}

describe("linked workflow cleanup eligibility and snapshot fence", () => {
  for (const change of [{ state: "running" }, { updatedAt: NOW.toISOString() }]) {
    it("protects the entire terminal root when one sibling run is active or recent: " + JSON.stringify(change), async () => {
      const f = await linkedCleanupFixture();
      try {
        linkedRowMetadata(f.workflowPath, change);
        const plan = f.service.prepare({ schemaVersion: "1.0.0" }).data!;
        expect(plan.candidates.workflowRoots).toEqual([]);
        expect(plan.candidates.standaloneWorkflowRuns.map(run => run.runId)).toEqual(["standalone-safe"]);
        const result = f.service.execute({ schemaVersion: "1.0.0", planToken: plan.planToken });
        expect(result.data?.databases.workflow).toMatchObject({ status: "completed", deletedRoots: 0, deletedRuns: 1 });
        expect(f.workflow.getRun("linked-a")).not.toBeNull();
        expect(f.workflow.getRun("linked-b")).not.toBeNull();
        const raw = new DatabaseSync(f.workflowPath, { readOnly: true });
        try { expect(raw.prepare("SELECT count(*) AS n FROM convergence_roots").get()).toMatchObject({ n: 1 }); }
        finally { raw.close(); }
      } finally { f.other.close(); f.workflow.close(); }
    });
  }

  it("deletes all old terminal siblings and a standalone run under the matching preview", async () => {
    const f = await linkedCleanupFixture();
    try {
      const plan = f.service.prepare({ schemaVersion: "1.0.0" }).data!;
      expect(plan.candidates.workflowRoots[0]?.runIds).toEqual(["linked-a", "linked-b"]);
      const result = f.service.execute({ schemaVersion: "1.0.0", planToken: plan.planToken });
      expect(result.data?.databases.workflow).toMatchObject({ status: "completed", deletedRoots: 1, deletedRuns: 3 });
      for (const id of ["linked-a", "linked-b", "standalone-safe"]) expect(f.workflow.getRun(id)).toBeNull();
      const raw = new DatabaseSync(f.workflowPath, { readOnly: true });
      try {
        expect(raw.prepare("SELECT count(*) AS n FROM convergence_roots WHERE root_id='terminal-root'").get()).toMatchObject({ n: 0 });
        expect(raw.prepare("SELECT count(*) AS n FROM workflow_attempt_links WHERE root_id='terminal-root'").get()).toMatchObject({ n: 0 });
      } finally { raw.close(); }
    } finally { f.other.close(); f.workflow.close(); }
  });

  for (const change of [{ revision: 2 }, { updatedAt: "2025-01-02T00:00:00.000Z" }]) {
    it("invalidates the signed plan for same-ID linked metadata changes before execution: " + JSON.stringify(change), async () => {
      const f = await linkedCleanupFixture();
      try {
        const plan = f.service.prepare({ schemaVersion: "1.0.0" }).data!;
        linkedRowMetadata(f.workflowPath, change);
        const current = f.service.prepare({ schemaVersion: "1.0.0" }).data!;
        expect(current.candidates).toEqual(plan.candidates);
        expect(current.candidateDigest).not.toBe(plan.candidateDigest);
        expect(f.service.execute({ schemaVersion: "1.0.0", planToken: plan.planToken }).error?.code).toBe("STALE_REVISION");
        expectLinkedBatchPreserved(f.workflowPath);
      } finally { f.other.close(); f.workflow.close(); }
    });
  }

  for (const change of ["running-receipt", "timestamp-only"] as const) {
    it("fences a second-connection change after backup and before any batch deletion: " + change, async () => {
      const f = await linkedCleanupFixture();
      try {
        const plan = f.service.prepare({ schemaVersion: "1.0.0" }).data!;
        const backup = f.workflow.backupTo.bind(f.workflow);
        let barrierReached = false;
        vi.spyOn(f.workflow, "backupTo").mockImplementationOnce(target => {
          backup(target);
          if (change === "running-receipt") {
            const changed = receipt("linked-b", "running"); changed.revision = 2;
            expect(f.other.updateRun(changed, 1)).toBe(true);
          } else linkedRowMetadata(f.workflowPath, { updatedAt: "2025-01-02T00:00:00.000Z" });
          barrierReached = true;
        });
        const result = f.service.execute({ schemaVersion: "1.0.0", planToken: plan.planToken });
        expect(barrierReached).toBe(true);
        expect(result.ok).toBe(true);
        expect(result.data?.status).toBe("partial");
        expect(result.data?.databases.workflow).toMatchObject({ status: "failed", deletedRoots: 0, deletedRuns: 0 });
        expect(result.data?.databases.workflow.error).toContain("linked workflow run changed");
        expect(result.data?.rootProtection).toEqual(plan.rootProtection);
        expectLinkedBatchPreserved(f.workflowPath);
      } finally { f.other.close(); f.workflow.close(); }
    });
  }
});


for (const rootState of ["completed", "abandoned"] as const) {
  it("protects a terminal root whose linked receipt is missing: " + rootState, async () => {
    const f = await linkedCleanupFixture();
    try {
      const raw = new DatabaseSync(f.workflowPath);
      try {
        // Reproduce an orphan possible in the standalone legacy store, never an operational DB.
        raw.exec("PRAGMA foreign_keys = OFF");
        raw.prepare("DELETE FROM workflow_runs WHERE run_id='linked-b'").run();
        raw.prepare("UPDATE convergence_roots SET state=? WHERE root_id='terminal-root'").run(rootState);
        expect(raw.prepare("SELECT count(*) AS n FROM workflow_attempt_links WHERE run_id='linked-b'").get()).toMatchObject({ n: 1 });
      } finally { raw.close(); }
      const plan = f.service.prepare({ schemaVersion: "1.0.0" }).data!;
      expect(plan.candidates.workflowRoots).toEqual([]);
      expect(plan.candidates.standaloneWorkflowRuns.map(run => run.runId)).toEqual(["standalone-safe"]);
      const result = f.service.execute({ schemaVersion: "1.0.0", planToken: plan.planToken });
      expect(result.data?.databases.workflow).toMatchObject({ status: "completed", deletedRoots: 0, deletedRuns: 1 });
      expect(f.workflow.getRun("linked-a")).not.toBeNull();
      const after = new DatabaseSync(f.workflowPath, { readOnly: true });
      try {
        expect(after.prepare("SELECT count(*) AS n FROM convergence_roots WHERE root_id='terminal-root'").get()).toMatchObject({ n: 1 });
        expect(after.prepare("SELECT count(*) AS n FROM workflow_attempt_links WHERE root_id='terminal-root'").get()).toMatchObject({ n: 2 });
        expect(after.prepare("SELECT count(*) AS n FROM workflow_attempt_links links LEFT JOIN workflow_runs runs ON runs.run_id=links.run_id WHERE runs.run_id IS NULL").get()).toMatchObject({ n: 1 });
      } finally { after.close(); }
    } finally { f.other.close(); f.workflow.close(); }
  });
}


function resignCleanupFixtureToken(workflow: SqliteWorkflowStore, token: string,
  change: (payload: Record<string, unknown>) => void): string {
  // Deliberately authenticated malformed/legacy tokens in this isolated fixture only.
  const payload = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
  change(payload);
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const secret = workflow.getOrCreateSecret("state-cleanup-signing-key", () => { throw new Error("fixture signing key missing"); });
  const signature = createHmac("sha256", Buffer.from(secret, "base64url")).update(encoded).digest("base64url");
  return encoded + "." + signature;
}

describe("SS01-D1 signed preview root protection diagnostics", () => {
  it("counts each protected root once across duplicate and overlapping linked reasons", async () => {
    const f = await linkedCleanupFixture();
    try {
      for (const id of ["active-one", "active-two", "active-three", "missing-a", "missing-b", "recent-root-run"])
        f.workflow.insertRun(receipt(id));
      linkRun(f.workflowPath, "active-open", "active-one", "open");
      linkRun(f.workflowPath, "active-review", "active-two", "open");
      linkRun(f.workflowPath, "active-user", "active-three", "open");
      linkRun(f.workflowPath, "missing-root-a", "missing-a", "completed");
      linkRun(f.workflowPath, "missing-root-b", "missing-b", "completed");
      linkRun(f.workflowPath, "retained-recent-root", "recent-root-run", "completed");
      const raw = new DatabaseSync(f.workflowPath);
      try {
        raw.exec("PRAGMA foreign_keys = OFF");
        raw.prepare("UPDATE convergence_roots SET state='needs-review' WHERE root_id='active-review'").run();
        raw.prepare("UPDATE convergence_roots SET state='needs-user',updated_at=? WHERE root_id='active-user'").run(NOW.toISOString());
        raw.prepare("UPDATE convergence_roots SET updated_at=? WHERE root_id='retained-recent-root'").run(NOW.toISOString());
        raw.prepare("UPDATE workflow_runs SET state='running',updated_at=? WHERE run_id IN ('linked-a','linked-b')").run(NOW.toISOString());
        raw.exec("DELETE FROM workflow_runs WHERE run_id IN ('missing-a','missing-b')");
      } finally { raw.close(); }
      const plan = f.service.prepare({ schemaVersion: "1.0.0" }).data!;
      expect(plan.counts.protectedActiveRoots).toBe(3);
      expect(plan.rootProtection).toEqual({ previewCreatedAt: NOW.toISOString(), activeRoots: 3,
        linkedNonTerminalRoots: 1, linkedRecentRoots: 1, linkedMissingReceiptRoots: 2, totalProtectedRoots: 6 });
      expect(plan.candidates.workflowRoots).toEqual([]);
      expect(plan.candidates.standaloneWorkflowRuns.map(run => run.runId)).toEqual(["standalone-safe"]);
      const result = f.service.execute({ schemaVersion: "1.0.0", planToken: plan.planToken });
      expect(result.ok).toBe(true);
      expect(result.data?.rootProtection).toEqual(plan.rootProtection);
      expect(result.data?.databases.workflow).toMatchObject({ status: "completed", deletedRoots: 0, deletedRuns: 1 });
      const after = new DatabaseSync(f.workflowPath, { readOnly: true });
      try { expect(after.prepare("SELECT count(*) AS n FROM convergence_roots").get()).toMatchObject({ n: 7 }); }
      finally { after.close(); }
    } finally { f.other.close(); f.workflow.close(); }
  });

  it("keeps cutoff equality eligible and observes zero protection with normal deletion", async () => {
    const f = await linkedCleanupFixture();
    try {
      const cutoff = new Date(NOW.getTime() - 180 * 24 * 60 * 60 * 1000).toISOString();
      linkedRowMetadata(f.workflowPath, { updatedAt: cutoff });
      const plan = f.service.prepare({ schemaVersion: "1.0.0" }).data!;
      expect(plan.rootProtection).toEqual({ previewCreatedAt: NOW.toISOString(), activeRoots: 0,
        linkedNonTerminalRoots: 0, linkedRecentRoots: 0, linkedMissingReceiptRoots: 0, totalProtectedRoots: 0 });
      expect(plan.candidates.workflowRoots[0]?.runIds).toEqual(["linked-a", "linked-b"]);
      const result = f.service.execute({ schemaVersion: "1.0.0", planToken: plan.planToken });
      expect(result.ok).toBe(true);
      expect(result.data?.rootProtection).toEqual(plan.rootProtection);
      expect(result.data?.databases.workflow).toMatchObject({ status: "completed", deletedRoots: 1, deletedRuns: 3 });
      for (const id of ["linked-a", "linked-b", "standalone-safe"]) expect(f.workflow.getRun(id)).toBeNull();
    } finally { f.other.close(); f.workflow.close(); }
  });

  it("copies signed preview counts even if only protected populations change before execution", async () => {
    const f = await linkedCleanupFixture();
    try {
      const plan = f.service.prepare({ schemaVersion: "1.0.0" }).data!;
      f.workflow.insertRun(receipt("new-active"));
      linkRun(f.workflowPath, "new-active-root", "new-active", "open");
      const current = f.service.prepare({ schemaVersion: "1.0.0" }).data!;
      expect(current.candidateDigest).toBe(plan.candidateDigest);
      expect(current.candidates).toEqual(plan.candidates);
      expect(current.rootProtection?.activeRoots).toBe(1);
      expect(plan.rootProtection?.activeRoots).toBe(0);
      const result = f.service.execute({ schemaVersion: "1.0.0", planToken: plan.planToken });
      expect(result.ok).toBe(true);
      expect(result.data?.rootProtection).toEqual(plan.rootProtection);
      expect(result.data?.planId).toBe(plan.planId);
      expect(f.workflow.getRun("new-active")).not.toBeNull();
    } finally { f.other.close(); f.workflow.close(); }
  });

  it("preserves legacy absence as unknown in schemas and authenticated token receipts", async () => {
    const f = await linkedCleanupFixture();
    try {
      const validator = new ContractValidator();
      const plan = f.service.prepare({ schemaVersion: "1.0.0" }).data!;
      const { rootProtection: observed, ...legacyPlan } = plan;
      expect(observed?.totalProtectedRoots).toBe(0);
      expect(() => validator.stateCleanupPlan(legacyPlan)).not.toThrow();
      const token = resignCleanupFixtureToken(f.workflow, plan.planToken, payload => { delete payload.rootProtection; });
      const result = f.service.execute({ schemaVersion: "1.0.0", planToken: token });
      expect(result.ok).toBe(true);
      expect(result.data).not.toHaveProperty("rootProtection");
      expect(result.data?.databases.workflow).toMatchObject({ status: "completed", deletedRoots: 1, deletedRuns: 3 });
      expect(() => validator.stateCleanupReceipt(result.data)).not.toThrow();

      // Model the previous closed schemas by removing only the newly optional property.
      const ajv = new Ajv2020({ strict: false });
      (addFormatsModule as unknown as FormatsPlugin)(ajv);
      const oldPlan = structuredClone(contractSchemas.stateCleanupPlan);
      const oldReceipt = structuredClone(contractSchemas.stateCleanupReceipt);
      delete (oldPlan.properties as Record<string, unknown>).rootProtection;
      delete (oldReceipt.properties as Record<string, unknown>).rootProtection;
      const validatePlan = ajv.compile(oldPlan);
      const validateReceipt = ajv.compile(oldReceipt);
      expect(validatePlan(legacyPlan)).toBe(true);
      expect(validatePlan(plan)).toBe(false);
      expect(validatePlan.errors).toEqual(expect.arrayContaining([expect.objectContaining({ keyword: "additionalProperties" })]));
      expect(validateReceipt(result.data)).toBe(true);
      expect(validateReceipt({ ...result.data, rootProtection: observed })).toBe(false);
      expect(validateReceipt.errors).toEqual(expect.arrayContaining([expect.objectContaining({ keyword: "additionalProperties" })]));
    } finally { f.other.close(); f.workflow.close(); }
  });

  it("rejects partial or invalid authenticated diagnostics before claim, backup or deletion", async () => {
    const f = await linkedCleanupFixture();
    try {
      const plan = f.service.prepare({ schemaVersion: "1.0.0" }).data!;
      const valid = plan.rootProtection!;
      const invalid = [null, {}, { ...valid, activeRoots: -1 }, { ...valid, linkedRecentRoots: 0.5 },
        { ...valid, totalProtectedRoots: "0" }, { ...valid, secret: "fixture-private-marker" },
        { ...valid, previewCreatedAt: "invalid" }, { ...valid, previewCreatedAt: OLD }];
      const claim = vi.spyOn(f.workflow, "claimCleanupPlan");
      const backup = vi.spyOn(f.workflow, "backupTo");
      const deletion = vi.spyOn(f.workflow, "executeCleanup");
      for (const rootProtection of invalid) {
        const token = resignCleanupFixtureToken(f.workflow, plan.planToken, payload => { payload.rootProtection = rootProtection; });
        const result = f.service.execute({ schemaVersion: "1.0.0", planToken: token });
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe("INVALID_INPUT");
        expect(result.data).toBeNull();
        expect(JSON.stringify(result)).not.toContain("fixture-private-marker");
      }
      const [encoded, signature] = plan.planToken.split(".");
      const forgedPayload = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")) as Record<string, unknown>;
      forgedPayload.rootProtection = { ...valid, totalProtectedRoots: 999 };
      const forged = Buffer.from(JSON.stringify(forgedPayload), "utf8").toString("base64url") + "." + signature;
      expect(f.service.execute({ schemaVersion: "1.0.0", planToken: forged }).error?.code).toBe("INVALID_INPUT");
      expect(claim).not.toHaveBeenCalled(); expect(backup).not.toHaveBeenCalled(); expect(deletion).not.toHaveBeenCalled();
      expectLinkedBatchPreserved(f.workflowPath);
      const result = f.service.execute({ schemaVersion: "1.0.0", planToken: plan.planToken });
      expect(result.ok).toBe(true);
      expect(result.data?.databases.workflow.deletedRoots).toBe(1);
    } finally { f.other.close(); f.workflow.close(); }
  });

  it("validates the same closed diagnostic shape on both public output contracts", async () => {
    const f = await linkedCleanupFixture();
    try {
      const validator = new ContractValidator();
      const plan = f.service.prepare({ schemaVersion: "1.0.0" }).data!;
      const result = f.service.execute({ schemaVersion: "1.0.0", planToken: plan.planToken }).data!;
      for (const rootProtection of [{}, { ...plan.rootProtection, activeRoots: -1 },
        { ...plan.rootProtection, linkedMissingReceiptRoots: 1.25 }, { ...plan.rootProtection, rootIds: ["private"] }]) {
        expect(() => validator.stateCleanupPlan({ ...plan, rootProtection })).toThrow();
        expect(() => validator.stateCleanupReceipt({ ...result, rootProtection })).toThrow();
      }
    } finally { f.other.close(); f.workflow.close(); }
  });
});


it("distinguishes authenticated payload, protection shape and preview timestamp failures safely", async () => {
  const f = await linkedCleanupFixture();
  try {
    const plan = f.service.prepare({ schemaVersion: "1.0.0" }).data!;
    const badShape = resignCleanupFixtureToken(f.workflow, plan.planToken, payload => { payload.rootProtection = { private: "diagnostic-private-marker" }; });
    const badTimestamp = resignCleanupFixtureToken(f.workflow, plan.planToken, payload => {
      payload.rootProtection = { ...plan.rootProtection, previewCreatedAt: OLD };
    });
    const secret = f.workflow.getOrCreateSecret("state-cleanup-signing-key", () => { throw new Error("fixture key missing"); });
    const malformed = Buffer.from("{private-json-marker".padEnd(80, " "), "utf8").toString("base64url");
    const signature = createHmac("sha256", Buffer.from(secret, "base64url")).update(malformed).digest("base64url");
    const cases = [
      [malformed + "." + signature, "The state cleanup plan token payload is invalid."],
      [badShape, "The state cleanup plan root protection diagnostics are invalid."],
      [badTimestamp, "The state cleanup plan root protection preview timestamp does not match."],
    ];
    const claim = vi.spyOn(f.workflow, "claimCleanupPlan");
    const backup = vi.spyOn(f.workflow, "backupTo");
    const deletion = vi.spyOn(f.workflow, "executeCleanup");
    for (const [planToken, message] of cases) {
      expect(planToken!.length).toBeGreaterThanOrEqual(80);
      const result = f.service.execute({ schemaVersion: "1.0.0", planToken });
      expect(result.ok).toBe(false); expect(result.data).toBeNull();
      expect(result.error).toMatchObject({ code: "INVALID_INPUT", message });
      expect(JSON.stringify(result)).not.toContain("private-marker");
      expect(JSON.stringify(result)).not.toContain("private-json-marker");
      expect(JSON.stringify(result)).not.toContain("rootId");
    }
    expect(claim).not.toHaveBeenCalled(); expect(backup).not.toHaveBeenCalled(); expect(deletion).not.toHaveBeenCalled();
    expectLinkedBatchPreserved(f.workflowPath);
  } finally { f.other.close(); f.workflow.close(); }
});
