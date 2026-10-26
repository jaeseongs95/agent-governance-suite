import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  hostActorId,
  hostAttestationBinding,
  HostAttestationProvider,
  type HostExecutionAdapter,
  issueHostAttestation,
} from "../../mcp-server/src/host-attestation.js";
import {
  claudeCodeExecutionAdapter,
  codexExecutionAdapter,
  createCatalogExecutionAdapters,
  defaultExecutionAdapters,
  geminiExecutionAdapter,
  type ModelRoutingPresetsV1,
  modelClassForClaudeModel,
  modelClassForGeminiModel,
} from "../../mcp-server/src/host-execution-adapters.js";
import {
  claudeCodeActorId,
  findToolUseObservation,
  handleHostAttestationHook,
  probeIssuingMessage,
  handleCodexHostAttestationHook,
  observedEffort,
  readSessionModel,
  type SessionModelRecord,
  sessionModelUpdate,
  transcriptCandidates,
  withoutCallerAttestation,
  writeSessionModel,
} from "../../mcp-server/src/host-attestation-hook.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { resolveHostAttestation } from "../../mcp-server/src/runtime-config.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { classificationInputSchema, selectionInputSchema, type SkillClassificationGateway } from "../../mcp-server/src/skill-classification/gateway.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore, type WorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { createSyntheticRootProofFixture } from "./synthetic-root-proof-client.js";
import { CURRENT_VERSION } from "./version-fixtures.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const TOOL_PREFIX = "mcp__plugin_agent-governance-suite_agent-governance-suite__";
const SESSION = "session-attest";
const TRANSCRIPT = path.join("transcripts", `${SESSION}.jsonl`);

// Raw observation is retained; only the real provider may create an ExecutionContext.
function expectIneligibleObservation(store: WorkflowStore, adapter: HostExecutionAdapter, input: Record<string, unknown>): void {
  const token = input[HOST_ATTESTATION_FIELD];
  expect(token).toEqual(expect.stringMatching(/^aghs2\.[^.]+\.[^.]+$/u));
  expect(JSON.parse(Buffer.from(String(token).split(".")[1]!, "base64url").toString("utf8")))
    .toMatchObject({ v: 2, eligibility: null });
  const provider = new HostAttestationProvider(store, adapter);
  const binding = hostAttestationBinding("plan_workflow", input);
  const taskId = binding?.taskId;
  if (!binding || !taskId) throw new Error("Owned bootstrap fixture is missing its task binding.");
  let failure: unknown;
  try {
    provider.run("plan_workflow", input, () => provider.observe({ ...binding, taskId }));
  } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "BINDING_INVALID",
    message: "Host observation has no matching trusted execution capability and policy revision." });
  expect(provider.lastObservedCapability()).toBeNull();
}

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
  hookEffort?: string;
  now?: Date;
  adapter?: HostExecutionAdapter;
}

/** Runs the hook the way Claude Code would and returns the tool input it hands to the server. */
function attest(store: WorkflowStore, tool: string, input: Record<string, unknown>, options: AttestOptions = {}): Record<string, unknown> {
  toolUseSequence += 1;
  const toolUseId = `toolu_${String(toolUseSequence).padStart(6, "0")}`;
  if (options.adapter === codexExecutionAdapter) {
    const model = options.model ?? "gpt-6-astra";
    const output = handleCodexHostAttestationHook({
      hook_event_name: "PreToolUse", session_id: SESSION, turn_id: "codex-turn", model,
      transcript_path: TRANSCRIPT, tool_name: `${TOOL_PREFIX}${tool}`, tool_use_id: toolUseId, tool_input: input,
    }, store, { ...(options.now ? { now: () => options.now! } : {}), readMetadata: () => ({
      head: JSON.stringify({ type: "session_meta", payload: { id: SESSION, source: "cli" } }),
      tail: JSON.stringify({ type: "turn_context", payload: { turn_id: "codex-turn", model, effort: options.effort ?? "high" } }),
    }) });
    const updated = (output.hookSpecificOutput as { updatedInput: Record<string, unknown> }).updatedInput;
    if (!updated[HOST_ATTESTATION_FIELD]) throw new Error("Codex hook did not attest the call");
    return updated;
  }
  if (options.adapter === geminiExecutionAdapter) {
    const model = options.model ?? "gemini-2.5-pro";
    const token = issueHostAttestation(store, geminiExecutionAdapter, {
      tool,
      input,
      model,
      reasoningEffort: options.effort ?? "high",
      actorId: hostActorId("gemini", SESSION),
      sessionId: SESSION,
      turnId: "gemini-turn",
      toolUseId,
      ...(options.now ? { now: options.now } : {}),
    });
    if (!token) throw new Error("Gemini attestation did not attest the call");
    return { ...input, [HOST_ATTESTATION_FIELD]: token };
  }
  const transcript = `${transcriptLine("toolu_other")}\n${transcriptLine(toolUseId, options)}\n`;
  const output = handleHostAttestationHook(
    {
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      transcript_path: TRANSCRIPT,
      tool_name: `${TOOL_PREFIX}${tool}`,
      tool_use_id: toolUseId,
      tool_input: input,
      effort: { level: options.hookEffort ?? options.effort ?? "high" },
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
  updates: PluginUpdateService;
  service: WorkflowService;
  client: Client;
  store: InMemoryWorkflowStore;
  rootArguments(tool: string, args: Record<string, unknown>): Record<string, unknown>;
  call<T>(name: string, args: Record<string, unknown>): Promise<ApiResultV1<T>>;
}

const openServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()!();
});

async function harness(withProvider: boolean, adapter: HostExecutionAdapter = claudeCodeExecutionAdapter, classification: SkillClassificationGateway | null = null): Promise<Harness> {
  const rootProof = createSyntheticRootProofFixture();
  const validator = new ContractValidator();
  const store = new InMemoryWorkflowStore();
  const provider = withProvider ? new HostAttestationProvider(store, adapter) : null;
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
  const updates = new PluginUpdateService(updateStore);
  const server = createMcpServer(
    service,
    updates,
    undefined,
    undefined,
    undefined,
    validator,
    "anthropic",
    provider,
    null,
    undefined,
    null,
    classification,
    rootProof.proofs,
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
    updates,
    service,
    client,
    store,
    rootArguments: rootProof.argumentsFor,
    // Sign the exact post-attestation arguments. A fresh root proof lets model replay checks reach their own verifier.
    call: async <T>(name: string, args: Record<string, unknown>) => result<T>(await client.callTool({ name, arguments: rootProof.argumentsFor(name, args) })),
  };
}

function planArguments(taskId: string): Record<string, unknown> {
  return { schemaVersion: "1.0.0", taskEnvelope: task(taskId) };
}

describe("Claude Code host attestation through the MCP boundary", () => {
  it.each([
    { adapter: claudeCodeExecutionAdapter, model: "claude-opus-5", modelClass: "deep", stageModel: "claude-fable-5-1" },
    { adapter: codexExecutionAdapter, model: "gpt-6-astra", modelClass: "frontier", stageModel: "gpt-6-astra" },
    { adapter: codexExecutionAdapter, model: "gpt-6-sol", modelClass: "general", stageModel: "gpt-6-astra" },
    { adapter: geminiExecutionAdapter, model: "gemini-2.5-pro", modelClass: "deep", stageModel: "gemini-ultra" },
  ])("completes an orchestrated workflow with $adapter.host observations", async ({ adapter, model, modelClass, stageModel }) => {
    const { store, call } = await harness(true, adapter);
    const taskEnvelope = task("attest-complete");
    taskEnvelope.artifactContracts = [{ capability: "task-decomposition", produced:
      ["delegation-decision", "task-graph", "assignment-briefs", "integration-report"].map((artifactId) => ({
        artifactId, schemaId: "host-attestation/v1", targetDigest: `sha256:${"b".repeat(64)}` as const,
      })),
    }];
    const planned = await call<WorkflowPlanV1>("plan_workflow", attest(store, "plan_workflow",
      { schemaVersion: "1.0.0", taskEnvelope }, { adapter, model }));
    expect(planned.error).toBeNull();
    const plan = planned.data!;
    expect(plan.bootstrapExecution?.context).toMatchObject({
      model,
      modelClass,
      reasoningEffort: "high",
      source: "runtime",
      taskId: "attest-complete",
      actorId: hostActorId(adapter.host, SESSION),
    });
    expect(JSON.stringify(plan)).not.toContain(SESSION);

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
      actorId: plan.bootstrapExecution!.context.actorId,
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
        artifacts: taskEnvelope.artifactContracts[0]!.produced.map(({ artifactId, schemaId, targetDigest }) => ({
          artifactId,
          schemaId,
          locator: `fixture:${artifactId}`,
          digest: "d".repeat(64),
          targetDigest,
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
    const recorded = await call<WorkflowReceiptV1>("record_stage_result", attest(store, "record_stage_result", stageArguments, { adapter, model: stageModel, effort: "xhigh" }));
    expect(recorded.error).toBeNull();
    expect(recorded.data!.stageResults[0]?.executionContext).toMatchObject({
      model: stageModel,
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

  it("rejects missing root proof and caller session bindings before host attestation", async () => {
    const { client, service } = await harness(true);
    const plan = vi.spyOn(service, "planWorkflow");
    const args = planArguments("root-proof-negative");
    const missing = result<WorkflowPlanV1>(await client.callTool({ name: "plan_workflow", arguments: args }));
    expect(missing.error).toMatchObject({ code: "BINDING_REQUIRED", details: { reasonCode: "ROOT_HOOK_PROOF_REQUIRED" } });
    const forged = result<WorkflowPlanV1>(await client.callTool({ name: "plan_workflow", arguments: { ...args, _sessionBinding: { host: "claude-code", sessionId: SESSION } } }));
    expect(forged.error).toMatchObject({ code: "BINDING_INVALID", details: { reasonCode: "CALLER_SESSION_BINDING_REJECTED" } });
    expect(plan).not.toHaveBeenCalled();
  });

  it("fails closed without a token", async () => {
    const { call } = await harness(true);
    const planned = await call<WorkflowPlanV1>("plan_workflow", planArguments("no-token"));
    expect(planned.error?.code).toBe("BINDING_REQUIRED");
  });

  it.each([claudeCodeExecutionAdapter, codexExecutionAdapter, geminiExecutionAdapter])("rejects different calls, signatures, replays and expiry for $host", async (adapter) => {
    const { store, call } = await harness(true, adapter);

    const attested = attest(store, "plan_workflow", planArguments("tampered"), { adapter });
    const tampered = {
      ...attested,
      taskEnvelope: { ...task("tampered"), objective: "Changed after attestation." },
    };
    expect((await call<WorkflowPlanV1>("plan_workflow", tampered)).error?.code).toBe("BINDING_INVALID");

    const forgedInput = attest(store, "plan_workflow", planArguments("forged"), { adapter });
    const token = String(forgedInput[HOST_ATTESTATION_FIELD]);
    const forged = { ...forgedInput, [HOST_ATTESTATION_FIELD]: `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}` };
    expect((await call<WorkflowPlanV1>("plan_workflow", forged)).error?.code).toBe("BINDING_INVALID");

    const foreignStore = new InMemoryWorkflowStore();
    const foreign = attest(foreignStore, "plan_workflow", planArguments("foreign-key"), { adapter });
    expect((await call<WorkflowPlanV1>("plan_workflow", foreign)).error?.code).toBe("BINDING_INVALID");

    const once = attest(store, "plan_workflow", planArguments("replay"), { adapter });
    expect((await call<WorkflowPlanV1>("plan_workflow", once)).ok).toBe(true);
    expect((await call<WorkflowPlanV1>("plan_workflow", once)).error?.code).toBe("BINDING_INVALID");

    const expired = attest(store, "plan_workflow", planArguments("expired"), { adapter, now: new Date(Date.now() - 10 * 60 * 1000) });
    expect((await call<WorkflowPlanV1>("plan_workflow", expired)).error?.code).toBe("BINDING_INVALID");
  });

  it("accepts an observation that waited on a permission prompt for up to five minutes", async () => {
    const { store, call } = await harness(true);
    const waited = attest(store, "plan_workflow", planArguments("waited"), { now: new Date(Date.now() - 4 * 60 * 1000) });
    const planned = await call<WorkflowPlanV1>("plan_workflow", waited);
    expect(planned.error).toBeNull();
    const context = planned.data!.bootstrapExecution!.context;
    expect(Date.parse(context.expiresAt!) - Date.parse(context.observedAt)).toBe(5 * 60 * 1000);
  });

  it("does not over-report effort when the transcript message ran lower than the hook reports", async () => {
    const { store, call } = await harness(true);
    const mixed = attest(store, "plan_workflow", planArguments("mixed-effort"), { effort: "low", hookEffort: "high" });
    expect((await call<WorkflowPlanV1>("plan_workflow", mixed)).error?.code).toBe("BINDING_INVALID");
  });

  it("enforces the planned assurance floor on the observed model and effort", async () => {
    const { store, call } = await harness(true);
    const lightweight = attest(store, "plan_workflow", planArguments("haiku"), { model: "claude-haiku-4-5-20251001" });
    expect((await call<WorkflowPlanV1>("plan_workflow", lightweight)).error?.code).toBe("BINDING_INVALID");
    const lowEffort = attest(store, "plan_workflow", planArguments("low-effort"), { effort: "low" });
    expect((await call<WorkflowPlanV1>("plan_workflow", lowEffort)).error?.code).toBe("BINDING_INVALID");
  });

  it.each([claudeCodeExecutionAdapter, codexExecutionAdapter])("strips caller skill observations before signing %s tool arguments", async (adapter) => {
    const { store, call } = await harness(true, adapter);
    const clean = planArguments(`caller-skill-claims-${adapter.host}`);
    const signed = attest(store, "plan_workflow", { ...clean,
      [HOST_ATTESTATION_FIELD]: "aghs1.caller.forged",
      _hostSkillObservation: { actorId: "caller", sourceRef: "caller", skills: [] },
    }, { adapter });
    expect(signed).toEqual({ ...clean, [HOST_ATTESTATION_FIELD]: expect.any(String) });
    expect(signed[HOST_ATTESTATION_FIELD]).not.toBe("aghs1.caller.forged");
    expect((await call<WorkflowPlanV1>("plan_workflow", signed)).error).toBeNull();
  });

  it("keeps Sol general and Luna lightweight below a deep bootstrap floor", async () => {
    const adapter = codexExecutionAdapter;
    const { store, call } = await harness(true, adapter);
    const deep = { schemaVersion: "1.0.0", taskEnvelope: { ...task("sol-deep-floor"), riskLevel: "high" } };
    expect((await call<WorkflowPlanV1>("plan_workflow", attest(store, "plan_workflow", deep,
      { adapter, model: "gpt-6-sol" }))).error?.code).toBe("BINDING_INVALID");
    expect((await call<WorkflowPlanV1>("plan_workflow", attest(store, "plan_workflow", planArguments("luna-general-floor"),
      { adapter, model: "gpt-6-luna" }))).error?.code).toBe("BINDING_INVALID");
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
    expect(updated.updatedInput[HOST_ATTESTATION_FIELD]).toMatch(/^aghs2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
    expect(updated.updatedInput[HOST_ATTESTATION_FIELD]).not.toBe("aghs1.caller.forged");
  });

  it("removes a caller-supplied token whenever it cannot attest the call", async () => {
    const callerInput = { taskId: "hook-task", [HOST_ATTESTATION_FIELD]: "aghs1.caller.forged",
      _hostSkillObservation: { actorId: "caller", sourceRef: "caller", skills: [] } };
    const unknownModel = handleHostAttestationHook({ ...base, tool_input: callerInput }, store,
      { ...noWait, readText: () => transcriptLine("toolu_hook", { model: "gpt-5.6-sol" }) });
    const unknownInput = (unknownModel.hookSpecificOutput as { updatedInput: Record<string, unknown> }).updatedInput;
    expect(unknownInput[HOST_ATTESTATION_FIELD]).not.toBe("aghs1.caller.forged");
    expectIneligibleObservation(store, claudeCodeExecutionAdapter, unknownInput);
    const unattested = [
      handleHostAttestationHook({ ...base, tool_input: callerInput }, store, { ...noWait, maxWaitMs: 0, readText: () => null }),
      handleHostAttestationHook({ ...base, tool_input: callerInput, transcript_path: undefined }, store, noWait),
      withoutCallerAttestation({ ...base, tool_input: callerInput }),
    ];
    const codexFailure = handleCodexHostAttestationHook({ ...base, tool_input: callerInput }, store,
      { readMetadata: () => ({ head: "", tail: "" }) });
    expect((codexFailure.hookSpecificOutput as { updatedInput: Record<string, unknown> }).updatedInput)
      .toEqual({ taskId: "hook-task" });
    for (const output of unattested) {
      expect(output).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { taskId: "hook-task" } } });
    }
    expect(withoutCallerAttestation(base)).toEqual({});
    expect(withoutCallerAttestation({ ...base, tool_input: { taskId: "hook-task",
      _hostSkillObservation: { actorId: "caller", sourceRef: "caller", skills: [] } } }))
      .toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { taskId: "hook-task" } } });
    expect(withoutCallerAttestation({ ...base, tool_name: "Bash", tool_input: callerInput })).toEqual({});

    // A stripped call reaches the server without a token and fails closed.
    const { call } = await harness(true);
    const planInput = { ...planArguments("stripped"), [HOST_ATTESTATION_FIELD]: "aghs1.caller.forged" };
    const output = handleHostAttestationHook({ ...base, tool_input: planInput }, store, { ...noWait, maxWaitMs: 0, readText: () => null });
    const stripped = (output.hookSpecificOutput as { updatedInput: Record<string, unknown> }).updatedInput;
    expect(stripped).toEqual(planArguments("stripped"));
    expect((await call<WorkflowPlanV1>("plan_workflow", stripped)).error?.code).toBe("BINDING_REQUIRED");
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

  it("retains unknown-model observations but rejects missing effort, foreign sessions or sidechain messages", () => {
    const read = (line: string) => ({ ...noWait, maxWaitMs: 0, readText: () => line });
    const unknown = handleHostAttestationHook(base, store, read(transcriptLine("toolu_hook", { model: "gpt-5.6-sol" })));
    expectIneligibleObservation(store, claudeCodeExecutionAdapter,
      (unknown.hookSpecificOutput as { updatedInput: Record<string, unknown> }).updatedInput);
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
    expect(payload).toMatchObject({ model: "claude-sonnet-5", eligibility: { modelClass: "general" }, actorId: claudeCodeActorId(SESSION, "agent123") });
    expect(claudeCodeActorId(SESSION, "agent123")).toMatch(/^claude-code:session-[0-9a-f]{24}:agent-[0-9a-f]{24}$/u);
    expect(claudeCodeActorId(SESSION, "agent123")).not.toBe(claudeCodeActorId(SESSION, "agent456"));
  });

  describe("interactive sessions, where the issuing message is written only after the call", () => {
    const at = (iso: string) => ({ timestamp: iso });
    const written = (options: Parameters<typeof transcriptLine>[1] & { timestamp?: string } = {}) =>
      JSON.stringify({ ...JSON.parse(transcriptLine("toolu_previous", options)), ...at(options.timestamp ?? "2026-09-19T00:10:12.000Z") });
    const payloadOf = (output: Record<string, unknown>) => {
      const token = String((output.hookSpecificOutput as { updatedInput: Record<string, unknown> }).updatedInput[HOST_ATTESTATION_FIELD]);
      return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    };
    const record = (model: string, observedAt: string, source: SessionModelRecord["source"] = "model-switch"): SessionModelRecord => ({ model, source, observedAt });
    const now = () => new Date("2026-09-19T00:11:00.000Z");
    const run = (transcript: string | null, session: SessionModelRecord | null, input: Record<string, unknown> = base) =>
      handleHostAttestationHook(input, store, { ...noWait, maxWaitMs: 0, now, readText: () => transcript, readSessionModel: () => session });
    const callerInput = { ...base, tool_input: { taskId: "hook-task", [HOST_ATTESTATION_FIELD]: "aghs1.caller.forged" } };
    const stripped = { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { taskId: "hook-task" } } };

    it("attests the SessionStart model before the session has written any message", () => {
      expect(payloadOf(run(null, record("claude-opus-5", "2026-09-19T00:10:01.000Z", "session-start")))).toMatchObject({ model: "claude-opus-5", reasoningEffort: "high" });
    });

    it("prefers the newer of the last written message and the session model record", () => {
      const switched = record("claude-sonnet-5", "2026-09-19T00:10:18.000Z");
      expect(payloadOf(run(written({ model: "claude-opus-5" }), switched))).toMatchObject({ model: "claude-sonnet-5", eligibility: { modelClass: "general" } });
      const started = record("claude-sonnet-5", "2026-09-19T00:10:01.000Z", "session-start");
      expect(payloadOf(run(written({ model: "claude-opus-5" }), started))).toMatchObject({ model: "claude-opus-5", eligibility: { modelClass: "deep" } });
    });

    it("takes effort only from the hook, never from an earlier message that may belong to another model", () => {
      expect(payloadOf(run(written({ model: "claude-opus-5", effort: "low" }), null))).toMatchObject({ model: "claude-opus-5", reasoningEffort: "high" });
      // A model without effort support (Haiku) sends no hook effort; an earlier Opus message must not stand in for it.
      expect(run(written({ model: "claude-opus-5", effort: "xhigh" }), null, { ...callerInput, effort: undefined })).toEqual(stripped);
      expect(run(written({ model: "claude-opus-5", effort: "high" }), record("claude-opus-5", "2026-09-19T00:10:01.000Z", "session-start"), { ...callerInput, effort: undefined })).toEqual(stripped);
    });

    it("skips messages of other sessions, sidechains, unknown models, missing session IDs and future timestamps", () => {
      const lines = [
        written({ model: "claude-opus-5" }),
        written({ sessionId: "other", model: "claude-fable-5-1" }),
        written({ isSidechain: true, model: "claude-fable-5-1" }),
        JSON.stringify({ ...JSON.parse(written()), message: { model: "<synthetic>", content: [] } }),
        JSON.stringify({ ...JSON.parse(written({ model: "claude-fable-5-1" })), sessionId: undefined }),
        written({ model: "claude-fable-5-1", timestamp: "2026-09-19T01:00:00.000Z" }),
      ].join("\n");
      expect(payloadOf(run(lines, null))).toMatchObject({ model: "claude-opus-5" });
      const undated = JSON.stringify({ ...JSON.parse(written({ model: "claude-fable-5-1" })), timestamp: undefined });
      expect(run(undated, null, callerInput)).toEqual(stripped);
    });

    it("does not fall back when the issuing message was found but rejected", () => {
      const session = record("claude-opus-5", "2026-09-19T00:10:01.000Z", "session-start");
      const issued = (options: Parameters<typeof transcriptLine>[1]) => transcriptLine("toolu_hook", options);
      expect(run(issued({ sessionId: "other" }), session, callerInput)).toEqual(stripped);
      expect(run(issued({ isSidechain: true }), session, callerInput)).toEqual(stripped);
      const noModel = JSON.stringify({ ...JSON.parse(issued({})), message: { content: [{ type: "tool_use", id: "toolu_hook", name: "tool", input: {} }] } });
      expect(run(noModel, session, callerInput)).toEqual(stripped);
    });

    it("requires model and effort observations and retains an ineligible switched model", () => {
      expect(run(null, null, callerInput)).toEqual(stripped);
      expect(run(null, record("claude-opus-5", "2026-09-19T00:10:01.000Z", "session-start"), { ...callerInput, effort: undefined })).toEqual(stripped);
      const unknown = run(written(), record("claude-next", "2026-09-19T00:10:18.000Z"), callerInput);
      expectIneligibleObservation(store, claudeCodeExecutionAdapter,
        (unknown.hookSpecificOutput as { updatedInput: Record<string, unknown> }).updatedInput);
    });

    it("uses only the subagent's own written messages, never the session model", () => {
      const session = record("claude-fable-5-1", "2026-09-19T00:10:18.000Z");
      const subagent = { ...base, agent_id: "agent123" };
      expect(run(null, session, subagent)).toEqual({});
      const own = written({ isSidechain: true, agentId: "agent123", model: "claude-sonnet-5" });
      expect(payloadOf(run(own, session, subagent))).toMatchObject({ model: "claude-sonnet-5", actorId: claudeCodeActorId(SESSION, "agent123") });
    });

    it("records the main-thread model from SessionStart and PostModelSwitch only", () => {
      const now = new Date("2026-09-19T00:10:01.000Z");
      expect(sessionModelUpdate({ hook_event_name: "SessionStart", session_id: SESSION, source: "startup", model: "claude-opus-5" }, now))
        .toEqual({ sessionId: SESSION, record: { model: "claude-opus-5", source: "session-start", observedAt: "2026-09-19T00:10:01.000Z" } });
      expect(sessionModelUpdate({ hook_event_name: "PostModelSwitch", session_id: SESSION, from_model: "claude-opus-5", to_model: "claude-haiku-4-5-20251001" }, now)?.record.model)
        .toBe("claude-haiku-4-5-20251001");
      expect(sessionModelUpdate({ hook_event_name: "PreModelSwitch", session_id: SESSION, to_model: "claude-sonnet-5" }, now)).toBeNull();
      expect(sessionModelUpdate({ hook_event_name: "SessionStart", session_id: SESSION, source: "resume" }, now)).toBeNull();
      expect(sessionModelUpdate({ hook_event_name: "PostModelSwitch", session_id: SESSION, agent_id: "agent123", to_model: "claude-opus-5" }, now)).toBeNull();
    });

    it("stores the session model under a digest and preserves the inherited F6 missing/damaged distinction", () => {
      const directory = mkdtempSync(path.join(tmpdir(), "host-models-"));
      try {
        const stored = { model: "claude-opus-5", source: "session-start" as const, observedAt: "2026-09-19T00:10:01.000Z" };
        writeSessionModel(directory, SESSION, stored);
        expect(readdirSync(directory)).toEqual([expect.stringMatching(/^[0-9a-f]{24}\.json$/u)]);
        expect(readSessionModel(directory, SESSION)).toEqual(stored);
        expect(readSessionModel(directory, "other")).toBeNull();
        writeFileSync(path.join(directory, readdirSync(directory)[0]!), "{not json");
        expect(() => readSessionModel(directory, SESSION)).toThrow("SESSION_MODEL_INVALID");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("finds the message that issued the tool call, not a later mention of its ID", () => {
    const mention = JSON.stringify({ type: "user", sessionId: SESSION, message: { content: [{ type: "tool_result", tool_use_id: "toolu_hook" }] } });
    expect(findToolUseObservation(`${transcriptLine("toolu_hook", { model: "claude-opus-5" })}\n${mention}\n`, "toolu_hook", SESSION, null))
      .toEqual({ model: "claude-opus-5", effort: "high" });
  });
});

describe("host attestation configuration", () => {
  it("selects actual bundled adapters and keeps missing names without a provider", () => {
    expect(resolveHostAttestation({})).toBeNull();
    expect(resolveHostAttestation({ AGENT_GOVERNANCE_HOST_ATTESTATION: "codex" })).toBe(codexExecutionAdapter);
    expect(resolveHostAttestation({ AGENT_GOVERNANCE_HOST_ATTESTATION: "unconfigured-host" })).toBeNull();
    expect(resolveHostAttestation({ AGENT_GOVERNANCE_HOST_ATTESTATION: "claude-code" })).toBe(claudeCodeExecutionAdapter);
    expect(resolveHostAttestation({ AGENT_GOVERNANCE_HOST_ATTESTATION: "gemini" })).toBe(geminiExecutionAdapter);
  });

  function fourthHostCatalog(): ModelRoutingPresetsV1 {
    return {schema_version: 1, policy_revision: "synthetic-fourth-r1",
      model_class_order: ["lightweight", "general", "deep", "frontier"], effort_order: ["low", "high"],
      providers: {"synthetic-fourth-provider": {host: "synthetic-fourth-host", catalog: {matching: "exact-only",
        models: {"opaque-fourth-model": {model_class: "deep", minimum_effort: "high", supported_efforts: ["high"]}}}}}};
  }

  it("binds one actual fourth-host adapter through the same resolver and signed MCP boundary", async () => {
    const suite = createCatalogExecutionAdapters(fourthHostCatalog());
    const adapter = resolveHostAttestation({AGENT_GOVERNANCE_HOST_ATTESTATION: "synthetic-fourth-host"}, suite.adapters);
    expect(adapter).toBe(suite.adapters.get("synthetic-fourth-host"));
    expect(adapter!.resolveModel!("opaque-fourth-model")).toMatchObject({host: "synthetic-fourth-host", provider: "synthetic-fourth-provider", modelClass: "deep", supportedEfforts: ["high"]});
    const {store, call} = await harness(true, adapter!);
    const args = planArguments("fourth-host-task");
    const observation = {tool: "plan_workflow", input: args, model: "opaque-fourth-model", reasoningEffort: "high",
      actorId: hostActorId(adapter!.host, SESSION), sessionId: SESSION, turnId: "fourth-turn", toolUseId: "fourth-call"};
    const token = issueHostAttestation(store, adapter!, observation);
    expect(token).toEqual(expect.any(String));
    // Fresh unconsumed token: preserve task identity while changing only signed input.
    const wrongArgs = {...args, taskEnvelope: {...(args.taskEnvelope as Record<string, unknown>), objective: "changed signed input"}};
    const wrongInput = await call<WorkflowPlanV1>("plan_workflow", {...wrongArgs, [HOST_ATTESTATION_FIELD]: token});
    expect(wrongInput).toMatchObject({ok: false, error: {code: "BINDING_INVALID"}});
    const planned = await call<WorkflowPlanV1>("plan_workflow", {...args, [HOST_ATTESTATION_FIELD]: token});
    expect(planned.ok).toBe(true);
    expect(planned.data!.bootstrapExecution!.context).toMatchObject({model: "opaque-fourth-model", modelClass: "deep", reasoningEffort: "high", actorId: hostActorId(adapter!.host, SESSION)});
    expect(issueHostAttestation(store, adapter!, {...observation, actorId: hostActorId("codex", SESSION)})).toBeNull();
    for (const rejected of [
      {...observation, model: "unobserved-model", toolUseId: "fourth-unknown"},
      {...observation, reasoningEffort: "low", toolUseId: "fourth-low"},
    ]) {
      const rawToken = issueHostAttestation(store, adapter!, rejected);
      expectIneligibleObservation(store, adapter!, {...args, [HOST_ATTESTATION_FIELD]: rawToken});
      expect(await call<WorkflowPlanV1>("plan_workflow", {...args, [HOST_ATTESTATION_FIELD]: rawToken}))
        .toMatchObject({ok: false, error: {code: "BINDING_INVALID",
          message: "Host observation has no matching trusted execution capability and policy revision."}});
    }
    const noProvider = await harness(false);
    expect(await noProvider.call<WorkflowPlanV1>("plan_workflow", args))
      .toMatchObject({ok: false, error: {code: "BINDING_REQUIRED"}});
    // A hook token without its verification provider is an explicit binding configuration error.
    expect(await noProvider.call<WorkflowPlanV1>("plan_workflow", {...args, [HOST_ATTESTATION_FIELD]: token}))
      .toMatchObject({ok: false, error: {code: "BINDING_REQUIRED"}});
    // Synthetic fixture authority only; this does not qualify or enable a live fourth host.
  });

  it.each(["plan_workflow", "record_stage_result", "classify_skills", "record_skill_selection"])(
    "rejects an unverifiable hook field before dispatching providerless %s", async (tool) => {
      const classification: SkillClassificationGateway = {
        inventory: vi.fn(async () => ({})),
        classify: vi.fn(async (input: unknown) => classificationInputSchema.parse(input)),
        accept: vi.fn(async (input: unknown) => selectionInputSchema.parse(input)),
      };
      const server = await harness(false, claudeCodeExecutionAdapter, classification);
      const updateCheck = vi.spyOn(server.updates, "check");
      const plan = vi.spyOn(server.service, "planWorkflow");
      const stage = vi.spyOn(server.service, "recordStageResult");
      const input = tool === "plan_workflow" ? planArguments("providerless-guard") : {};
      for (const token of ["synthetic-unverified-hook-token", null]) {
        const rejected = await server.call(tool, { ...input, [HOST_ATTESTATION_FIELD]: token });
        expect(rejected).toMatchObject({ ok: false, data: null, error: { code: "BINDING_REQUIRED" } });
        expect(rejected.error!.message).toContain("not configured");
        expect(JSON.stringify(rejected)).not.toContain("synthetic-unverified-hook-token");
      }
      // A rejected configuration must not trigger unrelated update or provider I/O.
      expect(updateCheck).not.toHaveBeenCalled();
      expect(plan).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      expect(classification.classify).not.toHaveBeenCalled();
      expect(classification.accept).not.toHaveBeenCalled();
      // Without the field, malformed classification input is rejected before gateway dispatch.
      // Workflow tools retain their existing service-level validation path.
      const plain = await server.call(tool, input);
      expect(plain).toMatchObject({ ok: false, error: { code: tool === "plan_workflow" ? "BINDING_REQUIRED" : "INVALID_INPUT" } });
      if (tool === "plan_workflow") expect(plan).toHaveBeenCalledTimes(1);
      if (tool === "record_stage_result") expect(stage).toHaveBeenCalledTimes(1);
      if (tool === "classify_skills") expect(classification.classify).not.toHaveBeenCalled();
      if (tool === "record_skill_selection") expect(classification.accept).not.toHaveBeenCalled();
    },
  );

  it("preserves normal argument rejection for a tool outside the attested set", async () => {
    const classification: SkillClassificationGateway = {
      inventory: vi.fn(async () => ({ status: "synthetic inventory" })),
      classify: vi.fn(async () => null),
      accept: vi.fn(async () => null),
    };
    const server = await harness(false, claudeCodeExecutionAdapter, classification);
    const rejected = await server.call("get_skill_inventory", { [HOST_ATTESTATION_FIELD]: "synthetic-unverified-hook-token" });
    expect(rejected).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(classification.inventory).not.toHaveBeenCalled();
    expect(await server.call("get_skill_inventory", {})).toMatchObject({ ok: true, data: { status: "synthetic inventory" } });
    expect(classification.inventory).toHaveBeenCalledTimes(1);
  });

  it("does not create an adapter from an environment name, a missing host, or a mismatched registry entry", () => {
    const suite = createCatalogExecutionAdapters(fourthHostCatalog());
    expect(resolveHostAttestation({AGENT_GOVERNANCE_HOST_ATTESTATION: "codex"}, suite.adapters)).toBeNull();
    expect(resolveHostAttestation({AGENT_GOVERNANCE_HOST_ATTESTATION: "forged-host"}, suite.adapters)).toBeNull();
    expect(resolveHostAttestation({AGENT_GOVERNANCE_HOST_ATTESTATION: "forged-host"}, new Map([["forged-host", codexExecutionAdapter]]))).toBeNull();
    const catalog = fourthHostCatalog();
    const providerCatalog = catalog.providers["synthetic-fourth-provider"]!.catalog;
    if (!providerCatalog) throw new Error("Missing synthetic provider catalog fixture");
    const missing = {...catalog, providers: {"synthetic-fourth-provider": {catalog: providerCatalog}}};
    expect(() => createCatalogExecutionAdapters(missing)).toThrow("INVALID_EXECUTION_ADAPTER_HOST");
    const invalidHost = {...catalog, providers: {"synthetic-fourth-provider": {...catalog.providers["synthetic-fourth-provider"]!, host: "invalid host"}}};
    expect(() => createCatalogExecutionAdapters(invalidHost)).toThrow("INVALID_EXECUTION_ADAPTER_HOST");
    for (const malformed of [null, {}, [], {providers: null}, {providers: []}]) {
      expect(() => createCatalogExecutionAdapters(malformed as unknown as ModelRoutingPresetsV1)).toThrow("INVALID_EXECUTION_ADAPTER_CONFIGURATION");
    }
    expect(() => createCatalogExecutionAdapters({...catalog, providers: {invalid: null}} as unknown as ModelRoutingPresetsV1))
      .toThrow("INVALID_EXECUTION_ADAPTER_HOST");
    const ambiguous = fourthHostCatalog();
    const duplicate = {...ambiguous, providers: {...ambiguous.providers, "another-provider": ambiguous.providers["synthetic-fourth-provider"]!}};
    expect(() => createCatalogExecutionAdapters(duplicate)).toThrow("DUPLICATE_EXECUTION_ADAPTER_HOST");
  });

  it("keeps registry entries immutable through every exposed map view", () => {
    const suite = createCatalogExecutionAdapters(fourthHostCatalog());
    const view = suite.adapters, selected = view.get("synthetic-fourth-host")!;
    expect(Object.isFrozen(view)).toBe(true); expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.prototype.toString.call(view)).toBe("[object ReadonlyMap]");
    expect(view instanceof Map).toBe(false);
    expect(() => (view as Map<string, HostExecutionAdapter>).set("evil", codexExecutionAdapter)).toThrow(TypeError);
    expect(() => Map.prototype.set.call(view, "evil", codexExecutionAdapter)).toThrow(TypeError);
    expect(() => Map.prototype.delete.call(view, selected.host)).toThrow(TypeError);
    expect(() => Map.prototype.clear.call(view)).toThrow(TypeError);
    const thisArg = {marker: "readonly-view"};
    const callback = vi.fn(function(this: typeof thisArg, value: HostExecutionAdapter, host: string, callbackView: ReadonlyMap<string, HostExecutionAdapter>) {
      expect(this).toBe(thisArg); expect(callbackView).toBe(view);
      expect(value).toBe(selected); expect(host).toBe(selected.host);
      expect(() => (callbackView as Map<string, HostExecutionAdapter>).clear()).toThrow(TypeError);
    });
    view.forEach(callback, thisArg);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(selected, selected.host, view);
    const pair = [...view][0]!; pair[0] = "evil";
    expect(view.has("evil")).toBe(false); expect(view.get(selected.host)).toBe(selected); expect(view.size).toBe(1);
    expect(() => (defaultExecutionAdapters as Map<string, HostExecutionAdapter>).set("codex", selected)).toThrow(TypeError);
    expect(resolveHostAttestation({AGENT_GOVERNANCE_HOST_ATTESTATION: "codex"})).toBe(codexExecutionAdapter);
  });

  it("maps Gemini model families to the routing preset classes", () => {
    expect(modelClassForGeminiModel("gemini-2.5-flash-lite")).toBe("lightweight");
    expect(modelClassForGeminiModel("gemini-1.5-flash-8b")).toBe("lightweight");
    expect(modelClassForGeminiModel("gemini-2.5-flash")).toBe("general");
    expect(modelClassForGeminiModel("gemini-3.8-flash")).toBe("general");
    expect(modelClassForGeminiModel("gemini-2.5-pro")).toBe("deep");
    expect(modelClassForGeminiModel("gemini-3.8-pro")).toBe("deep");
    expect(modelClassForGeminiModel("gemini-ultra")).toBe("frontier");
    expect(modelClassForGeminiModel("models/gemini-2.5-flash")).toBe("general");
    expect(modelClassForGeminiModel("flash_lite")).toBe("lightweight");
    expect(modelClassForGeminiModel("flash")).toBe("general");
    expect(modelClassForGeminiModel("pro")).toBe("deep");
    expect(modelClassForGeminiModel("ultra")).toBe("frontier");
    expect(modelClassForGeminiModel("unknown-gemini")).toBeNull();
    expect(modelClassForGeminiModel("gpt-6-astra")).toBeNull();
  });

  it("maps Claude model families to the routing preset classes", () => {
    expect(modelClassForClaudeModel("claude-haiku-4-5-20251001")).toBe("lightweight");
    expect(modelClassForClaudeModel("claude-sonnet-5")).toBe("general");
    expect(modelClassForClaudeModel("claude-opus-5")).toBe("deep");
    expect(modelClassForClaudeModel("claude-fable-5-1")).toBe("frontier");
    expect(modelClassForClaudeModel("claude-3-5-sonnet-20241022")).toBe("general");
    expect(modelClassForClaudeModel("claude-3-opus-20240229")).toBe("deep");
    expect(modelClassForClaudeModel("us.anthropic.claude-opus-5-v1:0")).toBe("deep");
    expect(modelClassForClaudeModel("global.anthropic.claude-sonnet-5-v1:0")).toBe("general");
    expect(modelClassForClaudeModel("us-gov.anthropic.claude-3-5-sonnet-20240620-v1:0")).toBe("general");
    expect(modelClassForClaudeModel("anthropic.claude-3-haiku-20240307-v1:0")).toBe("lightweight");
    expect(modelClassForClaudeModel("claude-opus-5@20260101")).toBe("deep");
    expect(modelClassForClaudeModel("claude-opusx")).toBeNull();
    expect(modelClassForClaudeModel("xclaude-opus-5")).toBeNull();
    expect(modelClassForClaudeModel("claude-instant-1")).toBeNull();
    expect(modelClassForClaudeModel("gpt-6-astra")).toBeNull();
  });

  it("attests the lower effort when the hook and the transcript message disagree", () => {
    expect(observedEffort("high", "low")).toBe("low");
    expect(observedEffort("medium", "xhigh")).toBe("medium");
    expect(observedEffort("high", null)).toBe("high");
    expect(observedEffort(null, "max")).toBe("max");
    expect(observedEffort("turbo", "high")).toBe("high");
    expect(observedEffort(null, null)).toBeNull();
  });
});


describe("AGS-D-0179 correlated issuing observations", () => {
  function fixture179(toolInput = planArguments("d0179")) {
    const now = new Date();
    const older = JSON.stringify({ ...JSON.parse(transcriptLine("toolu_previous", { model: "claude-opus-5" })),
      timestamp: new Date(now.getTime() - 1000).toISOString() });
    const malformed = transcriptLine("toolu_hook", { model: "claude-haiku-4-5-20251001" }).slice(0, -1);
    const cache = vi.fn((): SessionModelRecord => ({ model: "claude-opus-5", source: "session-start",
      observedAt: new Date(now.getTime() - 500).toISOString() }));
    return { older, malformed, cache, toolInput, input: { hook_event_name: "PreToolUse", session_id: SESSION,
      transcript_path: TRANSCRIPT, tool_name: TOOL_PREFIX + "plan_workflow", tool_use_id: "toolu_hook",
      effort: { level: "high" }, tool_input: { ...toolInput, [HOST_ATTESTATION_FIELD]: "aghs1.caller.forged" } },
      options: { maxWaitMs: 0, sleep: () => {}, now: () => now, readSessionModel: cache } };
  }
  const updated179 = (value: Record<string, unknown>) =>
    (value.hookSpecificOutput as { updatedInput: Record<string, unknown> }).updatedInput;
  const payload179 = (value: Record<string, unknown>) =>
    JSON.parse(Buffer.from(String(updated179(value)[HOST_ATTESTATION_FIELD]).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;

  it("keeps absent, present and indeterminate distinct without treating mentions as issuers", () => {
    const f = fixture179();
    expect(probeIssuingMessage(f.older, "toolu_hook")).toEqual({ state: "absent" });
    expect(probeIssuingMessage(transcriptLine("toolu_hook"), "toolu_hook")).toEqual({ state: "present" });
    expect(probeIssuingMessage(f.malformed, "toolu_hook")).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INVALID_JSON" });
    const mention = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_hook" }] } });
    expect(probeIssuingMessage(mention, "toolu_hook")).toEqual({ state: "absent" });
    expect(probeIssuingMessage(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "toolu_hook" }] } }), "toolu_hook"))
      .toEqual({ state: "absent" });
    expect(probeIssuingMessage('{"type":"assistant","id":"unrelated"', "toolu_hook")).toEqual({ state: "absent" });
  });

  it("does not mint from an older strong model after a current malformed line, and the MCP stays BINDING_REQUIRED", async () => {
    const { store, client, rootArguments } = await harness(true);
    const f = fixture179();
    const key = vi.spyOn(store, "getOrCreateSecret");
    try {
      const output = handleHostAttestationHook(f.input, store, { ...f.options, readText: () => f.older + "\n" + f.malformed });
      expect(updated179(output)).toEqual(f.toolInput);
      expect(f.cache).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
      const reply = await client.callTool({ name: "plan_workflow", arguments: rootArguments("plan_workflow", updated179(output)) });
      expect(reply.isError).toBe(true);
      expect(result<WorkflowPlanV1>(reply)).toMatchObject({ ok: false, error: { code: "BINDING_REQUIRED" } });
    } finally { key.mockRestore(); }
  });

  it("does not use a strong main-session cache after a malformed current issuer", () => {
    const store = new InMemoryWorkflowStore();
    const f = fixture179();
    const key = vi.spyOn(store, "getOrCreateSecret");
    try {
      expect(updated179(handleHostAttestationHook(f.input, store, { ...f.options, readText: () => f.malformed }))).toEqual(f.toolInput);
      expect(f.cache).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    } finally { key.mockRestore(); }
  });

  it("keeps exact current evidence and its normal strict consumer path", async () => {
    const { store, call } = await harness(true);
    const f = fixture179();
    const output = handleHostAttestationHook(f.input, store, { ...f.options, readText: () => transcriptLine("toolu_hook") });
    expect(updated179(output)[HOST_ATTESTATION_FIELD]).not.toBe("aghs1.caller.forged");
    expect(payload179(output)).toMatchObject({ model: "claude-opus-5", tool: "plan_workflow" });
    expect((await call<WorkflowPlanV1>("plan_workflow", updated179(output))).error).toBeNull();
    expect(f.cache).not.toHaveBeenCalled();
  });

  it("keeps genuine absence and ignores unrelated damaged rows", () => {
    const store = new InMemoryWorkflowStore();
    const f = fixture179();
    const input = f.older + '\n{"type":"assistant","unrelated":';
    const output = handleHostAttestationHook(f.input, store, { ...f.options, readText: () => input });
    expect(payload179(output)).toMatchObject({ model: "claude-opus-5", reasoningEffort: "high" });
    expect(f.cache).toHaveBeenCalledTimes(1);
    expect(payload179(handleHostAttestationHook(f.input, store, { ...f.options, readText: () => null })))
      .toMatchObject({ model: "claude-opus-5", provenance: "claude-code:session-start" });
  });

  it("does not use fallback for correlated assistant metadata with an invalid content shape", () => {
    const f = fixture179();
    const malformedShape = JSON.stringify({ type: "assistant", message: { content: "toolu_hook" } });
    expect(probeIssuingMessage(malformedShape, "toolu_hook")).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" });
    expect(updated179(handleHostAttestationHook(f.input, new InMemoryWorkflowStore(), { ...f.options, readText: () => malformedShape }))).toEqual(f.toolInput);
    expect(f.cache).not.toHaveBeenCalled();
  });

  it("preserves bounded partial-to-valid polling while refusing persistent malformed evidence", () => {
    const f = fixture179();
    let reads = 0;
    const sleep = vi.fn();
    const output = handleHostAttestationHook(f.input, new InMemoryWorkflowStore(), { ...f.options, maxWaitMs: 20,
      pollIntervalMs: 10, sleep, readText: () => ++reads === 1 ? f.malformed : transcriptLine("toolu_hook") });
    expect(payload179(output)).toMatchObject({ model: "claude-opus-5" });
    expect(reads).toBe(2); expect(sleep.mock.calls).toEqual([[10]]);
    reads = 0; sleep.mockClear();
    const refused = handleHostAttestationHook(f.input, new InMemoryWorkflowStore(), { ...f.options, maxWaitMs: 20,
      pollIntervalMs: 10, sleep, readText: () => { reads++; return f.malformed; } });
    expect(updated179(refused)).toEqual(f.toolInput);
    expect(reads).toBe(4); expect(sleep.mock.calls).toEqual([[10], [10]]);
    expect(f.cache).not.toHaveBeenCalled();
  });

  it("retains existing valid-exact precedence over damaged duplicates and a subagent never uses the main cache", () => {
    const f = fixture179();
    const subagent = { ...f.input, agent_id: "d0179-agent" };
    const own = transcriptLine("toolu_hook", { agentId: "d0179-agent", isSidechain: true });
    const ownPath = transcriptCandidates(TRANSCRIPT, SESSION, "d0179-agent")[1]!;
    const output = handleHostAttestationHook(subagent, new InMemoryWorkflowStore(), { ...f.options,
      readText: (file) => file === ownPath ? own : f.malformed });
    expect(payload179(output)).toMatchObject({ model: "claude-opus-5", actorId: claudeCodeActorId(SESSION, "d0179-agent") });
    const sameCandidate = handleHostAttestationHook(f.input, new InMemoryWorkflowStore(), { ...f.options,
      readText: () => transcriptLine("toolu_hook") + "\n" + f.malformed });
    expect(payload179(sameCandidate)).toMatchObject({ model: "claude-opus-5" });
    expect(updated179(handleHostAttestationHook(subagent, new InMemoryWorkflowStore(), { ...f.options,
      readText: () => f.older + "\n" + f.malformed }))).toEqual(f.toolInput);
    expect(f.cache).not.toHaveBeenCalled();
  });

  it("preserves the injected capability boundary for an opaque model without changing product catalogs", () => {
    const f = fixture179();
    const model = "synthetic-opaque-0179";
    const trusted: HostExecutionAdapter = { host: "claude-code", provider: "synthetic", policyRevision: "fixture-0179",
      modelClassForModel: (value) => value === model ? "deep" : null };
    const old = JSON.stringify({ ...JSON.parse(transcriptLine("toolu_previous", { model })),
      timestamp: new Date(f.options.now().getTime() - 1000).toISOString() });
    const output = handleHostAttestationHook(f.input, new InMemoryWorkflowStore(), { ...f.options, adapter: trusted,
      readText: () => old, readSessionModel: () => null });
    expect(payload179(output)).toMatchObject({ model, eligibility: { modelClass: "deep", provider: "synthetic" } });
    const unqualified = { ...trusted, modelClassForModel: () => null };
    const unqualifiedStore = new InMemoryWorkflowStore();
    const raw = handleHostAttestationHook(f.input, unqualifiedStore, { ...f.options, adapter: unqualified,
      readText: () => old, readSessionModel: () => null });
    expectIneligibleObservation(unqualifiedStore, unqualified, updated179(raw));
    // Hook preservation only: the full opaque-model workflow policy (0086 etc.) remains a separate obligation.
  });

  it.each([undefined, null, 1, "", "not-tool-use"])("does not treat a current-ID block with invalid type %j as absence", (type) => {
    const f = fixture179();
    const block = { ...(type === undefined ? {} : { type }), id: "toolu_hook", name: "plan_workflow", input: {} };
    const transcript = JSON.stringify({ type: "assistant", message: { content: [block] } });
    const store = new InMemoryWorkflowStore(); const key = vi.spyOn(store, "getOrCreateSecret");
    try {
      expect(probeIssuingMessage(transcript, "toolu_hook")).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" });
      expect(updated179(handleHostAttestationHook(f.input, store, { ...f.options, readText: () => transcript }))).toEqual(f.toolInput);
      expect(key).not.toHaveBeenCalled(); expect(f.cache).not.toHaveBeenCalled();
    } finally { key.mockRestore(); }
  });

  it.each([undefined, 1, "assistant-typo"])("does not call an unrecognized issuer-shaped row %j absent", (type) => {
    const f = fixture179();
    const transcript = JSON.stringify({ ...(type === undefined ? {} : { type }),
      message: { content: [{ type: "tool_use", id: "toolu_hook" }] } });
    expect(probeIssuingMessage(transcript, "toolu_hook")).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" });
    expect(updated179(handleHostAttestationHook(f.input, new InMemoryWorkflowStore(), { ...f.options, readText: () => transcript }))).toEqual(f.toolInput);
    expect(f.cache).not.toHaveBeenCalled();
  });

  it("compares decoded current IDs for exact and rejected issuing observations", () => {
    const f = fixture179();
    const noModel = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_hook" }] } })
      .replace("toolu_hook", "toolu_\\u0068ook");
    expect(probeIssuingMessage(noModel, "toolu_hook")).toEqual({ state: "present" });
    const store = new InMemoryWorkflowStore(); const key = vi.spyOn(store, "getOrCreateSecret");
    try {
      expect(updated179(handleHostAttestationHook(f.input, store, { ...f.options, readText: () => f.older + "\n" + noModel }))).toEqual(f.toolInput);
      expect(key).not.toHaveBeenCalled(); expect(f.cache).not.toHaveBeenCalled();
      const valid = transcriptLine("toolu_hook").replace("toolu_hook", "toolu_\\u0068ook");
      expect(payload179(handleHostAttestationHook(f.input, store, { ...f.options, readText: () => valid }))).toMatchObject({ model: "claude-opus-5" });
      expect(f.cache).not.toHaveBeenCalled();
    } finally { key.mockRestore(); }
  });

  it.each([
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_\\u0068ook"}]}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_\\u0068ook',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_\\u0068ook\\q"}]}}',
  ])("does not turn a damaged escaped current-ID row into absence: %s", (transcript) => {
    const f = fixture179();
    expect(probeIssuingMessage(transcript, "toolu_hook")).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INVALID_JSON" });
    const store = new InMemoryWorkflowStore(); const key = vi.spyOn(store, "getOrCreateSecret");
    try {
      expect(updated179(handleHostAttestationHook(f.input, store, { ...f.options, readText: () => transcript }))).toEqual(f.toolInput);
      expect(key).not.toHaveBeenCalled(); expect(f.cache).not.toHaveBeenCalled();
    } finally { key.mockRestore(); }
  });

  it("does not recursively decode unrelated double-escaped text in a damaged row", () => {
    const f = fixture179();
    const transcript = JSON.stringify({ type: "user", message: { text: "toolu_\\u0068ook" } }).slice(0, -1);
    expect(probeIssuingMessage(transcript, "toolu_hook")).toEqual({ state: "absent" });
    expect(payload179(handleHostAttestationHook(f.input, new InMemoryWorkflowStore(), { ...f.options, readText: () => f.older + "\n" + transcript })))
      .toMatchObject({ model: "claude-opus-5" });
  });


  it("does not JSON-parse unrelated ASCII-ID rows or decode their quote escapes", () => {
    const row = JSON.stringify({type: "assistant", message: {content: [{type: "text", text: 'unrelated "quoted" material '.repeat(64)}]}});
    const transcript = transcriptLine("toolu_hook") + "\n" + Array(128).fill(row).join("\n");
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(findToolUseObservation(transcript, "toolu_hook", SESSION, null)).toMatchObject({model: "claude-opus-5"});
      expect(parse).toHaveBeenCalledTimes(1);
    } finally { parse.mockRestore(); }
  });

  it.each([false, true])("preserves valid exact precedence for either same-carrier duplicate order: %s", (damagedFirst) => {
    const f = fixture179();
    const rows = [transcriptLine("toolu_hook"), f.malformed];
    if (damagedFirst) rows.reverse();
    expect(payload179(handleHostAttestationHook(f.input, new InMemoryWorkflowStore(), {...f.options, readText: () => rows.join("\n")})))
      .toMatchObject({model: "claude-opus-5"});
    expect(f.cache).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves same-actor exact precedence in either main/subagent candidate: %s", (exactInMain) => {
    const f = fixture179();
    const own = transcriptLine("toolu_hook", {agentId: "d0179-agent", isSidechain: true});
    const ownPath = transcriptCandidates(TRANSCRIPT, SESSION, "d0179-agent")[1]!;
    const output = handleHostAttestationHook({...f.input, agent_id: "d0179-agent"}, new InMemoryWorkflowStore(), {...f.options,
      readText: file => (file === ownPath) !== exactInMain ? own : f.malformed});
    expect(payload179(output)).toMatchObject({actorId: claudeCodeActorId(SESSION, "d0179-agent")});
    expect(f.cache).not.toHaveBeenCalled();
  });

  it("does not let a main actor's valid row replace a damaged subagent observation", () => {
    const f = fixture179();
    const ownPath = transcriptCandidates(TRANSCRIPT, SESSION, "d0179-agent")[1]!;
    const output = handleHostAttestationHook({...f.input, agent_id: "d0179-agent"}, new InMemoryWorkflowStore(), {...f.options,
      readText: file => file === ownPath ? f.malformed : transcriptLine("toolu_hook")});
    expect(updated179(output)).toEqual(f.toolInput);
    expect(f.cache).not.toHaveBeenCalled();
  });

});
