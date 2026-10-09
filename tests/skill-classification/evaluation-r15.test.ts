import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  aggregate, aggregateLegacy, evaluateInput, evaluateLayers, fromSelection, pairedMatrix,
  scoreCase, scoreLegacyCase, scoreLegacyPairs, scorePairs,
  type LegacyObservation, type PairTrial, type SemanticCase, type SelectionObservation, type TrustedStagePlan,
} from "./evaluation.js";
import type { SkillSelectionDecisionV1 } from "../../mcp-server/src/skill-classification/types.js";

const corpus = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8")) as {
  cases: SemanticCase[];
  inventorySkillIds: string[];
};
const bound = "sha256:" + "a".repeat(64);
const other = "sha256:" + "b".repeat(64);
const fixture = (id: string) => corpus.cases.find(row => row.caseId === id)!;

function selected(id: string, skills: string[] | null, host = "codex", state: SelectionObservation["state"] = "PASS"): SelectionObservation {
  const decision: SkillSelectionDecisionV1 = {
    schemaVersion: "1.0.0", classificationResponseRef: bound, requestDigest: bound, inventoryDigest: bound,
    taskRevision: null, configRevision: "mock-r15", profileRevision: "mock-r15", explicitSkillIds: [], ruleRequiredSkillIds: [],
    agentSelectedSkillIds: skills, selectionStatus: skills === null ? "NEEDS_INPUT" : "SELECTED",
    selectionReasons: (skills ?? []).map(skillId => ({ skillId, reason: "structural-mock-not-model-or-host" })),
    applicabilityChecks: [], unresolvedSkillReferences: [], adviceApplied: false,
    hostReceipt: skills === null ? null : { receiptId: "mock-not-host-attestation", host, requestDigest: bound, inventoryDigest: bound,
      agentSelectedSkillIds: skills, acceptedAt: "2000-01-01T00:00:00.000Z" },
  };
  return fromSelection(id, decision, { requestId: `r15/${id}/${host}`, operationId: `r15/${id}/${host}`, state,
    executionKind: "offline-mock", host, conditionDigest: bound, candidateDigest: bound,
    stageEvidence: { read: false, applied: false, verified: false } });
}

function legacy(observation: SelectionObservation): LegacyObservation {
  return { caseId: observation.caseId, layer: "selected", state: observation.state,
    skillIds: observation.decision.agentSelectedSkillIds, selectionStatus: observation.decision.selectionStatus,
    reasonCodes: observation.decision.unresolvedSkillReferences.map(row => row.reason), selectionReasons: observation.decision.selectionReasons,
    executionKind: observation.executionKind, host: observation.host, hostReceipt: observation.decision.hostReceipt,
    requestDigest: observation.requestDigest, inventoryDigest: observation.inventoryDigest, conditionDigest: observation.conditionDigest,
    ...(observation.candidateDigest === undefined ? {} : { candidateDigest: observation.candidateDigest }), stageEvidence: observation.stageEvidence };
}

function repeats(state: SelectionObservation["state"], skills: string[] | null): PairTrial[] {
  return pairedMatrix().filter(row => row.caseId === "SS01" && row.path === "jev-on").map(row => ({ ...row,
    codex: selected("SS01", skills, "codex", state), claude: selected("SS01", skills, "claude", state) }));
}

function staged(): { observation: SelectionObservation; plan: TrustedStagePlan } {
  const observation = selected("SS03", ["ponytail", "orchestrator"]);
  observation.stageEvidence = { read: true, applied: true, verified: true,
    readRefs: [{ path: "skills/ponytail/SKILL.md", digest: bound }],
    obligations: [{ obligationId: "VO-IMPLEMENT", artifactRef: "mock-implementation.json" }],
    requiredPhases: ["prepare", "verify"], completedPhases: ["prepare", "verify"],
    verification: { candidateDigest: bound, result: "PASS", evidenceRef: "mock-proof.json" } };
  const plan: TrustedStagePlan = { caseId: observation.caseId, requestId: observation.requestId, operationId: observation.operationId,
    requestDigest: bound, inventoryDigest: bound, conditionDigest: bound, candidateDigest: bound,
    readRefs: [{ path: "skills/ponytail/SKILL.md", digest: bound }], obligationIds: ["VO-IMPLEMENT"], requiredPhases: ["prepare", "verify"] };
  return { observation, plan };
}

describe("R15 evaluator metrics", () => {
  it("r15-executed-pairs preserves denominators and trace without counting unexecuted agreement", () => {
    const notRun = repeats("NOT_RUN", null);
    const result = scorePairs(notRun, corpus.cases, corpus.inventorySkillIds);
    // Original98 counts these three unexecuted records as agreement/STABLE.
    expect(result.comparedPairs).toBe(0);
    expect(result.exactSetAgreement).toBeNull();
    expect(result.expectedPairs).toBe(120);
    expect(result.expectedHostSlots).toBe(240);
    expect(result.executedHostSlots).toBe(0);
    expect(result.notRunPairs).toBe(120);
    expect(result.stability.every(row => row.stableGroups === 0)).toBe(true);
    expect(result.stability.every(row => row.groups.find(group => group.caseId === "SS01" && group.path === "jev-on")!.observedRepeats === 0)).toBe(true);
    expect(result.records[0]!.codex).toEqual(notRun[0]!.codex);
    expect(result.records[0]!.claude).toEqual(notRun[0]!.claude);
    expect(result.scorerPatchRevision).toBe("r15");
    const old = scoreLegacyPairs(notRun.map(row => ({ ...row, codex: legacy(row.codex!), claude: legacy(row.claude!) })), corpus.cases, corpus.inventorySkillIds);
    expect(old.comparedPairs).toBe(3);
    expect(old.stability.every(row => row.stableGroups === 1)).toBe(true);

    const positive = scorePairs(repeats("PASS", ["ponytail"]), corpus.cases, corpus.inventorySkillIds);
    expect(positive.comparedPairs).toBe(3);
    expect(positive.exactSetAgreement).toBe(1);
    expect(positive.executedHostSlots).toBe(6);
    expect(positive.completedPurposeRate).toBe(3 / 120);
    expect(positive.stability.every(row => row.stableGroups === 1)).toBe(true);
    const wrong = scorePairs(repeats("PASS", []), corpus.cases, corpus.inventorySkillIds);
    expect(wrong.exactSetAgreement).toBe(1);
    expect(wrong.completedPurposeRate).toBe(0);
    expect(wrong.records[0]!.status).toBe("FAIL");

    const blocked = scorePairs(repeats("BLOCKED", ["ponytail"]), corpus.cases, corpus.inventorySkillIds);
    expect(blocked.comparedPairs).toBe(0);
    expect(blocked.executedHostSlots).toBe(0);
    expect(blocked.blockedPairs).toBe(3);
    expect(blocked.stability.every(row => row.stableGroups === 0)).toBe(true);
    const oneSide = repeats("NOT_RUN", null);
    oneSide[0]!.codex = selected("SS01", ["ponytail"]);
    const partial = scorePairs(oneSide, corpus.cases, corpus.inventorySkillIds);
    expect(partial.comparedPairs).toBe(0);
    expect(partial.executedHostSlots).toBe(1);
    expect(partial.stability.every(row => row.stableGroups === 0)).toBe(true);

    const unmatched = repeats("PASS", ["ponytail"]);
    unmatched.forEach(row => { row.claude!.conditionDigest = other; });
    const mismatch = scorePairs(unmatched, corpus.cases, corpus.inventorySkillIds);
    expect(mismatch.comparedPairs).toBe(0);
    expect(mismatch.executedHostSlots).toBe(0);
    expect(mismatch.unmatchedPairs).toBe(3);
    expect(mismatch.stability.every(row => row.stableGroups === 0)).toBe(true);

    const abstained = scorePairs(repeats("PASS", null), corpus.cases, corpus.inventorySkillIds);
    expect(abstained.comparedPairs).toBe(0);
    expect(abstained.comparedAbstentionPairs).toBe(3);
    expect(abstained.executedAbstentionAgreement).toBe(1);
    expect(abstained.executedHostSlots).toBe(6);
    expect(abstained.stability.every(row => row.stableGroups === 0 && row.stableAbstentionGroups === 1)).toBe(true);
    expect(abstained.completedPurposeRate).toBe(0);
  });

  it("r15-unique-fp counts a recommendation once while preserving both violation diagnostics", () => {
    const bad = selected("SS09", ["test-engineering"]);
    const score = scoreCase(fixture("SS09"), bad, corpus.inventorySkillIds);
    // One recommended ID belongs to both frozen gold violation categories.
    expect(score.falsePositives).toBe(1);
    expect(score.forbidden).toEqual(["test-engineering"]);
    expect(score.unnecessary).toEqual(["test-engineering"]);
    expect(scoreLegacyCase(fixture("SS09"), legacy(bad), corpus.inventorySkillIds).falsePositives).toBe(2);
    const good = selected("SS01", ["ponytail"]);
    const report = aggregate([fixture("SS09"), fixture("SS01")], [bad, good], "selected", corpus.inventorySkillIds);
    expect(report.truePositives).toBe(1);
    expect(report.falsePositives).toBe(1);
    expect(report.precision).toBe(1 / 2);
    const old = aggregateLegacy([fixture("SS09"), fixture("SS01")], [legacy(bad), legacy(good)], "selected", corpus.inventorySkillIds);
    expect(old.falsePositives).toBe(2);
    expect(old.precision).toBe(1 / 3);
    const unknown = selected("SS09", ["test-engineering", "not-in-inventory"]);
    expect(scoreCase(fixture("SS09"), unknown, corpus.inventorySkillIds).falsePositives).toBe(2);
    expect(scoreCase(fixture("SS09"), unknown, corpus.inventorySkillIds).reasons).toContain("UNKNOWN_CANONICAL_ID");
  });

  it("r15-trusted-stage-plan requires the separately supplied bound plan and all required stages", () => {
    const { observation, plan } = staged();
    const cases = [fixture("SS03")];
    const coverage = (row: SelectionObservation, plans?: TrustedStagePlan[]) => aggregate(cases, [row], "selected", corpus.inventorySkillIds, plans).stageCoverage;
    // Original98 accepts caller assertions without a trusted phase plan.
    expect(coverage(observation).applied).toBe(0);
    expect(coverage(observation).verified).toBe(0);
    expect(coverage(observation).read).toBe(1);
    expect(coverage(observation, [plan])).toEqual({ read: 1, applied: 1, verified: 1 });
    const reordered = { ...plan, readRefs: [{ digest: bound, path: "skills/ponytail/SKILL.md" }] };
    expect(coverage(observation, [reordered])).toEqual({ read: 1, applied: 1, verified: 1 });
    for (const mutation of ["omit-required", "empty-required", "subset-required", "omit-completed", "missing-completed"] as const) {
      const bad = structuredClone(observation);
      if (mutation === "omit-required") delete bad.stageEvidence.requiredPhases;
      if (mutation === "empty-required") bad.stageEvidence.requiredPhases = [];
      if (mutation === "subset-required") bad.stageEvidence.requiredPhases = ["prepare"];
      if (mutation === "omit-completed") delete bad.stageEvidence.completedPhases;
      if (mutation === "missing-completed") bad.stageEvidence.completedPhases = ["prepare"];
      expect(coverage(bad, [plan]), mutation).toEqual({ read: 1, applied: 0, verified: 0 });
    }
    for (const field of ["caseId", "requestId", "operationId", "requestDigest", "inventoryDigest", "conditionDigest", "candidateDigest"] as const) {
      const badPlan = structuredClone(plan);
      badPlan[field] = field.endsWith("Digest") ? other : "different-bound-input";
      expect(coverage(observation, [badPlan]), field).toEqual({ read: 1, applied: 0, verified: 0 });
    }
    for (const mutation of ["source-path", "source-digest", "obligation"] as const) {
      const badPlan = structuredClone(plan);
      if (mutation === "source-path") badPlan.readRefs[0]!.path = "skills/orchestrator/SKILL.md";
      if (mutation === "source-digest") badPlan.readRefs[0]!.digest = other;
      if (mutation === "obligation") badPlan.obligationIds = ["VO-DIFFERENT"];
      expect(coverage(observation, [badPlan]), mutation).toEqual({ read: 1, applied: 0, verified: 0 });
    }
    const phaseFree = structuredClone(observation), emptyPlan = structuredClone(plan);
    phaseFree.stageEvidence.requiredPhases = []; phaseFree.stageEvidence.completedPhases = []; emptyPlan.requiredPhases = [];
    expect(coverage(phaseFree, [emptyPlan])).toEqual({ read: 1, applied: 1, verified: 1 });
    const ports = evaluateLayers(cases, [observation], corpus.inventorySkillIds, [plan]);
    expect(ports.selected!.stageCoverage.verified).toBe(1);
    const input = { observationRevision: "2.0.0", observations: [observation], pairs: [] };
    expect(evaluateInput(input, { cases, inventorySkillIds: corpus.inventorySkillIds, stagePlans: [plan] }).layers.selected!.stageCoverage.verified).toBe(1);
    expect(evaluateInput(input, { cases, inventorySkillIds: corpus.inventorySkillIds }).layers.selected!.stageCoverage.verified).toBe(0);
    expect(() => evaluateInput({ ...input, stagePlans: [plan] }, corpus)).toThrow();
    expect(aggregateLegacy(cases, [legacy(observation)], "selected", corpus.inventorySkillIds).stageCoverage.verified).toBe(1);
  });
});
