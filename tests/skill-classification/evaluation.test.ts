import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aggregate, canonicalSet, checkFamilySplit, evaluateLayers, fromSelection, oracleDigest, pairedMatrix, scoreCase, scorePairs, sameSet, type Layer, type Observation, type Oracle, type SemanticCase } from "./evaluation.js";
import type { SkillSelectionDecisionV1 } from "../../mcp-server/src/skill-classification/types.js";

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
