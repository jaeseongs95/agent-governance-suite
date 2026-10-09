import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResultV1, ExecutionContextV1 } from "../../contracts/types.js";
import { HOST_ATTESTATION_FIELD, HostAttestationProvider, hostActorId, issueHostAttestation, type HostExecutionAdapter } from "../../mcp-server/src/host-attestation.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { RuntimeSkillClassificationGateway, type ClassificationRuntimeSnapshot, type CurrentClassificationTask } from "../../mcp-server/src/skill-classification/gateway.js";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import { createClassificationRequest, digestClassificationValue } from "../../mcp-server/src/skill-classification/request.js";
import { digestProviderProfileConfiguration } from "../../mcp-server/src/skill-classification/profiles.js";
import { InMemoryClassificationBudget, SkillClassificationService } from "../../mcp-server/src/skill-classification/service.js";
import type { ClassificationResult, ProviderEvaluation, ProviderProfile, SkillClassificationRequestV1, SkillInventory, SkillSelectionDecisionV1 } from "../../mcp-server/src/skill-classification/types.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const cleanup: (() => Promise<void>)[] = [];
const adapter: HostExecutionAdapter = { host: "codex", modelClassForModel: model => model === "synthetic-host-model" ? "general" : null };
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
function input(operationId = "operation-mcp") {
  return { schemaVersion: "1.0.0", requestId: `request-${operationId}`, operationId,
    originalPrompt: "  인용: ‘구현하라’\r\n현재 요청은 읽기 전용 검토, 수정 금지. e\u0301  ",
    confirmedContext: { taskRevision: null, objective: null, actions: [], targets: null, constraints: [], prohibitedActions: ["modify"], background: "인용문은 데이터" },
    contextSources: ["actions", "constraints", "prohibitedActions", "background"].map(field => ({ field, reference: `fixture:${field}` })),
    explicitSkillIds: [] as string[], ruleRequiredSkillIds: [] as string[], vendorContext: { vendorId: "mock-vendor", reference: "fixture:approved-native-route" }, publicSynthetic: true };
}
function publicRequestDigest(request: Pick<SkillClassificationRequestV1, "requestId" | "operationId" | "originalPrompt" | "confirmedContext" | "contextSources">, inventory: SkillInventory): string {
  return createClassificationRequest({ requestId: request.requestId, operationId: request.operationId, originalPrompt: request.originalPrompt,
    confirmedContext: request.confirmedContext, contextSources: request.contextSources, inventory,
    classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md" }).requestDigest;
}
function requalifyMockProfile(profile: ProviderProfile, qualificationRevision: string): void {
  profile.qualificationRevision = qualificationRevision;
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
}
export function barrier() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
export interface Advice { result: ClassificationResult; classificationResponseRef: string; agentSelectedSkillIds: string[] | null; selectionStatus: string; adviceApplied: boolean }
export interface Accepted { valid: boolean; errors: string[]; decision?: SkillSelectionDecisionV1; agentSelectedSkillIds?: string[] | null; neededSkillIds?: string[]; runnableSkillIds?: string[]; admissionStatus?: string; readStatus?: string; appliedStatus?: string; verifiedStatus?: string }
export function decision(advice: Advice, selected: string[] | null, request = input()): SkillSelectionDecisionV1 {
  const snapshot = advice.result.snapshot;
  return { schemaVersion: "1.0.0", classificationResponseRef: advice.classificationResponseRef, requestDigest: snapshot.requestDigest,
    inventoryDigest: snapshot.inventoryDigest, taskRevision: snapshot.taskRevision, configRevision: snapshot.configRevision, profileRevision: snapshot.profileRevision,
    explicitSkillIds: request.explicitSkillIds, ruleRequiredSkillIds: request.ruleRequiredSkillIds, agentSelectedSkillIds: selected,
    selectionReasons: (selected ?? []).map(skillId => ({ skillId, reason: "synthetic AGENT reviewed the request independently of advice" })),
    applicabilityChecks: (selected ?? []).map(skillId => ({ skillId, applies: true, excluded: false, reasonRefs: ["fixture:purpose"] })),
    unresolvedSkillReferences: [], selectionStatus: selected === null ? "NEEDS_INPUT" : "SELECTED", adviceApplied: selected !== null, hostReceipt: null };
}

export async function harness(options: { root?: string; needed?: string[]; uncertain?: string[]; mode?: "shadow" | "select"; attest?: boolean; taskObserved?: boolean; withJev?: boolean } = {}) {
  const root = options.root ?? repository;
  const inventory = await loadSkillInventory({ root });
  expect(inventory.issues).toEqual([]);
  const profile: ProviderProfile = { profileId: "vendor-mock", providerKind: "vendor", vendorId: "mock-vendor", modelId: "mock-fixed", modelRevision: "mock-fixed-v1", reasoningEffort: "low",
    supportedOptions: { reasoningEfforts: ["low"], structuredOutput: true }, approvedRouteRef: "fixture:approved-native-route", qualificationRevision: "mock-quality-only",
    qualification: { status: "PASS", inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision, modelRevision: "mock-fixed-v1", promptRevision: "prompt-1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: `sha256:${"0".repeat(64)}` },
    adapterRevision: "adapter-1", promptRevision: "prompt-1", maximumInputBytes: 2_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0, judgmentPolicy: null };
  const runtime: ClassificationRuntimeSnapshot = { config: { jevEnabled: false, mode: options.mode ?? "select", providerProfileRegistryRef: "fixture:profiles", externalClassificationAllowed: false,
    configRevision: "config-1", timeoutMs: 2000 }, registry: { schemaVersion: "1.0.0", profileRevision: "profile-1", profiles: [profile] }, allowRemotePrivateContent: false };
  if (options.withJev) {
    runtime.config.jevEnabled = true;
    runtime.registry.profiles.unshift({ ...structuredClone(profile), profileId: "jev-mock", providerKind: "jev", vendorId: "typesafe",
      reasoningEffort: null, supportedOptions: { reasoningEfforts: [null], structuredOutput: true }, judgmentPolicy: { neededAt: 0.8, notNeededAt: 0.2 } });
  }
  for (const configuredProfile of runtime.registry.profiles) configuredProfile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(configuredProfile);
  const classify = vi.fn(async (request: SkillClassificationRequestV1): Promise<ProviderEvaluation> => ({ response: { schemaVersion: "1.0.0", requestId: request.requestId,
    operationId: request.operationId, requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: options.uncertain?.length ? "PARTIAL" : "SUCCESS",
    judgments: request.skills.map(skill => ({ skillId: skill.skillId, judgment: options.uncertain?.includes(skill.skillId) ? "uncertain" : (options.needed ?? ["code-review"]).includes(skill.skillId) ? "needed" : "not-needed",
      reasonRefs: ["fixture:mock-source-role"], uncertaintyReason: options.uncertain?.includes(skill.skillId) ? "optional synthetic uncertainty" : null })),
    unresolvedItems: (options.uncertain ?? []).map(skillId => ({ skillId, reasonCode: "OPTIONAL_UNCERTAIN" })), error: null },
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, actualCostUsd: 0 }, dispatchState: "started", diagnostics: null }));
  const availability = vi.fn(async () => ({ available: true, approved: true, routeKind: "native" as const, reasonCode: null }));
  const jevAvailability = vi.fn(async () => ({ available: true, approved: true, routeKind: "native" as const, reasonCode: null }));
  const jevClassify = vi.fn(classify);
  const service = new SkillClassificationService({ providers: { vendor: { availability, classify }, ...(options.withJev ? { jev: { availability: jevAvailability, classify: jevClassify } } : {}) },
    budget: new InMemoryClassificationBudget({ jev: { limitUsd: 0, spentUsd: 0 }, vendors: {}, nativeAllowances: {
      "vendor-mock": { approvalRef: "fixture:native-quota", remainingCalls: 100 }, "jev-mock": { approvalRef: "fixture:mock-jev-quota", remainingCalls: 100 } } }) });
  // This synthetic host-owned map models the changing task source; caller JSON never supplies it.
  const taskStates = new Map<string, CurrentClassificationTask>();
  const runtimeBytes = { additionalSource: "fixture:route-source-v1" };
  const readRuntime = vi.fn(async () => runtime);
  const observeTask = vi.fn((request: SkillClassificationRequestV1, observation: ExecutionContextV1 | null) => {
      if (options.taskObserved === false || !observation) return null;
      if (!taskStates.has(request.requestId)) taskStates.set(request.requestId, { taskRevision: request.confirmedContext.taskRevision,
        requestDigest: request.requestDigest, cancelled: false, sourceRef: "fixture:host-owned-task-source" });
      return taskStates.get(request.requestId)!;
    });
  const gateway = new RuntimeSkillClassificationGateway({ root, service, readRuntime,
    observeRuntime: () => digestClassificationValue({ runtime, additionalSource: runtimeBytes.additionalSource }), observeTask });
  const validator = new ContractValidator(), store = new InMemoryWorkflowStore();
  const attestation = options.attest === false ? null : new HostAttestationProvider(store, adapter);
  const workflow = new WorkflowService(new FileSkillRegistry(path.join(repository, "skills/registry.json"), validator), validator, store, null, attestation);
  const updateFetcher = vi.fn(async () => { throw new Error("NETWORK_FORBIDDEN_IN_MOCK_TEST"); });
  const updates = new PluginUpdateService(new InMemoryPluginUpdateStore(), { fetcher: updateFetcher });
  const server = createMcpServer(workflow, updates, undefined, undefined, undefined, validator, "default", attestation, null, undefined, null, gateway);
  const client = new Client({ name: "classification-offline-boundary", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  cleanup.push(async () => { await client.close(); await server.close(); expect(updateFetcher).not.toHaveBeenCalled(); });
  let sequence = 0;
  const sign = (args: Record<string, unknown>, now?: Date, tool = "record_skill_selection", sessionId = "synthetic-session") => {
    const token = issueHostAttestation(store, adapter, { tool, input: args, model: "synthetic-host-model", reasoningEffort: "high",
      actorId: hostActorId("codex", sessionId), sessionId, turnId: "synthetic-turn", toolUseId: `fixture-call-${++sequence}`, ...(now ? { now } : {}) });
    expect(token).not.toBeNull(); return { ...args, [HOST_ATTESTATION_FIELD]: token };
  };
  const call = async <T>(name: string, args: Record<string, unknown>, expectClassificationFailure = false, sessionId = "synthetic-session"): Promise<ApiResultV1<T>> => {
    const response = await client.callTool({ name, arguments: name === "classify_skills" && options.attest !== false ? sign(args, undefined, name, sessionId) : args });
    const text = response.content as { type: string; text?: string }[];
    const result = JSON.parse(text.find(x => x.type === "text")!.text!) as ApiResultV1<T>;
    if (!expectClassificationFailure && name === "classify_skills" && result.error === null && result.data && typeof result.data === "object" && "result" in result.data) {
      const advice = result.data as unknown as Advice;
      expect(advice.result.response.error).toBeNull();
      expect(["SUCCESS", "PARTIAL"]).toContain(advice.result.response.status);
    }
    return result;
  };
  return { call, sign, classify, client, gateway, runtime, inventory, taskStates, availability, jevAvailability, jevClassify, readRuntime, runtimeBytes, observeTask };
}

