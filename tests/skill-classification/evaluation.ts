import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { responseSchema, decisionSchema, validateClassificationResponse } from "../../mcp-server/src/skill-classification/validation.js";
import type { HostSelectionReceipt, SkillSelectionDecisionV1, SkillClassificationRequestV1, SkillClassificationResponseV1, DispatchState } from "../../mcp-server/src/skill-classification/types.js";

export type Layer = "jevRaw" | "vendorRaw" | "combined" | "selected";
export type RunState = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
export interface Oracle {
  required: string[]; allowed: string[]; forbidden: string[]; notApplicable: string[];
  unadjudicated: string[]; expectedSelection: string; requiredReasons: string[];
  allowedConditions: Record<string, string>;
}
export interface SemanticCase { caseId: string; familyId: string; oracle: Oracle | null }
export interface LegacyObservation {
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
export function fromLegacySelection(caseId: string, decision: SkillSelectionDecisionV1, context: Omit<LegacyObservation, "caseId" | "layer" | "skillIds" | "selectionStatus" | "selectionReasons" | "hostReceipt" | "requestDigest" | "inventoryDigest">): LegacyObservation {
  return { ...context, caseId, layer: "selected", skillIds: decision.agentSelectedSkillIds,
    selectionStatus: decision.selectionStatus, selectionReasons: decision.selectionReasons,
    hostReceipt: decision.hostReceipt, requestDigest: decision.requestDigest, inventoryDigest: decision.inventoryDigest };
}

export function scoreLegacyCase(fixture: SemanticCase, observation: LegacyObservation | undefined, inventory: string[]): CaseScore {
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

function aggregateScores(fixtureCases: SemanticCase[], observations: LegacyObservation[], layer: Layer, inventory: string[], score: typeof scoreLegacyCase) {
  const cases = fixtureCases.filter(x => x.oracle !== null);
  const rows = observations.filter(x => x.layer === layer);
  if (new Set(rows.map(x => x.caseId)).size !== rows.length) throw new Error("DUPLICATE_OBSERVATION");
  if (rows.some(x => !cases.some(f => f.caseId === x.caseId))) throw new Error("UNKNOWN_CASE_OBSERVATION");
  const scores = cases.map(f => score(f, rows.find(x => x.caseId === f.caseId), inventory));
  const count = (predicate: (x: CaseScore) => boolean) => scores.filter(predicate).length;
  const denominator = cases.length;
  const requiredTotal = cases.reduce((n, c) => n + c.oracle!.required.length, 0);
  const tp = scores.reduce((n, s) => n + s.truePositives, 0);
  const fp = scores.reduce((n, s) => n + s.falsePositives, 0);
  const unadjudicatedCount = scores.reduce((n, s) => n + s.unadjudicated.length, 0);
  const passes = count(s => s.verdict === "PASS");
  const rate = (n: number, d = denominator) => d === 0 ? null : n / d;
  const stageObserved = (o: LegacyObservation, stage: "read" | "applied" | "verified") => {
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

export function aggregateLegacy(cases: SemanticCase[], observations: LegacyObservation[], layer: Layer, inventory: string[]) {
  return aggregateScores(cases, observations, layer, inventory, scoreLegacyCase);
}

export function evaluateLegacyLayers(cases: SemanticCase[], observations: LegacyObservation[], inventory: string[]) {
  return Object.fromEntries((["jevRaw", "vendorRaw", "combined", "selected"] as const).map(layer => [layer, aggregateLegacy(cases, observations, layer, inventory)]));
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

export interface LegacyPairTrial { pairId: string; caseId: string; path: string; repetition: number; codex: LegacyObservation | null; claude: LegacyObservation | null }
export const REPRESENTATIVE_CASES = ["SS01", "SS03", "SS04", "SS05", "SS08", "SS09", "SS10", "SS11", "SS14", "SS18"];
export const PAIR_PATHS = ["jev-on", "jev-off-vendor", "jev-invalid-key-vendor", "jev-timeout-vendor"];
export function legacyPairedMatrix(): LegacyPairTrial[] {
  return REPRESENTATIVE_CASES.flatMap(caseId => PAIR_PATHS.flatMap(path => [1, 2, 3].map(repetition => ({
    pairId: `${caseId}/${path}/${repetition}`, caseId, path, repetition, codex: null, claude: null }))));
}
export function scoreLegacyPairs(trials: LegacyPairTrial[], cases: SemanticCase[], inventory: string[]) {
  const expected = legacyPairedMatrix();
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
    const left = scoreLegacyCase(fixture, codex, inventory), right = scoreLegacyCase(fixture, claude, inventory);
    const agreement = sameSet(codex.skillIds, claude.skillIds);
    // Agreement and purpose quality are independent; two matching wrong answers fail.
    return { ...e, status: agreement && left.verdict === "PASS" && right.verdict === "PASS" ? "PASS" : "FAIL", agreement,
      codexGolden: left.verdict, claudeGolden: right.verdict };
  });
  const compared = records.filter(x => x.agreement !== null);
  const stability = (["codex", "claude"] as const).map(host => {
    const groups = REPRESENTATIVE_CASES.flatMap(caseId => PAIR_PATHS.map(path => {
      const observations = expected.filter(x => x.caseId === caseId && x.path === path)
        .map(e => trials.find(x => x.pairId === e.pairId)?.[host]).filter((x): x is LegacyObservation => !!x);
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

export const OBSERVATION_REVISION = "2.0.0";
export const SCORER_PATCH_REVISION = "r15";
type RequestBinding = Pick<SkillClassificationRequestV1, "requestId" | "operationId" | "requestDigest" | "inventoryDigest">;
interface ObservationBase extends RequestBinding {
  observationRevision: "2.0.0"; caseId: string; state: RunState;
  executionKind: LegacyObservation["executionKind"]; conditionDigest: string;
}
export interface ClassificationObservation extends ObservationBase {
  kind: "classification"; layer: "jevRaw" | "vendorRaw";
  classificationResponse: SkillClassificationResponseV1 | null;
  producerDiagnostics: {errorCode: string | null; capViolation: boolean; dispatchState: DispatchState; responseValidationErrors: string[]};
}
export interface CombinedObservation extends ObservationBase {
  kind: "support-combination"; layer: "combined";
  neededSkillIds: string[]; unresolvedItems: SkillClassificationResponseV1["unresolvedItems"];
  classificationResponseRefs: string[]; explicitSkillIds: string[]; ruleRequiredSkillIds: string[];
  contributions: {kind: "classification" | "explicit" | "rule"; skillId: string; reasonRefs: string[]}[];
}
export interface SelectionObservation extends ObservationBase {
  kind: "selection"; layer: "selected"; decision: SkillSelectionDecisionV1;
  host: string | null; candidateDigest?: string; stageEvidence: LegacyObservation["stageEvidence"];
}
export type Observation = ClassificationObservation | CombinedObservation | SelectionObservation;
export interface PairTrial extends Omit<LegacyPairTrial, "codex" | "claude"> {codex: SelectionObservation | null; claude: SelectionObservation | null}
/** Supplied separately by the evaluator caller; observations cannot issue this plan or authenticate its author. */
export interface TrustedStagePlan extends RequestBinding {
  caseId: string; conditionDigest: string; candidateDigest: string;
  readRefs: {path: string; digest: string}[]; obligationIds: string[]; requiredPhases: string[];
}

const text = z.string().min(1), ids = z.array(text), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const reasons = z.array(z.object({skillId: z.string().nullable(), reasonCode: text}).strict());
const base = {observationRevision: z.literal("2.0.0"), caseId: text, state: z.enum(["PASS", "FAIL", "BLOCKED", "NOT_RUN"]),
  executionKind: z.enum(["offline-mock", "replay", "provider-live", "host-live"]), requestId: text, operationId: text,
  requestDigest: digest, inventoryDigest: digest, conditionDigest: digest};
const stageSchema = z.object({read: z.boolean(), applied: z.boolean(), verified: z.boolean(),
  readRefs: z.array(z.object({path: text, digest}).strict()).optional(),
  obligations: z.array(z.object({obligationId: text, artifactRef: text}).strict()).optional(),
  requiredPhases: ids.optional(), completedPhases: ids.optional(),
  verification: z.object({candidateDigest: text, result: z.enum(["PASS", "FAIL", "NOT_RUN"]), evidenceRef: text}).strict().optional()}).strict();
const stagePlanSchema = z.object({caseId: text, requestId: text, operationId: text, requestDigest: digest, inventoryDigest: digest,
  conditionDigest: digest, candidateDigest: digest, readRefs: z.array(z.object({path: text, digest}).strict()).min(1),
  obligationIds: ids.min(1), requiredPhases: ids}).strict();
const observationSchema = z.discriminatedUnion("kind", [
  z.object({...base, kind: z.literal("classification"), layer: z.enum(["jevRaw", "vendorRaw"]), classificationResponse: responseSchema.nullable(),
    producerDiagnostics: z.object({errorCode: text.nullable(), capViolation: z.boolean(), dispatchState: z.enum(["not-started", "started", "unknown"]), responseValidationErrors: ids}).strict()}).strict(),
  z.object({...base, kind: z.literal("support-combination"), layer: z.literal("combined"), neededSkillIds: ids, unresolvedItems: reasons,
    classificationResponseRefs: z.array(digest), explicitSkillIds: ids, ruleRequiredSkillIds: ids,
    contributions: z.array(z.object({kind: z.enum(["classification", "explicit", "rule"]), skillId: text, reasonRefs: ids.min(1)}).strict())}).strict(),
  z.object({...base, kind: z.literal("selection"), layer: z.literal("selected"), decision: decisionSchema,
    host: text.nullable(), candidateDigest: text.optional(), stageEvidence: stageSchema}).strict(),
]);

/** Structural receipt matching is not authentication of the host or author. */
export function assertObservation(value: unknown, inventory: string[]): asserts value is Observation {
  observationSchema.parse(value);
  const observation = value as Observation;
  if (observation.kind === "classification") {
    const response = observation.classificationResponse;
    if (response !== null) {
      // Validation-only projection of the fields consumed by the common validator, not a newly packaged REQ.
      const request = {...observation, skills: inventory.map(skillId => ({skillId}))} as unknown as SkillClassificationRequestV1;
      if (validateClassificationResponse(request, response).length) throw new Error("INVALID_CLASSIFICATION_OBSERVATION_RESPONSE");
      if (observation.state === "PASS" && (response.error !== null || ["UNAVAILABLE", "INVALID"].includes(response.status))) throw new Error("FAILURE_RESPONSE_CANNOT_PASS");
    } else if (observation.state === "PASS") throw new Error("CLASSIFICATION_RESPONSE_ABSENT");
    if (observation.state === "PASS" && (observation.producerDiagnostics.errorCode !== null || observation.producerDiagnostics.capViolation || observation.producerDiagnostics.responseValidationErrors.length)) throw new Error("PRODUCER_FAILURE_CANNOT_PASS");
  } else if (observation.kind === "selection") {
    const decision = observation.decision, selected = decision.agentSelectedSkillIds;
    if (decision.requestDigest !== observation.requestDigest || decision.inventoryDigest !== observation.inventoryDigest) throw new Error("SELECTION_BINDING_MISMATCH");
    if (selected === null) {
      if (!["PROPOSED", "NEEDS_INPUT"].includes(decision.selectionStatus) || decision.hostReceipt !== null || decision.adviceApplied) throw new Error("UNOBSERVED_SELECTION_CLAIM");
    } else {
      const receipt = decision.hostReceipt;
      if (!["SELECTED", "PARTIAL"].includes(decision.selectionStatus) || !receipt || receipt.host !== observation.host || receipt.requestDigest !== observation.requestDigest || receipt.inventoryDigest !== observation.inventoryDigest || !sameSet(receipt.agentSelectedSkillIds, selected)) throw new Error("HOST_SELECTION_RECEIPT_MISSING_OR_MISMATCH");
      if (new Set(selected).size !== selected.length) throw new Error("DUPLICATE_SELECTED_SKILL");
    }
  } else {
    if (new Set(observation.neededSkillIds).size !== observation.neededSkillIds.length || observation.neededSkillIds.some(skillId => !observation.contributions.some(row => row.skillId === skillId)) || [...observation.explicitSkillIds, ...observation.ruleRequiredSkillIds].some(skillId => !observation.neededSkillIds.includes(skillId))) throw new Error("COMBINED_CONTRIBUTION_MISSING");
    if (observation.contributions.some(row => row.kind === "classification" && observation.classificationResponseRefs.length === 0 || row.kind === "explicit" && !observation.explicitSkillIds.includes(row.skillId) || row.kind === "rule" && !observation.ruleRequiredSkillIds.includes(row.skillId))) throw new Error("COMBINED_CONTRIBUTION_UNBOUND");
  }
}

export function fromClassification(caseId: string, request: SkillClassificationRequestV1, response: unknown,
  context: Pick<ClassificationObservation, "state" | "executionKind" | "conditionDigest" | "producerDiagnostics">, layer: "jevRaw" | "vendorRaw" = "jevRaw"): ClassificationObservation {
  const errors = response === null || response === undefined ? [] : validateClassificationResponse(request, response as SkillClassificationResponseV1);
  const validResponse = response !== null && response !== undefined && errors.length === 0 ? structuredClone(response as SkillClassificationResponseV1) : null;
  const blocked = validResponse === null || validResponse.error !== null || ["UNAVAILABLE", "INVALID"].includes(validResponse.status);
  const observation: ClassificationObservation = {observationRevision: OBSERVATION_REVISION, kind: "classification", caseId, layer,
    requestId: request.requestId, operationId: request.operationId, requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest,
    ...context, state: context.state === "NOT_RUN" ? "NOT_RUN" : blocked ? "BLOCKED" : context.state,
    classificationResponse: validResponse, producerDiagnostics: {...context.producerDiagnostics,
      responseValidationErrors: [...new Set([...context.producerDiagnostics.responseValidationErrors, ...errors])]}};
  assertObservation(observation, request.skills.map(skill => skill.skillId));
  return observation;
}
export function fromSelection(caseId: string, decision: SkillSelectionDecisionV1,
  context: Omit<SelectionObservation, "observationRevision" | "kind" | "layer" | "caseId" | "decision" | "requestDigest" | "inventoryDigest">): SelectionObservation {
  const observation: SelectionObservation = {...context, observationRevision: OBSERVATION_REVISION, kind: "selection", layer: "selected", caseId,
    requestDigest: decision.requestDigest, inventoryDigest: decision.inventoryDigest, decision: structuredClone(decision)};
  assertObservation(observation, []);
  return observation;
}

/** Ephemeral legacy arithmetic view, never serialized or accepted as an AGENT selection. */
function scoringEvidence(observation: Observation): LegacyObservation {
  const common = {caseId: observation.caseId, layer: observation.layer, state: observation.state, executionKind: observation.executionKind,
    requestDigest: observation.requestDigest, inventoryDigest: observation.inventoryDigest, conditionDigest: observation.conditionDigest};
  if (observation.kind === "selection") return {...common, skillIds: observation.decision.agentSelectedSkillIds,
    selectionStatus: observation.decision.selectionStatus, reasonCodes: observation.decision.unresolvedSkillReferences.map(row => row.reason),
    selectionReasons: observation.decision.selectionReasons, host: observation.host, hostReceipt: observation.decision.hostReceipt,
    stageEvidence: observation.stageEvidence, ...(observation.candidateDigest === undefined ? {} : {candidateDigest: observation.candidateDigest})};
  const response = observation.kind === "classification" ? observation.classificationResponse : null;
  const skillIds = observation.kind === "classification" ? response === null || response.status === "UNCERTAIN" && response.judgments.every(row => row.judgment === "uncertain") ? null : response.judgments.filter(row => row.judgment === "needed").map(row => row.skillId) : observation.neededSkillIds;
  const unresolved = observation.kind === "classification" ? response?.unresolvedItems ?? [] : observation.unresolvedItems;
  return {...common, skillIds, selectionStatus: skillIds === null ? "NEEDS_INPUT" : "PROPOSED",
    reasonCodes: [...unresolved.map(row => row.reasonCode), ...(observation.kind === "classification" && observation.producerDiagnostics.errorCode ? [observation.producerDiagnostics.errorCode] : [])],
    selectionReasons: observation.kind === "classification" ? response?.judgments.map(row => ({skillId: row.skillId, reason: row.reasonRefs.join(",")})) ?? [] : observation.contributions.map(row => ({skillId: row.skillId, reason: row.reasonRefs.join(",")})),
    host: null, hostReceipt: null, stageEvidence: {read: false, applied: false, verified: false}};
}
export function scoreCase(fixture: SemanticCase, observation: Observation | undefined, inventory: string[]): CaseScore {
  if (observation) assertObservation(observation, inventory);
  const score = scoreLegacyCase(fixture, observation && scoringEvidence(observation), inventory);
  if (observation?.state === "PASS") {
    const selected = scoringEvidence(observation).skillIds;
    if (selected !== null) score.falsePositives = new Set([...score.forbidden, ...score.unnecessary, ...selected.filter(id => !inventory.includes(id))]).size;
  }
  if (observation && observation.kind !== "selection" && score.reasons.includes("UNCERTAINTY_HIDDEN_AS_SELECTION")) {
    const unresolved = observation.kind === "classification" ? observation.classificationResponse?.unresolvedItems ?? [] : observation.unresolvedItems;
    const reasonsPresent = fixture.oracle!.requiredReasons.every(reason => unresolved.some(row => row.reasonCode === reason));
    score.reasons = score.reasons.flatMap(reason => reason !== "UNCERTAINTY_HIDDEN_AS_SELECTION" ? [reason] : reasonsPresent ? [] : ["CLASSIFICATION_REQUIRED_INPUT_REASON_MISSING"]);
    score.verdict = score.missingRequired.length + score.forbidden.length + score.unnecessary.length + score.reasons.length > 0 ? "FAIL" : score.unadjudicated.length ? "REVIEW_REQUIRED" : "PASS";
  }
  return score;
}
function stageObserved(observation: Observation, stage: "read" | "applied" | "verified", plans: TrustedStagePlan[]): boolean {
  if (observation.kind !== "selection" || observation.state !== "PASS" || !observation.decision.hostReceipt) return false;
  const e = observation.stageEvidence;
  const read = e.read && !!e.readRefs?.length && e.readRefs.every(row => !!row.path && /^sha256:[a-f0-9]{64}$/u.test(row.digest));
  if (stage === "read") return read;
  const plan = plans.find(row => row.caseId === observation.caseId && row.requestId === observation.requestId && row.operationId === observation.operationId &&
    row.requestDigest === observation.requestDigest && row.inventoryDigest === observation.inventoryDigest && row.conditionDigest === observation.conditionDigest && row.candidateDigest === observation.candidateDigest);
  const applied = read && e.applied && !!plan && Array.isArray(e.requiredPhases) && Array.isArray(e.completedPhases) &&
    sameSet(e.requiredPhases, plan.requiredPhases) && plan.requiredPhases.every(phase => e.completedPhases!.includes(phase)) &&
    sameSet(e.readRefs!.map(row => JSON.stringify([row.path, row.digest])), plan.readRefs.map(row => JSON.stringify([row.path, row.digest]))) &&
    !!e.obligations && e.obligations.every(row => !!row.artifactRef) && sameSet(e.obligations.map(row => row.obligationId), plan.obligationIds);
  if (stage === "applied") return applied;
  return applied && e.verified && e.verification?.candidateDigest === plan!.candidateDigest && e.verification.result === "PASS" && !!e.verification.evidenceRef;
}
export function aggregate(cases: SemanticCase[], observations: Observation[], layer: Layer, inventory: string[], stagePlans: TrustedStagePlan[] = []) {
  observations.forEach(row => assertObservation(row, inventory));
  stagePlans.forEach(plan => {
    stagePlanSchema.parse(plan);
    if (new Set(plan.requiredPhases).size !== plan.requiredPhases.length || new Set(plan.obligationIds).size !== plan.obligationIds.length ||
      new Set(plan.readRefs.map(row => row.path)).size !== plan.readRefs.length) throw new Error("DUPLICATE_STAGE_PLAN_MEMBER");
  });
  if (new Set(stagePlans.map(plan => JSON.stringify([plan.caseId, plan.requestId, plan.operationId, plan.requestDigest, plan.inventoryDigest, plan.conditionDigest, plan.candidateDigest]))).size !== stagePlans.length) throw new Error("DUPLICATE_STAGE_PLAN_BINDING");
  const result = aggregateScores(cases, observations.map(scoringEvidence), layer, inventory,
    fixture => scoreCase(fixture, observations.find(row => row.caseId === fixture.caseId && row.layer === layer), inventory));
  const stageCoverage = Object.fromEntries((["read", "applied", "verified"] as const).map(stage => [stage, result.denominator === 0 ? null :
    observations.filter(row => row.layer === layer && result.scores.find(score => score.caseId === row.caseId)?.answered && stageObserved(row, stage, stagePlans)).length / result.denominator]));
  return {...result, stageCoverage, observationRevision: OBSERVATION_REVISION, scorerRevision: OBSERVATION_REVISION, scorerPatchRevision: SCORER_PATCH_REVISION};
}
export function evaluateLayers(cases: SemanticCase[], observations: Observation[], inventory: string[], stagePlans: TrustedStagePlan[] = []) {
  return Object.fromEntries((["jevRaw", "vendorRaw", "combined", "selected"] as const).map(layer => [layer, aggregate(cases, observations, layer, inventory, stagePlans)]));
}
export function pairedMatrix(): PairTrial[] {return legacyPairedMatrix().map(row => ({...row, codex: null, claude: null}));}
export function scorePairs(trials: PairTrial[], cases: SemanticCase[], inventory: string[]) {
  for (const trial of trials) for (const observation of [trial.codex, trial.claude]) if (observation !== null) {
    assertObservation(observation, inventory);
    if (observation.kind !== "selection") throw new Error("PAIR_REQUIRES_SELECTION_OBSERVATION");
  }
  const legacy = scoreLegacyPairs(trials.map(row => ({...row, codex: row.codex && scoringEvidence(row.codex), claude: row.claude && scoringEvidence(row.claude)})), cases, inventory);
  const records = pairedMatrix().map(expected => {
    const trial = trials.find(row => row.pairId === expected.pairId) ?? expected;
    const {codex, claude} = trial;
    const trace = {...expected, codex: structuredClone(codex), claude: structuredClone(claude)};
    const old = legacy.records.find(row => row.pairId === expected.pairId)!;
    let status = old.status;
    if (!codex || !claude || codex.state === "NOT_RUN" || claude.state === "NOT_RUN") status = "NOT_RUN";
    else if (codex.state === "BLOCKED" || claude.state === "BLOCKED") status = "BLOCKED";
    const executed = codex?.state === "PASS" && claude?.state === "PASS" && codex.host === "codex" && claude.host === "claude" &&
      codex.caseId === expected.caseId && claude.caseId === expected.caseId && status !== "UNMATCHED";
    const selected = executed && codex.decision.agentSelectedSkillIds !== null && claude.decision.agentSelectedSkillIds !== null;
    const agreement = selected ? sameSet(codex.decision.agentSelectedSkillIds, claude.decision.agentSelectedSkillIds) : null;
    const abstentionAgreement = executed && !selected ? codex.decision.agentSelectedSkillIds === null && claude.decision.agentSelectedSkillIds === null : null;
    return {...trace, status, agreement, abstentionAgreement, codexGolden: codex?.state === "NOT_RUN" ? "NOT_RUN" : old.codexGolden,
      claudeGolden: claude?.state === "NOT_RUN" ? "NOT_RUN" : old.claudeGolden};
  });
  const eligibleSlot = (record: typeof records[number], host: "codex" | "claude") => {
    const row = record[host];
    return row?.state === "PASS" && row.host === host && row.caseId === record.caseId && record.status !== "UNMATCHED";
  };
  const stability = (["codex", "claude"] as const).map(host => {
    const groups = REPRESENTATIVE_CASES.flatMap(caseId => PAIR_PATHS.map(path => {
      const observations = records.filter(row => row.caseId === caseId && row.path === path && eligibleSlot(row, host)).map(row => row[host]!);
      const selected = observations.filter(row => row.decision.agentSelectedSkillIds !== null);
      const bindingCount = new Set(observations.map(row => JSON.stringify([row.conditionDigest, row.inventoryDigest, row.candidateDigest]))).size;
      const values = selected.map(row => JSON.stringify(canonicalSet(row.decision.agentSelectedSkillIds)));
      const observedAbstentions = observations.length - selected.length;
      return {caseId, path, observedRepeats: selected.length, observedAbstentions,
        status: bindingCount > 1 ? "UNMATCHED" : values.length < 3 ? "NOT_RUN" : new Set(values).size === 1 ? "STABLE" : "UNSTABLE",
        abstentionStatus: bindingCount > 1 ? "UNMATCHED" : observedAbstentions === 3 ? "STABLE" : "NOT_RUN"};
    }));
    return {host, denominator: groups.length, stableGroups: groups.filter(row => row.status === "STABLE").length,
      unstableGroups: groups.filter(row => row.status === "UNSTABLE").length, notRunGroups: groups.filter(row => row.status === "NOT_RUN").length,
      unmatchedGroups: groups.filter(row => row.status === "UNMATCHED").length, stableAbstentionGroups: groups.filter(row => row.abstentionStatus === "STABLE").length, groups};
  });
  const compared = records.filter(row => row.agreement !== null), abstentions = records.filter(row => row.abstentionAgreement !== null);
  return {...legacy, scorerPatchRevision: SCORER_PATCH_REVISION, expectedHostSlots: records.length * 2,
    executedHostSlots: records.reduce((count, row) => count + Number(eligibleSlot(row, "codex")) + Number(eligibleSlot(row, "claude")), 0),
    comparedPairs: compared.length, comparedAbstentionPairs: abstentions.length,
    exactSetAgreement: compared.length ? compared.filter(row => row.agreement).length / compared.length : null,
    executedAbstentionAgreement: abstentions.length ? abstentions.filter(row => row.abstentionAgreement).length / abstentions.length : null,
    notRunPairs: records.filter(row => row.status === "NOT_RUN").length, blockedPairs: records.filter(row => row.status === "BLOCKED").length,
    unmatchedPairs: records.filter(row => row.status === "UNMATCHED").length,
    completedPurposeRate: records.filter(row => row.status === "PASS").length / records.length, stability, records,
    verdict: legacy.issues.length === 0 && records.every(row => row.status === "PASS") ? "PASS" : "INCOMPLETE_OR_FAIL"};
}

const legacySchema = z.object({caseId: text, layer: z.enum(["jevRaw", "vendorRaw", "combined", "selected"]), state: z.enum(["PASS", "FAIL", "BLOCKED", "NOT_RUN"]),
  skillIds: ids.nullable(), selectionStatus: text, reasonCodes: ids, selectionReasons: z.array(z.object({skillId: text, reason: z.string()}).strict()),
  executionKind: base.executionKind, host: text.nullable(), hostReceipt: z.object({receiptId: text, host: text, requestDigest: text, inventoryDigest: text, agentSelectedSkillIds: ids, acceptedAt: text}).strict().nullable(),
  requestDigest: text, inventoryDigest: text, conditionDigest: text, candidateDigest: text.optional(), stageEvidence: stageSchema}).strict();
const pairSchema = z.object({pairId: text, caseId: text, path: text, repetition: z.number().int(), codex: z.unknown().nullable(), claude: z.unknown().nullable()}).strict();
export function evaluateInput(value: unknown, corpus: {cases: SemanticCase[]; inventorySkillIds: string[]; stagePlans?: TrustedStagePlan[]}) {
  const input = z.object({observationRevision: z.enum(["2.0.0", "legacy-v1"]), observations: z.array(z.unknown()), pairs: z.array(pairSchema)}).strict().parse(value);
  if (input.observationRevision === "legacy-v1") {
    input.observations.forEach(row => legacySchema.parse(row));
    input.pairs.forEach(row => [row.codex, row.claude].forEach(observation => {if (observation !== null) legacySchema.parse(observation);}));
    return {observationRevision: "legacy-v1", scorerRevision: "legacy-v1", archivalDiagnosticOnly: true,
      layers: evaluateLegacyLayers(corpus.cases, input.observations as LegacyObservation[], corpus.inventorySkillIds),
      pairs: scoreLegacyPairs(input.pairs as LegacyPairTrial[], corpus.cases, corpus.inventorySkillIds), releaseAcceptance: "NOT_ASSESSED"};
  }
  input.observations.forEach(row => assertObservation(row, corpus.inventorySkillIds));
  input.pairs.forEach(row => [row.codex, row.claude].forEach(observation => {if (observation !== null) {assertObservation(observation, corpus.inventorySkillIds); if (observation.kind !== "selection") throw new Error("PAIR_REQUIRES_SELECTION_OBSERVATION");}}));
  return {observationRevision: OBSERVATION_REVISION, scorerRevision: OBSERVATION_REVISION, scorerPatchRevision: SCORER_PATCH_REVISION,
    layers: evaluateLayers(corpus.cases, input.observations as Observation[], corpus.inventorySkillIds, corpus.stagePlans),
    pairs: scorePairs(input.pairs as PairTrial[], corpus.cases, corpus.inventorySkillIds), releaseAcceptance: "NOT_ASSESSED"};
}

// Local diagnostics only. Historical inputs require explicit legacy-v1.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error("Usage: node --import tsx evaluation.ts [versioned-local-observations.json]");
  const corpus = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
  if (oracleDigest(corpus) !== corpus.oracleDigest) throw new Error("FROZEN_ORACLE_DIGEST_MISMATCH");
  const input = args[0] ? JSON.parse(readFileSync(resolve(args[0]), "utf8")) : {observationRevision: OBSERVATION_REVISION, observations: [], pairs: []};
  console.log(JSON.stringify({oracleDigest: corpus.oracleDigest, targetRelease: corpus.targetRelease, ...evaluateInput(input, corpus)}, null, 2));
}
