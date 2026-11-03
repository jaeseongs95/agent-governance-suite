import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluatePreflight } from "../../skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs";
import { verifyReceipt } from "../../skills/mutation-risk-preflight/scripts/verify-preflight-receipt.mjs";

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const now = "2026-09-09T00:00:00.000Z";

async function fixture(name) {
  return JSON.parse(await readFile(path.join(fixturesRoot, name, "intent.json"), "utf8"));
}

function inLocale(locale, action) {
  const previous = process.env.AGENT_GOVERNANCE_LOCALE;
  process.env.AGENT_GOVERNANCE_LOCALE = locale;
  try { return action(); } finally {
    if (previous === undefined) delete process.env.AGENT_GOVERNANCE_LOCALE;
    else process.env.AGENT_GOVERNANCE_LOCALE = previous;
  }
}

test("승인이 없는 보고서의 사유와 점검 문장은 호스트 locale(en·ko)로 나온다", async () => {
  const intent = await fixture("billing");
  const en = inLocale("en", () => evaluatePreflight(intent, { now }));
  const ko = inLocale("ko", () => evaluatePreflight(intent, { now }));
  assert.equal(en.verdict, "NEEDS_APPROVAL");
  assert.equal(ko.verdict, "NEEDS_APPROVAL");
  assert.equal(en.unresolved[0], "An approval that matches the current operation is needed: missing");
  assert.equal(ko.unresolved[0], "현재 작업에 맞는 승인이 필요합니다: missing");
  assert.equal(en.checks.find((check) => check.checkId === "approval").message, "Approval status: missing");
  assert.equal(ko.checks.find((check) => check.checkId === "approval").message, "승인 상태: missing");
  // Language does not change the action identity or the verdict.
  assert.equal(en.actionDigest, ko.actionDigest);
  assert.equal(en.targetDigest, ko.targetDigest);
});

test("차단 사유는 호스트 locale(en·ko)로 나온다", async () => {
  const intent = await fixture("broad-target");
  const en = inLocale("en", () => evaluatePreflight(intent, { now }));
  const ko = inLocale("ko", () => evaluatePreflight(intent, { now }));
  assert.equal(en.verdict, "BLOCKED");
  assert.equal(ko.verdict, "BLOCKED");
  assert.equal(en.unresolved.length, ko.unresolved.length);
  assert.ok(en.unresolved.every((sentence) => !/[가-힣]/.test(sentence)), en.unresolved.join("\n"));
  assert.ok(ko.unresolved.every((sentence) => /[가-힣]/.test(sentence)), ko.unresolved.join("\n"));
  const invalid = inLocale("en", () => evaluatePreflight({}, { now: "not a time" }));
  assert.equal(invalid.unresolved[0], "The evaluation time is not valid.");
  assert.equal(inLocale("ko", () => evaluatePreflight({}, { now: "not a time" })).unresolved[0], "평가 시각이 유효하지 않습니다.");
});

test("READY receipt는 다른 locale에서도 검증되고 검증 결과의 사유만 호스트 locale로 나온다", async () => {
  const intent = await fixture("local-delete");
  for (const [made, verified] of [["ko", "en"], ["en", "ko"]]) {
    const report = inLocale(made, () => evaluatePreflight(intent, { now }));
    assert.equal(report.verdict, "READY");
    const result = inLocale(verified, () => verifyReceipt({ report, intent, verificationTime: now }));
    assert.equal(result.valid, true, `${made} receipt verified in ${verified}`);
    assert.match(result.reason, verified === "en" ? /^The receipt matches the current mutation intent\./ : /^receipt와 현재 mutation intent가 일치합니다\./);
  }
  const rejected = inLocale("en", () => verifyReceipt({ report: null, intent, verificationTime: now }));
  assert.equal(rejected.errorCode, "INVALID_INPUT");
  assert.equal(rejected.reason, "report, intent, and a valid verificationTime are required.");
  assert.equal(inLocale("ko", () => verifyReceipt({ report: null, intent, verificationTime: now })).reason, "report, intent와 유효한 verificationTime이 필요합니다.");
});
