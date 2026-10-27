import {spawnSync} from "node:child_process";
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
  ["independent-wire-mutations.mts", "INDEPENDENT_MUTATIONS_PASS"],
  ["dynamic-precision-boundary.mts", "DYNAMIC_PRECISION_PARTIAL_PASS"],
  ["history-r04-boundary.mjs", "OFFLINE_PRECISION_REGRESSION_PASS", 180_000, 190_000],
  ["history-r04-budget.mjs", "OFFLINE_RUN_BUDGET_PASS"],
];
const sourcePrograms = new Set(["dynamic-current-stale.mts", "independent-wire-mutations.mts",
  "history-r04-boundary.mjs", "history-r04-budget.mjs"]);

describe("live bootstrap offline CLI contracts", () => {
  for (const [program, status, timeout = 90_000, testTimeout = 100_000] of programs) {
    it(`${program} preserves its standalone assertions`, () => {
      const root = sourcePrograms.has(program) ? createSourceScratch(repo,
        program === "dynamic-current-stale.mts" ? "ags-current-stale-" : "ags-bootstrap-source-") : null;
      try {
        const args = ["--import", "tsx", path.join(directory, program), repo];
        if (program !== "contract-selfcheck.mts") args.push(path.join(directory, "bootstrap.mts"));
        if (root) args.push(root);
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
      } finally {
        if (root) removeSourceScratch(root);
      }
    }, testTimeout);
  }
});
