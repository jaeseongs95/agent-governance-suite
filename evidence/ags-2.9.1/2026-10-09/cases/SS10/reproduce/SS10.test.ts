import {createHash} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {aggregate, canonicalSet, oracleDigest, sameSet, scoreCase, type Observation} from "../skill-classification/evaluation.js";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {createClassificationRequest, projectClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {buildVendorMessages, jevNoulWireAdapter} from "../../mcp-server/src/skill-classification/providers.js";
import {readClassificationRuntime, RuntimeSkillClassificationGateway} from "../../mcp-server/src/skill-classification/gateway.js";
import {InMemoryClassificationBudget, SkillClassificationService} from "../../mcp-server/src/skill-classification/service.js";
import type {SkillInventory} from "../../mcp-server/src/skill-classification/types.js";

const root = process.cwd();
const corpus = JSON.parse(readFileSync(`${root}/tests/skill-classification/fixtures.json`, "utf8"));
const fixture = corpus.cases.find((c: {caseId: string}) => c.caseId === "SS10");
const traces: object[] = [];
const sha = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
let inventory: SkillInventory;
beforeAll(async () => {inventory = await loadSkillInventory({root});});
afterAll(() => writeFileSync("tests/ss10-isolated/reproduction-output/SS10.offline-checks.json", JSON.stringify({
  caseId: "SS10", fixtureVariant: "base", executionKind: "offline-component-and-evaluator-controls",
  API0: {jev: 0, externalVendor: 0, claude: 0}, hostReceiptCreated: false,
  note: "Synthetic scorer inputs and local packaging checks; no model or host semantic observation.", checks: traces,
}, null, 2) + "\n"));
function trace(checkId: string, input: unknown, expected: unknown, observed: unknown) {
  traces.push({checkId, input, expected, observed});
}
function synthetic(ids: string[] | null, layer: Observation["layer"] = "jevRaw", state: Observation["state"] = "PASS"): Observation {
  return {caseId: "SS10", layer, state, skillIds: ids, selectionStatus: ids === null ? "NEEDS_INPUT" : "SELECTED",
    reasonCodes: [], selectionReasons: [], executionKind: "offline-mock", host: null, hostReceipt: null,
    requestDigest: "synthetic-scorer-input", inventoryDigest: "synthetic-scorer-input", conditionDigest: "synthetic-scorer-input",
    stageEvidence: {read: false, applied: false, verified: false}};
}
function request(id: string, context?: Parameters<typeof createClassificationRequest>[0]["confirmedContext"], sources?: Parameters<typeof createClassificationRequest>[0]["contextSources"]) {
  return createClassificationRequest({requestId: `SS10-${id}`, operationId: `SS10-${id}`, originalPrompt: fixture.originalPrompt,
    inventory, classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md",
    ...(context ? {confirmedContext: context, contextSources: sources} : {})});
}

describe("SS10 pinned base / offline only", () => {
  it("B01 binds the entire frozen oracle and all SS10 referenced source bytes", () => {
    expect(sha(readFileSync(`${root}/tests/skill-classification/fixtures.json`))).toBe("sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9");
    expect(oracleDigest(corpus)).toBe("sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055");
    expect(fixture.variants).toEqual(["base"]);
    expect(fixture.oracle.required).toEqual(["code-review"]);
    expect(fixture.oracle.allowed).toEqual([]);
    expect(fixture.oracle.forbidden).toEqual(["ponytail", "software-security-auditor"]);
    const refs = fixture.oracle.sourceRefs.map((s: {path: string; digest: string}) => ({...s, observedDigest: sha(readFileSync(`${root}/${s.path}`))}));
    for (const ref of refs) expect(ref.observedDigest).toBe(ref.digest);
    trace("B01", {caseId: "SS10", sourceSpec: fixture.sourceSpec, refs}, {variants: ["base"], oracleSHA: corpus.oracleDigest}, {variants: fixture.variants, oracleSHA: oracleDigest(corpus)});
  });
  it("B02 preserves base negations, unknown patch/context and the complete inventory", () => {
    expect(inventory.issues).toEqual([]);
    expect(inventory.skills.map(s => s.skillId).sort()).toEqual([...corpus.inventorySkillIds].sort());
    const req = request("base"); const projection = projectClassificationRequest(req);
    expect(req.originalPrompt).toBe(fixture.originalPrompt);
    expect(req.promptDigest).toBe(sha(fixture.originalPrompt));
    expect(req.confirmedContext).toEqual({taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null});
    expect(projection.payload.originalPrompt).toBe(fixture.originalPrompt);
    expect(projection.payload.confirmedContext).toEqual(req.confirmedContext);
    expect(projection.payload.skills).toHaveLength(inventory.skills.length);
    for (const [i, s] of inventory.skills.entries()) {
      const {sourceRefs, sourceMap, ...semantic} = s;
      expect(projection.payload.skills[i]).toEqual(semantic);
    }
    const wire = JSON.parse(buildVendorMessages(req)[1]!.content);
    expect(wire.originalPrompt).toBe(fixture.originalPrompt);
    expect(wire.skills).toEqual(projection.payload.skills);
    expect(buildVendorMessages(req)[0]!.content).toContain("Preserve negations");
    // Encoding only: never fetch, decode, or supply a provider/profile approval.
    const jevWire = jevNoulWireAdapter.encode(req, {modelId: "synthetic-encoding-only"} as never) as {state: {originalPrompt: string}; questions: Record<string, unknown>};
    expect(jevWire.state.originalPrompt).toBe(fixture.originalPrompt);
    expect(Object.keys(jevWire.questions).sort()).toEqual([...corpus.inventorySkillIds].sort());
    writeFileSync("tests/ss10-isolated/reproduction-output/SS10.request.json", JSON.stringify(req, null, 2) + "\n");
    trace("B02", {originalPrompt: fixture.originalPrompt, confirmedContext: null}, {promptPreserved: true, skillCount: corpus.inventorySkillIds.length, noInventedPatch: true}, {promptPreserved: wire.originalPrompt === fixture.originalPrompt, skillCount: wire.skills.length, confirmedContext: wire.confirmedContext, payloadBytes: projection.payloadBytes, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest});
  });
  it("B03 accepts the exact byte limit and rejects one byte under without truncation", () => {
    const req = request("limit"); const bytes = projectClassificationRequest(req).payloadBytes;
    expect(projectClassificationRequest(req, bytes).payload.originalPrompt).toBe(fixture.originalPrompt);
    let observed: unknown;
    try {projectClassificationRequest(req, bytes - 1);} catch (e) {observed = {code: (e as Error).message, payloadBytes: (e as {payloadBytes: number}).payloadBytes, omittedRanges: (e as {omittedRanges: unknown[]}).omittedRanges};}
    expect(observed).toEqual({code: "INPUT_TOO_LONG", payloadBytes: bytes, omittedRanges: []});
    trace("B03", {maximumInputBytes: [bytes, bytes - 1]}, {exact: "preserved", under: "INPUT_TOO_LONG", omittedRanges: []}, observed);
  });
  it("N01 keeps positive review and prohibited implement/refactor in separate sourced fields", () => {
    const context = {actions: ["review"], prohibitedActions: ["implement", "refactor"]};
    const sources = [{field: "actions", reference: "fixtures.json#SS10/originalPrompt/sentence2"}, {field: "prohibitedActions", reference: "fixtures.json#SS10/originalPrompt/sentence1"}];
    const req = request("sourced-context", context, sources);
    const wire = JSON.parse(buildVendorMessages(req)[1]!.content);
    expect(wire.confirmedContext).toMatchObject({...context, targets: null});
    expect(wire.originalPrompt).toBe(fixture.originalPrompt);
    expect(() => request("unsourced-context", context)).toThrow("CONTEXT_SOURCE_MISSING");
    trace("N01", {originalPrompt: fixture.originalPrompt, context, sources}, {...context, targets: null, unsourced: "CONTEXT_SOURCE_MISSING"}, {...wire.confirmedContext, unsourced: "CONTEXT_SOURCE_MISSING"});
  });
  it("N02 distinguishes unknown targets null from a sourced confirmed empty targets array", () => {
    const unknown = projectClassificationRequest(request("unknown-target")).payload.confirmedContext.targets;
    const empty = projectClassificationRequest(request("confirmed-empty-target", {targets: []}, [{field: "targets", reference: "offline-boundary-fixture:confirmed-no-target"}])).payload.confirmedContext.targets;
    expect(unknown).toBeNull(); expect(empty).toEqual([]); expect(unknown).not.toEqual(empty);
    trace("N02", {targets: [null, []], note: "New structural boundary, not a frozen prompt variant"}, {unknown: null, confirmedEmpty: []}, {unknown, confirmedEmpty: empty});
  });
  it("R01 extracts only the pre-existing SS10 forbidden-ponytail regression", () => {
    // tests/skill-classification/evaluation.test.ts:80-83; other original cases are not run.
    const forbidden = aggregate([fixture], [synthetic(["code-review", "ponytail"])], "jevRaw", corpus.inventorySkillIds);
    expect(forbidden.precision).toBe(0.5); expect(forbidden.forbiddenViolationRate).toBe(1); expect(forbidden.scores[0]!.verdict).toBe("FAIL");
    trace("R01", {syntheticRecommended: ["code-review", "ponytail"], source: "tests/skill-classification/evaluation.test.ts:80-83"}, {precision: 0.5, forbiddenViolationRate: 1, verdict: "FAIL"}, forbidden);
  });
  it.each([
    {id: "N03-exact-CR", ids: ["code-review"], verdict: "PASS", forbidden: [], missing: []},
    {id: "N04-negated-SEC", ids: ["code-review", "software-security-auditor"], verdict: "FAIL", forbidden: ["software-security-auditor"], missing: []},
    {id: "N05-both-negated", ids: ["code-review", "ponytail", "software-security-auditor"], verdict: "FAIL", forbidden: ["ponytail", "software-security-auditor"], missing: []},
    {id: "N06-missing-patch-no-skill", ids: [], verdict: "FAIL", forbidden: [], missing: ["code-review"]},
    {id: "N07-missing-patch-abstention", ids: null, verdict: "FAIL", forbidden: [], missing: ["code-review"]},
    {id: "N08-unadjudicated-extra", ids: ["code-review", "session-board"], verdict: "REVIEW_REQUIRED", forbidden: [], missing: []},
    {id: "N09-noncanonical-alias", ids: ["CR"], verdict: "FAIL", forbidden: [], missing: ["code-review"]},
  ])("$id evaluates independent negative controls without claiming model behavior", ({id, ids, verdict, forbidden, missing}) => {
    const observed = scoreCase(fixture, synthetic(ids), corpus.inventorySkillIds);
    expect(observed.verdict).toBe(verdict); expect(observed.forbidden).toEqual(forbidden); expect(observed.missingRequired).toEqual(missing);
    trace(id, {syntheticRecommended: ids, originalPrompt: fixture.originalPrompt}, {verdict, forbidden, missingRequired: missing}, observed);
  });
  it.each(fixture.oracle.notApplicable)("N10 rejects not-applicable extra %s", (id: string) => {
    const observed = scoreCase(fixture, synthetic(["code-review", id]), corpus.inventorySkillIds);
    expect(observed.verdict).toBe("FAIL"); expect(observed.unnecessary).toEqual([id]);
    trace(`N10-${id}`, {syntheticRecommended: ["code-review", id]}, {verdict: "FAIL", unnecessary: [id]}, observed);
  });
  it("N11 never promotes advice without host evidence and retains null versus []", () => {
    const absent = scoreCase(fixture, undefined, corpus.inventorySkillIds);
    const selected = scoreCase(fixture, synthetic(["code-review"], "selected"), corpus.inventorySkillIds);
    expect(absent.verdict).toBe("NOT_RUN"); expect(selected.verdict).toBe("FAIL");
    expect(selected.reasons).toContain("HOST_SELECTION_RECEIPT_MISSING_OR_MISMATCH");
    expect(aggregate([fixture], [synthetic(["code-review"], "selected")], "selected", corpus.inventorySkillIds).stageCoverage).toEqual({read: 0, applied: 0, verified: 0});
    expect(canonicalSet(null)).toBeNull(); expect(sameSet(null, [])).toBe(false);
    trace("N11", {hostReceipt: null, hypotheticalAdvice: ["code-review"]}, {absent: "NOT_RUN", selectedWithoutReceipt: "FAIL", stages: {read: 0, applied: 0, verified: 0}}, {absent, selected, nullEqualsEmpty: sameSet(null, [])});
  });
  it("N12 unconfigured public gateway has no provider invocation or agent selection", async () => {
    let availability = 0, invocation = 0;
    const unavailableProvider = {availability: async () => {availability++; throw new Error("UNEXPECTED_PROVIDER_AVAILABILITY");}, classify: async () => {invocation++; throw new Error("UNEXPECTED_PROVIDER_CALL");}};
    const runtime = await readClassificationRuntime(undefined, root);
    const service = new SkillClassificationService({providers: {jev: unavailableProvider, vendor: unavailableProvider}, budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}})});
    const gateway = new RuntimeSkillClassificationGateway({root, service, readRuntime: async () => runtime});
    const req = request("unconfigured-gateway");
    const observed = await gateway.classify({schemaVersion: "1.0.0", requestId: req.requestId, operationId: req.operationId, originalPrompt: fixture.originalPrompt, confirmedContext: req.confirmedContext, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: {vendorId: "synthetic-offline-vendor", reference: "offline-test"}, publicSynthetic: true});
    expect(observed).toMatchObject({agentSelectedSkillIds: null, selectionStatus: "PROPOSED", adviceApplied: false, result: {response: {status: "UNAVAILABLE", error: {code: "PROFILE_UNAVAILABLE"}}, attempts: []}});
    expect({availability, invocation}).toEqual({availability: 0, invocation: 0});
    trace("N12", {originalPrompt: fixture.originalPrompt, runtime: "unconfigured", hostObservation: null}, {status: "UNAVAILABLE", selected: null, availability: 0, invocation: 0}, {gateway: observed, availability, invocation});
  });
  it("D01 known host-state supply gap: gateway cannot reflect an unsupported CR host", async () => {
    const supported = inventory.skills.map(s => s.skillId).filter(id => id !== "code-review");
    const observedHost = await loadSkillInventory({root, hostSupportedSkillIds: supported});
    const directCR = observedHost.skills.find(s => s.skillId === "code-review")!;
    const runtime = await readClassificationRuntime(undefined, root);
    const gateway = new RuntimeSkillClassificationGateway({root, service: new SkillClassificationService({providers: {}, budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}})}), readRuntime: async () => runtime});
    const gatewayInventory = await gateway.inventory() as SkillInventory;
    const gatewayCR = gatewayInventory.skills.find(s => s.skillId === "code-review")!;
    trace("D01", {originalPrompt: fixture.originalPrompt, isolatedHostSupportedSkillIds: supported, boundary: "InventoryOptions hostSupportedSkillIds vs public gateway.inventory"}, {directCR: false, gatewayCR: false}, {directCR: directCR.hostSupported, gatewayCR: gatewayCR.hostSupported, knownDefect: "host-active-state-supply-gap"});
    expect(directCR.hostSupported).toBe(false);
    // Normative assertion intentionally red. No host receipt or real host is simulated.
    expect(gatewayCR.hostSupported).toBe(false);
  });
});
