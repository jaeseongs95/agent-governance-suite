import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { requestSessionMessageOnce, waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";

const pluginRoot = process.env.BROKER_TEST_PLUGIN_ROOT ?? fileURLToPath(new URL("../../", import.meta.url));
const broker = path.join(pluginRoot, "mcp-server/dist/session-message-broker.mjs");
const fixture = new URL("./fixtures/broker-endpoint-failure.mjs", import.meta.url).href;
const responseLossFixture = new URL("./fixtures/message-response-loss.mjs", import.meta.url).href;
const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 10 });
});

async function launch(mode: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "broker-lifecycle-"));
  directories.push(directory);
  await writeFile(path.join(directory, "endpoint.json"), "previous endpoint\n");
  if (mode === "database") await mkdir(path.join(directory, "session-messages.sqlite3"));
  if (mode === "credentials") await mkdir(path.join(directory, "broker.token"));
  const child = spawn(process.execPath, ["--import", fixture, broker, "--state-directory", directory], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, BROKER_TEST_RENAME_FAILURE: mode },
  });
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  return { directory, child, stderr: () => stderr };
}

it("retries transient endpoint publication failures and serves the published endpoint", async () => {
  const { directory, child } = await launch("transient");
  await waitForSessionMessageBrokerReady(directory, child, 3000);
  expect(JSON.parse(await readFile(path.join(directory, "endpoint.json"), "utf8")).pid).toBe(child.pid);
  await expect(requestSessionMessageOnce("ping", {}, directory)).resolves.toMatchObject({
    protocolVersion: "1.0.0",
    capabilities: ["atomic-wake-claim", "deferred-boundary", "delivery-capabilities", "peer-wait-policy"],
  });
  expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

it.each(["permanent", "ENOSPC", "credentials", "database"])("releases startup resources after %s failure and allows recovery", async (mode) => {
  const { directory, child, stderr } = await launch(mode);
  await expect(waitForSessionMessageBrokerReady(directory, child, 3000)).rejects.toThrow(/exited before it was ready/u);
  expect(child.exitCode).toBe(1);
  expect(stderr()).toContain(mode === "permanent" ? "EPERM" : mode === "ENOSPC" ? "ENOSPC" : "startup failed");
  expect(await readFile(path.join(directory, "endpoint.json"), "utf8")).toBe("previous endpoint\n");
  expect(await readdir(directory)).not.toContain("broker.lock");
  expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  if (mode === "database") await rm(path.join(directory, "session-messages.sqlite3"), { recursive: true });
  if (mode === "credentials") await rm(path.join(directory, "broker.token"), { recursive: true });
  const recovered = spawn(process.execPath, [broker, "--state-directory", directory], { windowsHide: true, stdio: "ignore" });
  children.push(recovered);
  await waitForSessionMessageBrokerReady(directory, recovered, 3000);
  await expect(requestSessionMessageOnce("ping", {}, directory)).resolves.toMatchObject({
    protocolVersion: "1.0.0",
    capabilities: ["atomic-wake-claim", "deferred-boundary", "delivery-capabilities", "peer-wait-policy"],
  });
});

it("delivers and acknowledges a message using only the packaged CLI and broker", async () => {
  const { directory, child } = await launch("transient");
  await waitForSessionMessageBrokerReady(directory, child, 3000);
  const sender = { host: "test-sender", sessionId: "sender" };
  const target = { host: "test-target", sessionId: "target" };
  const request = (operation: string, payload: Record<string, unknown>) => {
    const result = spawnSync(process.execPath, [path.join(pluginRoot, "mcp-server/dist/session-message-cli.mjs")], {
      input: JSON.stringify({ operation, payload }), encoding: "utf8", timeout: 5000, windowsHide: true,
      env: { ...process.env, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: directory },
    });
    expect(result.status, result.stderr).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.ok).toBe(true);
    return response.data;
  };
  const { messageId } = request("prepare", { sender, target, body: "Synthetic lifecycle check" });
  request("send", { sender, messageId });
  expect(request("claim", { target }).messages).toHaveLength(1);
  expect(request("acknowledge", { target, messageIds: [messageId] }).acknowledged).toBe(1);
  expect(request("status", { sender, messageId }).status.state).toBe("acknowledged");
});

it("isolates socket resets and a lost send response while preserving the broker and one committed message", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "broker-reset-"));
  directories.push(directory);
  const countsPath = path.join(directory, "operation-counts.json");
  const child = spawn(process.execPath, ["--import", responseLossFixture, broker, "--state-directory", directory], {
    windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, AGS_DROP_MESSAGE_OPERATION: "send", AGS_FORCE_SOCKET_ERROR: "1", AGS_MESSAGE_COUNTS_PATH: countsPath },
  });
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.once("close", (code, signal) => { if (code !== 0) console.info("Disposable reset broker exited:", { code, signal, stderr }); });
  await waitForSessionMessageBrokerReady(directory, child, 5000);
  const endpoint = JSON.parse(await readFile(path.join(directory, "endpoint.json"), "utf8")) as { pid: number; port: number };
  // An actual TCP reset before TLS and an injected TLS error after commit are separate cases.
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: endpoint.port });
    socket.once("connect", () => socket.resetAndDestroy());
    socket.once("close", () => resolve()); socket.once("error", reject);
  });
  const sender = { host: "fixture", sessionId: "reset-sender" };
  const target = { host: "fixture", sessionId: "reset-target" };
  const draft = await requestSessionMessageOnce<{ messageId: string }>("prepare", { sender, target, body: "One immutable message" }, directory);
  await expect(requestSessionMessageOnce("send", { sender, messageId: draft.messageId }, directory, 500)).rejects.toThrow();
  await expect(requestSessionMessageOnce("ping", {}, directory)).resolves.toHaveProperty("protocolVersion", "1.0.0");
  expect(child.exitCode, stderr).toBeNull();
  expect(JSON.parse(await readFile(path.join(directory, "endpoint.json"), "utf8")).pid).toBe(endpoint.pid);
  await expect(requestSessionMessageOnce("unknown-operation", {}, directory)).rejects.toThrow(/Unknown broker operation/u);
  await expect(requestSessionMessageOnce("status", { sender, messageId: draft.messageId }, directory)).resolves.toMatchObject({ status: { state: "queued", deliveryAttempts: 0 } });
  await expect(requestSessionMessageOnce("send", { sender, messageId: draft.messageId }, directory)).resolves.toMatchObject({ messageId: draft.messageId, duplicate: true });
  await expect(requestSessionMessageOnce("pending", { target }, directory)).resolves.toEqual({ count: 1 });
  await expect(requestSessionMessageOnce("claim", { target }, directory)).resolves.toMatchObject({ messages: [{ messageId: draft.messageId, body: "One immutable message" }] });
  await expect(requestSessionMessageOnce("acknowledge", { target, messageIds: [draft.messageId] }, directory)).resolves.toEqual({ acknowledged: 1 });
  expect(JSON.parse(await readFile(countsPath, "utf8"))).toMatchObject({ send: 2, responseDrops: 1 });
});
