import {spawnSync} from "node:child_process";
import path from "node:path";
import {describe, expect, it} from "vitest";

const repo = path.resolve(import.meta.dirname, "../../..");
const directory = path.join(repo, "tests/skill-classification/live-bootstrap");
const programs = [
  ["contract-selfcheck.mts", "OFFLINE_CONTRACT_PASS"],
  ["expiry-regression.mts", "OFFLINE_EXPIRY_REGRESSION_PASS"],
  ["budget-regression.mts", "OFFLINE_RUN_BUDGET_PASS"],
  ["precision-regression.mts", "OFFLINE_PRECISION_REGRESSION_PASS"],
];

describe("live bootstrap offline CLI contracts", () => {
  for (const [program, status] of programs) {
    it(`${program} preserves its standalone assertions`, () => {
      const args = ["--import", "tsx", path.join(directory, program), repo];
      if (program !== "contract-selfcheck.mts") args.push(path.join(directory, "bootstrap.mts"));
      const result = spawnSync(process.execPath, args, {
        cwd: repo, encoding: "utf8", windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
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
    }, 100_000);
  }
});
