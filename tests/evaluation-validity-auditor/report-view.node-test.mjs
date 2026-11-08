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
// The human view renders in the model locale (en) whatever the host locale; runs default to a ko host
// to show that, and null leaves AGENT_GOVERNANCE_LOCALE unset.
const hangul = /[가-힣]/u;
const execute = (script, args, suite = suiteRoot, locale = "ko") => {
  const env = { ...process.env };
  if (locale === null) delete env.AGENT_GOVERNANCE_LOCALE; else env.AGENT_GOVERNANCE_LOCALE = locale;
  return spawnSync(process.execPath, [scriptPath(suite, script), ...args], { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024, env });
};

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
  assert.match(human.stdout, /Conclusion: Verdict withheld \(BLOCKED\), post-execution evaluation validity/);
  for (const label of ["Reason:", "Verification coverage:", "Limitations:", "actual identities were not authenticated", "the target source was not verified separately"]) assert.ok(human.stdout.includes(label), label);
  assert.match(human.stdout, /result records observed 4 \/ planned 8/);
  assert.match(human.stdout, /numerator 1, denominator 4, value 0\.25/);
  assert.match(human.stdout, /numerator 2, denominator 4, value 0\.5/);
  assert.match(human.stdout, /Failed and timed-out runs stay in the original denominator/);
  assert.doesNotMatch(human.stdout, hangul);
  for (const id of [expected.auditId, expected.target.evaluationId, expected.target.identifier, expected.target.digest, expected.requestDigest, expected.reportDigest, f.ids.evidence]) assert.ok(human.stdout.includes(id), id);
  assert.equal(execute("cli.mjs", auditArgs(f)).stdout, json.stdout);
  const validation = execute("validate-report.mjs", [...await validationArgs(f, expected), "--format", "human-ko"]);
  assert.equal(validation.status, 0, validation.stdout + validation.stderr);
  assert.match(validation.stdout, /Report validation: passed/);
  assert.ok(validation.stdout.endsWith(human.stdout));
});

test("GOV07 실행 전 신원 미관측은 결과 검사나 품질 근거를 주장하지 않는다", async t => {
  const f = await prepare(t, false);
  const result = execute("cli.mjs", [...auditArgs(f), "--format", "human-ko"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Conclusion: Verdict withheld \(BLOCKED\), pre-execution design readiness/);
  assert.match(result.stdout, /Run results and aggregates were not checked at this stage/);
  assert.match(result.stdout, /Not usable as result evidence for quality and release decisions/);
  assert.doesNotMatch(result.stdout, /Published aggregate matches the recomputed result: Pass/);
});

test("GOV07 FAIL and BLOCKED remain distinct and explain their actual cause", async t => {
  const f = await prepare(t, false);
  f.request.criteria[0].judgmentMethods = ["self-report"];
  await writeFile(f.input, JSON.stringify(f.request), "utf8");
  const failed = execute("cli.mjs", [...auditArgs(f), "--format", "human-ko"]);
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.stdout, /Conclusion: Fail \(FAIL\)/);
  assert.match(failed.stdout, /The judgment relied on self-report alone\..*SELF_REPORT_ONLY/);
  assert.match(failed.stdout, /Not usable as result evidence/);
  f.request.criteria[0].judgmentMethods = ["independent-review", "self-report"];
  f.request.artifacts.find(a => a.role === "rubric").provenance = null;
  await writeFile(f.input, JSON.stringify(f.request), "utf8");
  const blocked = execute("cli.mjs", [...auditArgs(f), "--format", "human-ko"]);
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.match(blocked.stdout, /Conclusion: Verdict withheld \(BLOCKED\)/);
  assert.match(blocked.stdout, /provenance or timing evidence is insufficient\..*PROVENANCE_MISSING/);
});

test("GOV07 missing results never become an aggregate or a quality PASS", async t => {
  const f = await prepare(t);
  const text = f.resultText.trim().split("\n").slice(1).join("\n") + "\n";
  await writeFile(path.join(f.root, "run-1.jsonl"), text, "utf8");
  f.request.artifacts.find(a => a.role === "result-records").digest = rawDigest(text);
  await writeFile(f.input, JSON.stringify(f.request), "utf8");
  const result = execute("cli.mjs", [...auditArgs(f), "--format", "human-ko"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Conclusion: Fail \(FAIL\)/);
  assert.match(result.stdout, /required result of a completed run is missing\..*RESULT_MISSING/);
  assert.match(result.stdout, /No aggregate metrics were produced/);
  assert.doesNotMatch(result.stdout, /numerator \d/);
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
    assert.match(result.stdout, /Report validation: failed/);
    assert.doesNotMatch(result.stdout, /Conclusion: Pass|numerator|SYNTHETIC_UNTRUSTED_REPORT_PROSE/);
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
    assert.match(invalid.stdout, /input error/);
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
  await cp(path.join(suiteRoot, "runtime/i18n.mjs"), path.join(installed, "runtime/i18n.mjs"));
  const result = execute("cli.mjs", [...auditArgs(f), "--format", "human-ko"], installed);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Conclusion: Verdict withheld \(BLOCKED\)/);
  assert.match(result.stdout, /numerator 1, denominator 4, value 0\.25/);
  const json = execute("cli.mjs", auditArgs(f), installed);
  const validation = execute("validate-report.mjs", [...await validationArgs(f, JSON.parse(json.stdout)), "--format", "human-ko"], installed);
  assert.equal(validation.status, 0, validation.stdout + validation.stderr);
  assert.match(validation.stdout, /Report validation: passed/);
  assert.equal((await readFile(f.input, "utf8")), JSON.stringify(f.request));
});

test("the human view and the input errors render in the model locale, whatever the host locale, and the JSON stays the same", async t => {
  const f = await prepare(t);
  const jsonEn = execute("cli.mjs", auditArgs(f), suiteRoot, "en");
  assert.equal(jsonEn.status, 0, jsonEn.stderr);
  const report = JSON.parse(jsonEn.stdout);
  const humanEn = execute("cli.mjs", [...auditArgs(f), "--format", "human-ko"], suiteRoot, "en");
  assert.equal(humanEn.status, 0, humanEn.stderr);

  for (const locale of ["en", "ko", null]) {
    assert.equal(execute("cli.mjs", auditArgs(f), suiteRoot, locale).stdout, jsonEn.stdout);

    const human = execute("cli.mjs", [...auditArgs(f), "--format", "human-ko"], suiteRoot, locale);
    assert.equal(human.status, 0, human.stderr);
    assert.equal(human.stdout, humanEn.stdout);
    assert.match(human.stdout, /Conclusion: Verdict withheld \(BLOCKED\), post-execution evaluation validity audit\./);
    assert.match(human.stdout, /Metric \S+: numerator 1, denominator 4, value 0\.25;/);
    assert.match(human.stdout, /\(COOPERATIVE_PROVENANCE_ASSERTIONS\)/);
    assert.doesNotMatch(human.stdout, hangul);
    for (const id of [report.auditId, report.requestDigest, report.reportDigest]) assert.ok(human.stdout.includes(id), id);

    const validation = execute("validate-report.mjs", [...await validationArgs(f, report), "--format", "human-ko"], suiteRoot, locale);
    assert.equal(validation.status, 0, validation.stdout + validation.stderr);
    assert.match(validation.stdout, /^Report validation: passed\./);
    assert.ok(validation.stdout.endsWith(human.stdout));

    const missingRoot = JSON.parse(execute("cli.mjs", ["--input", f.input], suiteRoot, locale).stdout);
    assert.deepEqual(missingRoot, { schemaVersion: "1.0.0", ok: false, error: { code: "INVALID_INPUT", message: "--artifact-root is required.", details: null } });
    const io = execute("cli.mjs", ["--format", "human-ko", "--input", f.root, "--artifact-root", f.root], suiteRoot, locale);
    assert.match(io.stdout, /^Conclusion: I\/O error \(EISDIR\)\./);
    assert.doesNotMatch(io.stdout, hangul);
  }
});
