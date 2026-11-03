import {spawn} from "node:child_process";
import {existsSync, writeSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {clearTimeout, setTimeout} from "node:timers";
import {describe, expect, it, vi} from "vitest";
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

const maxConcurrentChildren = Math.min(4, Math.max(2, os.availableParallelism()));
// Vitest's own limiter queues the concurrent cases. It arms a test's timeout only when it starts the test body, so
// waiting for a free child slot is never charged to a case's limit; each limit measures that case's own work.
// A queue inside the test body would be charged to it (a 66 s wait failed final-fetch-body on Windows).
vi.setConfig({maxConcurrency: maxConcurrentChildren});
let activeChildren = 0;

async function runCli(args, {cwd, timeout, maxBuffer = 8 * 1024 * 1024, observation = false}) {
  let observationError, sequence = 0;
  const writeObservation = line => {
    try {
      const bytes = Buffer.from(`${line}\n`);
      if (bytes.length > 384) throw new Error("BOOTSTRAP_OBSERVATION_LIMIT");
      if (writeSync(2, bytes) !== bytes.length) throw new Error("BOOTSTRAP_OBSERVATION_SHORT_WRITE");
    }
    catch (error) { observationError ??= error; }
  };
  const observe = (event, details = {}) => {
    if (observation) writeObservation(JSON.stringify({observation: "bootstrap-child-r01", case: observation, sequence: ++sequence,
      monoMs: Number(process.hrtime.bigint() / 1_000_000n), event, ...details}));
  };
  // The limiter is the only queue: a case that starts while every slot is busy means it no longer bounds the children.
  if (++activeChildren > maxConcurrentChildren) {
    activeChildren--;
    throw new Error(`BOOTSTRAP_CHILD_LIMIT_EXCEEDED:${maxConcurrentChildren}`);
  }
  observe("start", {activeChildren});
  try {
    return await new Promise(resolve => {
      observe("spawn-request");
      const child = spawn(process.execPath, args, {
        cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      const stdoutChunks = [], stderrChunks = [];
      let stdoutBytes = 0, stderrBytes = 0;
      let observationTail = "", forwardedObservations = 0;
      let error, settled = false;
      const finish = (status, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          status,
          signal,
          error: observationError ? new AggregateError([error, observationError].filter(Boolean), "BOOTSTRAP_OBSERVATION_FAILED") : error,
          stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
          stderr: Buffer.concat(stderrChunks, stderrBytes).toString("utf8"),
        });
      };
      const timer = setTimeout(() => {
        observe("timeout");
        error = Object.assign(new Error(`spawn ${process.execPath} ETIMEDOUT`), {code: "ETIMEDOUT"});
        child.kill();
      }, timeout);
      child.stdout.on("data", chunk => {
        if (stdoutBytes + chunk.length > maxBuffer) {
          error ??= Object.assign(new Error("stdout maxBuffer length exceeded"), {code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"});
          child.kill();
          return;
        }
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      });
      child.stderr.on("data", chunk => {
        if (stderrBytes + chunk.length > maxBuffer) {
          error ??= Object.assign(new Error("stderr maxBuffer length exceeded"), {code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"});
          child.kill();
          return;
        }
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
        if (observation) {
          const lines = (observationTail + chunk.toString("utf8")).split("\n");
          observationTail = lines.pop().slice(-384);
          for (const line of lines) {
            const marker = observation === "final-fetch-body" ? "bootstrap-mutation-r01" : "history-tar-r01";
            if (!line.startsWith(`{"observation":"${marker}",`)) continue;
            if (line.length > 384 || ++forwardedObservations > (observation === "final-fetch-body" ? 6 : 10)) {
              observationError ??= new Error("BOOTSTRAP_OBSERVATION_LIMIT");
            } else writeObservation(line);
          }
        }
      });
      child.once("spawn", () => observe("spawn", {childPid: child.pid}));
      child.once("exit", (status, signal) => observe("exit", {status, signal}));
      child.once("error", err => {
        observe("error", {code: String(err.code ?? "UNKNOWN").slice(0, 32)});
        error ??= err;
        finish(null, null);
      });
      child.once("close", (status, signal) => {
        observe("close", {status, signal});
        finish(status, signal);
      });
    });
  } finally {
    activeChildren--;
  }
}

describe("live bootstrap offline CLI contracts", () => {
  for (const [program, status, timeout = 90_000, testTimeout = 100_000, scenario] of programs) {
    it.concurrent(`${program}${scenario ? ` (${scenario})` : ""} preserves its standalone assertions`, async () => {
      const root = sourcePrograms.has(program) ? createSourceScratch(repo,
        program === "dynamic-current-stale.mts" ? "ags-current-stale-" : "ags-bootstrap-source-") : null;
      try {
        const args = ["--import", "tsx", path.join(directory, program), repo];
        if (program !== "contract-selfcheck.mts") args.push(path.join(directory, "bootstrap.mts"));
        if (root) args.push(root);
        if (scenario) args.push(scenario);
        const result = await runCli(args, {cwd: repo, timeout, maxBuffer: 8 * 1024 * 1024,
          observation: scenario === "final-fetch-body" ? scenario : program === "history-r04-boundary.mjs" ? "history-r04-boundary" : false});
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
          expect(report.checks[2]).toBe(`${scenario}:restored: BYTES_IDENTICAL`);
        }
      } finally {
        if (root) removeSourceScratch(root);
      }
    }, testTimeout);
  }

  it.concurrent("independent-wire-mutations.mts rejects unknown scenarios before preparing scratch", async () => {
    const parent = createSourceScratch(repo, "ags-invalid-mutation-");
    const root = path.join(parent, "unused-scratch");
    try {
      const args = ["--import", "tsx", path.join(directory, "independent-wire-mutations.mts"), repo,
        path.join(directory, "bootstrap.mts"), root, "unknown-scenario"];
      const result = await runCli(args, {cwd: repo, timeout: 90_000});
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
