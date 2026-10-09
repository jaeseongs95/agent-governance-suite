import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {ExecutionContextV1} from "../../contracts/types.js";
import {RuntimeSkillClassificationGateway, readClassificationRuntime, type ClassificationRuntimeSnapshot, type CurrentClassificationTask} from "../../mcp-server/src/skill-classification/gateway.js";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {digestClassificationValue} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import {InMemoryClassificationBudget, SkillClassificationService} from "../../mcp-server/src/skill-classification/service.js";
import type {ClassificationResult, ProviderEvaluation, ProviderProfile, SkillClassificationRequestV1, SkillInventory, SkillSelectionDecisionV1} from "../../mcp-server/src/skill-classification/types.js";

// Real gateway/service/files; synthetic host-owned observations and provider only.
// Actual AGENT choice, native host turns, API/model quality and application remain NOT_RUN.
const root = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];
afterEach(async () => {await Promise.all(directories.splice(0).map(dir => rm(dir, {recursive: true, force: true})));});
interface HostSnapshot {
  schemaVersion: "1.0.0"; sourceRef: string; revision: string; observedAt: string; expiresAt: string;
  skills: {skillId: string; enabled: boolean; installed: boolean; hostSupported: boolean; root: string | null}[];
}
interface HostInventory extends SkillInventory {
  discovery: {status: "COMPLETE" | "INCOMPLETE" | "UNAVAILABLE"; scope: "host" | "local-tree"; sourceRef: string | null; revision: string | null};
}
interface Advice {result: ClassificationResult; classificationResponseRef: string; agentSelectedSkillIds: string[] | null}
interface Accepted {valid: boolean; errors: string[]; agentSelectedSkillIds?: string[] | null; runnableSkillIds?: string[]; neededSkillIds?: string[]; blockedItems?: {skillId: string; reasonCode: string}[]; decision?: SkillSelectionDecisionV1}
function barrier() {let open!: () => void; const promise = new Promise<void>(resolve => {open = resolve;}); return {open, promise};}
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
describe("trusted host discovery at the actual classification gateway", () => {
  it("HD1 preserves disabled needed candidate but rejects complete selection and excludes runnable", async () => {
    const h = await harness({disabled: true});
    const inventory = await h.gateway.inventory() as HostInventory;
    expect(inventory.skills.find(skill => skill.skillId === "code-review")).toMatchObject({enabled: false, installed: true, hostSupported: true});
    expect(inventory.discovery).toMatchObject({status: "COMPLETE", scope: "host"});
    const advice = await h.classify();
    expect((await h.accept(advice)).errors).toContain("UNRESOLVED_SELECTION_MARKED_COMPLETE");
    const partial = await h.accept(advice, "PARTIAL");
    expect(partial.valid).toBe(true); expect(partial.neededSkillIds).toContain("code-review"); expect(partial.runnableSkillIds).not.toContain("code-review");
    expect(partial.blockedItems).toContainEqual({skillId: "code-review", reasonCode: "DISABLED"});
  });
  it.each(["installed", "hostSupported"] as const)("HD2 forwards observed %s membership instead of local-tree defaults", async field => {
    const h = await harness({unavailable: field});
    const inventory = await h.gateway.inventory() as HostInventory;
    expect(inventory.skills.find(skill => skill.skillId === "code-review")![field]).toBe(false);
    const advice = await h.classify(); const result = await h.accept(advice, "PARTIAL");
    expect(result.runnableSkillIds).not.toContain("code-review");
    expect(result.blockedItems).toContainEqual({skillId: "code-review", reasonCode: field === "installed" ? "NOT_INSTALLED" : "HOST_UNSUPPORTED"});
  });
  it("HD3 missing discovery reports local scope and prevents falsely complete selection support", async () => {
    const h = await harness({missing: true}); const inventory = await h.gateway.inventory() as HostInventory;
    expect(inventory.discovery).toMatchObject({status: "UNAVAILABLE", scope: "local-tree"});
    expect(inventory.issues).toContainEqual({skillId: null, code: "HOST_DISCOVERY_UNAVAILABLE", field: "hostDiscovery"});
    expect(await h.classify()).toMatchObject({status: "NEEDS_INPUT", agentSelectedSkillIds: null});
    expect(h.provider.availability).not.toHaveBeenCalled(); expect(h.provider.classify).not.toHaveBeenCalled();
  });
  it("HD4 missing external metadata is reported rather than forcing a system candidate into taxonomy", async () => {
    const h = await harness(); h.host.skills.push({skillId: "external-system-skill", enabled: true, installed: true, hostSupported: true, root: null});
    const inventory = await h.gateway.inventory() as HostInventory;
    expect(inventory.discovery).toMatchObject({status: "INCOMPLETE", scope: "host"});
    expect(inventory.issues).toContainEqual({skillId: "external-system-skill", code: "INSTALLED_SKILL_UNEXPOSED", field: "installedSkillIds"});
    expect(inventory.skills.some(skill => skill.skillId === "external-system-skill")).toBe(false);
    expect(await h.classify()).toMatchObject({status: "NEEDS_INPUT"}); expect(h.provider.classify).not.toHaveBeenCalled();
  });
  it("HD5 changed host observation revision cannot reuse or accept an old selected operation", async () => {
    const h = await harness(), advice = await h.classify(); h.host.revision = "host-2";
    expect((await h.accept(advice)).valid).toBe(false);
    await expect(h.classify()).rejects.toThrow("STALE_CLASSIFICATION_OPERATION");
  });
  it("HD6 configured trusted snapshot is read through the existing runtime configuration boundary", async () => {
    const h = await harness({configured: true, disabled: true});
    const directory = await mkdtemp(path.join(tmpdir(), "ags-host-discovery-config-")); directories.push(directory);
    const file = path.join(directory, "host.json"); await writeFile(file, JSON.stringify(h.host));
    await writeFile(path.join(directory, "profiles.json"), JSON.stringify(h.runtime.registry));
    await writeFile(path.join(directory, "config.json"), JSON.stringify({config: {...h.runtime.config, providerProfileRegistryRef: "profiles.json"}, allowRemotePrivateContent: false, hostDiscoveryRef: "host.json"}));
    const runtime = await readClassificationRuntime(path.join(directory, "config.json"), root);
    h.readRuntime.mockResolvedValue(runtime);
    const inventory = await h.gateway.inventory() as HostInventory;
    expect(inventory.discovery).toMatchObject({status: "COMPLETE", sourceRef: h.host.sourceRef});
    expect(inventory.skills.find(skill => skill.skillId === "code-review")!.enabled).toBe(false);
    expect(await readFile(file, "utf8")).toBe(JSON.stringify(h.host));
  });
});
const changes = ["cancelled", "removed", "taskRevision", "requestDigest", "sourceRef"] as const;
describe("current task fence immediately before selection storage", () => {
  for (const stage of ["runtime", "discovery"] as const) {
    it.each(changes)(`AC ${stage} await cannot commit after %s`, async change => {
      const h = await harness(), advice = await h.classify(), original = structuredClone(h.task.current)!;
      const entered = barrier(), release = barrier();
      if (stage === "runtime") h.readRuntime.mockImplementationOnce(async () => {entered.open(); await release.promise; return h.runtime;});
      else h.observeHostSkills.mockImplementationOnce(async () => {entered.open(); await release.promise; return h.host;});
      const pending = h.accept(advice); await entered.promise;
      if (change === "cancelled") h.task.current!.cancelled = true;
      else if (change === "removed") h.task.current = null;
      else if (change === "taskRevision") h.task.current!.taskRevision = "new-task";
      else if (change === "requestDigest") h.task.current!.requestDigest = `sha256:${"d".repeat(64)}`;
      else h.task.current!.sourceRef = "new-source";
      release.open();
      expect(await pending).toMatchObject({valid: false, errors: ["HOST_TASK_CHANGED_OR_NOT_OBSERVED"], agentSelectedSkillIds: null});
      h.task.current = original;
      expect((await h.classify()).agentSelectedSkillIds).toBeNull();
    });
  }
  it("AC unchanged task accepts once and repeats idempotently without claiming read/application", async () => {
    const h = await harness(), advice = await h.classify();
    const first = await h.accept(advice), repeat = await h.accept(advice);
    expect(first.valid).toBe(true); expect(repeat.decision).toEqual(first.decision);
    expect(first).toMatchObject({admissionStatus: "NOT_EVALUATED", readStatus: "NOT_OBSERVED", appliedStatus: "NOT_OBSERVED", verifiedStatus: "NOT_RUN"});
  });
});
