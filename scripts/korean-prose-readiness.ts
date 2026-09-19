import { createHash } from "node:crypto";
import { access, readdir, readFile, realpath } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import { ContractValidator } from "../mcp-server/src/schema-validator.js";
import type { WorkflowReceiptV1 } from "../contracts/types.js";
import { assertConcreteKoreanProseExecutionProvenance } from "./korean-prose-execution-provenance.js";

const addFormats = addFormatsModule as unknown as FormatsPlugin;

// Preserved verbatim from evals/cycles/0.1.0-rc2/thresholds.json at the pinned upstream commit.
export const REQUIRED_KOREAN_PROSE_THRESHOLDS = {
  protectedExactRate: 100,
  legacyMeaningPassRate: 99,
  legacyImprovementRate: 80,
  legacyRegressionRateMax: 5,
  legacyRestraintSuccessRate: 90,
  holdoutMajorMeaningFailuresMax: 0,
  holdoutProtectedFailuresMax: 0,
  holdoutImprovementRate: 80,
  holdoutRestraintSuccessRate: 85,
  roleReuseMax: 0,
  missingEvidenceMax: 0,
  rubricChangesMax: 0,
} as const;

export type KoreanProseReadinessStatus = "READY_TO_EVALUATE" | "EVALUATION_EVIDENCE_PASSED";

export interface KoreanProseReadinessResult {
  status: KoreanProseReadinessStatus;
  frameId: string;
  frameDigest: string;
  caseCount: number;
  runBudget: number;
  rubricDigest: string;
  qualityEvidencePresent: boolean;
}

interface EvaluationFrame {
  frameId: string;
  status: "frozen";
  candidate: {
    suiteRevision: string;
    skillSourceCommit: string;
    skillSourceChecksum: string;
    integratedSkillChecksum: string;
    toolchainDigest: string;
  };
  corpus: {
    caseCount: number;
    inputDigest: string;
    orderedCaseIdsDigest: string;
    labelsLocator: string;
    labelsDigest: string;
    strata: { legacyCount: number; holdoutCount: number };
  };
  controls: {
    rubricLocator: string;
    rubricDigest: string;
    thresholdsDigest: string;
    corpusValidityEvidenceDigest: string;
  };
  runBudget: number;
  thresholds: Record<keyof typeof REQUIRED_KOREAN_PROSE_THRESHOLDS, number>;
  priorFrames: Array<{
    frameId: string;
    disposition: "invalid-corpus" | "failed-recovery";
    evidenceLocator: string;
    evidenceDigest: string;
  }>;
  frameDigest: string;
}

interface ValidityReport {
  frameId: string;
  frameDigest: string;
  corpusDigest: string;
  status: "valid" | "invalid" | "insufficient-evidence";
  auditedAt: string;
  executionStartedAt: string;
  actors: { author: string; auditor: string; adjudicator: string };
  checks: Record<string, boolean>;
  strataCounts: { legacyCount: number; holdoutCount: number };
  evidence: Array<{ verified: true }>;
  reportDigest: string;
}

interface QualityReport {
  frameId: string;
  frameDigest: string;
  rubricDigest: string;
  adjudicatorActorId: string;
  adjudicationInputLocator: string;
  adjudicationInputDigest: string;
  adjudicationMetaLocator: string;
  adjudicationMetaDigest: string;
  adjudicationLocator: string;
  adjudicationDigest: string;
  runCount: number;
  runs: Array<{
    run: number;
    receiptLocator: string;
    receiptDigest: string;
    claimDigest: string;
    actorIds: string[];
    caseCount: number;
    complete: true;
  }>;
  reportDigest: string;
}

interface FinalEvaluationRecord {
  id: string;
  suite: "legacy-100" | "holdout-30";
  expectedDecision: "edit" | "retain" | "defer";
  finalText: string;
  finalAction: string;
  protectedStrings: string[];
}

interface QualityAdjudicationRecord {
  schemaVersion: "1.0.0";
  run: number;
  caseId: string;
  adjudicatorActorId: string;
  receiptDigest: string;
  sourceDigest: string;
  finalDigest: string;
  rubricDigest: string;
  meaningPreservation: "pass" | "fail" | "uncertain";
  majorMeaningChange: boolean;
  registerCompliance: "pass" | "fail" | "uncertain";
  protectedStrings: "pass" | "fail" | "uncertain";
  terminologyJudgment: "pass" | "fail" | "uncertain" | "not-applicable";
  pairPreference: "candidate" | "original" | "tie" | "neither";
}

interface AdjudicatedFinal extends FinalEvaluationRecord {
  adjudication: QualityAdjudicationRecord;
}

// Compiled in this order, so a schema may reference any schema listed before it.
const SCHEMA_FILES = {
  frame: "korean-prose-evaluation-frame",
  input: "korean-prose-evaluation-input",
  final: "korean-prose-evaluation-final",
  receiptBinding: "korean-prose-receipt-binding",
  validity: "korean-prose-evaluation-validity-report",
  quality: "korean-prose-quality-report",
  adjudicationInput: "korean-prose-quality-adjudication-input",
  adjudicationMeta: "korean-prose-quality-adjudication-meta",
  adjudication: "korean-prose-quality-adjudication",
} as const;

let validators: Promise<Record<keyof typeof SCHEMA_FILES, ValidateFunction>> | null = null;

export async function evaluateKoreanProseReadiness(
  cycleDirectory: string,
  options: {
    requireQuality?: boolean;
    expectedFrameDigest?: string;
    expectedValidityReportDigest?: string;
    expectedQualityReportDigest?: string;
    evaluationRoot?: string;
  } = {},
): Promise<KoreanProseReadinessResult> {
  if (options.requireQuality && (!options.expectedFrameDigest || !options.expectedValidityReportDigest)) {
    throw new Error("externally expected frame and validity report digests are required for quality evaluation");
  }
  const cycleRoot = await realpath(cycleDirectory);
  const evaluationRoot = path.resolve(options.evaluationRoot ?? path.resolve(import.meta.dirname, ".."));
  const { frame: validateFrame, input: validateInput, validity: validateValidity, quality: validateQuality } = await loadValidators();
  const frameValue = await readJson(path.join(cycleRoot, "evaluation-frame.json"));
  assertSchema(validateFrame, frameValue, "evaluation frame");
  const frame = frameValue as unknown as EvaluationFrame;
  assertSelfDigest(frameValue, "frameDigest", "evaluation frame");
  if (options.expectedFrameDigest && frame.frameDigest !== options.expectedFrameDigest) {
    throw new Error("evaluation frame does not match the externally expected digest");
  }
  assertRequiredThresholds(frame);
  await assertPriorTerminalFrames(cycleRoot, frame);
  await assertPinnedCandidate(frame, evaluationRoot);

  const inputText = await readFile(path.join(cycleRoot, "input.jsonl"), "utf8");
  const inputRecords = parseJsonl(inputText);
  for (const record of inputRecords) assertSchema(validateInput, record, "model-visible evaluation input record");
  const caseIds = inputRecords.map((record) => requiredString(record, "id", "input case"));
  const labelsPath = resolveInside(cycleRoot, frame.corpus.labelsLocator, "quality labels locator");
  const labelRecords = parseJsonl(await readFile(labelsPath, "utf8"));
  if (digestCanonical(labelRecords) !== frame.corpus.labelsDigest) throw new Error("quality labels digest does not match the frozen frame");
  const labelIds = labelRecords.map((record) => requiredString(record, "id", "quality label"));
  if (JSON.stringify(labelIds) !== JSON.stringify(caseIds)) throw new Error("quality labels are incomplete or reordered");
  const legacyCount = labelRecords.filter((record) => record.suite === "legacy-100").length;
  const holdoutCount = labelRecords.filter((record) => record.suite === "holdout-30").length;
  if (labelRecords.some((record) => !["legacy-100", "holdout-30"].includes(String(record.suite))
      || !["edit", "retain", "defer"].includes(String(record.expectedDecision)))
    || legacyCount + holdoutCount !== labelRecords.length
    || legacyCount !== frame.corpus.strata.legacyCount || holdoutCount !== frame.corpus.strata.holdoutCount) {
    throw new Error("quality labels and corpus strata do not match the frozen frame");
  }
  if (new Set(caseIds).size !== caseIds.length) throw new Error("evaluation corpus contains duplicate case IDs");
  if (inputRecords.length !== frame.corpus.caseCount) throw new Error("evaluation corpus case count does not match the frozen frame");
  if (digestCanonical(inputRecords) !== frame.corpus.inputDigest) throw new Error("evaluation corpus digest does not match the frozen frame");
  if (digestCanonical(caseIds) !== frame.corpus.orderedCaseIdsDigest) throw new Error("ordered case ID digest does not match the frozen frame");
  if (digestCanonical(frame.thresholds) !== frame.controls.thresholdsDigest) throw new Error("threshold digest does not match the frozen frame");
  const rubricPath = resolveInside(cycleRoot, frame.controls.rubricLocator, "rubric locator");
  if (digestRaw(await readFile(rubricPath)) !== frame.controls.rubricDigest) {
    throw new Error("rubric digest does not match the frozen frame");
  }

  const manifest = await readJson(path.join(cycleRoot, "manifest.json"));
  if (manifest.cycleId !== frame.frameId || manifest.frameDigest !== frame.frameDigest) {
    throw new Error("cycle manifest is not bound to the frozen evaluation frame");
  }

  const validityValue = await readJson(path.join(cycleRoot, "evaluation-validity-report.json"));
  assertSchema(validateValidity, validityValue, "evaluation validity report");
  const validity = validityValue as unknown as ValidityReport;
  assertSelfDigest(validityValue, "reportDigest", "evaluation validity report");
  if (options.expectedValidityReportDigest && validity.reportDigest !== options.expectedValidityReportDigest) {
    throw new Error("evaluation validity report does not match the externally expected digest");
  }
  if (validity.frameId !== frame.frameId || validity.frameDigest !== frame.frameDigest
    || validity.corpusDigest !== frame.corpus.inputDigest
    || JSON.stringify(validity.strataCounts) !== JSON.stringify(frame.corpus.strata)) {
    throw new Error("evaluation validity report is not bound to the frozen frame and corpus");
  }
  if (validity.status !== "valid" || Object.values(validity.checks).some((value) => value !== true)
    || validity.evidence.some((item) => item.verified !== true)) {
    throw new Error("evaluation corpus validity has not passed every required check");
  }
  const validityActors = Object.values(validity.actors);
  if (new Set(validityActors).size !== validityActors.length) throw new Error("evaluation validity roles must use distinct actors");
  const verifiedEvidenceDigests: string[] = [];
  for (const evidence of validityValue.evidence as Array<Record<string, unknown>>) {
    const evidencePath = resolveInside(cycleRoot, requiredString(evidence, "locator", "validity evidence"), "validity evidence locator");
    if (digestRaw(await readFile(evidencePath)) !== evidence.digest) throw new Error("evaluation validity evidence digest mismatch");
    verifiedEvidenceDigests.push(String(evidence.digest));
  }
  if (!verifiedEvidenceDigests.includes(frame.controls.corpusValidityEvidenceDigest)) {
    throw new Error("frozen frame does not bind the corpus validity evidence");
  }
  if (Date.parse(validity.auditedAt) > Date.parse(validity.executionStartedAt)) {
    throw new Error("evaluation validity audit occurred after execution started");
  }

  const qualityPath = path.join(cycleRoot, "quality-report.json");
  if (!(await exists(qualityPath))) {
    if (options.requireQuality) throw new Error("quality evidence is required but quality-report.json is missing");
    return result(frame, "READY_TO_EVALUATE", false);
  }

  const qualityValue = await readJson(qualityPath);
  assertSchema(validateQuality, qualityValue, "quality report");
  const quality = qualityValue as unknown as QualityReport;
  assertSelfDigest(qualityValue, "reportDigest", "quality report");
  if (!options.expectedFrameDigest || !options.expectedValidityReportDigest || !options.expectedQualityReportDigest) {
    throw new Error("externally expected frame, validity, and quality report digests are required for passed evidence");
  }
  if (quality.reportDigest !== options.expectedQualityReportDigest) {
    throw new Error("quality report does not match the externally expected digest");
  }
  await assertQualityEvidence(cycleRoot, frame, quality, inputRecords, labelRecords, validity, new Set(validityActors));
  return result(frame, "EVALUATION_EVIDENCE_PASSED", true);
}

async function assertQualityEvidence(
  cycleRoot: string,
  frame: EvaluationFrame,
  quality: QualityReport,
  inputRecords: Array<Record<string, unknown>>,
  labelRecords: Array<Record<string, unknown>>,
  validity: ValidityReport,
  validityActors: Set<string>,
): Promise<void> {
  if (quality.frameId !== frame.frameId || quality.frameDigest !== frame.frameDigest
    || quality.rubricDigest !== frame.controls.rubricDigest) {
    throw new Error("quality report is not bound to the frozen frame and rubric");
  }
  if (quality.runCount !== frame.runBudget || quality.runs.length !== frame.runBudget) {
    throw new Error("quality report does not contain the complete frozen run budget");
  }
  const expectedRuns = Array.from({ length: frame.runBudget }, (_, index) => index + 1);
  if (JSON.stringify(quality.runs.map((run) => run.run).sort((left, right) => left - right)) !== JSON.stringify(expectedRuns)) {
    throw new Error("quality report run ordinals are incomplete or duplicated");
  }
  const languageActors = quality.runs.flatMap((run) => run.actorIds);
  if (languageActors.length - new Set(languageActors).size > frame.thresholds.roleReuseMax) {
    throw new Error("quality report reuses a language actor beyond the frozen threshold");
  }
  if (languageActors.some((actor) => validityActors.has(actor))) throw new Error("evaluation validity and language roles must use distinct actors");
  if (validityActors.has(quality.adjudicatorActorId) || languageActors.includes(quality.adjudicatorActorId)) {
    throw new Error("quality adjudication must use an actor distinct from validity and language roles");
  }
  const sourceById = new Map(inputRecords.map((record) => [
    requiredString(record, "id", "input case"),
    requiredString(record, "sourceText", "input case"),
  ]));
  const labelsById = new Map(labelRecords.map((record) => {
    const id = requiredString(record, "id", "quality label");
    const suite = requiredString(record, "suite", "quality label");
    const expectedDecision = requiredString(record, "expectedDecision", "quality label");
    return [id, { suite, expectedDecision }] as const;
  }));
  const inputById = new Map(inputRecords.map((record) => {
    const id = requiredString(record, "id", "input case");
    const protectedStrings = record.protectedStrings ?? [];
    if (!Array.isArray(protectedStrings) || protectedStrings.some((item) => typeof item !== "string" || item.length === 0)) {
      throw new Error("input case has invalid protected-string metadata");
    }
    return [id, { ...labelsById.get(id)!, protectedStrings: protectedStrings as string[] }] as const;
  }));
  const expectedIds = [...sourceById.keys()];
  const adjudicationInputPath = resolveInside(cycleRoot, quality.adjudicationInputLocator, "quality adjudication input locator");
  const adjudicationInputRecords = parseJsonl(await readFile(adjudicationInputPath, "utf8"));
  if (digestCanonical(adjudicationInputRecords) !== quality.adjudicationInputDigest) {
    throw new Error("quality adjudication input digest mismatch");
  }
  const { adjudicationInput: validateAdjudicationInput, adjudicationMeta: validateAdjudicationMeta,
    adjudication: validateAdjudication, final: validateFinal } = await loadValidators();
  const adjudicationInputByRunAndCase = new Map<string, Record<string, unknown>>();
  for (const record of adjudicationInputRecords) {
    assertSchema(validateAdjudicationInput, record, "quality adjudication input record");
    const key = `${record.run}\u0000${record.caseId}`;
    if (adjudicationInputByRunAndCase.has(key)) throw new Error("quality adjudication input contains duplicate run/case records");
    adjudicationInputByRunAndCase.set(key, record);
  }
  if (adjudicationInputRecords.length !== frame.runBudget * frame.corpus.caseCount) {
    throw new Error("quality adjudication input does not cover the frozen run budget and corpus");
  }
  const adjudicationPath = resolveInside(cycleRoot, quality.adjudicationLocator, "quality adjudication locator");
  const adjudicationRecords = parseJsonl(await readFile(adjudicationPath, "utf8"));
  if (digestCanonical(adjudicationRecords) !== quality.adjudicationDigest) throw new Error("quality adjudication digest mismatch");
  for (const record of adjudicationRecords) assertSchema(validateAdjudication, record, "quality adjudication record");
  if (adjudicationRecords.length !== frame.runBudget * frame.corpus.caseCount) {
    throw new Error("quality adjudication does not cover the frozen run budget and corpus");
  }
  const adjudicationByRunAndCase = new Map<string, QualityAdjudicationRecord>();
  for (const value of adjudicationRecords) {
    const record = value as unknown as QualityAdjudicationRecord;
    const key = `${record.run}\u0000${record.caseId}`;
    if (adjudicationByRunAndCase.has(key)) throw new Error("quality adjudication contains duplicate run/case judgments");
    if (record.adjudicatorActorId !== quality.adjudicatorActorId || record.rubricDigest !== frame.controls.rubricDigest) {
      throw new Error("quality adjudication is not bound to its independent actor and frozen rubric");
    }
    adjudicationByRunAndCase.set(key, record);
  }
  const adjudicationMetaPath = resolveInside(cycleRoot, quality.adjudicationMetaLocator, "quality adjudication metadata locator");
  const adjudicationMetaText = await readFile(adjudicationMetaPath);
  if (digestRaw(adjudicationMetaText) !== quality.adjudicationMetaDigest) throw new Error("quality adjudication metadata digest mismatch");
  const adjudicationMeta = JSON.parse(adjudicationMetaText.toString("utf8")) as Record<string, unknown>;
  assertSchema(validateAdjudicationMeta, adjudicationMeta, "quality adjudication metadata");
  if (adjudicationMeta.actorId !== quality.adjudicatorActorId
    || adjudicationMeta.inputDigest !== quality.adjudicationInputDigest
    || adjudicationMeta.workProductDigest !== quality.adjudicationDigest) {
    throw new Error("quality adjudication metadata is not bound to its blind input and work product");
  }
  assertConcreteKoreanProseExecutionProvenance(adjudicationMeta.executionProvenance, "quality adjudication");
  const allFinals: AdjudicatedFinal[] = [];
  let rubricChanges = 0;
  for (const run of quality.runs) {
    if (!run.complete || run.caseCount !== frame.corpus.caseCount) throw new Error(`run ${run.run} is incomplete`);
    const receiptPath = resolveInside(cycleRoot, run.receiptLocator, "receipt locator");
    const receiptText = await readFile(receiptPath);
    if (digestRaw(receiptText) !== run.receiptDigest) throw new Error(`run ${run.run} receipt digest mismatch`);
    const { receipt, claimedAt, claimDigest } = await assertStructuredReceipt(cycleRoot, receiptPath, receiptText);
    if (claimDigest !== run.claimDigest) throw new Error(`run ${run.run} claim digest mismatch`);
    if (Date.parse(validity.executionStartedAt) > Date.parse(claimedAt)
      || Date.parse(claimedAt) > Date.parse(String(adjudicationMeta.completedAt))) {
      throw new Error(`run ${run.run} timing is not ordered audit -> execution -> adjudication`);
    }
    const receiptActors = receipt.stageResults.slice(0, 3).map((stage) => stage.output.output?.actorId);
    const finalActors = receipt.stageResults[3]?.output.output?.actorIds;
    if (JSON.stringify(receiptActors) !== JSON.stringify(run.actorIds)
      || JSON.stringify(finalActors) !== JSON.stringify(run.actorIds)) {
      throw new Error(`run ${run.run} quality actors are not bound to a finalized workflow receipt`);
    }
    const runDirectory = path.dirname(receiptPath);
    const finalRecords = parseJsonl(await readFile(path.join(runDirectory, "final.jsonl"), "utf8"));
    const finalIds = finalRecords.map((record) => requiredString(record, "id", "final record"));
    if (JSON.stringify(finalIds) !== JSON.stringify(expectedIds)) throw new Error(`run ${run.run} final case IDs are incomplete or reordered`);
    const normalizedFinals = finalRecords.map((record) => {
      assertSchema(validateFinal, record, "final evaluation record");
      const id = requiredString(record, "id", "final record");
      const input = inputById.get(id);
      if (!input) throw new Error(`run ${run.run} final record has an unknown case ID`);
      return asFinalEvaluationRecord(record, input.suite, input.expectedDecision);
    });
    for (const final of normalizedFinals) {
      const input = inputById.get(final.id)!;
      if (JSON.stringify(final.protectedStrings) !== JSON.stringify(input.protectedStrings)) {
        throw new Error(`run ${run.run} final protected-string metadata differs from the frozen input`);
      }
      const adjudication = adjudicationByRunAndCase.get(`${run.run}\u0000${final.id}`);
      const adjudicationInput = adjudicationInputByRunAndCase.get(`${run.run}\u0000${final.id}`);
      if (!adjudication
        || !adjudicationInput
        || adjudicationInput.sourceText !== sourceById.get(final.id)
        || adjudicationInput.finalText !== final.finalText
        || adjudication.receiptDigest !== run.receiptDigest
        || adjudication.sourceDigest !== digestRaw(requiredString(adjudicationInput, "sourceText", "adjudication input"))
        || adjudication.finalDigest !== digestRaw(requiredString(adjudicationInput, "finalText", "adjudication input"))) {
        throw new Error(`run ${run.run} independent adjudication is missing or not bound to the final artifact`);
      }
      allFinals.push({ ...final, adjudication });
    }
    const verificationProducts = parseJsonl(await readFile(path.join(runDirectory, "verification-work-product.jsonl"), "utf8"));
    const expectedRubricDigest = frame.controls.rubricDigest.slice("sha256:".length);
    rubricChanges += verificationProducts.filter((record) => record.rubricDigest !== expectedRubricDigest).length;
  }

  const legacy = allFinals.filter((record) => record.suite === "legacy-100");
  const holdout = allFinals.filter((record) => record.suite === "holdout-30");
  const protectedPass = allFinals.filter((record) => protectedEqual(sourceById.get(record.id)!, record.finalText, record.protectedStrings)).length;
  const legacyMeaningPass = legacy.filter((record) => record.finalText === sourceById.get(record.id)
    || record.adjudication.meaningPreservation === "pass").length;
  const legacyEdits = legacy.filter((record) => record.expectedDecision === "edit");
  const legacyRetains = legacy.filter((record) => record.expectedDecision === "retain" || record.expectedDecision === "defer");
  const holdoutEdits = holdout.filter((record) => record.expectedDecision === "edit");
  const holdoutRetains = holdout.filter((record) => record.expectedDecision === "retain" || record.expectedDecision === "defer");
  const legacyRegressions = legacy.filter((record) => record.finalText !== sourceById.get(record.id) && (
    record.adjudication.pairPreference === "original" || record.adjudication.pairPreference === "neither"
    || record.adjudication.meaningPreservation !== "pass" || record.adjudication.registerCompliance !== "pass"
    || record.adjudication.protectedStrings !== "pass" || record.adjudication.terminologyJudgment === "fail"
  )).length;
  assertMinimumRate("protected exact", protectedPass, allFinals.length, frame.thresholds.protectedExactRate);
  assertMinimumRate("legacy meaning pass", legacyMeaningPass, legacy.length, frame.thresholds.legacyMeaningPassRate);
  assertMinimumRate("legacy improvement", successfulEdits(legacyEdits), legacyEdits.length, frame.thresholds.legacyImprovementRate);
  assertMaximumRate("legacy regression", legacyRegressions, legacy.length, frame.thresholds.legacyRegressionRateMax);
  assertMinimumRate("legacy restraint success", successfulRetains(legacyRetains, sourceById), legacyRetains.length, frame.thresholds.legacyRestraintSuccessRate);
  assertMinimumRate("holdout improvement", successfulEdits(holdoutEdits), holdoutEdits.length, frame.thresholds.holdoutImprovementRate);
  assertMinimumRate("holdout restraint success", successfulRetains(holdoutRetains, sourceById), holdoutRetains.length, frame.thresholds.holdoutRestraintSuccessRate);
  const majorMeaningFailures = holdout.filter((record) => record.finalText !== sourceById.get(record.id)
    && record.adjudication.majorMeaningChange).length;
  const protectedFailures = holdout.filter((record) => !protectedEqual(sourceById.get(record.id)!, record.finalText, record.protectedStrings)).length;
  if (majorMeaningFailures > frame.thresholds.holdoutMajorMeaningFailuresMax
    || protectedFailures > frame.thresholds.holdoutProtectedFailuresMax
    || rubricChanges > frame.thresholds.rubricChangesMax) {
    throw new Error("quality report exceeds a frozen failure-count threshold");
  }
}

async function assertStructuredReceipt(
  cycleRoot: string,
  receiptPath: string,
  receiptText: Buffer,
): Promise<{ receipt: WorkflowReceiptV1; claimedAt: string; claimDigest: string }> {
  const receipt = new ContractValidator().workflowReceipt(JSON.parse(receiptText.toString("utf8")) as unknown);
  if (receipt.revision !== 5 || receipt.state !== "passed" || receipt.error !== null
    || receipt.stageResults.length !== 4 || receipt.stageResults.some((stage) => stage.state !== "passed")) {
    throw new Error("workflow receipt is not a finalized four-stage pass");
  }
  const runDirectory = path.dirname(receiptPath);
  const claimText = await readFile(path.join(runDirectory, "evaluation-run-claim.json"));
  const claim = JSON.parse(claimText.toString("utf8")) as Record<string, unknown>;
  const runOrdinal = Number(path.basename(runDirectory).replace(/^run-/u, ""));
  const frame = await readJson(path.join(cycleRoot, "evaluation-frame.json"));
  const validity = await readJson(path.join(cycleRoot, "evaluation-validity-report.json"));
  const startedAt = requiredString(claim, "startedAt", "evaluation run claim");
  if (!Number.isFinite(Date.parse(startedAt))
    || claim.frameId !== frame.frameId || claim.frameDigest !== frame.frameDigest
    || claim.validityReportDigest !== validity.reportDigest || claim.run !== runOrdinal) {
    throw new Error("workflow receipt does not have a matching atomic run claim");
  }
  const [inputText, selectionText, editingText, verificationText, finalText, cycleManifestText, bindingText] = await Promise.all([
    readFile(path.join(cycleRoot, "input.jsonl"), "utf8"),
    readFile(path.join(runDirectory, "selection-work-product.jsonl"), "utf8"),
    readFile(path.join(runDirectory, "editing-work-product.jsonl"), "utf8"),
    readFile(path.join(runDirectory, "verification-work-product.jsonl"), "utf8"),
    readFile(path.join(runDirectory, "final.jsonl"), "utf8"),
    readFile(path.join(cycleRoot, "manifest.json"), "utf8"),
    readFile(path.join(runDirectory, "receipt-binding.json"), "utf8"),
  ]);
  const expected = {
    source: digestCanonical(parseJsonl(inputText)).slice("sha256:".length),
    selection: digestCanonical(parseJsonl(selectionText)).slice("sha256:".length),
    editing: digestCanonical(parseJsonl(editingText)).slice("sha256:".length),
    verification: digestCanonical(parseJsonl(verificationText)).slice("sha256:".length),
    final: digestCanonical(parseJsonl(finalText)).slice("sha256:".length),
    manifest: digestCanonical(JSON.parse(bindingText) as unknown).slice("sha256:".length),
  };
  const startClaimSha256 = createHash("sha256").update(claimText).digest("hex");
  const roleMetadata = await Promise.all(["selection", "editing", "verification"].map(async (role) => {
    const text = await readFile(path.join(runDirectory, `${role}-meta.json`));
    return { role, text, value: JSON.parse(text.toString("utf8")) as Record<string, unknown> };
  }));
  const expectedWorkProducts = [expected.selection, expected.editing, expected.verification];
  for (const [index, entry] of roleMetadata.entries()) {
    const actorId = receipt.stageResults[index]?.output.output?.actorId;
    if (entry.value.schemaVersion !== "3.0.0" || entry.value.role !== entry.role
      || entry.value.actorId !== actorId || entry.value.run !== runOrdinal
      || entry.value.caseCount !== parseJsonl(inputText).length || entry.value.status !== "complete"
      || entry.value.inputSha256 !== expected.source || entry.value.workProductSha256 !== expectedWorkProducts[index]
      || entry.value.startClaimSha256 !== startClaimSha256
      || !entry.value.executionProvenance || typeof entry.value.executionProvenance !== "object") {
      throw new Error(`${entry.role} metadata is not bound to the atomic start claim and finalized work product`);
    }
    assertConcreteKoreanProseExecutionProvenance(entry.value.executionProvenance, entry.role);
  }
  const binding = JSON.parse(bindingText) as Record<string, unknown>;
  const { receiptBinding: validateReceiptBinding } = await loadValidators();
  assertSchema(validateReceiptBinding, binding, "receipt binding");
  const roleMetaSha256 = binding.roleMetaSha256 as Record<string, unknown> | undefined;
  if (binding.schemaVersion !== "1.0.0" || binding.frameId !== frame.frameId || binding.frameDigest !== frame.frameDigest
    || binding.run !== runOrdinal
    || binding.cycleManifestSha256 !== digestCanonical(JSON.parse(cycleManifestText) as unknown).slice("sha256:".length)
    || binding.startClaimSha256 !== startClaimSha256
    || roleMetadata.some((entry) => roleMetaSha256?.[entry.role] !== createHash("sha256").update(entry.text).digest("hex"))) {
    throw new Error("receipt binding does not bind the cycle manifest, start claim, and role metadata");
  }
  const expectedArtifacts = [
    ["edit-decision-set", expected.selection],
    ["edit-candidate", expected.editing],
    ["edit-verification-report", expected.verification],
    ["final-text-receipt", expected.final],
  ] as const;
  for (const [index, [artifactId, digest]] of expectedArtifacts.entries()) {
    const artifact = receipt.stageResults[index]?.output.artifacts.find((item) => item.artifactId === artifactId);
    if (!artifact?.verified || artifact.digest !== digest) throw new Error(`${artifactId} digest does not match its work product`);
  }
  const firstOutput = receipt.stageResults[0]?.output.output as Record<string, unknown> | null;
  const finalOutput = receipt.stageResults[3]?.output.output as Record<string, unknown> | null;
  const firstDigests = firstOutput?.digest as Record<string, unknown> | undefined;
  const finalDigests = finalOutput?.digest as Record<string, unknown> | undefined;
  if (firstDigests?.source !== expected.source || finalDigests?.result !== expected.final || finalDigests.manifest !== expected.manifest) {
    throw new Error("workflow receipt artifact digests do not match evaluation work products");
  }
  const finalStageIndex = receipt.plan.stages.findIndex((stage) => stage.requiredCapability === "korean-prose-finalization");
  const finalStage = receipt.plan.stages[finalStageIndex];
  if (!finalStage?.requiredInputArtifacts.includes("edit-decision-set")
    || !finalStage.inputBindings.some((binding) => binding.targetArtifact === "edit-decision-set"
      && binding.sources.includes("provider:korean-prose-selection.edit-decision-set"))
    || !receipt.stageResults[finalStageIndex]?.evidence.some((item) => item.artifactId === "edit-decision-set" && item.verified)) {
    throw new Error("workflow receipt does not bind selection through finalization");
  }
  const database = new DatabaseSync(path.join(runDirectory, "workflow.sqlite3"), { readOnly: true });
  try {
    const row = database.prepare("SELECT receipt_json FROM workflow_runs WHERE run_id = ?").get(receipt.runId) as { receipt_json: string } | undefined;
    if (!row || JSON.stringify(JSON.parse(row.receipt_json)) !== JSON.stringify(receipt)) {
      throw new Error("SQLite and file workflow receipts differ");
    }
    const artifactTexts = [inputText, selectionText, editingText, verificationText, finalText];
    assertNoRawText(receiptText.toString("utf8"), artifactTexts, "raw prose leaked into a workflow receipt");
    assertNoRawText(row.receipt_json, artifactTexts, "raw prose leaked into a workflow receipt");
  } finally {
    database.close();
  }
  return { receipt, claimedAt: startedAt, claimDigest: digestRaw(claimText) };
}

/** Throws `message` when any prose value from the JSON Lines artifacts appears in the receipt surface. */
export function assertNoRawText(surface: string, artifactTexts: string[], message: string): void {
  const rawValues = new Set<string>();
  for (const text of artifactTexts) {
    for (const record of jsonlValues(text)) collectRawText(record, rawValues);
  }
  for (const raw of rawValues) if (surface.includes(raw)) throw new Error(message);
}

function collectRawText(value: unknown, destination: Set<string>, key = ""): void {
  if (typeof value === "string") {
    if (/^(?:text|prose|replacement|context|userRequest|meaningConstraints)$/iu.test(key)
      || /(?:source|candidate|final|original|replacement|before|after|context|selected)(?:text|prose|slice|snippet)$/iu.test(key)) {
      if (value.length > 0) destination.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (/^(?:additionalProtectedStrings|protectedStrings)$/iu.test(key)) {
      for (const item of value) if (typeof item === "string" && item.length > 0) destination.add(item);
      return;
    }
    for (const item of value) collectRawText(item, destination, key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) collectRawText(child, destination, childKey);
  }
}

async function assertPinnedCandidate(frame: EvaluationFrame, evaluationRoot: string): Promise<void> {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const sourceLock = await readJson(path.resolve(import.meta.dirname, "..", "skills", "source-lock.json"));
  const sources = Array.isArray(sourceLock.sources) ? sourceLock.sources : [];
  const source = sources.find((item) => item && typeof item === "object"
    && (item as Record<string, unknown>).skillId === "korean-prose-editor") as Record<string, unknown> | undefined;
  const sourceRef = source?.ref && typeof source.ref === "object"
    ? source.ref as Record<string, unknown>
    : undefined;
  const repositorySkillChecksum = await computeDirectoryChecksum(path.join(repositoryRoot, "skills", "korean-prose-editor"));
  const evaluationSkillChecksum = await computeDirectoryChecksum(path.join(evaluationRoot, "skills", "korean-prose-editor"));
  if (!source
    || frame.candidate.skillSourceCommit !== sourceRef?.commit
    || frame.candidate.skillSourceChecksum !== source.upstreamChecksum
    || frame.candidate.suiteRevision !== repositoryRevision(repositoryRoot)
    || frame.candidate.integratedSkillChecksum !== evaluationSkillChecksum
    || evaluationSkillChecksum !== repositorySkillChecksum
    || frame.candidate.toolchainDigest !== await computeKoreanProseToolchainDigest(repositoryRoot)) {
    throw new Error("evaluation frame does not use the repository-pinned Korean prose source");
  }
}

function repositoryRevision(repositoryRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

export async function computeKoreanProseToolchainDigest(repositoryRoot: string): Promise<string> {
  const files = [
    "contracts/korean-prose-evaluation-frame.v1.schema.json",
    "contracts/korean-prose-evaluation-input.v1.schema.json",
    "contracts/korean-prose-evaluation-final.v1.schema.json",
    "contracts/korean-prose-evaluation-validity-report.v1.schema.json",
    "contracts/korean-prose-quality-adjudication-input.v1.schema.json",
    "contracts/korean-prose-quality-adjudication-meta.v1.schema.json",
    "contracts/korean-prose-quality-adjudication.v1.schema.json",
    "contracts/korean-prose-quality-report.v1.schema.json",
    "contracts/korean-prose-receipt-binding.v1.schema.json",
    "contracts/workflow-plan.v1.schema.json",
    "contracts/workflow-receipt.v1.schema.json",
    "contracts/stage-result.v1.schema.json",
    "mcp-server/src/evaluation-preflight.ts",
    "mcp-server/src/registry.ts",
    "mcp-server/src/schema-validator.ts",
    "mcp-server/src/sqlite-workflow-store.ts",
    "mcp-server/src/workflow-service.ts",
    "scripts/korean-prose-evaluation-preflight.ts",
    "scripts/korean-prose-execution-provenance.ts",
    "scripts/korean-prose-readiness.ts",
    "scripts/record-korean-prose-run.ts",
    "scripts/verify-korean-prose-evaluation-preflight.ts",
    "scripts/verify-korean-prose-readiness.ts",
    "scripts/verify-korean-prose-receipt.ts",
    "skills/source-lock.json",
  ];
  const parts: Array<string | Buffer> = [];
  for (const relative of files) {
    parts.push(relative, normalizeChecksumContent(await readFile(path.join(repositoryRoot, relative))));
  }
  return digestRaw(Buffer.concat(parts.map((part) => typeof part === "string" ? Buffer.from(part, "utf8") : part)));
}

export async function computeDirectoryChecksum(directory: string): Promise<string> {
  const files = await walkFiles(directory);
  const parts: Array<string | Buffer> = [];
  for (const file of files.sort()) {
    parts.push(path.relative(directory, file).split(path.sep).join("/"), normalizeChecksumContent(await readFile(file)));
  }
  return digestRaw(Buffer.concat(parts.map((part) => typeof part === "string" ? Buffer.from(part, "utf8") : part)));
}

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if ([".git", "node_modules", "__pycache__", "results"].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(full));
    else files.push(full);
  }
  return files;
}

function normalizeChecksumContent(content: Buffer): Buffer {
  if (content.includes(0)) return content;
  const decoded = content.toString("utf8");
  return decoded.includes("�") ? content : Buffer.from(decoded.replaceAll("\r\n", "\n"), "utf8");
}

function assertRequiredThresholds(frame: EvaluationFrame): void {
  for (const [key, value] of Object.entries(REQUIRED_KOREAN_PROSE_THRESHOLDS)) {
    if (frame.thresholds[key as keyof typeof REQUIRED_KOREAN_PROSE_THRESHOLDS] !== value) {
      throw new Error(`frozen threshold ${key} must remain ${value}`);
    }
  }
}

async function assertPriorTerminalFrames(cycleRoot: string, frame: EvaluationFrame): Promise<void> {
  const dispositions = new Set(frame.priorFrames.map((prior) => prior.disposition));
  const ids = new Set(frame.priorFrames.map((prior) => prior.frameId));
  if (ids.size !== frame.priorFrames.length || ids.has(frame.frameId)
    || !dispositions.has("invalid-corpus") || !dispositions.has("failed-recovery")) {
    throw new Error("frozen frame must preserve both prior terminal dispositions");
  }
  for (const prior of frame.priorFrames) {
    const evidencePath = resolveInside(cycleRoot, prior.evidenceLocator, "prior frame evidence locator");
    const evidenceText = await readFile(evidencePath);
    if (digestRaw(evidenceText) !== prior.evidenceDigest) throw new Error("prior frame evidence digest mismatch");
    let evidence: Record<string, unknown>;
    try {
      evidence = JSON.parse(evidenceText.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new Error("prior frame evidence is not a structured terminal disposition");
    }
    if (evidence.schemaVersion !== "1.0.0" || evidence.frameId !== prior.frameId
      || evidence.disposition !== prior.disposition || evidence.status !== "terminal") {
      throw new Error("prior frame evidence does not prove its declared terminal disposition");
    }
  }
}

function assertMinimumRate(name: string, passed: number, total: number, threshold: number): void {
  assertDenominator(name, passed, total);
  if ((passed * 100) / total < threshold) throw new Error(`${name} rate is below the frozen threshold`);
}

function assertMaximumRate(name: string, passed: number, total: number, threshold: number): void {
  assertDenominator(name, passed, total);
  if ((passed * 100) / total > threshold) throw new Error(`${name} rate exceeds the frozen threshold`);
}

function assertDenominator(name: string, passed: number, total: number): void {
  if (total < 1) throw new Error(`${name} denominator is empty`);
  if (passed > total) throw new Error(`${name} numerator exceeds its denominator`);
}

function successfulEdits(records: AdjudicatedFinal[]): number {
  return records.filter((record) => record.finalAction === "edit"
    && record.adjudication.pairPreference === "candidate"
    && record.adjudication.meaningPreservation === "pass"
    && !record.adjudication.majorMeaningChange
    && record.adjudication.registerCompliance === "pass"
    && record.adjudication.protectedStrings === "pass"
    && (record.adjudication.terminologyJudgment === "pass" || record.adjudication.terminologyJudgment === "not-applicable")).length;
}

function successfulRetains(records: FinalEvaluationRecord[], sourceById: Map<string, string>): number {
  return records.filter((record) => record.finalText === sourceById.get(record.id)).length;
}

function protectedEqual(source: string, target: string, values: string[]): boolean {
  return values.every((value) => countOccurrences(source, value) === countOccurrences(target, value)
    && orderedFirstIndexes(source, values).join("\u0000") === orderedFirstIndexes(target, values).join("\u0000"));
}

function countOccurrences(text: string, value: string): number {
  if (value.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(value, offset)) >= 0) {
    count += 1;
    offset += value.length;
  }
  return count;
}

function orderedFirstIndexes(text: string, values: string[]): string[] {
  return values.map((value) => ({ value, index: text.indexOf(value) }))
    .sort((left, right) => left.index - right.index || left.value.localeCompare(right.value))
    .map((entry) => entry.value);
}

function asFinalEvaluationRecord(
  value: Record<string, unknown>,
  suite: string,
  expectedDecision: string,
): FinalEvaluationRecord {
  if (!Array.isArray(value.protectedStrings) || value.protectedStrings.some((item) => typeof item !== "string")) {
    throw new Error("final evaluation record is missing protected-string metadata");
  }
  if ((suite !== "legacy-100" && suite !== "holdout-30")
    || !["edit", "retain", "defer"].includes(expectedDecision)) {
    throw new Error("final evaluation record has an unknown suite or expected decision");
  }
  return {
    id: requiredString(value, "id", "final record"),
    suite,
    expectedDecision: expectedDecision as FinalEvaluationRecord["expectedDecision"],
    finalText: requiredString(value, "finalText", "final record"),
    finalAction: requiredString(value, "finalAction", "final record"),
    protectedStrings: value.protectedStrings as string[],
  };
}

function result(
  frame: EvaluationFrame,
  status: KoreanProseReadinessStatus,
  qualityEvidencePresent: boolean,
): KoreanProseReadinessResult {
  return {
    status,
    frameId: frame.frameId,
    frameDigest: frame.frameDigest,
    caseCount: frame.corpus.caseCount,
    runBudget: frame.runBudget,
    rubricDigest: frame.controls.rubricDigest,
    qualityEvidencePresent,
  };
}

async function loadValidators(): Promise<Record<keyof typeof SCHEMA_FILES, ValidateFunction>> {
  validators ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const contractRoot = path.resolve(import.meta.dirname, "..", "contracts");
    const names = Object.keys(SCHEMA_FILES) as Array<keyof typeof SCHEMA_FILES>;
    const schemas = await Promise.all(names.map((name) => readJson(path.join(contractRoot, `${SCHEMA_FILES[name]}.v1.schema.json`))));
    return Object.fromEntries(names.map((name, index) => [name, ajv.compile(schemas[index]!)])) as Record<keyof typeof SCHEMA_FILES, ValidateFunction>;
  })();
  return validators;
}

function assertSchema(validate: ValidateFunction, value: unknown, label: string): void {
  if (!validate(value)) throw new Error(`${label} does not satisfy its contract: ${JSON.stringify(validate.errors)}`);
}

function assertSelfDigest(value: Record<string, unknown>, field: string, label: string): void {
  const expected = value[field];
  const payload = { ...value };
  delete payload[field];
  if (expected !== digestCanonical(payload)) throw new Error(`${label} self-digest mismatch`);
}

function requiredString(value: Record<string, unknown>, field: string, label: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`${label} is missing ${field}`);
  return candidate;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file} must contain a JSON object`);
  return value as Record<string, unknown>;
}

/** JSON Lines values without shape checks; parseJsonl also requires every line to be an object. */
export function jsonlValues(text: string): Array<Record<string, unknown>> {
  return text.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function parseJsonl(text: string): Array<Record<string, unknown>> {
  const records = jsonlValues(text) as unknown[];
  if (records.some((record) => !record || typeof record !== "object" || Array.isArray(record))) {
    throw new Error("evaluation input must contain one JSON object per line");
  }
  return records as Array<Record<string, unknown>>;
}

export function digestCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function digestRaw(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalArtifact(text: string, format: "json" | "jsonl"): string {
  return canonicalJson(format === "jsonl" ? jsonlValues(text) : JSON.parse(text) as unknown);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("artifact contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("artifact contains a non-serializable value");
}

export function assertInside(root: string, candidate: string, message: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error(message);
}

function resolveInside(root: string, locator: string, label: string): string {
  const resolved = path.resolve(root, locator);
  assertInside(root, resolved, `${label} must stay inside the evaluation cycle`);
  return resolved;
}

export async function exists(target: string): Promise<boolean> {
  return access(target).then(() => true, () => false);
}

// Shared by the record and verify CLIs, which read the same run layouts.

export interface EvaluationRunLayout {
  cycleDirectory: string | null;
  runDirectory: string;
  inputPath: string;
  manifestPath: string;
  selectionPath: string;
  editingPath: string;
  verificationPath: string;
  finalPath: string;
  structured: boolean;
}

/**
 * Parses `<run> <evaluation-root> [cycle-path | --cycle-dir <cycle-path>]` plus the given
 * `--...-digest <sha256:...>` flags; any other argument counts as positional.
 */
export function parseEvaluationRunArguments(cliArgs: string[], digestFlags: string[], usage: string): {
  run: number;
  evaluationRoot: string;
  cycleDirectory: string | null;
  digests: Map<string, string>;
} {
  const positional: string[] = [];
  const digests = new Map<string, string>();
  let flaggedCycle: string | null = null;
  for (let index = 0; index < cliArgs.length; index += 1) {
    const argument = cliArgs[index]!;
    const value = cliArgs[index + 1];
    if (argument === "--cycle-dir") {
      if (!value || value.startsWith("--")) throw new Error("--cycle-dir requires a path");
      flaggedCycle = value;
      index += 1;
    } else if (digestFlags.includes(argument)) {
      if (!value || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`${argument} requires a sha256 digest`);
      digests.set(argument, value);
      index += 1;
    } else {
      positional.push(argument);
    }
  }
  const run = Number(positional[0]);
  const evaluationRoot = positional[1] ? path.resolve(positional[1]) : "";
  const positionalCycle = positional[2] ?? null;
  if (![1, 2, 3].includes(run) || !evaluationRoot || positional.length > 3 || (flaggedCycle && positionalCycle)) {
    throw new Error(usage);
  }
  return { run, evaluationRoot, cycleDirectory: flaggedCycle ?? positionalCycle, digests };
}

/**
 * An explicit cycle must stay inside the evaluation root. Without one, `fallbackCycle`
 * (segments under the root) is used when it exists, and evals/runs otherwise.
 */
export async function resolveEvaluationLayout(
  evaluationRoot: string,
  run: number,
  cycleArgument: string | null,
  fallbackCycle: string[] = [],
): Promise<EvaluationRunLayout> {
  const root = await realpath(evaluationRoot);
  if (cycleArgument) {
    const cycle = await realpath(path.isAbsolute(cycleArgument) ? path.resolve(cycleArgument) : path.resolve(root, cycleArgument));
    assertInside(root, cycle, "cycle directory must be inside the evaluation root");
    return await exists(path.join(cycle, `run-${run}`, "selection.jsonl")) ? legacyLayout(cycle, run) : cycleLayout(cycle, run);
  }
  const defaultCycle = path.join(root, ...fallbackCycle);
  if (fallbackCycle.length > 0 && await exists(defaultCycle)) return cycleLayout(defaultCycle, run);
  return legacyLayout(path.join(root, "evals", "runs"), run);
}

function legacyLayout(legacyBase: string, run: number): EvaluationRunLayout {
  const runDirectory = path.join(legacyBase, `run-${run}`);
  return {
    cycleDirectory: null,
    runDirectory,
    inputPath: path.join(legacyBase, "input.jsonl"),
    manifestPath: path.join(legacyBase, "manifest.json"),
    selectionPath: path.join(runDirectory, "selection.jsonl"),
    editingPath: path.join(runDirectory, "candidate.jsonl"),
    verificationPath: path.join(runDirectory, "verification.jsonl"),
    finalPath: path.join(runDirectory, "final.jsonl"),
    structured: false,
  };
}

function cycleLayout(cycleDirectory: string, run: number): EvaluationRunLayout {
  const runDirectory = path.join(cycleDirectory, "runs", `run-${run}`);
  return {
    cycleDirectory,
    runDirectory,
    inputPath: path.join(cycleDirectory, "input.jsonl"),
    manifestPath: path.join(cycleDirectory, "manifest.json"),
    selectionPath: path.join(runDirectory, "selection-work-product.jsonl"),
    editingPath: path.join(runDirectory, "editing-work-product.jsonl"),
    verificationPath: path.join(runDirectory, "verification-work-product.jsonl"),
    finalPath: path.join(runDirectory, "final.jsonl"),
    structured: true,
  };
}
