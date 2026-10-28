import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const testsRoot = resolve(import.meta.dirname);
const nodeTests = readdirSync(testsRoot)
  .filter((entry) => entry.endsWith(".node.mjs"))
  .sort()
  .map((entry) => resolve(testsRoot, entry));

interface IsolatedNodeTestResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Error | undefined;
  timedOut: boolean;
}

function runIsolatedNodeTests(timeoutMs: number): Promise<IsolatedNodeTestResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      ["--test", "--test-concurrency=2", "--test-reporter=spec", ...nodeTests],
      {
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let spawnError: Error | undefined;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        status,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        error: spawnError,
        timedOut,
      });
    };

    child.on("error", (error: Error) => {
      spawnError = error;
      finish(null, null);
    });
    child.on("close", (status, signal) => {
      finish(status, signal);
    });
  });
}

test("change-scope-guardian Node tests pass in an isolated process", async () => {
  const startedAt = Date.now();
  const result = await runIsolatedNodeTests(115_000);
  const elapsedMs = Date.now() - startedAt;
  const diagnostic = [
    `status=${String(result.status)} signal=${String(result.signal)} timedOut=${String(result.timedOut)} error=${result.error?.message ?? "none"} elapsedMs=${elapsedMs}`,
    result.stdout,
    result.stderr,
  ].join("\n");
  expect(result.timedOut, diagnostic).toBe(false);
  expect(result.error, diagnostic).toBeUndefined();
  expect(result.status, diagnostic).toBe(0);
}, 120_000);
