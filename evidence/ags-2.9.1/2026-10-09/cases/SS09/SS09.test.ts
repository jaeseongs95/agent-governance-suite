import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { RuntimeSkillClassificationGateway, readClassificationRuntime } from "../../mcp-server/src/skill-classification/gateway.js";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import { createClassificationRequest, digestClassificationValue, projectClassificationRequest } from "../../mcp-server/src/skill-classification/request.js";
import { digestProviderProfileConfiguration } from "../../mcp-server/src/skill-classification/profiles.js";
import { ClassificationProviderError, buildVendorMessages } from "../../mcp-server/src/skill-classification/providers.js";
import { InMemoryClassificationBudget, SkillClassificationService, type ClassificationServiceInput } from "../../mcp-server/src/skill-classification/service.js";
import type { ProviderEvaluation, ProviderProfile, SkillClassificationRequestV1, SkillInventory } from "../../mcp-server/src/skill-classification/types.js";
import { oracleDigest, scoreCase, sameSet, type Observation } from "../skill-classification/evaluation.js";

// SS09 ONLY. Real request/inventory/service/gateway/MCP; provider responses are synthetic.
// Never issue/sign a host receipt. These tests cannot establish provider/host-live quality.
const root = ".";
const output = "./SS09-evidence";
const corpus = JSON.parse(await readFile(`${root}/tests/skill-classification/fixtures.json`, "utf8"));
const fixture = corpus.cases.find((c: { caseId: string }) => c.caseId === "SS09");
let inventory: SkillInventory;
const traces: unknown[] = [];
const cleanup: (() => Promise<void>)[] = [];
let fetchGuard: ReturnType<typeof vi.fn>;
beforeAll(async () => {
  inventory = await loadSkillInventory({ root });
  fetchGuard = vi.fn(() => { throw new Error("SS09_NETWORK_FORBIDDEN"); });
  vi.stubGlobal("fetch", fetchGuard);
});
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.useRealTimers(); });
afterAll(async () => {
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/SS09.observed.json`, JSON.stringify({ caseId: "SS09", fixture,
    inventory, traces, actualExternalApiCalls: 0, guardedFetchCalls: fetchGuard.mock.calls.length,
    agentSelectedSkillIds: null, hostReceipt: null, selected: "NOTRUN", read: "NOTRUN", applied: "NOTRUN", verified: "NOTRUN" }, null, 2));
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
function observation(skillIds: string[] | null, layer: Observation["layer"] = "vendorRaw"): Observation {
  return { caseId: "SS09", layer, state: "PASS", skillIds, selectionStatus: skillIds === null ? "NEEDS_INPUT" : "SELECTED",
    reasonCodes: [], selectionReasons: [], executionKind: "offline-mock", host: null, hostReceipt: null,
    requestDigest: "offline-only", inventoryDigest: inventory.inventoryDigest, conditionDigest: "offline-only",
    stageEvidence: { read: false, applied: false, verified: false } };
}
function setup(id: string) {
  const request = createClassificationRequest({ requestId: `SS09-${id}`, operationId: `SS09-${id}`,
    originalPrompt: fixture.originalPrompt, inventory,
    classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md" });
  const profile: ProviderProfile = { profileId: "SS09-offline-only", providerKind: "vendor", vendorId: "offline-fixture",
    modelId: "synthetic-not-a-model", modelRevision: "synthetic-v1", reasoningEffort: "low",
    supportedOptions: { reasoningEfforts: ["low"], structuredOutput: true }, approvedRouteRef: "fixture:no-external-route",
    qualificationRevision: "synthetic-not-production-qualification", qualification: { status: "PASS", inventoryDigest: request.inventoryDigest,
      taxonomyRevision: request.taxonomyRevision, modelRevision: "synthetic-v1", promptRevision: "synthetic-v1",
      validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: "" }, adapterRevision: "synthetic-v1", promptRevision: "synthetic-v1",
    maximumInputBytes: 2_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: null };
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  const input: ClassificationServiceInput = { request, currentVendorId: "offline-fixture", config: { jevEnabled: false, mode: "select",
    providerProfileRegistryRef: "fixture:profiles", externalClassificationAllowed: false, configRevision: "synthetic-v1", timeoutMs: 2000 },
    registry: { schemaVersion: "1.0.0" as const, profileRevision: "synthetic-v1", profiles: [profile] } };
  const budget = new InMemoryClassificationBudget({ jev: { limitUsd: 0, spentUsd: 0 }, vendors: { "offline-fixture": { limitUsd: 2, spentUsd: 0 } },
    nativeAllowances: { [profile.profileId]: { approvalRef: "fixture:synthetic-quota", remainingCalls: 20 } } });
  const evaluation = (req: SkillClassificationRequestV1 = request): ProviderEvaluation => ({ response: {
    schemaVersion: "1.0.0", requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest,
    inventoryDigest: req.inventoryDigest, status: "SUCCESS", judgments: req.skills.map(s => ({ skillId: s.skillId, judgment: "not-needed",
      reasonRefs: ["fixture:SS09-general-explanation-no-design-implementation-audit"], uncertaintyReason: null })), unresolvedItems: [], error: null },
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, actualCostUsd: 0.1 }, dispatchState: "started", diagnostics: null });
  const vendor = { availability: vi.fn(async () => ({ available: true, approved: true, routeKind: "native" as const, reasonCode: null })),
    classify: vi.fn(async (req: SkillClassificationRequestV1) => evaluation(req)) };
  const jev = { availability: vi.fn(async () => { throw new Error("SS09_JEV_FORBIDDEN"); }),
    classify: vi.fn(async () => { throw new Error("SS09_JEV_FORBIDDEN"); }) };
  const service = new SkillClassificationService({ providers: { vendor, jev }, budget });
  const run = async (expected: unknown) => {
    const result = await service.classify(input);
    const rawProviderEvaluations = await Promise.all(vendor.classify.mock.results.map(async call => {
      try { return await call.value; }
      catch (error) { return { rejected: true, code: error instanceof ClassificationProviderError ? error.code : "unexpected-test-error" }; }
    }));
    traces.push({ id, kind: "new-offline-boundary", input, expected, observed: result, budget: budget.snapshot(),
      rawProviderEvaluations, mockVendorDispatches: vendor.classify.mock.calls.length, actualExternalApiCalls: 0 });
    expect(jev.availability).not.toHaveBeenCalled(); expect(jev.classify).not.toHaveBeenCalled();
    return result;
  };
  return { input, profile, budget, vendor, service, evaluation, run };
}
async function mcpHarness(id: string) {
  const f = setup(id);
  const runtime = { config: f.input.config, registry: f.input.registry, allowRemotePrivateContent: false };
  const gateway = new RuntimeSkillClassificationGateway({ root, service: f.service, readRuntime: async () => runtime });
  const validator = new ContractValidator();
  const workflow = new WorkflowService(new FileSkillRegistry(`${root}/skills/registry.json`, validator), validator, new InMemoryWorkflowStore());
  const updates = new PluginUpdateService(new InMemoryPluginUpdateStore(), { fetcher: fetch });
  const server = createMcpServer(workflow, updates, undefined, undefined, undefined, validator, "default", null, null, undefined, null, gateway);
  const client = new Client({ name: "SS09-offline-test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  cleanup.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown>) => {
    const raw = await client.callTool({ name, arguments: args });
    return JSON.parse((raw.content as { type: string; text?: string }[]).find(c => c.type === "text")!.text!);
  };
  const args = { schemaVersion: "1.0.0", requestId: f.input.request.requestId, operationId: f.input.request.operationId,
    originalPrompt: fixture.originalPrompt, confirmedContext: f.input.request.confirmedContext, contextSources: [],
    explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: { vendorId: "offline-fixture", reference: "fixture:offline-only" }, publicSynthetic: true };
  return { ...f, call, args };
}
describe("SS09 frozen base and isolated boundaries; API zero; host NOTRUN", () => {
  it("SS09/base frozen commit fixture oracle and skill sources remain bound", async () => {
    const bytes = await readFile(`${root}/tests/skill-classification/fixtures.json`);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9");
    expect(oracleDigest(corpus)).toBe("sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055");
    expect(fixture.variants).toEqual(["base"]); expect(fixture.oracle.required).toEqual([]); expect(fixture.oracle.allowed).toEqual([]);
    expect(inventory.issues).toEqual([]); expect(inventory.skills.map(s => s.skillId).sort()).toEqual([...corpus.inventorySkillIds].sort());
    for (const ref of fixture.oracle.sourceRefs) expect(`sha256:${createHash("sha256").update(await readFile(`${root}/${ref.path}`)).digest("hex")}`).toBe(ref.digest);
    traces.push({ id: "frozen-binding", kind: "static", expected: { variants: ["base"], required: [], allowed: [] }, observed: fixture, actualExternalApiCalls: 0 });
  });
  it("SS09/base actual MCP preserves full prompt, negation, inventory and unknown context; advice is not selection", async () => {
    const f = await mcpHarness("base");
    const observed = await f.call("classify_skills", f.args);
    traces.push({ id: "base", kind: "offline-mock-MCP", input: f.args, expected: { providerOutcome: "SUCCESS", needed: [], agentSelectedSkillIds: null }, observed,
      transmitted: f.vendor.classify.mock.calls[0]?.[0], actualExternalApiCalls: 0 });
    expect(observed.error).toBeNull(); expect(observed.data.result.response.status).toBe("SUCCESS");
    expect(observed.data.result.response.error).toBeNull(); expect(observed.data.result.response.judgments).toHaveLength(24);
    expect(observed.data.result.response.judgments.filter((j: { judgment: string }) => j.judgment !== "not-needed")).toEqual([]);
    expect(f.vendor.classify.mock.calls[0]![0].originalPrompt).toBe(fixture.originalPrompt);
    expect(f.vendor.classify.mock.calls[0]![0].skills).toEqual(inventory.skills);
    expect(Object.values(f.vendor.classify.mock.calls[0]![0].confirmedContext)).toEqual(Array(7).fill(null));
    expect(observed.data.agentSelectedSkillIds).toBeNull(); expect(observed.data.selectionStatus).toBe("PROPOSED");
    expect(observed.data.adviceApplied).toBe(false); expect(f.vendor.classify).toHaveBeenCalledTimes(1);
  });
  it("SS09/regression empty and null retain different oracle outcomes without a invented receipt", () => {
    expect(sameSet(null, [])).toBe(false);
    const empty = scoreCase(fixture, observation([]), corpus.inventorySkillIds);
    const absent = scoreCase(fixture, observation(null), corpus.inventorySkillIds);
    const unsigned = scoreCase(fixture, observation([], "selected"), corpus.inventorySkillIds);
    traces.push({ id: "null-empty", kind: "isolated-existing-regression-assertions", expected: { empty: "PASS", absent: "FAIL", unsigned: "FAIL" }, observed: { empty, absent, unsigned } });
    expect(empty.verdict).toBe("PASS"); expect(absent.verdict).toBe("FAIL");
    expect(unsigned.reasons).toContain("HOST_SELECTION_RECEIPT_MISSING_OR_MISMATCH");
  });
  it.each(fixture.oracle.forbidden as string[])("SS09/new keyword-only advice %s is detected by the frozen oracle", (skillId: string) => {
    const observed = scoreCase(fixture, observation([skillId]), corpus.inventorySkillIds);
    traces.push({ id: `keyword-${skillId}`, kind: "new-offline-oracle-negative-control", input: { originalPrompt: fixture.originalPrompt, syntheticAdvice: [skillId] }, expected: "FAIL", observed });
    expect(observed.verdict).toBe("FAIL"); expect(observed.forbidden).toContain(skillId);
  });
  it("SS09/evaluator overlap must count a single selected skill as one false positive", () => {
    const observed = scoreCase(fixture, observation(["test-engineering"]), corpus.inventorySkillIds);
    traces.push({ id: "evaluator-overlap", kind: "new-offline-evaluator-negative-control",
      input: { selected: ["test-engineering"], forbidden: fixture.oracle.forbidden, notApplicable: fixture.oracle.notApplicable },
      expected: { verdict: "FAIL", falsePositives: 1 }, observed });
    expect(observed.verdict).toBe("FAIL"); expect(observed.falsePositives).toBe(1);
  });
  it("SS09/new compact vendor payload preserves negation and null versus confirmed empty", () => {
    const f = setup("projection");
    const payload = projectClassificationRequest(f.input.request).payload;
    const messages = buildVendorMessages(f.input.request);
    const explicitEmpty = createClassificationRequest({ requestId: "SS09-empty", operationId: "SS09-empty", originalPrompt: fixture.originalPrompt,
      inventory, confirmedContext: { actions: [] }, contextSources: [{ field: "actions", reference: "fixture:SS09-known-empty-test" }], classificationCriteriaRef: "criteria" });
    traces.push({ id: "projection", kind: "new-offline-boundary", input: f.input.request, expected: { exactPrompt: fixture.originalPrompt, fullInventory: 24, actions: null }, observed: { payload, messages, explicitEmpty } });
    expect(payload.originalPrompt).toBe(fixture.originalPrompt); expect(payload.skills).toHaveLength(24); expect(payload.confirmedContext.actions).toBeNull();
    expect(projectClassificationRequest(explicitEmpty).payload.confirmedContext.actions).toEqual([]);
    expect(JSON.stringify(messages)).toContain(fixture.originalPrompt); expect(f.input.request).not.toHaveProperty("oracle");
  });
  it.each(["AUTH_UNAVAILABLE", "API_UNAVAILABLE"])("SS09/new %s remains failure and never valid empty advice", async code => {
    const f = setup(code); f.vendor.classify.mockRejectedValue(new ClassificationProviderError(code, "started"));
    const r = await f.run({ status: "UNAVAILABLE", errorCode: code, semanticNoSkill: false });
    expect(r.response.status).toBe("UNAVAILABLE"); expect(r.response.error?.code).toBe(code); expect(r.response.judgments).toEqual([]);
  });
  it.each(["empty-success", "wrong-binding", "reason-missing"])("SS09/new malformed %s is INVALID, never no-skill", async variant => {
    const f = setup(variant), e = f.evaluation();
    if (variant === "empty-success") e.response.judgments = [];
    else if (variant === "wrong-binding") e.response.requestDigest = `sha256:${"0".repeat(64)}`;
    else e.response.judgments[0]!.reasonRefs = [];
    f.vendor.classify.mockResolvedValue(e);
    const r = await f.run({ status: "INVALID", errorCode: "INVALID_PROVIDER_RESPONSE", semanticNoSkill: false });
    expect(r.response.status).toBe("INVALID"); expect(r.response.error?.code).toBe("INVALID_PROVIDER_RESPONSE");
  });
  it("SS09/new semantic uncertainty is not converted to no-skill", async () => {
    const f = setup("uncertain"), e = f.evaluation();
    e.response.status = "UNCERTAIN"; e.response.judgments[0]!.judgment = "uncertain";
    e.response.judgments[0]!.uncertaintyReason = "synthetic unresolved classification";
    e.response.unresolvedItems = [{ skillId: e.response.judgments[0]!.skillId, reasonCode: "SYNTHETIC_UNCERTAINTY" }];
    f.vendor.classify.mockResolvedValue(e);
    const r = await f.run({ status: "UNCERTAIN", error: null, unresolvedItems: 1, semanticNoSkill: false });
    expect(r.response.status).toBe("UNCERTAIN"); expect(r.response.error).toBeNull(); expect(r.response.unresolvedItems).toHaveLength(1);
  });
  it("SS09/new unset installation config is UNAVAILABLE; no arbitrary default model", async () => {
    const f = setup("unconfigured"), runtime = await readClassificationRuntime(undefined, root);
    f.input.registry = runtime.registry; f.input.config = runtime.config;
    const r = await f.run({ status: "UNAVAILABLE", errorCode: "PROFILE_UNAVAILABLE", mockVendorDispatches: 0 });
    expect(r.response.error?.code).toBe("PROFILE_UNAVAILABLE"); expect(f.vendor.classify).not.toHaveBeenCalled();
  });
  it("SS09/new unsigned empty AGENT decision is rejected; selected remains null", async () => {
    const f = await mcpHarness("unsigned"), advice = (await f.call("classify_skills", f.args)).data;
    const snapshot = advice.result.snapshot;
    const decision = { schemaVersion: "1.0.0", classificationResponseRef: advice.classificationResponseRef, ...snapshot,
      explicitSkillIds: [], ruleRequiredSkillIds: [], agentSelectedSkillIds: [], selectionReasons: [], applicabilityChecks: [],
      unresolvedSkillReferences: [], selectionStatus: "SELECTED", adviceApplied: true, hostReceipt: null };
    delete (decision as Record<string, unknown>).cancelled;
    const observed = await f.call("record_skill_selection", { schemaVersion: "1.0.0", operationId: f.args.operationId, decision });
    traces.push({ id: "unsigned-selection", kind: "new-offline-MCP-negative-control", input: decision,
      expected: { valid: false, errors: ["HOST_SELECTION_NOT_OBSERVED"], agentSelectedSkillIds: null }, observed });
    expect(observed.data).toMatchObject({ valid: false, errors: ["HOST_SELECTION_NOT_OBSERVED"], agentSelectedSkillIds: null });
  });
  it("SS09/known-defect invalid RESP must retain independently valid charged cost", async () => {
    const f = setup("cost-loss"), e = f.evaluation(); e.response.judgments = []; f.vendor.classify.mockResolvedValue(e);
    const r = await f.run({ status: "INVALID", actualCostUsd: 0.1, spentUsd: 0.1, outstandingReservations: 0 });
    expect(r.response.error?.code).toBe("INVALID_PROVIDER_RESPONSE");
    expect.soft(r.attempts[0]!.usage.actualCostUsd).toBe(0.1);
    expect.soft(f.budget.snapshot().limits["vendor:offline-fixture"]!.spentUsd).toBe(0.1);
    expect.soft(f.budget.snapshot().reservations).toHaveLength(0);
  });
  it("SS09/known-defect accepted large timeout must not expire after one millisecond", async () => {
    vi.useFakeTimers(); const f = setup("timeout-overflow"); f.input.config.timeoutMs = 2_147_483_648;
    f.vendor.classify.mockImplementation(async req => { await new Promise(resolve => setTimeout(resolve, 5)); return f.evaluation(req); });
    const pending = f.run({ status: "SUCCESS", error: null, timeoutMs: 2_147_483_648, providerDelayMs: 5 });
    await vi.advanceTimersByTimeAsync(10);
    const r = await pending;
    expect(r.response.status).toBe("SUCCESS"); expect(r.response.error).toBeNull();
  });
  it("SS09/known-defect real Node timer independently confirms timeout overflow", async () => {
    const f = setup("timeout-overflow-real-node"); f.input.config.timeoutMs = 2_147_483_648;
    const warnings: { name: string; message: string }[] = [];
    const onWarning = (w: Error) => { warnings.push({ name: w.name, message: w.message }); };
    process.on("warning", onWarning);
    try {
      f.vendor.classify.mockImplementation(async req => { await new Promise(resolve => setTimeout(resolve, 25)); return f.evaluation(req); });
      const r = await f.run({ status: "SUCCESS", error: null, timeoutMs: 2_147_483_648, providerDelayMs: 25, timer: "real Node" });
      traces.push({ id: "real-node-overflow-warning", kind: "new-offline-real-clock", expected: { noOverflow: true }, observed: warnings });
      expect(r.response.status).toBe("SUCCESS"); expect(r.response.error).toBeNull();
    } finally {
      process.removeListener("warning", onWarning);
      // Let the synthetic provider complete before closing the file's evidence.
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  });
});
