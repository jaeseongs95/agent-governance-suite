import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { aggregate, canonicalSet, oracleDigest, sameSet, scoreCase, type Observation, type SemanticCase } from "./evaluation.js";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import { RuntimeSkillClassificationGateway } from "../../mcp-server/src/skill-classification/gateway.js";
import { digestClassificationValue } from "../../mcp-server/src/skill-classification/request.js";

const root = new URL("../../", import.meta.url).pathname;
const output = process.env.SS34_EVIDENCE_OUTPUT ?? ".";
const corpus = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
const sourceCase = corpus.cases.find((c: { caseId: string }) => c.caseId === "SS34");
const hash = (value: string | Buffer) => "sha256:" + createHash("sha256").update(value).digest("hex");
const sourceDigest = hash(readFileSync(root + "skills/cs-engineering/SKILL.md"));
const currentCandidate = hash("SS34 synthetic candidate A; no actual skill application");
const condition = hash("SS34 synthetic environment A");
const phases = JSON.parse(readFileSync(root + "skills/korean-prose-editor/integration/skill-descriptor.json", "utf8"))
  .providers.map((p: {phase: string}) => p.phase);
const rows: any[] = [];

// SS34 has no semantic oracle. This separate sentinel enables only the existing
// aggregate stage predicate. It is not an SS34 golden answer; its quality metrics
// are deliberately never exported or used to compute SS34 accuracy.
const sentinel: SemanticCase = { caseId: "SS34-MECHANICAL-STAGE-PROBE", familyId: "mechanical-probe",
  oracle: { required: [], allowed: ["cs-engineering", "korean-prose-editor"], forbidden: [],
    notApplicable: [], unadjudicated: [], expectedSelection: "SELECTED", requiredReasons: [], allowedConditions: {} } };

function base(ids = ["cs-engineering"]): Observation {
  return { caseId: sentinel.caseId, layer: "selected", state: "PASS", skillIds: ids,
    selectionStatus: "SELECTED", reasonCodes: [], selectionReasons: [], executionKind: "offline-mock",
    host: "MOCK-HOST-NOT-LIVE", hostReceipt: { receiptId: "MOCK-ONLY-NOT-A-HOST-RECEIPT", host: "MOCK-HOST-NOT-LIVE",
      requestDigest: hash("synthetic request"), inventoryDigest: hash("synthetic inventory"),
      agentSelectedSkillIds: ids, acceptedAt: "2026-10-09T00:00:00Z" },
    requestDigest: hash("synthetic request"), inventoryDigest: hash("synthetic inventory"),
    conditionDigest: condition, candidateDigest: currentCandidate,
    stageEvidence: { read: false, applied: false, verified: false } };
}
function read(o = base()): Observation {
  o.stageEvidence = { ...o.stageEvidence, read: true,
    readRefs: [{ path: "skills/cs-engineering/SKILL.md", digest: sourceDigest }] }; return o;
}
function applied(o = read()): Observation {
  o.stageEvidence = { ...o.stageEvidence, applied: true,
    obligations: [{ obligationId: "SS34-synthetic-obligation", artifactRef: "mock://candidate-A/design" }],
    requiredPhases: ["cs-constraint-derivation", "cs-implementation-review"],
    completedPhases: ["cs-constraint-derivation", "cs-implementation-review"] }; return o;
}
function verified(o = applied()): Observation {
  o.stageEvidence = { ...o.stageEvidence, verified: true,
    verification: { candidateDigest: currentCandidate, result: "PASS", evidenceRef: "mock://candidate-A/planned-verification" } }; return o;
}
function inspect(o: Observation) {
  const result = aggregate([sentinel], [o], o.layer, corpus.inventorySkillIds);
  const selected = o.layer === "selected" && result.scores[0].answered;
  return { selected, ...Object.fromEntries(Object.entries(result.stageCoverage).map(([k,v]) => [k,v === 1])),
    contractVerdict: result.scores[0].verdict, reasons: result.scores[0].reasons };
}
function compare(id: string, kind: string, input: unknown, expected: unknown, observed: unknown, finding?: string) {
  const matches = JSON.stringify(expected) === JSON.stringify(observed);
  rows.push({ id, kind, input, expected, observed, status: matches ? "PASS" : "FAIL", finding: matches ? null : finding,
    executionKind: "offline-mock", actualHostStages: {selected: "NOT_RUN", read: "NOT_RUN", applied: "NOT_RUN", verified: "NOT_RUN"} });
  expect(observed, `${id}: ${finding ?? "SS34 embedded source expectation"}`).toEqual(expected);
}
const stages = (selected: boolean, read: boolean, applied: boolean, verified: boolean) => ({ selected, read, applied, verified });
function justStages(o: Observation) { const {contractVerdict, reasons, ...s} = inspect(o); return s; }

afterAll(() => writeFileSync(output + "/SS34.observations.json", JSON.stringify({ caseId: "SS34", sourceCase,
  originalPrompt: null, oracle: null, semanticAccuracy: null, stageProbeSentinel: sentinel,
  warning: "All host receipts, obligations, artifactRefs and verification inputs below are synthetic. No actual host selection or skill application is established.",
  apiCalls: {jev: 0, externalVendor: 0, claude: 0}, rows }, null, 2) + "\n"));

describe("SS34 binding and evaluator support", () => {
  it("keeps frozen SS34 nulls and exact eight variants", () => {
    expect(hash(readFileSync(root + "tests/skill-classification/fixtures.json"))).toBe("sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9");
    expect(oracleDigest(corpus)).toBe("sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055");
    expect(sourceCase.originalPrompt).toBeNull(); expect(sourceCase.oracle).toBeNull();
    expect(sourceCase.variants).toEqual(["recommend-only", "selected", "read", "applied", "verified", "wrong-candidate", "missing-k-phase", "no-admission-negative"]);
    expect(canonicalSet(null)).toBeNull(); expect(canonicalSet([])).toEqual([]); expect(sameSet(null, [])).toBe(false);
  });
  it("documents direct operational evaluator rejection without inventing an oracle", () => {
    const o = { ...base(), caseId: "SS34" };
    expect(() => scoreCase(sourceCase, o, corpus.inventorySkillIds)).toThrow("NO_SEMANTIC_ORACLE:SS34");
    expect(() => aggregate([sourceCase], [o], "selected", corpus.inventorySkillIds)).toThrow("UNKNOWN_CASE_OBSERVATION");
    rows.push({id: "operational-evaluator-support", kind: "new-boundary", status: "BLOCKED",
      expected: "SS34 nonsemantic contract checking; no accuracy", observed: {scoreCase: "NO_SEMANTIC_ORACLE:SS34", aggregate: "UNKNOWN_CASE_OBSERVATION"},
      semanticAccuracy: null, evidence: "Direct calls on unmodified frozen case; sentinel used separately only for stage predicates"});
  });
});

describe("SS34 all frozen variants", () => {
  it("recommend-only", () => {
    const o = { ...base(), layer: "vendorRaw" as const, hostReceipt: null, selectionStatus: "PROPOSED" };
    compare("recommend-only", "existing-regression-adaptation", o, stages(false,false,false,false), justStages(o));
  });
  it("selected", () => { const o = base(); compare("selected", "existing-regression-adaptation", o, stages(true,false,false,false), justStages(o)); });
  it("read", () => { const o = read(); compare("read", "new-variant", o, stages(true,true,false,false), justStages(o)); });
  it("applied", () => { const o = applied(); compare("applied", "new-variant", o, stages(true,true,true,false), justStages(o)); });
  it("verified", () => { const o = verified(); compare("verified", "existing-regression-adaptation", o, stages(true,true,true,true), justStages(o)); });
  it("wrong-candidate", () => {
    const o = { ...verified(), candidateDigest: hash("synthetic candidate B") };
    compare("wrong-candidate", "existing-regression-adaptation", o, stages(true,true,true,false), justStages(o));
  });
  it("missing-k-phase", () => {
    const o = verified(applied(read(base(["korean-prose-editor"]))));
    o.stageEvidence.readRefs = [{path: "skills/korean-prose-editor/SKILL.md", digest: hash(readFileSync(root + "skills/korean-prose-editor/SKILL.md"))}];
    o.stageEvidence.requiredPhases = phases;
    o.stageEvidence.completedPhases = phases.filter((p: string) => p !== "korean-prose-verification");
    compare("missing-k-phase", "existing-regression-adaptation", o, stages(true,true,false,false), justStages(o));
  });
  it("no-admission-negative", () => {
    const o = { ...base(), admissionStatus: null, executionStarted: true };
    compare("no-admission-negative", "new-variant", o, "FAIL", inspect(o).contractVerdict,
      "SS34-F1: evaluator has no admission/execution check; this does not demonstrate a workflow admission bypass");
  });
});

describe("SS34 omitted binding boundaries", () => {
  it("rejects plain stage declarations", () => {
    const o = base(); o.stageEvidence = {read:true, applied:true, verified:true};
    compare("labels-only", "existing-regression-adaptation", o, stages(true,false,false,false), justStages(o));
  });
  it("rejects wrong-environment verification on the same candidate", () => {
    const o = verified();
    (o.stageEvidence.verification as any).conditionDigest = hash("different environment B");
    compare("wrong-environment", "new-boundary", o, false, inspect(o).verified,
      "SS34-F2: verification candidate matches, but environment binding is ignored");
  });
  it("does not credit a mismatching source-file digest", () => {
    const o = read(); o.stageEvidence.readRefs![0].digest = hash("different skill body");
    compare("wrong-source-digest", "new-boundary", {trace:o, actualSourceDigest:sourceDigest}, false, inspect(o).read,
      "SS34-F2: digest syntax is checked but source bytes are not linked");
  });
  it("requires a planned verification evidence artifact", () => {
    const o = verified(); o.stageEvidence.verification!.evidenceRef = "mock://MISSING-UNPLANNED-evidence";
    compare("unplanned-missing-evidence", "new-boundary", o, false, inspect(o).verified,
      "SS34-F2: any nonempty evidenceRef is credited; no plan or artifact binding");
  });
  it("requires obligations bound to the candidate artifact", () => {
    const o = applied(); o.stageEvidence.obligations![0].artifactRef = "mock://candidate-B/unrelated";
    compare("wrong-obligation-artifact", "new-boundary", o, false, inspect(o).applied,
      "SS34-F2: obligation and artifact strings are nonempty, but candidate linkage is unchecked");
  });
  it("derives required K phases rather than trusting a shortened list", () => {
    const o = verified(applied(read(base(["korean-prose-editor"]))));
    o.stageEvidence.requiredPhases = phases.filter((p: string) => p !== "korean-prose-verification");
    o.stageEvidence.completedPhases = [...o.stageEvidence.requiredPhases!];
    compare("omitted-required-k-phase-list", "new-boundary", {trace:o, descriptorRequiredPhases:phases}, false, inspect(o).applied,
      "SS34-F3: caller-controlled requiredPhases can omit a mandatory capability");
  });
  it("does not credit an explicitly failing verification", () => {
    const o = verified(); o.stageEvidence.verification!.result = "FAIL";
    compare("verification-fail", "existing-regression-adaptation", o, false, inspect(o).verified);
  });
  it("does not credit verification marked NOT_RUN", () => {
    const o = verified(); o.stageEvidence.verification!.result = "NOT_RUN";
    compare("verification-not-run", "new-boundary", o, false, inspect(o).verified);
  });
});

describe("SS34 actual gateway code with synthetic observation; not host-live", () => {
  it("keeps provider advice, mocked acceptance, admission and completion separate", async () => {
    const inventory = await loadSkillInventory({root}); expect(inventory.issues).toEqual([]);
    const runtime = {config: {jevEnabled:false, mode:"select" as const, providerProfileRegistryRef:"mock", externalClassificationAllowed:false, configRevision:"mock", timeoutMs:1000},
      registry:{schemaVersion:"1.0.0" as const, profileRevision:"mock", profiles:[]}, allowRemotePrivateContent:false};
    // No real provider, route, credential or external network. Gateway service port
    // is mocked; the gateway, inventory loader and decision validator are real.
    const service = {classify: vi.fn(async ({request, config}: any) => ({request, config,
      snapshot:{taskRevision:null, requestDigest:request.requestDigest, inventoryDigest:request.inventoryDigest, configRevision:"mock", profileRevision:"mock", cancelled:false},
      response:{schemaVersion:"1.0.0", requestId:request.requestId, operationId:request.operationId, requestDigest:request.requestDigest, inventoryDigest:request.inventoryDigest, status:"SUCCESS",
        judgments:request.skills.map((s:any)=>({skillId:s.skillId, judgment:s.skillId==="cs-engineering"?"needed":"not-needed", reasonRefs:["mock://purpose"], uncertaintyReason:null})), unresolvedItems:[], error:null},
      attempts:[], jevRaw:null, vendorRaw:null}))};
    const gateway = new RuntimeSkillClassificationGateway({root, service: service as any,
      readRuntime:async()=>runtime, now:()=>new Date("2026-10-09T00:00:00Z"),
      observeTask:(request, obs)=>obs ? {taskRevision:null, requestDigest:request.requestDigest, cancelled:false, sourceRef:"MOCK-HOST-TASK"} : null});
    const input = {schemaVersion:"1.0.0", requestId:"SS34-MOCK-GATEWAY", operationId:"SS34-MOCK-GATEWAY",
      originalPrompt:sourceCase.sourceSpec.fields["입력"], confirmedContext:{taskRevision:null, objective:null, actions:null, targets:null, constraints:null, prohibitedActions:null, background:null},
      contextSources:[], explicitSkillIds:[], ruleRequiredSkillIds:[], vendorContext:{vendorId:"MOCK",reference:"mock://port"}, publicSynthetic:true};
    const observation = {source:"runtime", taskId:input.requestId, actorId:"MOCK:SS34", observationId:"MOCK-ONLY", observedAt:"2026-10-09T00:00:00Z", expiresAt:"2026-10-09T00:01:00Z"} as any;
    const advice = await gateway.classify(input, observation) as any;
    expect(advice.agentSelectedSkillIds).toBeNull(); expect(advice.selectionStatus).toBe("PROPOSED");
    const decision = {schemaVersion:"1.0.0", classificationResponseRef:digestClassificationValue(advice.result.response),
      requestDigest:advice.result.request.requestDigest, inventoryDigest:advice.result.request.inventoryDigest, taskRevision:null, configRevision:"mock", profileRevision:"mock",
      explicitSkillIds:[], ruleRequiredSkillIds:[], agentSelectedSkillIds:["cs-engineering"], selectionReasons:[{skillId:"cs-engineering",reason:"Mock test decision; no real AGENT selection"}],
      applicabilityChecks:[{skillId:"cs-engineering",applies:true,excluded:false,reasonRefs:["mock://purpose"]}], unresolvedSkillReferences:[], selectionStatus:"SELECTED", adviceApplied:true, hostReceipt:null};
    const args = {schemaVersion:"1.0.0", operationId:input.operationId, decision};
    const absent = await gateway.accept(args, null) as any;
    expect(absent.agentSelectedSkillIds).toBeNull(); expect(absent.valid).toBe(false);
    const accepted = await gateway.accept(args, {...observation, taskId:decision.requestDigest}) as any;
    expect(accepted.valid).toBe(true);
    expect(accepted).toMatchObject({neededSkillIds:["cs-engineering"], runnableSkillIds:["cs-engineering"], admissionStatus:"NOT_EVALUATED",readStatus:"NOT_OBSERVED",appliedStatus:"NOT_OBSERVED",verifiedStatus:"NOT_RUN"});
    await expect(gateway.accept({...args,decision:{...decision,hostReceipt:accepted.decision.hostReceipt}}, {...observation,taskId:decision.requestDigest})).rejects.toThrow("CALLER_SELECTION_RECEIPT_REJECTED");
    rows.push({id:"gateway-separation", kind:"new-offline-integration",status:"PASS",input:{...input,originalPromptSource:"embedded SS34 sourceSpec.fields.입력 (synthetic gateway input, not a semantic originalPrompt)"},
      observed:{advice: {agentSelectedSkillIds:advice.agentSelectedSkillIds,selectionStatus:advice.selectionStatus}, absent,accepted},
      actualHostStages:{selected:"NOT_RUN",read:"NOT_RUN",applied:"NOT_RUN",verified:"NOT_RUN"}, mockServiceCalls:service.classify.mock.calls.length,
      API0:{jev:0,externalVendor:0,claude:0}, independentAudit:"NOT_RUN"});
  });
});
