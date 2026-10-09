import {createHash} from "node:crypto";
import {readFileSync, writeFileSync, existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {aggregate, oracleDigest, scoreCase, type Observation} from "./evaluation.js";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {createClassificationRequest, projectClassificationRequest, digestClassificationValue} from "../../mcp-server/src/skill-classification/request.js";
import {RuntimeSkillClassificationGateway, readClassificationRuntime, type ClassificationRuntimeSnapshot} from "../../mcp-server/src/skill-classification/gateway.js";
import {InMemoryClassificationBudget, SkillClassificationService} from "../../mcp-server/src/skill-classification/service.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import type {SkillInventory, ProviderProfile, SkillClassificationRequestV1, ProviderEvaluation, SkillSelectionDecisionV1} from "../../mcp-server/src/skill-classification/types.js";
import type {ExecutionContextV1} from "../../contracts/types.js";

// This is ONLY an SS05 developer test. No model, credential, host hook or receipt issuer is invoked.
const root = fileURLToPath(new URL("../../", import.meta.url));
const bytes = readFileSync(root + "tests/skill-classification/fixtures.json");
const corpus = JSON.parse(bytes.toString("utf8"));
const f = corpus.cases.find((c: {caseId: string}) => c.caseId === "SS05");
const required = ["code-review", "cs-engineering", "orchestrator"];
const rows: unknown[] = [];
let inventory: SkillInventory;
let blockedFetchAttempts = 0;
const sha = (b: Buffer | string) => "sha256:" + createHash("sha256").update(b).digest("hex");
beforeAll(async () => {
  vi.stubGlobal("fetch", async () => {blockedFetchAttempts++; throw new Error("SS05_EXTERNAL_FETCH_FORBIDDEN");});
  inventory = await loadSkillInventory({root});
});
afterAll(() => {
  writeFileSync(root + "evidence/SS05/unit-observations.json", JSON.stringify({
  caseId: "SS05", executionKind: "offline-mock", API0: {jev: 0, externalVendor: 0, claude: 0},
  warning: "Injected judgments and synthetic runtime contexts are controls, never real AGENT selections or host receipts.",
  blockedFetchAttempts, rows,
}, null, 2) + "\n");
  vi.unstubAllGlobals();
  expect(blockedFetchAttempts).toBe(0);
});
function check(id: string, input: unknown, expected: unknown, observed: unknown) {
  const status = JSON.stringify(observed) === JSON.stringify(expected) ? "PASS" : "FAIL";
  rows.push({id, caseId: "SS05", input, expected, observed, status, executionKind: "offline-mock"});
  expect(observed).toEqual(expected);
}
function observation(ids: string[] | null, layer: Observation["layer"] = "combined"): Observation {
  return {caseId: "SS05", layer, state: "PASS", skillIds: ids, selectionStatus: ids === null ? "NEEDS_INPUT" : "SELECTED",
    reasonCodes: [], selectionReasons: [], executionKind: "offline-mock", host: null, hostReceipt: null,
    requestDigest: "synthetic-request", inventoryDigest: "synthetic-inventory", conditionDigest: "synthetic-condition",
    stageEvidence: {read: false, applied: false, verified: false}};
}
function makeRequest(id: string, context?: Parameters<typeof createClassificationRequest>[0]["confirmedContext"], sources?: Parameters<typeof createClassificationRequest>[0]["contextSources"]) {
  return createClassificationRequest({requestId: "SS05-" + id, operationId: "SS05-" + id,
    originalPrompt: f.originalPrompt, inventory, classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md",
    ...(context ? {confirmedContext: context} : {}), ...(sources ? {contextSources: sources} : {})});
}
function harness(id: string) {
  const request = makeRequest(id);
  const profile: ProviderProfile = {profileId: "SS05-synthetic-vendor", providerKind: "vendor", vendorId: "SS05-synthetic", modelId: "synthetic-fixed", modelRevision: "synthetic-v1", reasoningEffort: null,
    supportedOptions: {reasoningEfforts: [null], structuredOutput: true}, approvedRouteRef: "synthetic-only", qualificationRevision: "synthetic-only",
    qualification: {status: "PASS", inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision, modelRevision: "synthetic-v1", promptRevision: "synthetic-v1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""},
    adapterRevision: "synthetic-v1", promptRevision: "synthetic-v1", maximumInputBytes: 2_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: null};
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  const runtime: ClassificationRuntimeSnapshot = {config: {jevEnabled: false, mode: "select", providerProfileRegistryRef: "synthetic-only", externalClassificationAllowed: false, configRevision: "synthetic-v1", timeoutMs: 500},
    registry: {schemaVersion: "1.0.0", profileRevision: "synthetic-v1", profiles: [profile]}, allowRemotePrivateContent: false};
  const evaluation = (req: SkillClassificationRequestV1): ProviderEvaluation => ({response: {schemaVersion: "1.0.0", requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest,
    status: "SUCCESS", judgments: req.skills.map(s => ({skillId: s.skillId, judgment: required.includes(s.skillId) ? "needed" : "not-needed", reasonRefs: ["synthetic-only"], uncertaintyReason: null})), unresolvedItems: [], error: null},
    usage: {inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, actualCostUsd: 0.1}, dispatchState: "started", diagnostics: null});
  const classify = vi.fn(async (req: SkillClassificationRequestV1) => evaluation(req));
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {"SS05-synthetic": {limitUsd: 1, spentUsd: 0}}, nativeAllowances: {"SS05-synthetic-vendor": {approvalRef: "synthetic-only", remainingCalls: 10}}});
  const service = new SkillClassificationService({providers: {vendor: {availability: async () => ({available: true, approved: true, routeKind: "native", reasonCode: null}), classify}}, budget});
  const task = {taskRevision: null, requestDigest: request.requestDigest, cancelled: false, sourceRef: "synthetic-only"};
  const readRuntime = vi.fn(async () => runtime);
  const gateway = new RuntimeSkillClassificationGateway({root, service, readRuntime, observeTask: () => task});
  const input = {schemaVersion: "1.0.0", requestId: request.requestId, operationId: request.operationId, originalPrompt: request.originalPrompt, confirmedContext: request.confirmedContext, contextSources: request.contextSources,
    explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: {vendorId: "SS05-synthetic", reference: "synthetic-only"}, publicSynthetic: true};
  return {request, profile, runtime, evaluation, classify, budget, service, task, readRuntime, gateway, input};
}

describe("SS05 frozen base and offline evaluator controls", () => {
  it("base: binds full embedded source, single variant, frozen oracle and source refs", () => {
    const observed = {fixtureSHA: sha(bytes), oracleSHA: oracleDigest(corpus), variants: f.variants, required: f.oracle.required, forbidden: f.oracle.forbidden,
      sourceFields: Object.keys(f.sourceSpec.fields), externalSpecExists: existsSync(root + f.sourceSpec.path),
      refsMatch: f.oracle.sourceRefs.every((s: {path: string; digest: string}) => sha(readFileSync(root + s.path)) === s.digest)};
    check("base-integrity", {originalPrompt: f.originalPrompt, sourceSpec: f.sourceSpec, oracle: f.oracle, variants: f.variants}, {
      fixtureSHA: "sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9",
      oracleSHA: "sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055", variants: ["base"], required, forbidden: ["ponytail", "test-engineering"],
      sourceFields: ["입력", "필수추천", "금지추천 또는 행동", "허용선택", "보류조건", "통과기준", "증거", "실행종류"], externalSpecExists: false, refsMatch: true}, observed);
  });
  it("base: projects exact negated prompt, full inventory, and unknown context", () => {
    const req = makeRequest("projection"), wire = projectClassificationRequest(req);
    check("base-projection", {prompt: f.originalPrompt}, {prompt: f.originalPrompt, inventoryIds: [...corpus.inventorySkillIds].sort(), issues: [], unknown: true},
      {prompt: wire.payload.originalPrompt, inventoryIds: wire.payload.skills.map(s => s.skillId).sort(), issues: inventory.issues, unknown: Object.values(wire.payload.confirmedContext).every(x => x === null)});
  });
  it("new: preserves confirmed [] separately from unknown null", () => {
    const wire = projectClassificationRequest(makeRequest("empty-context", {actions: []}, [{field: "actions", reference: "synthetic:confirmed-empty"}]));
    check("confirmed-empty-vs-null", {actions: [], targets: null}, {actions: [], targets: null}, {actions: wire.payload.confirmedContext.actions, targets: wire.payload.confirmedContext.targets});
  });
  const controls: {id: string; ids: string[] | null; verdict: string; missing?: string[]; forbidden?: string[]}[] = [
    {id: "exact-R", ids: required, verdict: "PASS"},
    ...required.map(id => ({id: "omit-" + id, ids: required.filter(s => s !== id), verdict: "FAIL", missing: [id]})),
    ...["ponytail", "test-engineering"].map(id => ({id: "forbid-" + id, ids: [...required, id], verdict: "FAIL", forbidden: [id]})),
    ...["software-security-auditor", "korean-prose-editor"].map(id => ({id: "inapplicable-" + id, ids: [...required, id], verdict: "FAIL"})),
    {id: "unadjudicated-extra", ids: [...required, "session-board"], verdict: "REVIEW_REQUIRED"},
    {id: "unknown-alias", ids: [...required, "CR"], verdict: "FAIL"},
    {id: "unknown-abstention", ids: null, verdict: "FAIL"},
    {id: "confirmed-no-skill", ids: [], verdict: "FAIL", missing: required},
    {id: "select-all", ids: corpus.inventorySkillIds, verdict: "FAIL", forbidden: ["ponytail", "test-engineering"]},
  ];
  it.each(controls)("new evaluator control: $id", c => {
    const score = scoreCase(f, observation(c.ids), corpus.inventorySkillIds);
    check(c.id, {injectedIds: c.ids, layer: "combined", actualProviderCall: false}, c.verdict, score.verdict);
    if (c.missing) expect(score.missingRequired).toEqual(c.missing);
    if (c.forbidden) expect(score.forbidden).toEqual(c.forbidden);
  });
  it("base: absent observation remains NOT_RUN", () => {
    check("no-observation", {observation: null}, "NOT_RUN", scoreCase(f, undefined, corpus.inventorySkillIds).verdict);
  });
  it("new: correct injected advice cannot count as selected without host receipt", () => {
    const score = scoreCase(f, observation(required, "selected"), corpus.inventorySkillIds);
    check("advice-is-not-selection", {injectedIds: required, hostReceipt: null}, {verdict: "FAIL", reason: true},
      {verdict: score.verdict, reason: score.reasons.includes("HOST_SELECTION_RECEIPT_MISSING_OR_MISMATCH")});
  });
  it("new: stage self declarations without host evidence earn zero coverage", () => {
    const o = observation(required, "selected"); o.stageEvidence = {read: true, applied: true, verified: true};
    check("unobserved-stages", {stageEvidence: o.stageEvidence, hostReceipt: null}, {read: 0, applied: 0, verified: 0}, aggregate([f], [o], "selected", corpus.inventorySkillIds).stageCoverage);
  });
});

describe("SS05 isolated product support boundaries; no actual host", () => {
  it("base: unconfigured service returns unavailable without inventing selection", async () => {
    const runtime = await readClassificationRuntime(undefined, root);
    const service = new SkillClassificationService({providers: {}, budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}})});
    const gateway = new RuntimeSkillClassificationGateway({root, service, readRuntime: async () => runtime});
    const h = harness("unconfigured"); const result = await gateway.classify(h.input) as any;
    check("unconfigured", {configPresent: false, prompt: f.originalPrompt}, {errorCode: "PROFILE_UNAVAILABLE", selected: null, status: "PROPOSED", attempts: 0},
      {errorCode: result.result.response.error?.code, selected: result.agentSelectedSkillIds, status: result.selectionStatus, attempts: result.result.attempts.length});
  });
  it("new: successful mock classification keeps selected null", async () => {
    const h = harness("no-auto-selection"), result = await h.gateway.classify(h.input) as any;
    check("no-auto-selection", {mockNeeded: required}, {needed: required.slice().sort(), selected: null, status: "PROPOSED", adviceApplied: false},
      {needed: result.result.response.judgments.filter((j: any) => j.judgment === "needed").map((j: any) => j.skillId).sort(), selected: result.agentSelectedSkillIds, status: result.selectionStatus, adviceApplied: result.adviceApplied});
  });
  it("new: absence of runtime host observation rejects selection", async () => {
    const h = harness("no-host"), advice = await h.gateway.classify(h.input) as any;
    const decision = makeDecision(advice, required);
    const result = await h.gateway.accept({schemaVersion: "1.0.0", operationId: h.request.operationId, decision}, null) as any;
    check("no-host-selection", {proposedIds: required, hostReceipt: null, runtimeObservation: null}, {valid: false, selected: null, errors: ["HOST_SELECTION_NOT_OBSERVED"]},
      {valid: result.valid, selected: result.agentSelectedSkillIds, errors: result.errors});
  });
  it("positive control: valid RESP settles the same cost correctly", async () => {
    const h = harness("valid-response-cost");
    const result = await h.service.classify({request: h.request, config: h.runtime.config, registry: h.runtime.registry, currentVendorId: "SS05-synthetic"});
    check("valid-response-cost-control", {prompt: f.originalPrompt, validActualCostUsd: 0.1},
      {code: null, actualCostUsd: 0.1, spentUsd: 0.1, reserved: 0},
      {code: result.response.error?.code ?? null, actualCostUsd: result.attempts[0]?.usage.actualCostUsd, spentUsd: h.budget.snapshot().limits["vendor:SS05-synthetic"]?.spentUsd, reserved: h.budget.snapshot().reservations.length});
  });
  it("known defect repro: valid cost survives invalid RESP", async () => {
    const h = harness("invalid-response-cost");
    h.classify.mockImplementation(async req => ({...h.evaluation(req), response: {...h.evaluation(req).response, judgments: []}}));
    const result = await h.service.classify({request: h.request, config: h.runtime.config, registry: h.runtime.registry, currentVendorId: "SS05-synthetic"});
    check("known-invalid-response-cost-loss", {prompt: f.originalPrompt, invalidJudgments: [], validActualCostUsd: 0.1},
      {code: "INVALID_PROVIDER_RESPONSE", actualCostUsd: 0.1, spentUsd: 0.1, reserved: 0},
      {code: result.response.error?.code, actualCostUsd: result.attempts[0]?.usage.actualCostUsd, spentUsd: h.budget.snapshot().limits["vendor:SS05-synthetic"]?.spentUsd, reserved: h.budget.snapshot().reservations.length});
  });
  it("known defect repro: oversized timeout must fail before dispatch", async () => {
    const h = harness("timeout-overflow"); h.runtime.config.timeoutMs = 2_147_483_648;
    h.classify.mockImplementation(async req => {await new Promise(r => setTimeout(r, 15)); return h.evaluation(req);});
    const result = await h.service.classify({request: h.request, config: h.runtime.config, registry: h.runtime.registry, currentVendorId: "SS05-synthetic"});
    check("known-timeout-overflow", {prompt: f.originalPrompt, timeoutMs: h.runtime.config.timeoutMs}, {code: "INVALID_TIMEOUT", mockDispatches: 0}, {code: result.response.error?.code, mockDispatches: h.classify.mock.calls.length});
  });
  it("known gap repro: gateway inventory must honor host unavailable skill", async () => {
    const h = harness("host-discovery");
    const supported = inventory.skills.map(s => s.skillId).filter(id => id !== "code-review");
    const direct = await loadSkillInventory({root, hostSupportedSkillIds: supported});
    const gatewayInventory = await h.gateway.inventory() as SkillInventory;
    check("known-host-state-supply-gap", {syntheticHostUnsupportedSkillIds: ["code-review"], directCR: direct.skills.find(s => s.skillId === "code-review")?.hostSupported},
      {gatewayCR: false}, {gatewayCR: gatewayInventory.skills.find(s => s.skillId === "code-review")?.hostSupported});
  });
  it("known gap repro: cancellation during accept await must deny commit", async () => {
    const h = harness("accept-cancel");
    const syntheticObservation: ExecutionContextV1 = {schemaVersion: "1.0.0", model: "synthetic-only", modelClass: "general", reasoningEffort: "high", source: "runtime", observedAt: "2026-10-09T00:00:00Z", observationId: "MOCK_ONLY_NOT_HOST_EVIDENCE", taskId: h.request.requestDigest, actorId: "codex:synthetic-only", expiresAt: "2099-01-01T00:00:00Z"};
    const advice = await h.gateway.classify(h.input, syntheticObservation) as any;
    h.readRuntime.mockImplementation(async () => {h.task.cancelled = true; return h.runtime;});
    const result = await h.gateway.accept({schemaVersion: "1.0.0", operationId: h.request.operationId, decision: makeDecision(advice, required)}, syntheticObservation) as any;
    // Gateway-internal synthetic receipt is deliberately not exported or used as actual host evidence.
    check("known-accept-cancellation-recheck-gap", {syntheticRuntimeContext: true, cancellationDuringReadRuntime: true}, {valid: false}, {valid: result.valid});
  });
  it("positive control: cancellation before accept is rejected", async () => {
    const h = harness("cancel-before-accept");
    const syntheticObservation: ExecutionContextV1 = {schemaVersion: "1.0.0", model: "synthetic-only", modelClass: "general", reasoningEffort: "high", source: "runtime", observedAt: "2026-10-09T00:00:00Z", observationId: "MOCK_ONLY_NOT_HOST_EVIDENCE", taskId: h.request.requestDigest, actorId: "codex:synthetic-only", expiresAt: "2099-01-01T00:00:00Z"};
    const advice = await h.gateway.classify(h.input, syntheticObservation) as any;
    h.task.cancelled = true;
    const result = await h.gateway.accept({schemaVersion: "1.0.0", operationId: h.request.operationId, decision: makeDecision(advice, required)}, syntheticObservation) as any;
    check("cancel-before-accept-control", {syntheticRuntimeContext: true, cancellationBeforeAccept: true}, {valid: false, errors: ["HOST_TASK_CHANGED_OR_NOT_OBSERVED"]}, {valid: result.valid, errors: result.errors});
  });
});

function makeDecision(advice: any, selected: string[]): SkillSelectionDecisionV1 {
  const {requestDigest, inventoryDigest, taskRevision, configRevision, profileRevision} = advice.result.snapshot;
  return {schemaVersion: "1.0.0", classificationResponseRef: digestClassificationValue(advice.result.response), requestDigest, inventoryDigest, taskRevision, configRevision, profileRevision,
    explicitSkillIds: [], ruleRequiredSkillIds: [], agentSelectedSkillIds: selected,
    selectionReasons: selected.map(skillId => ({skillId, reason: "synthetic test only"})),
    applicabilityChecks: selected.map(skillId => ({skillId, applies: true, excluded: false, reasonRefs: ["synthetic test only"]})),
    unresolvedSkillReferences: [], selectionStatus: "SELECTED", adviceApplied: true, hostReceipt: null,
  } as SkillSelectionDecisionV1;
}
