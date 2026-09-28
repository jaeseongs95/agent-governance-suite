import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Both independent SQLite connections must be open before either claim starts. */
export async function concurrentClaims<T>(fixture: URL, inputs: unknown[]): Promise<T[]> {
  const children = inputs.map(input => spawn(process.execPath, ["--import", "tsx", fileURLToPath(fixture), JSON.stringify(input)], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  }));
  const exits = children.map(child => new Promise<number | null>(resolve => child.once("close", resolve)));
  function receive(child: ChildProcess, type: "ready" | "result"): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { child.off("message", message); child.off("error", failed); child.off("close", closed); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const closed = () => failed(new Error(`Claim process closed before ${type}.`));
      const message = (value: unknown) => {
        cleanup();
        if (!value || typeof value !== "object" || !("type" in value) || value.type !== type
          || (type === "result" && !("result" in value))) {
          reject(new Error("Claim process returned an unexpected message."));
        } else resolve(value);
      };
      child.once("message", message); child.once("error", failed); child.once("close", closed);
    });
  }
  try {
    await Promise.all(children.map(child => receive(child, "ready")));
    assert.equal(new Set(children.map(child => child.pid)).size, inputs.length);
    assert(children.every(child => child.pid !== process.pid));
    const results = children.map(child => receive(child, "result"));
    children.forEach(child => child.send("claim"));
    const claims = await Promise.all(results);
    assert.deepEqual(await Promise.all(exits), inputs.map(() => 0));
    return claims.map(message => (message as { result: T }).result);
  } finally {
    children.forEach(child => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    await Promise.all(exits);
  }
}
