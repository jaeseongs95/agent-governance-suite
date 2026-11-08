import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { ConvergenceFrameV1, StageResultV1, TaskEnvelopeV1 } from "../../contracts/types.js";
import {
  type HostExecutionAdapter,
  hostActorId,
  HostAttestationProvider,
  resolveAdapterModelCapability,
} from "../../mcp-server/src/host-attestation.js";
import {
  claudeCodeExecutionAdapter,
  codexExecutionAdapter,
  createCatalogExecutionAdapters,
  geminiExecutionAdapter,
  type ModelRoutingPresetsV1,
} from "../../mcp-server/src/host-execution-adapters.js";
import { observeClaudeExecution } from "../../mcp-server/src/host-attestation-hook.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { getPolicyRevision, resolveModelSelection } from "../../skills/coordinate-subagents/scripts/model-routing.mjs";
import syntheticCatalogV2 from "./fixtures/synthetic-model-catalog-v2.json" with { type: "json" };
import { childCaller, rootCaller } from "../helpers/caller.js";
import { observedCaller } from "../../mcp-server/src/caller-actor.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const SESSION = "session-capability-contract";
const TRANSCRIPT = "transcripts/session-capability-contract.jsonl";
const TOOL_PREFIX = "mcp__plugin_agent-governance-suite_agent-governance-suite__";

function createTask(taskId: string, riskLevel: "low" | "medium" | "high" | "critical" = "low"): TaskEnvelopeV1 {
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
  it.each(["low", "high", "critical"] as const)("accepts a host-observed low-effort caller for complex %s-risk bootstrap without changing stage floors (D0094)", (riskLevel) => {
    const store = new InMemoryWorkflowStore();
    const provider = new HostAttestationProvider(codexExecutionAdapter);
    const validator = new ContractValidator();
    const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, provider);
    const input = { schemaVersion: "1.0.0", taskEnvelope: createTask(`d0094-current-${riskLevel}`, riskLevel) };
    input.taskEnvelope.decision.complexity = "complex";
    const caller = rootCaller("codex", SESSION, {
      callId: `d0094-current-${riskLevel}`,
      execution: { model: "gpt-6.1-sol", effort: "low", turnId: "d0094-current-turn", provenance: "codex:mcp-meta" },
    });
    const planned = provider.run("plan_workflow", caller,
      () => service.planWorkflow(input, true));
    expect(planned.ok).toBe(true);
    expect(planned.data?.bootstrapExecution).toMatchObject({
      requirement: { minimumModelClass: null, minimumReasoningEffort: null, observationRequired: true },
      context: { model: "gpt-6.1-sol", modelClass: "general", reasoningEffort: "low" },
    });
    // 고위험의 명시 general/high 정책은 접수와 별도로 각 단계에 결속한다.
    for (const stage of planned.data!.stages) {
      expect(stage.executionRequirement).toMatchObject({
        minimumModelClass: riskLevel === "low" ? null : "general",
        minimumReasoningEffort: riskLevel === "low" ? null : "high",
        observationRequired: true,
      });
    }
    const replay = provider.run("plan_workflow", caller,
      () => service.planWorkflow(input, true));
    expect(replay.error?.code).toBe("BINDING_INVALID");
  });

  it.each([
    { riskLevel: "high", modelClass: "general", effort: "high" },
    { riskLevel: "critical", modelClass: "general", effort: "high" },
    { riskLevel: "critical", modelClass: "lightweight", effort: "high" },
    { riskLevel: "critical", modelClass: "general", effort: "low" },
    // A host that reports no effort is observed with a null effort; root and child records both keep it (AGS3-D-0058).
    { riskLevel: "critical", modelClass: "general", effort: null },
  ] as const)("이름 등록 없는 opaque 관측을 같은 guarded workflow 단계에서 소비한다: $riskLevel/$modelClass/$effort (D0094)", ({ riskLevel, modelClass, effort }) => {
    let model = "";
    const adapter: HostExecutionAdapter = {
      host: "synthetic-authority-host", provider: "synthetic-authority", policyRevision: "d0094-authority-r1",
      modelClassForModel: observed => observed === model ? modelClass : null,
      resolveModel: (observed, provenance = "synthetic-authority-host:runtime") => observed === model ? {
        provider: "synthetic-authority", host: "synthetic-authority-host", rawModel: observed, resolvedModel: observed,
        modelClass, minimumReasoningEffort: null, supportedEfforts: ["low", "high"], aliasUsed: false,
        policyRevision: "d0094-authority-r1", provenance,
      } : null,
    };
    // 권위 어댑터는 두 새 ID 생성 전에 고정하며 이름 등록은 바꾸지 않는다.
    for (let ordinal = 0; ordinal < 2; ordinal++) {
      // 각 사례는 첫 단계 뒤 열린 루트를 남기므로 저장소를 격리해 범위 충돌을 막는다.
      const store = new InMemoryWorkflowStore();
      const provider = new HostAttestationProvider(adapter);
      const validator = new ContractValidator();
      const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, provider);
      model = `opaque-${randomUUID()}`;
      expect(resolveAdapterModelCapability(codexExecutionAdapter, model)).toBeNull();
      expect(resolveAdapterModelCapability(adapter, "unobserved-model")).toBeNull();
      const input = { schemaVersion: "1.0.0", taskEnvelope: createTask(`d0094-opaque-${riskLevel}-${modelClass}-${effort}-${ordinal}`, riskLevel) };
      input.taskEnvelope.artifactContracts = [{
        capability: "task-decomposition",
        produced: ["delegation-decision", "task-graph", "assignment-briefs", "integration-report"].map(artifactId => ({
          artifactId, schemaId: "host-attestation/v1", targetDigest: `sha256:${"e".repeat(64)}` as const,
        })),
      }];
      const caller = rootCaller(adapter.host, SESSION, {
        callId: `d0094-opaque-call-${ordinal}`,
        execution: { model, effort, turnId: "d0094-opaque-turn", provenance: "synthetic-authority-host:runtime" },
      });
      const foreignProvider = new HostAttestationProvider(codexExecutionAdapter);
      const foreignService = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, foreignProvider);
      expect(foreignProvider.run("plan_workflow", caller,
        () => foreignService.planWorkflow(input, true))).toMatchObject({ ok: false, error: { code: "BINDING_INVALID", details: { reasonCode: "HOST_ADAPTER_MISMATCH" } } });
      const planned = provider.run("plan_workflow", caller,
        () => service.planWorkflow(input, true));
      expect(planned.ok).toBe(true);
      expect(planned.data?.bootstrapExecution?.context).toMatchObject({ model, modelClass, reasoningEffort: effort });
      expect(resolveAdapterModelCapability(adapter, model, "synthetic-authority-host:runtime")).toMatchObject({ provider: "synthetic-authority", policyRevision: "d0094-authority-r1", rawModel: model });
      expect(provider.run("plan_workflow", caller,
        () => service.planWorkflow(input, true)).error?.code).toBe("BINDING_INVALID");

      // 같은 새 모델과 권위 어댑터를 단계 소비까지 유지한다. 전체 workflow 완주를 뜻하지 않는다.
      const plan = planned.data!;
      const frame: ConvergenceFrameV1 = {
        schemaVersion: "1.0.0",
        workspace: { workspaceId: input.taskEnvelope.taskId, locator: fileURLToPath(new URL("../../", import.meta.url)) },
        controlArtifacts: [{ artifactId: "acceptance", role: "pass-condition", locator: "fixture:acceptance", digest: `sha256:${"a".repeat(64)}` }],
        targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: "fixture:candidate", digest: `sha256:${"b".repeat(64)}` }],
        operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
      };
      const opened = service.openConvergenceRoot({ schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: input.taskEnvelope, frame, userApprovalRefs: [] });
      expect(opened.ok, JSON.stringify({ ordinal, result: opened })).toBe(true);
      const claimed = service.claimWorkflowAttempt({
        schemaVersion: "1.0.0", rootId: opened.data!.rootId, expectedRevision: opened.data!.revision,
        taskEnvelope: input.taskEnvelope, frame, plan,
        outputTargets: ["fixture.md"], priorFailure: null,
      }, true);
      expect(claimed.ok, JSON.stringify({ ordinal, result: claimed })).toBe(true);
      const started = service.startGuardedWorkflow({
        schemaVersion: "1.0.0", leaseId: claimed.data!.leaseId, expectedRootRevision: claimed.data!.rootRevision, plan,
        skills: [{ skillId: "minimal-implementation", reason: "test" }],
      }, true);
      expect(started.ok, JSON.stringify({ ordinal, result: started })).toBe(true);
      const receipt = started.data!;
      const stage = receipt.plan.stages[0]!;
      expect(stage.executionRequirement).toEqual({
        policyId: "semantic-execution-assurance-v1", kind: "semantic",
        minimumModelClass: "general", minimumReasoningEffort: "high", observationRequired: true,
      });
      const stageInput: StageResultV1 = {
        schemaVersion: "1.0.0", runId: receipt.runId, stageId: stage.stageId,
        expectedRevision: receipt.revision, state: "passed",
        output: {
          schemaVersion: "1.0.0", kind: "output", output: { completed: true },
          artifacts: stage.requiredArtifacts.map(artifactId => ({
            artifactId, schemaId: "host-attestation/v1", locator: "fixture:" + artifactId,
            digest: "d".repeat(64), targetDigest: "e".repeat(64), verified: true,
          })), error: null,
        },
        evidence: [{ artifactId: "opaque-stage", kind: "test", locator: "model-capability-contract.test.ts", verified: true, note: "같은 opaque 관측의 인메모리 단계 소비 회귀." }],
        findings: [], blockers: [], error: null,
      };
      // A child agent records first: its model or effort is recorded, never refused (AGS3-D-0058).
      const stageCaller = childCaller(adapter.host, SESSION, "d0094-agent", {
        callId: `d0094-opaque-stage-${ordinal}`,
        execution: { model, effort, turnId: "d0094-opaque-stage-turn", provenance: "synthetic-authority-host:runtime" },
      });
      // 다른 권위의 어댑터와 자격 없는 모델 관측은 같은 단계에서도 소비할 수 없다.
      expect(foreignProvider.run("record_stage_result", stageCaller,
        () => foreignService.recordStageResult(stageInput, true))).toMatchObject({ ok: false, error: { code: "BINDING_INVALID", details: { reasonCode: "HOST_ADAPTER_MISMATCH" } } });
      expect(service.getWorkflowStatus(receipt.runId).data?.stageResults).toEqual([]);
      const recorded = provider.run("record_stage_result", stageCaller,
        () => service.recordStageResult(stageInput, true, observedCaller(stageCaller)));
      expect(resolveAdapterModelCapability(adapter, model, "synthetic-authority-host:runtime")).toMatchObject({ provider: adapter.provider, policyRevision: adapter.policyRevision, rawModel: model });
      expect(recorded.ok, JSON.stringify(recorded)).toBe(true);
      expect(recorded.data?.stageResults[0]?.executionContext).toMatchObject({
        model, modelClass, reasoningEffort: effort, actorId: hostActorId(adapter.host, SESSION, "d0094-agent"),
        taskId: input.taskEnvelope.taskId, runId: receipt.runId, stageId: stage.stageId, revision: receipt.revision,
      });
    }
  });


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
      policyRevision: "2026-11-07.r03",
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
      policyRevision: "2026-11-07.r03",
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
      policyRevision: "2026-11-07.r03",
      provenance: "gemini:wrapper",
    });

    // F06 regression: bare subagent routing profile tokens ("opus", "sonnet", "haiku", "fable")
    // remain ineligible capabilities; raw observation does not grant runtime execution.
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

    // 2. Codex call observation and server qualification accept synthetic "gpt-6.5-nova-canonical" alias at "xhigh"
    //    while rejecting its observation at "high", below minimum_effort.
    const store = new InMemoryWorkflowStore();
    const validator = new ContractValidator();
    const provider = new HostAttestationProvider(syntheticSuite.adapters.get("codex")!);
    const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, provider);

    // Codex reports model and effort in tools/call _meta; the ingress hands them over as caller.execution.
    const lowArgs = { schemaVersion: "1.0.0", taskEnvelope: createTask("synthetic-codex-low", "high") };
    const lowCaller = rootCaller("codex", SESSION, {
      callId: "call-low",
      execution: { model: "gpt-6.5-nova-canonical", effort: "high", turnId: "turn-1", provenance: "codex:mcp-meta" },
    });
    const belowMinimum = provider.run("plan_workflow", lowCaller,
      () => service.planWorkflow(lowArgs, true));
    // 3.1.1: the catalog's effort rule is recorded, never refused.
    expect(belowMinimum.ok, JSON.stringify(belowMinimum)).toBe(true);
    expect(belowMinimum.data!.bootstrapExecution!.context).toMatchObject({ reasoningEffort: "high",
      policyNotes: ["CURRENT_POLICY_EFFORT_BELOW_MINIMUM"] });

    const validCaller = rootCaller("codex", SESSION, {
      callId: "call-valid",
      execution: { model: "gpt-6.5-nova-canonical", effort: "xhigh", turnId: "turn-2", provenance: "codex:mcp-meta" },
    });
    const validArgs = { schemaVersion: "1.0.0", taskEnvelope: createTask("synthetic-codex-task", "high") };
    const planned = provider.run("plan_workflow", validCaller, () => service.planWorkflow(validArgs, true));
    expect(planned.ok).toBe(true);
    expect(planned.data?.bootstrapExecution?.context).toMatchObject({
      model: "gpt-6.5-nova-canonical",
      modelClass: "frontier",
      reasoningEffort: "xhigh",
    });
    expect(resolveAdapterModelCapability(syntheticSuite.adapters.get("codex")!, "gpt-6.5-nova-canonical", "codex:mcp-meta")).toEqual({
      provider: "openai-codex",
      host: "codex",
      rawModel: "gpt-6.5-nova-canonical",
      resolvedModel: "gpt-6.5-nova",
      modelClass: "frontier",
      minimumReasoningEffort: "xhigh",
      supportedEfforts: ["high", "xhigh", "max", "ultra"],
      aliasUsed: true,
      policyRevision: "synthetic-2026-10-24.v2",
      provenance: "codex:mcp-meta",
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
    const claudeInput = { schemaVersion: "1.0.0", taskEnvelope: createTask("synthetic-claude-task", "high") };
    const claudeExecution = observeClaudeExecution(
      {
        hook_event_name: "PreToolUse",
        session_id: SESSION,
        transcript_path: TRANSCRIPT,
        tool_name: `${TOOL_PREFIX}plan_workflow`,
        tool_use_id: "toolu_mythos",
        tool_input: claudeInput,
        effort: { level: "xhigh" },
      },
      {
        readText: () => claudeLine,
        sleep: () => {},
      },
    );
    expect(claudeExecution).toEqual({
      model: "us.anthropic.claude-mythos-preview-v1:0", effort: "xhigh", turnId: null, provenance: "claude-code:transcript-tool-use",
    });
    const claudeProvider = new HostAttestationProvider(syntheticSuite.adapters.get("claude-code")!);
    const claudeService = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, claudeProvider);
    const claudeCaller = rootCaller("claude-code", SESSION, { callId: "toolu_mythos", execution: claudeExecution });
    const claudePlanned = claudeProvider.run("plan_workflow", claudeCaller, () => claudeService.planWorkflow(claudeInput, true));
    expect(claudePlanned.ok).toBe(true);
    expect(resolveAdapterModelCapability(syntheticSuite.adapters.get("claude-code")!, "us.anthropic.claude-mythos-preview-v1:0", "claude-code:transcript-tool-use")).toMatchObject({
      provider: "anthropic-claude-code",
      rawModel: "us.anthropic.claude-mythos-preview-v1:0",
      resolvedModel: "mythos",
      modelClass: "frontier",
      aliasUsed: true,
      policyRevision: "synthetic-2026-10-24.v2",
      provenance: "claude-code:transcript-tool-use",
    });

    // 4. Gemini wrapper attestation resolves synthetic "gemini-4.0-argon_pro" -> "argon" ("deep").
    const geminiProvider = new HostAttestationProvider(syntheticSuite.adapters.get("gemini")!);
    const geminiService = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, geminiProvider);
    const geminiInput = { schemaVersion: "1.0.0", taskEnvelope: createTask("synthetic-gemini-task", "high") };
    const geminiPlanned = geminiProvider.run(
      "plan_workflow",
      rootCaller("gemini", SESSION, {
        callId: "gemini-call-1",
        execution: { model: "models/gemini-4.0-argon_pro", effort: "high", turnId: "gemini-turn-1", provenance: "gemini:wrapper-runtime" },
      }),
      () => geminiService.planWorkflow(geminiInput, true),
    );
    expect(geminiPlanned.ok).toBe(true);
    expect(resolveAdapterModelCapability(syntheticSuite.adapters.get("gemini")!, "models/gemini-4.0-argon_pro", "gemini:wrapper-runtime")).toMatchObject({
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
    // The routing script renders its errors in the host locale (package default ko); these assertions pin English.
    vi.stubEnv("AGENT_GOVERNANCE_LOCALE", "en");
    onTestFinished(() => { vi.unstubAllEnvs(); });
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
    const narrowedArgs = { schemaVersion: "1.0.0", taskEnvelope: createTask("narrowed-effort-task", "high") };
    const narrowedCaller = rootCaller("codex", SESSION, {
      callId: "call-narrow-1",
      execution: { model: "gpt-6.5-nova", effort: "ultra", turnId: "turn-narrow", provenance: "codex:mcp-meta" },
    });
    const narrowedProvider = new HostAttestationProvider(narrowedSuite.adapters.get("codex")!);
    const narrowedValidator = new ContractValidator();
    const narrowedService = new WorkflowService(new FileSkillRegistry(registryPath, narrowedValidator), narrowedValidator, store, null, narrowedProvider);
    const unsupported = narrowedProvider.run("plan_workflow", narrowedCaller,
      () => narrowedService.planWorkflow(narrowedArgs, true));
    expect(unsupported.ok, JSON.stringify(unsupported)).toBe(true);
    expect(unsupported.data!.bootstrapExecution!.context).toMatchObject({ reasoningEffort: "ultra",
      policyNotes: ["CURRENT_POLICY_EFFORT_UNSUPPORTED"] });
  });

  it("preserves below-minimum rejection, replay, missing-observation handling, and assurance floors (AC4)", () => {
    const store = new InMemoryWorkflowStore();
    const validator = new ContractValidator();
    const defaultProvider = new HostAttestationProvider(codexExecutionAdapter);

    const planArgs = { schemaVersion: "1.0.0", taskEnvelope: createTask("revision-mismatch-task", "high") };
    const codexCaller = (callId: string, model: string, effort: string, turnId: string) => rootCaller("codex", SESSION, {
      callId, execution: { model, effort, turnId, provenance: "codex:mcp-meta" },
    });
    const defaultPolicyCaller = codexCaller("call-rev-1", "gpt-6-astra", "high", "turn-rev");
    const defaultService = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, defaultProvider);

    // Raw Luna/medium is observed; the catalog's below-minimum effort is a note (3.1.1), not a refusal.
    const belowModelFloor = defaultProvider.run("plan_workflow", codexCaller("call-luna-1", "gpt-5.6-luna", "medium", "turn-luna"),
      () => defaultService.planWorkflow(planArgs, true));
    expect(belowModelFloor.ok, JSON.stringify(belowModelFloor)).toBe(true);
    expect(belowModelFloor.data!.bootstrapExecution!.context).toMatchObject({ model: "gpt-5.6-luna", reasoningEffort: "medium",
      policyNotes: ["CURRENT_POLICY_EFFORT_BELOW_MINIMUM"] });

    // 유효한 lightweight 관측도 접수할 수 있으며 실제 단계 자격은 별도로 검사한다.
    const belowBootstrapFloor = defaultProvider.run(
      "plan_workflow",
      codexCaller("call-luna-high-1", "gpt-5.6-luna", "high", "turn-luna-high"),
      () => defaultService.planWorkflow(planArgs, true),
    );
    expect(belowBootstrapFloor.ok).toBe(true);
    expect(belowBootstrapFloor.data?.bootstrapExecution?.context.modelClass).toBe("lightweight");

    // Under defaultProvider, one host call observation works once and fails closed on replay.
    const first = defaultProvider.run(
      "plan_workflow",
      defaultPolicyCaller,
      () => defaultService.planWorkflow(planArgs, true),
    );
    expect(first.ok).toBe(true);
    expect(resolveAdapterModelCapability(codexExecutionAdapter, "gpt-6-astra")?.resolvedModel).toBe("gpt-6-astra");

    const replay = defaultProvider.run(
      "plan_workflow",
      defaultPolicyCaller,
      () => defaultService.planWorkflow(planArgs, true),
    );
    expect(replay.error?.code).toBe("BINDING_INVALID");

    // A missing host observation on a subsequent call never reuses the previous public execution result.
    const missingObservationCall = defaultProvider.run(
      "plan_workflow",
      rootCaller("codex", SESSION, { callId: "call-missing-1" }),
      () => defaultService.planWorkflow(planArgs, true),
    );
    expect(missingObservationCall.error?.code).toBe("BINDING_REQUIRED");
    expect(missingObservationCall.data?.bootstrapExecution).toBeUndefined();
  });

  // 3.9.0 (AGS3-D-0058): class and effort only order recommendations. A reclassified or lightweight model the host
  // supports stays selectable; the catalog change shows in the reported class, not in a refusal.
  it("reports a policy reclassification in the model class without refusing the selection (AC3, AC4, AGS3-D-0058)", () => {
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
    for (const selected of [resolveModelSelection(options, downgraded), resolveModelSelection({
      ...options, supported: [{ ...options.supported[0]!, modelClass: "lightweight" }],
    }, syntheticCatalogV2)]) {
      expect(selected).toMatchObject({ delivery: "explicit", selection: { model: "gpt-6.5-nova", effort: "xhigh" }, fallbackReason: null });
    }
  });

  it("records a below-recommendation stage observation and keeps the signed plan values (AC4, AC5, AGS3-D-0058)", () => {
    const store = new InMemoryWorkflowStore();
    const validator = new ContractValidator();
    const provider = new HostAttestationProvider(codexExecutionAdapter);
    const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, provider);
    const taskEnvelope = createTask("capability-stage-floor", "high");
    taskEnvelope.artifactContracts = [{
      capability: "task-decomposition",
      produced: ["delegation-decision", "task-graph", "assignment-briefs", "integration-report"].map((artifactId) => ({
        artifactId, schemaId: "host-attestation/v1", targetDigest: `sha256:${"e".repeat(64)}` as const,
      })),
    }];
    const planArgs = { schemaVersion: "1.0.0", taskEnvelope };
    const bootstrapCaller = rootCaller("codex", SESSION, {
      callId: "stage-bootstrap-call",
      execution: { model: "gpt-6.1-sol", effort: "low", turnId: "stage-bootstrap", provenance: "codex:mcp-meta" },
    });
    const planned = provider.run("plan_workflow", bootstrapCaller,
      () => service.planWorkflow(planArgs, true));
    expect(planned.ok).toBe(true);
    expect(planned.data?.bootstrapExecution?.context.reasoningEffort).toBe("low");
    const plan = planned.data!;
    // 관측 전용 쌍은 유효하지만 서명된 명시 단계 하한을 caller가 지울 수는 없다.
    const halfFloor = structuredClone(plan);
    halfFloor.bootstrapExecution!.requirement.minimumReasoningEffort = "low";
    expect(() => validator.workflowPlan(halfFloor)).toThrow();
    const halfStageFloor = structuredClone(plan);
    halfStageFloor.stages[0]!.executionRequirement!.minimumReasoningEffort = null;
    expect(() => validator.workflowPlan(halfStageFloor)).toThrow();
    const missingStageFloor = structuredClone(plan);
    missingStageFloor.stages[0]!.executionRequirement!.minimumModelClass = null;
    missingStageFloor.stages[0]!.executionRequirement!.minimumReasoningEffort = null;
    expect(() => validator.workflowPlan(missingStageFloor)).not.toThrow();
    expect(service.startWorkflow(missingStageFloor).error?.code).toBe("INVALID_INPUT");
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
      taskEnvelope, frame, plan,
      outputTargets: ["fixture.md"], priorFailure: null,
    }, true);
    expect(claimed.ok).toBe(true);
    const lease = claimed.data!;
    const started = service.startGuardedWorkflow({
      schemaVersion: "1.0.0", leaseId: lease.leaseId, expectedRootRevision: lease.rootRevision, plan,
      skills: [{ skillId: "minimal-implementation", reason: "test" }],
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
    const lightCaller = rootCaller("codex", SESSION, {
      callId: "stage-low-class", execution: { model: "gpt-5.6-luna", effort: "high", turnId: "stage-turn", provenance: "codex:mcp-meta" },
    });
    const recorded = provider.run("record_stage_result", lightCaller,
      () => service.recordStageResult(stageArgs, true));
    expect(recorded.ok, JSON.stringify(recorded.error)).toBe(true);
    expect(recorded.data?.stageResults[0]?.executionContext).toMatchObject({ model: "gpt-5.6-luna", modelClass: "lightweight", reasoningEffort: "high" });
    expect(recorded.data?.plan.stages[0]?.executionRequirement).toMatchObject({ minimumModelClass: "general", minimumReasoningEffort: "high" });
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
      // AGS3-D-0058: a lightweight catalog model is selected or inherited as the host reports it.
      expect(resolveModelSelection(options, syntheticCatalogV2)).toMatchObject({ delivery: "explicit", selection: { model, effort: "high" } });
      expect(resolveModelSelection({
        ...options, inheritOnly: true, inherited: { model, effort: "high" },
      }, syntheticCatalogV2)).toMatchObject({ delivery: "inherited", selection: { model, effort: "high" } });
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
      // AGS3-D-0058: a model the catalog does not list stays selectable when the host supports it.
      expect(resolveModelSelection({
        provider, role: "independent-audit", highRisk: true,
        user: { model, effort: "high" },
        inherited: { model, effort: "high" },
        supported: [{ model, modelClass: "frontier", efforts: ["high"] }],
      }, syntheticCatalogV2)).toMatchObject({ delivery: "explicit", selection: { model, effort: "high" } });
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

  it("qualifies with the current descriptor-only revision and fails a legacy class-only adapter closed (AC4, AC5, D0089)", () => {
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
    const provider = new HostAttestationProvider(adapter);
    const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, provider);
    const args = { schemaVersion: "1.0.0", taskEnvelope: createTask("descriptor-revision", "high") };
    const execution = { model: "gpt-6-astra", effort: "high", turnId: "descriptor-turn", provenance: "codex:mcp-meta" };
    // The current descriptor revision at observation time is the one that qualifies the call.
    revision = "descriptor-r2";
    const fresh = provider.run("plan_workflow", rootCaller("codex", SESSION, { callId: "descriptor-call", execution }),
      () => service.planWorkflow(args, true));
    expect(fresh.ok).toBe(true);
    expect(resolveAdapterModelCapability(adapter, execution.model, execution.provenance)?.policyRevision).toBe("descriptor-r2");

    // @ts-expect-error Legacy/custom adapter without resolveModel must declare provider at compile time.
    const providerlessLegacy: HostExecutionAdapter = {
      host: "codex", modelClassForModel: (model) => codexExecutionAdapter.modelClassForModel(model),
    };
    expect(resolveAdapterModelCapability(providerlessLegacy, "gpt-6-astra")).toBeNull();

    const legacy: HostExecutionAdapter = {
      host: "codex", provider: "openai-codex", modelClassForModel: (model) => codexExecutionAdapter.modelClassForModel(model),
    };
    // D0089: a class answer is no capability; nothing (efforts, revision "1.0.0") is synthesized from it.
    expect(resolveAdapterModelCapability(legacy, "gpt-6-astra")).toBeNull();
    const legacyProvider = new HostAttestationProvider(legacy);
    const legacyService = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, legacyProvider);
    const legacyArgs = { schemaVersion: "1.0.0", taskEnvelope: createTask("legacy-revision-control", "high") };
    const legacyResult = legacyProvider.run("plan_workflow", rootCaller("codex", SESSION, { callId: "legacy-control-call", execution }),
      () => legacyService.planWorkflow(legacyArgs, true));
    // The legacy class answer still grants no class; the model runs unclassified (3.1.1).
    expect(legacyResult.ok, JSON.stringify(legacyResult)).toBe(true);
    expect(legacyResult.data!.bootstrapExecution!.context).toMatchObject({ modelClass: null, policyNotes: ["MISSING_MODEL_CAPABILITY"] });
    expect(legacyProvider.observe({ phase: "bootstrap", taskId: "after-call", runId: null, stageId: null, revision: null })).toBeNull();
  });
});
