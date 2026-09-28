import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiResultV1, CheckpointContextRequestV1 } from "../../contracts/types.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { CURRENT_VERSION } from "../mcp/version-fixtures.js";

// Schema 3 addition from 152de1bf5a6a765c2cc0459f263c6daeee1ce0ea; no delta runtime is backported.
const DELTA_SCHEMA = `CREATE TABLE continuity_delta_state (
  task_correlation TEXT NOT NULL, epoch INTEGER NOT NULL,
  receiver_host TEXT NOT NULL, receiver_session TEXT NOT NULL, receiver_instance TEXT NOT NULL,
  context_generation INTEGER NOT NULL CHECK (context_generation >= 0),
  sequence INTEGER NOT NULL CHECK (sequence >= 0), origin_digest TEXT NOT NULL,
  checkpoint_digest TEXT NOT NULL, checkpoint_json TEXT NOT NULL,
  last_delta_digest TEXT, state_ack_json TEXT, PRIMARY KEY(task_correlation, epoch)
); PRAGMA user_version = 3;`;
const OLD = "2025-01-01T00:00:00.000Z";
const NOW = "2026-09-28T02:00:00.000Z";
const directories: string[] = [];
const stores: SqliteContinuityStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("ags-v271-")) {
      throw new Error("Refusing to remove a directory outside the compatibility fixture scope.");
    }
    rmSync(resolved, { recursive: true, force: true });
  }
});

function fixture(version = 2) {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-v271-"));
  directories.push(directory);
  const databasePath = path.join(directory, "continuity.sqlite3");
  const initial = new SqliteContinuityStore(databasePath);
  initial.close();
  const raw = new DatabaseSync(databasePath);
  if (version === 3) raw.exec(DELTA_SCHEMA);
  else if (version > 3) raw.exec(`PRAGMA user_version = ${version};`);
  raw.close();
  return { directory, databasePath };
}

function open(databasePath: string) {
  const store = new SqliteContinuityStore(databasePath);
  stores.push(store);
  const service = new ContinuityService(store, new ContractValidator(), null, () => new Date(NOW));
  return { store, service };
}

function input(requestId = "checkpoint-1", expectedRevision = 0): Omit<CheckpointContextRequestV1, "_continuityBinding"> {
  return {
    schemaVersion: "1.0.0", requestId, expectedRevision, status: "completed",
    core: { objective: "fixture body must stay private", completionCriteria: ["preserve state"], constraints: [],
      decisions: [], progress: [], blockers: [], nextActions: [] }, evidenceRefs: [],
  };
}

function bound(service: ContinuityService, tool: string, value: Record<string, unknown>, session = "compat-session") {
  return { ...value, _continuityBinding: service.issueToolBinding(session, tool, value) };
}

function state(databasePath: string) {
  const raw = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'continuity_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return { version: raw.prepare("PRAGMA user_version").get(),
      tables: Object.fromEntries(tables.map(({ name }) => [name, raw.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()])) };
  } finally { raw.close(); }
}

function attachReceiver(databasePath: string, correlation: string, epoch = 1) {
  const raw = new DatabaseSync(databasePath);
  try {
    raw.prepare(`INSERT INTO continuity_delta_state VALUES (?, ?, 'future-host', 'receiver-session', 'receiver-instance',
      2, 1, 'origin', 'target', '{"receiverBody":"must remain private"}', 'delta', '{"stateAck":true}')`)
      .run(correlation, epoch);
  } finally { raw.close(); }
}

function initializationReason(databasePath: string) {
  try { const store = new SqliteContinuityStore(databasePath); store.close(); return null; }
  catch (error) { return (error as { reason?: string }).reason; }
}

describe("2.7.x continuity schema compatibility", () => {
  it.each([2, 3])("preserves schema %i state across reopen, restore, CAS, purge and epoch rotation", (version) => {
    const { databasePath } = fixture(version);
    const first = open(databasePath);
    const checkpoint = first.service.checkpointContext(bound(first.service, "checkpoint_context", input())).data!;
    first.service.markPreCompact("compat-session");
    first.store.recordObservation(checkpoint.taskCorrelation, 1, "post-compact", "opaque-turn", true, NOW);
    first.store.close();
    const before = state(databasePath);
    const second = open(databasePath);
    expect(state(databasePath)).toEqual(before);
    const candidate = second.service.inspectContext(bound(second.service, "inspect_context", { schemaVersion: "1.0.0" })).data!;
    expect(candidate.summary?.revision).toBe(1);
    const load = { schemaVersion: "1.0.0", candidateToken: candidate.restoreToken!, epoch: 1,
      revision: 1, digest: checkpoint.snapshotDigest };
    expect(second.service.loadContext(bound(second.service, "load_context", load)).data).toEqual(checkpoint);
    expect(second.service.checkpointContext(bound(second.service, "checkpoint_context", input())).data).toEqual(checkpoint);
    const replacement = second.service.checkpointContext(bound(second.service, "checkpoint_context", input("replace", 1))).data!;
    expect(replacement.revision).toBe(2);
    expect(second.service.checkpointContext(bound(second.service, "checkpoint_context", input("loser", 1))).error?.code).toBe("STALE_REVISION");
    const purge = { schemaVersion: "1.0.0", requestId: "purge", expectedEpoch: 1, expectedRevision: 2 };
    expect(second.service.purgeDirectContext(bound(second.service, "purge_direct_context", purge)).data?.purged).toBe(true);
    expect(second.store.getTombstone(checkpoint.taskCorrelation, 1)?.revision).toBe(2);
    expect(second.service.checkpointContext(bound(second.service, "checkpoint_context", input("after-purge", 2))).data?.revision).toBe(3);
    expect(second.service.clearSession("compat-session").currentEpoch).toBe(2);
    expect(second.store.getSchemaVersion()).toBe(version);
    if (version === 3) expect(state(databasePath).tables.continuity_delta_state).toEqual([]);
  });

  it("creates new databases as schema 2", () => {
    const { directory } = fixture();
    expect(open(path.join(directory, "new.sqlite3")).store.getSchemaVersion()).toBe(2);
  });

  it("preserves receiver-owned tasks, refuses stale origins and keeps unrelated tasks usable", () => {
    const { databasePath } = fixture(3);
    const { store, service } = open(databasePath);
    const snapshot = service.checkpointContext(bound(service, "checkpoint_context", input())).data!;
    service.markPreCompact("compat-session");
    const inspect = bound(service, "inspect_context", { schemaVersion: "1.0.0" });
    const checkpoint = bound(service, "checkpoint_context", input("replace", 1));
    const suppress = bound(service, "suppress_context_restore", { schemaVersion: "1.0.0", expectedEpoch: 1 });
    const purge = bound(service, "purge_direct_context", { schemaVersion: "1.0.0", requestId: "purge", expectedEpoch: 1, expectedRevision: 1 });
    attachReceiver(databasePath, snapshot.taskCorrelation);
    const before = state(databasePath);
    const hook = handleContinuityHook({ hook_event_name: "PreToolUse", session_id: "compat-session",
      tool_name: "mcp__agent-governance-suite__inspect_context", tool_input: { schemaVersion: "1.0.0" } }, service);
    const hookInput = (hook.hookSpecificOutput as { updatedInput: Record<string, unknown> }).updatedInput;
    expect(hookInput._continuityBinding).toEqual(expect.any(String));
    expect(service.inspectContext(hookInput).error?.details).toEqual({ reason: "RECEIVER_STATE_UNSUPPORTED" });
    for (const result of [service.inspectContext(inspect), service.checkpointContext(checkpoint),
      service.suppressContextRestore(suppress), service.purgeDirectContext(purge)]) {
      expect(result).toMatchObject({ ok: false, data: null, error: { code: "CONTINUITY_UNAVAILABLE", details: { reason: "RECEIVER_STATE_UNSUPPORTED" } } });
      expect(JSON.stringify(result)).not.toContain("fixture body");
      expect(JSON.stringify(result)).not.toContain("receiverBody");
    }
    for (const operation of [() => service.clearSession("compat-session"), () => service.markPreCompact("compat-session"),
      () => service.compactContext("compat-session"), () => store.bindRoot(snapshot.taskCorrelation, 1, "new-root", NOW),
      () => store.recordObservation(snapshot.taskCorrelation, 1, "post-compact", null, true, NOW)]) {
      expect(operation).toThrow();
    }
    expect(state(databasePath)).toEqual(before);
    const restarted = open(databasePath);
    expect(restarted.service.inspectContext(inspect).error?.code).toBe("CONTINUITY_UNAVAILABLE");
    expect(state(databasePath)).toEqual(before);
    expect(service.checkpointContext(bound(service, "checkpoint_context", input(), "unrelated-session")).ok).toBe(true);
    expect(state(databasePath).tables.continuity_delta_state).toEqual(before.tables.continuity_delta_state);
  });

  it("checks receiver state inside the checkpoint transaction after service preflight", () => {
    const { databasePath } = fixture(3);
    const { store, service } = open(databasePath);
    const checkpoint = service.checkpointContext(bound(service, "checkpoint_context", input())).data!;
    const request = bound(service, "checkpoint_context", input("replace", 1));
    const commit = store.checkpoint.bind(store);
    let before: ReturnType<typeof state> | undefined;
    const spy = vi.spyOn(store, "checkpoint").mockImplementationOnce((...args) => {
      // A real separate process publishes receiver state after the service's initial snapshot read.
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(process.argv[1]);
        db.exec('BEGIN IMMEDIATE');
        db.prepare("INSERT INTO continuity_delta_state VALUES (?,1,'host','session','instance',1,0,'origin','target','{}',NULL,NULL)").run(process.argv[2]);
        db.exec('COMMIT'); db.close();
      `, databasePath, checkpoint.taskCorrelation], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
      expect(child.status, child.stderr).toBe(0);
      before = state(databasePath);
      return commit(...args);
    });
    try {
      expect(service.checkpointContext(request).error).toMatchObject({ code: "CONTINUITY_UNAVAILABLE",
        details: { reason: "RECEIVER_STATE_UNSUPPORTED" } });
      expect(state(databasePath)).toEqual(before);
    } finally { spy.mockRestore(); }
  });

  it("detects a schema 3 receiver added by another connection after opening schema 2", () => {
    const { databasePath } = fixture();
    const { service } = open(databasePath);
    const checkpoint = service.checkpointContext(bound(service, "checkpoint_context", input())).data!;
    const request = bound(service, "checkpoint_context", input("replace", 1));
    const raw = new DatabaseSync(databasePath);
    raw.exec(DELTA_SCHEMA); raw.close();
    attachReceiver(databasePath, checkpoint.taskCorrelation);
    const before = state(databasePath);
    expect(service.checkpointContext(request).error?.code).toBe("CONTINUITY_UNAVAILABLE");
    expect(state(databasePath)).toEqual(before);
  });

  it.each(["snapshot", "task"])("protects receiver state added after %s cleanup preview", (scope) => {
    const { databasePath } = fixture(3);
    const { store, service } = open(databasePath);
    const checkpoint = service.checkpointContext(bound(service, "checkpoint_context", input())).data!;
    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE continuity_snapshots SET updated_at = ?").run(OLD);
    raw.prepare("UPDATE continuity_tasks SET updated_at = ?").run(scope === "snapshot" ? NOW : OLD);
    raw.prepare("UPDATE continuity_requests SET created_at = ?").run(OLD); raw.close();
    const preview = store.previewCleanup(NOW, OLD);
    expect(scope === "snapshot" ? preview.snapshots.length : preview.tasks.length).toBe(1);
    attachReceiver(databasePath, checkpoint.taskCorrelation);
    const before = state(databasePath);
    expect(() => store.executeCleanup(preview, NOW, NOW, OLD)).toThrow();
    expect(state(databasePath)).toEqual(before);
    expect(store.previewCleanup(NOW, NOW)).toMatchObject({ snapshots: [], tasks: [] });
  });

  it("rejects incompatible schema 3 without repairing or downgrading it", () => {
    const { databasePath } = fixture(3);
    const raw = new DatabaseSync(databasePath);
    raw.exec("ALTER TABLE continuity_delta_state RENAME COLUMN sequence TO incompatible_sequence;"); raw.close();
    const before = state(databasePath);
    expect(initializationReason(databasePath)).toBe("INCOMPATIBLE_SCHEMA");
    expect(state(databasePath)).toEqual(before);
  });

  it("rejects changed schema 3 defaults instead of changing task suppression implicitly", () => {
    const { databasePath } = fixture(3);
    const raw = new DatabaseSync(databasePath);
    try {
      const ddl = (raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'continuity_tasks'").get() as { sql: string }).sql;
      raw.exec("DROP TABLE continuity_tasks;");
      raw.exec(ddl.replace("DEFAULT 0", "DEFAULT 1"));
    } finally { raw.close(); }
    const before = state(databasePath);
    expect(initializationReason(databasePath)).toBe("INCOMPATIBLE_SCHEMA");
    expect(state(databasePath)).toEqual(before);
  });

  it("rejects missing schema 3 tables and future schemas without creating state", () => {
    for (const version of [3, 4]) {
      const { databasePath } = fixture(version);
      if (version === 3) { const raw = new DatabaseSync(databasePath); raw.exec("DROP TABLE continuity_tasks;"); raw.close(); }
      const before = state(databasePath);
      expect(initializationReason(databasePath)).toBe(version === 3 ? "INCOMPATIBLE_SCHEMA" : "UNSUPPORTED_SCHEMA");
      expect(state(databasePath)).toEqual(before);
    }
  });

  it("rejects damaged bytes without replacing the database", () => {
    const { directory } = fixture();
    const databasePath = path.join(directory, "corrupt.sqlite3");
    writeFileSync(databasePath, "not a sqlite database: private checkpoint body", "utf8");
    const before = readFileSync(databasePath);
    expect(initializationReason(databasePath)).toBe("CORRUPT_DATABASE");
    expect(readFileSync(databasePath)).toEqual(before);
  });

  it("rejects a schema 3 database with valid column definitions and malformed pages", () => {
    const { databasePath } = fixture(3);
    const raw = new DatabaseSync(databasePath);
    let rootPage: number;
    try {
      rootPage = (raw.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'continuity_tasks'").get() as { rootpage: number }).rootpage;
    } finally { raw.close(); }
    // Corrupt one isolated, closed fixture table page while retaining its schema and database header.
    const damaged = readFileSync(databasePath);
    const pageSize = damaged.readUInt16BE(16) || 65536;
    damaged[(rootPage - 1) * pageSize] = 0xff;
    writeFileSync(databasePath, damaged);
    const before = readFileSync(databasePath);
    expect(initializationReason(databasePath)).toBe("CORRUPT_DATABASE");
    expect(readFileSync(databasePath)).toEqual(before);
  });
});

describe("source STDIO continuity startup diagnostics", () => {
  it.each(["healthy", "receiver", "future", "incompatible", "corrupt"])("keeps normal MCP usable when continuity is %s", async (kind) => {
    const { directory, databasePath } = fixture(kind === "future" ? 4 : 3);
    if (kind === "corrupt") writeFileSync(databasePath, "private body: not a database", "utf8");
    if (kind === "incompatible") {
      const raw = new DatabaseSync(databasePath); raw.exec("DROP TABLE continuity_delta_state;"); raw.close();
    }
    const issuer = kind === "healthy" || kind === "receiver" ? new ContinuityService(open(databasePath).store, new ContractValidator()) : null;
    const saved = issuer?.checkpointContext(bound(issuer, "checkpoint_context", input())).data;
    if (kind === "receiver") attachReceiver(databasePath, saved!.taskCorrelation);
    const beforeReceiver = kind === "receiver" ? state(databasePath) : null;
    const environment = getDefaultEnvironment();
    environment.AGENT_GOVERNANCE_DB_PATH = path.join(directory, "workflow.sqlite3");
    environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH = databasePath;
    environment.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH = path.join(directory, "board.sqlite3");
    environment.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR = path.join(directory, "messaging");
    environment.AGENT_GOVERNANCE_TRUST_DB_PATH = path.join(directory, "trust.sqlite3");
    const hookArguments = (tool: string, value: Record<string, unknown>) => {
      const hook = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../mcp-server/src/continuity-hook.ts", import.meta.url))],
        { cwd: fileURLToPath(new URL("../../", import.meta.url)), env: environment, windowsHide: true, encoding: "utf8", timeout: 10_000,
          input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "compat-session", tool_name: tool, tool_input: value }) });
      expect(hook.status, hook.stderr).toBe(0);
      return JSON.parse(hook.stdout).hookSpecificOutput.updatedInput as Record<string, unknown>;
    };
    const workflow = new SqliteWorkflowStore(environment.AGENT_GOVERNANCE_DB_PATH);
    workflow.putPluginUpdateState({ targetId: "agent-governance-suite", currentVersion: CURRENT_VERSION,
      latestVersion: CURRENT_VERSION, latestTag: `v${CURRENT_VERSION}`, latestCommit: "a".repeat(40),
      etag: "isolated", comparison: "up-to-date", lastAttemptAt: NOW, lastSuccessfulCheckAt: NOW,
      nextCheckAt: "2099-01-01T00:00:00.000Z", lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null });
    workflow.close();
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", "tsx", fileURLToPath(new URL("../../mcp-server/src/index.ts", import.meta.url))],
      env: environment, cwd: fileURLToPath(new URL("../../", import.meta.url)), stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const client = new Client({ name: "compatibility-fixture", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.some((tool) => tool.name === "inspect_context")).toBe(true);
      const info = await client.callTool({ name: "get_trust_capabilities", arguments: {} });
      const infoText = (info.content as Array<{ type: string; text: string }>).find((item) => item.type === "text")!.text;
      expect(JSON.parse(infoText).ok).toBe(true);
      const result = await client.callTool({ name: "inspect_context", arguments: issuer
        ? hookArguments("inspect_context", { schemaVersion: "1.0.0" }) : { schemaVersion: "1.0.0" } });
      const text = (result.content as Array<{ type: string; text: string }>).find((item) => item.type === "text")!.text;
      if (issuer && kind === "healthy") {
        const candidate = JSON.parse(text).data;
        expect(candidate.summary.revision).toBe(1);
        const load = { schemaVersion: "1.0.0", candidateToken: candidate.restoreToken, epoch: 1,
          revision: 1, digest: saved!.snapshotDigest };
        const loaded = await client.callTool({ name: "load_context", arguments: hookArguments("load_context", load) });
        const loadedText = (loaded.content as Array<{ type: string; text: string }>).find((item) => item.type === "text")!.text;
        expect(JSON.parse(loadedText).data).toEqual(saved);
        expect(issuer.store.getSchemaVersion()).toBe(3);
        return;
      }
      const failure = JSON.parse(text) as ApiResultV1<unknown>;
      expect(failure).toMatchObject({ ok: false, data: null, error: { code: "CONTINUITY_UNAVAILABLE",
        details: { reason: { receiver: "RECEIVER_STATE_UNSUPPORTED", future: "UNSUPPORTED_SCHEMA", incompatible: "INCOMPATIBLE_SCHEMA", corrupt: "CORRUPT_DATABASE" }[kind] } } });
      expect(text + stderr).not.toContain("private body");
      expect(text + stderr).not.toContain("signing-secret");
      if (beforeReceiver) expect(state(databasePath)).toEqual(beforeReceiver);
    } finally { await client.close(); }
  }, 15_000);
});
