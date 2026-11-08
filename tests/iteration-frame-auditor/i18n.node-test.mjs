import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { InputError, validateRequest, validateReview } from "../../skills/iteration-frame-auditor/scripts/core.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "iteration-frame-auditor");

function inLocale(locale, run) {
  const previous = process.env.AGENT_GOVERNANCE_LOCALE;
  if (locale === undefined) delete process.env.AGENT_GOVERNANCE_LOCALE; else process.env.AGENT_GOVERNANCE_LOCALE = locale;
  try { return run(); } finally {
    if (previous === undefined) delete process.env.AGENT_GOVERNANCE_LOCALE; else process.env.AGENT_GOVERNANCE_LOCALE = previous;
  }
}

// Script output renders in the model locale (en), whatever the host locale.
const notObject = "review must be an object";
const requestNotObject = "Request must be an object.";
const missingPath = "--request requires a file path.";
const digestMissing = "--request-digest requires the external frozen request artifact digest.";
for (const locale of ["en", "ko", undefined]) {
  test(`review errors and input errors are rendered in the model locale, whatever the host locale (${locale ?? "unset"})`, () => {
    inLocale(locale, () => {
      assert.deepEqual(validateReview(null), [notObject]);
      assert.throws(() => validateRequest(null), (error) => error instanceof InputError && error.message === requestNotObject);
    });
  });

  test(`the CLIs write their error sentences in the model locale, whatever the host locale (${locale ?? "unset"})`, () => {
    const env = { ...process.env };
    if (locale === undefined) delete env.AGENT_GOVERNANCE_LOCALE; else env.AGENT_GOVERNANCE_LOCALE = locale;
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
