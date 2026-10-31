import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

function serializeSpawnError(error: unknown): { name: string; code: string | null; message: string } | null {
  if (!error) return null;
  if (error instanceof Error) {
    const code = typeof (error as NodeJS.ErrnoException).code === "string" ? (error as NodeJS.ErrnoException).code! : null;
    return { name: error.name, code, message: error.message };
  }
  return { name: "Error", code: null, message: String(error) };
}

export type ClaimStage = "ready" | "result" | "exit" | "reap";
export interface ClaimDeadlines { readyMs: number; resultMs: number; exitMs: number; reapMs: number }
export interface ClaimWorkerState {
  pid: number | null;
  status: "RUNNING" | "CLOSED" | "TIMED_OUT" | "UNKNOWN";
  /** First stage this worker missed its deadline in; null when it never timed out. */
  timedOutStage: ClaimStage | null;
  exit: number | null | "UNKNOWN";
  signal: NodeJS.Signals | null | "UNKNOWN";
  spawnError: { name: string; code: string | null; message: string } | null;
  lastRawStdout: string | null;
  stderr: string;
}

const DEFAULT_DEADLINES: ClaimDeadlines = { readyMs: 15_000, resultMs: 15_000, exitMs: 15_000, reapMs: 5_000 };

/** A claim worker missed a stage deadline or was still running when its fixture was about to be removed. */
export class ClaimWorkerTimeoutError extends Error {
  readonly code = "TIMED_OUT";
  readonly workers: ClaimWorkerState[];
  constructor(message: string, workers: ClaimWorkerState[]) {
    super(`${message}: ${JSON.stringify(workers)}`);
    this.name = "ClaimWorkerTimeoutError";
    this.workers = workers.map(worker => ({ ...worker }));
  }
}

// Workers that timed out or have not closed yet. Module state is per test file under Vitest isolation.
const unfinishedWorkers = new Set<ClaimWorkerState>();

/**
 * Runs `cleanup` only when every claim worker finished. Otherwise the fixture stays on disk and the
 * TIMED_OUT/UNKNOWN workers are reported; the record is drained so later tests clean up normally.
 */
export function cleanupIfClaimWorkersFinished<T>(cleanup: () => T): T {
  if (unfinishedWorkers.size === 0) return cleanup();
  const workers = [...unfinishedWorkers];
  unfinishedWorkers.clear();
  for (const worker of workers) if (worker.status === "RUNNING") worker.status = "UNKNOWN";
  throw new ClaimWorkerTimeoutError("Claim workers did not finish; fixture preserved", workers);
}

/** Both independent SQLite connections must be open before either claim starts. */
export async function concurrentClaims<T>(fixture: URL, inputs: unknown[], deadlines: Partial<ClaimDeadlines> = {}): Promise<T[]> {
  const limits = { ...DEFAULT_DEADLINES, ...deadlines };
  const states: ClaimWorkerState[] = inputs.map(() => ({
    pid: null, status: "RUNNING", timedOutStage: null, exit: "UNKNOWN", signal: "UNKNOWN", spawnError: null, lastRawStdout: null, stderr: "",
  }));
  states.forEach(state => unfinishedWorkers.add(state));
  const timeOut = (stage: ClaimStage) => {
    for (const state of states) {
      if (state.status === "CLOSED") continue;
      state.status = "TIMED_OUT";
      state.timedOutStage ??= stage;
    }
  };
  const children = inputs.map((input, idx) => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(fixture), JSON.stringify(input)], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    states[idx]!.pid = child.pid ?? null;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const lines = chunk.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (lines.length > 0) states[idx]!.lastRawStdout = lines.at(-1)!;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      states[idx]!.stderr += chunk;
    });
    child.once("error", (err) => {
      states[idx]!.spawnError = serializeSpawnError(err);
      states[idx]!.status = "UNKNOWN";
    });
    return child;
  });
  const exits = children.map((child, idx) => new Promise<number | null>(resolve => child.once("close", (code, signal) => {
    const state = states[idx]!;
    state.status = "CLOSED";
    state.exit = code;
    state.signal = signal;
    if (state.timedOutStage === null) unfinishedWorkers.delete(state);
    resolve(code);
  })));
  async function withDeadline<V>(promise: Promise<V>, ms: number, stage: ClaimStage, message: string): Promise<V> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          timeOut(stage);
          reject(new ClaimWorkerTimeoutError(message, states));
        }, ms);
      })]);
    } finally { clearTimeout(deadline); }
  }
  function receive(child: ChildProcess, idx: number, type: "ready" | "result"): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const diag = () => JSON.stringify(states[idx]);
      const deadline = setTimeout(() => {
        states[idx]!.status = "TIMED_OUT";
        states[idx]!.timedOutStage ??= type;
        failed(new ClaimWorkerTimeoutError(`Claim process ${idx} timed out before ${type}`, states));
      }, type === "ready" ? limits.readyMs : limits.resultMs);
      const cleanup = () => { clearTimeout(deadline); child.off("message", message); child.off("error", onError); child.off("close", closed); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const onError = (error: Error) => {
        states[idx]!.spawnError = serializeSpawnError(error);
        states[idx]!.status = "UNKNOWN";
        failed(new Error(`Claim process spawn error before ${type}: ${diag()}`, { cause: error }));
      };
      const closed = (code: number | null, signal: NodeJS.Signals | null) => {
        states[idx]!.status = "CLOSED";
        states[idx]!.exit = code;
        states[idx]!.signal = signal;
        failed(new Error(`Claim process closed before ${type}: ${diag()}`));
      };
      const message = (value: unknown) => {
        cleanup();
        if (!value || typeof value !== "object" || !("type" in value) || value.type !== type
          || (type === "result" && !("result" in value))) {
          reject(new Error(`Claim process returned an unexpected message: ${diag()}`));
        } else resolve(value);
      };
      child.once("message", message); child.once("error", onError); child.once("close", closed);
    });
  }
  try {
    await Promise.all(children.map((child, idx) => receive(child, idx, "ready")));
    assert.equal(new Set(children.map(child => child.pid)).size, inputs.length);
    assert(children.every(child => child.pid !== process.pid));
    const results = children.map((child, idx) => receive(child, idx, "result"));
    children.forEach(child => child.send("claim"));
    const claims = await Promise.all(results);
    const codes = await withDeadline(Promise.all(exits), limits.exitMs, "exit", "Claim workers did not exit after reporting");
    assert.deepEqual(codes, inputs.map(() => 0));
    return claims.map(message => (message as { result: T }).result);
  } finally {
    children.forEach(child => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    await withDeadline(Promise.all(exits), limits.reapMs, "reap", "Claim workers did not close after termination");
  }
}
