import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { InputError, validateRequest, validateReview } from "../../skills/iteration-frame-auditor/scripts/core.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "iteration-frame-auditor");

function inLocale(locale, run) {
  const previous = process.env.AGENT_GOVERNANCE_LOCALE;
  process.env.AGENT_GOVERNANCE_LOCALE = locale;
  try { return run(); } finally {
    if (previous === undefined) delete process.env.AGENT_GOVERNANCE_LOCALE; else process.env.AGENT_GOVERNANCE_LOCALE = previous;
  }
}

for (const [locale, notObject, requestNotObject, missingPath, digestMissing] of [
  ["en", "review must be an object", "Request must be an object.", "--request requires a file path.", "--request-digest requires the external frozen request artifact digest."],
  ["ko", "review는 객체여야 한다", "요청은 객체여야 한다.", "--request에는 파일 경로가 필요하다.", "--request-digest에는 외부 고정 요청 산출물 digest가 필요하다."],
]) {
  test(`review errors and input errors are rendered in the ${locale} host locale`, () => {
    inLocale(locale, () => {
      assert.deepEqual(validateReview(null), [notObject]);
      assert.throws(() => validateRequest(null), (error) => error instanceof InputError && error.message === requestNotObject);
    });
  });

  test(`the CLIs write their error sentences in the ${locale} host locale`, () => {
    const env = { ...process.env, AGENT_GOVERNANCE_LOCALE: locale };
    const argumentError = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "validate-review.mjs"), "--request"], { encoding: "utf8", env });
    assert.equal(argumentError.status, 2);
    assert.deepEqual(JSON.parse(argumentError.stdout), { valid: false, errors: [missingPath] });

    const digestError = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "validate-review.mjs"), "--request", "a", "--review", "b", "--comparison", "c", "--request-digest"], { encoding: "utf8", env });
    assert.equal(digestError.status, 2);
    assert.deepEqual(JSON.parse(digestError.stdout), { valid: false, errors: [digestMissing] });

    const digestRun = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "digest-request.mjs")], { encoding: "utf8", env, input: "[]" });
    assert.equal(digestRun.status, 2);
    assert.equal(JSON.parse(digestRun.stdout).error.message, requestNotObject);
  });
}
