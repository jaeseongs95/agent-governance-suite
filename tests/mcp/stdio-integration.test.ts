import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import type {
  ApiResultV1,
  PluginUpdateStatusV1,
  StateCleanupPlanV1,
  TaskEnvelopeV1,
  WorkflowPlanV1,
} from "../../contracts/types.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { CURRENT_VERSION, NEXT_TAG, NEXT_VERSION } from "./version-fixtures.js";

const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const bundledServer = fileURLToPath(new URL("../../mcp-server/dist/server.mjs", import.meta.url));
const bundledContinuityHook = fileURLToPath(new URL("../../mcp-server/dist/continuity-hook.mjs", import.meta.url));

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
  const result = spawnSync(process.execPath, [bundledContinuityHook], {
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

function updatedHookInput(output: Record<string, unknown>): Record<string, unknown> {
  return ((output.hookSpecificOutput as { updatedInput?: Record<string, unknown> } | undefined)?.updatedInput) ?? {};
}

describe("bundled STDIO MCP server", () => {
  it("starts from an isolated plugin tree without node_modules", async () => {
    const isolatedRoot = await mkdtemp(join(tmpdir(), "skill-suite-clean-room-"));
    const isolatedServer = join(isolatedRoot, "mcp-server", "dist", "server.mjs");
    const environment = getDefaultEnvironment();
    delete environment.SKILL_REGISTRY_PATH;
    environment.AGENT_GOVERNANCE_DB_PATH = join(isolatedRoot, "state", "workflow-state.sqlite3");
    const unavailableContinuityPath = join(isolatedRoot, "state", "continuity.sqlite3");
    environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH = unavailableContinuityPath;
    let transport: StdioClientTransport | undefined;

    try {
      await mkdir(join(isolatedRoot, "mcp-server", "dist"), { recursive: true });
      await Promise.all([
        cp(bundledServer, isolatedServer),
        cp(join(rootDirectory, "contracts"), join(isolatedRoot, "contracts"), { recursive: true }),
        cp(join(rootDirectory, "skills"), join(isolatedRoot, "skills"), { recursive: true }),
      ]);
      await mkdir(unavailableContinuityPath, { recursive: true });

      transport = new StdioClientTransport({
        command: process.execPath,
        args: [isolatedServer],
        cwd: isolatedRoot,
        env: environment,
        stderr: "pipe",
      });
      const client = new Client({ name: "clean-room-install-test", version: "1.0.0" });
      await client.connect(transport);

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "lookup_korean_prose_terms",
        "check_for_updates",
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
        "checkpoint_context",
        "inspect_context",
        "load_context",
        "suppress_context_restore",
        "purge_direct_context",
        "prepare_state_cleanup",
        "execute_state_cleanup",
      ]);
      expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
      const sourceText = "MCP와 SQLite는 보호하고 데이터 베이스는 문맥을 확인한다.";
      const glossary = toolData(await client.callTool({
        name: "lookup_korean_prose_terms",
        arguments: { schemaVersion: "1.0.0", sourceText, sourceDigest: createHash("sha256").update(sourceText).digest("hex") },
      }));
      expect(glossary.ok).toBe(true);
      expect(glossary.data).toMatchObject({ status: "matched", sourceDigest: createHash("sha256").update(sourceText).digest("hex") });
      const workflowDatabase = new DatabaseSync(environment.AGENT_GOVERNANCE_DB_PATH!, { readOnly: true });
      expect(workflowDatabase.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get()).toEqual({ count: 0 });
      workflowDatabase.close();
      const unavailable = toolData(await client.callTool({
        name: "inspect_context",
        arguments: { schemaVersion: "1.0.0", _continuityBinding: "untrusted-placeholder" },
      }));
      expect(unavailable.error?.code).toBe("CONTINUITY_UNAVAILABLE");
    } finally {
      try {
        await transport?.close();
      } finally {
        await rm(isolatedRoot, { recursive: true, force: true });
      }
    }
  }, 60_000); // Copies a plugin tree and starts the server; Windows CI runners have taken over 15 s.

  it("keeps workflow startup clean when both database settings resolve to one file", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "skill-suite-shared-db-"));
    const environment = getDefaultEnvironment();
    const sharedDatabasePath = join(stateDirectory, "shared.sqlite3");
    environment.AGENT_GOVERNANCE_DB_PATH = sharedDatabasePath;
    environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH = sharedDatabasePath;
    expect(runContinuityHook(environment, {
      hook_event_name: "SessionStart",
      session_id: "shared-db-session",
      source: "startup",
    })).toEqual({});
    expect(existsSync(sharedDatabasePath)).toBe(false);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundledServer],
      cwd: rootDirectory,
      env: environment,
      stderr: "pipe",
    });
    const client = new Client({ name: "shared-db-boundary-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.some((tool) => tool.name === "plan_workflow")).toBe(true);
      const unavailable = toolData(await client.callTool({
        name: "inspect_context",
        arguments: { schemaVersion: "1.0.0", _continuityBinding: "untrusted-placeholder" },
      }));
      expect(unavailable.error?.code).toBe("CONTINUITY_UNAVAILABLE");
    } finally {
      try { await transport.close(); } finally {
        const database = new DatabaseSync(sharedDatabasePath);
        const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
        database.close();
        expect(JSON.stringify(tables)).not.toContain("continuity_");
        await rm(stateDirectory, { recursive: true, force: true });
      }
    }
  }, 15_000);

  it("starts with the packaged registry and fails semantic planning closed without a trusted provider", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "skill-suite-stdio-"));
    const environment = getDefaultEnvironment();
    delete environment.SKILL_REGISTRY_PATH;
    const databasePath = join(stateDirectory, "workflow-state.sqlite3");
    environment.AGENT_GOVERNANCE_DB_PATH = databasePath;
    environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH = join(stateDirectory, "continuity.sqlite3");
    seedAvailableUpdate(databasePath);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundledServer],
      cwd: rootDirectory,
      env: environment,
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-integration-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "lookup_korean_prose_terms",
        "check_for_updates",
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
        "checkpoint_context",
        "inspect_context",
        "load_context",
        "suppress_context_restore",
        "purge_direct_context",
        "prepare_state_cleanup",
        "execute_state_cleanup",
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
      expect(listed.tools.find((tool) => tool.name === "start_workflow")?.annotations?.readOnlyHint).toBe(false);
      expect(listed.tools.find((tool) => tool.name === "prepare_state_cleanup")?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
      expect(listed.tools.find((tool) => tool.name === "execute_state_cleanup")?.annotations?.destructiveHint).toBe(true);

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
      const plannedResponse = await client.callTool({
        name: "plan_workflow",
        arguments: assuredPlanArguments(task),
      });
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

      const cleanupPreview = toolData<StateCleanupPlanV1>(await client.callTool({
        name: "prepare_state_cleanup",
        arguments: { schemaVersion: "1.0.0" },
      }));
      expect(cleanupPreview.ok).toBe(true);
      expect(cleanupPreview.data?.planToken).toEqual(expect.any(String));

      const updateStatus = toolData<PluginUpdateStatusV1>(await client.callTool({
        name: "check_for_updates",
        arguments: { force: false },
      }));
      expect(updateStatus.data).toMatchObject({
        currentVersion: CURRENT_VERSION,
        latestVersion: NEXT_VERSION,
        comparison: "update-available",
        automaticInstall: false,
      });

      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get()).toEqual({ count: 0 });
        expect(database.prepare("SELECT COUNT(*) AS count FROM execution_observation_claims").get()).toEqual({ count: 0 });
      } finally {
        database.close();
      }
    } finally {
      try {
        await transport.close();
      } finally {
        await rm(stateDirectory, { recursive: true, force: true });
      }
    }
  }, 15_000);

  it("shares signed continuity bindings between the packaged hook and MCP server", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "skill-suite-continuity-stdio-"));
    const environment = getDefaultEnvironment();
    const workflowPath = join(stateDirectory, "workflows.sqlite3");
    environment.AGENT_GOVERNANCE_DB_PATH = workflowPath;
    environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH = join(stateDirectory, "continuity.sqlite3");
    seedAvailableUpdate(workflowPath);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundledServer],
      cwd: rootDirectory,
      env: environment,
      stderr: "pipe",
    });
    const client = new Client({ name: "continuity-hook-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const checkpoint = {
        schemaVersion: "1.0.0",
        requestId: "stdio-checkpoint-1",
        expectedRevision: 0,
        status: "active",
        core: {
          objective: "Resume this private direct task.",
          completionCriteria: ["The explicit load succeeds."],
          constraints: [], decisions: [], progress: [], blockers: [], nextActions: [],
        },
        evidenceRefs: [],
      };
      const checkpointHook = runContinuityHook(environment, {
        hook_event_name: "PreToolUse",
        session_id: "stdio-continuity-session",
        tool_name: "mcp__agent-governance-suite__checkpoint_context",
        tool_input: checkpoint,
      });
      const stored = toolData(await client.callTool({ name: "checkpoint_context", arguments: updatedHookInput(checkpointHook) }));
      expect(stored).toMatchObject({ ok: true, data: { revision: 1 } });

      const inspect = { schemaVersion: "1.0.0" };
      const inspectHook = runContinuityHook(environment, {
        hook_event_name: "PreToolUse",
        session_id: "stdio-continuity-session",
        tool_name: "mcp__agent_governance_suite__inspect_context",
        tool_input: inspect,
      });
      const candidate = toolData<{
        summary: { epoch: number; revision: number; snapshotDigest: string };
        restoreToken: string;
      }>(await client.callTool({ name: "inspect_context", arguments: updatedHookInput(inspectHook) }));
      expect(JSON.stringify(candidate)).not.toContain("Resume this private direct task.");

      const load = {
        schemaVersion: "1.0.0",
        candidateToken: candidate.data!.restoreToken,
        epoch: candidate.data!.summary.epoch,
        revision: candidate.data!.summary.revision,
        digest: candidate.data!.summary.snapshotDigest,
      };
      const loadHook = runContinuityHook(environment, {
        hook_event_name: "PreToolUse",
        session_id: "stdio-continuity-session",
        tool_name: "mcp__agent-governance-suite__load_context",
        tool_input: load,
      });
      expect(toolData<{ core: { objective: string } }>(await client.callTool({ name: "load_context", arguments: updatedHookInput(loadHook) })).data?.core.objective)
        .toBe("Resume this private direct task.");

      const resume = runContinuityHook(environment, {
        hook_event_name: "SessionStart",
        session_id: "stdio-continuity-session",
        source: "resume",
      });
      expect(JSON.stringify(resume)).toContain("decision=DEFER");
      expect(JSON.stringify(resume)).not.toContain("Resume this private direct task.");
    } finally {
      try { await transport.close(); } finally { await rm(stateDirectory, { recursive: true, force: true }); }
    }
  }, 15_000);
});
