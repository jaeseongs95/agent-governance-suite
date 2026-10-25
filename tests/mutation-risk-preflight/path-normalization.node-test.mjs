import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalLocator, evaluatePreflight } from "../../skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs";
import { verifyReceipt } from "../../skills/mutation-risk-preflight/scripts/verify-preflight-receipt.mjs";

const now = "2026-09-09T00:00:00.000Z";
async function intentFor(locator) {
  const intent = JSON.parse(await readFile(new URL("./fixtures/local-delete/intent.json", import.meta.url), "utf8"));
  intent.targets[0].locator = locator;
  intent.scopeRef.includedTargets = [locator];
  intent.authorizationRef.allowedTargets = [locator];
  intent.approvalEvidenceRefs[0].targetLocators = [locator];
  intent.currentStateEvidenceRefs[0].targetLocator = locator;
  return intent;
}

test("dot-segment를 경로 종류별로 정규화하고 URI 계약을 보존한다", () => {
  for (const [input, expected] of [
    ["D:/claude/..", "d:"], ["D:\\repo\\.\\child\\..\\file.txt", "d:/repo/file.txt"],
    ["D://repo/../", "d:"], ["D:child/..", "d:."],
    ["\\\\server\\share\\child\\..", "//server/share"],
    ["//server/share/child/../../safe.txt", "//server/share/safe.txt"],
    ["/tmp/..", "/"], ["/tmp/../safe.txt", "/safe.txt"],
    ["child/..", "."], ["./..", ".."], ["~/child/..", "~"],
    ["D:/Repo/file.txt", "d:/Repo/file.txt"], ["/repo/file.txt", "/repo/file.txt"],
    ["SERVICE://payments//worker/", "service://payments/worker"],
    ["service://payments/../worker", "service://payments/../worker"],
  ]) {
    assert.equal(canonicalLocator(input), expected, input);
    assert.equal(canonicalLocator(expected), expected, `idempotent: ${input}`);
  }
});

test("dot-segment로 위장한 루트와 지워질 미해석 변수·glob은 BLOCKED다", async () => {
  for (const locator of [
    "D:/claude/..", "D:\\.", "D:/repo/../.", "D://repo/..", "D:child/..",
    "//server/share/child/..", "\\\\server\\share\\child\\..\\..",
    "/tmp/..", "/tmp/../.", "child/..", "./..", "~/child/..",
    "C:\\", "//server/share", "%USERPROFILE%/x", "D:/repo/*", "~",
    "D:/repo/*/../safe.txt", "D:/repo/$HOME/../safe.txt", "D:/repo/%TEMP%/../safe.txt",
  ]) {
    const report = evaluatePreflight(await intentFor(locator), { now });
    assert.equal(report.verdict, "BLOCKED", locator);
    assert.equal(report.checks.find((check) => check.checkId === "target-specificity").state, "failed", locator);
  }
});

test("정상 대상과 승인·범위·현재근거·receipt는 같은 canonical 경로로 비교된다", async () => {
  for (const [target, canonical] of [
    ["D:/repo/child/../file.txt", "d:/repo/file.txt"],
    ["D:/repo/.", "d:/repo"],
    ["//server/share/child/../file.txt", "//server/share/file.txt"],
    ["/repo/child/../file.txt", "/repo/file.txt"],
  ]) {
    const intent = await intentFor(canonical);
    const baseline = evaluatePreflight(intent, { now });
    intent.targets[0].locator = target;
    const report = evaluatePreflight(intent, { now });
    assert.equal(report.verdict, "READY", target);
    assert.equal(report.targetDigest, baseline.targetDigest, target);
    assert.equal(report.actionDigest, baseline.actionDigest, target);
    assert.equal(verifyReceipt({ report, intent, verificationTime: now }).valid, true, target);
    intent.scopeRef.excludedTargets = [canonical];
    assert.equal(evaluatePreflight(intent, { now }).verdict, "BLOCKED", `excluded: ${target}`);
  }
  const repository = await intentFor("D:/repo/.");
  repository.targets[0].targetType = "repository-root";
  assert.equal(evaluatePreflight(repository, { now }).verdict, "BLOCKED");
});

test("기존 정상·경계·실패 fixture 판정을 보존한다", async () => {
  const behavior = JSON.parse(await readFile(new URL("./behavior-cases.json", import.meta.url), "utf8"));
  for (const item of behavior.cases) {
    const intent = JSON.parse(await readFile(new URL(`./fixtures/${item.fixture}/intent.json`, import.meta.url), "utf8"));
    assert.equal(evaluatePreflight(intent, { now }).verdict, item.expectedVerdict, item.id);
  }
});
