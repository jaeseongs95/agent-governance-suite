import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ConvergenceFrameV1, StageResultV1, TaskEnvelopeV1 } from "../../contracts/types.js";
import { observeCodexHook } from "../../mcp-server/src/codex-host-observation.js";
import {
  HOST_ATTESTATION_FIELD,
  type HostExecutionAdapter,
  hostActorId,
  HostAttestationProvider,
  issueHostAttestation,
  resolveAdapterModelCapability,
} from "../../mcp-server/src/host-attestation.js";
import {
  claudeCodeExecutionAdapter,
  codexExecutionAdapter,
  createCatalogExecutionAdapters,
  geminiExecutionAdapter,
  type ModelRoutingPresetsV1,
} from "../../mcp-server/src/host-execution-adapters.js";
import {
  findLatestAssistantObservation,
  handleCodexHostAttestationHook,
  handleHostAttestationHook,
} from "../../mcp-server/src/host-attestation-hook.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { getPolicyRevision, resolveModelSelection } from "../../skills/coordinate-subagents/scripts/model-routing.mjs";
import syntheticCatalogV2 from "./fixtures/synthetic-model-catalog-v2.json" with { type: "json" };

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const SESSION = "session-capability-contract";
const TRANSCRIPT = "transcripts/session-capability-contract.jsonl";
const TOOL_PREFIX = "mcp__plugin_agent-governance-suite_agent-governance-suite__";

function createTask(taskId: string, riskLevel: "low" | "medium" | "high" = "low"): TaskEnvelopeV1 {
  return {
    schemaVersion: "1.0.0",
    taskId,
    objective: "Verify vendor-neutral model/capability contract and single-catalog update propagation.",
    scope: { included: ["mcp-server", "coordinate-subagents"], excluded: ["deployment"] },
    acceptanceCriteria: ["Consume vendor-neutral capability contract without vendor string branches in shared logic."],
    riskLevel,
    workUnits: [{ id: "unit-1", objective: "Verify capability resolution.", dependencies: [], writeTargets: ["fixture.md"] }],
    requiredCapabilities: ["task-decomposition"],
    constraints: ["Synthetic fixture only."],
    authorization: { allowedActions: ["test"], prohibitedActions: ["deploy"], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false },
    orchestration: { requested: true, mcpAvailable: true },
  };
}

describe("AGS-08A vendor-neutral model/capability contract and single-catalog update", () => {
  it("normalizes 3-vendor raw model names, Bedrock/Vertex prefixes, aliases, and provenance at the adapter boundary while rejecting bare Claude profiles (AC1, AC2, F06)", () => {
    const codexCap = resolveAdapterModelCapability(codexExecutionAdapter, "gpt-6.1-sol", "codex:rollout-turn-context");
    expect(codexCap).toEqual({
      provider: "openai-codex",
      host: "codex",
      rawModel: "gpt-6.1-sol",
      resolvedModel: "gpt-6.1-sol",
      modelClass: "general",
      minimumReasoningEffort: null,
      supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      aliasUsed: false,
      policyRevision: "2026-10-24.r02",
      provenance: "codex:rollout-turn-context",
    });

    const lunaCap = resolveAdapterModelCapability(codexExecutionAdapter, "gpt-5.6-luna", "codex:rollout-turn-context");
    expect(lunaCap).toMatchObject({
      provider: "openai-codex",
      resolvedModel: "gpt-5.6-luna",
      modelClass: "lightweight",
      minimumReasoningEffort: "high",
    });

    const claudeBedrock = resolveAdapterModelCapability(
      claudeCodeExecutionAdapter,
      "us.anthropic.claude-opus-5-v1:0",
      "claude-code:transcript-tool-use",
    );
    expect(claudeBedrock).toMatchObject({
      provider: "anthropic-claude-code",
      host: "claude-code",
      rawModel: "us.anthropic.claude-opus-5-v1:0",
      resolvedModel: "opus",
      modelClass: "deep",
      aliasUsed: true,
      policyRevision: "2026-10-24.r02",
      provenance: "claude-code:transcript-tool-use",
    });

    const geminiAlias = resolveAdapterModelCapability(
      geminiExecutionAdapter,
      "models/gemini-2.5-flash_lite",
      "gemini:wrapper",
    );
    expect(geminiAlias).toMatchObject({
      provider: "google-gemini",
      host: "gemini",
      rawModel: "models/gemini-2.5-flash_lite",
      resolvedModel: "flash-lite",
      modelClass: "lightweight",
      aliasUsed: true,
      policyRevision: "2026-10-24.r02",
      provenance: "gemini:wrapper",
    });

    // F06 regression: bare subagent routing profile tokens ("opus", "sonnet", "haiku", "fable")
    // must remain rejected at the Claude runtime observation boundary unless prefixed as claude-...
    expect(resolveAdapterModelCapability(claudeCodeExecutionAdapter, "opus")).toBeNull();
    expect(resolveAdapterModelCapability(claudeCodeExecutionAdapter, "sonnet")).toBeNull();
    expect(resolveAdapterModelCapability(claudeCodeExecutionAdapter, "haiku")).toBeNull();
    expect(resolveAdapterModelCapability(claudeCodeExecutionAdapter, "fable")).toBeNull();

    expect(resolveAdapterModelCapability(codexExecutionAdapter, "gpt-6.1-sol-latest")).toBeNull();
    expect(resolveAdapterModelCapability(claudeCodeExecutionAdapter, "claude-unknown-9")).toBeNull();
    expect(resolveAdapterModelCapability(geminiExecutionAdapter, "flash-8b")).toBeNull();
  });

  it("propagates a synthetic v2 catalog update across routing, hooks, and server verification without code branches (AC3, AC5)", () => {
    const syntheticSuite = createCatalogExecutionAdapters(syntheticCatalogV2 as unknown as ModelRoutingPresetsV1);
    expect(syntheticSuite.policyRevision).toBe("synthetic-2026-10-24.v2");
    expect(getPolicyRevision(syntheticCatalogV2)).toBe("synthetic-2026-10-24.v2");

    // 1. Subagent model-routing consumes the same synthetic v2 catalog via internal second parameter.
    const routed = resolveModelSelection(
      {
        provider: "openai-codex",
        role: "independent-audit",
        highRisk: true,
        supported: [
          { model: "gpt-6.5-nova", modelClass: "frontier", efforts: ["high", "xhigh", "max", "ultra"] },
        ],
      },
      syntheticCatalogV2,
    );
    expect(routed.selection).toEqual({ model: "gpt-6.5-nova", effort: "xhigh" });

    // Below gpt-6.5-nova minimum_effort ("xhigh"), routing blocks even if "high" is in supported.
    const blockedByModelMinimum = resolveModelSelection(
      {
        provider: "openai-codex",
        role: "independent-audit",
        highRisk: true,
        user: { model: "gpt-6.5-nova", effort: "high" },
        supported: [
          { model: "gpt-6.5-nova", modelClass: "frontier", efforts: ["high", "xhigh"] },
        ],
      },
      syntheticCatalogV2,
    );
    expect(blockedByModelMinimum.delivery).toBe("blocked");

    // 2. Codex hook and server attestation accept synthetic "gpt-6.5-nova-canonical" alias at "xhigh"
    //    and reject it at "high" (below minimum_effort).
    const store = new InMemoryWorkflowStore();
    const validator = new ContractValidator();
    const provider = new HostAttestationProvider(store, syntheticSuite.adapters.get("codex")!);
    const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, provider);

    const lowEffortHook = observeCodexHook(
      {
        hook_event_name: "PreToolUse",
        session_id: SESSION,
        turn_id: "turn-1",
        tool_use_id: "call-low",
        model: "gpt-6.5-nova-canonical",
        transcript_path: TRANSCRIPT,
      },
      {
        adapter: syntheticSuite.adapters.get("codex")!,
        readMetadata: () => ({
          head: `${JSON.stringify({ type: "session_meta", payload: { id: SESSION, source: "cli" } })}\n`,
          tail: `${JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-6.5-nova-canonical", effort: "high" } })}\n`,
        }),
      },
    );
    expect(lowEffortHook).toEqual({
      observation: null,
      reason: "host-reasoning-effort-below-model-minimum-or-unsupported",
    });

    const validCodexOutput = handleCodexHostAttestationHook(
      {
        hook_event_name: "PreToolUse",
        session_id: SESSION,
        turn_id: "turn-2",
        tool_use_id: "call-valid",
        model: "gpt-6.5-nova-canonical",
        transcript_path: TRANSCRIPT,
        tool_name: `${TOOL_PREFIX}plan_workflow`,
        tool_input: { schemaVersion: "1.0.0", taskEnvelope: createTask("synthetic-codex-task", "high") },
      },
      store,
      {
        adapter: syntheticSuite.adapters.get("codex")!,
        readMetadata: () => ({
          head: `${JSON.stringify({ type: "session_meta", payload: { id: SESSION, source: "cli" } })}\n`,
          tail: `${JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-6.5-nova-canonical", effort: "xhigh" } })}\n`,
        }),
      },
    );
    const signedArgs = (validCodexOutput.hookSpecificOutput as { updatedInput: Record<string, unknown> }).updatedInput;
    const planned = provider.run("plan_workflow", signedArgs, (clean) => service.planWorkflow(clean, true));
    expect(planned.ok).toBe(true);
    expect(planned.data?.bootstrapExecution?.context).toMatchObject({
      model: "gpt-6.5-nova-canonical",
      modelClass: "frontier",
      reasoningEffort: "xhigh",
    });
    expect(provider.lastObservedCapability()).toEqual({
      provider: "openai-codex",
      host: "codex",
      rawModel: "gpt-6.5-nova-canonical",
      resolvedModel: "gpt-6.5-nova",
      modelClass: "frontier",
      minimumReasoningEffort: "xhigh",
      supportedEfforts: ["high", "xhigh", "max", "ultra"],
      aliasUsed: true,
      policyRevision: "synthetic-2026-10-24.v2",
      provenance: "codex:rollout-turn-context",
    });

    // 3. Claude hook and interactive fallback accept synthetic "claude-mythos-6" / "claude-mythos-preview" via injected adapter.
    const claudeLine = JSON.stringify({
      type: "assistant",
      sessionId: SESSION,
      isSidechain: false,
      timestamp: "2026-10-24T05:00:00.000Z",
      effort: "xhigh",
      message: {
        model: "us.anthropic.claude-mythos-preview-v1:0",
        content: [{ type: "tool_use", id: "toolu_mythos", name: "plan_workflow", input: {} }],
      },
    });
    expect(
      findLatestAssistantObservation(
        claudeLine,
        SESSION,
        null,
        Date.parse("2026-10-24T05:01:00.000Z"),
        syntheticSuite.adapters.get("claude-code")!,
      ),
    ).toEqual({
      model: "us.anthropic.claude-mythos-preview-v1:0",
      at: Date.parse("2026-10-24T05:00:00.000Z"),
    });

    const claudeHookOut = handleHostAttestationHook(
      {
        hook_event_name: "PreToolUse",
        session_id: SESSION,
        transcript_path: TRANSCRIPT,
        tool_name: `${TOOL_PREFIX}plan_workflow`,
        tool_use_id: "toolu_mythos",
        tool_input: { schemaVersion: "1.0.0", taskEnvelope: createTask("synthetic-claude-task", "high") },
        effort: { level: "xhigh" },
      },
      store,
      {
        adapter: syntheticSuite.adapters.get("claude-code")!,
        readText: () => claudeLine,
        sleep: () => {},
      },
    );
    const claudeSigned = (claudeHookOut.hookSpecificOutput as { updatedInput: Record<string, unknown> }).updatedInput;
    const claudeProvider = new HostAttestationProvider(store, syntheticSuite.adapters.get("claude-code")!);
    const claudeService = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, claudeProvider);
    const claudePlanned = claudeProvider.run("plan_workflow", claudeSigned, (clean) => claudeService.planWorkflow(clean, true));
    expect(claudePlanned.ok).toBe(true);
    expect(claudeProvider.lastObservedCapability()).toMatchObject({
      provider: "anthropic-claude-code",
      rawModel: "us.anthropic.claude-mythos-preview-v1:0",
      resolvedModel: "mythos",
      modelClass: "frontier",
      aliasUsed: true,
      policyRevision: "synthetic-2026-10-24.v2",
      provenance: "claude-code:transcript-tool-use",
    });

    // 4. Gemini wrapper attestation resolves synthetic "gemini-4.0-argon_pro" -> "argon" ("deep").
    const geminiProvider = new HostAttestationProvider(store, syntheticSuite.adapters.get("gemini")!);
    const geminiService = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, geminiProvider);
    const geminiInput = { schemaVersion: "1.0.0", taskEnvelope: createTask("synthetic-gemini-task", "high") };
    const geminiPlanned = geminiProvider.runObserved(
      "plan_workflow",
      geminiInput,
      () => ({
        model: "models/gemini-4.0-argon_pro",
        reasoningEffort: "high",
        actorId: hostActorId("gemini", SESSION),
        sessionId: SESSION,
        turnId: "gemini-turn-1",
        toolUseId: "gemini-call-1",
        provenance: "gemini:wrapper-runtime",
      }),
      (clean) => geminiService.planWorkflow(clean, true),
    );
    expect(geminiPlanned.ok).toBe(true);
    expect(geminiProvider.lastObservedCapability()).toMatchObject({
      provider: "google-gemini",
      rawModel: "models/gemini-4.0-argon_pro",
      resolvedModel: "argon",
      modelClass: "deep",
      minimumReasoningEffort: "medium",
      aliasUsed: true,
      policyRevision: "synthetic-2026-10-24.v2",
      provenance: "gemini:wrapper-runtime",
    });
  });

  it("closes policy-authority, alias-selection, and effort-subset gaps across routing and server attestation (F03, F04, F05)", () => {
    // F03: Caller options cannot smuggle `presets` or reorder `model_class_order` / `effort_order` to weaken mandatory highRisk floors.
    expect(() =>
      resolveModelSelection({
        presets: syntheticCatalogV2,
        provider: "openai-codex",
        role: "independent-audit",
        highRisk: true,
        supported: [{ model: "gpt-6.5-nova", modelClass: "frontier", efforts: ["xhigh"] }],
      } as unknown as Record<string, unknown>),
    ).toThrow(/policy presets cannot be overridden via caller options/);

    const reorderedPresets = {
      ...syntheticCatalogV2,
      model_class_order: ["general", "lightweight", "deep", "frontier"],
      effort_order: ["high", "medium", "low", "xhigh", "max", "ultra"],
    };
    expect(() =>
      resolveModelSelection(
        {
          provider: "openai-codex",
          role: "independent-audit",
          highRisk: true,
          user: { model: "gpt-5.6-luna", effort: "medium" },
          supported: [{ model: "gpt-5.6-luna", modelClass: "lightweight", efforts: ["medium", "high"] }],
        },
        reorderedPresets,
      ),
    ).toThrow(/immutable contract and cannot be reordered/);

    // F04: Requesting an alias ("gpt-6.5-nova-canonical") when the host only advertises canonical "gpt-6.5-nova"
    // preserves `requested.model` as the raw alias while returning `selection.model` as the host-supported canonical ID.
    const aliasResolved = resolveModelSelection(
      {
        provider: "openai-codex",
        role: "independent-audit",
        highRisk: true,
        user: { model: "gpt-6.5-nova-canonical", effort: "xhigh" },
        supported: [{ model: "gpt-6.5-nova", modelClass: "frontier", efforts: ["xhigh"] }],
      },
      syntheticCatalogV2,
    );
    expect(aliasResolved).toEqual({
      requested: { model: "gpt-6.5-nova-canonical", effort: "xhigh" },
      selection: { model: "gpt-6.5-nova", effort: "xhigh" },
      delivery: "explicit",
      fallbackReason: null,
    });

    // If the host explicitly advertises the alias itself in `supported`, `selection.model` keeps that exact advertised entry.
    const directAliasAdvertised = resolveModelSelection(
      {
        provider: "openai-codex",
        role: "independent-audit",
        highRisk: true,
        user: { model: "gpt-6.5-nova-canonical", effort: "xhigh" },
        supported: [{ model: "gpt-6.5-nova-canonical", modelClass: "frontier", efforts: ["xhigh"] }],
      },
      syntheticCatalogV2,
    );
    expect(directAliasAdvertised.selection).toEqual({ model: "gpt-6.5-nova-canonical", effort: "xhigh" });

    // F05: When the central catalog narrows `supported_efforts` (e.g., to ["xhigh"] only), both routing and server attestation
    // reject an effort ("ultra") even if the host snapshot advertises ["xhigh", "ultra"].
    const narrowedCatalog = structuredClone(syntheticCatalogV2);
    narrowedCatalog.providers["openai-codex"].catalog.models["gpt-6.5-nova"].supported_efforts = ["xhigh"];

    const blockedByCatalogSupportedEfforts = resolveModelSelection(
      {
        provider: "openai-codex",
        role: "independent-audit",
        highRisk: true,
        user: { model: "gpt-6.5-nova", effort: "ultra" },
        supported: [{ model: "gpt-6.5-nova", modelClass: "frontier", efforts: ["xhigh", "ultra"] }],
      },
      narrowedCatalog,
    );
    expect(blockedByCatalogSupportedEfforts.delivery).toBe("blocked");

    const store = new InMemoryWorkflowStore();
    const narrowedSuite = createCatalogExecutionAdapters(narrowedCatalog as unknown as ModelRoutingPresetsV1);
    const rejectedToken = issueHostAttestation(store, narrowedSuite.adapters.get("codex")!, {
      tool: "plan_workflow",
      input: { schemaVersion: "1.0.0", taskEnvelope: createTask("narrowed-effort-task", "high") },
      model: "gpt-6.5-nova",
      reasoningEffort: "ultra",
      actorId: hostActorId("codex", SESSION),
      sessionId: SESSION,
      turnId: "turn-narrow",
      toolUseId: "call-narrow-1",
    });
    expect(rejectedToken).toBeNull();
  });

  it("preserves policyRevision, provenance, unknown-model rejection, tampering, expiry, replay, and assurance floors (AC4)", () => {
    const store = new InMemoryWorkflowStore();
    const validator = new ContractValidator();
    const defaultProvider = new HostAttestationProvider(store, codexExecutionAdapter);
    const syntheticSuite = createCatalogExecutionAdapters(syntheticCatalogV2 as unknown as ModelRoutingPresetsV1);
    const v2Provider = new HostAttestationProvider(store, syntheticSuite.adapters.get("codex")!);
    const v2Service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, v2Provider);

    const planArgs = { schemaVersion: "1.0.0", taskEnvelope: createTask("revision-mismatch-task", "high") };

    // A token minted under default policyRevision ("2026-10-24.r02") is rejected by a server configured with v2 ("synthetic-2026-10-24.v2").
    const v1Token = issueHostAttestation(store, codexExecutionAdapter, {
      tool: "plan_workflow",
      input: planArgs,
      model: "gpt-6-astra",
      reasoningEffort: "high",
      actorId: hostActorId("codex", SESSION),
      sessionId: SESSION,
      turnId: "turn-rev",
      toolUseId: "call-rev-1",
      provenance: "codex:rollout-turn-context",
    });
    expect(v1Token).toBeTruthy();
    const crossRevision = v2Provider.run(
      "plan_workflow",
      { ...planArgs, [HOST_ATTESTATION_FIELD]: v1Token },
      (clean) => v2Service.planWorkflow(clean, true),
    );
    expect(crossRevision.error?.code).toBe("BINDING_INVALID");
    expect(v2Provider.lastObservedCapability()).toBeNull();

    // Tampered token signature is rejected fail-closed.
    const tamperedToken = `${v1Token}tampered`;
    const defaultService = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, defaultProvider);
    const tampered = defaultProvider.run(
      "plan_workflow",
      { ...planArgs, [HOST_ATTESTATION_FIELD]: tamperedToken },
      (clean) => defaultService.planWorkflow(clean, true),
    );
    expect(tampered.error?.code).toBe("BINDING_INVALID");

    // Expired token (> 5m old) is rejected fail-closed by WorkflowService validity window check.
    const expiredToken = issueHostAttestation(store, codexExecutionAdapter, {
      tool: "plan_workflow",
      input: planArgs,
      model: "gpt-6-astra",
      reasoningEffort: "high",
      actorId: hostActorId("codex", SESSION),
      sessionId: SESSION,
      turnId: "turn-exp",
      toolUseId: "call-exp-1",
      now: new Date(Date.now() - 10 * 60 * 1000),
    });
    expect(expiredToken).toBeTruthy();
    const expiredResult = defaultProvider.run(
      "plan_workflow",
      { ...planArgs, [HOST_ATTESTATION_FIELD]: expiredToken },
      (clean) => defaultService.planWorkflow(clean, true),
    );
    expect(expiredResult.error?.code).toBe("BINDING_INVALID");

    // And a token for gpt-5.6-luna with effort "medium" (below model minimum "high") cannot be minted at all.
    const lunaBelowFloor = issueHostAttestation(store, codexExecutionAdapter, {
      tool: "plan_workflow",
      input: planArgs,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      actorId: hostActorId("codex", SESSION),
      sessionId: SESSION,
      turnId: "turn-luna",
      toolUseId: "call-luna-1",
    });
    expect(lunaBelowFloor).toBeNull();

    // Even when a lightweight model ("gpt-5.6-luna" at "high") mints a valid token, high-risk bootstrap assurance floor ("general"/"high") rejects it.
    const lunaHighToken = issueHostAttestation(store, codexExecutionAdapter, {
      tool: "plan_workflow",
      input: planArgs,
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      actorId: hostActorId("codex", SESSION),
      sessionId: SESSION,
      turnId: "turn-luna-high",
      toolUseId: "call-luna-high-1",
    });
    expect(lunaHighToken).toBeTruthy();
    const belowBootstrapFloor = defaultProvider.run(
      "plan_workflow",
      { ...planArgs, [HOST_ATTESTATION_FIELD]: lunaHighToken },
      (clean) => defaultService.planWorkflow(clean, true),
    );
    expect(belowBootstrapFloor.error?.code).toBe("BINDING_INVALID");

    // Under defaultProvider, the valid v1Token works once and fails closed on replay.
    const first = defaultProvider.run(
      "plan_workflow",
      { ...planArgs, [HOST_ATTESTATION_FIELD]: v1Token },
      (clean) => defaultService.planWorkflow(clean, true),
    );
    expect(first.ok).toBe(true);
    expect(defaultProvider.lastObservedCapability()?.resolvedModel).toBe("gpt-6-astra");

    const replay = defaultProvider.run(
      "plan_workflow",
      { ...planArgs, [HOST_ATTESTATION_FIELD]: v1Token },
      (clean) => defaultService.planWorkflow(clean, true),
    );
    expect(replay.error?.code).toBe("BINDING_INVALID");

    // Missing token on subsequent observe() clears lastObservedCapability so stale call metadata cannot leak.
    const missingTokenCall = defaultProvider.run(
      "plan_workflow",
      planArgs,
      (clean) => defaultService.planWorkflow(clean, true),
    );
    expect(missingTokenCall.error?.code).toBe("BINDING_REQUIRED");
    expect(defaultProvider.lastObservedCapability()).toBeNull();
  });

  it("keeps both catalog and observed host class floors when policy reclassifies a model (AC3, AC4)", () => {
    const options = {
      provider: "openai-codex", role: "independent-audit", highRisk: true,
      user: { model: "gpt-6.5-nova", effort: "xhigh" },
      supported: [{ model: "gpt-6.5-nova", modelClass: "frontier", efforts: ["xhigh"] }],
    };
    expect(resolveModelSelection(options, syntheticCatalogV2).delivery).toBe("explicit");

    const downgraded = structuredClone(syntheticCatalogV2);
    downgraded.policy_revision = "synthetic-class-downgrade";
    downgraded.providers["openai-codex"].catalog.models["gpt-6.5-nova"].model_class = "lightweight";
    const suite = createCatalogExecutionAdapters(downgraded as unknown as ModelRoutingPresetsV1);
    expect(suite.adapters.get("codex")!.modelClassForModel("gpt-6.5-nova")).toBe("lightweight");
    expect(resolveModelSelection(options, downgraded).delivery).toBe("blocked");
    expect(resolveModelSelection({
      ...options, supported: [{ ...options.supported[0]!, modelClass: "lightweight" }],
    }, syntheticCatalogV2).delivery).toBe("blocked");
  });

  it("rejects below-class and below-effort stage observations before recording a valid stage (AC4, AC5)", () => {
    const store = new InMemoryWorkflowStore();
    const validator = new ContractValidator();
    const provider = new HostAttestationProvider(store, codexExecutionAdapter);
    const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, provider);
    const taskEnvelope = createTask("capability-stage-floor");
    taskEnvelope.artifactContracts = [{
      capability: "task-decomposition",
      produced: ["delegation-decision", "task-graph", "assignment-briefs", "integration-report"].map((artifactId) => ({
        artifactId, schemaId: "host-attestation/v1", targetDigest: `sha256:${"e".repeat(64)}` as const,
      })),
    }];
    const planArgs = { schemaVersion: "1.0.0", taskEnvelope };
    const bootstrapToken = issueHostAttestation(store, codexExecutionAdapter, {
      tool: "plan_workflow", input: planArgs, model: "gpt-6-astra", reasoningEffort: "high",
      actorId: hostActorId("codex", SESSION), sessionId: SESSION,
      turnId: "stage-bootstrap", toolUseId: "stage-bootstrap-call",
    });
    expect(bootstrapToken).toBeTruthy();
    const planned = provider.run("plan_workflow", { ...planArgs, [HOST_ATTESTATION_FIELD]: bootstrapToken },
      (clean) => service.planWorkflow(clean, true));
    expect(planned.ok).toBe(true);
    const plan = planned.data!;
    const frame: ConvergenceFrameV1 = {
      schemaVersion: "1.0.0",
      workspace: { workspaceId: "capability-stage-floor", locator: "tests/mcp/model-capability-contract.test.ts" },
      controlArtifacts: [{ artifactId: "acceptance", role: "pass-condition", locator: "fixture:acceptance", digest: `sha256:${"a".repeat(64)}` }],
      targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: "fixture:candidate", digest: `sha256:${"b".repeat(64)}` }],
      operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
    };
    const opened = service.openConvergenceRoot({ schemaVersion: "1.0.0", parentRootId: null, taskEnvelope, frame, userApprovalRefs: [] });
    expect(opened.ok).toBe(true);
    const root = opened.data!;
    const claimed = service.claimWorkflowAttempt({
      schemaVersion: "1.0.0", rootId: root.rootId, expectedRevision: root.revision,
      taskEnvelope, frame, plan, actorId: plan.bootstrapExecution!.context.actorId,
      outputTargets: ["fixture.md"], priorFailure: null,
    }, true);
    expect(claimed.ok).toBe(true);
    const lease = claimed.data!;
    const started = service.startGuardedWorkflow({
      schemaVersion: "1.0.0", leaseId: lease.leaseId, expectedRootRevision: lease.rootRevision, plan,
    }, true);
    expect(started.ok).toBe(true);
    const receipt = started.data!;
    const stage = receipt.plan.stages[0]!;
    expect(stage.executionRequirement?.kind).toBe("semantic");
    const stageArgs: StageResultV1 = {
      schemaVersion: "1.0.0", runId: receipt.runId, stageId: stage.stageId,
      expectedRevision: receipt.revision, state: "passed",
      output: {
        schemaVersion: "1.0.0", kind: "output", output: { completed: true },
        artifacts: stage.requiredArtifacts.map((artifactId) => ({
          artifactId, schemaId: "host-attestation/v1", locator: "fixture:" + artifactId,
          digest: "d".repeat(64), targetDigest: "e".repeat(64), verified: true,
        })), error: null,
      },
      evidence: [{ artifactId: "stage-floor", kind: "test", locator: "model-capability-contract.test.ts", verified: true, note: "Synthetic in-memory stage observations." }],
      findings: [], blockers: [], error: null,
    };
    for (const [model, reasoningEffort, toolUseId] of [
      ["gpt-5.6-luna", "high", "stage-low-class"],
      ["gpt-6-astra", "low", "stage-low-effort"],
    ] as const) {
      const token = issueHostAttestation(store, codexExecutionAdapter, {
        tool: "record_stage_result", input: stageArgs as unknown as Record<string, unknown>, model, reasoningEffort,
        actorId: hostActorId("codex", SESSION), sessionId: SESSION, turnId: "stage-turn", toolUseId,
      });
      expect(token).toBeTruthy();
      const rejected = provider.run("record_stage_result", { ...stageArgs, [HOST_ATTESTATION_FIELD]: token },
        (clean) => service.recordStageResult(clean, true));
      expect(rejected.error?.code).toBe("BINDING_INVALID");
      expect(service.getWorkflowStatus(receipt.runId).data?.stageResults).toEqual([]);
    }
    const strongToken = issueHostAttestation(store, codexExecutionAdapter, {
      tool: "record_stage_result", input: stageArgs as unknown as Record<string, unknown>, model: "gpt-6-astra", reasoningEffort: "xhigh",
      actorId: hostActorId("codex", SESSION), sessionId: SESSION, turnId: "stage-turn", toolUseId: "stage-strong",
    });
    expect(strongToken).toBeTruthy();
    const recorded = provider.run("record_stage_result", { ...stageArgs, [HOST_ATTESTATION_FIELD]: strongToken },
      (clean) => service.recordStageResult(clean, true));
    expect(recorded.ok).toBe(true);
    expect(recorded.data?.stageResults[0]?.executionContext).toMatchObject({ model: "gpt-6-astra", modelClass: "frontier", reasoningEffort: "xhigh" });
  });

  it("uses one catalog interpretation for native IDs, aliases, inherited settings, and unknown models (AC2, AC3, AC4)", () => {
    for (const [provider, model] of [
      ["anthropic-claude-code", "claude-haiku-5"],
      ["google-gemini", "models/gemini-2.5-flash_lite"],
    ] as const) {
      const options = {
        provider, role: "independent-audit", highRisk: true,
        user: { model, effort: "high" },
        supported: [{ model, modelClass: "frontier", efforts: ["high"] }],
      };
      expect(resolveModelSelection(options, syntheticCatalogV2).delivery).toBe("blocked");
      expect(resolveModelSelection({
        ...options, inheritOnly: true, inherited: { model, effort: "high" },
      }, syntheticCatalogV2).delivery).toBe("blocked");
    }
    for (const [provider, rawModel, canonicalModel] of [
      ["anthropic-claude-code", "us.anthropic.claude-mythos-preview-v1:0", "mythos"],
      ["google-gemini", "models/gemini-4.0-argon_pro", "argon"],
    ] as const) {
      const options = {
        provider, role: "independent-audit", highRisk: true,
        user: { model: rawModel, effort: "high" },
        supported: [{ model: canonicalModel, modelClass: "frontier", efforts: ["high"] }],
      };
      const selected = resolveModelSelection(options, syntheticCatalogV2);
      expect(selected.requested?.model).toBe(rawModel);
      expect(selected.selection).toEqual({ model: canonicalModel, effort: "high" });
      expect(selected.delivery).toBe("explicit");
      expect(resolveModelSelection({
        ...options, inheritOnly: true, inherited: { model: rawModel, effort: "high" },
      }, syntheticCatalogV2).delivery).toBe("inherited");
    }
    for (const [provider, model] of [
      ["openai-codex", "gpt-unknown-9"],
      ["anthropic-claude-code", "claude-unknown-9"],
      ["google-gemini", "models/gemini-9.0-unknown"],
    ] as const) {
      expect(resolveModelSelection({
        provider, role: "independent-audit", highRisk: true,
        user: { model, effort: "high" },
        inherited: { model, effort: "high" },
        supported: [{ model, modelClass: "frontier", efforts: ["high"] }],
      }, syntheticCatalogV2).delivery).toBe("blocked");
    }
    expect(resolveModelSelection({
      provider: "google-gemini", role: "general-implementation", highRisk: false,
      user: { model: "models/gemini-4.0-argon_pro", effort: "low" },
      supported: [{ model: "models/gemini-4.0-argon_pro", modelClass: "frontier", efforts: ["low", "high"] }],
    }, syntheticCatalogV2).delivery).toBe("blocked");
    const narrowed = structuredClone(syntheticCatalogV2);
    narrowed.providers["google-gemini"].catalog.models.argon.supported_efforts = ["high"];
    for (const effort of ["low", "xhigh", "high"]) {
      const selected = resolveModelSelection({
        provider: "google-gemini", role: "general-implementation", highRisk: false,
        user: { model: "models/gemini-4.0-argon_pro", effort },
        supported: [{ model: "models/gemini-4.0-argon_pro", modelClass: "frontier", efforts: ["low", "high", "xhigh"] }],
      }, narrowed);
      expect(selected.delivery).toBe(effort === "high" ? "explicit" : "blocked");
    }
    // A host without a central catalog still supplies its own observed capability snapshot.
    expect(resolveModelSelection({
      provider: "synthetic-host-without-catalog", role: "general-implementation", highRisk: true,
      inherited: { model: "host-observed-model", effort: "high" },
      supported: [{ model: "host-observed-model", modelClass: "general", efforts: ["high"] }],
    }, syntheticCatalogV2).delivery).toBe("explicit");
  });

  it("rejects a stale descriptor-only revision while preserving fresh and legacy adapter controls (AC4, AC5)", () => {
    const store = new InMemoryWorkflowStore();
    const validator = new ContractValidator();
    let revision = "descriptor-r1";
    const adapter: HostExecutionAdapter = {
      host: "codex",
      modelClassForModel: (model) => codexExecutionAdapter.modelClassForModel(model),
      resolveModel(model, provenance) {
        const capability = resolveAdapterModelCapability(codexExecutionAdapter, model, provenance);
        return capability ? { ...capability, policyRevision: revision } : null;
      },
    };
    expect(adapter.policyRevision).toBeUndefined();
    const provider = new HostAttestationProvider(store, adapter);
    const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, provider);
    const args = { schemaVersion: "1.0.0", taskEnvelope: createTask("descriptor-revision", "high") };
    const observation = {
      tool: "plan_workflow", input: args, model: "gpt-6-astra", reasoningEffort: "high" as const,
      actorId: hostActorId("codex", SESSION), sessionId: SESSION,
      turnId: "descriptor-turn", toolUseId: "descriptor-call",
    };
    const staleToken = issueHostAttestation(store, adapter, observation);
    expect(staleToken).toBeTruthy();
    revision = "descriptor-r2";
    const stale = provider.run("plan_workflow", { ...args, [HOST_ATTESTATION_FIELD]: staleToken },
      (clean) => service.planWorkflow(clean, true));
    expect(stale.error?.code).toBe("BINDING_INVALID");
    expect(provider.lastObservedCapability()).toBeNull();
    const freshToken = issueHostAttestation(store, adapter, observation);
    expect(freshToken).toBeTruthy();
    const fresh = provider.run("plan_workflow", { ...args, [HOST_ATTESTATION_FIELD]: freshToken },
      (clean) => service.planWorkflow(clean, true));
    expect(fresh.ok).toBe(true);
    expect(provider.lastObservedCapability()?.policyRevision).toBe("descriptor-r2");

    const legacy: HostExecutionAdapter = {
      host: "codex", modelClassForModel: (model) => codexExecutionAdapter.modelClassForModel(model),
    };
    expect(resolveAdapterModelCapability(legacy, "gpt-6-astra")?.policyRevision).toBe("1.0.0");
    const legacyProvider = new HostAttestationProvider(store, legacy);
    const legacyService = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, legacyProvider);
    const legacyArgs = { schemaVersion: "1.0.0", taskEnvelope: createTask("legacy-revision-control", "high") };
    const legacyToken = issueHostAttestation(store, legacy, {
      ...observation, input: legacyArgs, toolUseId: "legacy-control-call",
    });
    expect(legacyToken).toBeTruthy();
    const legacyResult = legacyProvider.run("plan_workflow", { ...legacyArgs, [HOST_ATTESTATION_FIELD]: legacyToken },
      (clean) => legacyService.planWorkflow(clean, true));
    expect(legacyResult.ok).toBe(true);
  });
});
