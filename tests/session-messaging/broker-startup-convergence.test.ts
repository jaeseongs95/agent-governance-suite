import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { requestSessionMessageOnce, waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";

const broker = fileURLToPath(new URL("../../mcp-server/dist/session-message-broker.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/broker-startup-child.mjs", import.meta.url));
const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function startWinner(gateProbe = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "broker-startup-convergence-"));
  directories.push(directory);
  const preload = gateProbe ? ["--import", new URL("./fixtures/broker-startup-probe-gate.mjs", import.meta.url).href] : [];
  const child = spawn(process.execPath, [...preload, broker, "--state-directory", directory], {
    windowsHide: true, stdio: "ignore", env: {
      ...process.env,
      AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflows.sqlite3"),
      AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"),
      AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"),
      AGENT_GOVERNANCE_SHARED_STATE_DIR: directory,
      AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: directory,
      AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(directory, "board.sqlite3"),
      ...(gateProbe ? { AGS_STARTUP_PROBE_GATE: directory } : {}),
    },
  });
  children.push(child);
  await waitForSessionMessageBrokerReady(directory, child, 5000);
  return { directory, child };
}

it("does not settle an unstarted owned launcher just because another broker answers ping", async () => {
  const { directory } = await startWinner();
  const held = spawn(process.execPath, [fixture, "silent"], { windowsHide: true, stdio: "ignore" });
  children.push(held);
  await expect(waitForSessionMessageBrokerReady(directory, held, 1000)).rejects.toThrow(/startup deadline/u);
  expect(held.exitCode).toBeNull();
  await expect(requestSessionMessageOnce("ping", {}, directory)).resolves.toHaveProperty("protocolVersion", "1.0.0");
});

it.each(["exit", "signal"])("rejects an owned launcher %s that occurs during another broker's readiness probe", async (failure) => {
  const { directory } = await startWinner(true);
  const child = spawn(process.execPath, ["--eval", 'process.on("message", () => process.exit(3)); process.send("ready");'], {
    windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  children.push(child);
  await once(child, "message");
  await writeFile(path.join(directory, "arm-ping"), "1");
  const ready = expect(waitForSessionMessageBrokerReady(directory, child, 5000)).rejects.toThrow(/exited before it was ready/u);
  try {
    const deadline = performance.now() + 2500;
    while (true) {
      try { await readFile(path.join(directory, "ping-response-held")); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (performance.now() >= deadline) throw new Error("Fixture ping did not enter its controlled response boundary.");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const closed = once(child, "close");
    if (failure === "exit") child.send("fail");
    else child.kill("SIGTERM");
    await closed;
  } finally { await writeFile(path.join(directory, "release-ping"), "1"); }
  await ready;
});

it("reuses a healthy winner after its owned loser exits normally and still rejects a failed loser", async () => {
  const { directory } = await startWinner();
  for (const mode of ["exit-zero", "exit"]) {
    const child = spawn(process.execPath, [fixture, mode], { windowsHide: true, stdio: "ignore" });
    children.push(child);
    await once(child, "close");
    if (mode === "exit-zero") await expect(waitForSessionMessageBrokerReady(directory, child, 1000)).resolves.toBeUndefined();
    else await expect(waitForSessionMessageBrokerReady(directory, child, 1000)).rejects.toThrow(/exited before it was ready/u);
  }
});

it("requires a positive safe endpoint PID only when deciding ownership of a running launcher", async () => {
  const { directory, child } = await startWinner();
  const endpointPath = path.join(directory, "endpoint.json");
  const original = await readFile(endpointPath, "utf8");
  const endpoint = JSON.parse(original);
  try {
    for (const pid of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, String(child.pid)]) {
      await writeFile(endpointPath, JSON.stringify({ ...endpoint, pid }), "utf8");
      // Endpoint PID is not newly made an authentication condition for ordinary requests.
      await expect(requestSessionMessageOnce("ping", {}, directory)).resolves.toHaveProperty("protocolVersion", "1.0.0");
      await expect(waitForSessionMessageBrokerReady(directory, child, 200)).rejects.toThrow(/startup deadline/u);
    }
  } finally { await writeFile(endpointPath, original, "utf8"); }
});
