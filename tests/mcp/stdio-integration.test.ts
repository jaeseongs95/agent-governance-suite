import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect } from "vitest";

import type {
  ApiResultV1,
  CheckpointContextRequestV1,
  ContinuityCandidateV1,
  ContinuitySnapshotV1,
  PluginUpdateStatusV1,
  StateCleanupPlanV1,
  TaskEnvelopeV1,
  WorkflowPlanV1,
} from "../../contracts/types.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { codexCallMeta } from "../helpers/caller.js";
import { stdioServerTests } from "../helpers/stdio-server.js";
import { CURRENT_VERSION, NEXT_TAG, NEXT_VERSION } from "./version-fixtures.js";

const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const bundledServer = fileURLToPath(new URL("../../mcp-server/dist/server.mjs", import.meta.url));
const bundledContinuityHook = fileURLToPath(new URL("../../mcp-server/dist/continuity-hook.mjs", import.meta.url));

function isolatedEnvironment(stateDirectory: string): Record<string, string> {
  const environment = getDefaultEnvironment();
  const messagingDirectory = join(stateDirectory, "session-messaging");
  environment.AGENT_GOVERNANCE_SHARED_STATE_DIR = join(stateDirectory, "shared-state");
  environment.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR = messagingDirectory;
  environment.AGENT_GOVERNANCE_TRUST_DB_PATH = join(messagingDirectory, "trust.sqlite3");
  environment.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH = join(stateDirectory, "board.sqlite3");
  // The installed Codex server identifies each caller from the tools/call _meta Codex writes; no hook rewrites arguments.
  environment.AGENT_GOVERNANCE_HOST_ATTESTATION = "codex";
  return environment;
}

function assuredPlanArguments(task: TaskEnvelopeV1): Record<string, unknown> {
  return toolArguments({
    schemaVersion: "1.0.0",
    taskEnvelope: task,
  });
}

function toolArguments(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function toolData<T>(result: unknown): ApiResultV1<T> {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("MCP response did not contain content.");
  const text = content.find((item): item is { type: "text"; text: string } => (
    Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text"
      && typeof (item as { text?: unknown }).text === "string"
  ));
  if (!text) throw new Error("MCP response did not contain a text result.");
  return JSON.parse(text.text) as ApiResultV1<T>;
}

function textContents(result: unknown): string[] {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => (
    Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text"
      && typeof (item as { text?: unknown }).text === "string"
      ? [(item as { text: string }).text]
      : []
  ));
}

function seedAvailableUpdate(databasePath: string): void {
  const store = new SqliteWorkflowStore(databasePath);
  try {
    store.putPluginUpdateState({
      targetId: "agent-governance-suite",
      currentVersion: CURRENT_VERSION,
      latestVersion: NEXT_VERSION,
      latestTag: NEXT_TAG,
      latestCommit: "c".repeat(40),
      etag: "stdio-fixture",
      comparison: "update-available",
      lastAttemptAt: "2026-09-13T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-09-13T00:00:00.000Z",
      nextCheckAt: "2099-01-01T00:00:00.000Z",
      lastNotifiedVersion: null,
      lastNotifiedAt: null,
      lastErrorCode: null,
    });
  } finally {
    store.close();
  }
}

function runContinuityHook(environment: Record<string, string>, input: Record<string, unknown>): Record<string, unknown> {
  const result = spawnSync(process.execPath, [bundledContinuityHook, "--host=claude-code"], {
    cwd: rootDirectory,
    env: environment,
    input: JSON.stringify(input),
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
  return result.stdout ? JSON.parse(result.stdout) as Record<string, unknown> : {};
}

// Codex call metadata for a root caller. The model and effort are left unreported, so no execution is qualified:
// unavailable-domain and missing-model cases reach their existing consumer. This is synthetic core evidence.
function rootCall(name: string, args: Record<string, unknown>, sessionId = "stdio-negative-session") {
  return { name, arguments: args, _meta: codexCallMeta(sessionId, { model: null, effort: null }) };
}

describe("bundled STDIO MCP server", () => {
  // Each server starts before its test's time limit starts (stdioServerTests); the limits measure only the calls below.
  const serverTest = stdioServerTests();
  serverTest("starts from an isolated plugin tree without node_modules", async ({ defer, connect }) => {
    const isolatedRoot = await mkdtemp(join(tmpdir(), "skill-suite-clean-room-"));
    defer(() => rm(isolatedRoot, { recursive: true, force: true }));
    const isolatedServer = join(isolatedRoot, "mcp-server", "dist", "server.mjs");
    const environment = isolatedEnvironment(isolatedRoot);
    delete environment.SKILL_REGISTRY_PATH;
    environment.AGENT_GOVERNANCE_DB_PATH = join(isolatedRoot, "state", "workflow-state.sqlite3");
    const unavailableContinuityPath = join(isolatedRoot, "state", "continuity.sqlite3");
    environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH = unavailableContinuityPath;
    await mkdir(join(isolatedRoot, "mcp-server", "dist"), { recursive: true });
    await Promise.all([
      cp(bundledServer, isolatedServer),
      cp(join(rootDirectory, "contracts"), join(isolatedRoot, "contracts"), { recursive: true }),
      cp(join(rootDirectory, "skills"), join(isolatedRoot, "skills"), { recursive: true }),
    ]);
    await mkdir(unavailableContinuityPath, { recursive: true });
    const server = await connect("clean-room-install-test", { command: process.execPath, args: [isolatedServer], cwd: isolatedRoot, env: environment });
    return { client: server.client, environment };
  }, async ({ client, environment }) => {
    {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "get_skill_inventory",
        "classify_skills",
        "record_skill_selection",
        "lookup_korean_prose_terms",
        "check_for_updates",
        "get_trust_capabilities",
        "validate_collaboration_decision",
        "plan_workflow",
        "open_convergence_root",
        "claim_workflow_attempt",
        "start_guarded_workflow",
        "get_convergence_status",
        "resolve_convergence_gate",
        "start_workflow",
        "record_stage_result",
        "get_workflow_status",
        "finalize_workflow",
        "abort_workflow",
        "release_convergence_root",
        "checkpoint_context",
        "inspect_context",
        "load_context",
        "load_shared_context",
        "checkpoint_global_context",
        "bind_session_role",
        "checkpoint_role_context",
        "suppress_context_restore",
        "purge_direct_context",
        "prepare_state_cleanup",
        "execute_state_cleanup",
        "update_session_status",
        "list_session_status",
        "prepare_session_message",
        "send_session_message",
        "acknowledge_session_messages",
        "get_session_message_status",
        "recall_session_message",
      ]);
      expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
      const sourceText = "MCP와 SQLite는 보호하고 데이터 베이스는 문맥을 확인한다.";
      const glossary = toolData(await client.callTool(rootCall("lookup_korean_prose_terms",
        { schemaVersion: "1.0.0", sourceText, sourceDigest: createHash("sha256").update(sourceText).digest("hex") })));
      expect(glossary.ok).toBe(true);
      expect(glossary.data).toMatchObject({ status: "matched", sourceDigest: createHash("sha256").update(sourceText).digest("hex") });
      const workflowDatabase = new DatabaseSync(environment.AGENT_GOVERNANCE_DB_PATH!, { readOnly: true });
      expect(workflowDatabase.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get()).toEqual({ count: 0 });
      workflowDatabase.close();
      const unavailable = toolData(await client.callTool(rootCall("inspect_context", { schemaVersion: "1.0.0" })));
      expect(unavailable.error?.code).toBe("CONTINUITY_UNAVAILABLE");
    }
  }, 15_000);

  serverTest("keeps workflow startup clean when both database settings resolve to one file", async ({ defer, connect }) => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "skill-suite-shared-db-"));
    defer(() => rm(stateDirectory, { recursive: true, force: true }));
    const environment = isolatedEnvironment(stateDirectory);
    const sharedDatabasePath = join(stateDirectory, "shared.sqlite3");
    environment.AGENT_GOVERNANCE_DB_PATH = sharedDatabasePath;
    environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH = sharedDatabasePath;
    // Observed before the server starts, asserted in the test.
    const hookOutput = runContinuityHook(environment, {
      hook_event_name: "SessionStart",
      session_id: "shared-db-session",
      source: "startup",
    });
    const existedBeforeStart = existsSync(sharedDatabasePath);
    const server = await connect("shared-db-boundary-test", { command: process.execPath, args: [bundledServer], cwd: rootDirectory, env: environment });
    return { server, hookOutput, existedBeforeStart, sharedDatabasePath };
  }, async ({ server, hookOutput, existedBeforeStart, sharedDatabasePath }) => {
    const { client } = server;
    expect(hookOutput).toEqual({});
    expect(existedBeforeStart).toBe(false);
    try {
      expect((await client.listTools()).tools.some((tool) => tool.name === "plan_workflow")).toBe(true);
      const unavailable = toolData(await client.callTool(rootCall("inspect_context", { schemaVersion: "1.0.0" })));
      expect(unavailable.error?.code).toBe("CONTINUITY_UNAVAILABLE");
    } finally {
      await server.close();
      const database = new DatabaseSync(sharedDatabasePath);
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      database.close();
      expect(JSON.stringify(tables)).not.toContain("continuity_");
    }
  }, 15_000);

  serverTest("starts with the packaged registry and fails semantic planning closed without a trusted provider", async ({ defer, connect }) => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "skill-suite-stdio-"));
    defer(() => rm(stateDirectory, { recursive: true, force: true }));
    const environment = isolatedEnvironment(stateDirectory);
    delete environment.SKILL_REGISTRY_PATH;
    const databasePath = join(stateDirectory, "workflow-state.sqlite3");
    environment.AGENT_GOVERNANCE_DB_PATH = databasePath;
    environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH = join(stateDirectory, "continuity.sqlite3");
    seedAvailableUpdate(databasePath);
    const server = await connect("stdio-integration-test", { command: process.execPath, args: [bundledServer], cwd: rootDirectory, env: environment });
    return { client: server.client, databasePath };
  }, async ({ client, databasePath }) => {
    {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "get_skill_inventory",
        "classify_skills",
        "record_skill_selection",
        "lookup_korean_prose_terms",
        "check_for_updates",
        "get_trust_capabilities",
        "validate_collaboration_decision",
        "plan_workflow",
        "open_convergence_root",
        "claim_workflow_attempt",
        "start_guarded_workflow",
        "get_convergence_status",
        "resolve_convergence_gate",
        "start_workflow",
        "record_stage_result",
        "get_workflow_status",
        "finalize_workflow",
        "abort_workflow",
        "release_convergence_root",
        "checkpoint_context",
        "inspect_context",
        "load_context",
        "load_shared_context",
        "checkpoint_global_context",
        "bind_session_role",
        "checkpoint_role_context",
        "suppress_context_restore",
        "purge_direct_context",
        "prepare_state_cleanup",
        "execute_state_cleanup",
        "update_session_status",
        "list_session_status",
        "prepare_session_message",
        "send_session_message",
        "acknowledge_session_messages",
        "get_session_message_status",
        "recall_session_message",
      ]);
      expect(listed.tools.find((tool) => tool.name === "plan_workflow")?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: false,
      });
      const planningInputSchema = listed.tools.find((tool) => tool.name === "plan_workflow")?.inputSchema;
      expect(planningInputSchema).toMatchObject({ type: "object", oneOf: expect.any(Array) });
      expect(JSON.stringify(planningInputSchema)).not.toContain("$ref");
      expect(JSON.stringify(planningInputSchema)).not.toContain("executionContext");
      expect(listed.tools.find((tool) => tool.name === "check_for_updates")?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      });
      expect(listed.tools.find((tool) => tool.name === "get_workflow_status")?.annotations?.readOnlyHint).toBe(true);
      expect(listed.tools.find((tool) => tool.name === "validate_collaboration_decision")?.annotations?.readOnlyHint).toBe(true);
      expect(listed.tools.find((tool) => tool.name === "start_workflow")?.annotations?.readOnlyHint).toBe(false);
      expect(listed.tools.find((tool) => tool.name === "prepare_state_cleanup")?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
      expect(listed.tools.find((tool) => tool.name === "execute_state_cleanup")?.annotations?.destructiveHint).toBe(true);
      // D0347: a host approval policy reads these hints; the local inventory read declares exactly what it does not do.
      expect(listed.tools.find((tool) => tool.name === "get_skill_inventory")?.annotations).toEqual({ destructiveHint: false, openWorldHint: false });

      const task: TaskEnvelopeV1 = {
        schemaVersion: "1.0.0",
        taskId: "stdio-default-registry",
        objective: "Plan two independent implementation units.",
        scope: { included: ["implementation planning"], excluded: ["deployment"] },
        acceptanceCriteria: ["Return an executable work plan."],
        riskLevel: "low",
        workUnits: [
          { id: "first", objective: "First unit.", dependencies: [], writeTargets: ["first.md"] },
          { id: "second", objective: "Second unit.", dependencies: [], writeTargets: ["second.md"] },
        ],
        requiredCapabilities: ["task-decomposition"],
        constraints: ["Use local files only."],
        authorization: {
          allowedActions: ["read"],
          prohibitedActions: ["deploy"],
          approvalRequired: [],
        },
        decision: { complexity: "simple", hasConflicts: false },
        orchestration: { requested: true, mcpAvailable: true },
      };
      const plannedResponse = await client.callTool(rootCall("plan_workflow", assuredPlanArguments(task)));
      const planned = toolData<WorkflowPlanV1>(plannedResponse);
      expect(planned.ok).toBe(false);
      expect(planned.error?.code).toBe("BINDING_REQUIRED");
      expect(textContents(plannedResponse)).toHaveLength(2);
      expect(JSON.parse(textContents(plannedResponse)[1]!)).toMatchObject({
        kind: "plugin-update-notice",
        currentVersion: CURRENT_VERSION,
        latestVersion: NEXT_VERSION,
        automaticInstall: false,
      });

      const cleanupPreview = toolData<StateCleanupPlanV1>(await client.callTool(rootCall("prepare_state_cleanup", { schemaVersion: "1.0.0" })));
      expect(cleanupPreview.ok).toBe(true);
      expect(cleanupPreview.data?.planToken).toEqual(expect.any(String));

      const updateStatus = toolData<PluginUpdateStatusV1>(await client.callTool(rootCall("check_for_updates", { force: false })));
      expect(updateStatus.data).toMatchObject({
        currentVersion: CURRENT_VERSION,
        latestVersion: NEXT_VERSION,
        comparison: "update-available",
        automaticInstall: false,
      });

      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get()).toEqual({ count: 0 });
        // No execution was reported, so nothing was observed or consumed; caller identity leaves no claim rows.
        expect(database.prepare("SELECT COUNT(*) AS count FROM execution_observation_claims").get()).toEqual({ count: 0 });
      } finally {
        database.close();
      }
    }
  }, 15_000);

  serverTest("shares continuity state between the packaged hook and the MCP server's verified caller", async ({ defer, connect }) => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "skill-suite-continuity-stdio-"));
    defer(() => rm(stateDirectory, { recursive: true, force: true }));
    const environment = isolatedEnvironment(stateDirectory);
    const workflowPath = join(stateDirectory, "workflows.sqlite3");
    environment.AGENT_GOVERNANCE_DB_PATH = workflowPath;
    environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH = join(stateDirectory, "continuity.sqlite3");
    seedAvailableUpdate(workflowPath);
    const server = await connect("continuity-hook-test", { command: process.execPath, args: [bundledServer], cwd: rootDirectory, env: environment });
    return { client: server.client, environment };
  }, async ({ client, environment }) => {
    {
      const session = "stdio-continuity-session";
      const inspect = { schemaVersion: "1.0.0" };
      const empty = toolData<ContinuitySnapshotV1>(await client.callTool(rootCall("load_context", inspect, session)));
      expect(empty).toMatchObject({ ok: true, data: { source: "direct", memory: null, memoryDigest: null } });
      expect(empty.data!.stateToken).toEqual(expect.any(String));
      const checkpoint: CheckpointContextRequestV1 = {
        schemaVersion: "1.0.0",
        requestId: "stdio-checkpoint-1",
        expectedStateToken: empty.data!.stateToken,
        status: "active",
        core: {
          objective: "Resume this private direct task.",
          completionCriteria: ["The explicit load succeeds."],
          constraints: [], decisions: [], progress: [], blockers: [], nextActions: [],
        },
        evidenceRefs: [],
      };
      const stored = toolData<ContinuitySnapshotV1>(await client.callTool(rootCall("checkpoint_context", toolArguments(checkpoint), session)));
      expect(stored).toMatchObject({ ok: true, data: { source: "direct", stateToken: expect.any(String) } });
      expect(stored.data!.stateToken).not.toBe(empty.data!.stateToken);
      expect(stored.data!.memory).toEqual({ status: checkpoint.status, core: checkpoint.core, evidenceRefs: checkpoint.evidenceRefs });

      const candidate = toolData<ContinuityCandidateV1>(await client.callTool(rootCall("inspect_context", inspect, session)));
      expect(candidate).toMatchObject({ ok: true, data: { decision: "DEFER", restoreToken: expect.any(String),
        summary: { source: "direct", stateToken: stored.data!.stateToken, memoryDigest: stored.data!.memoryDigest } } });
      expect(JSON.stringify(candidate)).not.toContain("Resume this private direct task.");

      const load = { schemaVersion: "1.0.0", candidateToken: candidate.data!.restoreToken! };
      expect(toolData<ContinuitySnapshotV1>(await client.callTool(rootCall("load_context", load, session))).data).toEqual(stored.data);

      const resume = runContinuityHook(environment, {
        hook_event_name: "SessionStart",
        session_id: session,
        source: "resume",
      });
      expect(resume).toMatchObject({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: expect.any(String) } });
      const restored = (resume as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext.split("\n");
      expect(restored).toHaveLength(4);
      expect(restored.slice(0, 2)).toEqual(["[AGS current memory]", `stateToken=${stored.data!.stateToken}`]);
      expect(JSON.parse(restored[3]!)).toEqual(stored.data!.memory);
      expect(JSON.stringify(resume)).not.toContain("candidateToken=");
      expect(toolData<ContinuitySnapshotV1>(await client.callTool(rootCall("load_context", inspect, session))).data).toEqual(stored.data);
    }
  }, 15_000);
});
