import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { RuntimeSkillClassificationGateway } from "../../mcp-server/src/skill-classification/gateway.js";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import { createClassificationRequest, digestClassificationValue } from "../../mcp-server/src/skill-classification/request.js";
import { digestProviderProfileConfiguration } from "../../mcp-server/src/skill-classification/profiles.js";
import { InMemoryClassificationBudget, SkillClassificationService } from "../../mcp-server/src/skill-classification/service.js";
import { validateDecision } from "../../mcp-server/src/skill-classification/validation.js";
import { canonicalSet, oracleDigest, scoreCase } from "./evaluation.js";
import type { Observation } from "./evaluation.js";
import type { ClassificationResult, ProviderProfile, SkillSelectionDecisionV1 } from "../../mcp-server/src/skill-classification/types.js";

// Only SS18. All providers and host observations below are synthetic test doubles.
// Gateway-generated receipts are NOT native AGENT selection evidence.
const root = fileURLToPath(new URL("../../", import.meta.url));
const bytes = readFileSync(new URL("./fixtures.json", import.meta.url));
const corpus = JSON.parse(bytes.toString());
const fixture = corpus.cases.find((c: {caseId: string}) => c.caseId === "SS18");
const P = "ponytail", SEC = "software-security-auditor", O = "orchestrator";
const findings: unknown[] = [];
const record = (id: string, input: unknown, expected: unknown, observed: unknown) => findings.push({id, caseId: "SS18", executionKind: "offline-mock", input, expected, observed});
afterAll(() => writeFileSync("SS18-repro-output/observations.json", JSON.stringify(findings, null, 2)));

async function harness() {
  const inventory = await loadSkillInventory({root});
  expect(inventory.issues).toEqual([]);
  const input = {schemaVersion: "1.0.0", requestId: "SS18-base", operationId: "SS18-base",
    originalPrompt: fixture.originalPrompt,
    confirmedContext: {taskRevision: "SS18-rule-1", objective: null, actions: null, targets: null,
      constraints: ["Existing frozen acceptance rule requires software-security-auditor"], prohibitedActions: null, background: null},
    contextSources: [{field: "taskRevision", reference: "fixture:SS18/sourceSpec/입력"}, {field: "constraints", reference: "fixture:SS18/sourceSpec/입력"}],
    explicitSkillIds: [], ruleRequiredSkillIds: [SEC], vendorContext: {vendorId: "offline-test", reference: "fixture:SS18/mock"}, publicSynthetic: true};
  const request = createClassificationRequest({requestId: input.requestId, operationId: input.operationId, originalPrompt: input.originalPrompt,
    confirmedContext: input.confirmedContext, contextSources: input.contextSources, inventory, classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md"});
  const profile: ProviderProfile = {profileId: "SS18-mock", providerKind: "vendor", vendorId: "offline-test", modelId: "offline-test", modelRevision: "mock-1", reasoningEffort: "low",
    supportedOptions: {reasoningEfforts: ["low"], structuredOutput: true}, approvedRouteRef: "fixture:SS18/mock", qualificationRevision: "mock-only",
    qualification: {status: "PASS", inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision, modelRevision: "mock-1", promptRevision: "mock-1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: `sha256:${"0".repeat(64)}`},
    adapterRevision: "mock-1", promptRevision: "mock-1", maximumInputBytes: 2000000, maximumOutputTokens: 1000, maximumCostUsd: 0, judgmentPolicy: null};
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  const runtime = {config: {jevEnabled: false, mode: "select" as const, providerProfileRegistryRef: "fixture:SS18/mock", externalClassificationAllowed: false, configRevision: "mock-1", timeoutMs: 1000},
    registry: {schemaVersion: "1.0.0" as const, profileRevision: "mock-1", profiles: [profile]}, allowRemotePrivateContent: false};
  const evaluate = vi.fn(async (req: typeof request) => ({response: {schemaVersion: "1.0.0" as const, requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest, status: "SUCCESS" as const,
    judgments: req.skills.map(s => ({skillId: s.skillId, judgment: s.skillId === P ? "needed" as const : "not-needed" as const, reasonRefs: ["fixture:SS18/injected-P-only"], uncertaintyReason: null})), unresolvedItems: [], error: null},
    usage: {inputTokens: null, outputTokens: null, cachedInputTokens: null, actualCostUsd: 0}, dispatchState: "started" as const, diagnostics: null}));
  const service = new SkillClassificationService({providers: {vendor: {availability: async () => ({available: true, approved: true, routeKind: "native", reasonCode: null}), classify: evaluate}},
    budget: new InMemoryClassificationBudget({jev: {limitUsd: 0, spentUsd: 0}, vendors: {}, nativeAllowances: {"SS18-mock": {approvalRef: "fixture:SS18/mock", remainingCalls: 1}}})});
  const task = {taskRevision: "SS18-rule-1", requestDigest: request.requestDigest, cancelled: false, sourceRef: "fixture:SS18/mock-host-task"};
  const readRuntime = vi.fn(async () => runtime);
  const observeTask = vi.fn(() => structuredClone(task));
  const observation = {source: "runtime" as const, taskId: request.requestDigest, actorId: "mock:ss18", observationId: "TEST-DOUBLE-NOT-HOST-EVIDENCE", observedAt: "2026-10-09T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z"};
  const gateway = new RuntimeSkillClassificationGateway({root, service, readRuntime, observeTask});
  const advice = await gateway.classify(input, observation as never) as {result: ClassificationResult; agentSelectedSkillIds: null; selectionStatus: string};
  const decision = (selected: string[] | null): SkillSelectionDecisionV1 => ({schemaVersion: "1.0.0", classificationResponseRef: digestClassificationValue(advice.result.response), ...advice.result.snapshot,
    explicitSkillIds: [], ruleRequiredSkillIds: [SEC], agentSelectedSkillIds: selected,
    selectionReasons: (selected ?? []).map(skillId => ({skillId, reason: skillId === SEC ? "Existing mandatory acceptance rule; user skip request does not amend rule; audit not performed" : "Synthetic purpose decision, no execution approval"})),
    applicabilityChecks: (selected ?? []).map(skillId => ({skillId, applies: true, excluded: false, reasonRefs: ["fixture:SS18/sourceSpec"]})), unresolvedSkillReferences: [],
    selectionStatus: selected === null ? "NEEDS_INPUT" : "SELECTED", adviceApplied: selected !== null, hostReceipt: null});
  // snapshot.cancelled is not part of the decision schema.
  const makeDecision = (ids: string[] | null) => {const d = decision(ids); delete (d as unknown as {cancelled?: boolean}).cancelled; return d;};
  const accept = (d: SkillSelectionDecisionV1, obs: typeof observation | null = observation) => gateway.accept({schemaVersion: "1.0.0", operationId: input.operationId, decision: d}, obs as never) as Promise<any>;
  return {gateway, inventory, input, request, advice, evaluate, task, readRuntime, observeTask, decision: makeDecision, accept};
}

function observation(ids: string[] | null, layer: Observation["layer"], state: Observation["state"] = "PASS"): Observation {
  return {caseId: "SS18", layer, state, skillIds: ids, selectionStatus: ids === null ? "PROPOSED" : "SELECTED", reasonCodes: [], selectionReasons: [], executionKind: "offline-mock", host: null, hostReceipt: null,
    requestDigest: "offline", inventoryDigest: "offline", conditionDigest: "SS18", stageEvidence: {read: false, applied: false, verified: false}};
}

describe("SS18 independent base and additional boundaries", () => {
  it("SS18 base freezes source and separates raw failure, rules, combined need and AGENT choice", async () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9");
    expect(oracleDigest(corpus)).toBe("sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055");
    expect(fixture.variants).toEqual(["base"]);
    for (const source of fixture.oracle.sourceRefs) expect(`sha256:${createHash("sha256").update(readFileSync(new URL(`../../${source.path}`, import.meta.url))).digest("hex")}`).toBe(source.digest);
    const h = await harness();
    const raw = h.advice.result.response.judgments.filter(x => x.judgment === "needed").map(x => x.skillId);
    const score = scoreCase(fixture, observation(raw, "vendorRaw"), corpus.inventorySkillIds);
    const accepted = await h.accept(h.decision([P, SEC, O]));
    record("base", h.input, {raw: [P], rawVerdict: "FAIL", missing: [SEC, O], combinedNeed: [P, SEC], syntheticSelected: [P, SEC, O], nativeSelected: null}, {raw, rawScore: score, beforeAcceptance: {agentSelectedSkillIds: h.advice.agentSelectedSkillIds, selectionStatus: h.advice.selectionStatus}, accepted});
    expect(raw).toEqual([P]); expect(score.verdict).toBe("FAIL"); expect(score.missingRequired).toEqual([SEC, O]);
    expect(h.evaluate).toHaveBeenCalledTimes(1); expect(h.evaluate.mock.calls[0]![0].originalPrompt).toBe(fixture.originalPrompt);
    expect(h.evaluate.mock.calls[0]![0].skills).toHaveLength(corpus.inventorySkillIds.length);
    expect(h.advice.agentSelectedSkillIds).toBeNull(); expect(h.advice.selectionStatus).toBe("PROPOSED");
    expect(accepted.valid).toBe(true); expect(accepted.neededSkillIds).toEqual([P, SEC].sort());
    expect(accepted.decision.ruleRequiredSkillIds).toEqual([SEC]); expect(accepted.decision.agentSelectedSkillIds).toEqual([P, SEC, O]);
    expect(accepted.admissionStatus).toBe("NOT_EVALUATED"); expect(accepted.readStatus).toBe("NOT_OBSERVED"); expect(accepted.appliedStatus).toBe("NOT_OBSERVED"); expect(accepted.verifiedStatus).toBe("NOT_RUN");
  });
  it("SS18 extra rejects missing SEC instead of rewriting raw or selected", async () => {
    const h = await harness(), d = h.decision([P]); const result = await h.accept(d);
    record("missing-SEC", d, {valid: false, error: `REQUIRED_SKILL_OMITTED:${SEC}`, selectedUnchanged: [P]}, result);
    expect(result.valid).toBe(false); expect(result.errors).toContain(`REQUIRED_SKILL_OMITTED:${SEC}`); expect(result.agentSelectedSkillIds).toBeNull(); expect(d.agentSelectedSkillIds).toEqual([P]);
  });
  it("SS18 extra does not auto-create missing O from SEC rule", async () => {
    const h = await harness(), result = await h.accept(h.decision([P, SEC]));
    const combined = scoreCase(fixture, observation(result.neededSkillIds, "combined"), corpus.inventorySkillIds);
    record("no-auto-O", {raw: [P], rules: [SEC], syntheticSelected: [P, SEC]}, {mechanicalValid: true, semanticVerdict: "FAIL", missing: [O]}, {result, combined});
    expect(result.valid).toBe(true); expect(result.neededSkillIds).toEqual([P, SEC].sort()); expect(combined.verdict).toBe("FAIL"); expect(combined.missingRequired).toEqual([O]);
  });
  it("SS18 extra rejects attempted mandatory-rule removal", async () => {
    const h = await harness(), d = h.decision([P]); d.ruleRequiredSkillIds = [];
    let error = ""; try {await h.accept(d);} catch (e) {error = (e as Error).message;}
    record("rule-removal", d, "REQUIRED_SKILL_SNAPSHOT_CHANGED", error);
    expect(error).toBe("REQUIRED_SKILL_SNAPSHOT_CHANGED");
  });
  it("SS18 extra keeps unresolved conflict null distinct from empty", async () => {
    const h = await harness(), d = h.decision(null);
    d.unresolvedSkillReferences = [{reference: "fixture:SS18-rule-1", reason: "No authority to amend frozen mandatory rule in response to skip request"}];
    const hold = validateDecision(h.advice.result, d, h.advice.result.snapshot);
    const result = await h.accept(h.decision([]));
    record("conflict-hold", {decision: d, empty: []}, {holdValid: true, heldIds: null, emptyValid: false}, {hold, emptyResult: result});
    expect(hold.valid).toBe(true); expect(d.agentSelectedSkillIds).toBeNull(); expect(canonicalSet(null)).not.toEqual(canonicalSet([]));
    expect(result.valid).toBe(false); expect(result.errors).toContain(`REQUIRED_SKILL_OMITTED:${SEC}`);
  });
  it("SS18 extra rejects absent host observation and caller-fabricated receipt", async () => {
    const h = await harness(), d = h.decision([P, SEC, O]);
    const absent = await h.accept(d, null);
    d.hostReceipt = {receiptId: "caller-forgery", host: "mock", requestDigest: d.requestDigest, inventoryDigest: d.inventoryDigest, agentSelectedSkillIds: [P, SEC, O], acceptedAt: "2026-10-09T00:00:00Z"};
    let error = ""; try {await h.accept(d);} catch (e) {error = (e as Error).message;}
    record("host-boundary", {missingObservation: true, forgedReceipt: true}, {absentValid: false, callerReceiptRejected: true}, {absent, error});
    expect(absent.valid).toBe(false); expect(absent.errors).toContain("HOST_SELECTION_NOT_OBSERVED"); expect(error).toBe("CALLER_SELECTION_RECEIPT_REJECTED");
  });
  it("SS18 extra rejects changed rule revision before acceptance", async () => {
    const h = await harness(); h.task.taskRevision = "SS18-rule-2";
    const result = await h.accept(h.decision([P, SEC, O]));
    record("rule-revision", {old: "SS18-rule-1", current: "SS18-rule-2"}, {valid: false}, result);
    expect(result.valid).toBe(false); expect(result.errors).toContain("HOST_TASK_CHANGED_OR_NOT_OBSERVED");
  });
  it("SS18 extra observes task cancellation during asynchronous acceptance read", async () => {
    const h = await harness();
    const read = h.readRuntime.getMockImplementation()!;
    h.readRuntime.mockImplementationOnce(async () => {h.task.cancelled = true; return read();});
    const result = await h.accept(h.decision([P, SEC, O]));
    record("acceptance-cancellation-race", {cancellationDuring: "await readRuntime", mandatory: [SEC]}, {valid: false, selected: null}, result);
    expect(result.valid, "Cancelled SS18 task must not accept mandatory security selection").toBe(false);
  });
  it("SS18 extra requires host-supported SEC observation at gateway inventory boundary", async () => {
    const h = await harness();
    const supplied = await loadSkillInventory({root, hostSupportedSkillIds: corpus.inventorySkillIds.filter((id: string) => id !== SEC)});
    const gatewayInventory = await h.gateway.inventory() as typeof supplied;
    const direct = supplied.skills.find(x => x.skillId === SEC)!;
    const gateway = gatewayInventory.skills.find(x => x.skillId === SEC)!;
    record("host-state-supply-gap", {simulatedHostUnsupported: SEC}, {directHostSupported: false, gatewayHostSupported: false}, {directHostSupported: direct.hostSupported, gatewayHostSupported: gateway.hostSupported, gatewayHasHostStateInput: false});
    expect(direct.hostSupported).toBe(false);
    expect(gateway.hostSupported, "SS18 mandatory SEC host state needs a trusted supplier; static installed-tree default is insufficient").toBe(false);
  });
});
