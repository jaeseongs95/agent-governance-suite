import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ApiResultV1,
  AttemptLeaseV1,
  ConvergenceFrameV1,
  ConvergenceRootV1,
  StageResultV1,
  TaskEnvelopeV1,
  WorkflowPlanV1,
  WorkflowReceiptV1,
} from "../../contracts/types.js";
import {
  HOST_ATTESTATION_FIELD,
  HostAttestationProvider,
  modelClassForClaudeModel,
} from "../../mcp-server/src/host-attestation.js";
import {
  claudeCodeActorId,
  findToolUseObservation,
  handleHostAttestationHook,
  transcriptCandidates,
} from "../../mcp-server/src/host-attestation-hook.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { resolveHostAttestation } from "../../mcp-server/src/runtime-config.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore, type WorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { CURRENT_VERSION } from "./version-fixtures.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const TOOL_PREFIX = "mcp__plugin_agent-governance-suite_agent-governance-suite__";
const SESSION = "session-attest";
const TRANSCRIPT = path.join("transcripts", `${SESSION}.jsonl`);

function task(taskId: string): TaskEnvelopeV1 {
  return {
    schemaVersion: "1.0.0",
    taskId,
    objective: "Exercise Claude Code host attestation.",
    scope: { included: ["integration test"], excluded: ["deployment"] },
    acceptanceCriteria: ["Complete the planned stage through the MCP boundary."],
    riskLevel: "low",
    workUnits: [{ id: "unit-1", objective: "Run the fixture.", dependencies: [], writeTargets: ["fixture.md"] }],
    requiredCapabilities: ["task-decomposition"],
    constraints: ["Use only fixture data."],
    authorization: { allowedActions: ["test"], prohibitedActions: ["deploy"], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false },
    orchestration: { requested: true, mcpAvailable: true },
  };
}

function frame(taskId: string): ConvergenceFrameV1 {
  return {
    schemaVersion: "1.0.0",
    workspace: { workspaceId: `attest-${taskId}`, locator: "tests/mcp/host-attestation.test.ts" },
    controlArtifacts: [{ artifactId: "acceptance", role: "pass-condition", locator: "fixture:acceptance", digest: `sha256:${"a".repeat(64)}` }],
    targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: `fixture:${taskId}`, digest: `sha256:${"b".repeat(64)}` }],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
  };
}

function transcriptLine(toolUseId: string, options: { model?: string; effort?: string; sessionId?: string; isSidechain?: boolean; agentId?: string } = {}): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: options.sessionId ?? SESSION,
    isSidechain: options.isSidechain ?? false,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    effort: options.effort ?? "high",
    message: {
      model: options.model ?? "claude-opus-5",
      content: [{ type: "text", text: "calling" }, { type: "tool_use", id: toolUseId, name: "tool", input: {} }],
    },
  });
}

let toolUseSequence = 0;

interface AttestOptions {
  model?: string;
  effort?: string;
  now?: Date;
}

/** Runs the hook the way Claude Code would and returns the tool input it hands to the server. */
function attest(store: WorkflowStore, tool: string, input: Record<string, unknown>, options: AttestOptions = {}): Record<string, unknown> {
  toolUseSequence += 1;
  const toolUseId = `toolu_${String(toolUseSequence).padStart(6, "0")}`;
  const transcript = `${transcriptLine("toolu_other")}\n${transcriptLine(toolUseId, options)}\n`;
  const output = handleHostAttestationHook(
    {
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      transcript_path: TRANSCRIPT,
      tool_name: `${TOOL_PREFIX}${tool}`,
      tool_use_id: toolUseId,
      tool_input: input,
      effort: { level: options.effort ?? "high" },
    },
    store,
    { readText: () => transcript, sleep: () => {}, ...(options.now ? { now: () => options.now! } : {}) },
  );
  const updated = (output.hookSpecificOutput as { updatedInput?: Record<string, unknown> } | undefined)?.updatedInput;
  if (!updated) throw new Error("hook did not attest the call");
  return updated;
}

function result<T>(response: unknown): ApiResultV1<T> {
  const content = (response as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  const text = content.find((item) => item.type === "text" && typeof item.text === "string")?.text;
  if (!text) throw new Error("MCP response did not contain a JSON text result.");
  return JSON.parse(text) as ApiResultV1<T>;
}

interface Harness {
  client: Client;
  store: InMemoryWorkflowStore;
  call<T>(name: string, args: Record<string, unknown>): Promise<ApiResultV1<T>>;
}

const openServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()!();
});

async function harness(withProvider: boolean): Promise<Harness> {
  const validator = new ContractValidator();
  const store = new InMemoryWorkflowStore();
  const provider = withProvider ? new HostAttestationProvider(store) : null;
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, provider);
  const updateStore = new InMemoryPluginUpdateStore();
  updateStore.putPluginUpdateState({
    targetId: "agent-governance-suite",
    currentVersion: CURRENT_VERSION,
    latestVersion: CURRENT_VERSION,
    latestTag: `v${CURRENT_VERSION}`,
    latestCommit: "c".repeat(40),
    etag: "host-attestation",
    comparison: "up-to-date",
    lastAttemptAt: "2026-09-18T00:00:00.000Z",
    lastSuccessfulCheckAt: "2026-09-18T00:00:00.000Z",
    nextCheckAt: "2099-01-01T00:00:00.000Z",
    lastNotifiedVersion: null,
    lastNotifiedAt: null,
    lastErrorCode: null,
  });
  const server = createMcpServer(
    service,
    new PluginUpdateService(updateStore),
    undefined,
    undefined,
    undefined,
    validator,
    "anthropic",
    provider,
  );
  const client = new Client({ name: "host-attestation", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openServers.push(async () => {
    await client.close();
    await server.close();
  });
  return {
    client,
    store,
    call: async <T>(name: string, args: Record<string, unknown>) => result<T>(await client.callTool({ name, arguments: args })),
  };
}

function planArguments(taskId: string): Record<string, unknown> {
  return { schemaVersion: "1.0.0", taskEnvelope: task(taskId) };
}

describe("Claude Code host attestation through the MCP boundary", () => {
  it("completes an orchestrated workflow with harness-observed model and effort", async () => {
    const { store, call } = await harness(true);
    const planned = await call<WorkflowPlanV1>("plan_workflow", attest(store, "plan_workflow", planArguments("attest-complete")));
    expect(planned.error).toBeNull();
    const plan = planned.data!;
    expect(plan.bootstrapExecution?.context).toMatchObject({
      model: "claude-opus-5",
      modelClass: "deep",
      reasoningEffort: "high",
      source: "runtime",
      taskId: "attest-complete",
      actorId: claudeCodeActorId(SESSION, null),
    });
    expect(JSON.stringify(plan)).not.toContain(SESSION);

    const taskEnvelope = task("attest-complete");
    const taskFrame = frame(taskEnvelope.taskId);
    const root = (await call<ConvergenceRootV1>("open_convergence_root", {
      schemaVersion: "1.0.0", parentRootId: null, taskEnvelope, frame: taskFrame, userApprovalRefs: [],
    })).data!;
    const lease = (await call<AttemptLeaseV1>("claim_workflow_attempt", {
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      expectedRevision: root.revision,
      taskEnvelope,
      frame: taskFrame,
      plan,
      actorId: claudeCodeActorId(SESSION, null),
      outputTargets: ["fixture.md"],
      priorFailure: null,
    })).data!;
    const receipt = (await call<WorkflowReceiptV1>("start_guarded_workflow", {
      schemaVersion: "1.0.0", leaseId: lease.leaseId, expectedRootRevision: lease.rootRevision, plan,
    })).data!;
    const stage = receipt.plan.stages[0]!;
    const stageResult: StageResultV1 = {
      schemaVersion: "1.0.0",
      runId: receipt.runId,
      stageId: stage.stageId,
      expectedRevision: receipt.revision,
      state: "passed",
      output: {
        schemaVersion: "1.0.0",
        kind: "output",
        output: { completed: true },
        artifacts: stage.requiredArtifacts.map((artifactId) => ({
          artifactId,
          schemaId: "host-attestation/v1",
          locator: `fixture:${artifactId}`,
          digest: "d".repeat(64),
          targetDigest: "e".repeat(64),
          verified: true,
        })),
        error: null,
      },
      evidence: [{ artifactId: "host-attestation", kind: "test", locator: "host-attestation.test.ts", verified: true, note: "In-memory MCP transport." }],
      findings: [],
      blockers: [],
      error: null,
    };
    const stageArguments = { ...(stageResult as unknown as Record<string, unknown>), responseMode: "full" };
    const recorded = await call<WorkflowReceiptV1>("record_stage_result", attest(store, "record_stage_result", stageArguments, { model: "claude-fable-5-1", effort: "xhigh" }));
    expect(recorded.error).toBeNull();
    expect(recorded.data!.stageResults[0]?.executionContext).toMatchObject({
      model: "claude-fable-5-1",
      modelClass: "frontier",
      reasoningEffort: "xhigh",
      taskId: "attest-complete",
      runId: receipt.runId,
      stageId: stage.stageId,
      revision: receipt.revision,
    });
    const finalized = await call<WorkflowReceiptV1>("finalize_workflow", { runId: receipt.runId, expectedRevision: recorded.data!.revision });
    expect(finalized.data).toMatchObject({ state: "passed" });
  });

  it("keeps the default server without a provider on BINDING_REQUIRED", async () => {
    const { call } = await harness(false);
    const plain = await call<WorkflowPlanV1>("plan_workflow", planArguments("default-plain"));
    expect(plain.error?.code).toBe("BINDING_REQUIRED");

    const claude = await harness(true);
    const token = attest(claude.store, "plan_workflow", planArguments("default-token"))[HOST_ATTESTATION_FIELD];
    const withToken = await call<WorkflowPlanV1>("plan_workflow", { ...planArguments("default-token"), [HOST_ATTESTATION_FIELD]: token });
    expect(withToken.ok).toBe(false);
    expect(withToken.data).toBeNull();
  });

  it("fails closed without a token", async () => {
    const { call } = await harness(true);
    const planned = await call<WorkflowPlanV1>("plan_workflow", planArguments("no-token"));
    expect(planned.error?.code).toBe("BINDING_REQUIRED");
  });

  it("rejects tokens for a different call, forged signatures, replays and expired observations", async () => {
    const { store, call } = await harness(true);

    const attested = attest(store, "plan_workflow", planArguments("tampered"));
    const tampered = {
      ...attested,
      taskEnvelope: { ...task("tampered"), objective: "Changed after attestation." },
    };
    expect((await call<WorkflowPlanV1>("plan_workflow", tampered)).error?.code).toBe("BINDING_INVALID");

    const forgedInput = attest(store, "plan_workflow", planArguments("forged"));
    const token = String(forgedInput[HOST_ATTESTATION_FIELD]);
    const forged = { ...forgedInput, [HOST_ATTESTATION_FIELD]: `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}` };
    expect((await call<WorkflowPlanV1>("plan_workflow", forged)).error?.code).toBe("BINDING_INVALID");

    const foreignStore = new InMemoryWorkflowStore();
    const foreign = attest(foreignStore, "plan_workflow", planArguments("foreign-key"));
    expect((await call<WorkflowPlanV1>("plan_workflow", foreign)).error?.code).toBe("BINDING_INVALID");

    const once = attest(store, "plan_workflow", planArguments("replay"));
    expect((await call<WorkflowPlanV1>("plan_workflow", once)).ok).toBe(true);
    expect((await call<WorkflowPlanV1>("plan_workflow", once)).error?.code).toBe("BINDING_INVALID");

    const expired = attest(store, "plan_workflow", planArguments("expired"), { now: new Date(Date.now() - 10 * 60 * 1000) });
    expect((await call<WorkflowPlanV1>("plan_workflow", expired)).error?.code).toBe("BINDING_INVALID");
  });

  it("enforces the planned assurance floor on the observed model and effort", async () => {
    const { store, call } = await harness(true);
    const lightweight = attest(store, "plan_workflow", planArguments("haiku"), { model: "claude-haiku-4-5-20251001" });
    expect((await call<WorkflowPlanV1>("plan_workflow", lightweight)).error?.code).toBe("BINDING_INVALID");
    const lowEffort = attest(store, "plan_workflow", planArguments("low-effort"), { effort: "low" });
    expect((await call<WorkflowPlanV1>("plan_workflow", lowEffort)).error?.code).toBe("BINDING_INVALID");
  });
});

describe("host attestation hook", () => {
  const store = new InMemoryWorkflowStore();
  const base = {
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    transcript_path: TRANSCRIPT,
    tool_name: `${TOOL_PREFIX}plan_workflow`,
    tool_use_id: "toolu_hook",
    tool_input: { taskId: "hook-task" },
    effort: { level: "high" },
  };
  const noWait = { sleep: () => {} };

  it("attests only the two strict tools of this MCP server", () => {
    expect(handleHostAttestationHook({ ...base, tool_name: `${TOOL_PREFIX}open_convergence_root` }, store, { ...noWait, readText: () => transcriptLine("toolu_hook") })).toEqual({});
    expect(handleHostAttestationHook({ ...base, tool_name: "Bash" }, store, { ...noWait, readText: () => transcriptLine("toolu_hook") })).toEqual({});
    expect(handleHostAttestationHook({ ...base, hook_event_name: "PostToolUse" }, store, { ...noWait, readText: () => transcriptLine("toolu_hook") })).toEqual({});
  });

  it("replaces a caller-supplied token and keeps the other arguments", () => {
    const output = handleHostAttestationHook(
      { ...base, tool_input: { taskId: "hook-task", [HOST_ATTESTATION_FIELD]: "aghs1.caller.forged" } },
      store,
      { ...noWait, readText: () => transcriptLine("toolu_hook") },
    );
    const updated = (output.hookSpecificOutput as { updatedInput: Record<string, unknown>; permissionDecision?: string });
    expect(updated.permissionDecision).toBeUndefined();
    expect(updated.updatedInput.taskId).toBe("hook-task");
    expect(updated.updatedInput[HOST_ATTESTATION_FIELD]).toMatch(/^aghs1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
    expect(updated.updatedInput[HOST_ATTESTATION_FIELD]).not.toBe("aghs1.caller.forged");
  });

  it("waits for a lagging transcript and gives up without a token", () => {
    let reads = 0;
    const lagging = handleHostAttestationHook(base, store, {
      ...noWait,
      readText: () => (++reads < 4 ? transcriptLine("toolu_older") : transcriptLine("toolu_hook")),
    });
    expect(reads).toBe(4);
    expect(lagging.hookSpecificOutput).toBeDefined();

    let slept = 0;
    const missing = handleHostAttestationHook(base, store, {
      readText: () => null,
      sleep: (milliseconds) => { slept += milliseconds; },
      maxWaitMs: 500,
      pollIntervalMs: 100,
    });
    expect(missing).toEqual({});
    expect(slept).toBe(500);
  });

  it("does not attest unknown models, missing effort, foreign sessions or sidechain messages", () => {
    const read = (line: string) => ({ ...noWait, maxWaitMs: 0, readText: () => line });
    expect(handleHostAttestationHook(base, store, read(transcriptLine("toolu_hook", { model: "gpt-5.6-sol" })))).toEqual({});
    expect(handleHostAttestationHook(base, store, read(transcriptLine("toolu_hook", { sessionId: "other" })))).toEqual({});
    expect(handleHostAttestationHook(base, store, read(transcriptLine("toolu_hook", { isSidechain: true })))).toEqual({});
    const noEffortLine = JSON.stringify({ ...JSON.parse(transcriptLine("toolu_hook")), effort: undefined });
    expect(handleHostAttestationHook({ ...base, effort: undefined }, store, read(noEffortLine))).toEqual({});
    expect(handleHostAttestationHook({ ...base, tool_input: {} }, store, read(transcriptLine("toolu_hook")))).toEqual({});
  });

  it("reads a subagent's own transcript and records the subagent as the actor", () => {
    const subagentPath = transcriptCandidates(TRANSCRIPT, SESSION, "agent123")[1]!;
    expect(subagentPath).toBe(path.join("transcripts", SESSION, "subagents", "agent-agent123.jsonl"));
    const files: Record<string, string> = {
      [TRANSCRIPT]: transcriptLine("toolu_parent"),
      [subagentPath]: transcriptLine("toolu_hook", { isSidechain: true, agentId: "agent123", model: "claude-sonnet-5" }),
    };
    const output = handleHostAttestationHook({ ...base, agent_id: "agent123" }, store, { ...noWait, readText: (file) => files[file] ?? null });
    const token = String((output.hookSpecificOutput as { updatedInput: Record<string, unknown> }).updatedInput[HOST_ATTESTATION_FIELD]);
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(payload).toMatchObject({ model: "claude-sonnet-5", modelClass: "general", actorId: claudeCodeActorId(SESSION, "agent123") });
    expect(claudeCodeActorId(SESSION, "agent123")).toMatch(/^claude-code:session-[0-9a-f]{24}:agent-[0-9a-f]{24}$/u);
    expect(claudeCodeActorId(SESSION, "agent123")).not.toBe(claudeCodeActorId(SESSION, "agent456"));
  });

  it("finds the message that issued the tool call, not a later mention of its ID", () => {
    const mention = JSON.stringify({ type: "user", sessionId: SESSION, message: { content: [{ type: "tool_result", tool_use_id: "toolu_hook" }] } });
    expect(findToolUseObservation(`${transcriptLine("toolu_hook", { model: "claude-opus-5" })}\n${mention}\n`, "toolu_hook", SESSION, null))
      .toEqual({ model: "claude-opus-5", effort: "high" });
  });
});

describe("host attestation configuration", () => {
  it("enables the provider only for the exact Claude Code value", () => {
    expect(resolveHostAttestation({})).toBeNull();
    expect(resolveHostAttestation({ AGENT_GOVERNANCE_HOST_ATTESTATION: "codex" })).toBeNull();
    expect(resolveHostAttestation({ AGENT_GOVERNANCE_HOST_ATTESTATION: "claude-code" })).toBe("claude-code");
  });

  it("maps Claude model families to the routing preset classes", () => {
    expect(modelClassForClaudeModel("claude-haiku-4-5-20251001")).toBe("lightweight");
    expect(modelClassForClaudeModel("claude-sonnet-5")).toBe("general");
    expect(modelClassForClaudeModel("claude-opus-5")).toBe("deep");
    expect(modelClassForClaudeModel("claude-fable-5-1")).toBe("frontier");
    expect(modelClassForClaudeModel("claude-opusx")).toBeNull();
    expect(modelClassForClaudeModel("gpt-6-astra")).toBeNull();
  });
});
