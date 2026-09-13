import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
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
  AttemptLeaseV1,
  ConvergenceFrameV1,
  ConvergenceRootHandleV1,
  ConvergenceRootV1,
  ConvergenceStatusSummaryV1,
  PluginUpdateStatusV1,
  StageResultV1,
  TaskEnvelopeV1,
  WorkflowPlanV1,
  WorkflowReceiptV1,
  WorkflowStatusSummaryV1,
} from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";

const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const bundledServer = fileURLToPath(new URL("../../mcp-server/dist/server.mjs", import.meta.url));
const bundledContinuityHook = fileURLToPath(new URL("../../mcp-server/dist/continuity-hook.mjs", import.meta.url));

function toolArguments(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${value.repeat(64).slice(0, 64)}`;
}

function convergenceFrame(taskId: string): ConvergenceFrameV1 {
  return {
    schemaVersion: "1.0.0",
    workspace: { workspaceId: `stdio-${taskId}`, locator: rootDirectory },
    controlArtifacts: [{ artifactId: "pass-contract", role: "pass-condition", locator: "acceptance", digest: digest("c") }],
    targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: taskId, digest: digest("d") }],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
  };
}

async function startGuarded(
  client: Client,
  task: TaskEnvelopeV1,
  plan: WorkflowPlanV1,
): Promise<{ root: ConvergenceRootV1; lease: AttemptLeaseV1; receipt: WorkflowReceiptV1 }> {
  const frame = convergenceFrame(task.taskId);
  const root = toolData<ConvergenceRootV1>(await client.callTool({
    name: "open_convergence_root",
    arguments: toolArguments({ schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: task, frame, userApprovalRefs: [] }),
  })).data!;
  const lease = toolData<AttemptLeaseV1>(await client.callTool({
    name: "claim_workflow_attempt",
    arguments: toolArguments({
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      expectedRevision: root.revision,
      taskEnvelope: task,
      frame,
      plan,
      actorId: "stdio-implementation-agent",
      outputTargets: task.workUnits.flatMap((unit) => unit.writeTargets),
      priorFailure: null,
    }),
  })).data!;
  const receipt = toolData<WorkflowReceiptV1>(await client.callTool({
    name: "start_guarded_workflow",
    arguments: toolArguments({ schemaVersion: "1.0.0", leaseId: lease.leaseId, expectedRootRevision: lease.rootRevision, plan }),
  })).data!;
  return { root, lease, receipt };
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
      currentVersion: "1.5.0",
      latestVersion: "1.6.0",
      latestTag: "v1.6.0",
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
      ]);
      expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
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
  }, 15_000);

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

  it("starts with the packaged registry and executes complete and abort paths", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "skill-suite-stdio-"));
    const environment = getDefaultEnvironment();
    delete environment.SKILL_REGISTRY_PATH;
    const databasePath = join(stateDirectory, "workflow-state.sqlite3");
    environment.AGENT_GOVERNANCE_DB_PATH = databasePath;
    environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH = join(stateDirectory, "continuity.sqlite3");
    seedAvailableUpdate(databasePath);
    let transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundledServer],
      cwd: rootDirectory,
      env: environment,
      stderr: "pipe",
    });
    let client = new Client({ name: "stdio-integration-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
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
      ]);
      expect(listed.tools.find((tool) => tool.name === "plan_workflow")?.annotations?.readOnlyHint).toBe(true);
      expect(listed.tools.find((tool) => tool.name === "check_for_updates")?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      });
      expect(listed.tools.find((tool) => tool.name === "get_workflow_status")?.annotations?.readOnlyHint).toBe(true);
      expect(listed.tools.find((tool) => tool.name === "start_workflow")?.annotations?.readOnlyHint).toBe(false);

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
        arguments: toolArguments(task),
      });
      const planned = toolData<WorkflowPlanV1>(plannedResponse);
      const plannedContents = textContents(plannedResponse);
      expect(plannedContents).toHaveLength(2);
      expect(JSON.parse(plannedContents[1]!)).toMatchObject({
        kind: "plugin-update-notice",
        currentVersion: "1.5.0",
        latestVersion: "1.6.0",
        automaticInstall: false,
      });
      expect(planned.ok).toBe(true);
      expect(planned.data?.state).toBe("ready");
      expect(planned.data?.selectedSkills).toContain("coordinate-subagents");
      expect(planned.data?.stages).toHaveLength(1);
      expect(planned.data?.stages[0]?.satisfiedCapabilities).toEqual(["task-decomposition"]);

      const startedResponse = await client.callTool({
        name: "start_workflow",
        arguments: toolArguments(planned.data!),
      });
      expect(textContents(startedResponse)).toHaveLength(1);
      expect(toolData<WorkflowReceiptV1>(startedResponse).error?.code).toBe("LEASE_REQUIRED");
      const guarded = await startGuarded(client, task, planned.data!);
      const started = { data: guarded.receipt };
      expect(started.data).toMatchObject({ state: "running", revision: 0 });

      const updateStatus = toolData<PluginUpdateStatusV1>(await client.callTool({
        name: "check_for_updates",
        arguments: { force: false },
      }));
      expect(updateStatus.data).toMatchObject({
        currentVersion: "1.5.0",
        latestVersion: "1.6.0",
        comparison: "update-available",
        automaticInstall: false,
      });

      const stage = started.data!.plan.stages[0]!;
      const stageResult: StageResultV1 = {
        schemaVersion: "1.0.0",
        runId: started.data!.runId,
        stageId: stage.stageId,
        expectedRevision: started.data!.revision,
        state: "passed",
        output: {
          schemaVersion: "1.0.0",
          kind: "output",
          output: { completed: true },
          artifacts: stage.requiredArtifacts.map((artifactId) => ({
            artifactId,
            schemaId: "stdio-fixture/v1",
            locator: `tests/mcp/stdio/${artifactId}.json`,
            digest: "a".repeat(64),
            targetDigest: "b".repeat(64),
            verified: true,
          })),
          error: null,
        },
        evidence: [{
          artifactId: "stdio-execution",
          kind: "test",
          locator: "tests/mcp/stdio-integration.test.ts",
          verified: true,
          note: "Executed through the bundled STDIO transport.",
        }],
        findings: [],
        blockers: [],
        error: null,
      };
      const recorded = toolData<WorkflowReceiptV1>(await client.callTool({
        name: "record_stage_result",
        arguments: toolArguments(stageResult),
      }));
      expect(recorded.data).toMatchObject({ state: "running", revision: 1 });

      await transport.close();
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [bundledServer],
        cwd: rootDirectory,
        env: environment,
        stderr: "pipe",
      });
      client = new Client({ name: "stdio-restart-test", version: "1.0.0" });
      await client.connect(transport);

      const statusResponse = await client.callTool({
        name: "get_workflow_status",
        arguments: { runId: recorded.data!.runId, detail: "compact" },
      });
      expect(textContents(statusResponse)).toHaveLength(1);
      const compactStatus = toolData<WorkflowStatusSummaryV1>(statusResponse);
      expect(compactStatus.data?.runId).toBe(started.data?.runId);
      expect(compactStatus.data?.revision).toBe(recorded.data?.revision);
      expect(compactStatus.data).not.toHaveProperty("plan");
      expect(compactStatus.data).not.toHaveProperty("stageResults");

      const status = toolData<WorkflowReceiptV1>(await client.callTool({
        name: "get_workflow_status",
        arguments: { runId: recorded.data!.runId },
      }));
      expect(status.data?.stageResults).toHaveLength(1);

      const finalized = toolData<WorkflowStatusSummaryV1>(await client.callTool({
        name: "finalize_workflow",
        arguments: { runId: status.data!.runId, expectedRevision: status.data!.revision, responseMode: "compact" },
      }));
      expect(finalized.data).toMatchObject({ state: "passed", revision: 2 });
      expect(finalized.data).not.toHaveProperty("plan");
      const finalizedFullStatus = toolData<WorkflowReceiptV1>(await client.callTool({
        name: "get_workflow_status",
        arguments: { runId: finalized.data!.runId },
      }));
      expect(convergenceDigest(finalizedFullStatus.data)).toBe(finalized.data!.receiptDigest);
      const finalizedConvergence = toolData<ConvergenceStatusSummaryV1>(await client.callTool({
        name: "get_convergence_status",
        arguments: { rootId: guarded.root.rootId, detail: "compact" },
      }));
      expect(finalizedConvergence.data?.latestOutcomeReceiptDigest).toBe(finalized.data!.receiptDigest);

      const abortTask = { ...task, taskId: "stdio-abort-path" };
      const abortPlan = toolData<WorkflowPlanV1>(await client.callTool({
        name: "plan_workflow",
        arguments: toolArguments(abortTask),
      }));
      const abortFrame = convergenceFrame(abortTask.taskId);
      const abortRoot = toolData<ConvergenceRootHandleV1>(await client.callTool({
        name: "open_convergence_root",
        arguments: toolArguments({
          schemaVersion: "1.0.0",
          parentRootId: null,
          taskEnvelope: abortTask,
          frame: abortFrame,
          userApprovalRefs: [],
          responseMode: "compact",
        }),
      }));
      expect(abortRoot.data).not.toHaveProperty("taskEnvelope");
      expect(abortRoot.data).not.toHaveProperty("frame");
      const abortLease = toolData<AttemptLeaseV1>(await client.callTool({
        name: "claim_workflow_attempt",
        arguments: toolArguments({
          schemaVersion: "1.0.0",
          rootId: abortRoot.data!.rootId,
          expectedRevision: abortRoot.data!.revision,
          plan: abortPlan.data!,
          actorId: "stdio-compact-agent",
          outputTargets: abortTask.workUnits.flatMap((unit) => unit.writeTargets),
          priorFailure: null,
        }),
      }));
      const abortRun = toolData<WorkflowStatusSummaryV1>(await client.callTool({
        name: "start_guarded_workflow",
        arguments: {
          schemaVersion: "1.0.0",
          leaseId: abortLease.data!.leaseId,
          expectedRootRevision: abortLease.data!.rootRevision,
          responseMode: "compact",
        },
      }));
      expect(abortRun.data).not.toHaveProperty("plan");

      const abortStage = abortPlan.data!.stages[0]!;
      const abortRecorded = toolData<WorkflowStatusSummaryV1>(await client.callTool({
        name: "record_stage_result",
        arguments: toolArguments({
          schemaVersion: "1.0.0",
          runId: abortRun.data!.runId,
          stageId: abortStage.stageId,
          expectedRevision: abortRun.data!.revision,
          state: "passed",
          output: {
            schemaVersion: "1.0.0",
            kind: "output",
            output: { payload: "x".repeat(8 * 1024) },
            artifacts: abortStage.requiredArtifacts.map((artifactId) => ({
              artifactId,
              schemaId: "stdio-fixture/v1",
              locator: `tests/mcp/stdio/${artifactId}.json`,
              digest: "c".repeat(64),
              targetDigest: "d".repeat(64),
              verified: true,
            })),
            error: null,
          },
          evidence: [{
            artifactId: "stdio-compact-execution",
            kind: "test",
            locator: "tests/mcp/stdio-integration.test.ts",
            verified: true,
            note: "Compact stage response fixture.",
          }],
          findings: [],
          blockers: [],
          error: null,
          responseMode: "compact",
        }),
      }));
      expect(abortRecorded.data).not.toHaveProperty("stageResults");
      expect(JSON.stringify(abortRecorded.data)).not.toContain("x".repeat(1024));

      const aborted = toolData<WorkflowStatusSummaryV1>(await client.callTool({
        name: "abort_workflow",
        arguments: { runId: abortRun.data!.runId, expectedRevision: abortRecorded.data!.revision, responseMode: "compact" },
      }));
      expect(aborted.data).toMatchObject({ state: "blocked", revision: 2 });
      expect(aborted.data).not.toHaveProperty("stageResults");

      const compactConvergence = toolData<ConvergenceStatusSummaryV1>(await client.callTool({
        name: "get_convergence_status",
        arguments: { rootId: abortRoot.data!.rootId, detail: "compact" },
      }));
      expect(compactConvergence.data).toMatchObject({ outcomeCount: 1, latestOutcomeState: "aborted" });
      expect(compactConvergence.data?.latestOutcomeReceiptDigest).toBe(aborted.data!.receiptDigest);
      expect(compactConvergence.data?.root).not.toHaveProperty("taskEnvelope");
      expect(compactConvergence.data).not.toHaveProperty("proposals");
    } finally {
      try {
        await transport.close();
      } finally {
        await rm(stateDirectory, { recursive: true, force: true });
      }
    }
  });

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
