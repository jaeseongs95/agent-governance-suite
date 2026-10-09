import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import { createClassificationRequest, projectClassificationRequest } from "../../mcp-server/src/skill-classification/request.js";
import { buildVendorMessages } from "../../mcp-server/src/skill-classification/providers.js";
import { validateClassificationResponse } from "../../mcp-server/src/skill-classification/validation.js";
import { RuntimeSkillClassificationGateway, readClassificationRuntime } from "../../mcp-server/src/skill-classification/gateway.js";
import { InMemoryClassificationBudget, SkillClassificationService } from "../../mcp-server/src/skill-classification/service.js";
import { oracleDigest, scoreCase, aggregate, sameSet, type Observation } from "../skill-classification/evaluation.js";
import type { SkillInventory, SkillClassificationRequestV1, SkillClassificationResponseV1 } from "../../mcp-server/src/skill-classification/types.js";

const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const corpus = JSON.parse(readFileSync("tests/skill-classification/fixtures.json", "utf8"));
const fixture = corpus.cases.find((c: {caseId: string}) => c.caseId === "SS14");
const R = ["cs-engineering", "test-engineering", "orchestrator"];
const rows: unknown[] = [];
let inventory: SkillInventory, request: SkillClassificationRequestV1;
const response = (): SkillClassificationResponseV1 => ({schemaVersion: "1.0.0", requestId: request.requestId, operationId: request.operationId,
  requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: "SUCCESS",
  judgments: request.skills.map(s => ({skillId: s.skillId, judgment: R.includes(s.skillId) ? "needed" : "not-needed", reasonRefs: ["offline-control:SS14-frozen-oracle"], uncertaintyReason: null})), unresolvedItems: [], error: null});
const observation = (skillIds: string[] | null, layer: Observation["layer"] = "vendorRaw"): Observation => ({caseId: "SS14", layer, state: "PASS", skillIds,
  selectionStatus: skillIds === null ? "NEEDS_INPUT" : "SELECTED", reasonCodes: [], selectionReasons: [], executionKind: "offline-mock", host: null,
  hostReceipt: null, requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, conditionDigest: sha("all-context-null"),
  stageEvidence: {read: false, applied: false, verified: false}});

beforeAll(async () => {
  vi.stubGlobal("fetch", vi.fn(() => {throw new Error("SS14_EXTERNAL_NETWORK_FORBIDDEN");}));
  inventory = await loadSkillInventory({root: process.cwd()});
  request = createClassificationRequest({requestId: "SS14-base-offline", operationId: "SS14-base-offline", originalPrompt: fixture.originalPrompt,
    inventory, classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md"});
});
afterAll(() => {
  const calls = vi.mocked(fetch).mock.calls.length;
  rows.push({kind: "external-api-call-counter", observed: calls, expected: 0});
  writeFileSync("ss14-repro-output/SS14.offline.observations.json", JSON.stringify({caseId: "SS14", executionKind: "offline-mock", rows}, null, 2));
  expect(calls).toBe(0);
  vi.unstubAllGlobals();
});

describe("SS14 only: base plus isolated boundary controls; no live selection receipts", () => {
  it("binds fixed fixture, computed oracle, all embedded fields and SS14 sourceRefs", () => {
    expect(sha(readFileSync("tests/skill-classification/fixtures.json"))).toBe("sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9");
    expect(oracleDigest(corpus)).toBe("sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055");
    expect(fixture.variants).toEqual(["base"]);
    expect(fixture.oracle.required).toEqual(R);
    expect(Object.keys(fixture.sourceSpec.fields)).toHaveLength(8);
    expect(existsSync(fixture.sourceSpec.path)).toBe(false);
    for (const source of fixture.oracle.sourceRefs) expect(sha(readFileSync(source.path))).toBe(source.digest);
    rows.push({kind: "frozen-source-binding", variant: "base", fixture, observedOracleSHA: oracleDigest(corpus)});
  });
  it("base preserves mixed-language original bytes, negations, unknown context and full 24-role inventory", () => {
    expect(inventory.issues).toEqual([]);
    expect(inventory.skills.map(s => s.skillId).sort()).toEqual([...corpus.inventorySkillIds].sort());
    expect(inventory.skills).toHaveLength(24);
    expect(request.originalPrompt).toBe(fixture.originalPrompt);
    expect(request.promptDigest).toBe(sha(fixture.originalPrompt));
    expect(Object.values(request.confirmedContext).every(x => x === null)).toBe(true);
    const compact = projectClassificationRequest(request);
    expect(compact.payload.originalPrompt).toBe(fixture.originalPrompt);
    expect(compact.payload.originalPrompt).toContain("No implementation, no code changes.");
    expect(compact.payload.skills.map(s => s.skillId)).toEqual(request.skills.map(s => s.skillId));
    for (const s of compact.payload.skills) expect(s).toEqual(expect.objectContaining({dependencies: expect.any(Array), applicability: expect.any(Array), exclusions: expect.any(Array), phases: expect.any(Array)}));
    const messages = buildVendorMessages(request);
    expect(JSON.stringify(messages)).toContain("No implementation, no code changes.");
    expect(JSON.stringify(messages)).not.toContain("offline-control:SS14-frozen-oracle");
    rows.push({kind: "base-request-transport", expectedR: R, request, projection: compact, wireMessages: messages,
      semanticProviderObserved: null, agentSelectedSkillIds: null, hostReceipt: null});
  });
  it("boundary: missing queue context stays null, confirmed empty targets stays [] with source", () => {
    const empty = createClassificationRequest({requestId: "SS14-empty-target", operationId: "SS14-empty-target", originalPrompt: fixture.originalPrompt,
      inventory, classificationCriteriaRef: request.classificationCriteriaRef, confirmedContext: {targets: []}, contextSources: [{field: "targets", reference: "offline-control:confirmed-empty"}]});
    expect(projectClassificationRequest(request).payload.confirmedContext.targets).toBeNull();
    expect(projectClassificationRequest(empty).payload.confirmedContext.targets).toEqual([]);
    expect(sameSet(null, [])).toBe(false);
    rows.push({kind: "null-versus-empty", expected: [null, []], observed: [request.confirmedContext.targets, empty.confirmedContext.targets]});
  });
  it("boundary: exact UTF8 limit accepts complete input; one byte less rejects without omitted ranges", () => {
    const bytes = projectClassificationRequest(request).payloadBytes;
    expect(projectClassificationRequest(request, bytes).payload.originalPrompt).toBe(fixture.originalPrompt);
    let failure: any;
    try {projectClassificationRequest(request, bytes - 1);} catch(e) {failure = e;}
    expect(failure.message).toBe("INPUT_TOO_LONG");
    expect(failure.omittedRanges).toEqual([]);
    rows.push({kind: "utf8-boundary", payloadBytes: bytes, acceptedBytes: bytes, rejectedBytes: bytes - 1, error: failure.message, omittedRanges: failure.omittedRanges});
  });
  it("boundary: complete mock RESP is transport-valid but omitting any required candidate is invalid", () => {
    expect(validateClassificationResponse(request, response())).toEqual([]);
    for (const id of R) {
      const r = response(); r.judgments = r.judgments.filter(j => j.skillId !== id);
      const errors = validateClassificationResponse(request, r);
      expect(errors).toContain("MISSING_CANDIDATE_JUDGMENT");
      rows.push({kind: "omitted-response-candidate", inputOmitted: id, expected: "MISSING_CANDIDATE_JUDGMENT", observed: errors});
    }
  });
  it("boundary: a structurally valid single-label recommendation remains an SS14 semantic failure", () => {
    const r = response(); r.judgments.forEach(j => {j.judgment = j.skillId === "cs-engineering" ? "needed" : "not-needed";});
    expect(validateClassificationResponse(request, r)).toEqual([]);
    const score = scoreCase(fixture, observation(["cs-engineering"]), corpus.inventorySkillIds);
    expect(score.verdict).toBe("FAIL");
    expect(score.missingRequired).toEqual(["test-engineering", "orchestrator"]);
    rows.push({kind: "language-switch-single-role-control", observedInput: r, expectedMissing: ["test-engineering", "orchestrator"], observed: score});
  });
  it.each(R)("boundary: scorer rejects required role omission %s", id => {
    const ids = R.filter(x => x !== id), score = scoreCase(fixture, observation(ids), corpus.inventorySkillIds);
    expect(score.verdict).toBe("FAIL"); expect(score.missingRequired).toEqual([id]);
    rows.push({kind: "required-role-omission-control", input: ids, expectedMissing: [id], observed: score});
  });
  it("boundary: scorer rejects implementation and incompatible roles; leaves unadjudicated extras under review", () => {
    for (const id of ["ponytail", ...fixture.oracle.notApplicable]) {
      const score = scoreCase(fixture, observation([...R, id]), corpus.inventorySkillIds);
      expect(score.verdict).toBe("FAIL");
      rows.push({kind: "extra-role-control", input: [...R, id], expected: "FAIL", observed: score});
    }
    expect(scoreCase(fixture, observation([...R, "session-board"]), corpus.inventorySkillIds).verdict).toBe("REVIEW_REQUIRED");
  });
  it("boundary: correct mock advice cannot become selected/read/applied/verified without a real host receipt", () => {
    const advice = scoreCase(fixture, observation(R), corpus.inventorySkillIds);
    expect(advice.verdict).toBe("PASS");
    const selected = scoreCase(fixture, observation(R, "selected"), corpus.inventorySkillIds);
    expect(selected.verdict).toBe("FAIL"); expect(selected.reasons).toContain("HOST_SELECTION_RECEIPT_MISSING_OR_MISMATCH");
    const notrun = {...observation(null, "selected"), state: "NOT_RUN" as const, selectionStatus: "PROPOSED"};
    expect(scoreCase(fixture, notrun, corpus.inventorySkillIds).verdict).toBe("NOT_RUN");
    expect(aggregate([fixture], [notrun], "selected", corpus.inventorySkillIds).stageCoverage).toEqual({read: 0, applied: 0, verified: 0});
    rows.push({kind: "selection-evidence-boundary", mockAdviceScore: advice, receiptlessAttemptScore: selected, actualObservation: notrun});
  });
  it("boundary: actual unconfigured runtime makes zero provider attempts and gateway accepts no unobserved host", async () => {
    const runtime = await readClassificationRuntime(undefined, process.cwd());
    const service = new SkillClassificationService({providers: {}, budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}})});
    const result = await service.classify({request, config: runtime.config, registry: runtime.registry, currentVendorId: "offline-unconfigured"});
    expect(result.response.status).toBe("UNAVAILABLE"); expect(result.attempts).toEqual([]);
    const gateway = new RuntimeSkillClassificationGateway({root: process.cwd(), service, readRuntime: async () => runtime});
    const classified: any = await gateway.classify({schemaVersion: "1.0.0", requestId: "SS14-gateway-unconfigured", operationId: "SS14-gateway-unconfigured",
      originalPrompt: fixture.originalPrompt, confirmedContext: request.confirmedContext, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [],
      vendorContext: {vendorId: "offline-unconfigured", reference: "offline-control"}, publicSynthetic: true});
    expect(classified.agentSelectedSkillIds).toBeNull();
    const decision = {schemaVersion: "1.0.0", classificationResponseRef: classified.classificationResponseRef, requestDigest: classified.result.request.requestDigest,
      inventoryDigest: classified.result.request.inventoryDigest, taskRevision: null, configRevision: runtime.config.configRevision, profileRevision: runtime.registry.profileRevision,
      explicitSkillIds: [], ruleRequiredSkillIds: [], agentSelectedSkillIds: null, selectionReasons: [], applicabilityChecks: [], unresolvedSkillReferences: [],
      selectionStatus: "PROPOSED", adviceApplied: false, hostReceipt: null};
    const checked: any = await gateway.accept({schemaVersion: "1.0.0", operationId: "SS14-gateway-unconfigured", decision}, null);
    expect(checked.errors).toEqual(["HOST_SELECTION_NOT_OBSERVED"]); expect(checked.agentSelectedSkillIds).toBeNull();
    rows.push({kind: "unconfigured-runtime-observation", response: result.response, attempts: result.attempts, gatewaySelected: classified.agentSelectedSkillIds, selectionRejected: checked});
  });
});
