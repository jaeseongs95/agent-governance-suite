import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";

it("preserves the recorded blind static evaluation, not a fresh model evaluation", () => {
  const load = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
  const receipt = load("eval-receipt.json");
  const oracle = load("eval-oracle.json");
  const results = load("eval-results.json");
  expect(results).toHaveLength(12);
  expect(new Set(results.map((r) => r.id)).size).toBe(12);
  for (const expected of oracle) {
    const actual = results.find((r) => r.id === expected.id);
    expect(actual.classification).toBe(expected.expected);
    expect(actual.actually_executed).toBe(false);
    expect(actual.evidence.length).toBeGreaterThan(0);
  }
  for (const [file, expected] of Object.entries(receipt.files)) {
    const bytes = readFileSync(new URL(`../../${file}`, import.meta.url));
    expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, file).toBe(expected);
  }
});
