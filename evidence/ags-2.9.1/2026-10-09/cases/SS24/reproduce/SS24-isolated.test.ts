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
function barrier() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
interface Advice { result: ClassificationResult; classificationResponseRef: string; agentSelectedSkillIds: string[] | null; selectionStatus: string; adviceApplied: boolean }
interface Accepted { valid: boolean; errors: string[]; decision?: SkillSelectionDecisionV1; agentSelectedSkillIds?: string[] | null; neededSkillIds?: string[]; runnableSkillIds?: string[]; admissionStatus?: string; readStatus?: string; appliedStatus?: string; verifiedStatus?: string }
function decision(advice: Advice, selected: string[] | null, request = input()): SkillSelectionDecisionV1 {
  const snapshot = advice.result.snapshot;
  return { schemaVersion: "1.0.0", classificationResponseRef: advice.classificationResponseRef, requestDigest: snapshot.requestDigest,
    inventoryDigest: snapshot.inventoryDigest, taskRevision: snapshot.taskRevision, configRevision: snapshot.configRevision, profileRevision: snapshot.profileRevision,
    explicitSkillIds: request.explicitSkillIds, ruleRequiredSkillIds: request.ruleRequiredSkillIds, agentSelectedSkillIds: selected,
    selectionReasons: (selected ?? []).map(skillId => ({ skillId, reason: "synthetic AGENT reviewed the request independently of advice" })),
    applicabilityChecks: (selected ?? []).map(skillId => ({ skillId, applies: true, excluded: false, reasonRefs: ["fixture:purpose"] })),
    unresolvedSkillReferences: [], selectionStatus: selected === null ? "NEEDS_INPUT" : "SELECTED", adviceApplied: selected !== null, hostReceipt: null };
}

async function harness(options: { root?: string; needed?: string[]; uncertain?: string[]; mode?: "shadow" | "select"; attest?: boolean; taskObserved?: boolean; withJev?: boolean } = {}) {
  const root = options.root ?? repository;
  const inventory = await loadSkillInventory({ root });
  expect(inventory.issues).toEqual([]);
  const profile: ProviderProfile = { profileId: "vendor-mock", providerKind: "vendor", vendorId: "mock-vendor", modelId: "mock-fixed", modelRevision: "mock-fixed-v1", reasoningEffort: "low",
    supportedOptions: { reasoningEfforts: ["low"], structuredOutput: true }, approvedRouteRef: "fixture:approved-native-route", qualificationRevision: "mock-quality-only",
    qualification: { status: "PASS", inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision, modelRevision: "mock-fixed-v1", promptRevision: "prompt-1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: `sha256:${"0".repeat(64)}` },
    adapterRevision: "adapter-1", promptRevision: "prompt-1", maximumInputBytes: 2_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: null };
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
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, actualCostUsd: 0.1 }, dispatchState: "started", diagnostics: null }));
  const availability = vi.fn(async () => ({ available: true, approved: true, routeKind: "native" as const, reasonCode: null }));
  const jevAvailability = vi.fn(async () => ({ available: true, approved: true, routeKind: "native" as const, reasonCode: null }));
  const jevClassify = vi.fn(classify.getMockImplementation()!);
  const service = new SkillClassificationService({ providers: { vendor: { availability, classify }, ...(options.withJev ? { jev: { availability: jevAvailability, classify: jevClassify } } : {}) },
    budget: new InMemoryClassificationBudget({ jev: { limitUsd: 5, spentUsd: 0 }, vendors: {"mock-vendor": {limitUsd: 2, spentUsd: 0}}, nativeAllowances: {
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


// SS24 only. All host signatures, providers and selected IDs below are synthetic test inputs.
// No actual AGENT selection/read/apply/verify evidence is issued by this test.
import { writeFileSync } from "node:fs";
function evidence(id: string, value: unknown) {
  writeFileSync(`SS24-evidence/${id}.observed.json`, JSON.stringify(value, null, 2) + "\n");
}
function selectArgs(advice: Advice, request: ReturnType<typeof input>) {
  return {schemaVersion: "1.0.0", operationId: request.operationId, decision: decision(advice, ["code-review"], request)};
}
describe("SS24 isolated embedded-spec variants", () => {
  it.each(["on-to-off", "profile-ref-change", "profile-revision-change"])("SS24 %s delayed old reply and next request", async variant => {
    const h = await harness({withJev: true}), entered = barrier(), release = barrier();
    const original = h.jevClassify.getMockImplementation()!;
    h.jevClassify.mockImplementationOnce(async (...args) => {entered.open(); await release.promise; return original(...args);});
    const oldRequest = input(`SS24-${variant}-old`), nextRequest = input(`SS24-${variant}-next`);
    const pending = h.call<Advice>("classify_skills", oldRequest, true);
    await entered.promise;
    const oldRuntime = structuredClone(h.runtime);
    if (variant === "on-to-off") {h.runtime.config.jevEnabled = false; h.runtime.config.configRevision = "config-2";}
    if (variant === "profile-ref-change") h.runtime.config.providerProfileRegistryRef = "fixture:new-profiles";
    if (variant !== "on-to-off") {
      if (variant === "profile-revision-change") h.runtime.registry.profileRevision = "profile-2";
      for (const p of h.runtime.registry.profiles) {
        p.modelId = "mock-updated"; p.modelRevision = "mock-updated-v2";
        p.maximumCostUsd = 0.3; p.qualification.modelRevision = p.modelRevision;
        requalifyMockProfile(p, "SS24-mock-updated");
      }
    }
    const next = (await h.call<Advice>("classify_skills", nextRequest)).data!;
    const newerAccepted = (await h.call<Accepted>("record_skill_selection", h.sign(selectArgs(next, nextRequest)))).data!;
    const saved = JSON.stringify(next);
    release.open(); const old = (await pending).data!;
    const oldAccepted = (await h.call<Accepted>("record_skill_selection", h.sign(selectArgs(old, oldRequest)))).data!;
    const reusedNext = (await h.call<Advice>("classify_skills", nextRequest)).data!;
    evidence(variant, {kind:"new-offline-mock", originalPrompt:null, oracle:null, syntheticPrompt: oldRequest.originalPrompt, oldRuntime, currentRuntime:h.runtime,
      old, next, newerAccepted, oldAccepted, reusedNext, callCounts:{jev:h.jevClassify.mock.calls.length,vendor:h.classify.mock.calls.length},
      actualTransmitted:h.jevClassify.mock.calls.map(x=>({requestId:x[0].requestId,modelId:x[1].modelId,maximumCostUsd:x[1].maximumCostUsd})),
      realAgentStages:{selected:"NOTRUN",read:"NOTRUN",applied:"NOTRUN",verified:"NOTRUN"}});
    expect(old.result.response.error?.code).toBe("STALE_CLASSIFICATION");
    expect(old.result.attempts[0]!.usage.actualCostUsd).toBe(0.1);
    expect(old.result.request.requestId).toBe(oldRequest.requestId);
    expect(old.result.snapshot.configRevision).toBe("config-1");
    expect(old.result.profileRevision).toBe("profile-1");
    expect(old.agentSelectedSkillIds).toBeNull();
    expect(oldAccepted.valid).toBe(false); expect(oldAccepted.agentSelectedSkillIds).toBeNull();
    expect(newerAccepted.valid).toBe(true); expect(reusedNext.agentSelectedSkillIds).toEqual(["code-review"]);
    expect(JSON.stringify(next)).toBe(saved);
    expect(h.jevClassify.mock.calls.length).toBe(variant === "on-to-off" ? 1 : 2);
    expect(h.classify.mock.calls.length).toBe(variant === "on-to-off" ? 1 : 0);
    if (variant !== "on-to-off") expect(next.result.attempts[0]).toMatchObject({modelId:"mock-updated",reservedCostUsd:0.3});
    expect(next.result.snapshot.configRevision).toBe(h.runtime.config.configRevision);
  });
  it("SS24 before-selection-race OFF during asynchronous acceptance read", async () => {
    const h=await harness({withJev:true}), req=input("SS24-before-selection-race");
    const a=(await h.call<Advice>("classify_skills",req)).data!, entered=barrier(),release=barrier();
    const snapshot=structuredClone(h.runtime);
    h.readRuntime.mockImplementationOnce(async()=>{entered.open(); await release.promise; return snapshot;});
    const pending=h.call<Accepted>("record_skill_selection",h.sign(selectArgs(a,req)));
    await entered.promise; h.runtime.config.jevEnabled=false; h.runtime.config.configRevision="config-2"; release.open();
    const accepted=(await pending).data!;
    evidence("before-selection-race", {kind:"new-offline-mock",acceptanceRuntimeSnapshot:snapshot,currentRuntime:h.runtime,accepted,
      callCounts:{jev:h.jevClassify.mock.calls.length,vendor:h.classify.mock.calls.length}, realAgentStages:{selected:"NOTRUN",read:"NOTRUN",applied:"NOTRUN",verified:"NOTRUN"}});
    expect(accepted.valid).toBe(false); expect(accepted.errors).toContain("RUNTIME_SOURCE_CHANGED"); expect(accepted.agentSelectedSkillIds).toBeNull();
  });
  it("SS24 boundary cancellation during acceptance must stop old selection", async()=>{
    const h=await harness(), req=input("SS24-cancellation-race");
    const a=(await h.call<Advice>("classify_skills",req)).data!,entered=barrier(),release=barrier();
    h.readRuntime.mockImplementationOnce(async()=>{entered.open();await release.promise;return structuredClone(h.runtime);});
    const pending=h.call<Accepted>("record_skill_selection",h.sign(selectArgs(a,req)));
    await entered.promise; h.taskStates.get(req.requestId)!.cancelled=true; release.open();
    const accepted=(await pending).data!;
    evidence("boundary-cancellation-race",{kind:"new-offline-mock",expected:{valid:false,agentSelectedSkillIds:null},observed:accepted,currentTask:h.taskStates.get(req.requestId),
      linkedKnownDefect:"동시성 직전 재검사 공백",realAgentStages:{selected:"NOTRUN",read:"NOTRUN",applied:"NOTRUN",verified:"NOTRUN"}});
    expect(accepted.valid,"cancelled task during await must be rechecked before storing selection").toBe(false);
  });
});
