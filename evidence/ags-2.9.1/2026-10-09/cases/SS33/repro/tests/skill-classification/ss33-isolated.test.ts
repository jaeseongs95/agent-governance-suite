import {afterAll, afterEach, describe, expect, it, vi} from "vitest";
import {readFileSync, writeFileSync} from "node:fs";
import {InMemoryClassificationBudget, SkillClassificationService, type ClassificationServiceInput} from "../../mcp-server/src/skill-classification/service.js";
import {ApprovedRouteClassificationProvider, ClassificationProviderError, jevNoulWireAdapter, unknownUsage, type ApprovedClassificationRoute} from "../../mcp-server/src/skill-classification/providers.js";
import {createClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import {RuntimeSkillClassificationGateway} from "../../mcp-server/src/skill-classification/gateway.js";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import type {ProviderEvaluation, ProviderProfile, SkillClassificationRequestV1} from "../../mcp-server/src/skill-classification/types.js";

// SS33 only. Synthetic input is permitted locally; no external API, host CLI,
// selection/attestation receipt, bootstrap run, or production change occurs.
const evidenceRoot = process.env.SS33_EVIDENCE_ROOT ?? process.cwd();
const inputs = JSON.parse(readFileSync(`${evidenceRoot}/input-fixtures.json`, "utf8"));
const observations: {variant: string; boundary: string; input: unknown; expected: unknown; observed: unknown}[] = [];
const record = (variant: string, boundary: string, input: unknown, expected: unknown, observed: unknown) => observations.push({variant, boundary, input, expected, observed});
const occurrences = (value: unknown) => JSON.stringify(value).split(inputs.sentinel).length - 1;
const publicPrompt = "공개 합성 읽기 전용 검토";
function fixture(options: {jev?: boolean; spent?: number | null; vendorLimit?: number | null; vendorSpent?: number | null; vendorPresent?: boolean; external?: boolean; prompt?: string} = {}) {
  const request = createClassificationRequest({requestId: "ss33-r1", operationId: "ss33-o1", originalPrompt: options.prompt ?? publicPrompt,
    inventory: {skills: [{skillId: "review", version: "1", description: "고정 변경 검토", enabled: true, installed: true, hostSupported: true, capabilities: ["review"], actions: ["review"], targets: ["diff"], constraints: ["read-only"], applicability: ["fixed diff"], exclusions: ["implementation"], dependencies: [], phases: [], sourceRefs: []}], issues: [], inventoryDigest: `sha256:${"a".repeat(64)}`, taxonomyRevision: "t1"}, classificationCriteriaRef: "criteria"});
  const profile = (kind: "jev" | "vendor"): ProviderProfile => {
    const p: ProviderProfile = {profileId: kind, providerKind: kind, vendorId: kind === "jev" ? "typesafe" : "current-vendor", modelId: `${kind}-fixed`, modelRevision: `${kind}-fixed`, reasoningEffort: kind === "jev" ? null : "low", supportedOptions: {reasoningEfforts: kind === "jev" ? [null] : ["low"], structuredOutput: true}, approvedRouteRef: `${kind}-route`, qualificationRevision: "synthetic-q1", qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: request.taxonomyRevision, modelRevision: `${kind}-fixed`, promptRevision: "p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}, adapterRevision: "a1", promptRevision: "p1", maximumInputBytes: 2_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: kind === "jev" ? {neededAt: 0.8, notNeededAt: 0.2} : null};
    requalify(p); return p;
  };
  const input: ClassificationServiceInput = {request, config: {jevEnabled: options.jev ?? true, mode: "select", providerProfileRegistryRef: "synthetic-profiles", externalClassificationAllowed: options.external ?? true, configRevision: "c1", timeoutMs: 1000}, registry: {schemaVersion: "1.0.0", profileRevision: "pr1", profiles: [profile("jev"), profile("vendor")]}, currentVendorId: "current-vendor"};
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 100, spentUsd: options.spent === undefined ? 0 : options.spent}, vendors: options.vendorPresent === false ? {} : {"current-vendor": {limitUsd: options.vendorLimit === undefined ? 2 : options.vendorLimit, spentUsd: options.vendorSpent === undefined ? 0 : options.vendorSpent}}});
  const evaluation = (req: SkillClassificationRequestV1 = request): ProviderEvaluation => ({response: {schemaVersion: "1.0.0", requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest, status: "SUCCESS", judgments: req.skills.map(skill => ({skillId: skill.skillId, judgment: "needed", reasonRefs: ["fixture:synthetic"], uncertaintyReason: null})), unresolvedItems: [], error: null}, usage: {...unknownUsage(), actualCostUsd: 0.1}, dispatchState: "started", diagnostics: null});
  const provider = () => ({availability: vi.fn(async () => ({available: true, approved: true, routeKind: "remote" as const, reasonCode: null})), classify: vi.fn(async (req: SkillClassificationRequestV1) => evaluation(req))});
  const jev = provider(), vendor = provider();
  return {request, input, profile, budget, evaluation, jev, vendor, service: new SkillClassificationService({providers: {jev, vendor}, budget})};
}
function requalify(p: ProviderProfile) { p.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(p); }
function secondInput(f: ReturnType<typeof fixture>): ClassificationServiceInput {
  return {...f.input, request: createClassificationRequest({requestId: "ss33-r2", operationId: "ss33-o2", originalPrompt: publicPrompt, inventory: {skills: f.request.skills, issues: [], inventoryDigest: f.request.inventoryDigest, taxonomyRevision: f.request.taxonomyRevision}, classificationCriteriaRef: "criteria"})};
}
afterEach(() => vi.useRealTimers());
afterAll(() => writeFileSync(`${evidenceRoot}/isolated-observations.json`, JSON.stringify({caseId: "SS33", executionKind: "offline-mock", apiCalls: {jev: 0, externalVendor: 0, claude: 0}, agentSelectedSkillIds: null, selected: "NOTRUN", read: "NOTRUN", applied: "NOTRUN", verified: "NOTRUN", observations}, null, 2) + "\n"));

describe("SS33 isolated operational variants", () => {
  it("secret-sentinel: HTTP body and authorization are omitted from errors", async () => {
    const f = fixture(); const p = f.input.registry.profiles[0]!;
    const fetcher = vi.fn<typeof fetch>(async (_endpoint, init) => {
      expect((init?.headers as Record<string, string>).authorization === inputs.authorization).toBe(true);
      return new Response(inputs.errorBody, {status: 401});
    });
    const provider = new ApprovedRouteClassificationProvider([{routeRef: p.approvedRouteRef, approvalRef: "synthetic-approval", approved: true, providerKind: "jev", vendorId: p.vendorId, adapterRevision: p.adapterRevision, modelIds: [p.modelId], reasoningEfforts: [null], structuredOutput: true, kind: "remote", endpoint: "https://approved.example.invalid", getCredential: async () => inputs.sentinel, adapter: jevNoulWireAdapter}], fetcher);
    const error = await provider.classify(f.request, p, new AbortController().signal).catch((e: unknown) => e);
    const observed = {sentinelOccurrences: occurrences(error), calls: fetcher.mock.calls.length, code: (error as ClassificationProviderError).code};
    record("secret-sentinel", "provider HTTP401/header", {syntheticInputRef: "input-fixtures.json", prompt: "public", errorBody: "synthetic-secret", header: "synthetic-secret"}, {sentinelOccurrences: 0, calls: 1, code: "AUTH_UNAVAILABLE"}, observed);
    expect(observed).toEqual({sentinelOccurrences: 0, calls: 1, code: "AUTH_UNAVAILABLE"});
  });

  it("secret-sentinel: unapproved private content is held before provider", async () => {
    const f = fixture();
    const gateway = new RuntimeSkillClassificationGateway({root: process.cwd(), service: f.service, readRuntime: async () => ({config: f.input.config, registry: f.input.registry, allowRemotePrivateContent: false})});
    const result = await gateway.classify({schemaVersion: "1.0.0", requestId: "private-r", operationId: "private-o", originalPrompt: inputs.task, confirmedContext: f.request.confirmedContext, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: {vendorId: "current-vendor", reference: "synthetic"}, publicSynthetic: true});
    const observed = {sentinelOccurrences: occurrences(result), result, jevCalls: f.jev.classify.mock.calls.length, vendorCalls: f.vendor.classify.mock.calls.length};
    record("secret-sentinel", "gateway content approval", {syntheticInputRef: "input-fixtures.json", publicSynthetic: true, approvedPublicRequestDigests: null, allowRemotePrivateContent: false}, {sentinelOccurrences: 0, response: null, agentSelectedSkillIds: null, providerCalls: 0}, observed);
    expect(result).toMatchObject({status: "NEEDS_INPUT", response: null, agentSelectedSkillIds: null, errors: ["REMOTE_CONTENT_NOT_APPROVED"]});
    expect(observed.sentinelOccurrences).toBe(0); expect(observed.jevCalls + observed.vendorCalls).toBe(0);
  });

  it("secret-sentinel: egress-blocked gateway response must not echo task secret", async () => {
    const f = fixture({external: false}); const inventory = await loadSkillInventory({root: process.cwd()});
    for (const p of f.input.registry.profiles) {p.qualification.inventoryDigest = inventory.inventoryDigest; p.qualification.taxonomyRevision = inventory.taxonomyRevision; requalify(p);}
    const gateway = new RuntimeSkillClassificationGateway({root: process.cwd(), service: f.service, readRuntime: async () => ({config: f.input.config, registry: f.input.registry, allowRemotePrivateContent: false})});
    const result = await gateway.classify({schemaVersion: "1.0.0", requestId: "secret-r", operationId: "secret-o", originalPrompt: inputs.task, confirmedContext: f.request.confirmedContext, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: {vendorId: "current-vendor", reference: "synthetic"}, publicSynthetic: false});
    const observed = {sentinelOccurrences: occurrences(result), leakedField: "result.request.originalPrompt", jevCalls: f.jev.classify.mock.calls.length, vendorCalls: f.vendor.classify.mock.calls.length, agentSelectedSkillIds: (result as {agentSelectedSkillIds: unknown}).agentSelectedSkillIds};
    record("secret-sentinel", "gateway response task echo", {syntheticInputRef: "input-fixtures.json", externalClassificationAllowed: false}, {sentinelOccurrences: 0, providerCalls: 0, agentSelectedSkillIds: null}, observed);
    expect(observed.jevCalls + observed.vendorCalls).toBe(0); expect(observed.agentSelectedSkillIds).toBeNull();
    expect(observed.sentinelOccurrences).toBe(0);
  });

  it("jev-budget: prior usage and hard five dollar cap block insufficient balance", async () => {
    const f = fixture({spent: 4.7, vendorPresent: false}); const result = await f.service.classify(f.input);
    const observed = {jevLimitUsd: f.budget.snapshot().limits.jev.limitUsd, jevSpentUsd: f.budget.snapshot().limits.jev.spentUsd, providerCalls: f.jev.classify.mock.calls.length + f.vendor.classify.mock.calls.length, attemptCodes: result.attempts.map(x => x.errorCode), reservations: f.budget.snapshot().reservations.length};
    record("jev-budget", "prior spend", {configuredLimitUsd: 100, priorSpentUsd: 4.7, upperBoundUsd: 0.4, vendorBudget: null}, {jevLimitUsd: 5, providerCalls: 0, reservations: 0}, observed);
    expect(observed).toMatchObject({jevLimitUsd: 5, jevSpentUsd: 4.7, providerCalls: 0, attemptCodes: ["BUDGET_UNAVAILABLE", "BUDGET_UNAVAILABLE"], reservations: 0});
  });

  it("jev-budget: exact boundary is allowed and actual usage is accumulated", async () => {
    const f = fixture({spent: 4.6}); await f.service.classify(f.input);
    const observed = {spentUsd: f.budget.snapshot().limits.jev.spentUsd, reservations: f.budget.snapshot().reservations.length, jevCalls: f.jev.classify.mock.calls.length, vendorCalls: f.vendor.classify.mock.calls.length};
    record("jev-budget", "exact boundary and settlement", {priorSpentUsd: 4.6, upperBoundUsd: 0.4, actualCostUsd: 0.1}, {spentUsd: 4.7, reservations: 0, jevCalls: 1, vendorCalls: 0}, observed);
    expect(observed.spentUsd).toBeCloseTo(4.7); expect(observed).toMatchObject({reservations: 0, jevCalls: 1, vendorCalls: 0});
  });

  it("jev-budget: invalid RESP must retain independently valid actual cost and ceiling overrun", async () => {
    const f = fixture({spent: 4.1, vendorPresent: false});
    f.jev.classify.mockImplementation(async req => ({...f.evaluation(req), response: {...f.evaluation(req).response, judgments: []}, usage: {...unknownUsage(), actualCostUsd: 0.7}}));
    const first = await f.service.classify(f.input), second = await f.service.classify(secondInput(f));
    const observed = {firstErrorCode: first.attempts[0]?.errorCode, firstActualCostUsd: first.attempts[0]?.usage.actualCostUsd, spentUsd: f.budget.snapshot().limits.jev.spentUsd, reservedUsd: f.budget.snapshot().reservations.reduce((s, r) => s + r.maximumUsd, 0), invalidCostCeilings: f.budget.snapshot().invalidCostCeilings, jevCalls: f.jev.classify.mock.calls.length, secondErrorCode: second.attempts[0]?.errorCode, suppliedActualCumulativeUsd: 4.1 + f.jev.classify.mock.calls.length * 0.7};
    record("jev-budget", "known-cost invalid RESP (existing reported root cause)", {priorSpentUsd: 4.1, maximumCostUsd: 0.4, actualCostUsd: 0.7, malformed: "missing candidate judgments", operations: 2}, {firstActualCostUsd: 0.7, spentUsd: 4.8, invalidCostCeilings: ["jev"], jevCalls: 1, secondCallHeld: true}, observed);
    expect.soft(observed.firstActualCostUsd).toBe(0.7); expect.soft(observed.spentUsd).toBeCloseTo(4.8); expect.soft(observed.invalidCostCeilings).toContain("jev"); expect.soft(observed.jevCalls).toBe(1);
  });

  it("vendor-unapproved: route denial blocks a paid vendor despite numerical budget", async () => {
    const f = fixture({jev: false}); f.vendor.availability.mockResolvedValue({available: true, approved: false, routeKind: "remote", reasonCode: "ROUTE_NOT_APPROVED"});
    const result = await f.service.classify(f.input);
    const observed = {errorCode: result.response.error?.code, providerCalls: f.vendor.classify.mock.calls.length, reservations: f.budget.snapshot().reservations.length};
    record("vendor-unapproved", "route approval", {jevEnabled: false, vendorBudgetUsd: 2, approved: false}, {errorCode: "ROUTE_NOT_APPROVED", providerCalls: 0, reservations: 0}, observed);
    expect(observed).toEqual({errorCode: "ROUTE_NOT_APPROVED", providerCalls: 0, reservations: 0});
  });

  it("vendor-unapproved: no separate vendor budget blocks approved paid route", async () => {
    const f = fixture({jev: false, vendorPresent: false}); const result = await f.service.classify(f.input);
    const observed = {errorCode: result.response.error?.code, providerCalls: f.vendor.classify.mock.calls.length, jevCalls: f.jev.classify.mock.calls.length, vendorBudget: f.budget.snapshot().limits["vendor:current-vendor"] ?? null};
    record("vendor-unapproved", "separate paid permission/budget", {approved: true, vendorBudget: null, jevEnabled: false}, {errorCode: "BUDGET_UNAVAILABLE", providerCalls: 0, jevCalls: 0, vendorBudget: null}, observed);
    expect(observed).toEqual({errorCode: "BUDGET_UNAVAILABLE", providerCalls: 0, jevCalls: 0, vendorBudget: null});
  });

  it("vendor-unapproved: revocation during credential await must block final transport", async () => {
    const f = fixture({jev: false}); const p = f.input.registry.profiles[1]!;
    let entered!: () => void; let release!: (key: string) => void;
    const entering = new Promise<void>(resolve => {entered = resolve;});
    const route: ApprovedClassificationRoute = {routeRef: p.approvedRouteRef, approvalRef: "synthetic-approved-route", approved: true, providerKind: "vendor", vendorId: p.vendorId, adapterRevision: p.adapterRevision, modelIds: [p.modelId], reasoningEfforts: [p.reasoningEffort], structuredOutput: true, kind: "remote", endpoint: "https://approved.example.invalid", getCredential: () => {entered(); return new Promise(resolve => {release = resolve;});}, adapter: {encode: () => ({publicSynthetic: true}), decode: () => f.evaluation()}};
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}"));
    const provider = new ApprovedRouteClassificationProvider([route], fetcher);
    const pending = provider.classify(f.request, p, new AbortController().signal); await entering;
    route.approved = false; release(inputs.sentinel);
    const result = await pending.catch((e: unknown) => e);
    const observed = {approvedAtFetch: route.approved, mockFetchCalls: fetcher.mock.calls.length, sentinelOccurrences: occurrences(result)};
    record("vendor-unapproved", "permission revocation before dispatch (linked pre-dispatch recheck gap)", {approvedAtEntry: true, approvedAfterCredentialBarrier: false, syntheticCredentialRef: "input-fixtures.json"}, {mockFetchCalls: 0, sentinelOccurrences: 0}, observed);
    expect(observed.sentinelOccurrences).toBe(0); expect(observed.mockFetchCalls).toBe(0);
  });

  it.each([{label: "limit unknown", limit: null, spent: 0}, {label: "prior usage unknown", limit: 2, spent: null}, {label: "both unknown", limit: null, spent: null}])("vendor-unknown-budget: $label remains null and blocks transport", async ({label, limit, spent}) => {
    const f = fixture({jev: false, vendorLimit: limit, vendorSpent: spent}); const result = await f.service.classify(f.input);
    const observed = {errorCode: result.response.error?.code, providerCalls: f.vendor.classify.mock.calls.length, vendorBudget: f.budget.snapshot().limits["vendor:current-vendor"]};
    record("vendor-unknown-budget", label, {limitUsd: limit, spentUsd: spent, maximumCostUsd: 0.4}, {errorCode: "BUDGET_UNAVAILABLE", providerCalls: 0, vendorBudget: {limitUsd: limit, spentUsd: spent}}, observed);
    expect(observed).toEqual({errorCode: "BUDGET_UNAVAILABLE", providerCalls: 0, vendorBudget: {limitUsd: limit, spentUsd: spent}});
  });

  it("vendor-unknown-budget: unknown qualified cost is held before availability", async () => {
    const f = fixture({jev: false}); const p = f.input.registry.profiles[1]!; p.maximumCostUsd = null; requalify(p);
    const result = await f.service.classify(f.input);
    const observed = {errorCode: result.response.error?.code, availabilityCalls: f.vendor.availability.mock.calls.length, providerCalls: f.vendor.classify.mock.calls.length, attempts: result.attempts};
    record("vendor-unknown-budget", "unknown per-call cost", {maximumCostUsd: null, vendorLimitUsd: 2}, {errorCode: "COST_UNKNOWN", availabilityCalls: 0, providerCalls: 0, attempts: []}, observed);
    expect(observed).toEqual({errorCode: "COST_UNKNOWN", availabilityCalls: 0, providerCalls: 0, attempts: []});
  });

  it("inflight-reservation: concurrent operations include outstanding cost before dispatch", async () => {
    const f = fixture({spent: 4.3, vendorPresent: false}); let release!: (e: ProviderEvaluation) => void; let entered!: () => void;
    const entering = new Promise<void>(resolve => {entered = resolve;});
    f.jev.classify.mockImplementation(() => {entered(); return new Promise(resolve => {release = resolve;});});
    const first = f.service.classify(f.input); await entering; const second = await f.service.classify(secondInput(f));
    const during = f.budget.snapshot(); release(f.evaluation()); await first;
    const observed = {secondErrorCode: second.attempts[0]?.errorCode, jevCalls: f.jev.classify.mock.calls.length, reservedDuringUsd: during.reservations.reduce((s, r) => s + r.maximumUsd, 0), finalSpentUsd: f.budget.snapshot().limits.jev.spentUsd, finalReservations: f.budget.snapshot().reservations.length};
    record("inflight-reservation", "distinct operations barrier", {limitUsd: 5, priorSpentUsd: 4.3, firstReserveUsd: 0.4, secondReserveUsd: 0.4}, {secondErrorCode: "BUDGET_UNAVAILABLE", jevCalls: 1, reservedDuringUsd: 0.4, finalSpentUsd: 4.4, finalReservations: 0}, observed);
    expect(observed).toMatchObject({secondErrorCode: "BUDGET_UNAVAILABLE", jevCalls: 1, reservedDuringUsd: 0.4, finalReservations: 0}); expect(observed.finalSpentUsd).toBeCloseTo(4.4);
  });

  it("inflight-reservation: unknown dispatched usage keeps conservative reservation", async () => {
    const f = fixture({spent: 4.3, vendorPresent: false}); f.jev.classify.mockRejectedValue(new ClassificationProviderError("TRANSPORT_UNAVAILABLE", "unknown"));
    await f.service.classify(f.input); const second = await f.service.classify(secondInput(f));
    const observed = {secondErrorCode: second.attempts[0]?.errorCode, jevCalls: f.jev.classify.mock.calls.length, spentUsd: f.budget.snapshot().limits.jev.spentUsd, reservedUsd: f.budget.snapshot().reservations.reduce((s, r) => s + r.maximumUsd, 0)};
    record("inflight-reservation", "unknown settlement", {priorSpentUsd: 4.3, firstDispatchState: "unknown", actualCostUsd: null, maximumCostUsd: 0.4}, {secondErrorCode: "BUDGET_UNAVAILABLE", jevCalls: 1, spentUsd: 4.3, reservedUsd: 0.4}, observed);
    expect(observed).toEqual({secondErrorCode: "BUDGET_UNAVAILABLE", jevCalls: 1, spentUsd: 4.3, reservedUsd: 0.4});
  });

  it("inflight-reservation: timeout and late completion retain unknown reservation", async () => {
    vi.useFakeTimers(); const f = fixture({spent: 4.3, vendorPresent: false}); let release!: (e: ProviderEvaluation) => void;
    f.jev.classify.mockImplementation(() => new Promise(resolve => {release = resolve;}));
    const pending = f.service.classify(f.input); await vi.advanceTimersByTimeAsync(1001); const first = await pending;
    const beforeLate = JSON.stringify(f.budget.snapshot()); release(f.evaluation()); await vi.advanceTimersByTimeAsync(0);
    const unchangedAfterLate = beforeLate === JSON.stringify(f.budget.snapshot()); const second = await f.service.classify(secondInput(f));
    const observed = {firstTimedOut: first.attempts[0]?.timedOut, firstActualCostUsd: first.attempts[0]?.usage.actualCostUsd, secondErrorCode: second.attempts[0]?.errorCode, jevCalls: f.jev.classify.mock.calls.length, reservedUsd: f.budget.snapshot().reservations.reduce((s, r) => s + r.maximumUsd, 0), unchangedAfterLate};
    record("inflight-reservation", "timeout late completion", {priorSpentUsd: 4.3, upperBoundUsd: 0.4, timeoutMs: 1000, lateActualCostUsd: 0.1}, {firstTimedOut: true, firstActualCostUsd: null, secondErrorCode: "BUDGET_UNAVAILABLE", jevCalls: 1, reservedUsd: 0.4, unchangedAfterLate: true}, observed);
    expect(observed).toEqual({firstTimedOut: true, firstActualCostUsd: null, secondErrorCode: "BUDGET_UNAVAILABLE", jevCalls: 1, reservedUsd: 0.4, unchangedAfterLate: true});
  });
});
