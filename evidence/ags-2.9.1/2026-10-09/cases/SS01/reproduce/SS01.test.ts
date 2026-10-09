import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResultV1, ExecutionContextV1 } from "./repo/contracts/types.js";
import { HOST_ATTESTATION_FIELD, HostAttestationProvider, hostActorId, issueHostAttestation, type HostExecutionAdapter } from "./repo/mcp-server/src/host-attestation.js";
import { InMemoryPluginUpdateStore } from "./repo/mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "./repo/mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "./repo/mcp-server/src/registry.js";
import { ContractValidator } from "./repo/mcp-server/src/schema-validator.js";
import { createMcpServer } from "./repo/mcp-server/src/server.js";
import { WorkflowService } from "./repo/mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "./repo/mcp-server/src/workflow-store.js";
import { RuntimeSkillClassificationGateway, type ClassificationRuntimeSnapshot, type CurrentClassificationTask } from "./repo/mcp-server/src/skill-classification/gateway.js";
import { loadSkillInventory } from "./repo/mcp-server/src/skill-classification/inventory.js";
import { createClassificationRequest, digestClassificationValue } from "./repo/mcp-server/src/skill-classification/request.js";
import { digestProviderProfileConfiguration } from "./repo/mcp-server/src/skill-classification/profiles.js";
import { InMemoryClassificationBudget, SkillClassificationService } from "./repo/mcp-server/src/skill-classification/service.js";
import type { ClassificationResult, ProviderEvaluation, ProviderProfile, SkillClassificationRequestV1, SkillInventory, SkillSelectionDecisionV1 } from "./repo/mcp-server/src/skill-classification/types.js";

const repository = fileURLToPath(new URL("./repo/", import.meta.url));
const frozenCorpus = JSON.parse(await readFile(path.join(repository, "tests/skill-classification/fixtures.json"), "utf8"));
const frozen = frozenCorpus.cases.find((x: any) => x.caseId === "SS01");
const observed: any[] = [];
const capture = (id: string, input: unknown, expected: unknown, actual: unknown) => observed.push({caseId: "SS01", fixtureVariant: "base", testId: id, input, expected, observed: actual, executionKind: "offline-mock", actualHostSelection: false});
const cleanup: (() => Promise<void>)[] = [];
const adapter: HostExecutionAdapter = { host: "codex", modelClassForModel: model => model === "synthetic-host-model" ? "general" : null };
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
function input(operationId = "operation-mcp") {
  return { schemaVersion: "1.0.0", requestId: `request-${operationId}`, operationId,
    originalPrompt: frozen.originalPrompt,
    confirmedContext: { taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null },
    contextSources: [],
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
    judgments: request.skills.map(skill => ({ skillId: skill.skillId, judgment: options.uncertain?.includes(skill.skillId) ? "uncertain" : (options.needed ?? ["ponytail"]).includes(skill.skillId) ? "needed" : "not-needed",
      reasonRefs: ["fixture:mock-source-role"], uncertaintyReason: options.uncertain?.includes(skill.skillId) ? "optional synthetic uncertainty" : null })),
    unresolvedItems: (options.uncertain ?? []).map(skillId => ({ skillId, reasonCode: "OPTIONAL_UNCERTAIN" })), error: null },
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, actualCostUsd: 0 }, dispatchState: "started", diagnostics: null }));
  const availability = vi.fn(async () => ({ available: true, approved: true, routeKind: "native" as const, reasonCode: null }));
  const jevAvailability = vi.fn(async () => ({ available: true, approved: true, routeKind: "native" as const, reasonCode: null }));
  const jevClassify = vi.fn(async (request: SkillClassificationRequestV1) => classify.getMockImplementation()!(request));
  const budget = new InMemoryClassificationBudget({ jev: {limitUsd: 5, spentUsd: 0}, vendors: {"mock-vendor": {limitUsd: 2, spentUsd: 0}}, nativeAllowances: {"vendor-mock": {approvalRef: "offline-only", remainingCalls: 100}, "jev-mock": {approvalRef: "offline-only", remainingCalls: 100}} });
  const service = new SkillClassificationService({ providers: { vendor: { availability, classify }, ...(options.withJev ? { jev: { availability: jevAvailability, classify: jevClassify } } : {}) },
    budget });
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
  return { budget, service, call, sign, classify, client, gateway, runtime, inventory, taskStates, availability, jevAvailability, jevClassify, readRuntime, runtimeBytes, observeTask };
}


import { afterAll } from "vitest";
import { oracleDigest, scoreCase, canonicalSet, sameSet, fromSelection } from "./repo/tests/skill-classification/evaluation.js";
// All signing below is synthetic transport evidence. It does not establish real AGENT selection.
const rawObservation = (skills: string[] | null) => ({caseId: "SS01", layer: "vendorRaw" as const, state: "PASS" as const, skillIds: skills,
  selectionStatus: skills === null ? "NEEDS_INPUT" : "SELECTED", reasonCodes: [], selectionReasons: [], executionKind: "offline-mock" as const,
  host: null, hostReceipt: null, requestDigest: "offline", inventoryDigest: "offline", conditionDigest: "offline", stageEvidence: {read:false,applied:false,verified:false}});
afterAll(async () => {await writeFile("./artifacts/observations.json", JSON.stringify(observed,null,2)+"\n");});
const recommendation = (a: Advice) => a.result.response.judgments.filter(x=>x.judgment === "needed").map(x=>x.skillId);
describe("SS01 isolated base and new boundary controls", () => {
  it("SS01 frozen identity and source digests", async () => {
    expect(oracleDigest(frozenCorpus)).toBe("sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055");
    expect(frozen.variants).toEqual(["base"]);
    for (const s of frozen.oracle.sourceRefs) {
      const bytes=await readFile(path.join(repository,s.path));
      const {createHash}=await import("node:crypto");
      expect("sha256:"+createHash("sha256").update(bytes).digest("hex")).toBe(s.digest);
    }
    capture("frozen-identity", frozen, {variants:["base"],required:["ponytail"]}, {oracleDigest:oracleDigest(frozenCorpus),verifiedSourceRefs:frozen.oracle.sourceRefs});
  });
  it.each(["ON", "OFF", "invalid-key", "timeout"])("SS01 base %s exact original prompt and full inventory", async route => {
    const h=await harness({withJev:route!=="OFF"});
    if(route==="invalid-key") h.jevAvailability.mockResolvedValue({available:false,approved:true,routeKind:"native",reasonCode:"CREDENTIAL_UNAVAILABLE"});
    if(route==="timeout") {h.runtime.config.timeoutMs=10; h.jevClassify.mockImplementation(()=>new Promise(()=>{}));}
    const req=input("SS01-base-"+route); const advice=(await h.call<Advice>("classify_skills",req)).data!;
    const port=route==="ON"?h.jevClassify:h.classify;
    const wire=port.mock.calls[0]![0];
    capture("base-"+route,req,{needed:["ponytail"],selected:null,inventory:24,targets:null}, {advice,wire,jevAvailability:h.jevAvailability.mock.calls.length,jevCalls:h.jevClassify.mock.calls.length,vendorCalls:h.classify.mock.calls.length,budget:h.budget.snapshot()});
    expect(wire.originalPrompt).toBe(frozen.originalPrompt); expect(wire.confirmedContext.targets).toBeNull();
    expect(wire.skills.map(x=>x.skillId).sort()).toEqual([...frozenCorpus.inventorySkillIds].sort());
    expect(recommendation(advice)).toEqual(["ponytail"]); expect(advice.agentSelectedSkillIds).toBeNull();
    expect(advice.selectionStatus).toBe("PROPOSED"); expect(advice.adviceApplied).toBe(false);
    expect(scoreCase(frozen,rawObservation(recommendation(advice)),frozenCorpus.inventorySkillIds).verdict).toBe("PASS");
    if(route==="OFF") {expect(h.jevAvailability).not.toHaveBeenCalled();expect(h.jevClassify).not.toHaveBeenCalled();}
    if(route==="invalid-key") expect(h.jevClassify).not.toHaveBeenCalled();
    if(route==="timeout") {expect(advice.result.attempts[0].timedOut).toBe(true);expect(h.budget.snapshot().reservations).toHaveLength(1);}
    if(route!=="ON") expect(h.classify).toHaveBeenCalledTimes(1);
  });
  it("SS01 missing host observation preserves null selection", async()=>{
    const h=await harness({attest:false});const a=(await h.call<Advice>("classify_skills",input())).data!;
    const r=(await h.call<Accepted>("record_skill_selection",{schemaVersion:"1.0.0",operationId:input().operationId,decision:decision(a,["ponytail"])})).data!;
    capture("no-host",input(),{valid:false,selected:null},r);expect(r.valid).toBe(false);expect(r.agentSelectedSkillIds).toBeNull();
  });
  it("SS01 synthetic signed choice accepts P and does not claim later stages",async()=>{
    const h=await harness();const a=(await h.call<Advice>("classify_skills",input())).data!;
    const r=(await h.call<Accepted>("record_skill_selection",h.sign({schemaVersion:"1.0.0",operationId:input().operationId,decision:decision(a,["ponytail"])}))).data!;
    capture("synthetic-acceptance",input(),{valid:true,selected:["ponytail"],read:"NOT_OBSERVED",applied:"NOT_OBSERVED",verified:"NOT_RUN"},r);
    expect(r.valid).toBe(true);expect(r.decision!.agentSelectedSkillIds).toEqual(["ponytail"]);
    expect(r).toMatchObject({readStatus:"NOT_OBSERVED",appliedStatus:"NOT_OBSERVED",verifiedStatus:"NOT_RUN"});
  });
  it("SS01 caller receipt cannot establish selection",async()=>{
    const h=await harness();const a=(await h.call<Advice>("classify_skills",input())).data!;const d=decision(a,["ponytail"]);
    d.hostReceipt={receiptId:"caller-made",host:"codex",requestDigest:d.requestDigest,inventoryDigest:d.inventoryDigest,agentSelectedSkillIds:["ponytail"],acceptedAt:new Date().toISOString()};
    const r=await h.call<Accepted>("record_skill_selection",h.sign({schemaVersion:"1.0.0",operationId:input().operationId,decision:d}));
    capture("caller-receipt",d,{error:"INVALID_INPUT"},r);expect(r.error?.code).toBe("INVALID_INPUT");
  });
  it.each([null, [], ["ponytail","cs-engineering"], ["ponytail","code-review"], ["ponytail","software-security-auditor"], ["ponytail","orchestrator"], ["ponytail","test-engineering"], ["P"]])("SS01 rejects oracle-incompatible output %j", skills=>{
    const r=scoreCase(frozen,rawObservation(skills),frozenCorpus.inventorySkillIds);capture("oracle-negative-"+JSON.stringify(skills),skills,{verdict:"FAIL"},r);expect(r.verdict).toBe("FAIL");
  });
  it("SS01 keeps null and [] distinct and advice never creates a host receipt",async()=>{
    const h=await harness();const a=(await h.call<Advice>("classify_skills",input())).data!;
    const d=decision(a,null);const r=fromSelection("SS01",d,rawObservation(["ponytail"]));
    capture("null-empty",d,{selected:null,hostReceipt:null},r);expect(canonicalSet(null)).toBeNull();expect(sameSet(null,[])).toBe(false);expect(r.skillIds).toBeNull();expect(r.hostReceipt).toBeNull();
  });
  it("SS01 AGENT correction remains independent of incorrect raw advice",async()=>{
    const h=await harness({needed:["code-review"]});const a=(await h.call<Advice>("classify_skills",input())).data!;
    const rawScore=scoreCase(frozen,rawObservation(recommendation(a)),frozenCorpus.inventorySkillIds);
    const r=(await h.call<Accepted>("record_skill_selection",h.sign({schemaVersion:"1.0.0",operationId:input().operationId,decision:decision(a,["ponytail"])}))).data!;
    capture("raw-agent-separation",input(),{raw:"FAIL",syntheticAccepted:["ponytail"]},{rawScore,accepted:r});expect(rawScore.verdict).toBe("FAIL");expect(r.decision!.agentSelectedSkillIds).toEqual(["ponytail"]);
  });
  it("SS01 known defect invalid RESP must preserve independently valid cost",async()=>{
    const h=await harness({withJev:true});const p=h.runtime.registry.profiles[0];p.maximumCostUsd=.4;requalifyMockProfile(p,"ss01-invalid-resp-cost");
    const good=h.jevClassify.getMockImplementation()!;
    h.jevClassify.mockImplementation(async req=>{const e=await good(req);return {...e,response:{...e.response,judgments:[]},usage:{...e.usage,actualCostUsd:.1}};});
    const a=(await h.call<Advice>("classify_skills",input())).data!;
    capture("known-invalid-resp-cost",{prompt:frozen.originalPrompt,judgments:[],validActualCostUsd:.1},{attemptCost:.1,spentUsd:.1},{attempt:a.result.attempts[0],budget:h.budget.snapshot(),fallback:recommendation(a)});
    expect(a.result.attempts[0].errorCode).toBe("INVALID_PROVIDER_RESPONSE");expect(recommendation(a)).toEqual(["ponytail"]);
    expect(a.result.attempts[0].usage.actualCostUsd,"valid observed cost lost with invalid RESP").toBe(.1);expect(h.budget.snapshot().limits.jev.spentUsd).toBe(.1);
  });
  it("SS01 known defect must recheck cancellation after async acceptance read",async()=>{
    const h=await harness();const req=input();const a=(await h.call<Advice>("classify_skills",req)).data!;
    h.readRuntime.mockImplementation(async()=>{h.taskStates.get(req.requestId)!.cancelled=true;return h.runtime;});
    const r=(await h.call<Accepted>("record_skill_selection",h.sign({schemaVersion:"1.0.0",operationId:req.operationId,decision:decision(a,["ponytail"])}))).data!;
    capture("known-acceptance-race",{prompt:frozen.originalPrompt,cancellation:"during readRuntime"},{valid:false,selected:null},{accepted:r,currentTask:h.taskStates.get(req.requestId)});
    expect(r.valid,"cancelled during asynchronous acceptance read").toBe(false);
  });
  it("SS01 known defect timer overflow must not become a 1ms timeout",async()=>{
    const h=await harness({withJev:true});h.runtime.config.timeoutMs=2147483648;
    const good=h.jevClassify.getMockImplementation()!;
    h.jevClassify.mockImplementation(async req=>{await new Promise(resolve=>setTimeout(resolve,20));return good(req);});
    const a=(await h.call<Advice>("classify_skills",input())).data!;
    capture("known-timeout-overflow",{prompt:frozen.originalPrompt,timeoutMs:2147483648,providerDelayMs:20},{jevTimedOut:false},{attempts:a.result.attempts,budget:h.budget.snapshot()});
    expect(a.result.attempts[0].timedOut,"24 day timeout overflowed to 1ms").toBe(false);
  });
  it("SS01 unconfigured actual local runtime does not imply a provider or host selection",async()=>{
    const {readClassificationRuntime}=await import("./repo/mcp-server/src/skill-classification/gateway.js");
    const runtime=await readClassificationRuntime(undefined,repository);const inventory=await loadSkillInventory({root:repository});
    const request=createClassificationRequest({requestId:"SS01-unconfigured",operationId:"SS01-unconfigured",originalPrompt:frozen.originalPrompt,inventory,classificationCriteriaRef:"skills/orchestrator/references/skill-classification.md"});
    const service=new SkillClassificationService({providers:{},budget:new InMemoryClassificationBudget({jev:{limitUsd:null,spentUsd:null},vendors:{}})});
    const r=await service.classify({request,config:runtime.config,registry:runtime.registry,currentVendorId:"codex"});
    capture("actual-local-unconfigured",{prompt:frozen.originalPrompt,configEnvPresent:false},{status:"UNAVAILABLE",attempts:[]},r);
    expect(r.response.status).toBe("UNAVAILABLE");expect(r.response.error?.code).toBe("PROFILE_UNAVAILABLE");expect(r.attempts).toEqual([]);
  });
  it("SS01 host support discovery has no gateway supplier",async()=>{
    const explicit=await loadSkillInventory({root:repository,installedSkillIds:[],hostSupportedSkillIds:[]});const h=await harness();const implicit=await h.gateway.inventory() as SkillInventory;
    capture("host-support-supply-gap",{explicitHostInstalled:[],explicitHostSupported:[]},{explicitP:{installed:false,hostSupported:false},gatewaySupplier:"NOT_AVAILABLE"},{explicitP:explicit.skills.find(x=>x.skillId==="ponytail"),gatewayP:implicit.skills.find(x=>x.skillId==="ponytail"),source:"gateway.ts:22,48,61,124"});
    expect(explicit.skills.find(x=>x.skillId==="ponytail")).toMatchObject({installed:false,hostSupported:false});expect(implicit.skills.find(x=>x.skillId==="ponytail")).toMatchObject({installed:true,hostSupported:true});
  });

});
