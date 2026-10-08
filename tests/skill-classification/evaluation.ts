import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { HostSelectionReceipt, SkillSelectionDecisionV1 } from "../../mcp-server/src/skill-classification/types.js";

export type Layer = "jevRaw" | "vendorRaw" | "combined" | "selected";
export type RunState = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
export interface Oracle {
  required: string[]; allowed: string[]; forbidden: string[]; notApplicable: string[];
  unadjudicated: string[]; expectedSelection: string; requiredReasons: string[];
  allowedConditions: Record<string, string>;
}
export interface SemanticCase { caseId: string; familyId: string; oracle: Oracle | null }
export interface Observation {
  caseId: string; layer: Layer; state: RunState; skillIds: string[] | null;
  selectionStatus: string; reasonCodes: string[];
  selectionReasons: { skillId: string; reason: string }[];
  executionKind: "offline-mock" | "replay" | "provider-live" | "host-live";
  host: string | null; hostReceipt: HostSelectionReceipt | null;
  requestDigest: string; inventoryDigest: string; conditionDigest: string;
  candidateDigest?: string;
  stageEvidence: {
    read: boolean; applied: boolean; verified: boolean;
    readRefs?: { path: string; digest: string }[];
    obligations?: { obligationId: string; artifactRef: string }[];
    requiredPhases?: string[]; completedPhases?: string[];
    verification?: { candidateDigest: string; result: "PASS" | "FAIL" | "NOT_RUN"; evidenceRef: string };
  };
}
export interface CaseScore {
  caseId: string; verdict: RunState | "REVIEW_REQUIRED";
  missingRequired: string[]; forbidden: string[]; unnecessary: string[]; unadjudicated: string[];
  truePositives: number; falsePositives: number; requiredHits: number;
  answered: boolean; abstained: boolean; unnecessaryAbstention: boolean;
  reasons: string[];
}

// Only exact registered IDs are canonical. Alias spelling never creates authority.
export function canonicalSet(value: string[] | null): string[] | null {
  return value === null ? null : [...new Set(value)].sort();
}
export function sameSet(a: string[] | null, b: string[] | null): boolean {
  const left = canonicalSet(a), right = canonicalSet(b);
  return left === null || right === null ? left === right : JSON.stringify(left) === JSON.stringify(right);
}
export function fromSelection(caseId: string, decision: SkillSelectionDecisionV1, context: Omit<Observation, "caseId" | "layer" | "skillIds" | "selectionStatus" | "selectionReasons" | "hostReceipt" | "requestDigest" | "inventoryDigest">): Observation {
  return { ...context, caseId, layer: "selected", skillIds: decision.agentSelectedSkillIds,
    selectionStatus: decision.selectionStatus, selectionReasons: decision.selectionReasons,
    hostReceipt: decision.hostReceipt, requestDigest: decision.requestDigest, inventoryDigest: decision.inventoryDigest };
}

export function scoreCase(fixture: SemanticCase, observation: Observation | undefined, inventory: string[]): CaseScore {
  if (fixture.oracle === null) throw new Error(`NO_SEMANTIC_ORACLE:${fixture.caseId}`);
  const oracle = fixture.oracle;
  const base: CaseScore = { caseId: fixture.caseId, verdict: "NOT_RUN", missingRequired: [...oracle.required],
    forbidden: [], unnecessary: [], unadjudicated: [], truePositives: 0, falsePositives: 0,
    requiredHits: 0, answered: false, abstained: false, unnecessaryAbstention: false, reasons: [] };
  if (!observation || observation.state === "NOT_RUN") return base;
  if (observation.caseId !== fixture.caseId) return { ...base, verdict: "FAIL", reasons: ["CASE_BINDING_MISMATCH"] };
  if (observation.state !== "PASS") return { ...base, verdict: observation.state, reasons: ["EXECUTION_DID_NOT_SUCCEED", ...observation.reasonCodes] };
  if (observation.skillIds === null) {
    const expected = oracle.expectedSelection === "NEEDS_INPUT" && observation.selectionStatus === "NEEDS_INPUT";
    const reasonsPresent = oracle.requiredReasons.every(x => observation.reasonCodes.includes(x));
    return { ...base, verdict: expected && reasonsPresent ? "PASS" : "FAIL", abstained: true,
      unnecessaryAbstention: !expected, reasons: expected && reasonsPresent ? [] : ["UNEXPECTED_OR_UNEXPLAINED_ABSTENTION"] };
  }
  const selected = canonicalSet(observation.skillIds)!;
  const allowed = new Set([...oracle.required, ...oracle.allowed]);
  const unknown = selected.filter(x => !inventory.includes(x));
  const forbidden = selected.filter(x => oracle.forbidden.includes(x));
  const unnecessary = selected.filter(x => oracle.notApplicable.includes(x));
  const unadjudicated = selected.filter(x => inventory.includes(x) && !allowed.has(x) && !forbidden.includes(x) && !unnecessary.includes(x));
  const missingRequired = oracle.required.filter(x => !selected.includes(x));
  const truePositives = selected.filter(x => allowed.has(x)).length;
  const reasons = unknown.length ? ["UNKNOWN_CANONICAL_ID"] : [];
  if (oracle.expectedSelection === "NEEDS_INPUT") reasons.push("UNCERTAINTY_HIDDEN_AS_SELECTION");
  if (Object.keys(oracle.allowedConditions).some(x => selected.includes(x) && !observation.selectionReasons.some(r => r.skillId === x && r.reason.trim().length > 0))) reasons.push("CONDITIONAL_ALLOWED_REASON_MISSING");
  if (observation.layer === "selected") {
    const receipt = observation.hostReceipt;
    if (!receipt || !receipt.receiptId || !receipt.acceptedAt || receipt.host !== observation.host ||
        receipt.requestDigest !== observation.requestDigest || receipt.inventoryDigest !== observation.inventoryDigest ||
        !sameSet(receipt.agentSelectedSkillIds, selected)) reasons.push("HOST_SELECTION_RECEIPT_MISSING_OR_MISMATCH");
    if (!["SELECTED", "PARTIAL"].includes(observation.selectionStatus)) reasons.push("SELECTION_STATUS_MISMATCH");
  }
  const failed = missingRequired.length + forbidden.length + unnecessary.length + reasons.length > 0;
  return { ...base, verdict: failed ? "FAIL" : unadjudicated.length ? "REVIEW_REQUIRED" : "PASS",
    missingRequired, forbidden, unnecessary, unadjudicated, truePositives,
    falsePositives: forbidden.length + unnecessary.length + unknown.length,
    requiredHits: oracle.required.length - missingRequired.length,
    answered: !reasons.includes("HOST_SELECTION_RECEIPT_MISSING_OR_MISMATCH"), reasons };
}

export function aggregate(fixtureCases: SemanticCase[], observations: Observation[], layer: Layer, inventory: string[]) {
  const cases = fixtureCases.filter(x => x.oracle !== null);
  const rows = observations.filter(x => x.layer === layer);
  if (new Set(rows.map(x => x.caseId)).size !== rows.length) throw new Error("DUPLICATE_OBSERVATION");
  if (rows.some(x => !cases.some(f => f.caseId === x.caseId))) throw new Error("UNKNOWN_CASE_OBSERVATION");
  const scores = cases.map(f => scoreCase(f, rows.find(x => x.caseId === f.caseId), inventory));
  const count = (predicate: (x: CaseScore) => boolean) => scores.filter(predicate).length;
  const denominator = cases.length;
  const requiredTotal = cases.reduce((n, c) => n + c.oracle!.required.length, 0);
  const tp = scores.reduce((n, s) => n + s.truePositives, 0);
  const fp = scores.reduce((n, s) => n + s.falsePositives, 0);
  const unadjudicatedCount = scores.reduce((n, s) => n + s.unadjudicated.length, 0);
  const passes = count(s => s.verdict === "PASS");
  const rate = (n: number, d = denominator) => d === 0 ? null : n / d;
  const stageObserved = (o: Observation, stage: "read" | "applied" | "verified") => {
    if (layer !== "selected" || o.state !== "PASS" || !o.hostReceipt ||
        !scores.find(x => x.caseId === o.caseId)?.answered) return false;
    const e = o.stageEvidence;
    const read = e.read && !!e.readRefs?.length && e.readRefs.every(x => !!x.path && /^sha256:[a-f0-9]{64}$/.test(x.digest));
    if (stage === "read") return read;
    const applied = read && e.applied && !!e.obligations?.length && e.obligations.every(x => !!x.obligationId && !!x.artifactRef) &&
      (e.requiredPhases ?? []).every(x => e.completedPhases?.includes(x));
    if (stage === "applied") return applied;
    return applied && e.verified && !!o.candidateDigest && e.verification?.candidateDigest === o.candidateDigest &&
      e.verification.result === "PASS" && !!e.verification.evidenceRef;
  };
  return { layer, denominator, executed: count(s => s.verdict !== "NOT_RUN"), passes,
    failures: count(s => s.verdict === "FAIL"), blocked: count(s => s.verdict === "BLOCKED"),
    notRun: count(s => s.verdict === "NOT_RUN"), reviewRequired: count(s => s.verdict === "REVIEW_REQUIRED"),
    requiredTotal, requiredHits: scores.reduce((n, s) => n + s.requiredHits, 0),
    requiredRecall: rate(scores.reduce((n, s) => n + s.requiredHits, 0), requiredTotal),
    truePositives: tp, falsePositives: fp, unadjudicatedCount,
    precision: unadjudicatedCount > 0 ? null : rate(tp, tp + fp),
    forbiddenViolations: count(s => s.forbidden.length > 0), forbiddenViolationRate: rate(count(s => s.forbidden.length > 0)),
    unnecessarySelections: scores.reduce((n, s) => n + s.unnecessary.length, 0),
    exactPurposeSuccessRate: rate(passes), coverage: rate(count(s => s.answered)),
    abstentions: count(s => s.abstained), abstentionRate: rate(count(s => s.abstained)),
    unnecessaryAbstentionRate: rate(count(s => s.unnecessaryAbstention)),
    stageCoverage: Object.fromEntries((["read", "applied", "verified"] as const).map(stage => [stage,
      rate(rows.filter(x => stageObserved(x, stage)).length)])),
    verdict: denominator === 0 || scores.some(s => s.verdict !== "PASS") ? "INCOMPLETE_OR_FAIL" : "PASS",
    scores };
}

export function evaluateLayers(cases: SemanticCase[], observations: Observation[], inventory: string[]) {
  return Object.fromEntries((["jevRaw", "vendorRaw", "combined", "selected"] as const).map(layer => [layer, aggregate(cases, observations, layer, inventory)]));
}

export function checkFamilySplit(cases: SemanticCase[], calibration: string[], holdout: string[]): string[] {
  const issues: string[] = [];
  const lookup = new Map(cases.map(x => [x.caseId, x.familyId]));
  const all = [...calibration, ...holdout];
  if (new Set(all).size !== all.length) issues.push("DUPLICATE_SPLIT_CASE");
  if (all.some(id => !lookup.has(id))) issues.push("UNKNOWN_SPLIT_CASE");
  const calibrationFamilies = new Set(calibration.map(id => lookup.get(id)));
  if (holdout.some(id => calibrationFamilies.has(lookup.get(id)))) issues.push("FAMILY_LEAKAGE");
  const expected = cases.filter(x => x.oracle !== null).map(x => x.caseId);
  if (expected.some(id => !all.includes(id))) issues.push("UNASSIGNED_SEMANTIC_CASE");
  return issues;
}

export interface PairTrial { pairId: string; caseId: string; path: string; repetition: number; codex: Observation | null; claude: Observation | null }
export const REPRESENTATIVE_CASES = ["SS01", "SS03", "SS04", "SS05", "SS08", "SS09", "SS10", "SS11", "SS14", "SS18"];
export const PAIR_PATHS = ["jev-on", "jev-off-vendor", "jev-invalid-key-vendor", "jev-timeout-vendor"];
export function pairedMatrix(): PairTrial[] {
  return REPRESENTATIVE_CASES.flatMap(caseId => PAIR_PATHS.flatMap(path => [1, 2, 3].map(repetition => ({
    pairId: `${caseId}/${path}/${repetition}`, caseId, path, repetition, codex: null, claude: null }))));
}
export function scorePairs(trials: PairTrial[], cases: SemanticCase[], inventory: string[]) {
  const expected = pairedMatrix();
  const issues: string[] = [];
  const ids = trials.map(x => x.pairId);
  if (new Set(ids).size !== ids.length) issues.push("DUPLICATE_PAIR");
  if (trials.some(x => !expected.some(e => e.pairId === x.pairId && e.caseId === x.caseId && e.path === x.path && e.repetition === x.repetition))) issues.push("INVALID_PAIR_KEY");
  const records = expected.map(e => {
    const trial = trials.find(x => x.pairId === e.pairId) ?? e;
    const { codex, claude } = trial;
    if (!codex || !claude) return { ...e, status: "NOT_RUN", agreement: null, codexGolden: "NOT_RUN", claudeGolden: "NOT_RUN" };
    if (codex.host !== "codex" || claude.host !== "claude" || codex.layer !== "selected" || claude.layer !== "selected" || codex.caseId !== e.caseId || claude.caseId !== e.caseId) return { ...e, status: "FAIL", agreement: null, codexGolden: "FAIL", claudeGolden: "FAIL" };
    if (codex.conditionDigest !== claude.conditionDigest || codex.inventoryDigest !== claude.inventoryDigest) return { ...e, status: "UNMATCHED", agreement: null, codexGolden: "NOT_RUN", claudeGolden: "NOT_RUN" };
    const fixture = cases.find(x => x.caseId === e.caseId);
    if (!fixture) throw new Error(`MISSING_PAIR_ORACLE:${e.caseId}`);
    const left = scoreCase(fixture, codex, inventory), right = scoreCase(fixture, claude, inventory);
    const agreement = sameSet(codex.skillIds, claude.skillIds);
    // Agreement and purpose quality are independent; two matching wrong answers fail.
    return { ...e, status: agreement && left.verdict === "PASS" && right.verdict === "PASS" ? "PASS" : "FAIL", agreement,
      codexGolden: left.verdict, claudeGolden: right.verdict };
  });
  const compared = records.filter(x => x.agreement !== null);
  const stability = (["codex", "claude"] as const).map(host => {
    const groups = REPRESENTATIVE_CASES.flatMap(caseId => PAIR_PATHS.map(path => {
      const observations = expected.filter(x => x.caseId === caseId && x.path === path)
        .map(e => trials.find(x => x.pairId === e.pairId)?.[host]).filter((x): x is Observation => !!x);
      const values = observations.map(x => JSON.stringify(canonicalSet(x.skillIds)));
      return { caseId, path, observedRepeats: values.length, status: values.length < 3 ? "NOT_RUN" :
        new Set(values).size === 1 ? "STABLE" : "UNSTABLE" };
    }));
    return { host, denominator: groups.length, stableGroups: groups.filter(x => x.status === "STABLE").length,
      unstableGroups: groups.filter(x => x.status === "UNSTABLE").length,
      notRunGroups: groups.filter(x => x.status === "NOT_RUN").length, groups };
  });
  return { expectedPairs: expected.length, suppliedPairs: trials.length, issues,
    comparedPairs: compared.length, unmatchedPairs: records.filter(x => x.status === "UNMATCHED").length,
    notRunPairs: records.filter(x => x.status === "NOT_RUN").length,
    exactSetAgreement: compared.length ? compared.filter(x => x.agreement).length / compared.length : null,
    completedPurposeRate: records.filter(x => x.status === "PASS").length / expected.length,
    evidenceKinds: [...new Set(trials.flatMap(x => [x.codex?.executionKind, x.claude?.executionKind]).filter(Boolean))],
    releaseAcceptance: "NOT_ASSESSED", stability,
    verdict: issues.length === 0 && records.every(x => x.status === "PASS") ? "PASS" : "INCOMPLETE_OR_FAIL", records };
}

export function oracleDigest(value: { oracleRevision: string; sourceSpecDigest: string; sourceSkills: unknown; cases: unknown; metadataRoleCases: unknown; sourceProvenanceCases: unknown; pairedMatrix: unknown; split: unknown }): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify({ oracleRevision: value.oracleRevision,
    sourceSpecDigest: value.sourceSpecDigest, sourceSkills: value.sourceSkills, cases: value.cases,
    metadataRoleCases: value.metadataRoleCases, sourceProvenanceCases: value.sourceProvenanceCases,
    pairedMatrix: value.pairedMatrix, split: value.split })).digest("hex");
}

// Local JSON scoring only: no provider calls, selection writes, or acceptance receipts.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error("Usage: node --experimental-strip-types evaluation.ts [local-observations.json]");
  const corpus = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
  if (oracleDigest(corpus) !== corpus.oracleDigest) throw new Error("FROZEN_ORACLE_DIGEST_MISMATCH");
  const input = args[0] ? JSON.parse(readFileSync(resolve(args[0]), "utf8")) : { observations: [], pairs: [] };
  if (!Array.isArray(input.observations) || !Array.isArray(input.pairs)) throw new Error("Input requires observations and pairs arrays");
  console.log(JSON.stringify({ oracleDigest: corpus.oracleDigest, targetRelease: corpus.targetRelease,
    layers: evaluateLayers(corpus.cases, input.observations, corpus.inventorySkillIds),
    pairs: scorePairs(input.pairs, corpus.cases, corpus.inventorySkillIds), releaseAcceptance: "NOT_ASSESSED" }, null, 2));
}
