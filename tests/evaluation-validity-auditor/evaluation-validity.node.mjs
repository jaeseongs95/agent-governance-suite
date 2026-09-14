import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  analyzeEvaluation,
  digestRequest,
  InputError,
  sha256Canonical,
  validateReport,
} from "../../skills/evaluation-validity-auditor/scripts/core.mjs";
import { makeFixture, makePostFixture, rawDigest } from "./fixture.mjs";

test("pre-execution PASS certifies design readiness only", async () => {
  const { root, base } = await makeFixture();
  const report = await analyzeEvaluation(base, { artifactRoot: root });
  assert.equal(report.verdict, "PASS");
  assert.equal(report.qualifiesAsQualityOrReleaseEvidence, false);
  assert.deepEqual(report.recomputedMetrics, []);
});

test("post-execution PASS recomputes complete denominators", async () => {
  const { root, post, ids } = await makePostFixture();
  const report = await analyzeEvaluation(post, { artifactRoot: root });
  assert.equal(report.verdict, "PASS");
  assert.equal(report.qualifiesAsQualityOrReleaseEvidence, true);
  assert.deepEqual(report.recomputedMetrics.map(({ metricId, numerator, denominator, value }) => ({ metricId, numerator, denominator, value })), [
    { metricId: ids.semanticMetric, numerator: 1, denominator: 4, value: 0.25 },
    { metricId: ids.exactMetric, numerator: 2, denominator: 4, value: 0.5 },
  ]);
});

test("semantic lexical-only and self-report-only criteria fail", async () => {
  const lexical = await makeFixture();
  lexical.base.criteria[0].judgmentMethods = ["lexical-match"];
  assert.ok((await analyzeEvaluation(lexical.base, { artifactRoot: lexical.root })).blockingCodes.includes("SEMANTIC_LEXICAL_ONLY"));
  const selfReport = await makeFixture();
  selfReport.base.criteria[0].judgmentMethods = ["self-report"];
  assert.ok((await analyzeEvaluation(selfReport.base, { artifactRoot: selfReport.root })).blockingCodes.includes("SELF_REPORT_ONLY"));
});

test("deterministic exact matching and supplementary self-report remain valid", async () => {
  const { root, base } = await makeFixture();
  const report = await analyzeEvaluation(base, { artifactRoot: root });
  assert.equal(report.checks.find((item) => item.checkId === "JUDGMENT_METHOD_VALID").status, "PASS");
});

test("missing timing provenance blocks while confirmed post-hoc input fails", async () => {
  const missing = await makeFixture();
  missing.base.artifacts.find((item) => item.role === "rubric").provenance = null;
  assert.equal((await analyzeEvaluation(missing.base, { artifactRoot: missing.root })).verdict, "BLOCKED");
  const posthoc = await makePostFixture();
  posthoc.post.artifacts.find((item) => item.role === "rubric").provenance.observedAt = "2026-01-02T00:00:01Z";
  const failed = await analyzeEvaluation(posthoc.post, { artifactRoot: posthoc.root });
  assert.equal(failed.verdict, "FAIL");
  assert.ok(failed.blockingCodes.includes("POSTHOC_INPUT"));
});

test("malformed JSONL fails without producing aggregate metrics", async () => {
  const { root, post } = await makePostFixture();
  const malformed = '{"schemaVersion":"1.0.0"\n';
  await writeFile(path.join(root, "run-1.jsonl"), malformed, "utf8");
  post.artifacts.find((item) => item.role === "result-records").digest = rawDigest(malformed);
  const report = await analyzeEvaluation(post, { artifactRoot: root });
  assert.equal(report.verdict, "FAIL");
  assert.ok(report.blockingCodes.includes("JSONL_PARSE_FAILED"));
  assert.deepEqual(report.recomputedMetrics, []);
});

test("missing, duplicate, and unknown cases fail complete coverage", async () => {
  for (const [text, code] of [
    ['{"schemaVersion":"1.0.0","caseId":"test:case-0001","split":"validation"}\n', "CASE_MISSING"],
    ['{"schemaVersion":"1.0.0","caseId":"test:case-0001","split":"validation"}\n{"schemaVersion":"1.0.0","caseId":"test:case-0001","split":"holdout"}\n', "CASE_DUPLICATE"],
    ['{"schemaVersion":"1.0.0","caseId":"test:case-0001","split":"validation"}\n{"schemaVersion":"1.0.0","caseId":"test:case-0002","split":"holdout"}\n{"schemaVersion":"1.0.0","caseId":"test:case-unknown","split":"holdout"}\n', "CASE_UNKNOWN"],
  ]) {
    const { root, base } = await makeFixture();
    await writeFile(path.join(root, "fixture-manifest.jsonl"), text, "utf8");
    base.artifacts.find((item) => item.role === "fixture-manifest").digest = rawDigest(text);
    const report = await analyzeEvaluation(base, { artifactRoot: root });
    assert.equal(report.verdict, "FAIL");
    assert.ok(report.blockingCodes.includes(code));
  }
});

test("digest mismatch fails and unreadable required artifacts block", async () => {
  const mismatched = await makeFixture();
  mismatched.base.artifacts.find((item) => item.role === "rubric").digest = rawDigest("changed");
  assert.equal((await analyzeEvaluation(mismatched.base, { artifactRoot: mismatched.root })).verdict, "FAIL");
  const missing = await makeFixture();
  missing.base.artifacts.find((item) => item.role === "rubric").locator = "missing.json";
  assert.equal((await analyzeEvaluation(missing.base, { artifactRoot: missing.root })).verdict, "BLOCKED");
});

test("aggregate mismatch and actor collision fail", async () => {
  const aggregate = await makePostFixture();
  aggregate.post.metrics[0].claimedValue = 0.5;
  assert.ok((await analyzeEvaluation(aggregate.post, { artifactRoot: aggregate.root })).blockingCodes.includes("AGGREGATE_MISMATCH"));
  const actors = await makeFixture();
  actors.base.actors.auditorId = actors.base.actors.executorIds[0];
  assert.ok((await analyzeEvaluation(actors.base, { artifactRoot: actors.root })).blockingCodes.includes("ROLE_CONFLICT"));
});

test("request digest is order-stable and validation detects remapping", async () => {
  const { root, base } = await makeFixture();
  const reordered = Object.fromEntries(Object.entries(base).reverse());
  assert.equal(digestRequest(base).digest, digestRequest(reordered).digest);
  const report = await analyzeEvaluation(base, { artifactRoot: root });
  const envelope = {
    schemaVersion: "1.0.0",
    request: base,
    requestArtifact: { artifactId: "evaluation-validity-request", locator: "artifact://request/evaluation-validity", digest: sha256Canonical(base) },
    report,
  };
  assert.deepEqual(await validateReport(envelope, { artifactRoot: root }), []);
  envelope.report = { ...report, verdict: "FAIL" };
  assert.ok((await validateReport(envelope, { artifactRoot: root })).length > 0);
});

test("artifact traversal and absolute paths are INVALID_INPUT", async () => {
  const { root, base } = await makeFixture();
  base.artifacts[0].locator = "../outside.json";
  await assert.rejects(() => analyzeEvaluation(base, { artifactRoot: root }), InputError);
  base.artifacts[0].locator = path.join(root, "fixture-manifest.jsonl");
  await assert.rejects(() => analyzeEvaluation(base, { artifactRoot: root }), InputError);
});
