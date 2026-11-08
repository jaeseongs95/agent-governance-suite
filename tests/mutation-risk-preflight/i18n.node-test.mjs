import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluatePreflight } from "../../skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs";
import { verifyReceipt } from "../../skills/mutation-risk-preflight/scripts/verify-preflight-receipt.mjs";

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const now = "2026-09-09T00:00:00.000Z";
const HOST_LOCALES = ["en", "ko", undefined];
const HANGUL = /[가-힣]/u;

async function fixture(name) {
  return JSON.parse(await readFile(path.join(fixturesRoot, name, "intent.json"), "utf8"));
}

function inLocale(locale, action) {
  const previous = process.env.AGENT_GOVERNANCE_LOCALE;
  if (locale === undefined) delete process.env.AGENT_GOVERNANCE_LOCALE;
  else process.env.AGENT_GOVERNANCE_LOCALE = locale;
  try { return action(); } finally {
    if (previous === undefined) delete process.env.AGENT_GOVERNANCE_LOCALE;
    else process.env.AGENT_GOVERNANCE_LOCALE = previous;
  }
}

test("승인이 없는 보고서의 사유와 점검 문장은 host locale과 무관하게 model locale(en)로 나온다", async () => {
  const intent = await fixture("billing");
  const reports = HOST_LOCALES.map((locale) => inLocale(locale, () => evaluatePreflight(intent, { now })));
  for (const report of reports) {
    assert.equal(report.verdict, "NEEDS_APPROVAL");
    assert.equal(report.unresolved[0], "An approval that matches the current operation is needed: missing");
    assert.equal(report.checks.find((check) => check.checkId === "approval").message, "Approval status: missing");
    // Host locale does not change the action identity or the verdict.
    assert.equal(report.actionDigest, reports[0].actionDigest);
    assert.equal(report.targetDigest, reports[0].targetDigest);
  }
});

test("차단 사유는 host locale과 무관하게 같은 영어 문장이다", async () => {
  const intent = await fixture("broad-target");
  const [en, ...others] = HOST_LOCALES.map((locale) => inLocale(locale, () => evaluatePreflight(intent, { now })));
  assert.equal(en.verdict, "BLOCKED");
  assert.ok(en.unresolved.length > 0);
  assert.ok(en.unresolved.every((sentence) => !HANGUL.test(sentence)), en.unresolved.join("\n"));
  for (const other of others) {
    assert.equal(other.verdict, "BLOCKED");
    assert.deepEqual(other.unresolved, en.unresolved);
  }
  for (const locale of HOST_LOCALES) {
    assert.equal(inLocale(locale, () => evaluatePreflight({}, { now: "not a time" })).unresolved[0], "The evaluation time is not valid.");
  }
});

test("READY receipt는 어느 host locale에서 만들고 검증해도 검증되고 사유는 영어로 나온다", async () => {
  const intent = await fixture("local-delete");
  for (const [made, verified] of [["ko", "en"], ["en", "ko"], [undefined, "ko"]]) {
    const report = inLocale(made, () => evaluatePreflight(intent, { now }));
    assert.equal(report.verdict, "READY");
    const result = inLocale(verified, () => verifyReceipt({ report, intent, verificationTime: now }));
    assert.equal(result.valid, true, `${made} receipt verified in ${verified}`);
    assert.match(result.reason, /^The receipt matches the current mutation intent\./);
    assert.ok(!HANGUL.test(result.reason), result.reason);
  }
  for (const locale of HOST_LOCALES) {
    const rejected = inLocale(locale, () => verifyReceipt({ report: null, intent, verificationTime: now }));
    assert.equal(rejected.errorCode, "INVALID_INPUT");
    assert.equal(rejected.reason, "report, intent, and a valid verificationTime are required.");
  }
});
