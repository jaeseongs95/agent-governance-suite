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
import { claudeAdmissionIngress, codexMetaIngress } from "../../mcp-server/src/builtin-caller-ingress.js";
import type { CallerExecution, CallerIngress } from "../../mcp-server/src/caller-identity.js";
import { runGovernanceHook } from "../../mcp-server/src/governance-hook.js";
import {
  hostActorId,
  HostAttestationProvider,
  type HostExecutionAdapter,
  judgeAdapterModelCapability,
  resolveAdapterModelCapability,
} from "../../mcp-server/src/host-attestation.js";
import {
  antigravityExecutionAdapter,
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
  type HostAttestationHookOptions,
  observeClaudeExecution,
  probeIssuingMessage,
  observedEffort,
  readSessionModel,
  type SessionModelRecord,
  sessionModelUpdate,
  transcriptCandidates,
  writeSessionModel,
} from "../../mcp-server/src/host-attestation-hook.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { resolveHostAttestation } from "../../mcp-server/src/runtime-config.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { classificationInputSchema, selectionInputSchema, type SkillClassificationGateway } from "../../mcp-server/src/skill-classification/gateway.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore, type WorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { codexCallMeta, rootCaller } from "../helpers/caller.js";
import { CURRENT_VERSION, STABLE_VERSION } from "./version-fixtures.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const TOOL_PREFIX = "mcp__plugin_agent-governance-suite_agent-governance-suite__";
const SESSION = "session-attest";
const TRANSCRIPT = path.join("transcripts", `${SESSION}.jsonl`);
const bootstrap = (taskId: string) => ({ phase: "bootstrap" as const, taskId, runId: null, stageId: null, revision: null });

/** The observed model has no trusted capability: the provider refuses it instead of inventing a class. */
function expectIneligibleObservation(adapter: HostExecutionAdapter, execution: CallerExecution): void {
  expect(execution).toMatchObject({ model: expect.any(String), effort: expect.any(String) });
  const provider = new HostAttestationProvider(adapter);
  let failure: unknown;
  try {
    provider.run("plan_workflow", rootCaller(adapter.host, SESSION, { execution }), () => provider.observe(bootstrap("ineligible")));
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

interface ObserveOptions {
  model?: string;
  effort?: string;
  hookEffort?: string;
  /** The host observed the caller but not the model of this call. */
  unobserved?: boolean;
  callId?: string;
}

/** Owned execution ingress for hosts without a bundled caller ingress (Gemini, a synthetic fourth host). */
const SYNTHETIC_EXECUTION = "agent-governance.test/execution";
function syntheticExecutionIngress(host: string): CallerIngress {
  return (_tool, meta) => {
    const named = meta?.[SYNTHETIC_EXECUTION] as { callId: string; model?: string; effort: string } | undefined;
    if (!named) return { provenance: "unavailable", reason: "TEST_CALLER_META_MISSING" };
    const { provenance: _provenance, ...caller } = rootCaller(host, SESSION, { callId: named.callId,
      execution: named.model ? { model: named.model, effort: named.effort, turnId: null, provenance: `${host}:test` } : { unavailable: "TEST_EXECUTION_UNOBSERVED" } });
    return { provenance: "host-observed", caller };
  };
}

function ingressFor(adapter: HostExecutionAdapter, store: WorkflowStore): CallerIngress {
  if (adapter.host === "claude-code") return claudeAdmissionIngress(store);
  if (adapter.host === "codex") return codexMetaIngress();
  return syntheticExecutionIngress(adapter.host);
}

/** The Claude governance hook's record of one call: the observed execution under the host tool-use ID. */
function admitClaudeCall(store: WorkflowStore, tool: string, execution: CallerExecution, callId: string, agentId: string | null = null): Record<string, unknown> {
  store.recordCallAdmission({ host: "claude-code", callId, tool, sessionId: SESSION, agentId, execution, transcriptPath: null });
  return { "claudecode/toolUseId": callId };
}

/** The tools/call `_meta` the host would write for one call of `tool`, with the hook's admission for Claude. */
function observedCall(store: WorkflowStore, adapter: HostExecutionAdapter, tool: string, options: ObserveOptions = {}): Record<string, unknown> {
  toolUseSequence += 1;
  const callId = options.callId ?? `toolu_${String(toolUseSequence).padStart(6, "0")}`;
  if (adapter.host === "codex") {
    return codexCallMeta(SESSION, { callId, model: options.unobserved ? null : options.model ?? "gpt-6-astra", effort: options.effort ?? "high" });
  }
  if (adapter.host !== "claude-code") {
    return { [SYNTHETIC_EXECUTION]: { callId, effort: options.effort ?? "high", ...(options.unobserved ? {} : { model: options.model ?? "gemini-2.5-pro" }) } };
  }
  const transcript = options.unobserved ? null : `${transcriptLine("toolu_other")}\n${transcriptLine(callId, options)}\n`;
  const execution = observeClaudeExecution({
    hook_event_name: "PreToolUse", session_id: SESSION, transcript_path: TRANSCRIPT, tool_name: `${TOOL_PREFIX}${tool}`,
    tool_use_id: callId, tool_input: {}, effort: { level: options.hookEffort ?? options.effort ?? "high" },
  }, { readText: () => transcript, sleep: () => {}, maxWaitMs: 0 });
  return admitClaudeCall(store, tool, execution, callId);
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
  /** One host-observed call; the meta defaults to a fresh observed call of the harness host. */
  call<T>(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<ApiResultV1<T>>;
  /** A call exactly as given, with no host metadata unless supplied. */
  raw<T>(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<ApiResultV1<T>>;
}

const openServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()!();
});

async function harness(withProvider: boolean, adapter: HostExecutionAdapter = claudeCodeExecutionAdapter,
  classification: SkillClassificationGateway | null = null, ingress?: CallerIngress): Promise<Harness> {
  const validator = new ContractValidator();
  const store = new InMemoryWorkflowStore();
  const provider = withProvider ? new HostAttestationProvider(adapter) : null;
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, provider);
  const updateStore = new InMemoryPluginUpdateStore();
  updateStore.putPluginUpdateState({
    targetId: "agent-governance-suite",
    currentVersion: CURRENT_VERSION,
    latestVersion: STABLE_VERSION,
    latestTag: `v${STABLE_VERSION}`,
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
    ingress ?? ingressFor(adapter, store),
  );
  const client = new Client({ name: "host-attestation", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openServers.push(async () => {
    await client.close();
    await server.close();
  });
  const raw = async <T>(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
    result<T>(await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }));
  return {
    updates,
    service,
    client,
    store,
    raw,
    call: async <T>(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
      raw<T>(name, args, meta ?? observedCall(store, adapter, name)),
  };
}

function planArguments(taskId: string): Record<string, unknown> {
  return { schemaVersion: "1.0.0", taskEnvelope: task(taskId) };
}

describe("host execution observation through the MCP boundary", () => {
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
    const planned = await call<WorkflowPlanV1>("plan_workflow", { schemaVersion: "1.0.0", taskEnvelope },
      observedCall(store, adapter, "plan_workflow", { model }));
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
    const recorded = await call<WorkflowReceiptV1>("record_stage_result", stageArguments,
      observedCall(store, adapter, "record_stage_result", { model: stageModel, effort: "xhigh" }));
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

  it("keeps the default server without a provider on BINDING_REQUIRED even for an observed call", async () => {
    const { call } = await harness(false);
    const plain = await call<WorkflowPlanV1>("plan_workflow", planArguments("default-plain"));
    expect(plain).toMatchObject({ ok: false, data: null, error: { code: "BINDING_REQUIRED", details: { observation: { status: "provider-not-configured" } } } });
  });

  it("rejects an unobserved caller and caller-supplied identity or execution fields before host attestation", async () => {
    const { raw, store, service } = await harness(true);
    const plan = vi.spyOn(service, "planWorkflow");
    const args = planArguments("caller-negative");
    expect((await raw<WorkflowPlanV1>("plan_workflow", args)).error).toMatchObject({ code: "BINDING_REQUIRED",
      details: { reasonCode: "CALLER_PROVENANCE_UNAVAILABLE", ingressReason: "CLAUDE_TOOL_USE_ID_MISSING" } });
    expect((await raw<WorkflowPlanV1>("plan_workflow", args, { "claudecode/toolUseId": "toolu_never_admitted" })).error).toMatchObject({
      code: "BINDING_REQUIRED", details: { reasonCode: "CALLER_PROVENANCE_UNAVAILABLE", ingressReason: "CALL_ADMISSION_MISSING" } });
    for (const field of ["_sessionBinding", "_hostAttestation"]) {
      const forged = await raw<WorkflowPlanV1>("plan_workflow", { ...args, [field]: field === "_sessionBinding" ? { host: "claude-code", sessionId: SESSION } : "aghs2.caller.forged" },
        observedCall(store, claudeCodeExecutionAdapter, "plan_workflow"));
      expect(forged.error).toMatchObject({ code: "INVALID_INPUT", details: { reasonCode: "RESERVED_CALLER_FIELD", field } });
    }
    expect(plan).not.toHaveBeenCalled();
  });

  it("fails closed when the host identified the caller but not the model of the call", async () => {
    const { store, call } = await harness(true);
    const planned = await call<WorkflowPlanV1>("plan_workflow", planArguments("no-model"),
      observedCall(store, claudeCodeExecutionAdapter, "plan_workflow", { unobserved: true }));
    expect(planned.error).toMatchObject({ code: "BINDING_REQUIRED", details: { observation: { host: "claude-code", reasonCode: "CLAUDE_MODEL_UNOBSERVED" } } });
  });

  it.each([claudeCodeExecutionAdapter, codexExecutionAdapter, geminiExecutionAdapter])("consumes one observation per host call for $host", async (adapter) => {
    const { store, call, raw } = await harness(true, adapter);
    const once = observedCall(store, adapter, "plan_workflow");
    expect((await raw<WorkflowPlanV1>("plan_workflow", planArguments("replay"), once)).ok).toBe(true);
    if (adapter.host === "claude-code") {
      // The admission row was claimed; a second delivery of the same tool-use ID is unobserved.
      expect((await raw<WorkflowPlanV1>("plan_workflow", planArguments("replay"), once)).error).toMatchObject({
        code: "BINDING_REQUIRED", details: { ingressReason: "CALL_ADMISSION_MISSING" } });
    }
    // The same host call observed again (re-admitted, or re-sent with the same _meta) yields the consumed observation.
    const again = adapter.host === "claude-code" ? observedCall(store, adapter, "plan_workflow", { callId: String(once["claudecode/toolUseId"]) }) : once;
    expect((await raw<WorkflowPlanV1>("plan_workflow", planArguments("replay"), again)).error).toMatchObject({
      code: "BINDING_INVALID", message: expect.stringContaining("trusted execution attestation was already consumed") });
    expect((await call<WorkflowPlanV1>("plan_workflow", planArguments("fresh"))).ok).toBe(true);
  });

  it("claims an admission that waited on a permission prompt and keeps the five-minute observation window", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "host-attestation-wait-"));
    const store = new SqliteWorkflowStore(path.join(directory, "workflows.sqlite3"));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-02T00:00:00.000Z"));
      const meta = observedCall(store, claudeCodeExecutionAdapter, "plan_workflow");
      vi.setSystemTime(new Date("2026-11-02T00:10:00.000Z"));
      const { call } = await harness(true, claudeCodeExecutionAdapter, null, claudeAdmissionIngress(store));
      const planned = await call<WorkflowPlanV1>("plan_workflow", planArguments("waited"), meta);
      expect(planned.error).toBeNull();
      const context = planned.data!.bootstrapExecution!.context;
      expect(context.observedAt).toBe("2026-11-02T00:10:00.000Z");
      expect(Date.parse(context.expiresAt!) - Date.parse(context.observedAt)).toBe(5 * 60 * 1000);
    } finally {
      vi.useRealTimers();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not over-report effort when the transcript message ran lower than the hook reports", async () => {
    const { store, call } = await harness(true);
    const planned = await call<WorkflowPlanV1>("plan_workflow", planArguments("mixed-effort"),
      observedCall(store, claudeCodeExecutionAdapter, "plan_workflow", { effort: "low", hookEffort: "high" }));
    expect(planned.ok).toBe(true);
    expect(planned.data?.bootstrapExecution?.context.reasoningEffort).toBe("low");
  });

  it("admits observed lightweight and low-effort bootstrap without granting stage assurance", async () => {
    const { store, call } = await harness(true);
    expect((await call<WorkflowPlanV1>("plan_workflow", planArguments("haiku"),
      observedCall(store, claudeCodeExecutionAdapter, "plan_workflow", { model: "claude-haiku-4-5-20251001" }))).ok).toBe(true);
    const planned = await call<WorkflowPlanV1>("plan_workflow", planArguments("low-effort"),
      observedCall(store, claudeCodeExecutionAdapter, "plan_workflow", { effort: "low" }));
    expect(planned.ok).toBe(true);
    expect(planned.data?.bootstrapExecution?.context.reasoningEffort).toBe("low");
  });

  it.each([claudeCodeExecutionAdapter, codexExecutionAdapter])("refuses caller execution claims for $host instead of stripping them", async (adapter) => {
    const { call, service } = await harness(true, adapter);
    const plan = vi.spyOn(service, "planWorkflow");
    const clean = planArguments(`caller-skill-claims-${adapter.host}`);
    expect((await call<WorkflowPlanV1>("plan_workflow", { ...clean, _hostAttestation: "aghs1.caller.forged" })).error)
      .toMatchObject({ code: "INVALID_INPUT", details: { reasonCode: "RESERVED_CALLER_FIELD", field: "_hostAttestation" } });
    // A host-skill observation is not a plan field; the plan contract rejects it instead of a hook stripping it.
    expect((await call<WorkflowPlanV1>("plan_workflow", { ...clean, _hostSkillObservation: { actorId: "caller", sourceRef: "caller", skills: [] } })).error?.code)
      .toBe("INVALID_INPUT");
    expect(plan).toHaveBeenCalledTimes(1);
    expect((await call<WorkflowPlanV1>("plan_workflow", clean)).error).toBeNull();
  });

  it("separates an observed low Codex call from an unobserved one and its replay (D0094)", async () => {
    const adapter = codexExecutionAdapter;
    const { store, raw } = await harness(true, adapter);
    const input = planArguments("signed-low-boundary");
    expect((await raw<WorkflowPlanV1>("plan_workflow", input, observedCall(store, adapter, "plan_workflow", { unobserved: true }))).error)
      .toMatchObject({ code: "BINDING_REQUIRED", details: { observation: { reasonCode: "CODEX_EXECUTION_META_MISSING" } } });
    expect((await raw<WorkflowPlanV1>("plan_workflow", input)).error)
      .toMatchObject({ code: "BINDING_REQUIRED", details: { ingressReason: "CODEX_CALL_META_MISSING" } });
    const low = observedCall(store, adapter, "plan_workflow", { model: "gpt-6.1-sol", effort: "low" });
    const admitted = await raw<WorkflowPlanV1>("plan_workflow", input, low);
    expect(admitted.ok).toBe(true);
    expect(admitted.data?.bootstrapExecution?.context).toMatchObject({ model: "gpt-6.1-sol", modelClass: "general", reasoningEffort: "low" });
    expect((await raw<WorkflowPlanV1>("plan_workflow", input, low)).error?.code).toBe("BINDING_INVALID");
  });

  it("admits a current Codex low observation through the MCP bootstrap boundary", async () => {
    const adapter = codexExecutionAdapter;
    const { store, call } = await harness(true, adapter);
    const high = { schemaVersion: "1.0.0", taskEnvelope: { ...task("sol-bootstrap-floor"), riskLevel: "high" } };
    const planned = await call<WorkflowPlanV1>("plan_workflow", high, observedCall(store, adapter, "plan_workflow", { model: "gpt-6.1-sol", effort: "low" }));
    expect(planned.ok).toBe(true);
    expect(planned.data?.bootstrapExecution?.context).toMatchObject({ modelClass: "general", reasoningEffort: "low" });
    expect((await call<WorkflowPlanV1>("plan_workflow", planArguments("luna-general-floor"),
      observedCall(store, adapter, "plan_workflow", { model: "gpt-6-luna", effort: "low" }))).ok).toBe(true);
  });

  // Moved from codex-host-observation.test.ts: the raw model is kept while the real provider denies eligibility.
  it.each(["unknown-model", "constructor"])("keeps the raw Codex model %s and denies execution eligibility", async (model) => {
    const { store, call } = await harness(true, codexExecutionAdapter);
    expect(await call<WorkflowPlanV1>("plan_workflow", planArguments(`codex-${model}`), observedCall(store, codexExecutionAdapter, "plan_workflow", { model })))
      .toMatchObject({ ok: false, data: null, error: { code: "BINDING_INVALID",
        message: "Host observation has no matching trusted execution capability and policy revision." } });
  });
});

describe("Claude execution observation recorded by the governance hook", () => {
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
  const observe = (input: Record<string, unknown>, options: HostAttestationHookOptions) => observeClaudeExecution(input, options);

  it("observes execution only for the execution-floor tools and records nothing for other events", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "host-attestation-hook-"));
    const database = path.join(directory, "workflows.sqlite3");
    const environment = { ...process.env, AGENT_GOVERNANCE_DB_PATH: database };
    try {
      for (const [index, input] of [
        { ...base, tool_name: "Bash", tool_use_id: "toolu_bash" },
        { ...base, hook_event_name: "PostToolUse", tool_use_id: "toolu_post" },
        { ...base, tool_name: `${TOOL_PREFIX}get_trust_capabilities`, tool_use_id: "toolu_other_tool" },
      ].entries()) {
        expect(await runGovernanceHook("claude-code", JSON.stringify(input), environment), String(index)).toEqual({ ok: true, output: "" });
      }
      const store = new SqliteWorkflowStore(database);
      try {
        expect(store.claimCallAdmission("claude-code", "toolu_bash")).toBeNull();
        expect(store.claimCallAdmission("claude-code", "toolu_post")).toBeNull();
        expect(store.claimCallAdmission("claude-code", "toolu_other_tool")).toMatchObject({
          tool: "get_trust_capabilities", sessionId: SESSION, agentId: null, execution: { unavailable: "EXECUTION_NOT_REQUIRED" } });
      } finally { store.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps an unknown model raw and reports every unobserved case by its reason", async () => {
    const unknown = observe(base, { ...noWait, readText: () => transcriptLine("toolu_hook", { model: "unknown-model-id" }) });
    expect(unknown).toMatchObject({ model: "unknown-model-id", effort: "high", provenance: "claude-code:transcript-tool-use" });
    expectIneligibleObservation(claudeCodeExecutionAdapter, unknown);
    expect(observe(base, { ...noWait, maxWaitMs: 0, readText: () => null })).toEqual({ unavailable: "CLAUDE_MODEL_UNOBSERVED" });
    expect(observe({ ...base, transcript_path: undefined }, noWait)).toEqual({ unavailable: "CLAUDE_CALL_FIELDS_MISSING" });
    expect(observe({ ...base, tool_use_id: undefined }, noWait)).toEqual({ unavailable: "CLAUDE_CALL_FIELDS_MISSING" });

    // An unobserved call reaches the server with its caller but no execution, and fails closed.
    const { store, call } = await harness(true);
    const meta = admitClaudeCall(store, "plan_workflow", observe(base, { ...noWait, maxWaitMs: 0, readText: () => null }), "toolu_unobserved");
    expect((await call<WorkflowPlanV1>("plan_workflow", planArguments("unobserved"), meta)).error?.code).toBe("BINDING_REQUIRED");
  });

  it("waits for a lagging transcript and gives up without an observation", () => {
    let reads = 0;
    const lagging = observe(base, {
      ...noWait,
      readText: () => (++reads < 4 ? transcriptLine("toolu_older") : transcriptLine("toolu_hook")),
    });
    expect(reads).toBe(4);
    expect(lagging).toMatchObject({ model: "claude-opus-5", effort: "high" });

    let slept = 0;
    const missing = observe(base, {
      readText: () => null,
      sleep: (milliseconds) => { slept += milliseconds; },
      maxWaitMs: 500,
      pollIntervalMs: 100,
    });
    expect(missing).toEqual({ unavailable: "CLAUDE_MODEL_UNOBSERVED" });
    expect(slept).toBe(500);

    let clockMs = 1_000;
    let slowReads = 0;
    let slowSleeps = 0;
    const deadlineExceeded = observe(base, {
      now: () => new Date(clockMs),
      readText: () => {
        slowReads += 1;
        clockMs += 300;
        return null;
      },
      sleep: () => { slowSleeps += 1; },
      maxWaitMs: 300,
      pollIntervalMs: 100,
    });
    expect(deadlineExceeded).toEqual({ unavailable: "CLAUDE_MODEL_UNOBSERVED" });
    expect(slowReads).toBe(2);
    expect(slowSleeps).toBe(0);
  });

  it("rejects missing effort, foreign sessions and sidechain issuing messages", () => {
    const read = (line: string) => ({ ...noWait, maxWaitMs: 0, readText: () => line });
    expect(observe(base, read(transcriptLine("toolu_hook", { sessionId: "other" })))).toEqual({ unavailable: "CLAUDE_ISSUING_MESSAGE_REJECTED" });
    expect(observe(base, read(transcriptLine("toolu_hook", { isSidechain: true })))).toEqual({ unavailable: "CLAUDE_ISSUING_MESSAGE_REJECTED" });
    const noEffortLine = JSON.stringify({ ...JSON.parse(transcriptLine("toolu_hook")), effort: undefined });
    expect(observe({ ...base, effort: undefined }, read(noEffortLine))).toEqual({ unavailable: "CLAUDE_EFFORT_UNOBSERVED" });
  });

  it("reads a subagent's own transcript, and the admission records the subagent as the actor", () => {
    const subagentPath = transcriptCandidates(TRANSCRIPT, SESSION, "agent123")[1]!;
    expect(subagentPath).toBe(path.join("transcripts", SESSION, "subagents", "agent-agent123.jsonl"));
    const files: Record<string, string> = {
      [TRANSCRIPT]: transcriptLine("toolu_parent"),
      [subagentPath]: transcriptLine("toolu_hook", { isSidechain: true, agentId: "agent123", model: "claude-sonnet-5" }),
    };
    const execution = observe({ ...base, agent_id: "agent123" }, { ...noWait, readText: (file) => files[file] ?? null });
    expect(execution).toMatchObject({ model: "claude-sonnet-5", effort: "high" });
    const store = new InMemoryWorkflowStore();
    admitClaudeCall(store, "plan_workflow", execution, "toolu_hook", "agent123");
    const admitted = claudeAdmissionIngress(store)("plan_workflow", { "claudecode/toolUseId": "toolu_hook" });
    expect(admitted).toMatchObject({ provenance: "host-observed", caller: {
      actor: { id: claudeCodeActorId(SESSION, "agent123"), role: "child" }, parentChain: [hostActorId("claude-code", SESSION)], parentChainComplete: false } });
    expect(claudeCodeActorId(SESSION, "agent123")).toMatch(/^claude-code:session-[0-9a-f]{24}:agent-[0-9a-f]{24}$/u);
    expect(claudeCodeActorId(SESSION, "agent123")).not.toBe(claudeCodeActorId(SESSION, "agent456"));
  });

  describe("interactive sessions, where the issuing message is written only after the call", () => {
    const written = (options: Parameters<typeof transcriptLine>[1] = {}) =>
      JSON.stringify({ ...JSON.parse(transcriptLine("toolu_previous", options)), timestamp: "2026-09-19T00:10:12.000Z" });
    const record = (model: string, observedAt: string, source: SessionModelRecord["source"] = "model-switch"): SessionModelRecord => ({ model, source, observedAt });
    const now = () => new Date("2026-09-19T00:11:00.000Z");
    const run = (transcript: string | null, session: SessionModelRecord | null, input: Record<string, unknown> = base) =>
      observe(input, { ...noWait, maxWaitMs: 0, now, readText: () => transcript, readSessionModel: () => session });

    it("observes the SessionStart model before the session has written any message", () => {
      expect(run(null, record("claude-opus-5", "2026-09-19T00:10:01.000Z", "session-start")))
        .toEqual({ model: "claude-opus-5", effort: "high", turnId: null, provenance: "claude-code:session-start" });
    });

    it("uses the session model record, never the latest unrelated message (D-0033)", () => {
      expect(run(written({ model: "claude-opus-5" }), record("claude-sonnet-5", "2026-09-19T00:10:01.000Z")))
        .toMatchObject({ model: "claude-sonnet-5", provenance: "claude-code:model-switch" });
      expect(run(written({ model: "claude-opus-5" }), null)).toEqual({ unavailable: "CLAUDE_MODEL_UNOBSERVED" });
    });

    it("takes effort only from the hook, never from an earlier message that may belong to another model", () => {
      const session = record("claude-opus-5", "2026-09-19T00:10:01.000Z", "session-start");
      expect(run(written({ model: "claude-opus-5", effort: "low" }), session)).toMatchObject({ model: "claude-opus-5", effort: "high" });
      // A model without effort support (Haiku) sends no hook effort; an earlier Opus message must not stand in for it.
      expect(run(written({ model: "claude-opus-5", effort: "xhigh" }), session, { ...base, effort: undefined })).toEqual({ unavailable: "CLAUDE_EFFORT_UNOBSERVED" });
    });

    it("does not fall back when the issuing message was found but rejected", () => {
      const session = record("claude-opus-5", "2026-09-19T00:10:01.000Z", "session-start");
      const issued = (options: Parameters<typeof transcriptLine>[1]) => transcriptLine("toolu_hook", options);
      expect(run(issued({ sessionId: "other" }), session)).toEqual({ unavailable: "CLAUDE_ISSUING_MESSAGE_REJECTED" });
      expect(run(issued({ isSidechain: true }), session)).toEqual({ unavailable: "CLAUDE_ISSUING_MESSAGE_REJECTED" });
      const noModel = JSON.stringify({ ...JSON.parse(issued({})), message: { content: [{ type: "tool_use", id: "toolu_hook", name: "tool", input: {} }] } });
      expect(run(noModel, session)).toEqual({ unavailable: "CLAUDE_ISSUING_MESSAGE_REJECTED" });
    });

    it("requires model and effort observations and retains an ineligible switched model", () => {
      expect(run(null, null)).toEqual({ unavailable: "CLAUDE_MODEL_UNOBSERVED" });
      expect(run(null, record("claude-opus-5", "2026-09-19T00:10:01.000Z", "session-start"), { ...base, effort: undefined }))
        .toEqual({ unavailable: "CLAUDE_EFFORT_UNOBSERVED" });
      expectIneligibleObservation(claudeCodeExecutionAdapter, run(written(), record("claude-next", "2026-09-19T00:10:18.000Z")));
    });

    it("uses only the subagent's own written messages, never the session model", () => {
      const session = record("claude-fable-5-1", "2026-09-19T00:10:18.000Z");
      const subagent = { ...base, agent_id: "agent123" };
      expect(run(null, session, subagent)).toEqual({ unavailable: "CLAUDE_MODEL_UNOBSERVED" });
      const own = transcriptLine("toolu_hook", { isSidechain: true, agentId: "agent123", model: "claude-sonnet-5" });
      expect(run(own, session, subagent)).toMatchObject({ model: "claude-sonnet-5", provenance: "claude-code:transcript-tool-use" });
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

  it("binds one actual fourth-host adapter through the same resolver and caller boundary", async () => {
    const suite = createCatalogExecutionAdapters(fourthHostCatalog());
    const adapter = resolveHostAttestation({AGENT_GOVERNANCE_HOST_ATTESTATION: "synthetic-fourth-host"}, suite.adapters);
    expect(adapter).toBe(suite.adapters.get("synthetic-fourth-host"));
    expect(adapter!.resolveModel!("opaque-fourth-model")).toMatchObject({host: "synthetic-fourth-host", provider: "synthetic-fourth-provider", modelClass: "deep", supportedEfforts: ["high"]});
    const {store, call} = await harness(true, adapter!);
    const args = planArguments("fourth-host-task");
    const planned = await call<WorkflowPlanV1>("plan_workflow", args, observedCall(store, adapter!, "plan_workflow", {model: "opaque-fourth-model"}));
    expect(planned.ok).toBe(true);
    expect(planned.data!.bootstrapExecution!.context).toMatchObject({model: "opaque-fourth-model", modelClass: "deep", reasoningEffort: "high", actorId: hostActorId(adapter!.host, SESSION)});
    // A caller observed by another host's ingress never qualifies against this host's adapter.
    const provider = new HostAttestationProvider(adapter!);
    let foreign: unknown;
    try {
      provider.run("plan_workflow", rootCaller("codex", SESSION, {execution: {model: "opaque-fourth-model", effort: "high", turnId: null, provenance: "codex:mcp-meta"}}),
        () => provider.observe(bootstrap("fourth-host-task")));
    } catch (error) { foreign = error; }
    expect(foreign).toMatchObject({code: "BINDING_INVALID", details: {reasonCode: "HOST_ADAPTER_MISMATCH"}});
    for (const [options, failure] of [
      [{model: "unobserved-model"}, {message: "Host observation has no matching trusted execution capability and policy revision.", details: {reasonCode: "MODEL_NOT_IN_CATALOG"}}],
      [{model: "opaque-fourth-model", effort: "low"}, {details: {reasonCode: "CURRENT_POLICY_EFFORT_UNSUPPORTED"}}],
    ] as const) {
      expect(await call<WorkflowPlanV1>("plan_workflow", args, observedCall(store, adapter!, "plan_workflow", options)))
        .toMatchObject({ok: false, error: {code: "BINDING_INVALID", ...failure}});
    }
    const noProvider = await harness(false, adapter!);
    expect(await noProvider.call<WorkflowPlanV1>("plan_workflow", args))
      .toMatchObject({ok: false, error: {code: "BINDING_REQUIRED"}});
    // Synthetic fixture authority only; this does not qualify or enable a live fourth host.
  });

  it.each(["plan_workflow", "record_stage_result", "classify_skills", "record_skill_selection"])(
    "rejects a caller-supplied hook field before dispatching providerless %s", async (tool) => {
      const classification: SkillClassificationGateway = {
        inventory: vi.fn(async () => ({})),
        classify: vi.fn(async (input: unknown) => classificationInputSchema.parse(input)),
        accept: vi.fn(async (input: unknown) => selectionInputSchema.parse(input)),
      };
      const server = await harness(false, claudeCodeExecutionAdapter, classification);
      const updateCheck = vi.spyOn(server.updates, "check");
      const plan = vi.spyOn(server.service, "planWorkflow");
      const stage = vi.spyOn(server.service, "recordStageResult");
      const digest = `sha256:${"a".repeat(64)}`;
      const classificationInput = {
        schemaVersion: "1.0.0",
        requestId: "providerless-classify",
        operationId: "providerless-operation",
        originalPrompt: "Check the current repository conventions.",
        confirmedContext: {
          taskRevision: null, objective: "Check conventions.", actions: ["inspect"],
          targets: ["README.md"], constraints: null, prohibitedActions: null, background: null,
        },
        contextSources: [{ field: "objective", reference: "user-prompt" }],
        explicitSkillIds: [],
        ruleRequiredSkillIds: [],
        vendorContext: { vendorId: "anthropic", reference: "claude-code" },
        publicSynthetic: false,
      };
      const selectionInput = {
        schemaVersion: "1.0.0",
        operationId: "providerless-operation",
        decision: {
          schemaVersion: "1.0.0",
          classificationResponseRef: digest,
          requestDigest: digest,
          inventoryDigest: digest,
          taskRevision: null,
          configRevision: "1.0.0",
          profileRevision: "1.0.0",
          explicitSkillIds: [],
          ruleRequiredSkillIds: [],
          agentSelectedSkillIds: ["workspace-convention-profiler"],
          selectionReasons: [{ skillId: "workspace-convention-profiler", reason: "Matches repository convention check." }],
          applicabilityChecks: [{ skillId: "workspace-convention-profiler", applies: true, excluded: false, reasonRefs: ["user-prompt"] }],
          unresolvedSkillReferences: [],
          selectionStatus: "SELECTED",
          adviceApplied: true,
          hostReceipt: null,
        },
      };
      const input = tool === "plan_workflow"
        ? planArguments("providerless-guard")
        : tool === "classify_skills"
        ? classificationInput
        : tool === "record_skill_selection"
        ? selectionInput
        : {};
      for (const token of ["synthetic-unverified-hook-token", null]) {
        const rejected = await server.call(tool, { ...input, _hostAttestation: token });
        expect(rejected).toMatchObject({ ok: false, data: null, error: { code: "INVALID_INPUT", details: { reasonCode: "RESERVED_CALLER_FIELD", field: "_hostAttestation" } } });
        expect(JSON.stringify(rejected)).not.toContain("synthetic-unverified-hook-token");
      }
      // A rejected configuration must not trigger unrelated update or provider I/O.
      expect(updateCheck).not.toHaveBeenCalled();
      expect(plan).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
      expect(classification.classify).not.toHaveBeenCalled();
      expect(classification.accept).not.toHaveBeenCalled();
      // Without the field, valid classification inputs succeed while workflow tools retain their service-level validation path.
      const plain = await server.call(tool, input);
      if (tool === "plan_workflow") {
        expect(plain).toMatchObject({ ok: false, error: { code: "BINDING_REQUIRED" } });
        expect(plan).toHaveBeenCalledTimes(1);
      } else if (tool === "record_stage_result") {
        expect(plain).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
        expect(stage).toHaveBeenCalledTimes(1);
      } else if (tool === "classify_skills") {
        expect(plain).toMatchObject({ ok: true, data: classificationInput, error: null });
        expect(classification.classify).toHaveBeenCalledExactlyOnceWith(classificationInput, null);
        expect(await server.call(tool, {})).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
        expect(classification.classify).toHaveBeenCalledTimes(1);
      } else if (tool === "record_skill_selection") {
        expect(plain).toMatchObject({ ok: true, data: selectionInput, error: null });
        expect(classification.accept).toHaveBeenCalledExactlyOnceWith(selectionInput, null);
        expect(await server.call(tool, {})).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
        expect(classification.accept).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("preserves normal argument rejection for a tool outside the attested set", async () => {
    const classification: SkillClassificationGateway = {
      inventory: vi.fn(async () => ({ status: "synthetic inventory" })),
      classify: vi.fn(async () => null),
      accept: vi.fn(async () => null),
    };
    const server = await harness(false, claudeCodeExecutionAdapter, classification);
    const rejected = await server.call("get_skill_inventory", { _hostAttestation: "synthetic-unverified-hook-token" });
    expect(rejected).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", details: { reasonCode: "RESERVED_CALLER_FIELD" } } });
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
    const duplicateAdapter = createCatalogExecutionAdapters(duplicate).adapters.get("synthetic-fourth-host")!;
    expect(duplicateAdapter.resolveModel!("opaque-fourth-model")).toBeNull();
    expect(duplicateAdapter.judgeModel!("opaque-fourth-model")).toMatchObject({
      status: "undetermined",
      reason: "AMBIGUOUS_PROVIDER_MATCH",
      provider: null,
      modelClass: null,
    });
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
  // Moved from codex-host-observation.test.ts: the adapter policy is exact and never infers suffixes or successors.
  it("uses exact Codex model IDs and conservative governance policy without inferring suffixes or successors", () => {
    expect(codexExecutionAdapter.modelClassForModel("gpt-6-astra")).toBe("frontier");
    expect(codexExecutionAdapter.modelClassForModel("gpt-6-sol")).toBe("general");
    expect(codexExecutionAdapter.modelClassForModel("gpt-6-luna")).toBe("lightweight");
    expect(codexExecutionAdapter.modelClassForModel("gpt-5.6-sol")).toBe("deep");
    expect(codexExecutionAdapter.modelClassForModel("gpt-6-sol-latest")).toBeNull();
    expect(codexExecutionAdapter.modelClassForModel("gpt-7-astra")).toBeNull();
    expect(codexExecutionAdapter.modelClassForModel("constructor")).toBeNull();
  });
});


describe("AGS-D-0179 correlated issuing observations", () => {
  function fixture179() {
    const now = new Date();
    const older = JSON.stringify({ ...JSON.parse(transcriptLine("toolu_previous", { model: "claude-opus-5" })),
      timestamp: new Date(now.getTime() - 1000).toISOString() });
    const malformed = transcriptLine("toolu_hook", { model: "claude-haiku-4-5-20251001" }).slice(0, -1);
    const cache = vi.fn((): SessionModelRecord => ({ model: "claude-opus-5", source: "session-start",
      observedAt: new Date(now.getTime() - 500).toISOString() }));
    return { older, malformed, cache, input: { hook_event_name: "PreToolUse", session_id: SESSION,
      transcript_path: TRANSCRIPT, tool_name: TOOL_PREFIX + "plan_workflow", tool_use_id: "toolu_hook",
      effort: { level: "high" }, tool_input: planArguments("d0179") },
      options: { maxWaitMs: 0, sleep: () => {}, now: () => now, readSessionModel: cache } };
  }
  const observe179 = (input: Record<string, unknown>, options: HostAttestationHookOptions) => observeClaudeExecution(input, options);

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

  it("does not observe an older strong model after a current malformed line, and the MCP stays BINDING_REQUIRED", async () => {
    const { store, call } = await harness(true);
    const f = fixture179();
    const execution = observe179(f.input, { ...f.options, readText: () => f.older + "\n" + f.malformed });
    expect(execution).toEqual({ unavailable: "CURRENT_CALL_INVALID_JSON" });
    expect(f.cache).not.toHaveBeenCalled();
    const reply = await call<WorkflowPlanV1>("plan_workflow", planArguments("d0179"), admitClaudeCall(store, "plan_workflow", execution, "toolu_hook"));
    expect(reply).toMatchObject({ ok: false, error: { code: "BINDING_REQUIRED", details: { observation: { reasonCode: "CURRENT_CALL_INVALID_JSON" } } } });
  });

  it("does not use a strong main-session cache after a malformed current issuer", () => {
    const f = fixture179();
    expect(observe179(f.input, { ...f.options, readText: () => f.malformed })).toEqual({ unavailable: "CURRENT_CALL_INVALID_JSON" });
    expect(f.cache).not.toHaveBeenCalled();
  });

  it("keeps exact current evidence and its normal strict consumer path", async () => {
    const { store, call } = await harness(true);
    const f = fixture179();
    const execution = observe179(f.input, { ...f.options, readText: () => transcriptLine("toolu_hook") });
    expect(execution).toMatchObject({ model: "claude-opus-5", provenance: "claude-code:transcript-tool-use" });
    expect((await call<WorkflowPlanV1>("plan_workflow", planArguments("d0179"), admitClaudeCall(store, "plan_workflow", execution, "toolu_hook"))).error).toBeNull();
    expect(f.cache).not.toHaveBeenCalled();
  });

  it("keeps genuine absence and ignores unrelated damaged rows", () => {
    const f = fixture179();
    const input = f.older + '\n{"type":"assistant","unrelated":';
    expect(observe179(f.input, { ...f.options, readText: () => input })).toMatchObject({ model: "claude-opus-5", effort: "high", provenance: "claude-code:session-start" });
    expect(f.cache).toHaveBeenCalledTimes(1);
    expect(observe179(f.input, { ...f.options, readText: () => null }))
      .toMatchObject({ model: "claude-opus-5", provenance: "claude-code:session-start" });
  });

  it("does not use fallback for correlated assistant metadata with an invalid content shape", () => {
    const f = fixture179();
    const malformedShape = JSON.stringify({ type: "assistant", message: { content: "toolu_hook" } });
    expect(probeIssuingMessage(malformedShape, "toolu_hook")).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" });
    expect(observe179(f.input, { ...f.options, readText: () => malformedShape })).toEqual({ unavailable: "CURRENT_CALL_INVALID_SHAPE" });
    expect(f.cache).not.toHaveBeenCalled();
  });

  it("preserves bounded partial-to-valid polling while refusing persistent malformed evidence", () => {
    const f = fixture179();
    let reads = 0;
    const sleep = vi.fn();
    const output = observe179(f.input, { ...f.options, maxWaitMs: 20,
      pollIntervalMs: 10, sleep, readText: () => ++reads === 1 ? f.malformed : transcriptLine("toolu_hook") });
    expect(output).toMatchObject({ model: "claude-opus-5" });
    expect(reads).toBe(2); expect(sleep.mock.calls).toEqual([[10]]);
    reads = 0; sleep.mockClear();
    const refused = observe179(f.input, { ...f.options, maxWaitMs: 20,
      pollIntervalMs: 10, sleep, readText: () => { reads++; return f.malformed; } });
    expect(refused).toEqual({ unavailable: "CURRENT_CALL_INVALID_JSON" });
    expect(reads).toBe(4); expect(sleep.mock.calls).toEqual([[10], [10]]);
    expect(f.cache).not.toHaveBeenCalled();
  });

  it("retains existing valid-exact precedence over damaged duplicates and a subagent never uses the main cache", () => {
    const f = fixture179();
    const subagent = { ...f.input, agent_id: "d0179-agent" };
    const own = transcriptLine("toolu_hook", { agentId: "d0179-agent", isSidechain: true });
    const ownPath = transcriptCandidates(TRANSCRIPT, SESSION, "d0179-agent")[1]!;
    expect(observe179(subagent, { ...f.options, readText: (file) => file === ownPath ? own : f.malformed })).toMatchObject({ model: "claude-opus-5" });
    expect(observe179(f.input, { ...f.options, readText: () => transcriptLine("toolu_hook") + "\n" + f.malformed })).toMatchObject({ model: "claude-opus-5" });
    expect(observe179(subagent, { ...f.options, readText: () => f.older + "\n" + f.malformed })).toEqual({ unavailable: "CURRENT_CALL_INVALID_JSON" });
    expect(f.cache).not.toHaveBeenCalled();
  });

  it("preserves the injected capability boundary for an opaque model without changing product catalogs", () => {
    const f = fixture179();
    const model = "synthetic-opaque-0179";
    const trusted: HostExecutionAdapter = { host: "claude-code", provider: "synthetic", policyRevision: "fixture-0179",
      modelClassForModel: (value) => value === model ? "deep" : null,
      resolveModel: (value, provenance = "synthetic:fixture-0179") => value === model ? {
        host: "claude-code", provider: "synthetic", rawModel: value, resolvedModel: value, modelClass: "deep",
        minimumReasoningEffort: null, supportedEfforts: ["high"], aliasUsed: false, policyRevision: "fixture-0179", provenance,
      } : null };
    const execution = observe179(f.input, { ...f.options, readText: () => transcriptLine("toolu_hook", { model }), readSessionModel: () => null });
    expect(execution).toMatchObject({ model, effort: "high" });
    const provider = new HostAttestationProvider(trusted);
    expect(provider.run("plan_workflow", rootCaller("claude-code", SESSION, { execution }), () => provider.observe(bootstrap("d0179"))))
      .toMatchObject({ model, modelClass: "deep" });
    expect(provider.lastObservedCapability()).toMatchObject({ provider: "synthetic", modelClass: "deep" });
    expectIneligibleObservation({ ...trusted, modelClassForModel: () => null, resolveModel: () => null }, execution);
    // Hook preservation only: the full opaque-model workflow policy (0086 etc.) remains a separate obligation.
  });

  it.each([undefined, null, 1, "", "not-tool-use"])("does not treat a current-ID block with invalid type %j as absence", (type) => {
    const f = fixture179();
    const block = { ...(type === undefined ? {} : { type }), id: "toolu_hook", name: "plan_workflow", input: {} };
    const transcript = JSON.stringify({ type: "assistant", message: { content: [block] } });
    expect(probeIssuingMessage(transcript, "toolu_hook")).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" });
    expect(observe179(f.input, { ...f.options, readText: () => transcript })).toEqual({ unavailable: "CURRENT_CALL_INVALID_SHAPE" });
    expect(f.cache).not.toHaveBeenCalled();
  });

  it.each([undefined, 1, "assistant-typo"])("does not call an unrecognized issuer-shaped row %j absent", (type) => {
    const f = fixture179();
    const transcript = JSON.stringify({ ...(type === undefined ? {} : { type }),
      message: { content: [{ type: "tool_use", id: "toolu_hook" }] } });
    expect(probeIssuingMessage(transcript, "toolu_hook")).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" });
    expect(observe179(f.input, { ...f.options, readText: () => transcript })).toEqual({ unavailable: "CURRENT_CALL_INVALID_SHAPE" });
    expect(f.cache).not.toHaveBeenCalled();
  });

  it("compares decoded current IDs for exact and rejected issuing observations", () => {
    const f = fixture179();
    const noModel = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_hook" }] } })
      .replace("toolu_hook", "toolu_\\u0068ook");
    expect(probeIssuingMessage(noModel, "toolu_hook")).toEqual({ state: "present" });
    expect(observe179(f.input, { ...f.options, readText: () => f.older + "\n" + noModel })).toEqual({ unavailable: "CLAUDE_ISSUING_MESSAGE_REJECTED" });
    expect(f.cache).not.toHaveBeenCalled();
    const valid = transcriptLine("toolu_hook").replace("toolu_hook", "toolu_\\u0068ook");
    expect(observe179(f.input, { ...f.options, readText: () => valid })).toMatchObject({ model: "claude-opus-5" });
    expect(f.cache).not.toHaveBeenCalled();
  });

  it.each([
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_\\u0068ook"}]}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_\\u0068ook',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_\\u0068ook\\q"}]}}',
  ])("does not turn a damaged escaped current-ID row into absence: %s", (transcript) => {
    const f = fixture179();
    expect(probeIssuingMessage(transcript, "toolu_hook")).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INVALID_JSON" });
    expect(observe179(f.input, { ...f.options, readText: () => transcript })).toEqual({ unavailable: "CURRENT_CALL_INVALID_JSON" });
    expect(f.cache).not.toHaveBeenCalled();
  });

  it("does not recursively decode unrelated double-escaped text in a damaged row", () => {
    const f = fixture179();
    const transcript = JSON.stringify({ type: "user", message: { text: "toolu_\\u0068ook" } }).slice(0, -1);
    expect(probeIssuingMessage(transcript, "toolu_hook")).toEqual({ state: "absent" });
    expect(observe179(f.input, { ...f.options, readText: () => f.older + "\n" + transcript }))
      .toMatchObject({ model: "claude-opus-5", provenance: "claude-code:session-start" });
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
    expect(observe179(f.input, {...f.options, readText: () => rows.join("\n")})).toMatchObject({model: "claude-opus-5"});
    expect(f.cache).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves same-actor exact precedence in either main/subagent candidate: %s", (exactInMain) => {
    const f = fixture179();
    const own = transcriptLine("toolu_hook", {agentId: "d0179-agent", isSidechain: true});
    const ownPath = transcriptCandidates(TRANSCRIPT, SESSION, "d0179-agent")[1]!;
    expect(observe179({...f.input, agent_id: "d0179-agent"}, {...f.options,
      readText: file => (file === ownPath) !== exactInMain ? own : f.malformed})).toMatchObject({model: "claude-opus-5", effort: "high"});
    expect(f.cache).not.toHaveBeenCalled();
  });

  it("does not let a main actor's valid row replace a damaged subagent observation", () => {
    const f = fixture179();
    const ownPath = transcriptCandidates(TRANSCRIPT, SESSION, "d0179-agent")[1]!;
    expect(observe179({...f.input, agent_id: "d0179-agent"}, {...f.options,
      readText: file => file === ownPath ? f.malformed : transcriptLine("toolu_hook")})).toMatchObject({unavailable: expect.any(String)});
    expect(f.cache).not.toHaveBeenCalled();
  });

});

describe("AGS-D-0328 host and model-vendor separation", () => {
  it("resolves 1 host x 3 vendors from a synthetic catalog by observed model ID without host-to-vendor fallback", () => {
    const oneHostThreeVendors: ModelRoutingPresetsV1 = {
      schema_version: 1,
      policy_revision: "synthetic-d0328-1h3v",
      model_class_order: ["lightweight", "general", "deep", "frontier"],
      effort_order: ["low", "medium", "high", "xhigh", "max", "ultra"],
      providers: {
        "vendor-alpha": {
          host: "synthetic-polyglot-host",
          catalog: {
            matching: "exact-only",
            models: {
              "alpha-frontier-1": {
                model_class: "frontier",
                minimum_effort: "high",
                supported_efforts: ["high", "xhigh"],
              },
            },
          },
        },
        "vendor-beta": {
          host: "synthetic-polyglot-host",
          catalog: {
            matching: "exact-only",
            models: {
              "beta-deep-2": {
                model_class: "deep",
                supported_efforts: ["medium", "high"],
              },
            },
          },
        },
        "vendor-gamma": {
          host: "synthetic-polyglot-host",
          catalog: {
            matching: "exact-only",
            models: {
              "gamma-light-3": {
                model_class: "lightweight",
                supported_efforts: ["low", "medium", "high"],
              },
            },
          },
        },
      },
    };

    const suite = createCatalogExecutionAdapters(oneHostThreeVendors);
    const adapter = suite.adapters.get("synthetic-polyglot-host");
    expect(adapter).toBeDefined();
    expect(adapter!.host).toBe("synthetic-polyglot-host");
    // Multi-vendor host adapter must not hardcode a single vendor on the host object itself.
    expect(adapter!.provider).toBeUndefined();

    expect(resolveAdapterModelCapability(adapter!, "alpha-frontier-1", "polyglot:test")).toEqual({
      provider: "vendor-alpha",
      host: "synthetic-polyglot-host",
      rawModel: "alpha-frontier-1",
      resolvedModel: "alpha-frontier-1",
      modelClass: "frontier",
      minimumReasoningEffort: "high",
      supportedEfforts: ["high", "xhigh"],
      aliasUsed: false,
      policyRevision: "synthetic-d0328-1h3v",
      provenance: "polyglot:test",
    });
    expect(resolveAdapterModelCapability(adapter!, "beta-deep-2", "polyglot:test")).toMatchObject({
      provider: "vendor-beta",
      host: "synthetic-polyglot-host",
      resolvedModel: "beta-deep-2",
      modelClass: "deep",
      minimumReasoningEffort: null,
    });
    expect(resolveAdapterModelCapability(adapter!, "gamma-light-3", "polyglot:test")).toMatchObject({
      provider: "vendor-gamma",
      host: "synthetic-polyglot-host",
      resolvedModel: "gamma-light-3",
      modelClass: "lightweight",
    });
  });

  it("resolves 1 vendor x multiple hosts from a synthetic catalog with the same structure across all hosts", () => {
    const oneVendorMultiHost = {
      schema_version: 1,
      policy_revision: "synthetic-d0328-1v3h",
      model_class_order: ["lightweight", "general", "deep", "frontier"],
      effort_order: ["low", "medium", "high", "xhigh", "max", "ultra"],
      providers: {
        "vendor-shared": {
          hosts: ["host-one", "host-two", "host-three"],
          catalog: {
            matching: "exact-only",
            models: {
              "shared-deep-model": {
                model_class: "deep",
                minimum_effort: "high",
                supported_efforts: ["high", "xhigh"],
              },
            },
          },
        },
      },
    } as unknown as ModelRoutingPresetsV1;

    const suite = createCatalogExecutionAdapters(oneVendorMultiHost);
    for (const host of ["host-one", "host-two", "host-three"]) {
      const adapter = suite.adapters.get(host);
      expect(adapter).toBeDefined();
      expect(resolveAdapterModelCapability(adapter!, "shared-deep-model", `${host}:test`)).toEqual({
        provider: "vendor-shared",
        host,
        rawModel: "shared-deep-model",
        resolvedModel: "shared-deep-model",
        modelClass: "deep",
        minimumReasoningEffort: "high",
        supportedEfforts: ["high", "xhigh"],
        aliasUsed: false,
        policyRevision: "synthetic-d0328-1v3h",
        provenance: `${host}:test`,
      });
    }
  });

  it("explicitly reports undetermined for unknown models, ambiguous cross-vendor models, and providerless adapters without host fallback", () => {
    const catalog = {
      schema_version: 1,
      policy_revision: "synthetic-d0328-unknown",
      model_class_order: ["lightweight", "general", "deep", "frontier"],
      effort_order: ["low", "medium", "high", "xhigh", "max", "ultra"],
      providers: {
        "vendor-alpha": {
          host: "synthetic-polyglot-host",
          catalog: {
            matching: "exact-only",
            models: {
              "alpha-only": { model_class: "general", supported_efforts: ["high"] },
              "colliding-model": { model_class: "general", supported_efforts: ["high"] },
            },
          },
        },
        "vendor-beta": {
          host: "synthetic-polyglot-host",
          catalog: {
            matching: "exact-only",
            models: {
              "beta-only": { model_class: "deep", supported_efforts: ["high"] },
              "colliding-model": { model_class: "deep", supported_efforts: ["high"] },
            },
          },
        },
      },
    } as unknown as ModelRoutingPresetsV1;

    const suite = createCatalogExecutionAdapters(catalog);
    const adapter = suite.adapters.get("synthetic-polyglot-host")!;
    expect(resolveAdapterModelCapability(adapter, "unlisted-model")).toBeNull();
    expect(adapter.modelClassForModel("unlisted-model")).toBeNull();

    const judgeModel = (adapter as unknown as {
      judgeModel?: (model: string, provenance?: string) => unknown;
    }).judgeModel;
    expect(typeof judgeModel).toBe("function");
    expect(judgeModel!.call(adapter, "unlisted-model", "polyglot:test")).toEqual({
      status: "undetermined",
      reason: "MODEL_NOT_IN_CATALOG",
      host: "synthetic-polyglot-host",
      rawModel: "unlisted-model",
      provider: null,
      modelClass: null,
      policyRevision: "synthetic-d0328-unknown",
      provenance: "polyglot:test",
    });

    // Ambiguous model claimed by two vendors on the same host must also be undetermined, never picking the first vendor.
    expect(resolveAdapterModelCapability(adapter, "colliding-model")).toBeNull();
    expect(judgeModel!.call(adapter, "colliding-model", "polyglot:test")).toEqual({
      status: "undetermined",
      reason: "AMBIGUOUS_PROVIDER_MATCH",
      host: "synthetic-polyglot-host",
      rawModel: "colliding-model",
      provider: null,
      modelClass: null,
      policyRevision: "synthetic-d0328-unknown",
      provenance: "polyglot:test",
    });
    const collidingProvider = new HostAttestationProvider(adapter);
    let collidingFailure: unknown;
    try {
      collidingProvider.run(
        "plan_workflow",
        rootCaller("synthetic-polyglot-host", "session-d0328", { callId: "call-d0328-colliding",
          execution: { model: "colliding-model", effort: "high", turnId: "turn-d0328", provenance: "synthetic-polyglot-host:test" } }),
        () => collidingProvider.observe(bootstrap("d0328-colliding-task")),
      );
    } catch (error) {
      collidingFailure = error;
    }
    expect(collidingFailure).toMatchObject({
      code: "BINDING_INVALID",
      details: { reasonCode: "AMBIGUOUS_PROVIDER_MATCH" },
    });

    // Legacy/custom adapter without provider identity must not infer provider from adapter.host.
    // @ts-expect-error Legacy/custom adapter without resolveModel must declare provider at compile time.
    const providerlessAdapter: HostExecutionAdapter = {
      host: "synthetic-host-only",
      modelClassForModel: () => "deep",
    };
    expect(resolveAdapterModelCapability(providerlessAdapter, "some-model")).toBeNull();
    expect(judgeAdapterModelCapability(providerlessAdapter, "some-model", "synthetic:test")).toEqual({
      status: "undetermined",
      reason: "MISSING_PROVIDER_IDENTITY",
      host: "synthetic-host-only",
      rawModel: "some-model",
      provider: null,
      modelClass: null,
      policyRevision: null,
      provenance: "synthetic:test",
    });

    expect(resolveHostAttestation({ AGENT_GOVERNANCE_HOST_ATTESTATION: "antigravity" })).toBe(antigravityExecutionAdapter);
    // Bundled hosts (codex, claude-code, gemini, antigravity) all resolve OpenAI, Anthropic, and Gemini models by model ID.
    for (const hostName of ["codex", "claude-code", "gemini", "antigravity"]) {
      const bundledAdapter = defaultExecutionAdapters.get(hostName);
      expect(bundledAdapter, hostName).toBeDefined();
      expect(resolveAdapterModelCapability(bundledAdapter!, "gpt-6-astra")).toMatchObject({
        host: hostName,
        provider: "openai-codex",
        resolvedModel: "gpt-6-astra",
        modelClass: "frontier",
      });
      expect(resolveAdapterModelCapability(bundledAdapter!, "claude-opus-5")).toMatchObject({
        host: hostName,
        provider: "anthropic-claude-code",
        resolvedModel: "opus",
        modelClass: "deep",
      });
      expect(resolveAdapterModelCapability(bundledAdapter!, "gemini-2.5-pro")).toMatchObject({
        host: hostName,
        provider: "google-gemini",
        resolvedModel: "pro",
        modelClass: "deep",
      });
      expect(resolveAdapterModelCapability(bundledAdapter!, "unknown-model-id")).toBeNull();
    }
  });
});
