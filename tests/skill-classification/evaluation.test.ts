import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aggregateLegacy as aggregate, canonicalSet, checkFamilySplit, evaluateLegacyLayers as evaluateLayers, fromLegacySelection as fromSelection, oracleDigest, legacyPairedMatrix as pairedMatrix, scoreLegacyCase as scoreCase, scoreLegacyPairs as scorePairs, sameSet, type Layer, type LegacyObservation as Observation, type Oracle, type SemanticCase } from "./evaluation.js";
import type { SkillSelectionDecisionV1 } from "../../mcp-server/src/skill-classification/types.js";
import type { SkillClassificationRequestV1, SkillClassificationResponseV1 } from "../../mcp-server/src/skill-classification/types.js";
import * as current from "./evaluation.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const corpus = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8")) as {
  targetRelease: string; oracleDigest: string; oracleRevision: string; sourceSpecDigest: string;
  sourceSkills: { skillId: string; path: string; digest: string }[]; inventorySkillIds: string[];
  cases: (SemanticCase & { originalPrompt: string | null; status: string; sourceSpec: { fields: Record<string, string> }; variants: string[] })[];
  metadataRoleCases: { variantId: string; required: string[]; forbidden: string[] }[];
  sourceProvenanceCases: unknown[]; pairedMatrix: { expectedPairs: number; expectedHostTrials: number }; split: { calibration: string[]; holdout: string[]; independentHoldoutClaim: boolean };
};
const fixture = (id: string) => corpus.cases.find(x => x.caseId === id)!;
function mock(id: string, skills: string[] | null, layer: Layer = "jevRaw", host = "codex"): Observation {
  return { caseId: id, layer, state: "PASS", skillIds: skills, selectionStatus: skills === null ? "NEEDS_INPUT" : "SELECTED",
    reasonCodes: [], selectionReasons: [], executionKind: "offline-mock", host,
    hostReceipt: layer === "selected" && skills !== null ? { receiptId: "mock-only", host,
      requestDigest: "request-mock", inventoryDigest: "inventory-mock", agentSelectedSkillIds: skills, acceptedAt: "2000-01-01T00:00:00Z" } : null,
    requestDigest: "request-mock", inventoryDigest: "inventory-mock", conditionDigest: "condition-mock",
    stageEvidence: { read: false, applied: false, verified: false } };
}

describe("pre-live frozen specification mapping", () => {
  it("maps every source SS01–39 and preserves all required fields as NOT_RUN", () => {
    expect(corpus.cases.map(x => x.caseId)).toEqual(Array.from({ length: 39 }, (_, i) => `SS${String(i + 1).padStart(2, "0")}`));
    expect(corpus.targetRelease).toBe("2.9.1");
    for (const c of corpus.cases) {
      expect(c.status).toBe("NOT_RUN");
      expect(Object.keys(c.sourceSpec.fields)).toEqual(["입력", "필수추천", "금지추천 또는 행동", "허용선택", "보류조건", "통과기준", "증거", "실행종류"]);
      expect(c.variants.length).toBeGreaterThan(0);
    }
    expect(corpus.cases.filter(x => x.oracle !== null)).toHaveLength(18);
    expect(fixture("SS39").variants).toHaveLength(12);
    expect(oracleDigest(corpus)).toBe(corpus.oracleDigest);
    expect(corpus.split.independentHoldoutClaim).toBe(false);
  });
  it("binds oracle to actual source bytes and preserves O boundaries", () => {
    for (const s of corpus.sourceSkills) {
      const bytes = readFileSync(new URL(`../../${s.path}`, import.meta.url));
      expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(s.digest);
    }
    expect(fixture("SS04").oracle!.required).toEqual(["cs-engineering", "test-engineering", "orchestrator"]);
    expect(fixture("SS04").oracle!.allowed).toEqual(["ponytail"]);
    expect(fixture("SS05").oracle!.required).toEqual(["code-review", "cs-engineering", "orchestrator"]);
    expect(fixture("SS06").oracle!.forbidden).toContain("orchestrator");
  });
  it("maps neutral IDs and role-swapped expected results without product fixed IDs", () => {
    expect(corpus.metadataRoleCases.map(x => x.required)).toEqual([["skill-z17"], ["skill-z18"], ["neutral-q83"]]);
    for (const m of corpus.metadataRoleCases) {
      const oracle: Oracle = { required: m.required, allowed: [], forbidden: m.forbidden, notApplicable: [], unadjudicated: [], expectedSelection: "SELECTED", requiredReasons: [], allowedConditions: {} };
      const f = { caseId: m.variantId, familyId: "new-metadata", oracle };
      expect(scoreCase(f, mock(m.variantId, m.required), [...m.required, ...m.forbidden]).verdict).toBe("PASS");
      expect(scoreCase(f, mock(m.variantId, m.forbidden), [...m.required, ...m.forbidden]).verdict).toBe("FAIL");
    }
  });
});

describe("independent hand-calculated evaluator controls", () => {
  it("rejects select-all despite recall 1 and accepts only R", () => {
    const f = fixture("SS03");
    const all = aggregate([f], [mock("SS03", corpus.inventorySkillIds)], "jevRaw", corpus.inventorySkillIds);
    expect(all.requiredRecall).toBe(1);
    expect(all.truePositives).toBe(4);
    expect(all.falsePositives).toBe(3); // CR, SEC, K have reviewed incompatible roles.
    expect(all.precision).toBeNull(); // Unadjudicated extra roles cannot be silently counted as correct/wrong.
    expect(all.verdict).toBe("INCOMPLETE_OR_FAIL");
    const exact = aggregate([f], [mock("SS03", ["ponytail", "cs-engineering", "test-engineering", "orchestrator"])], "jevRaw", corpus.inventorySkillIds);
    expect(exact.precision).toBe(1);
    expect(exact.requiredRecall).toBe(1);
    expect(exact.exactPurposeSuccessRate).toBe(1);
    expect(exact.verdict).toBe("PASS");
  });
  it("detects each missing label and forbidden extra independently", () => {
    const f = fixture("SS03");
    const score = aggregate([f], [mock("SS03", ["ponytail", "orchestrator"])], "jevRaw", corpus.inventorySkillIds);
    expect(score.requiredRecall).toBe(0.5);
    expect(score.scores[0]!.missingRequired).toEqual(["cs-engineering", "test-engineering"]);
    expect(score.verdict).toBe("INCOMPLETE_OR_FAIL");
    const forbidden = aggregate([fixture("SS10")], [mock("SS10", ["code-review", "ponytail"])], "jevRaw", corpus.inventorySkillIds);
    expect(forbidden.precision).toBe(0.5);
    expect(forbidden.forbiddenViolationRate).toBe(1);
    expect(forbidden.scores[0]!.verdict).toBe("FAIL");
    expect(scoreCase(f, mock("SS03", [...f.oracle!.required, "session-board"]), corpus.inventorySkillIds).verdict).toBe("REVIEW_REQUIRED");
  });
  it("preserves all failure and abstention denominators", () => {
    const cases = [fixture("SS01"), fixture("SS09"), fixture("SS03"), fixture("SS10")];
    const result = aggregate(cases, [mock("SS01", ["ponytail"]), mock("SS09", null), { ...mock("SS03", null), state: "FAIL" }], "jevRaw", corpus.inventorySkillIds);
    expect(result.denominator).toBe(4);
    expect(result.requiredTotal).toBe(6);
    expect(result.requiredRecall).toBeCloseTo(1 / 6);
    expect(result.passes).toBe(1);
    expect(result.failures).toBe(2);
    expect(result.notRun).toBe(1);
    expect(result.coverage).toBe(0.25);
    expect(result.abstentionRate).toBe(0.25);
    expect(result.unnecessaryAbstentionRate).toBe(0.25);
    expect(result.exactPurposeSuccessRate).toBe(0.25);
    const allAbstain = aggregate([fixture("SS01"), fixture("SS09")], [mock("SS01", null, "selected"), mock("SS09", null, "selected")], "selected", corpus.inventorySkillIds);
    expect(allAbstain.coverage).toBe(0);
    expect(allAbstain.unnecessaryAbstentionRate).toBe(1);
    expect(allAbstain.verdict).toBe("INCOMPLETE_OR_FAIL");
  });
  it("never credits rules or final agent correction as raw or vendor quality", () => {
    const f = fixture("SS18");
    const report = evaluateLayers([f], [mock("SS18", ["ponytail"]), mock("SS18", ["ponytail"], "vendorRaw"), mock("SS18", f.oracle!.required, "combined"), mock("SS18", f.oracle!.required, "selected")], corpus.inventorySkillIds);
    expect(report.jevRaw!.requiredRecall).toBeCloseTo(1 / 3);
    expect(report.vendorRaw!.requiredRecall).toBeCloseTo(1 / 3);
    expect(report.combined!.requiredRecall).toBe(1);
    expect(report.selected!.requiredRecall).toBe(1);
    expect(report.selected!.stageCoverage).toEqual({ read: 0, applied: 0, verified: 0 });
  });
  it("distinguishes null from accepted empty, and validates uncertainty reasons", () => {
    expect(canonicalSet(null)).toBeNull();
    expect(sameSet(null, [])).toBe(false);
    expect(sameSet(["ponytail", "ponytail"], ["ponytail"])).toBe(true);
    expect(scoreCase(fixture("SS09"), mock("SS09", [], "selected"), corpus.inventorySkillIds).verdict).toBe("PASS");
    expect(scoreCase(fixture("SS09"), mock("SS09", null, "selected"), corpus.inventorySkillIds).verdict).toBe("FAIL");
    const unclear = { ...mock("SS12", null, "selected"), reasonCodes: ["missing-action", "missing-target"] };
    expect(scoreCase(fixture("SS12"), unclear, corpus.inventorySkillIds).verdict).toBe("PASS");
    expect(scoreCase(fixture("SS12"), mock("SS12", [], "selected"), corpus.inventorySkillIds).verdict).toBe("FAIL");
  });
  it("requires host acceptance without fabricating a receipt from advice", () => {
    const f = fixture("SS01");
    expect(scoreCase(f, { ...mock("SS01", ["ponytail"], "selected"), hostReceipt: null }, corpus.inventorySkillIds).verdict).toBe("FAIL");
    const decision: SkillSelectionDecisionV1 = { schemaVersion: "1.0.0", classificationResponseRef: "mock-response", requestDigest: "request-mock", inventoryDigest: "inventory-mock", taskRevision: null, configRevision: "mock", profileRevision: "mock", explicitSkillIds: [], ruleRequiredSkillIds: [], agentSelectedSkillIds: null, selectionReasons: [], applicabilityChecks: [], unresolvedSkillReferences: [], selectionStatus: "PROPOSED", adviceApplied: false, hostReceipt: null };
    const converted = fromSelection("SS01", decision, mock("SS01", ["ponytail"]));
    expect(converted.skillIds).toBeNull();
    expect(converted.hostReceipt).toBeNull();
    expect(scoreCase(f, converted, corpus.inventorySkillIds).verdict).toBe("FAIL");
    expect(scoreCase(f, mock("SS01", ["P"]), corpus.inventorySkillIds).reasons).toContain("UNKNOWN_CANONICAL_ID");
    expect(() => aggregate([f], [mock("SS01", ["ponytail"]), mock("SS01", ["ponytail"])], "jevRaw", corpus.inventorySkillIds)).toThrow("DUPLICATE_OBSERVATION");
  });
  it("never promotes stage labels without source, obligation, phase and candidate evidence", () => {
    const f = fixture("SS03");
    const declared = { ...mock("SS03", f.oracle!.required, "selected"), candidateDigest: "candidate-current",
      stageEvidence: { read: true, applied: true, verified: true } };
    expect(aggregate([f], [declared], "selected", corpus.inventorySkillIds).stageCoverage).toEqual({ read: 0, applied: 0, verified: 0 });
    const evidenced = { ...declared, stageEvidence: { ...declared.stageEvidence,
      readRefs: [{ path: "skills/cs-engineering/SKILL.md", digest: `sha256:${"a".repeat(64)}` }],
      obligations: [{ obligationId: "duplicate-completion", artifactRef: "mock-design" }],
      requiredPhases: ["analysis", "review"], completedPhases: ["analysis", "review"],
      verification: { candidateDigest: "candidate-current", result: "PASS" as const, evidenceRef: "mock-verification" } } };
    expect(aggregate([f], [evidenced], "selected", corpus.inventorySkillIds).stageCoverage).toEqual({ read: 1, applied: 1, verified: 1 });
    expect(aggregate([f], [{ ...evidenced, candidateDigest: "another-candidate" }], "selected", corpus.inventorySkillIds).stageCoverage.verified).toBe(0);
    expect(aggregate([f], [{ ...evidenced, stageEvidence: { ...evidenced.stageEvidence, completedPhases: ["analysis"] } }], "selected", corpus.inventorySkillIds).stageCoverage.applied).toBe(0);
    expect(aggregate([f], [{ ...evidenced, layer: "jevRaw" }], "jevRaw", corpus.inventorySkillIds).stageCoverage).toEqual({ read: 0, applied: 0, verified: 0 });
  });
});

describe("family isolation and paired trial controls", () => {
  it("rejects translations and synonyms leaking across split", () => {
    expect(checkFamilySplit(corpus.cases, corpus.split.calibration, corpus.split.holdout)).toEqual([]);
    expect(checkFamilySplit(corpus.cases, ["SS01"], ["SS02"])).toContain("FAMILY_LEAKAGE");
    const paraphrase = { ...fixture("SS03"), caseId: "SS03-paraphrase" };
    expect(checkFamilySplit([...corpus.cases, paraphrase], ["SS03"], ["SS03-paraphrase"])).toContain("FAMILY_LEAKAGE");
  });
  it("retains all 120 pairs / 240 host slots as NOT_RUN until observed", () => {
    const matrix = pairedMatrix();
    expect(matrix).toHaveLength(120);
    expect(new Set(matrix.map(x => x.pairId)).size).toBe(120);
    const result = scorePairs([], corpus.cases, corpus.inventorySkillIds);
    expect(result.expectedPairs).toBe(120);
    expect(result.notRunPairs).toBe(120);
    expect(result.exactSetAgreement).toBeNull();
    expect(result.completedPurposeRate).toBe(0);
    expect(result.stability.map(x => [x.denominator, x.notRunGroups])).toEqual([[40, 40], [40, 40]]);
    expect(result.releaseAcceptance).toBe("NOT_ASSESSED");
    expect(result.verdict).toBe("INCOMPLETE_OR_FAIL");
  });
  it("fails two equally wrong hosts even when measured agreement is 1", () => {
    const pair = pairedMatrix().find(x => x.caseId === "SS03")!;
    const result = scorePairs([{ ...pair, codex: mock("SS03", ["ponytail"], "selected", "codex"), claude: mock("SS03", ["ponytail"], "selected", "claude") }], corpus.cases, corpus.inventorySkillIds);
    expect(result.exactSetAgreement).toBe(1);
    expect(result.completedPurposeRate).toBe(0);
    expect(result.records.find(x => x.pairId === pair.pairId)!.status).toBe("FAIL");
    expect(result.verdict).toBe("INCOMPLETE_OR_FAIL");
  });
  it("reports allowed alternatives as disagreement and unmatched as missing coverage", () => {
    const pair = pairedMatrix().find(x => x.caseId === "SS04")!;
    const base = fixture("SS04").oracle!.required;
    const trial = { ...pair, codex: mock("SS04", base, "selected", "codex"), claude: mock("SS04", [...base, "ponytail"], "selected", "claude") };
    const result = scorePairs([trial], corpus.cases, corpus.inventorySkillIds);
    const record = result.records.find(x => x.pairId === pair.pairId)!;
    expect(record.codexGolden).toBe("PASS"); expect(record.claudeGolden).toBe("PASS");
    expect(record.agreement).toBe(false); expect(record.status).toBe("FAIL");
    const unmatched = scorePairs([{ ...trial, claude: { ...trial.claude, conditionDigest: "different-context" } }], corpus.cases, corpus.inventorySkillIds);
    expect(unmatched.unmatchedPairs).toBe(1); expect(unmatched.notRunPairs).toBe(119);
    expect(unmatched.comparedPairs).toBe(0); expect(unmatched.completedPurposeRate).toBe(0);
  });
  it("measures within-host repeat stability without calling repetition independent holdout", () => {
    const repeats = pairedMatrix().filter(x => x.caseId === "SS01" && x.path === "jev-on");
    const result = scorePairs(repeats.map(x => ({ ...x,
      codex: mock("SS01", ["ponytail"], "selected", "codex"),
      claude: mock("SS01", x.repetition === 3 ? [] : ["ponytail"], "selected", "claude") })), corpus.cases, corpus.inventorySkillIds);
    expect(result.stability[0]!.stableGroups).toBe(1);
    expect(result.stability[1]!.unstableGroups).toBe(1);
    expect(result.stability[0]!.notRunGroups).toBe(39);
    expect(result.completedPurposeRate).toBeCloseTo(2 / 120);
  });
});

const boundDigest = `sha256:${"a".repeat(64)}`;
function requestMock(id: string): SkillClassificationRequestV1 {
  // Only fields read by common response validation; never sent as a real request.
  return {requestId: `mock/${id}`, operationId: `mock/${id}`, requestDigest: boundDigest, inventoryDigest: boundDigest,
    skills: corpus.inventorySkillIds.map(skillId => ({skillId}))} as unknown as SkillClassificationRequestV1;
}
function responseMock(id: string, needed: string[] = [], uncertain: string[] = []): SkillClassificationResponseV1 {
  return {schemaVersion: "1.0.0", requestId: `mock/${id}`, operationId: `mock/${id}`, requestDigest: boundDigest, inventoryDigest: boundDigest,
    status: uncertain.length ? "PARTIAL" : "SUCCESS", judgments: corpus.inventorySkillIds.map(skillId => ({skillId,
      judgment: needed.includes(skillId) ? "needed" : uncertain.includes(skillId) ? "uncertain" : "not-needed", reasonRefs: ["mock-response-not-model-quality"],
      uncertaintyReason: uncertain.includes(skillId) ? "JEV_JUDGMENT_UNCERTAIN" : null})),
    unresolvedItems: uncertain.map(skillId => ({skillId, reasonCode: "JEV_JUDGMENT_UNCERTAIN"})), error: null};
}
function classificationMock(id: string, response: unknown = responseMock(id)): current.ClassificationObservation {
  return current.fromClassification(id, requestMock(id), response, {state: "PASS", executionKind: "offline-mock", conditionDigest: boundDigest,
    producerDiagnostics: {errorCode: null, capViolation: false, dispatchState: "started", responseValidationErrors: []}});
}
function selectionMock(id: string, selected: string[] | null): current.SelectionObservation {
  const decision: SkillSelectionDecisionV1 = {schemaVersion: "1.0.0", classificationResponseRef: boundDigest, requestDigest: boundDigest, inventoryDigest: boundDigest,
    taskRevision: null, configRevision: "mock", profileRevision: "mock", explicitSkillIds: [], ruleRequiredSkillIds: [], agentSelectedSkillIds: selected,
    selectionStatus: selected === null ? "NEEDS_INPUT" : "SELECTED", selectionReasons: (selected ?? []).map(skillId => ({skillId, reason: "mock-only"})),
    applicabilityChecks: [], unresolvedSkillReferences: [], adviceApplied: false,
    hostReceipt: selected === null ? null : {receiptId: "synthetic-not-host-attestation", host: "codex", requestDigest: boundDigest, inventoryDigest: boundDigest,
      agentSelectedSkillIds: selected, acceptedAt: "2000-01-01T00:00:00.000Z"}};
  return current.fromSelection(id, decision, {requestId: `mock/${id}`, operationId: `mock/${id}`, state: "PASS", executionKind: "offline-mock", conditionDigest: boundDigest,
    host: "codex", stageEvidence: {read: false, applied: false, verified: false}});
}

describe("R14 versioned observation boundaries", () => {
  it("type-and-response-boundary preserves full PARTIAL without a selected claim", () => {
    const response = responseMock("SS07", ["software-security-auditor"], ["task-contract"]);
    const observation = classificationMock("SS07", response);
    expect(observation.classificationResponse).toEqual(response);
    expect(observation.classificationResponse).not.toBe(response);
    expect(Object.keys(observation)).not.toContain("selectionStatus");
    expect(Object.keys(observation)).not.toContain("agentSelectedSkillIds");
    expect(() => current.assertObservation({...observation, selectionStatus: "SELECTED"}, corpus.inventorySkillIds)).toThrow();
    expect(() => current.assertObservation({...observation, kind: "selection"}, corpus.inventorySkillIds)).toThrow();
    expect(() => current.assertObservation({...observation, classificationResponse: {...response, judgments: []}}, corpus.inventorySkillIds)).toThrow("INVALID_CLASSIFICATION_OBSERVATION_RESPONSE");
    expect(() => current.assertObservation({...observation, classificationResponse: {...response, requestDigest: `sha256:${"b".repeat(64)}`}}, corpus.inventorySkillIds)).toThrow();
    const semanticUncertain = classificationMock("SS07", {...response, status: "UNCERTAIN"});
    expect(semanticUncertain.classificationResponse).toEqual({...response, status: "UNCERTAIN"});
    expect(current.scoreCase(fixture("SS07"), semanticUncertain, corpus.inventorySkillIds).requiredHits).toBe(1);
    expect(current.scoreCase(fixture("SS07"), semanticUncertain, corpus.inventorySkillIds).verdict).toBe("PASS");
  });
  it("type-and-response-boundary preserves valid failure RESP and distinguishes absent/rejected", () => {
    for (const status of ["UNAVAILABLE", "INVALID", "UNCERTAIN"] as const) {
      const response: SkillClassificationResponseV1 = {...responseMock("SS01"), status, judgments: [],
        error: {code: "MOCK_PROVIDER_FAILURE", retryable: true, dispatchState: "unknown"}};
      const observation = classificationMock("SS01", response);
      expect(observation.classificationResponse).toEqual(response);
      expect(observation.state).toBe("BLOCKED");
      expect(current.scoreCase(fixture("SS01"), observation, corpus.inventorySkillIds).verdict).toBe("BLOCKED");
      expect(() => current.assertObservation({...observation, state: "PASS"}, corpus.inventorySkillIds)).toThrow("FAILURE_RESPONSE_CANNOT_PASS");
    }
    const absent = classificationMock("SS01", null);
    expect(absent.classificationResponse).toBeNull(); expect(absent.state).toBe("BLOCKED");
    expect(absent.producerDiagnostics.responseValidationErrors).toEqual([]);
    const rejected = classificationMock("SS01", {status: "SUCCESS"});
    expect(rejected.classificationResponse).toBeNull();
    expect(rejected.producerDiagnostics.responseValidationErrors).toEqual(["INVALID_RESPONSE_SCHEMA"]);
    expect(() => current.assertObservation({...rejected, classificationResponse: {status: "SUCCESS"}}, corpus.inventorySkillIds)).toThrow();
    const previouslyRejected = current.fromClassification("SS01", requestMock("SS01"), null, {state: "BLOCKED", executionKind: "offline-mock", conditionDigest: boundDigest,
      producerDiagnostics: {...rejected.producerDiagnostics, dispatchState: "unknown"}});
    expect(previouslyRejected.producerDiagnostics).toEqual({...rejected.producerDiagnostics, dispatchState: "unknown"});
  });
  it("partial-information retains known needed and every original required omission", () => {
    for (const [id, known, uncertain, missing] of [
      ["SS03", ["cs-engineering", "test-engineering"], ["ponytail"], ["ponytail", "orchestrator"]],
      ["SS04", ["cs-engineering", "test-engineering"], ["orchestrator", "ponytail"], ["orchestrator"]],
      ["SS05", ["code-review", "cs-engineering"], ["independent-deliberation-panel"], ["orchestrator"]],
      ["SS14", ["cs-engineering", "test-engineering"], ["task-contract"], ["orchestrator"]],
      ["SS18", ["ponytail"], ["orchestrator"], ["software-security-auditor", "orchestrator"]],
    ] as const) {
      const response = responseMock(id, [...known], [...uncertain]);
      const observation = classificationMock(id, response);
      const score = current.scoreCase(fixture(id), observation, corpus.inventorySkillIds);
      expect(observation.classificationResponse).toEqual(response);
      expect(score.missingRequired).toEqual(missing); expect(score.verdict).toBe("FAIL");
      expect(score.requiredHits).toBe(known.length);
    }
    for (const [id, known, uncertain] of [["SS07", "software-security-auditor", "task-contract"], ["SS10", "code-review", "cs-engineering"],
      ["SS16", "korean-prose-editor", "orchestrator"], ["SS17", "change-scope-guardian", "session-board"]]) {
      const observation = classificationMock(id!, responseMock(id!, [known!], [uncertain!]));
      expect(current.scoreCase(fixture(id!), observation, corpus.inventorySkillIds).verdict).toBe("PASS");
      expect(observation.classificationResponse!.unresolvedItems).toHaveLength(1);
    }
  });
  it("missing-input-reasons does not pass by an empty needed set or null conversion", () => {
    for (const [id, response, reportedReasons] of [["SS12", responseMock("SS12"), ["missing-action", "missing-target"]],
      ["SS15", responseMock("SS15", [], ["code-review", "cs-engineering"]), ["unknown-explicit-skill"]]] as const) {
      const observation = classificationMock(id, response);
      expect(current.scoreCase(fixture(id), observation, corpus.inventorySkillIds).verdict).toBe("FAIL");
      expect(current.scoreCase(fixture(id), observation, corpus.inventorySkillIds).reasons).toContain("CLASSIFICATION_REQUIRED_INPUT_REASON_MISSING");
      expect(current.scoreCase(fixture(id), classificationMock(id, null), corpus.inventorySkillIds).verdict).toBe("BLOCKED");
      expect(current.scoreCase(fixture(id), selectionMock(id, null), corpus.inventorySkillIds).verdict).toBe("FAIL");
      const reported: SkillClassificationResponseV1 = {...response, status: "PARTIAL", unresolvedItems: [
        ...response.unresolvedItems, ...reportedReasons.map(reasonCode => ({skillId: null, reasonCode}))]};
      const positive = classificationMock(id, reported);
      expect(current.scoreCase(fixture(id), positive, corpus.inventorySkillIds).verdict).toBe("PASS");
      expect(current.scoreCase(fixture(id), positive, corpus.inventorySkillIds).reasons).not.toContain("CLASSIFICATION_REQUIRED_INPUT_REASON_MISSING");
      expect(current.aggregate([fixture(id)], [positive], "jevRaw", corpus.inventorySkillIds).passes).toBe(1);
      expect(positive.kind).toBe("classification"); expect(Object.keys(positive)).not.toContain("hostReceipt");
    }
    expect(current.scoreCase(fixture("SS11"), classificationMock("SS11"), corpus.inventorySkillIds).verdict).toBe("PASS");
    const clarification = selectionMock("SS15", null);
    clarification.decision.unresolvedSkillReferences = [{reference: "$cs-enginering", reason: "unknown-explicit-skill"}];
    expect(current.scoreCase(fixture("SS15"), clarification, corpus.inventorySkillIds).verdict).toBe("PASS");
    expect(clarification.decision.agentSelectedSkillIds).toBeNull();
  });
  it("selected-runtime-cli rejects receipt/binding absence and nonselected pairs", () => {
    const selected = selectionMock("SS01", ["ponytail"]);
    expect(current.scoreCase(fixture("SS01"), selected, corpus.inventorySkillIds).verdict).toBe("PASS");
    expect(() => current.assertObservation({...selected, decision: {...selected.decision, hostReceipt: null}}, corpus.inventorySkillIds)).toThrow("HOST_SELECTION_RECEIPT_MISSING_OR_MISMATCH");
    expect(() => current.assertObservation({...selected, requestDigest: `sha256:${"b".repeat(64)}`}, corpus.inventorySkillIds)).toThrow("SELECTION_BINDING_MISMATCH");
    const pair = current.pairedMatrix()[0]!;
    const raw = classificationMock(pair.caseId);
    expect(() => current.scorePairs([{...pair, codex: raw as unknown as current.SelectionObservation, claude: selected}], corpus.cases, corpus.inventorySkillIds)).toThrow("PAIR_REQUIRES_SELECTION_OBSERVATION");
    const empty = selectionMock("SS11", []);
    expect(empty.decision.agentSelectedSkillIds).toEqual([]); expect(empty.decision.hostReceipt).not.toBeNull();
    expect(current.scoreCase(fixture("SS11"), empty, corpus.inventorySkillIds).verdict).toBe("PASS");
    const combined: current.CombinedObservation = {observationRevision: "2.0.0", kind: "support-combination", layer: "combined", caseId: "SS18", state: "PASS", executionKind: "offline-mock",
      requestId: "mock/SS18", operationId: "mock/SS18", requestDigest: boundDigest, inventoryDigest: boundDigest, conditionDigest: boundDigest,
      neededSkillIds: ["ponytail", "software-security-auditor"], unresolvedItems: [], classificationResponseRefs: [boundDigest], explicitSkillIds: [], ruleRequiredSkillIds: ["software-security-auditor"],
      contributions: [{kind: "classification", skillId: "ponytail", reasonRefs: ["mock-response"]}, {kind: "rule", skillId: "software-security-auditor", reasonRefs: ["mock-rule-not-authority"]}]};
    expect(current.scoreCase(fixture("SS18"), combined, corpus.inventorySkillIds).missingRequired).toEqual(["orchestrator"]);
    expect(() => current.assertObservation({...combined, contributions: []}, corpus.inventorySkillIds)).toThrow("COMBINED_CONTRIBUTION_MISSING");
    expect(() => current.assertObservation({...combined, hostReceipt: selected.decision.hostReceipt}, corpus.inventorySkillIds)).toThrow();
  });
  it("explicit-legacy preserves original scoring and rejects silent mode changes", () => {
    const legacy = mock("SS15", []);
    const result = current.evaluateInput({observationRevision: "legacy-v1", observations: [legacy], pairs: []}, corpus);
    expect(result.layers.jevRaw!.scores).toEqual(evaluateLayers(corpus.cases, [legacy], corpus.inventorySkillIds).jevRaw!.scores);
    expect(result.layers.jevRaw!.scores.find(row => row.caseId === "SS15")!.reasons).toEqual(["UNCERTAINTY_HIDDEN_AS_SELECTION"]);
    expect(result.scorerRevision).toBe("legacy-v1");
    expect(() => current.evaluateInput({observations: [legacy], pairs: []}, corpus)).toThrow();
    expect(() => current.evaluateInput({observationRevision: "2.0.0", observations: [legacy], pairs: []}, corpus)).toThrow();
    expect(() => current.evaluateInput({observationRevision: "2.0.0", observations: [], pairs: [], credential: "not-allowed"}, corpus)).toThrow();
  });
  it("selected-runtime-cli executes the closed JSON boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "ags-r14-eval-"));
    try {
      const argv = ["--import", pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href, fileURLToPath(new URL("./evaluation.ts", import.meta.url)), join(root, "input.json")];
      const selected = selectionMock("SS01", ["ponytail"]);
      selected.decision.hostReceipt = null;
      for (const input of [{observations: [], pairs: []}, {observationRevision: "2.0.0", observations: [selected], pairs: []},
        {observationRevision: "2.0.0", observations: [{...classificationMock("SS01"), selectionStatus: "SELECTED"}], pairs: []}]) {
        writeFileSync(argv[3]!, JSON.stringify(input));
        const failed = spawnSync(process.execPath, argv, {encoding: "utf8", timeout: 15000});
        expect(failed.error).toBeUndefined(); expect(failed.status).not.toBe(0);
      }
      writeFileSync(argv[3]!, JSON.stringify({observationRevision: "legacy-v1", observations: [], pairs: []}));
      const valid = spawnSync(process.execPath, argv, {encoding: "utf8", timeout: 15000});
      expect(valid.status).toBe(0); expect(JSON.parse(valid.stdout).archivalDiagnosticOnly).toBe(true);
    } finally {
      expect(dirname(resolve(root))).toBe(resolve(tmpdir())); expect(basename(root)).toMatch(/^ags-r14-eval-/u);
      rmSync(root, {recursive: true, force: true});
    }
  });
});
