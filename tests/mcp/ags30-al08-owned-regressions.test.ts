import {createHash} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createClassificationRequest, digestClassificationValue} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import {ApprovedRouteClassificationProvider, bindClassificationRouteTransport, unknownUsage} from "../../mcp-server/src/skill-classification/providers.js";
import {createNativeClassificationAdapters, type NativeClassificationAdapterDefinition, type NativeCliRunner} from "../../mcp-server/src/skill-classification/native-adapters.js";
import {InMemoryClassificationBudget, SkillClassificationService} from "../../mcp-server/src/skill-classification/service.js";
import {RuntimeSkillClassificationGateway, type ClassificationRuntimeSnapshot} from "../../mcp-server/src/skill-classification/gateway.js";
import {loadHostObservedInventory, type HostSkillDiscoverySnapshot} from "../../mcp-server/src/skill-classification/host-discovery-adapter.js";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {validateDecision} from "../../mcp-server/src/skill-classification/validation.js";
import type {ClassificationConfig, ClassificationResult, ProviderEvaluation, ProviderProfile, SkillClassificationProviderPort, SkillClassificationRequestV1, SkillInventory, SkillSelectionDecisionV1} from "../../mcp-server/src/skill-classification/types.js";

// AL08: public boundaries, synthetic provider ports only. Local/remote/native execution is NOT_RUN during authoring.
// TD-002/004/005; CONC-CANCEL-004 and DIST-IDEMPOTENCY-002. Existing negative oracles remain unchanged.
const roots: string[] = [];
const NOW = new Date("2026-10-25T00:00:00.000Z");
afterEach(async () => {await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true})));});
const config: ClassificationConfig = {jevEnabled: false, mode: "select", providerProfileRegistryRef: "synthetic:profiles", externalClassificationAllowed: true, configRevision: "al08-c1", timeoutMs: 2000};
function response(request: SkillClassificationRequestV1): ProviderEvaluation {
  return {response: {schemaVersion: "1.0.0", requestId: request.requestId, operationId: request.operationId, requestDigest: request.requestDigest,
    inventoryDigest: request.inventoryDigest, status: "SUCCESS", judgments: request.skills.map(skill => ({skillId: skill.skillId, judgment: "not-needed", reasonRefs: ["synthetic:objective"], uncertaintyReason: null})), unresolvedItems: [], error: null},
    usage: {...unknownUsage(), actualCostUsd: 0}, dispatchState: "started", diagnostics: null};
}
function profile(request: SkillClassificationRequestV1, kind: "vendor" | "jev" = "vendor"): ProviderProfile {
  const result: ProviderProfile = {profileId: `al08-${kind}`, providerKind: kind, vendorId: "neutral-vendor", modelId: "neutral-model", modelRevision: "neutral-model",
    reasoningEffort: kind === "vendor" ? "high" : null, supportedOptions: {structuredOutput: true, reasoningEfforts: kind === "vendor" ? ["high"] : [null]},
    approvedRouteRef: `al08-${kind}-route`, adapterRevision: "al08-a1", promptRevision: "al08-p1", qualificationRevision: "synthetic-q1",
    maximumInputBytes: 2_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0, judgmentPolicy: kind === "jev" ? {neededAt: 0.8, notNeededAt: 0.2} : null,
    qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: request.taxonomyRevision, modelRevision: "neutral-model", promptRevision: "al08-p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}};
  result.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(result);
  return result;
}
function budget() {
  return new InMemoryClassificationBudget({jev: {limitUsd: 0, spentUsd: 0}, vendors: {}, nativeAllowances: {"al08-vendor": {approvalRef: "synthetic:allowance", remainingCalls: 2}}});
}
function emptyRequest() {
  return createClassificationRequest({requestId: "al08-request", operationId: "al08-operation", originalPrompt: "분석만 한다. 수정은 금지한다.", inventory: {skills: [], issues: [], inventoryDigest: `sha256:${"a".repeat(64)}`, taxonomyRevision: "al08-t1"}, classificationCriteriaRef: "synthetic:criteria"});
}
async function skillTree(id: string) {
  const root = await mkdtemp(path.join(tmpdir(), "ags-al08-owned-")); roots.push(root);
  const directory = path.join(root, "skills", id); await mkdir(directory, {recursive: true});
  const bytes = `---\nname: ${id}\ndescription: Analyze a fixed queue, excluding modification.\nmetadata:\n  version: "1.0.0"\n---\n\nAnalyze a fixed queue.\nExclude modification.\n`;
  await writeFile(path.join(directory, "SKILL.md"), bytes, "utf8");
  const source = {path: `skills/${id}/SKILL.md`, startLine: 8, endLine: 9, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`};
  await writeFile(path.join(directory, "classification.json"), JSON.stringify({schemaVersion: "1.0.0", taxonomyRevision: "al08-t1", actions: ["analyze"], targets: ["queue"], constraints: [], dependencies: [], capabilities: ["analyze"], applicability: [source], exclusions: [source]}), "utf8");
  await writeFile(path.join(root, "skills", "registry.json"), JSON.stringify({schemaVersion: "2.0.0", skills: []}), "utf8");
  return {root, directory};
}
function hostSnapshot(inventory: SkillInventory): HostSkillDiscoverySnapshot {
  return {schemaVersion: "1.0.0", sourceRef: "synthetic:host", revision: "al08-h1", observedAt: NOW.toISOString(), expiresAt: "2099-01-01T00:00:00.000Z",
    skills: inventory.skills.map(skill => ({skillId: skill.skillId, enabled: true, installed: true, hostSupported: true, root: null}))};
}

describe("AL08 original owned defects", () => {
  it("D0072 preparation failure is known not-started and releases the reservation without spending an allowance", async () => {
    const request = emptyRequest(), selected = profile(request), runner = vi.fn<NativeCliRunner>();
    const definition: NativeClassificationAdapterDefinition = {adapterId: "synthetic-native", host: "neutral-host", executable: process.execPath, workingDirectory: tmpdir(),
      approvalRef: "synthetic:approval", capabilityEvidenceRef: "synthetic:capability", retryPolicyVerified: true, retryPolicyEvidenceRef: "synthetic:no-retry", isolationEvidenceRef: "synthetic:isolation", isolationArgs: [], timeoutMs: 100, maximumOutputBytes: 10000};
    const adapter = createNativeClassificationAdapters([{data: definition, behavior: {validateIsolationArgs: () => true, canEncodeProfile: () => true,
      prepare: async () => {throw new Error("PRIVATE_PREPARATION_FAILURE");}, decode: () => {throw new Error("UNREACHABLE");}}}], runner).get(definition.adapterId)!;
    const provider = new ApprovedRouteClassificationProvider([bindClassificationRouteTransport({kind: "native", routeRef: selected.approvedRouteRef, approvalRef: "synthetic:route", approved: true,
      providerKind: "vendor", vendorId: selected.vendorId, adapterRevision: selected.adapterRevision, modelIds: [selected.modelId], reasoningEfforts: [selected.reasoningEffort], structuredOutput: true,
      invokeStructured: adapter.invokeStructured})]);
    const accounting = budget();
    const result = await new SkillClassificationService({providers: {vendor: provider}, budget: accounting}).classify({request, config, registry: {schemaVersion: "1.0.0", profileRevision: "al08-r1", profiles: [selected]}, currentVendorId: selected.vendorId});
    expect(result.attempts[0]).toMatchObject({errorCode: "NATIVE_PROCESS_UNAVAILABLE", dispatchState: "not-started", reservedCostUsd: 0});
    expect(accounting.snapshot()).toMatchObject({reservations: [], nativeAllowances: {"al08-vendor": {remainingCalls: 2}}});
    expect(runner).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain("PRIVATE_PREPARATION_FAILURE");
  });

  it("D0073 unselected unavailable advice remains visible and does not block an independently selected set", async () => {
    const local = await skillTree("al08-choice"), inventory = await loadSkillInventory({root: local.root});
    const advised = {...inventory.skills[0]!, skillId: "al08-advice", enabled: false}; inventory.skills.push(advised);
    const request = createClassificationRequest({requestId: "selection-r", operationId: "selection-o", originalPrompt: "분석한다", inventory, classificationCriteriaRef: "synthetic:criteria"});
    const evaluation = response(request); evaluation.response.judgments[1]!.judgment = "needed";
    const snapshot = {taskRevision: null, configRevision: config.configRevision, profileRevision: "al08-r1", inventoryDigest: request.inventoryDigest, requestDigest: request.requestDigest, cancelled: false};
    const result: ClassificationResult = {request, response: evaluation.response, config, profileRevision: snapshot.profileRevision, snapshot, attempts: []};
    const decision: SkillSelectionDecisionV1 = {schemaVersion: "1.0.0", classificationResponseRef: digestClassificationValue(result.response), taskRevision: snapshot.taskRevision, configRevision: snapshot.configRevision, profileRevision: snapshot.profileRevision, inventoryDigest: snapshot.inventoryDigest, requestDigest: snapshot.requestDigest,
      explicitSkillIds: [], ruleRequiredSkillIds: [], agentSelectedSkillIds: ["al08-choice"], selectionReasons: [{skillId: "al08-choice", reason: "synthetic independent decision"}],
      applicabilityChecks: [{skillId: "al08-choice", applies: true, excluded: false, reasonRefs: ["synthetic:task"]}], unresolvedSkillReferences: [], selectionStatus: "SELECTED", adviceApplied: true,
      hostReceipt: {receiptId: "synthetic:receipt", host: "neutral-host", requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, agentSelectedSkillIds: ["al08-choice"], acceptedAt: NOW.toISOString()}};
    const checked = validateDecision(result, decision, snapshot);
    expect(checked.valid).toBe(true); expect(checked.runnableSkillIds).toEqual(["al08-choice"]);
    expect(checked.blockedItems).toEqual([{skillId: "al08-advice", reasonCode: "DISABLED"}]);
    decision.explicitSkillIds = ["al08-advice"];
    expect(validateDecision(result, decision, snapshot).valid).toBe(false);
  });

  it("D0074 gateway permits approved native classification while remote private-content permission is absent", async () => {
    const local = await skillTree("al08-native"), inventory = await loadSkillInventory({root: local.root}), host = hostSnapshot(inventory);
    const requestInput = {schemaVersion: "1.0.0", requestId: "native-r", operationId: "native-o", originalPrompt: "비공개 합성 자료를 읽기 전용으로 분석한다.",
      confirmedContext: {taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null}, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: {vendorId: "neutral-vendor", reference: "synthetic:vendor"}, publicSynthetic: false};
    const request = createClassificationRequest({requestId: requestInput.requestId, operationId: requestInput.operationId, originalPrompt: requestInput.originalPrompt, confirmedContext: requestInput.confirmedContext, contextSources: requestInput.contextSources, inventory, classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md"});
    const selected = profile(request), invoke = vi.fn(async (bound: SkillClassificationRequestV1) => response(bound));
    const provider = new ApprovedRouteClassificationProvider([bindClassificationRouteTransport({kind: "native", routeRef: selected.approvedRouteRef, approvalRef: "synthetic:route", approved: true,
      providerKind: "vendor", vendorId: selected.vendorId, adapterRevision: selected.adapterRevision, modelIds: [selected.modelId], reasoningEfforts: [selected.reasoningEffort], structuredOutput: true, invokeStructured: invoke})]);
    const runtime: ClassificationRuntimeSnapshot = {config, registry: {schemaVersion: "1.0.0", profileRevision: "al08-r1", profiles: [selected]}, allowRemotePrivateContent: false};
    const gateway = new RuntimeSkillClassificationGateway({root: local.root, service: new SkillClassificationService({providers: {vendor: provider}, budget: budget()}),
      readRuntime: async () => runtime, observeHostSkills: async () => host, now: () => NOW});
    const result = await gateway.classify(requestInput);
    expect(result).toMatchObject({result: {response: {status: "SUCCESS"}}}); expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("D0074 blocked remote JEV performs no availability lookup before permitted native fallback", async () => {
    const request = emptyRequest(), vendorProfile = profile(request), jevProfile = profile(request, "jev");
    const jev: SkillClassificationProviderPort = {routeKind: () => "remote", availability: vi.fn(), classify: vi.fn()};
    const vendor: SkillClassificationProviderPort = {routeKind: () => "native", availability: vi.fn(async () => ({available: true, approved: true, routeKind: "native", reasonCode: null})),
      classify: vi.fn(async (bound, _profile, _signal, fence) => {fence?.(); return response(bound);})};
    const result = await new SkillClassificationService({providers: {jev, vendor}, budget: budget()}).classify({request, config: {...config, jevEnabled: true},
      registry: {schemaVersion: "1.0.0", profileRevision: "al08-r1", profiles: [jevProfile, vendorProfile]}, currentVendorId: vendorProfile.vendorId, remoteContentAllowed: false});
    expect(result.response.status).toBe("SUCCESS"); expect(result.attempts.map(attempt => attempt.errorCode)).toEqual(["REMOTE_CONTENT_NOT_APPROVED", null]);
    expect(jev.availability).not.toHaveBeenCalled(); expect(jev.classify).not.toHaveBeenCalled(); expect(vendor.classify).toHaveBeenCalledTimes(1);
  });

  it("D0074 native-to-remote change before dispatch cannot transmit unapproved content", async () => {
    const request = emptyRequest(), selected = profile(request), effect = vi.fn(); let kind: "native" | "remote" = "native";
    const vendor: SkillClassificationProviderPort = {routeKind: () => kind, availability: async () => ({available: true, approved: true, routeKind: "native", reasonCode: null}),
      classify: async (bound, _profile, _signal, fence) => {kind = "remote"; fence?.(); effect(); return response(bound);}};
    const accounting = budget();
    const result = await new SkillClassificationService({providers: {vendor}, budget: accounting}).classify({request, config,
      registry: {schemaVersion: "1.0.0", profileRevision: "al08-r1", profiles: [selected]}, currentVendorId: selected.vendorId, remoteContentAllowed: false});
    expect(result.response.error?.code).toBe("REMOTE_CONTENT_NOT_APPROVED"); expect(effect).not.toHaveBeenCalled(); expect(accounting.snapshot().reservations).toEqual([]);
  });

  it("D0075 host-reported local root and repeated equivalent roots load the skill once", async () => {
    const local = await skillTree("al08-local"), inventory = await loadSkillInventory({root: local.root}), host = hostSnapshot(inventory);
    host.skills[0]!.root = local.directory;
    const result = await loadHostObservedInventory({root: local.root, externalSkillRoots: [local.directory, path.join(local.directory, "..", "al08-local")], observeHostSkills: async () => host, now: () => NOW});
    expect(result.discovery.status).toBe("COMPLETE"); expect(result.inventory.issues).toEqual([]);
    expect(result.inventory.skills.map(skill => skill.skillId)).toEqual(["al08-local"]); expect(result.inventory.inventoryDigest).toBe(inventory.inventoryDigest);
  });

  it("D0075 distinct roots claiming the same skill remain an invalid duplicate", async () => {
    const local = await skillTree("al08-duplicate"), foreign = await skillTree("al08-duplicate");
    const result = await loadSkillInventory({root: local.root, externalSkillRoots: [foreign.directory]});
    expect(result.issues).toContainEqual({skillId: "al08-duplicate", code: "DUPLICATE_ID", field: "externalSkillRoots"}); expect(result.skills).toEqual([]);
  });
});
