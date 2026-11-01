import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaimWorkerTimeoutError, claimReapFailure, cleanupIfClaimWorkersFinished, concurrentClaims, type ClaimWorkerState } from "./concurrent-claim-process.js";

const worker = new URL("./fixtures/claim-worker-modes.ts", import.meta.url);
// Startup and reaping stay generous for slow Windows runners; only the stage under test is short.
const SLOW = 20_000;
const SHORT = 300;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "concurrent-claim-helper-"));
  directories.push(directory);
  return directory;
}

async function timedOut(run: Promise<unknown>): Promise<ClaimWorkerTimeoutError> {
  const error = await run.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ClaimWorkerTimeoutError);
  expect((error as ClaimWorkerTimeoutError).code).toBe("TIMED_OUT");
  return error as ClaimWorkerTimeoutError;
}

function expectReaped(state: ClaimWorkerState): void {
  expect(state.status).toBe("CLOSED");
  let probe: unknown = null;
  try { process.kill(state.pid!, 0); } catch (error) { probe = error; }
  expect((probe as NodeJS.ErrnoException | null)?.code).toBe("ESRCH");
}

function expectFixturePreserved(directory: string, stage: string): void {
  let cleaned = false;
  let preserved: unknown;
  try {
    cleanupIfClaimWorkersFinished(() => { cleaned = true; });
  } catch (error) { preserved = error; }
  expect(cleaned).toBe(false);
  expect(preserved).toBeInstanceOf(ClaimWorkerTimeoutError);
  expect((preserved as ClaimWorkerTimeoutError).code).toBe("TIMED_OUT");
  const workers = (preserved as ClaimWorkerTimeoutError).workers;
  expect(workers.map(state => state.timedOutStage)).toEqual([stage]);
  // concurrentClaims rejects only after its finally block reaped the worker.
  workers.forEach(expectReaped);
  expect(existsSync(directory)).toBe(true);
  // The record is drained once reported, so the next test's fixtures are cleaned normally.
  expect(cleanupIfClaimWorkersFinished(() => "cleaned")).toBe("cleaned");
}

describe("concurrentClaims stage deadlines", () => {
  it("returns results and lets the fixture be cleaned when every worker finishes", async () => {
    const directory = fixtureDirectory();
    const results = await concurrentClaims<{ mode: string }>(worker, [{ mode: "normal" }, { mode: "normal" }], { readyMs: SLOW, resultMs: SLOW, exitMs: SLOW, reapMs: SLOW });
    expect(results.map(result => result.mode)).toEqual(["normal", "normal"]);
    cleanupIfClaimWorkersFinished(() => rmSync(directory, { recursive: true }));
    expect(existsSync(directory)).toBe(false);
  });

  it("fails TIMED_OUT at the exit stage, reaps a worker that never exits, and preserves the fixture", async () => {
    const directory = fixtureDirectory();
    const error = await timedOut(concurrentClaims(worker, [{ mode: "no-exit" }], { readyMs: SLOW, resultMs: SLOW, exitMs: SHORT, reapMs: SLOW }));
    expect(error.message).toMatch(/did not exit after reporting/u);
    // This snapshot is taken at the deadline, before the kill.
    expect(error.workers).toMatchObject([{ status: "TIMED_OUT", timedOutStage: "exit", exit: "UNKNOWN" }]);
    expectFixturePreserved(directory, "exit");
  });

  it("fails TIMED_OUT at the result stage, reaps a worker that never reports, and preserves the fixture", async () => {
    const directory = fixtureDirectory();
    const error = await timedOut(concurrentClaims(worker, [{ mode: "no-result" }], { readyMs: SLOW, resultMs: SHORT, exitMs: SLOW, reapMs: SLOW }));
    expect(error.message).toMatch(/Claim process 0 timed out before result/u);
    expect(error.workers).toMatchObject([{ status: "TIMED_OUT", timedOutStage: "result", exit: "UNKNOWN" }]);
    expectFixturePreserved(directory, "result");
  });

  it("keeps the original stage error when the reap after it also misses its deadline (D0161)", async () => {
    const directory = fixtureDirectory();
    let holderPid: number | null = null;
    try {
      const error = await timedOut(concurrentClaims(worker, [{ mode: "hold-stdout" }], { readyMs: SLOW, resultMs: SHORT, exitMs: SLOW, reapMs: SHORT }));
      holderPid = (JSON.parse(error.workers[0]!.lastRawStdout!) as { holderPid: number }).holderPid;
      // The thrown error is the result-stage failure, not the later reap timeout.
      expect(error.message).toMatch(/Claim process 0 timed out before result/u);
      expect(error.workers).toMatchObject([{ status: "TIMED_OUT", timedOutStage: "result", exit: "UNKNOWN" }]);
      const reap = claimReapFailure(error);
      expect(reap).toBeInstanceOf(ClaimWorkerTimeoutError);
      expect((reap as ClaimWorkerTimeoutError).message).toMatch(/did not close after termination/u);
      // The killed worker never closed (its stdout is still held): it stays TIMED_OUT at its first missed stage.
      expect((reap as ClaimWorkerTimeoutError).workers).toMatchObject([{ status: "TIMED_OUT", timedOutStage: "result", exit: "UNKNOWN" }]);
      let preserved: unknown;
      try { cleanupIfClaimWorkersFinished(() => rmSync(directory, { recursive: true })); } catch (caught) { preserved = caught; }
      expect(preserved).toBeInstanceOf(ClaimWorkerTimeoutError);
      expect((preserved as ClaimWorkerTimeoutError).workers).toMatchObject([{ status: "TIMED_OUT", timedOutStage: "result" }]);
      expect(existsSync(directory)).toBe(true);
    } finally {
      if (holderPid !== null) {
        const pid = holderPid;
        process.kill(pid, "SIGKILL");
        await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow(); }, { timeout: SLOW });
      }
    }
    // Without an earlier failure nothing is kept beside the result.
    expect(claimReapFailure(new Error("unrelated"))).toBeNull();
  });

  it("reports workers still running at fixture cleanup as UNKNOWN without deleting the fixture", async () => {
    const directory = fixtureDirectory();
    const run = concurrentClaims(worker, [{ mode: "no-result" }], { readyMs: SLOW, resultMs: SHORT, exitMs: SLOW, reapMs: SLOW });
    run.catch(() => {});
    let preserved: unknown;
    try {
      cleanupIfClaimWorkersFinished(() => rmSync(directory, { recursive: true }));
    } catch (error) { preserved = error; }
    expect(preserved).toBeInstanceOf(ClaimWorkerTimeoutError);
    expect((preserved as ClaimWorkerTimeoutError).workers).toMatchObject([{ status: "UNKNOWN", timedOutStage: null }]);
    expect(existsSync(directory)).toBe(true);
    // Let the helper's own result deadline reap the worker so it cannot outlive this test.
    await expect(run).rejects.toBeInstanceOf(ClaimWorkerTimeoutError);
  });
});
