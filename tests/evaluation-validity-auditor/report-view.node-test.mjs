import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { analyzeEvaluation, sha256Canonical } from "../../skills/evaluation-validity-auditor/scripts/core.mjs";
import { makeFixture, makePostFixture, rawDigest } from "./fixture.mjs";

const suiteRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = (suite, script) => path.join(suite, "skills/evaluation-validity-auditor/scripts", script);
const execute = (script, args, suite = suiteRoot) => spawnSync(process.execPath, [scriptPath(suite, script), ...args], {
  encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024,
});

async function prepare(t, post = true) {
  const fixture = await (post ? makePostFixture() : makeFixture());
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const request = post ? fixture.post : fixture.base;
  const input = path.join(fixture.root, "request.json");
  await writeFile(input, JSON.stringify(request), "utf8");
  return { ...fixture, request, input };
}

const auditArgs = f => ["--input", f.input, "--artifact-root", f.root];

async function validationArgs(f, report) {
  const reportFile = path.join(f.root, "report.json");
  const requestArtifact = path.join(f.root, "request-artifact.json");
  await writeFile(reportFile, JSON.stringify(report), "utf8");
  await writeFile(requestArtifact, JSON.stringify({
    artifactId: "evaluation-validity-request", locator: "artifact://request/evaluation-validity", digest: sha256Canonical(f.request),
  }), "utf8");
  return ["--request", f.input, "--request-artifact", requestArtifact, "--report", reportFile, "--artifact-root", f.root];
}

test("GOV07 human CLI explains the same report without changing identity, denominator or JSON", async t => {
  const f = await prepare(t);
  const json = execute("cli.mjs", auditArgs(f));
  assert.equal(json.status, 0, json.stderr);
  const expected = await analyzeEvaluation(f.request, { artifactRoot: f.root });
  assert.equal(json.stdout, `${JSON.stringify(expected, null, 2)}\n`);
  const human = execute("cli.mjs", [...auditArgs(f), "--format", "human-ko"]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /결론: 통과 \(PASS\), 실행 후 평가 유효성/);
  for (const label of ["이유:", "검증 범위:", "한계:", "실제 신원을 인증하지 않았습니다", "대상 소스를 별도로 검증하지 않았습니다"]) assert.ok(human.stdout.includes(label), label);
  assert.match(human.stdout, /결과 레코드 관측 4 \/ 예정 8/);
  assert.match(human.stdout, /분자 1, 분모 4, 값 0\.25/);
  assert.match(human.stdout, /분자 2, 분모 4, 값 0\.5/);
  assert.match(human.stdout, /실패·시간초과 실행도 원래 분모에 포함/);
  for (const id of [expected.auditId, expected.target.evaluationId, expected.target.identifier, expected.target.digest, expected.requestDigest, expected.reportDigest, f.ids.evidence]) assert.ok(human.stdout.includes(id), id);
  assert.equal(execute("cli.mjs", auditArgs(f)).stdout, json.stdout);
  const validation = execute("validate-report.mjs", [...await validationArgs(f, expected), "--format", "human-ko"]);
  assert.equal(validation.status, 0, validation.stdout + validation.stderr);
  assert.match(validation.stdout, /보고서 검증: 통과/);
  assert.ok(validation.stdout.endsWith(human.stdout));
});

test("GOV07 pre-execution PASS cannot claim checked results or quality evidence", async t => {
  const f = await prepare(t, false);
  const result = execute("cli.mjs", [...auditArgs(f), "--format", "human-ko"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /결론: 통과 \(PASS\), 실행 전 설계 준비/);
  assert.match(result.stdout, /실행 결과와 집계는 이 단계에서 검사하지 않았습니다/);
  assert.match(result.stdout, /품질·릴리스 판단의 결과 근거로 사용할 수 없습니다/);
  assert.doesNotMatch(result.stdout, /공개 집계와 재계산 결과의 일치: 통과/);
});

test("GOV07 FAIL and BLOCKED remain distinct and explain their actual cause", async t => {
  const f = await prepare(t, false);
  f.request.criteria[0].judgmentMethods = ["self-report"];
  await writeFile(f.input, JSON.stringify(f.request), "utf8");
  const failed = execute("cli.mjs", [...auditArgs(f), "--format", "human-ko"]);
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.stdout, /결론: 실패 \(FAIL\)/);
  assert.match(failed.stdout, /자기보고만으로 판정했습니다.*SELF_REPORT_ONLY/);
  assert.match(failed.stdout, /결과 근거로 사용할 수 없습니다/);
  f.request.criteria[0].judgmentMethods = ["independent-review", "self-report"];
  f.request.artifacts.find(a => a.role === "rubric").provenance = null;
  await writeFile(f.input, JSON.stringify(f.request), "utf8");
  const blocked = execute("cli.mjs", [...auditArgs(f), "--format", "human-ko"]);
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.match(blocked.stdout, /결론: 판정 보류 \(BLOCKED\)/);
  assert.match(blocked.stdout, /출처 또는 시점 증거가 부족합니다.*PROVENANCE_MISSING/);
});

test("GOV07 missing results never become an aggregate or a quality PASS", async t => {
  const f = await prepare(t);
  const text = f.resultText.trim().split("\n").slice(1).join("\n") + "\n";
  await writeFile(path.join(f.root, "run-1.jsonl"), text, "utf8");
  f.request.artifacts.find(a => a.role === "result-records").digest = rawDigest(text);
  await writeFile(f.input, JSON.stringify(f.request), "utf8");
  const result = execute("cli.mjs", [...auditArgs(f), "--format", "human-ko"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /결론: 실패 \(FAIL\)/);
  assert.match(result.stdout, /필수 결과가 누락됐습니다.*RESULT_MISSING/);
  assert.match(result.stdout, /집계 지표가 생성되지 않았습니다/);
  assert.doesNotMatch(result.stdout, /분자 \d/);
});

test("GOV07 stored-report view rejects changed denominator, request binding and free text", async t => {
  const f = await prepare(t);
  const report = await analyzeEvaluation(f.request, { artifactRoot: f.root });
  for (const mutation of [
    r => { r.recomputedMetrics[0].denominator = 2; const payload = { ...r }; delete payload.reportDigest; r.reportDigest = sha256Canonical(payload); },
    r => { r.requestDigest = rawDigest("different-request"); },
    r => { r.summary = "SYNTHETIC_UNTRUSTED_REPORT_PROSE"; },
  ]) {
    const changed = structuredClone(report);
    mutation(changed);
    const result = execute("validate-report.mjs", [...await validationArgs(f, changed), "--format", "human-ko"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /보고서 검증: 실패/);
    assert.doesNotMatch(result.stdout, /결론: 통과|분자|SYNTHETIC_UNTRUSTED_REPORT_PROSE/);
  }
});

test("GOV07 source artifact prose and invalid-input details never enter human output", async t => {
  const f = await prepare(t);
  const canary = "SYNTHETIC_SOURCE_PROSE_DO_NOT_DISPLAY";
  const text = JSON.stringify({ sample: canary });
  await writeFile(path.join(f.root, "evidence.json"), text, "utf8");
  f.request.artifacts.find(a => a.artifactId === f.ids.evidence).digest = rawDigest(text);
  await writeFile(f.input, JSON.stringify(f.request), "utf8");
  const json = execute("cli.mjs", auditArgs(f));
  const report = JSON.parse(json.stdout);
  assert.doesNotMatch(json.stdout, new RegExp(canary));
  const human = execute("cli.mjs", [...auditArgs(f), "--format", "human-ko"]);
  assert.equal(human.status, 0, human.stderr);
  assert.doesNotMatch(human.stdout + human.stderr, new RegExp(canary));
  const args = await validationArgs(f, report);
  f.request.extra = canary;
  await writeFile(f.input, JSON.stringify(f.request), "utf8");
  for (const [script, argv] of [["cli.mjs", auditArgs(f)], ["validate-report.mjs", args]]) {
    const invalid = execute(script, [...argv, "--format", "human-ko"]);
    assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
    assert.match(invalid.stdout, /입력 오류/);
    assert.doesNotMatch(invalid.stdout + invalid.stderr, new RegExp(canary));
  }
});

test("GOV07 human report CLI works in an installation tree without node_modules", async t => {
  const f = await prepare(t);
  const installed = path.join(f.root, "installed");
  await mkdir(path.join(installed, "skills"), { recursive: true });
  await mkdir(path.join(installed, "runtime"), { recursive: true });
  await cp(path.join(suiteRoot, "skills/evaluation-validity-auditor"), path.join(installed, "skills/evaluation-validity-auditor"), { recursive: true });
  await cp(path.join(suiteRoot, "runtime/schema-validation.mjs"), path.join(installed, "runtime/schema-validation.mjs"));
  const result = execute("cli.mjs", [...auditArgs(f), "--format", "human-ko"], installed);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /결론: 통과 \(PASS\)/);
  assert.match(result.stdout, /분자 1, 분모 4, 값 0\.25/);
  const json = execute("cli.mjs", auditArgs(f), installed);
  const validation = execute("validate-report.mjs", [...await validationArgs(f, JSON.parse(json.stdout)), "--format", "human-ko"], installed);
  assert.equal(validation.status, 0, validation.stdout + validation.stderr);
  assert.match(validation.stdout, /보고서 검증: 통과/);
  assert.equal((await readFile(f.input, "utf8")), JSON.stringify(f.request));
});
