import {fileURLToPath} from "node:url";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {describe, expect, it, vi} from "vitest";
import type {ExecutionContextV1} from "../../contracts/types.js";
import {RuntimeSkillClassificationGateway, type ClassificationRuntimeSnapshot, type CurrentClassificationTask} from "../../mcp-server/src/skill-classification/gateway.js";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {digestClassificationValue} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import {InMemoryClassificationBudget, SkillClassificationService} from "../../mcp-server/src/skill-classification/service.js";
import type {ClassificationResult, ProviderEvaluation, ProviderProfile, SkillClassificationRequestV1, SkillInventory, SkillSelectionDecisionV1} from "../../mcp-server/src/skill-classification/types.js";

// Real gateway/service/files; synthetic host-owned observations and provider only.
// Actual AGENT choice, native host turns, API/model quality and application remain NOT_RUN.
const root = fileURLToPath(new URL("../../", import.meta.url));
interface HostSnapshot {
  schemaVersion: "1.0.0"; sourceRef: string; revision: string; observedAt: string; expiresAt: string;
  skills: {skillId: string; enabled: boolean; installed: boolean; hostSupported: boolean; root: string | null}[];
}
interface HostInventory extends SkillInventory {
  discovery: {status: "COMPLETE" | "INCOMPLETE" | "UNAVAILABLE"; scope: "host" | "local-tree"; sourceRef: string | null; revision: string | null};
}
interface Advice {result: ClassificationResult; classificationResponseRef: string; agentSelectedSkillIds: string[] | null}
interface Accepted {valid: boolean; errors: string[]; agentSelectedSkillIds?: string[] | null; runnableSkillIds?: string[]; neededSkillIds?: string[]; blockedItems?: {skillId: string; reasonCode: string}[]; decision?: SkillSelectionDecisionV1}
function observation(taskId: string, now: Date): ExecutionContextV1 {
  return {schemaVersion: "1.0.0", model: "synthetic-host", modelClass: "general", reasoningEffort: "high", source: "runtime", actorId: "codex:synthetic-owner",
    observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 300_000).toISOString(), observationId: "synthetic-only-observation", taskId};
}
function selection(advice: Advice, status: "SELECTED" | "PARTIAL" = "SELECTED"): SkillSelectionDecisionV1 {
  const {taskRevision, requestDigest, inventoryDigest, configRevision, profileRevision} = advice.result.snapshot;
  return {schemaVersion: "1.0.0", classificationResponseRef: advice.classificationResponseRef, taskRevision, requestDigest, inventoryDigest, configRevision, profileRevision,
    explicitSkillIds: ["code-review"], ruleRequiredSkillIds: [], agentSelectedSkillIds: ["code-review"],
    selectionReasons: [{skillId: "code-review", reason: "Synthetic independent choice for a read-only fixed diff"}],
    applicabilityChecks: [{skillId: "code-review", applies: true, excluded: false, reasonRefs: ["fixture:fixed-diff"]}],
    unresolvedSkillReferences: [], selectionStatus: status, adviceApplied: true, hostReceipt: null};
}
async function harness(options: {missing?: boolean; disabled?: boolean; unavailable?: "installed" | "hostSupported"; configured?: boolean} = {}) {
  const base = await loadSkillInventory({root});
  const now = new Date("2026-10-09T00:00:00.000Z");
  const host: HostSnapshot = {schemaVersion: "1.0.0", sourceRef: "fixture:trusted-host-discovery", revision: "host-1", observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300_000).toISOString(), skills: base.skills.map(skill => ({skillId: skill.skillId, enabled: true, installed: true, hostSupported: true, root: null}))};
  const review = host.skills.find(skill => skill.skillId === "code-review")!;
  if (options.disabled) review.enabled = false;
  if (options.unavailable) review[options.unavailable] = false;
  const profile: ProviderProfile = {profileId: "mock-fixed", providerKind: "vendor", vendorId: "mock-vendor", modelId: "synthetic-fixed", modelRevision: "m1", reasoningEffort: "low",
    supportedOptions: {structuredOutput: true, reasoningEfforts: ["low"]}, approvedRouteRef: "fixture:native", qualificationRevision: "synthetic-only",
    qualification: {status: "PASS", inventoryDigest: base.inventoryDigest, taxonomyRevision: base.taxonomyRevision, modelRevision: "m1", promptRevision: "p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""},
    adapterRevision: "a1", promptRevision: "p1", maximumInputBytes: 2_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0, judgmentPolicy: null};
  const runtime: ClassificationRuntimeSnapshot = {config: {jevEnabled: false, mode: "select", providerProfileRegistryRef: "fixture:profiles", externalClassificationAllowed: false, configRevision: "c1", timeoutMs: 2000},
    registry: {schemaVersion: "1.0.0", profileRevision: "p1", profiles: [profile]}, allowRemotePrivateContent: false};
  const provider = {availability: vi.fn(async () => ({available: true, approved: true, routeKind: "native" as const, reasonCode: null})),
    classify: vi.fn(async (request: SkillClassificationRequestV1): Promise<ProviderEvaluation> => ({response: {schemaVersion: "1.0.0", requestId: request.requestId, operationId: request.operationId,
      requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: "SUCCESS", judgments: request.skills.map(skill => ({skillId: skill.skillId,
        judgment: skill.skillId === "code-review" ? "needed" : "not-needed", reasonRefs: ["fixture:source"], uncertaintyReason: null})), unresolvedItems: [], error: null},
      usage: {inputTokens: null, outputTokens: null, cachedInputTokens: null, actualCostUsd: 0}, dispatchState: "started", diagnostics: null}))};
  const service = new SkillClassificationService({providers: {vendor: provider}, now: () => now.getTime(),
    budget: new InMemoryClassificationBudget({jev: {limitUsd: 0, spentUsd: 0}, vendors: {}, nativeAllowances: {"mock-fixed": {approvalRef: "synthetic-only", remainingCalls: 10}}})});
  const task = {current: null as CurrentClassificationTask | null, initialized: false};
  const observeTask = vi.fn((request: SkillClassificationRequestV1) => {
    if (!task.initialized) {task.initialized = true; task.current = {taskRevision: request.confirmedContext.taskRevision, requestDigest: request.requestDigest, cancelled: false, sourceRef: "fixture:current-task"};}
    return task.current;
  });
  const readRuntime = vi.fn(async () => runtime);
  const observeHostSkills = vi.fn(async () => options.missing ? null : host);
  const gateway = new RuntimeSkillClassificationGateway({root, service, readRuntime, observeTask, observeRuntime: () => digestClassificationValue(runtime), now: () => now,
    ...(!options.configured ? {observeHostSkills} : {})});
  const inventoried = await gateway.inventory() as HostInventory;
  profile.qualification.inventoryDigest = inventoried.inventoryDigest;
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  const input = {schemaVersion: "1.0.0", requestId: "host-request", operationId: "host-operation", originalPrompt: "고정 diff만 읽기 전용 리뷰. 수정 금지.",
    confirmedContext: {taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null}, contextSources: [],
    explicitSkillIds: ["code-review"], ruleRequiredSkillIds: [], vendorContext: {vendorId: "mock-vendor", reference: "synthetic-only"}, publicSynthetic: true};
  const classify = () => gateway.classify(input, observation(input.requestId, now)) as Promise<Advice>;
  const accept = (advice: Advice, status: "SELECTED" | "PARTIAL" = "SELECTED") => gateway.accept({schemaVersion: "1.0.0", operationId: input.operationId, decision: selection(advice, status)}, observation(advice.result.request.requestDigest, now)) as Promise<Accepted>;
  return {gateway, host, profile, runtime, readRuntime, observeHostSkills, observeTask, task, provider, classify, accept, input, now};
}

import {ApprovedRouteClassificationProvider, unknownUsage, type ApprovedClassificationRoute} from "../../mcp-server/src/skill-classification/providers.js";
import {createNativeClassificationAdapters} from "../../mcp-server/src/skill-classification/native-adapters.js";

describe("R17 freshness at the public commit and dispatch boundaries", () => {
  it.each([0, 1])("r17-observation: an accept observation expiring during runtime await is rejected at expiry+%s and a fresh receipt can commit", async offset => {
    const h = await harness(), advice = await h.classify();
    const old = observation(advice.result.request.requestDigest, h.now);
    old.expiresAt = new Date(h.now.getTime() + 1000).toISOString(); old.observationId = "expired-receipt";
    h.readRuntime.mockImplementationOnce(async () => {h.now.setTime(Date.parse(old.expiresAt!) + offset); return h.runtime;});
    await expect(h.gateway.accept({schemaVersion: "1.0.0", operationId: h.input.operationId, decision: selection(advice)}, old)).rejects.toThrow("HOST_SELECTION_OBSERVATION_EXPIRED");
    const cached = await h.classify(); expect(cached.agentSelectedSkillIds).toBeNull();
    const fresh = observation(advice.result.request.requestDigest, h.now); fresh.observationId = "fresh-receipt";
    const accepted = await h.gateway.accept({schemaVersion: "1.0.0", operationId: h.input.operationId, decision: selection(advice)}, fresh) as Accepted;
    expect(accepted.valid).toBe(true); expect(accepted.decision?.hostReceipt?.receiptId).toBe("fresh-receipt");
  });
  it.each([
    {kind: "remote", change: "revision"}, {kind: "remote", change: "enabled"},
    {kind: "remote", change: "installed"}, {kind: "remote", change: "hostSupported"},
    {kind: "native", change: "revision"}, {kind: "remote", change: "none"}, {kind: "native", change: "none"},
  ] as const)("r17-host-source: $kind actual dispatch respects configured file $change change during await", async ({kind, change}) => {
    const temporary = await mkdtemp(path.join(tmpdir(), "ags-r17-host-"));
    expect(path.dirname(temporary)).toBe(path.resolve(tmpdir()));
    try {
      const h = await harness({configured: true}), hostFile = path.join(temporary, "host.json");
      await writeFile(hostFile, JSON.stringify(h.host)); h.runtime.hostDiscoveryRef = hostFile;
      const mutate = async () => {
        if (change === "none") return;
        h.host.revision = "host-2";
        if (change !== "revision") h.host.skills.find(skill => skill.skillId === "code-review")![change] = false;
        await writeFile(hostFile, JSON.stringify(h.host));
      };
      const evaluation = async (request: SkillClassificationRequestV1) => h.provider.classify(request);
      const fetcher = vi.fn(async () => new Response("{}", {status: 200}));
      let nativeRequest: SkillClassificationRequestV1 | null = null;
      const runner = vi.fn(async () => {
        const response = (await evaluation(nativeRequest!)).response;
        return {exitCode: 0, stdout: JSON.stringify({type: "item.completed", item: {type: "agent_message", text: JSON.stringify(response)}}) + "\n" + JSON.stringify({type: "turn.completed", usage: {}})};
      });
      const adapter = createNativeClassificationAdapters([{adapterId: "r17-native", host: "codex", executable: process.execPath, workingDirectory: root, approvalRef: "synthetic", capabilityEvidenceRef: "synthetic", retryPolicyVerified: true, retryPolicyEvidenceRef: "synthetic", isolationEvidenceRef: "synthetic", isolationArgs: [], timeoutMs: 1000, maximumOutputBytes: 100000}], runner).get("r17-native")!;
      const routeBase = {routeRef: h.profile.approvedRouteRef, approvalRef: "synthetic-only", approved: true, providerKind: "vendor" as const, vendorId: h.profile.vendorId, adapterRevision: h.profile.adapterRevision, modelIds: [h.profile.modelId], reasoningEfforts: [h.profile.reasoningEffort], structuredOutput: true};
      let credentials = 0;
      const route: ApprovedClassificationRoute = kind === "remote" ? {...routeBase, kind, endpoint: "https://synthetic.invalid/classify", getCredential: async () => {if (++credentials === 2) await mutate(); return "synthetic-key";}, adapter: {encode: () => ({}), decode: (_body, request) => ({response: {schemaVersion: "1.0.0", requestId: request.requestId, operationId: request.operationId, requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: "SUCCESS", judgments: request.skills.map(skill => ({skillId: skill.skillId, judgment: skill.skillId === "code-review" ? "needed" : "not-needed", reasonRefs: ["synthetic"], uncertaintyReason: null})), unresolvedItems: [], error: null}, dispatchState: "started", usage: {...unknownUsage(), actualCostUsd: 0}, diagnostics: null})}}
        : {...routeBase, kind, invokeStructured: async (request, profile, signal, guard) => {nativeRequest = request; await mutate(); return adapter.invokeStructured(request, profile, signal, guard);}};
      const provider = new ApprovedRouteClassificationProvider([route], fetcher);
      const budget = new InMemoryClassificationBudget({jev: {limitUsd: 0, spentUsd: 0}, vendors: {"mock-vendor": {limitUsd: 1, spentUsd: 0}}, nativeAllowances: {"mock-fixed": {approvalRef: "synthetic-only", remainingCalls: 10}}});
      const gateway = new RuntimeSkillClassificationGateway({root, service: new SkillClassificationService({providers: {vendor: provider}, budget, now: () => h.now.getTime()}), readRuntime: h.readRuntime, observeTask: h.observeTask, observeRuntime: () => digestClassificationValue(h.runtime), now: () => h.now});
      const inventory = await gateway.inventory() as HostInventory; expect(inventory.issues).toEqual([]);
      h.profile.qualification.inventoryDigest = inventory.inventoryDigest; h.profile.maximumCostUsd = 0.4;
      h.profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(h.profile);
      h.runtime.allowRemotePrivateContent = true; h.runtime.config.externalClassificationAllowed = true;
      const advice = await gateway.classify(h.input, observation(h.input.requestId, h.now)) as Advice;
      const transport = kind === "remote" ? fetcher : runner;
      expect(transport).toHaveBeenCalledTimes(change === "none" ? 1 : 0);
      if (change === "none") expect(advice.result.response.status).toBe("SUCCESS");
      else {expect(advice.result.response.error?.code).toBe("STALE_CLASSIFICATION"); expect(budget.snapshot().reservations).toHaveLength(0); expect(budget.snapshot().limits["vendor:mock-vendor"]!.spentUsd).toBe(0);}
    } finally {await rm(temporary, {recursive: true, force: true});}
  });
});
