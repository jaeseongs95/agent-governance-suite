import { afterEach, expect, it, vi } from "vitest";

/*
 * D0331 engineering-test-plan. Requirement: a verified relay acquisition observes the parent and
 * relay births in one native query under the caller's single budget, with per-PID results.
 * BATCH-1..3 replace only the child_process boundary (any OS) to fix the exact Windows command
 * and output mapping. NATIVE-1 runs the actual Windows PowerShell path unmocked; it measures, it
 * does not assert a latency threshold.
 */
const f = vi.hoisted(() => ({ sync: vi.fn(), async: vi.fn(), mocked: true }));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => f.mocked ? f.sync(...args) : actual.execFileSync(...args),
    execFile: (...args: Parameters<typeof actual.execFile>) => f.mocked ? f.async(...args) : (actual.execFile as (...a: unknown[]) => unknown)(...args) };
});
import { processStartToken, processStartTokens, processStartTokensAsync } from "../../mcp-server/src/process-identity.js";

afterEach(() => { f.sync.mockReset(); f.async.mockReset(); f.mocked = true; vi.restoreAllMocks(); });
const quiet = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);

it("BATCH-1: one PowerShell start answers each PID with its own present, absent, denied or missing result", () => {
  quiet();
  f.sync.mockReturnValue("11 OK 2026-11-01T00:00:00.0000000Z\r\n12 ERR ArgumentException \r\n13 ERR Win32Exception 5\r\n15 ERR InvalidOperationException \r\n");
  const readings = processStartTokens([11, 12, 13, 14, 15, 11], "win32", 1234);
  expect(f.sync).toHaveBeenCalledTimes(1);
  const [executable, args, options] = f.sync.mock.calls[0]! as [string, string[], { timeout: number; windowsHide: boolean }];
  expect(executable).toBe("powershell.exe");
  for (const pid of [11, 12, 13, 14, 15]) expect(args.at(-1)).toContain(`GetProcessById(${pid})`);
  expect(args.at(-1)!.match(/GetProcessById\(11\)/gu)).toHaveLength(1);
  // The caller's whole remaining budget bounds the single call; it is neither raised nor split.
  expect(options).toMatchObject({ timeout: 1234, windowsHide: true });
  expect(readings.map(reading => reading.token)).toEqual(["2026-11-01T00:00:00.0000000Z", null, null, null, null, "2026-11-01T00:00:00.0000000Z"]);
  expect(readings.map(reading => [reading.diagnostic?.nativeCode ?? null, reading.diagnostic?.stderrIndication ?? null])).toEqual([
    [null, null], ["ESRCH", null], ["EACCES", "permission-denied-indication"], [null, "unclassified"], [null, "unclassified"], [null, null]]);
  for (const reading of readings.slice(1, 5)) expect(reading.diagnostic).toMatchObject({ stage: "windows-query", timeoutMs: 1234 });
});

it("BATCH-2: a failed or timed-out native call fails every PID it covered without a fabricated token", () => {
  quiet();
  f.sync.mockImplementation(() => { throw Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT", signal: "SIGTERM" }); });
  const readings = processStartTokens([21, 22], "win32", 900);
  expect(f.sync).toHaveBeenCalledTimes(1);
  expect(readings.map(reading => reading.token)).toEqual([null, null]);
  for (const reading of readings) expect(reading.diagnostic).toMatchObject({ nativeCode: "ETIMEDOUT", signal: "SIGTERM", timeoutMs: 900 });
  expect(readings[0]!.cause).toBeInstanceOf(Error);
  // An exhausted or invalid budget starts no native query.
  expect(processStartTokens([21, 22], "win32", 0)).toEqual([{ token: null }, { token: null }]);
  expect(f.sync).toHaveBeenCalledTimes(1);
});

it("BATCH-3: the broker's asynchronous batch uses one cancellable native call with the same per-PID mapping", async () => {
  quiet();
  const signal = new AbortController().signal;
  f.async.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(null, "31 OK birth-31\n32 ERR ArgumentException \n", "");
    return {};
  });
  const readings = await processStartTokensAsync([31, 32], "win32", 700, signal);
  expect(f.async).toHaveBeenCalledTimes(1);
  expect(f.async.mock.calls[0]![2]).toMatchObject({ timeout: 700, signal });
  expect(readings.map(reading => reading.token)).toEqual(["birth-31", null]);
  expect(readings[1]!.diagnostic).toMatchObject({ nativeCode: "ESRCH" });
});

it.runIf(process.platform === "win32")("NATIVE-1: the actual Windows batch matches single queries per PID and reports absence for a missing PID", async () => {
  f.mocked = false;
  quiet();
  const self = process.pid, parent = process.ppid, absent = 2147483647;
  let started = performance.now();
  const singles = [processStartToken(self, "win32", 5000), processStartToken(parent, "win32", 5000)];
  const singleMs = performance.now() - started;
  started = performance.now();
  const batch = processStartTokens([self, parent, absent], "win32", 5000);
  const batchMs = performance.now() - started;
  started = performance.now();
  const asyncBatch = await processStartTokensAsync([self, parent], "win32", 5000);
  const asyncMs = performance.now() - started;
  expect(typeof singles[0]).toBe("string");
  expect(batch.map(reading => reading.token)).toEqual([...singles, null]);
  expect(batch[2]!.diagnostic).toMatchObject({ stage: "windows-query", nativeCode: "ESRCH", stderrIndication: null });
  expect(asyncBatch.map(reading => reading.token)).toEqual(singles);
  // Measurement record for CI evidence only; no latency threshold is asserted.
  console.log("[D0331-측정] " + JSON.stringify({ twoSingleQueriesMs: Math.round(singleMs), oneBatchOfThreeMs: Math.round(batchMs), oneAsyncBatchOfTwoMs: Math.round(asyncMs) }));
});
