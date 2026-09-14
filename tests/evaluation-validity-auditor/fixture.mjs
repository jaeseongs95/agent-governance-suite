import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const actor = {
  author: "11111111-1111-4111-8111-111111111111",
  executor: "22222222-2222-4222-8222-222222222222",
  judge: "33333333-3333-4333-8333-333333333333",
  auditor: "44444444-4444-4444-8444-444444444444",
};

export const rawDigest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function artifact(artifactId, role, locator, digest, mediaType, visibleToRoles, availableAt = "2025-12-31T20:00:00Z") {
  return {
    artifactId,
    role,
    locator,
    digest,
    mediaType,
    availableAt,
    visibleToRoles,
    provenance: {
      source: "trusted-system",
      observedAt: availableAt,
      evidenceRefs: [`artifact:receipt-${artifactId.slice("artifact:".length)}`],
    },
  };
}

function result(caseId, runId, criterionId, outcome, judgeActorId, judgmentMethod, evidenceRef) {
  return {
    schemaVersion: "1.0.0",
    caseId,
    runId,
    criterionId,
    outcome,
    value: null,
    judgeActorId,
    judgmentMethod,
    evidenceRefs: [evidenceRef],
  };
}

export async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "evaluation-validity-suite-"));
  const ids = {
    manifest: "artifact:fixture-manifest",
    rubric: "artifact:frozen-rubric",
    oracle: "artifact:frozen-oracle",
    aggregation: "artifact:aggregation-rule",
    timing: "artifact:timing-evidence",
    evidence: "artifact:independent-evidence",
    caseOne: "test:case-0001",
    caseTwo: "test:case-0002",
    runOne: "run:evaluation-0001",
    runTwo: "run:evaluation-0002",
    semantic: "test:semantic-quality",
    exact: "test:exact-output",
    semanticMetric: "test:semantic-pass-rate",
    exactMetric: "test:exact-pass-rate",
  };
  const contents = new Map([
    ["manifest", `${JSON.stringify({ schemaVersion: "1.0.0", caseId: ids.caseOne, split: "validation" })}\n${JSON.stringify({ schemaVersion: "1.0.0", caseId: ids.caseTwo, split: "holdout" })}\n`],
    ["rubric", JSON.stringify({ schemaVersion: "1.0.0", criteria: [ids.semantic, ids.exact] })],
    ["oracle", JSON.stringify({ schemaVersion: "1.0.0", kinds: ["independent-review", "lexical-match"] })],
    ["aggregation", JSON.stringify({ schemaVersion: "1.0.0", denominator: "all-expected-records", metricIds: [ids.semanticMetric, ids.exactMetric] })],
    ["timing", JSON.stringify({ schemaVersion: "1.0.0", receipt: "frozen-before-execution" })],
    ["evidence", JSON.stringify({ schemaVersion: "1.0.0", source: "independent-review" })],
  ]);
  const filenames = {
    manifest: "fixture-manifest.jsonl",
    rubric: "rubric.json",
    oracle: "oracle.json",
    aggregation: "aggregation.json",
    timing: "timing.json",
    evidence: "evidence.json",
  };
  for (const [id, value] of contents) await writeFile(path.join(root, filenames[id]), value, "utf8");
  const digest = Object.fromEntries([...contents].map(([id, value]) => [id, rawDigest(value)]));
  const base = {
    schemaVersion: "1.0.0",
    auditId: "55555555-5555-4555-8555-555555555555",
    auditStage: "pre-execution",
    auditedAt: "2026-01-01T00:00:00Z",
    target: {
      evaluationId: "run:evaluation-target",
      identifier: "artifact:evaluation-target",
      revision: "commit:abcdef12",
      digest: rawDigest("candidate-v1"),
    },
    frozenAt: "2025-12-31T22:00:00Z",
    executionStartedAt: "2026-01-02T00:00:00Z",
    actors: {
      authorIds: [actor.author],
      executorIds: [actor.executor],
      judgeIds: [actor.judge],
      auditorId: actor.auditor,
    },
    artifacts: [
      artifact(ids.manifest, "fixture-manifest", filenames.manifest, digest.manifest, "jsonl", ["author", "executor", "judge", "auditor"]),
      artifact(ids.rubric, "rubric", filenames.rubric, digest.rubric, "json", ["author", "executor", "judge", "auditor"]),
      artifact(ids.oracle, "oracle", filenames.oracle, digest.oracle, "json", ["judge", "auditor"]),
      artifact(ids.aggregation, "aggregation-rule", filenames.aggregation, digest.aggregation, "json", ["author", "auditor"]),
      artifact(ids.timing, "timing-evidence", filenames.timing, digest.timing, "json", ["auditor"]),
      artifact(ids.evidence, "evidence", filenames.evidence, digest.evidence, "json", ["judge", "auditor"]),
    ],
    expected: {
      caseIds: [ids.caseOne, ids.caseTwo],
      runIds: [ids.runOne, ids.runTwo],
      criterionIds: [ids.semantic, ids.exact],
    },
    criteria: [
      { criterionId: ids.semantic, kind: "semantic", judgmentMethods: ["independent-review", "self-report"], oracleArtifactId: ids.oracle, evidenceRefs: [ids.evidence] },
      { criterionId: ids.exact, kind: "deterministic", judgmentMethods: ["lexical-match"], oracleArtifactId: ids.oracle, evidenceRefs: [ids.oracle] },
    ],
    metrics: [
      { metricId: ids.semanticMetric, criterionId: ids.semantic, operation: "rate", denominator: "all-expected-records", numeratorOutcomes: ["PASS"], comparator: ">=", threshold: 0.25, claimedValue: null },
      { metricId: ids.exactMetric, criterionId: ids.exact, operation: "rate", denominator: "all-expected-records", numeratorOutcomes: ["PASS"], comparator: ">=", threshold: 0.5, claimedValue: null },
    ],
    runs: [],
    knownLimitations: [],
  };
  return { root, base, digest, actor, ids };
}

export async function makePostFixture() {
  const fixture = await makeFixture();
  const { ids } = fixture;
  const records = [
    result(ids.caseOne, ids.runOne, ids.semantic, "PASS", fixture.actor.judge, "independent-review", ids.evidence),
    result(ids.caseOne, ids.runOne, ids.exact, "PASS", fixture.actor.judge, "lexical-match", ids.oracle),
    result(ids.caseTwo, ids.runOne, ids.semantic, "FAIL", fixture.actor.judge, "independent-review", ids.evidence),
    result(ids.caseTwo, ids.runOne, ids.exact, "PASS", fixture.actor.judge, "lexical-match", ids.oracle),
  ];
  const resultText = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const metrics = [
    { metricId: ids.semanticMetric, numerator: 1, denominator: 4, value: 0.25, comparator: ">=", threshold: 0.25, passed: true },
    { metricId: ids.exactMetric, numerator: 2, denominator: 4, value: 0.5, comparator: ">=", threshold: 0.5, passed: true },
  ];
  const aggregateText = JSON.stringify({ schemaVersion: "1.0.0", evaluationId: fixture.base.target.evaluationId, targetDigest: fixture.base.target.digest, metrics });
  await writeFile(path.join(fixture.root, "run-1.jsonl"), resultText, "utf8");
  await writeFile(path.join(fixture.root, "aggregate.json"), aggregateText, "utf8");
  const post = structuredClone(fixture.base);
  post.auditId = "66666666-6666-4666-8666-666666666666";
  post.auditStage = "post-execution";
  post.auditedAt = "2026-01-03T00:00:00Z";
  post.metrics[0].claimedValue = 0.25;
  post.metrics[1].claimedValue = 0.5;
  post.artifacts.push(
    artifact("artifact:run-0001-results", "result-records", "run-1.jsonl", rawDigest(resultText), "jsonl", ["judge", "auditor"], "2026-01-02T01:00:00Z"),
    artifact("artifact:aggregate-claim", "aggregate-claim", "aggregate.json", rawDigest(aggregateText), "json", ["auditor"], "2026-01-02T02:00:00Z"),
  );
  post.runs = [
    { runId: ids.runOne, status: "completed", resultArtifactId: "artifact:run-0001-results" },
    { runId: ids.runTwo, status: "failed", resultArtifactId: null },
  ];
  return { ...fixture, post, resultText };
}
