import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExecutionContextV1 } from "../../contracts/types.js";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import { createClassificationRequest, digestClassificationValue } from "../../mcp-server/src/skill-classification/request.js";
import { digestProviderProfileConfiguration } from "../../mcp-server/src/skill-classification/profiles.js";
import { InMemoryClassificationBudget, SkillClassificationService } from "../../mcp-server/src/skill-classification/service.js";
import { RuntimeSkillClassificationGateway, type ClassificationRuntimeSnapshot, type CurrentClassificationTask } from "../../mcp-server/src/skill-classification/gateway.js";
import type { ClassificationResult, ClassificationSnapshot, ProviderEvaluation, ProviderProfile, SkillClassificationRequestV1, SkillSelectionDecisionV1 } from "../../mcp-server/src/skill-classification/types.js";
import { oracleDigest } from "./evaluation.js";

// SS25 only. SS03/SS09 are embedded SS25 inputs, not independent case runs.
// Real inventory/request/service/gateway; synthetic provider/host observation only.
// Synthetic acceptance and its receipt never constitute real AGENT selection evidence.
const root = fileURLToPath(new URL("../../", import.meta.url));
const corpus = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
const source = (id: string) => corpus.cases.find((x: {caseId: string}) => x.caseId === id);
const rows: unknown[] = [];
function evidence(id: string, expected: string, observed: unknown) { rows.push({ caseId: "SS25", id, expected, observed }); }
afterEach(() => {
  writeFileSync("./ss25-reproduction/isolated-observations.json", JSON.stringify(rows, null, 2) + "\n");
  vi.unstubAllGlobals();
});
function barrier<T>() { let release!: (value: T) => void; const promise = new Promise<T>(resolve => { release = resolve; }); return { promise, release }; }
async function harness() {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("SS25_NETWORK_FORBIDDEN"); }));
  const inventory = await loadSkillInventory({root});
  expect(inventory.issues).toEqual([]);
  const profile: ProviderProfile = {profileId: "ss25-mock-vendor", providerKind: "vendor", vendorId: "ss25-vendor", modelId: "ss25-fixed", modelRevision: "v1", reasoningEffort: "low",
    supportedOptions: {reasoningEfforts: ["low"], structuredOutput: true}, approvedRouteRef: "ss25:synthetic-native", qualificationRevision: "ss25:synthetic-quality",
    qualification: {status: "PASS", inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision, modelRevision: "v1", promptRevision: "p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""},
    adapterRevision: "a1", promptRevision: "p1", maximumInputBytes: 2_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0, judgmentPolicy: null};
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  const runtime: ClassificationRuntimeSnapshot = {config: {jevEnabled: false, mode: "select", providerProfileRegistryRef: "ss25:profiles", externalClassificationAllowed: false, configRevision: "c1", timeoutMs: 2000},
    registry: {schemaVersion: "1.0.0", profileRevision: "p1", profiles: [profile]}, allowRemotePrivateContent: false};
  const evaluation = (request: SkillClassificationRequestV1): ProviderEvaluation => ({response: {schemaVersion: "1.0.0", requestId: request.requestId, operationId: request.operationId,
    requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: "SUCCESS", judgments: request.skills.map(skill => ({skillId: skill.skillId,
      judgment: request.originalPrompt === source("SS03").originalPrompt && source("SS03").oracle.required.includes(skill.skillId) ? "needed" : "not-needed",
      reasonRefs: ["ss25:injected-response-not-model-quality"], uncertaintyReason: null})), unresolvedItems: [], error: null},
    usage: {inputTokens: null, outputTokens: null, cachedInputTokens: null, actualCostUsd: 0}, dispatchState: "started", diagnostics: null});
  const availability = vi.fn(async () => ({available: true, approved: true, routeKind: "native" as const, reasonCode: null}));
  const classify = vi.fn(async (request: SkillClassificationRequestV1, _profile: ProviderProfile, _signal: AbortSignal) => evaluation(request));
  const service = new SkillClassificationService({providers: {vendor: {availability, classify}}, budget: new InMemoryClassificationBudget({jev: {limitUsd: 0, spentUsd: 0}, vendors: {}, nativeAllowances: {[profile.profileId]: {approvalRef: "ss25:synthetic-quota", remainingCalls: 100}}})});
  const intake = (id: string, promptCase: "SS03" | "SS09", revision: string | null) => ({schemaVersion: "1.0.0" as const, requestId: `ss25-${id}`, operationId: `ss25-${id}`,
    originalPrompt: source(promptCase).originalPrompt, confirmedContext: {taskRevision: revision, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null},
    contextSources: revision === null ? [] : [{field: "taskRevision", reference: `ss25:task-revision:${revision}`}], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: {vendorId: "ss25-vendor", reference: "ss25:synthetic-vendor"}, publicSynthetic: true});
  const request = (raw: ReturnType<typeof intake>) => createClassificationRequest({requestId: raw.requestId, operationId: raw.operationId,
    originalPrompt: raw.originalPrompt, confirmedContext: raw.confirmedContext, contextSources: raw.contextSources, inventory, classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md"});
  const input = (req: SkillClassificationRequestV1, getCurrentSnapshot?: () => ClassificationSnapshot, signal?: AbortSignal) => ({request: req, config: runtime.config, registry: runtime.registry, currentVendorId: "ss25-vendor", getCurrentSnapshot, signal});
  const snapshot = (req: SkillClassificationRequestV1): ClassificationSnapshot => ({taskRevision: req.confirmedContext.taskRevision, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest, configRevision: runtime.config.configRevision, profileRevision: runtime.registry.profileRevision, cancelled: false});
  let currentTask: CurrentClassificationTask | null = null;
  const setTask = (req: SkillClassificationRequestV1) => {currentTask = {taskRevision: req.confirmedContext.taskRevision, requestDigest: req.requestDigest, cancelled: false, sourceRef: `ss25:task:${req.confirmedContext.taskRevision}`}; return currentTask;};
  const observeTask = vi.fn(() => currentTask);
  const readRuntime = vi.fn(async () => runtime);
  const gateway = new RuntimeSkillClassificationGateway({root, service, readRuntime, observeTask, observeRuntime: () => digestClassificationValue(runtime), now: () => new Date("2026-10-09T00:00:00Z")});
  const observation = (req: SkillClassificationRequestV1): ExecutionContextV1 => ({schemaVersion: "1.0.0", source: "runtime", model: "synthetic", modelClass: "general", reasoningEffort: "high",
    actorId: "codex:synthetic-SS25", observationId: "ss25:synthetic-observation", taskId: req.requestDigest, observedAt: "2026-10-09T00:00:00Z", expiresAt: "2026-10-09T00:01:00Z"});
  const decision = (result: ClassificationResult): SkillSelectionDecisionV1 => ({schemaVersion: "1.0.0", classificationResponseRef: digestClassificationValue(result.response), ...result.snapshot,
    explicitSkillIds: [], ruleRequiredSkillIds: [], agentSelectedSkillIds: [], selectionReasons: [], applicabilityChecks: [], unresolvedSkillReferences: [], selectionStatus: "SELECTED", adviceApplied: true, hostReceipt: null});
  // Strip snapshot.cancelled: the public decision schema is strict.
  const acceptInput = (result: ClassificationResult) => {const d = decision(result); Reflect.deleteProperty(d, "cancelled"); return {schemaVersion: "1.0.0", operationId: result.request.operationId, decision: d};};
  return {inventory, runtime, profile, availability, classify, evaluation, service, intake, request, input, snapshot, setTask, observeTask, readRuntime, gateway, observation, acceptInput};
}

describe("SS25 isolated offline operational variants", () => {
  it("SS25 reverse-response: B finishes before A and survives A stale completion", async () => {
    const h = await harness(), a = h.request(h.intake("A", "SS03", "1")), bRaw = h.intake("B", "SS09", "2"), b = h.request(bRaw);
    h.setTask(a); const entered = barrier<void>(), delayed = barrier<ProviderEvaluation>();
    h.classify.mockImplementation(async req => {if (req.operationId === a.operationId) {entered.release(); return delayed.promise;} return h.evaluation(req);});
    const pa = h.gateway.classify(h.intake("A", "SS03", "1"), h.observation(a)); await entered.promise;
    h.setTask(b); h.runtime.config.configRevision = "c2";
    const before = await h.gateway.classify(bRaw, h.observation(b));
    const accepted = await h.gateway.accept(h.acceptInput(before.result!), h.observation(b));
    const saved = JSON.stringify(before); delayed.release(h.evaluation(a)); const afterA = await pa;
    const replay = await h.gateway.classify(bRaw, h.observation(b));
    evidence("reverse-response", "A stale; B raw/combined SUCCESS empty-needed survives; synthetic no-skill acceptance []; real selected null", {a: afterA, bBefore: before, bAfter: replay, syntheticAcceptance: accepted, providerRequests: h.classify.mock.calls.map(([req, profile]) => ({request: req, profile}))});
    expect(afterA.result!.response.error?.code).toBe("STALE_CLASSIFICATION"); expect(before.result!.response.status).toBe("SUCCESS");
    expect(before.result!.response.judgments.filter(x => x.judgment === "needed")).toEqual([]); expect(JSON.stringify(before)).toBe(saved);
    expect(replay.result).toEqual(before.result!); expect(before.agentSelectedSkillIds).toBeNull(); expect(replay.agentSelectedSkillIds).toEqual([]);
    expect(accepted.valid).toBe(true); expect(h.classify).toHaveBeenCalledTimes(2); expect(before.result!.snapshot.taskRevision).toBe("2"); expect(before.result!.config.configRevision).toBe("c2");
  });
  it("SS25 digest-cache-collision: changed prompt under same operation/request ID cannot reuse A", async () => {
    const h = await harness(), a = h.request(h.intake("cache", "SS03", "1")), changed = h.request(h.intake("cache", "SS09", "2"));
    const first = await h.service.classify(h.input(a)); const collision = await h.service.classify(h.input(changed)); const replay = await h.service.classify(h.input(a));
    evidence("digest-cache-collision", "OPERATION_DIGEST_CONFLICT; original cache unchanged; 1 mock dispatch", {a, changed, collision, first, replay, dispatchCount: h.classify.mock.calls.length});
    expect(changed.requestDigest).not.toBe(a.requestDigest); expect(collision.response.error?.code).toBe("OPERATION_DIGEST_CONFLICT"); expect(replay).toEqual(first); expect(h.classify).toHaveBeenCalledTimes(1);
  });
  it("SS25 digest-cache-collision: reused request ID with new operation is rejected", async () => {
    const h = await harness(), a = h.request(h.intake("same-request", "SS03", "1")); const raw = h.intake("new-operation", "SS09", "2"); raw.requestId = a.requestId;
    await h.service.classify(h.input(a)); const result = await h.service.classify(h.input(h.request(raw)));
    evidence("digest-cache-request-id", "REQUEST_ID_CONFLICT and no second dispatch", result);
    expect(result.response.error?.code).toBe("REQUEST_ID_CONFLICT"); expect(h.classify).toHaveBeenCalledTimes(1);
  });
  it("SS25 digest-cache-collision: provider response with wrong digest is invalid", async () => {
    const h = await harness(), req = h.request(h.intake("foreign-digest", "SS09", "2")), evaluation = h.evaluation(req);
    evaluation.response.requestDigest = `sha256:${"d".repeat(64)}`; h.classify.mockResolvedValue(evaluation);
    const result = await h.service.classify(h.input(req)); evidence("response-digest", "INVALID_PROVIDER_RESPONSE; no cached foreign success", result);
    expect(result.response.status).toBe("INVALID"); expect(result.response.error?.code).toBe("INVALID_PROVIDER_RESPONSE");
  });
  it("SS25 digest-cache-collision: missing digest holds before dispatch", async () => {
    const h = await harness(), req = h.request(h.intake("missing-digest", "SS09", "2")); Reflect.deleteProperty(req, "requestDigest");
    const result = await h.service.classify(h.input(req)); evidence("missing-digest", "INVALID_CLASSIFICATION_REQUEST; 0 dispatch", result);
    expect(result.response.error?.code).toBe("INVALID_CLASSIFICATION_REQUEST"); expect(h.classify).not.toHaveBeenCalled();
  });
  it("SS25 cancelled-task: cancelled current snapshot holds before dispatch", async () => {
    const h = await harness(), req = h.request(h.intake("cancel-pre", "SS03", "1")), current = {...h.snapshot(req), cancelled: true};
    const result = await h.service.classify(h.input(req, () => current)); evidence("cancel-before-dispatch", "STALE_CLASSIFICATION; 0 availability/dispatch", result);
    expect(result.response.error?.code).toBe("STALE_CLASSIFICATION"); expect(h.availability).not.toHaveBeenCalled(); expect(h.classify).not.toHaveBeenCalled();
  });
  it("SS25 cancelled-task: cancellation during availability blocks dispatch", async () => {
    const h = await harness(), req = h.request(h.intake("cancel-available", "SS03", "1")), current = h.snapshot(req), entered = barrier<void>(), gate = barrier<void>();
    h.availability.mockImplementation(async () => {entered.release(); await gate.promise; return {available: true, approved: true, routeKind: "native", reasonCode: null};});
    const pending = h.service.classify(h.input(req, () => current)); await entered.promise; current.cancelled = true; gate.release(); const result = await pending;
    evidence("cancel-during-availability", "STALE_CLASSIFICATION; 0 dispatch", result); expect(result.response.error?.code).toBe("STALE_CLASSIFICATION"); expect(h.classify).not.toHaveBeenCalled();
  });
  it("SS25 cancelled-task: late completed result and cache replay are held", async () => {
    const h = await harness(), req = h.request(h.intake("cancel-late", "SS03", "1")), current = h.snapshot(req), entered = barrier<void>(), gate = barrier<ProviderEvaluation>();
    h.classify.mockImplementation(async () => {entered.release(); return gate.promise;}); const pending = h.service.classify(h.input(req, () => current)); await entered.promise;
    current.cancelled = true; gate.release(h.evaluation(req)); const first = await pending, replay = await h.service.classify(h.input(req, () => current));
    evidence("cancel-late-and-replay", "STALE_CLASSIFICATION both times, one dispatch", {first, replay});
    expect(first.response.error?.code).toBe("STALE_CLASSIFICATION"); expect(replay.response.error?.code).toBe("STALE_CLASSIFICATION"); expect(h.classify).toHaveBeenCalledTimes(1);
  });
  it("SS25 cancelled-task: aborted in-flight signal never publishes late advice", async () => {
    const h = await harness(), req = h.request(h.intake("cancel-signal", "SS03", "1")), controller = new AbortController(), entered = barrier<void>(), gate = barrier<ProviderEvaluation>();
    h.classify.mockImplementation(async () => {entered.release(); return gate.promise;}); const pending = h.service.classify(h.input(req, undefined, controller.signal)); await entered.promise; controller.abort();
    const result = await pending, saved = JSON.stringify(result); gate.release(h.evaluation(req)); await Promise.resolve(); await Promise.resolve();
    evidence("cancel-abort-signal", "STALE_CLASSIFICATION and late result cannot overwrite", result);
    expect(result.response.error?.code).toBe("STALE_CLASSIFICATION"); expect(JSON.stringify(result)).toBe(saved);
  });
  it("SS25 cancelled-task: cancellation before synthetic accept rejects selection", async () => {
    const h = await harness(), raw = h.intake("cancel-accept", "SS09", "2"), req = h.request(raw), task = h.setTask(req), advice = await h.gateway.classify(raw, h.observation(req));
    task.cancelled = true; const accepted = await h.gateway.accept(h.acceptInput(advice.result!), h.observation(req));
    evidence("cancel-before-accept", "invalid HOST_TASK_CHANGED_OR_NOT_OBSERVED with null selected", accepted);
    expect(accepted.valid).toBe(false); expect(accepted.agentSelectedSkillIds).toBeNull();
  });
  it("SS25 missing taskRevision must hold synthetic acceptance", async () => {
    const h = await harness(), raw = h.intake("null-revision", "SS09", null), req = h.request(raw); h.setTask(req);
    const advice = await h.gateway.classify(raw, h.observation(req)), accepted = await h.gateway.accept(h.acceptInput(advice.result!), h.observation(req));
    evidence("null-task-revision", "revision absent => adoption held per embedded SS25 sourceSpec", {request: req, advice, syntheticAcceptance: accepted});
    expect(accepted.valid, "SS25 missing taskRevision must prevent adoption").toBe(false);
  });
  it.each(["taskRevision", "requestDigest"] as const)("SS25 initial observed %s conflict must hold synthetic acceptance", async field => {
    const h = await harness(), raw = h.intake(`initial-${field}`, "SS09", "2"), req = h.request(raw), task = h.setTask(req);
    task[field] = field === "taskRevision" ? "1" : `sha256:${"a".repeat(64)}`;
    const advice = await h.gateway.classify(raw, h.observation(req)), accepted = await h.gateway.accept(h.acceptInput(advice.result!), h.observation(req));
    evidence(`initial-${field}-conflict`, "observed task and request conflict => adoption held", {request: req, observedTask: task, advice, syntheticAcceptance: accepted});
    expect(accepted.valid, "SS25 conflicting initial host binding must prevent adoption").toBe(false);
  });
  it.each(["cancelled", "taskRevision", "requestDigest"] as const)("SS25 %s changes during synthetic accept await must hold", async field => {
    const h = await harness(), raw = h.intake(`race-${field}`, "SS09", "2"), req = h.request(raw), task = h.setTask(req), advice = await h.gateway.classify(raw, h.observation(req));
    const entered = barrier<void>(), gate = barrier<void>(); h.readRuntime.mockImplementationOnce(async () => {entered.release(); await gate.promise; return h.runtime;});
    const pending = h.gateway.accept(h.acceptInput(advice.result!), h.observation(req)); await entered.promise;
    if (field === "cancelled") task.cancelled = true; else task[field] = field === "taskRevision" ? "3" : `sha256:${"b".repeat(64)}`;
    gate.release(); const accepted = await pending;
    evidence(`accept-race-${field}`, "changed task after initial host check but before commit => adoption held", {changedTask: task, syntheticAcceptance: accepted});
    expect(accepted.valid, "SS25 must recheck current task immediately before selection write").toBe(false);
  });
  it("SS25 fixture/oracle binding only, no invented operational accuracy score", () => {
    evidence("frozen-binding", "SS25 originalPrompt/oracle null; 3 variants; frozen oracle matches", source("SS25"));
    expect(source("SS25").originalPrompt).toBeNull(); expect(source("SS25").oracle).toBeNull();
    expect(source("SS25").variants).toEqual(["reverse-response", "digest-cache-collision", "cancelled-task"]);
    expect(oracleDigest(corpus)).toBe("sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055");
  });
});
