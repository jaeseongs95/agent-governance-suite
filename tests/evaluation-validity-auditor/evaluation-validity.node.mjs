import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

test("실행 전 정적 검사가 통과해도 작업자 신원 관찰 불가는 보류한다 (D0336)", async () => {
  const { root, base } = await makeFixture();
  const report = await analyzeEvaluation(base, { artifactRoot: root });
  assert.equal(report.verdict, "BLOCKED");
  assert.equal(report.qualifiesAsQualityOrReleaseEvidence, false);
  assert.deepEqual(report.checks.find(item => item.checkId === "ROLE_INDEPENDENCE"), { checkId: "ROLE_INDEPENDENCE", status: "BLOCKED", code: "PROVENANCE_MISSING", evidenceRefs: [] });
  assert.ok(report.checks.filter(item => item.checkId !== "ROLE_INDEPENDENCE").every(item => item.status === "PASS"));
  assert.deepEqual(report.recomputedMetrics, []);
});

test("신원 관찰이 없어도 실행 후 유효 집계와 원래 분모를 보존한다 (D0336)", async () => {
  const { root, post, ids } = await makePostFixture();
  const report = await analyzeEvaluation(post, { artifactRoot: root });
  assert.equal(report.verdict, "BLOCKED");
  assert.equal(report.qualifiesAsQualityOrReleaseEvidence, false);
  assert.equal(report.checks.find(item => item.checkId === "ROLE_INDEPENDENCE").status, "BLOCKED");
  assert.ok(report.checks.filter(item => item.checkId !== "ROLE_INDEPENDENCE").every(item => item.status === "PASS"));
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

test("서로 다른 새 UUID도 작업자 독립성을 증명하지 못한다 (D0336)", async () => {
  const { root, base } = await makeFixture();
  base.actors = { authorIds: [randomUUID()], executorIds: [randomUUID()], judgeIds: [randomUUID()], auditorId: randomUUID() };
  const report = await analyzeEvaluation(base, { artifactRoot: root });
  assert.equal(report.verdict, "BLOCKED");
  assert.equal(report.qualifiesAsQualityOrReleaseEvidence, false);
  assert.ok(report.blockingCodes.includes("PROVENANCE_MISSING"));
});

test("직접 확인한 역할 충돌은 신원 미관측보다 실패를 우선한다 (D0336)", async () => {
  for (const role of ["authorIds", "executorIds", "judgeIds"]) {
    const { root, base } = await makeFixture();
    base.actors.auditorId = base.actors[role][0];
    const report = await analyzeEvaluation(base, { artifactRoot: root });
    assert.equal(report.verdict, "FAIL");
    assert.equal(report.qualifiesAsQualityOrReleaseEvidence, false);
    assert.equal(report.checks.find(item => item.checkId === "ROLE_INDEPENDENCE").code, "ROLE_CONFLICT");
  }
});

test("출처 한계와 역할 보류를 지우고 digest를 재계산한 PASS도 재검증에서 거부한다 (D0336)", async () => {
  const { root, post } = await makePostFixture();
  const report = await analyzeEvaluation(post, { artifactRoot: root });
  report.verdict = "PASS";
  report.qualifiesAsQualityOrReleaseEvidence = true;
  report.limitations = report.limitations.filter(item => item !== "COOPERATIVE_PROVENANCE_ASSERTIONS");
  report.blockingCodes = [];
  Object.assign(report.checks.find(item => item.checkId === "ROLE_INDEPENDENCE"), { status: "PASS", code: "CHECK_PASSED" });
  const payload = { ...report };
  delete payload.reportDigest;
  report.reportDigest = sha256Canonical(payload);
  const errors = await validateReport({ schemaVersion: "1.0.0", request: post, requestArtifact: { artifactId: "evaluation-validity-request", locator: "artifact://request/evaluation-validity", digest: sha256Canonical(post) }, report }, { artifactRoot: root });
  assert.ok(errors.length > 0);
});
