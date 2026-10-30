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

/** Both independent SQLite connections must be open before either claim starts. */
export async function concurrentClaims<T>(fixture: URL, inputs: unknown[]): Promise<T[]> {
  const states = inputs.map(() => ({
    pid: null as number | null,
    status: "RUNNING" as "RUNNING" | "CLOSED" | "TIMED_OUT" | "UNKNOWN",
    exit: "UNKNOWN" as number | null | "UNKNOWN",
    signal: "UNKNOWN" as NodeJS.Signals | null | "UNKNOWN",
    spawnError: null as { name: string; code: string | null; message: string } | null,
    lastRawStdout: null as string | null,
    stderr: "",
  }));
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
    states[idx]!.status = "CLOSED";
    states[idx]!.exit = code;
    states[idx]!.signal = signal;
    resolve(code);
  })));
  function receive(child: ChildProcess, idx: number, type: "ready" | "result"): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const diag = () => JSON.stringify(states[idx]);
      const deadline = setTimeout(() => {
        states[idx]!.status = "TIMED_OUT";
        failed(new Error(`Claim process timed out before ${type}: ${diag()}`));
      }, 15000);
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
    assert.deepEqual(await Promise.all(exits), inputs.map(() => 0));
    return claims.map(message => (message as { result: T }).result);
  } finally {
    children.forEach(child => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(exits),
        new Promise((_, reject) => {
          deadline = setTimeout(() => {
            states.forEach(state => { if (state.status !== "CLOSED") state.status = "TIMED_OUT"; });
            reject(new Error(`Claim workers did not close after termination: ${JSON.stringify(states)}`));
          }, 5000);
        }),
      ]);
    } finally { clearTimeout(deadline); }
  }
}
