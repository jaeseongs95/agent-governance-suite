import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  digestCanonical as readinessDigest,
  digestRaw as readinessRawDigest,
  computeDirectoryChecksum,
  computeKoreanProseToolchainDigest,
  evaluateKoreanProseReadiness,
  REQUIRED_KOREAN_PROSE_THRESHOLDS,
} from "../../scripts/korean-prose-readiness.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const recorderPath = fileURLToPath(new URL("../../scripts/record-korean-prose-run.ts", import.meta.url));
const verifierPath = fileURLToPath(new URL("../../scripts/verify-korean-prose-receipt.ts", import.meta.url));
const temporaryDirectories: string[] = [];
const actors = [
  "30000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000002",
  "30000000-0000-4000-8000-000000000003",
] as const;
const qualityAdjudicator = "40000000-0000-4000-8000-000000000001";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("range-aware Korean prose cycle receipts", { timeout: 15_000 }, () => {
  it("records canonical structured work products and binds selection through finalization", async () => {
    const evaluationRoot = await createCycleFixture();
    const positionalCycle = join("evals", "cycles", "0.1.0-rc2");
    const recorded = runScript(recorderPath, ["1", evaluationRoot, positionalCycle]);
    expect(recorded.status, recorded.stderr).toBe(0);

    const runDirectory = join(evaluationRoot, positionalCycle, "runs", "run-1");
    const receiptText = await readFile(join(runDirectory, "workflow-receipt.json"), "utf8");
    const receipt = JSON.parse(receiptText) as {
      plan: { stages: Array<{ requiredCapability: string; requiredInputArtifacts: string[]; inputBindings: Array<{ targetArtifact: string; sources: string[] }> }> };
      stageResults: Array<{
        output: { output: { digest: Record<string, string> } };
        evidence: Array<{ artifactId: string; verified: boolean }>;
      }>;
    };
    const finalIndex = receipt.plan.stages.findIndex((stage) => stage.requiredCapability === "korean-prose-finalization");
    const finalStage = receipt.plan.stages[finalIndex]!;
    expect(finalStage.requiredInputArtifacts).toContain("edit-decision-set");
    expect(finalStage.inputBindings).toContainEqual({
      targetArtifact: "edit-decision-set",
      sources: ["provider:korean-prose-selection.edit-decision-set"],
      operation: "select",
    });
    expect(receipt.stageResults[finalIndex]!.evidence).toContainEqual(expect.objectContaining({
      artifactId: "edit-decision-set",
      verified: true,
    }));

    const editingText = await readFile(join(runDirectory, "editing-work-product.jsonl"), "utf8");
    expect(receipt.stageResults[1]!.output.output.digest.candidate).toBe(canonicalJsonlDigest(editingText));
    expect(receiptText).not.toContain("비공개 원문 sentinel");
    expect(receiptText).not.toContain("비공개 교정문 sentinel");

    const verified = runScript(verifierPath, ["1", evaluationRoot, "--cycle-dir", positionalCycle]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain("bound selection artifact");

    await Promise.all([
      rm(join(runDirectory, "workflow.sqlite3"), { force: true }),
      rm(join(runDirectory, "workflow.sqlite3-shm"), { force: true }),
      rm(join(runDirectory, "workflow.sqlite3-wal"), { force: true }),
    ]);
    const refused = runScript(recorderPath, ["1", evaluationRoot, "--cycle-dir", positionalCycle]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("refusing to overwrite");
    expect(refused.stderr).toContain("workflow-receipt.json");
    expect(await readFile(join(runDirectory, "workflow-receipt.json"), "utf8")).toBe(receiptText);
  });

  it("rejects a cycle work product changed after the receipt was recorded", async () => {
    const evaluationRoot = await createCycleFixture();
    const cycleDirectory = join("evals", "cycles", "0.1.0-rc2");
    const recorded = runScript(recorderPath, ["1", evaluationRoot, "--cycle-dir", cycleDirectory]);
    expect(recorded.status, recorded.stderr).toBe(0);

    const editingPath = join(evaluationRoot, cycleDirectory, "runs", "run-1", "editing-work-product.jsonl");
    const editingRecords = (await readFile(editingPath, "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
    editingRecords[0]!.candidateDigest = "e".repeat(64);
    await writeFile(editingPath, jsonlRecords(editingRecords), "utf8");

    const verified = runScript(verifierPath, ["1", evaluationRoot, "--cycle-dir", cycleDirectory]);
    expect(verified.status).not.toBe(0);
    expect(verified.stderr).toContain("edit-candidate digest does not match its work product");
  });

  it("rejects a cycle directory outside the evaluation root", async () => {
    const evaluationRoot = await createCycleFixture();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "korean-prose-cycle-outside-"));
    temporaryDirectories.push(outsideDirectory);

    const recorded = runScript(recorderPath, ["1", evaluationRoot, "--cycle-dir", outsideDirectory]);
    expect(recorded.status).not.toBe(0);
    expect(recorded.stderr).toContain("cycle directory must be inside the evaluation root");
  });

  it("rejects a structured cycle that omits formal readiness evidence", async () => {
    const evaluationRoot = await createCycleFixture();
    const cycleDirectory = join(evaluationRoot, "evals", "cycles", "0.1.0-rc2");
    await rm(join(cycleDirectory, "evaluation-validity-report.json"));

    const recorded = runScript(recorderPath, ["1", evaluationRoot, "--cycle-dir", cycleDirectory]);
    expect(recorded.status).not.toBe(0);
    await expect(readFile(join(cycleDirectory, "runs", "run-1", "workflow-receipt.json"), "utf8")).rejects.toThrow();
  });

  it("does not silently select the historical cycle when no cycle path is given", async () => {
    const evaluationRoot = await createCycleFixture();

    const recorded = runScript(recorderPath, ["1", evaluationRoot]);
    expect(recorded.status).not.toBe(0);
    expect(recorded.stderr).toContain("manifest.json");
    expect(recorded.stderr).not.toContain("0.1.0-rc2\\runs");
  });

  it("rejects structured run metadata without execution provenance", async () => {
    const evaluationRoot = await createCycleFixture();
    const cycleDirectory = join(evaluationRoot, "evals", "cycles", "0.1.0-rc2");
    const metaPath = join(cycleDirectory, "runs", "run-1", "selection-meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    delete meta.executionProvenance;
    await writeFile(metaPath, JSON.stringify(meta), "utf8");

    const recorded = runScript(recorderPath, ["1", evaluationRoot, "--cycle-dir", cycleDirectory]);
    expect(recorded.status).not.toBe(0);
    expect(recorded.stderr).toContain("not bound to the frozen structured work product");
  });

  it("derives a passing quality decision from the bound final records", async () => {
    const evaluationRoot = await createCycleFixture();
    const cycleDirectory = join(evaluationRoot, "evals", "cycles", "0.1.0-rc2");
    const recorded = runScript(recorderPath, ["1", evaluationRoot, "--cycle-dir", cycleDirectory]);
    expect(recorded.status, recorded.stderr).toBe(0);
    await writeQualityReport(cycleDirectory);

    const frame = JSON.parse(await readFile(join(cycleDirectory, "evaluation-frame.json"), "utf8")) as { frameDigest: string };
    const validity = JSON.parse(await readFile(join(cycleDirectory, "evaluation-validity-report.json"), "utf8")) as { reportDigest: string };
    const quality = JSON.parse(await readFile(join(cycleDirectory, "quality-report.json"), "utf8")) as { reportDigest: string };
    await expect(evaluateKoreanProseReadiness(cycleDirectory, {
      requireQuality: true,
      expectedFrameDigest: frame.frameDigest,
      expectedValidityReportDigest: validity.reportDigest,
      expectedQualityReportDigest: quality.reportDigest,
      evaluationRoot,
    })).resolves.toMatchObject({
      status: "EVALUATION_EVIDENCE_PASSED",
      qualityEvidencePresent: true,
    });
  });

  it("rejects quality evidence when bound final records miss the improvement threshold", async () => {
    const evaluationRoot = await createCycleFixture();
    const cycleDirectory = join(evaluationRoot, "evals", "cycles", "0.1.0-rc2");
    const finalPath = join(cycleDirectory, "runs", "run-1", "final.jsonl");
    const finals = (await readFile(finalPath, "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
    const failed = finals.find((record) => record.id === "holdout-edit")!;
    failed.finalText = "비공개 원문 sentinel holdout edit";
    failed.finalAction = "retain";
    await writeFile(finalPath, jsonlRecords(finals), "utf8");
    const recorded = runScript(recorderPath, ["1", evaluationRoot, "--cycle-dir", cycleDirectory]);
    expect(recorded.status, recorded.stderr).toBe(0);
    await writeQualityReport(cycleDirectory);

    const frame = JSON.parse(await readFile(join(cycleDirectory, "evaluation-frame.json"), "utf8")) as { frameDigest: string };
    const validity = JSON.parse(await readFile(join(cycleDirectory, "evaluation-validity-report.json"), "utf8")) as { reportDigest: string };
    const quality = JSON.parse(await readFile(join(cycleDirectory, "quality-report.json"), "utf8")) as { reportDigest: string };
    await expect(evaluateKoreanProseReadiness(cycleDirectory, {
      requireQuality: true,
      expectedFrameDigest: frame.frameDigest,
      expectedValidityReportDigest: validity.reportDigest,
      expectedQualityReportDigest: quality.reportDigest,
      evaluationRoot,
    }))
      .rejects.toThrow("holdout improvement rate is below");
  });

  it("rejects a label leaked into the independent adjudicator input", async () => {
    const evaluationRoot = await createCycleFixture();
    const cycleDirectory = join(evaluationRoot, "evals", "cycles", "0.1.0-rc2");
    expect(runScript(recorderPath, ["1", evaluationRoot, "--cycle-dir", cycleDirectory]).status).toBe(0);
    await writeQualityReport(cycleDirectory, { leakAdjudicationLabel: true });
    const frame = JSON.parse(await readFile(join(cycleDirectory, "evaluation-frame.json"), "utf8")) as { frameDigest: string };
    const validity = JSON.parse(await readFile(join(cycleDirectory, "evaluation-validity-report.json"), "utf8")) as { reportDigest: string };
    const quality = JSON.parse(await readFile(join(cycleDirectory, "quality-report.json"), "utf8")) as { reportDigest: string };

    await expect(evaluateKoreanProseReadiness(cycleDirectory, {
      requireQuality: true,
      expectedFrameDigest: frame.frameDigest,
      expectedValidityReportDigest: validity.reportDigest,
      expectedQualityReportDigest: quality.reportDigest,
      evaluationRoot,
    })).rejects.toThrow("quality adjudication input record does not satisfy its contract");
  });

  it("does not count an unsafe independently adjudicated edit as an improvement", async () => {
    const evaluationRoot = await createCycleFixture();
    const cycleDirectory = join(evaluationRoot, "evals", "cycles", "0.1.0-rc2");
    expect(runScript(recorderPath, ["1", evaluationRoot, "--cycle-dir", cycleDirectory]).status).toBe(0);
    await writeQualityReport(cycleDirectory, { unsafeCaseId: "holdout-edit" });
    const frame = JSON.parse(await readFile(join(cycleDirectory, "evaluation-frame.json"), "utf8")) as { frameDigest: string };
    const validity = JSON.parse(await readFile(join(cycleDirectory, "evaluation-validity-report.json"), "utf8")) as { reportDigest: string };
    const quality = JSON.parse(await readFile(join(cycleDirectory, "quality-report.json"), "utf8")) as { reportDigest: string };

    await expect(evaluateKoreanProseReadiness(cycleDirectory, {
      requireQuality: true,
      expectedFrameDigest: frame.frameDigest,
      expectedValidityReportDigest: validity.reportDigest,
      expectedQualityReportDigest: quality.reportDigest,
      evaluationRoot,
    })).rejects.toThrow("holdout improvement rate is below");
  });

  it("rejects a start claim and role metadata replaced after the workflow receipt was finalized", async () => {
    const evaluationRoot = await createCycleFixture();
    const cycleDirectory = join(evaluationRoot, "evals", "cycles", "0.1.0-rc2");
    expect(runScript(recorderPath, ["1", evaluationRoot, "--cycle-dir", cycleDirectory]).status).toBe(0);
    const claimPath = join(cycleDirectory, "runs", "run-1", "evaluation-run-claim.json");
    const claim = JSON.parse(await readFile(claimPath, "utf8")) as Record<string, unknown>;
    claim.startedAt = "2020-01-01T00:03:30.000Z";
    const replacementClaimText = JSON.stringify(claim);
    await writeFile(claimPath, replacementClaimText, "utf8");
    for (const role of ["selection", "editing", "verification"]) {
      const metaPath = join(cycleDirectory, "runs", "run-1", `${role}-meta.json`);
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
      meta.startClaimSha256 = sha256(replacementClaimText);
      await writeFile(metaPath, JSON.stringify(meta), "utf8");
    }
    await writeQualityReport(cycleDirectory);
    const frame = JSON.parse(await readFile(join(cycleDirectory, "evaluation-frame.json"), "utf8")) as { frameDigest: string };
    const validity = JSON.parse(await readFile(join(cycleDirectory, "evaluation-validity-report.json"), "utf8")) as { reportDigest: string };
    const quality = JSON.parse(await readFile(join(cycleDirectory, "quality-report.json"), "utf8")) as { reportDigest: string };

    await expect(evaluateKoreanProseReadiness(cycleDirectory, {
      requireQuality: true,
      expectedFrameDigest: frame.frameDigest,
      expectedValidityReportDigest: validity.reportDigest,
      expectedQualityReportDigest: quality.reportDigest,
      evaluationRoot,
    })).rejects.toThrow("receipt binding does not bind");
  });
});

async function writeQualityReport(
  cycleDirectory: string,
  options: { leakAdjudicationLabel?: boolean; unsafeCaseId?: string } = {},
): Promise<void> {
  const frame = JSON.parse(await readFile(join(cycleDirectory, "evaluation-frame.json"), "utf8")) as {
    frameId: string;
    frameDigest: string;
    controls: { rubricDigest: string };
    corpus: { caseCount: number };
  };
  const receiptPath = join(cycleDirectory, "runs", "run-1", "workflow-receipt.json");
  const receiptText = await readFile(receiptPath, "utf8");
  const receiptDigest = readinessRawDigest(receiptText);
  const claimDigest = readinessRawDigest(await readFile(join(cycleDirectory, "runs", "run-1", "evaluation-run-claim.json")));
  const inputs = (await readFile(join(cycleDirectory, "input.jsonl"), "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line) as { id: string; sourceText: string });
  const finals = (await readFile(join(cycleDirectory, "runs", "run-1", "final.jsonl"), "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line) as { id: string; finalText: string; finalAction: string });
  const inputById = new Map(inputs.map((record) => [record.id, record]));
  const adjudicationInputs = finals.map((record) => ({
    schemaVersion: "1.0.0",
    run: 1,
    caseId: record.id,
    sourceText: inputById.get(record.id)!.sourceText,
    finalText: record.finalText,
    ...(options.leakAdjudicationLabel ? { expectedDecision: "edit" } : {}),
  }));
  const adjudications = finals.map((record, index) => ({
    schemaVersion: "1.0.0",
    run: 1,
    caseId: record.id,
    adjudicatorActorId: qualityAdjudicator,
    receiptDigest,
    sourceDigest: readinessRawDigest(adjudicationInputs[index]!.sourceText),
    finalDigest: readinessRawDigest(adjudicationInputs[index]!.finalText),
    rubricDigest: frame.controls.rubricDigest,
    meaningPreservation: record.id === options.unsafeCaseId ? "fail" : "pass",
    majorMeaningChange: false,
    registerCompliance: "pass",
    protectedStrings: "pass",
    terminologyJudgment: "not-applicable",
    pairPreference: record.finalAction === "edit" ? "candidate" : "tie",
  }));
  const adjudicationInputText = jsonlRecords(adjudicationInputs);
  const adjudicationText = jsonlRecords(adjudications);
  const adjudicationMeta = {
    schemaVersion: "1.0.0",
    actorId: qualityAdjudicator,
    status: "complete",
    completedAt: "2020-01-01T00:04:00.000Z",
    inputDigest: readinessDigest(adjudicationInputs),
    workProductDigest: readinessDigest(adjudications),
    containsExpectedDecision: false,
    containsSuiteLabel: false,
    executionProvenance: {
      requestedModel: "fixture-adjudicator",
      actualModel: "fixture-adjudicator",
      provider: "fixture-provider",
      providerVersion: "1.0.0",
      promptSha256: "d".repeat(64),
      seed: "unverified",
      decodingParametersSha256: "unverified",
    },
  };
  const adjudicationMetaText = `${JSON.stringify(adjudicationMeta)}\n`;
  await Promise.all([
    writeFile(join(cycleDirectory, "quality-adjudication-input.jsonl"), adjudicationInputText, "utf8"),
    writeFile(join(cycleDirectory, "quality-adjudication.jsonl"), adjudicationText, "utf8"),
    writeFile(join(cycleDirectory, "quality-adjudication-meta.json"), adjudicationMetaText, "utf8"),
  ]);
  const qualityPayload = {
    schemaVersion: "1.0.0",
    frameId: frame.frameId,
    frameDigest: frame.frameDigest,
    rubricDigest: frame.controls.rubricDigest,
    adjudicatorActorId: qualityAdjudicator,
    adjudicationInputLocator: "quality-adjudication-input.jsonl",
    adjudicationInputDigest: readinessDigest(adjudicationInputs),
    adjudicationMetaLocator: "quality-adjudication-meta.json",
    adjudicationMetaDigest: readinessRawDigest(adjudicationMetaText),
    adjudicationLocator: "quality-adjudication.jsonl",
    adjudicationDigest: readinessDigest(adjudications),
    runCount: 1,
    runs: [{
      run: 1,
      receiptLocator: join("runs", "run-1", "workflow-receipt.json"),
      receiptDigest,
      claimDigest,
      actorIds: actors,
      caseCount: frame.corpus.caseCount,
      complete: true,
    }],
  };
  await writeFile(join(cycleDirectory, "quality-report.json"), JSON.stringify({
    ...qualityPayload,
    reportDigest: readinessDigest(qualityPayload),
  }), "utf8");
}

async function createCycleFixture(): Promise<string> {
  const evaluationRoot = await mkdtemp(join(tmpdir(), "korean-prose-cycle-receipt-"));
  temporaryDirectories.push(evaluationRoot);
  const cycleDirectory = join(evaluationRoot, "evals", "cycles", "0.1.0-rc2");
  const runDirectory = join(cycleDirectory, "runs", "run-1");
  const rubricPath = join(evaluationRoot, "skills", "korean-prose-editor", "references", "verification-rubric.md");
  await mkdir(runDirectory, { recursive: true });
  await mkdir(join(evaluationRoot, "skills"), { recursive: true });
  await cp(join(repositoryRoot, "skills", "korean-prose-editor"), join(evaluationRoot, "skills", "korean-prose-editor"), { recursive: true });
  const rubricText = await readFile(rubricPath, "utf8");
  const inputRecords = [
    { id: "legacy-edit", suite: "legacy-100", expectedDecision: "edit", sourceText: "비공개 원문 sentinel legacy edit" },
    { id: "legacy-retain", suite: "legacy-100", expectedDecision: "retain", sourceText: "비공개 원문 sentinel legacy retain" },
    { id: "holdout-edit", suite: "holdout-30", expectedDecision: "edit", sourceText: "비공개 원문 sentinel holdout edit" },
    { id: "holdout-retain", suite: "holdout-30", expectedDecision: "retain", sourceText: "비공개 원문 sentinel holdout retain" },
  ];
  const visibleInputRecords = inputRecords.map(({ id, sourceText }) => ({ id, sourceText }));
  const qualityLabels = inputRecords.map(({ id, suite, expectedDecision }) => ({ id, suite, expectedDecision }));
  const inputText = jsonlRecords(visibleInputRecords);
  const invalidCorpusEvidence = `${JSON.stringify({ schemaVersion: "1.0.0", frameId: "0.1.0-rc1", disposition: "invalid-corpus", status: "terminal" })}\n`;
  const failedRecoveryEvidence = `${JSON.stringify({ schemaVersion: "1.0.0", frameId: "0.1.0-rc2", disposition: "failed-recovery", status: "terminal" })}\n`;
  const framePayload = {
    schemaVersion: "1.0.0",
    frameId: "0.2.0-private-fixture",
    status: "frozen",
    createdAt: "2026-09-13T00:00:00.000Z",
    candidate: {
      suiteRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
      skillSourceCommit: "c5df63749e2edfc8aa424f9935ee3cd4697d3c49",
      skillSourceChecksum: "sha256:a88252aa9c4e654458ecc7eed282d26c022ca9f5db858f87f3237decc622feb8",
      integratedSkillChecksum: await computeDirectoryChecksum(join(evaluationRoot, "skills", "korean-prose-editor")),
      toolchainDigest: await computeKoreanProseToolchainDigest(repositoryRoot),
    },
    corpus: {
      caseCount: inputRecords.length,
      inputDigest: readinessDigest(visibleInputRecords),
      orderedCaseIdsDigest: readinessDigest(inputRecords.map((record) => record.id)),
      labelsLocator: "quality-labels.jsonl",
      labelsDigest: readinessDigest(qualityLabels),
      visibility: "mixed-gate",
      strata: { legacyCount: 2, holdoutCount: 2 },
    },
    controls: {
      rubricLocator: "verification-rubric.md",
      rubricDigest: readinessRawDigest(rubricText),
      thresholdsDigest: readinessDigest(REQUIRED_KOREAN_PROSE_THRESHOLDS),
      corpusValidityEvidenceDigest: readinessRawDigest("fixture validity evidence\n"),
    },
    runBudget: 1,
    aggregation: "all-runs-complete",
    thresholds: REQUIRED_KOREAN_PROSE_THRESHOLDS,
    priorFrames: [
      { frameId: "0.1.0-rc1", disposition: "invalid-corpus", evidenceLocator: "prior-invalid-corpus.txt", evidenceDigest: readinessRawDigest(invalidCorpusEvidence) },
      { frameId: "0.1.0-rc2", disposition: "failed-recovery", evidenceLocator: "prior-failed-recovery.txt", evidenceDigest: readinessRawDigest(failedRecoveryEvidence) },
    ],
    executionMetadataSchemaVersion: "3.0.0",
  };
  const frame = { ...framePayload, frameDigest: readinessDigest(framePayload) };
  const validityPayload = {
    schemaVersion: "1.0.0",
    frameId: frame.frameId,
    frameDigest: frame.frameDigest,
    corpusDigest: frame.corpus.inputDigest,
    status: "valid",
    auditedAt: "2020-01-01T00:01:00.000Z",
    executionStartedAt: "2020-01-01T00:02:00.000Z",
    actors: {
      author: "10000000-0000-4000-8000-000000000001",
      auditor: "10000000-0000-4000-8000-000000000002",
      adjudicator: "10000000-0000-4000-8000-000000000003",
    },
    checks: {
      sourceAuthoritative: true,
      noDuplicateCases: true,
      noCorpusOverlap: true,
      strataComplete: true,
      auditedBeforeExecution: true,
    },
    strataCounts: frame.corpus.strata,
    evidence: [{ locator: "validity-evidence.json", digest: readinessRawDigest("fixture validity evidence\n"), verified: true }],
  };
  const selectionRecords = inputRecords.map((record) => {
    const edited = record.expectedDecision === "edit";
    return {
      schemaVersion: "1.0.0",
      actorId: actors[0],
      sourceDigest: sha256(record.sourceText),
      status: "ready",
      decisions: [{
        unitId: "unit-0001",
        action: edited ? "edit" : "retain",
        reasonCodes: edited ? ["TRANSLATIONESE"] : [],
        riskFlags: [],
        additionalProtectedStrings: [],
        issueRanges: edited ? [{ start: 0, end: 1, reasonCode: "TRANSLATIONESE" }] : [],
      }],
    };
  });
  const editingRecords = inputRecords.map((record, index) => {
    const edited = record.expectedDecision === "edit";
    return {
      schemaVersion: "1.0.0",
      actorId: actors[1],
      sourceDigest: sha256(record.sourceText),
      selectionDigest: readinessDigest(selectionRecords[index]).slice("sha256:".length),
      edits: edited ? [{
        id: `edit-${record.id}`,
        unitId: "unit-0001",
        sourceDigest: sha256(record.sourceText),
        start: 0,
        end: 1,
        replacement: `${record.sourceText[0]} 개선`,
        actorId: actors[1],
      }] : [],
      candidateDigest: sha256(edited ? `${record.sourceText} 개선` : record.sourceText),
    };
  });
  const verificationRecords = inputRecords.map((record, index) => {
    const edited = record.expectedDecision === "edit";
    return {
      schemaVersion: "1.0.0",
      actorId: actors[2],
      sourceDigest: sha256(record.sourceText),
      editingDigest: readinessDigest(editingRecords[index]).slice("sha256:".length),
      rubricDigest: readinessRawDigest(rubricText).slice("sha256:".length),
      globalDecision: "continue",
      decisions: edited ? [{
        editId: `edit-${record.id}`,
        decision: "accept",
        reasonCode: "MEANING_PRESERVED",
        sourceDefect: "TRANSLATIONESE",
        invariantDelta: "NONE",
      }] : [],
      assessment: {
        meaningPreservation: "pass",
        majorMeaningChange: false,
        registerCompliance: "pass",
        protectedStrings: "pass",
        terminologyJudgment: "not-applicable",
        pairPreference: edited ? "candidate" : "tie",
      },
    };
  });
  const files = new Map<string, string>([
    [join(cycleDirectory, "input.jsonl"), inputText],
    [join(cycleDirectory, "quality-labels.jsonl"), jsonlRecords(qualityLabels)],
    [join(cycleDirectory, "manifest.json"), JSON.stringify({ schemaVersion: "1.0.0", cycleId: frame.frameId, frameDigest: frame.frameDigest })],
    [join(cycleDirectory, "evaluation-frame.json"), JSON.stringify(frame)],
    [join(cycleDirectory, "evaluation-validity-report.json"), JSON.stringify({
      ...validityPayload,
      reportDigest: readinessDigest(validityPayload),
    })],
    [join(cycleDirectory, "verification-rubric.md"), rubricText],
    [join(cycleDirectory, "validity-evidence.json"), "fixture validity evidence\n"],
    [join(cycleDirectory, "prior-invalid-corpus.txt"), invalidCorpusEvidence],
    [join(cycleDirectory, "prior-failed-recovery.txt"), failedRecoveryEvidence],
    [join(runDirectory, "selection-work-product.jsonl"), jsonlRecords(selectionRecords)],
    [join(runDirectory, "editing-work-product.jsonl"), jsonlRecords(editingRecords)],
    [join(runDirectory, "verification-work-product.jsonl"), jsonlRecords(verificationRecords)],
    [join(runDirectory, "final.jsonl"), jsonlRecords(inputRecords.map((record) => {
      const edited = record.expectedDecision === "edit";
      return {
        id: record.id,
        finalText: edited ? `${record.sourceText} 개선` : record.sourceText,
        finalAction: edited ? "edit" : "retain",
        protectedStrings: [],
      };
    }))],
    [join(runDirectory, "selection-meta.json"), JSON.stringify({ actorId: actors[0] })],
    [join(runDirectory, "editing-meta.json"), JSON.stringify({ actorId: actors[1] })],
    [join(runDirectory, "verification-meta.json"), JSON.stringify({ actorId: actors[2] })],
    [join(runDirectory, "metrics.json"), JSON.stringify({
      schemaVersion: "1.0.0",
      actorIds: actors,
      counts: { proposedEdits: 1, acceptedEdits: 1, retainedEdits: 0 },
    })],
    [join(runDirectory, "evaluation-run-claim.json"), JSON.stringify({
      schemaVersion: "1.0.0",
      frameId: frame.frameId,
      frameDigest: frame.frameDigest,
      validityReportDigest: readinessDigest(validityPayload),
      run: 1,
      startedAt: "2020-01-01T00:03:00.000Z",
    })],
  ]);
  await Promise.all([...files].map(([filename, contents]) => writeFile(filename, contents, "utf8")));
  const [selectionText, editingText, verificationText, startClaimText] = await Promise.all([
    readFile(join(runDirectory, "selection-work-product.jsonl"), "utf8"),
    readFile(join(runDirectory, "editing-work-product.jsonl"), "utf8"),
    readFile(join(runDirectory, "verification-work-product.jsonl"), "utf8"),
    readFile(join(runDirectory, "evaluation-run-claim.json"), "utf8"),
  ]);
  const startClaimSha256 = sha256(startClaimText);
  await Promise.all([
    writeFile(join(runDirectory, "selection-meta.json"), JSON.stringify(runMeta("selection", actors[0], canonicalJsonlDigest(inputText), canonicalJsonlDigest(selectionText), startClaimSha256)), "utf8"),
    writeFile(join(runDirectory, "editing-meta.json"), JSON.stringify(runMeta("editing", actors[1], canonicalJsonlDigest(inputText), canonicalJsonlDigest(editingText), startClaimSha256)), "utf8"),
    writeFile(join(runDirectory, "verification-meta.json"), JSON.stringify(runMeta("verification", actors[2], canonicalJsonlDigest(inputText), canonicalJsonlDigest(verificationText), startClaimSha256)), "utf8"),
  ]);
  return evaluationRoot;
}

function runMeta(
  role: string,
  actorId: string,
  inputSha256: string,
  workProductSha256: string,
  startClaimSha256: string,
): Record<string, unknown> {
  return {
    schemaVersion: "3.0.0",
    run: 1,
    role,
    actorId,
    caseCount: 4,
    inputSha256,
    workProductSha256,
    startClaimSha256,
    status: "complete",
    executionProvenance: {
      requestedModel: "fixture-model",
      actualModel: "fixture-model",
      provider: "fixture-provider",
      providerVersion: "1.0.0",
      promptSha256: "e".repeat(64),
      seed: "unverified",
      decodingParametersSha256: "unverified",
    },
  };
}

function runScript(scriptPath: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const effectiveArgs = [...args];
  if ((scriptPath === recorderPath || scriptPath === verifierPath) && !effectiveArgs.includes("--expected-frame-digest")) {
    const cycleFlag = effectiveArgs.indexOf("--cycle-dir");
    const cycleArgument = cycleFlag >= 0 ? effectiveArgs[cycleFlag + 1] : effectiveArgs[2];
    if (cycleArgument) {
      const evaluationRoot = effectiveArgs[1]!;
      const cyclePath = isAbsolute(cycleArgument) ? cycleArgument : join(evaluationRoot, cycleArgument);
      const framePath = join(cyclePath, "evaluation-frame.json");
      if (existsSync(framePath)) {
        const frame = JSON.parse(readFileSync(framePath, "utf8")) as { frameDigest: string };
        effectiveArgs.push("--expected-frame-digest", frame.frameDigest);
        const validityPath = join(cyclePath, "evaluation-validity-report.json");
        if (existsSync(validityPath)) {
          const validity = JSON.parse(readFileSync(validityPath, "utf8")) as { reportDigest: string };
          effectiveArgs.push("--expected-validity-report-digest", validity.reportDigest);
        }
      }
    }
  }
  const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...effectiveArgs], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function jsonlRecords(values: unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonlDigest(text: string): string {
  const records = text.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as unknown);
  return createHash("sha256").update(canonicalJson(records)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
