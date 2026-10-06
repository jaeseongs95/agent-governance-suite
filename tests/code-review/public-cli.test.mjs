import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { fixture, writeJson, H } from "../engineering-practices/helpers.mjs";

const cleanups = [];
const script = fileURLToPath(new URL("../../skills/code-review/scripts/run.mjs", import.meta.url));
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;
delete environment.NODE_OPTIONS;
delete environment.NODE_PATH;

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function reviewFixture() {
  return fixture({ after: (cleanup) => cleanups.push(cleanup) });
}

function runReview(input) {
  return spawnSync(process.execPath, [script, "check-review", "--root", input.root,
    "--request", "request.json", "--report", "review.json"], {
    cwd: input.root, env: environment, encoding: "utf8", windowsHide: true, timeout: 20_000,
  });
}

test("code-review public CLI accepts complete review outside repository cwd", () => {
  const result = runReview(reviewFixture());
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ kind: "engineering-review-result", verdict: "NO_BLOCKING_FINDINGS" });
  expect(result.stderr).toBe("");
});

test("code-review public CLI preserves incomplete review with exit 1", () => {
  const input = reviewFixture();
  input.report.coverage[0].status = "NOT_REVIEWED";
  writeJson(input.root, "review.json", input.report);
  const result = runReview(input);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ kind: "engineering-review-result", verdict: "INCOMPLETE" });
  expect(result.stderr).toBe("");
});

test("code-review public CLI rejects request digest mismatch with structured exit 2", () => {
  const input = reviewFixture();
  input.report.requestDigest = H("different request");
  writeJson(input.root, "review.json", input.report);
  const result = runReview(input);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(2);
  expect(JSON.parse(result.stderr)).toMatchObject({ status: "ERROR", code: "INTEGRITY_FAILED" });
  expect(result.stdout).toBe("");
});
