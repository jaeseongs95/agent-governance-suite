import {spawnSync} from "node:child_process";
import {existsSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {createSourceScratch, removeSourceScratch} from "./source-scratch.mjs";

const repo = path.resolve(import.meta.dirname, "../../..");
const directory = path.join(repo, "tests/skill-classification/live-bootstrap");
const programs = [
  ["contract-selfcheck.mts", "OFFLINE_CONTRACT_PASS"],
  ["expiry-regression.mts", "OFFLINE_EXPIRY_REGRESSION_PASS"],
  ["budget-regression.mts", "OFFLINE_RUN_BUDGET_PASS"],
  ["precision-regression.mts", "OFFLINE_PRECISION_REGRESSION_PASS"],
  ["dynamic-current-stale.mts", "CURRENT_STALE_REGISTRY_PASS"],
  ["dynamic-current-oracle.mts", "DYNAMIC_CURRENT_ORACLE_PARTIAL_PASS"],
  // Each mutation keeps its baseline/RED/restored sequence within the same 90s child cap.
  ...["producer-version", "producer-prompt", "producer-order", "wire-prompt", "final-fetch-body", "price"]
    .map(scenario => ["independent-wire-mutations.mts", "INDEPENDENT_MUTATIONS_PASS", 90_000, 100_000, scenario]),
  ["dynamic-precision-boundary.mts", "DYNAMIC_PRECISION_PARTIAL_PASS"],
  ["history-r04-boundary.mjs", "OFFLINE_PRECISION_REGRESSION_PASS", 180_000, 190_000],
  ["history-r04-budget.mjs", "OFFLINE_RUN_BUDGET_PASS"],
];
const sourcePrograms = new Set(["dynamic-current-stale.mts", "independent-wire-mutations.mts",
  "history-r04-boundary.mjs", "history-r04-budget.mjs"]);

describe("live bootstrap offline CLI contracts", () => {
  for (const [program, status, timeout = 90_000, testTimeout = 100_000, scenario] of programs) {
    it(`${program}${scenario ? ` (${scenario})` : ""} preserves its standalone assertions`, () => {
      const root = sourcePrograms.has(program) ? createSourceScratch(repo,
        program === "dynamic-current-stale.mts" ? "ags-current-stale-" : "ags-bootstrap-source-") : null;
      try {
        const args = ["--import", "tsx", path.join(directory, program), repo];
        if (program !== "contract-selfcheck.mts") args.push(path.join(directory, "bootstrap.mts"));
        if (root) args.push(root);
        if (scenario) args.push(scenario);
        const result = spawnSync(process.execPath, args, {
          cwd: repo, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024,
        });
        const diagnostic = JSON.stringify({args, status: result.status, signal: result.signal,
          error: result.error?.message, stdout: result.stdout, stderr: result.stderr});
        expect(result.error, diagnostic).toBeUndefined();
        expect(result.signal, diagnostic).toBeNull();
        expect(result.status, diagnostic).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.status).toBe(status);
        expect(report.actualApiCalls).toBe(0);
        expect(report.actualCredentialLookups).toBe(0);
        if (scenario) {
          expect(report.checks).toHaveLength(3);
          expect(report.checks[0]).toBe("baseline: GREEN");
          expect(report.checks[1]).toMatch(new RegExp(`^${scenario}: RED INDEPENDENT_`));
          expect(report.checks[2]).toBe(`${scenario}:restored: GREEN`);
        }
      } finally {
        if (root) removeSourceScratch(root);
      }
    }, testTimeout);
  }

  it("independent-wire-mutations.mts rejects unknown scenarios before preparing scratch", () => {
    const parent = createSourceScratch(repo, "ags-invalid-mutation-");
    const root = path.join(parent, "unused-scratch");
    try {
      const args = ["--import", "tsx", path.join(directory, "independent-wire-mutations.mts"), repo,
        path.join(directory, "bootstrap.mts"), root, "unknown-scenario"];
      const result = spawnSync(process.execPath, args, {
        cwd: repo, encoding: "utf8", windowsHide: true, timeout: 90_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("UNKNOWN_MUTATION_SCENARIO:unknown-scenario");
      expect(existsSync(root)).toBe(false);
    } finally {
      removeSourceScratch(parent);
    }
  });
});
