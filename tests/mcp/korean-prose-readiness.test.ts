import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  digestCanonical,
  digestRaw,
  evaluateKoreanProseReadiness,
  computeDirectoryChecksum,
  computeKoreanProseToolchainDigest,
  REQUIRED_KOREAN_PROSE_THRESHOLDS,
} from "../../scripts/korean-prose-readiness.js";
import { preflightStructuredKoreanProseEvaluation } from "../../scripts/korean-prose-evaluation-preflight.js";

const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Korean prose evaluation readiness", () => {
  it("reports readiness without confusing it with activation", async () => {
    const cycle = await createReadinessFixture();
    const frame = JSON.parse(await readFile(path.join(cycle, "evaluation-frame.json"), "utf8")) as { frameDigest: string };
    const validity = JSON.parse(await readFile(path.join(cycle, "evaluation-validity-report.json"), "utf8")) as { reportDigest: string };

    await expect(evaluateKoreanProseReadiness(cycle)).resolves.toMatchObject({
      status: "READY_TO_EVALUATE",
      frameId: "0.2.0-private-1",
      qualityEvidencePresent: false,
    });
    await expect(evaluateKoreanProseReadiness(cycle, {
      requireQuality: true,
      expectedFrameDigest: frame.frameDigest,
      expectedValidityReportDigest: validity.reportDigest,
    }))
      .rejects.toThrow("quality-report.json is missing");
  });

  it("applies readiness and no-overwrite checks before a structured model phase", async () => {
    const cycle = await createReadinessFixture();
    const frame = JSON.parse(await readFile(path.join(cycle, "evaluation-frame.json"), "utf8")) as { frameDigest: string };
    const validity = JSON.parse(await readFile(path.join(cycle, "evaluation-validity-report.json"), "utf8")) as { reportDigest: string };

    await expect(preflightStructuredKoreanProseEvaluation("selection", 1, cycle, frame.frameDigest, validity.reportDigest, repositoryRoot)).resolves.toMatchObject({
      status: "READY_TO_EVALUATE",
    });
    const runDirectory = path.join(cycle, "runs", "run-1");
    await expect(readFile(path.join(runDirectory, "evaluation-run-claim.json"), "utf8")).resolves.toContain(validity.reportDigest);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(path.join(runDirectory, "selection-work-product.jsonl"), "{}\n", "utf8");
    await expect(preflightStructuredKoreanProseEvaluation("selection", 1, cycle, frame.frameDigest, validity.reportDigest, repositoryRoot))
      .rejects.toThrow("refusing to overwrite");
  });

  it("fails closed when the frozen corpus changes", async () => {
    const cycle = await createReadinessFixture();
    await writeFile(path.join(cycle, "input.jsonl"), `${JSON.stringify({ id: "case-1", sourceText: "변조된 입력" })}\n`, "utf8");

    await expect(evaluateKoreanProseReadiness(cycle)).rejects.toThrow(/evaluation corpus|quality labels/u);
  });

  it("refuses a lowered release threshold even when frame digests are recomputed", async () => {
    const cycle = await createReadinessFixture({ thresholdOverride: { holdoutImprovementRate: 75 } });

    await expect(evaluateKoreanProseReadiness(cycle)).rejects.toThrow("holdoutImprovementRate must remain 80");
  });

  it("rejects a frame that differs from the external expected digest", async () => {
    const cycle = await createReadinessFixture();

    await expect(evaluateKoreanProseReadiness(cycle, { expectedFrameDigest: `sha256:${"f".repeat(64)}` }))
      .rejects.toThrow("externally expected digest");
  });

  it("rejects a validity report that differs from the external expected digest", async () => {
    const cycle = await createReadinessFixture();

    await expect(evaluateKoreanProseReadiness(cycle, { expectedValidityReportDigest: `sha256:${"f".repeat(64)}` }))
      .rejects.toThrow("validity report does not match the externally expected digest");
  });

  it("rejects nested hidden labels in the model-visible input", async () => {
    const cycle = await createReadinessFixture();
    const visible = { id: "legacy-edit", sourceText: "legacy edit source", metadata: { expectedDecision: "edit" } };
    await writeFile(path.join(cycle, "input.jsonl"), `${JSON.stringify(visible)}\n`, "utf8");

    await expect(evaluateKoreanProseReadiness(cycle)).rejects.toThrow("model-visible evaluation input record does not satisfy its contract");
  });

});

async function createReadinessFixture(options: {
  thresholdOverride?: Partial<Record<keyof typeof REQUIRED_KOREAN_PROSE_THRESHOLDS, number>>;
} = {}): Promise<string> {
  const cycle = await mkdtemp(path.join(tmpdir(), "korean-prose-readiness-"));
  temporaryDirectories.push(cycle);
  const cases = [
    { id: "legacy-edit", suite: "legacy-100", expectedDecision: "edit", sourceText: "legacy edit source" },
    { id: "legacy-retain", suite: "legacy-100", expectedDecision: "retain", sourceText: "legacy retain source" },
    { id: "holdout-edit-1", suite: "holdout-30", expectedDecision: "edit", sourceText: "holdout edit one" },
    { id: "holdout-retain", suite: "holdout-30", expectedDecision: "retain", sourceText: "holdout retain source" },
  ];
  const inputRecords = cases.map(({ id, sourceText }) => ({ id, sourceText }));
  const qualityLabels = cases.map(({ id, suite, expectedDecision }) => ({ id, suite, expectedDecision }));
  const inputText = `${inputRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const thresholds = { ...REQUIRED_KOREAN_PROSE_THRESHOLDS, ...options.thresholdOverride };
  const validityEvidence = `${JSON.stringify({ sourceReview: "fixture", overlapReview: "fixture", strataReview: "fixture" })}\n`;
  const invalidCorpusEvidence = `${JSON.stringify({ schemaVersion: "1.0.0", frameId: "0.1.0-rc1", disposition: "invalid-corpus", status: "terminal" })}\n`;
  const failedRecoveryEvidence = `${JSON.stringify({ schemaVersion: "1.0.0", frameId: "0.1.0-rc2", disposition: "failed-recovery", status: "terminal" })}\n`;
  const suiteRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const integratedSkillChecksum = await computeDirectoryChecksum(path.join(repositoryRoot, "skills", "korean-prose-editor"));
  const framePayload = {
    schemaVersion: "1.0.0",
    frameId: "0.2.0-private-1",
    status: "frozen",
    createdAt: "2026-09-13T00:00:00.000Z",
    candidate: {
      suiteRevision,
      skillSourceCommit: suiteRevision,
      skillSourceChecksum: integratedSkillChecksum,
      integratedSkillChecksum,
      toolchainDigest: await computeKoreanProseToolchainDigest(repositoryRoot),
    },
    corpus: {
      caseCount: inputRecords.length,
      inputDigest: digestCanonical(inputRecords),
      orderedCaseIdsDigest: digestCanonical(inputRecords.map((record) => record.id)),
      labelsLocator: "quality-labels.jsonl",
      labelsDigest: digestCanonical(qualityLabels),
      visibility: "mixed-gate",
      strata: { legacyCount: 2, holdoutCount: 2 },
    },
    controls: {
      rubricLocator: "verification-rubric.md",
      rubricDigest: digestRaw("fixture rubric\n"),
      thresholdsDigest: digestCanonical(thresholds),
      corpusValidityEvidenceDigest: digestRaw(validityEvidence),
    },
    runBudget: 1,
    aggregation: "all-runs-complete",
    thresholds,
    priorFrames: [
      { frameId: "0.1.0-rc1", disposition: "invalid-corpus", evidenceLocator: "prior-invalid-corpus.txt", evidenceDigest: digestRaw(invalidCorpusEvidence) },
      { frameId: "0.1.0-rc2", disposition: "failed-recovery", evidenceLocator: "prior-failed-recovery.txt", evidenceDigest: digestRaw(failedRecoveryEvidence) },
    ],
    executionMetadataSchemaVersion: "3.0.0",
  };
  const frame = { ...framePayload, frameDigest: digestCanonical(framePayload) };
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
    evidence: [{ locator: "validity-evidence.json", digest: digestRaw(validityEvidence), verified: true }],
  };
  const validity = { ...validityPayload, reportDigest: digestCanonical(validityPayload) };
  await Promise.all([
    writeFile(path.join(cycle, "input.jsonl"), inputText, "utf8"),
    writeFile(path.join(cycle, "quality-labels.jsonl"), `${qualityLabels.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8"),
    writeFile(path.join(cycle, "verification-rubric.md"), "fixture rubric\n", "utf8"),
    writeFile(path.join(cycle, "validity-evidence.json"), validityEvidence, "utf8"),
    writeFile(path.join(cycle, "prior-invalid-corpus.txt"), invalidCorpusEvidence, "utf8"),
    writeFile(path.join(cycle, "prior-failed-recovery.txt"), failedRecoveryEvidence, "utf8"),
    writeJson(path.join(cycle, "evaluation-frame.json"), frame),
    writeJson(path.join(cycle, "manifest.json"), {
      schemaVersion: "1.0.0",
      cycleId: frame.frameId,
      frameDigest: frame.frameDigest,
    }),
    writeJson(path.join(cycle, "evaluation-validity-report.json"), validity),
  ]);
  return cycle;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
