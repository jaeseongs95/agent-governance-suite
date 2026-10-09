import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {describe, expect, it, vi} from "vitest";
import type {ExecutionContextV1} from "../../contracts/types.js";
import {RuntimeSkillClassificationGateway, type ClassificationRuntimeSnapshot, type CurrentClassificationTask} from "../../mcp-server/src/skill-classification/gateway.js";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {createClassificationRequest, digestClassificationValue} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import {InMemoryClassificationBudget, SkillClassificationService} from "../../mcp-server/src/skill-classification/service.js";
import type {ClassificationResult, ClassificationSnapshot, ProviderEvaluation, ProviderProfile, SkillClassificationRequestV1, SkillInventory, SkillSelectionDecisionV1} from "../../mcp-server/src/skill-classification/types.js";

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

import {ApprovedRouteClassificationProvider, ClassificationProviderError, unknownUsage, type ApprovedClassificationRoute} from "../../mcp-server/src/skill-classification/providers.js";
import {validateDecision} from "../../mcp-server/src/skill-classification/validation.js";

function remoteHarness(options: {credentialChange?: () => void; encodeChange?: () => void; responseStatus?: number; retryAfter?: string} = {}) {
  const request = createClassificationRequest({requestId: "r16-request", operationId: "r16-operation", originalPrompt: "고정 diff 리뷰", inventory: {skills: [{skillId: "review", version: "1", description: "리뷰", enabled: true, installed: true, hostSupported: true, capabilities: ["review"], actions: [], targets: [], constraints: [], applicability: ["fixed diff"], exclusions: ["implementation"], dependencies: [], phases: [], sourceRefs: []}], inventoryDigest: "sha256:" + "a".repeat(64), taxonomyRevision: "synthetic", issues: []}, classificationCriteriaRef: "synthetic"});
  const profile: ProviderProfile = {profileId: "vendor", providerKind: "vendor", vendorId: "vendor", modelId: "fixed", modelRevision: "fixed", reasoningEffort: "low", supportedOptions: {reasoningEfforts: ["low"], structuredOutput: true}, approvedRouteRef: "route", qualificationRevision: "q1", qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: request.taxonomyRevision, modelRevision: "fixed", promptRevision: "p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}, adapterRevision: "a1", promptRevision: "p1", maximumInputBytes: 100000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: null};
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  const response = {schemaVersion: "1.0.0" as const, requestId: request.requestId, operationId: request.operationId, requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: "SUCCESS" as const, judgments: [{skillId: "review", judgment: "needed" as const, reasonRefs: ["synthetic"], uncertaintyReason: null}], unresolvedItems: [], error: null};
  const current: ClassificationSnapshot = {taskRevision: null, configRevision: "c1", profileRevision: "p1", inventoryDigest: request.inventoryDigest, requestDigest: request.requestDigest, cancelled: false};
  let credentials = 0;
  const route: ApprovedClassificationRoute = {kind: "remote", routeRef: "route", approvalRef: "synthetic-only", approved: true, providerKind: "vendor", vendorId: "vendor", adapterRevision: "a1", modelIds: ["fixed"], reasoningEfforts: ["low"], structuredOutput: true, endpoint: "https://synthetic.invalid/classify", getCredential: async () => {if (++credentials === 2) options.credentialChange?.(); return "synthetic-key";}, adapter: {encode: () => {options.encodeChange?.(); return {};}, decode: () => ({response, dispatchState: "started", usage: {...unknownUsage(), actualCostUsd: 0.1}, diagnostics: {scoreKind: "synthetic-score", scores: [{skillId: "review", value: 0.9}]}})}};
  const fetcher = vi.fn(async () => new Response("{}", {status: options.responseStatus ?? 200, headers: options.retryAfter ? {"retry-after": options.retryAfter} : {}}));
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 5, spentUsd: 0}, vendors: {vendor: {limitUsd: 5, spentUsd: 0}}});
  const service = new SkillClassificationService({providers: {vendor: new ApprovedRouteClassificationProvider([route], fetcher)}, budget});
  const input = {request, config: {jevEnabled: false, mode: "select" as const, providerProfileRegistryRef: "synthetic", externalClassificationAllowed: true, configRevision: "c1", timeoutMs: 1000}, registry: {schemaVersion: "1.0.0" as const, profileRevision: "p1", profiles: [profile]}, currentVendorId: "vendor", getCurrentSnapshot: () => current};
  return {service,input,current,budget,fetcher};
}
describe("R16 local integration public boundaries", () => {
  it("r16-dispatch: gateway fences host expiry during provider availability", async () => {
    const h = await harness();
    vi.mocked(h.provider.availability).mockImplementation(async () => {h.now.setTime(Date.parse(h.host.expiresAt) + 1); return {available: true, approved: true, routeKind: "native", reasonCode: null};});
    const result = await h.classify();
    expect(h.provider.classify).not.toHaveBeenCalled(); expect(result.result.response.error?.code).toBe("STALE_CLASSIFICATION");
  });
  it("r16-dispatch: gateway fences an actual approved external skill source change during availability", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "ags-r16-source-"));
    expect(path.dirname(temporary)).toBe(path.resolve(tmpdir()));
    try {
      const h = await harness(), id = "neutral-r16-source", directory = path.join(temporary, id);
      await mkdir(directory);
      const bytes = `---\nname: ${id}\ndescription: Read-only source analysis.\nmetadata:\n  version: "1.0.0"\n---\n\nAnalyze immutable source evidence.\nExclude implementation.\n`;
      await writeFile(path.join(directory, "SKILL.md"), bytes);
      const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
      await writeFile(path.join(directory, "classification.json"), JSON.stringify({schemaVersion: "1.0.0", taxonomyRevision: "1.0.0", actions: ["read-only-analysis"], targets: ["source"], constraints: [], dependencies: [], capabilities: ["analysis"], applicability: [{path: `skills/${id}/SKILL.md`, startLine: 8, endLine: 8, digest}], exclusions: [{path: `skills/${id}/SKILL.md`, startLine: 9, endLine: 9, digest}]}));
      h.host.skills.push({skillId: id, enabled: true, installed: true, hostSupported: true, root: directory});
      const inventoried = await h.gateway.inventory() as HostInventory;
      expect(inventoried.issues).toEqual([]); expect(inventoried.skills.some(skill => skill.skillId === id)).toBe(true);
      h.profile.qualification.inventoryDigest = inventoried.inventoryDigest;
      vi.mocked(h.provider.availability).mockImplementation(async () => {await writeFile(path.join(directory, "SKILL.md"), bytes.replace("Read-only source analysis.", "Changed source meaning.")); return {available: true, approved: true, routeKind: "native", reasonCode: null};});
      const result = await h.classify();
      expect(h.provider.classify).not.toHaveBeenCalled(); expect(result.result.response.error?.code).toBe("STALE_CLASSIFICATION");
    } finally {await rm(temporary, {recursive: true, force: true});}
  });
  it.each(["taskRevision", "configRevision", "profileRevision", "inventoryDigest", "requestDigest", "cancelled"] as const)("r16-dispatch: credential await changes %s before actual fetch", async field => {
    const h = remoteHarness({credentialChange: () => change()});
    const change = () => {if (field === "cancelled") h.current.cancelled = true; else h.current[field] = field.endsWith("Digest") ? "sha256:" + "b".repeat(64) : "new";};
    const result = await h.service.classify(h.input);
    expect(h.fetcher).toHaveBeenCalledTimes(0); expect(result.response.error?.code).toBe("STALE_CLASSIFICATION");
    expect(h.budget.snapshot().reservations).toHaveLength(0); expect(h.budget.snapshot().limits["vendor:vendor"]!.spentUsd).toBe(0);
  });
  it("r16-dispatch: synchronous encoding changes external source before fetch", async () => {
    const h = remoteHarness({encodeChange: () => change()}); const change = () => {h.current.configRevision = "new-source";};
    await h.service.classify(h.input); expect(h.fetcher).toHaveBeenCalledTimes(0);
  });
  it("r16-dispatch: unchanged snapshot permits exactly one real fetch", async () => {
    const h = remoteHarness(); expect((await h.service.classify(h.input)).response.status).toBe("SUCCESS"); expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([429, 529])("r16-observations: safe %s Retry-After survives provider→service and unknown cost stays reserved", async httpStatus => {
    const h = remoteHarness({responseStatus: httpStatus, retryAfter: "12"}); const result = await h.service.classify(h.input);
    expect(result.attempts[0]).toMatchObject({errorCode: "RATE_LIMITED", rateLimitObservation: {httpStatus, retryAfter: {kind: "delay-seconds", seconds: 12}}});
    expect(h.fetcher).toHaveBeenCalledTimes(1); expect(h.budget.snapshot().reservations).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("synthetic-key");
  });
  it("r16-observations: verified scores remain in the attempt separately from advice", async () => {
    const h = remoteHarness(); const result = await h.service.classify(h.input);
    expect(result.attempts[0]).toMatchObject({diagnostics: {scoreKind: "synthetic-score", scores: [{skillId: "review", value: 0.9}]}});
    expect(result).not.toHaveProperty("agentSelectedSkillIds");
  });
  it.each(["enabled", "installed", "hostSupported"] as const)("r16-selection: unselected needed %s=false remains blocked without invented runnable", async field => {
    const h = await harness({disabled: field === "enabled", ...(field !== "enabled" ? {unavailable: field} : {})}); const advice = await h.classify();
    const decision = selection(advice, "PARTIAL"); decision.explicitSkillIds = []; decision.agentSelectedSkillIds = []; decision.applicabilityChecks = []; decision.selectionReasons = [];
    decision.hostReceipt = {receiptId: "synthetic", host: "synthetic", requestDigest: advice.result.request.requestDigest, inventoryDigest: advice.result.request.inventoryDigest, agentSelectedSkillIds: [], acceptedAt: h.now.toISOString()};
    const checked = validateDecision(advice.result, decision, advice.result.snapshot);
    expect(checked.neededSkillIds).toContain("code-review"); expect(checked.runnableSkillIds).toEqual([]);
    expect(checked.blockedItems).toContainEqual({skillId: "code-review", reasonCode: field === "enabled" ? "DISABLED" : field === "installed" ? "NOT_INSTALLED" : "HOST_UNSUPPORTED"});
  });
  it("r16-freshness: cached advice rechecks elapsed qualification without changing runtime bytes", async () => {
    const h = await harness(); h.profile.qualification.validUntil = new Date(h.now.getTime() + 1000).toISOString();
    const first = await h.classify(); expect(first.result.response.status).toBe("SUCCESS");
    h.now.setTime(h.now.getTime() + 2000); const second = await h.classify();
    expect(second.result.response.error?.code).toBe("QUALIFICATION_EXPIRED"); expect(h.provider.classify).toHaveBeenCalledTimes(1);
  });
  it("r16-freshness: accept rechecks qualification at the final synchronous commit", async () => {
    const h = await harness(); h.profile.qualification.validUntil = new Date(h.now.getTime() + 1000).toISOString();
    const advice = await h.classify(); h.now.setTime(h.now.getTime() + 2000);
    const accepted = await h.accept(advice); expect(accepted.valid).toBe(false); expect(accepted.errors).toContain("QUALIFICATION_EXPIRED");
  });
});

import {createNativeClassificationAdapters} from "../../mcp-server/src/skill-classification/native-adapters.js";

it("r16-dispatch: native schema await consumes the service guard before real runner", async () => {
  const h = remoteHarness(), profile = h.input.registry.profiles[0]!;
  const runner = vi.fn(async () => ({exitCode: 0, stdout: JSON.stringify({type: "item.completed", item: {type: "agent_message", text: JSON.stringify({schemaVersion: "1.0.0", requestId: h.input.request.requestId, operationId: h.input.request.operationId, requestDigest: h.input.request.requestDigest, inventoryDigest: h.input.request.inventoryDigest, status: "SUCCESS", judgments: [{skillId: "review", judgment: "needed", reasonRefs: ["synthetic"], uncertaintyReason: null}], unresolvedItems: [], error: null})}}) + "\n" + JSON.stringify({type: "turn.completed", usage: {}})}));
  const adapter = createNativeClassificationAdapters([{adapterId: "synthetic-native", host: "codex", executable: process.execPath, workingDirectory: root, approvalRef: "synthetic", capabilityEvidenceRef: "synthetic", retryPolicyVerified: true, retryPolicyEvidenceRef: "synthetic", isolationEvidenceRef: "synthetic", isolationArgs: [], timeoutMs: 1000, maximumOutputBytes: 100000}], runner).get("synthetic-native")!;
  await expect(adapter.invokeStructured(h.input.request, profile, new AbortController().signal, () => {throw new ClassificationProviderError("STALE_CLASSIFICATION", "not-started");})).rejects.toMatchObject({code: "STALE_CLASSIFICATION", dispatchState: "not-started"});
  expect(runner).toHaveBeenCalledTimes(0);
});
