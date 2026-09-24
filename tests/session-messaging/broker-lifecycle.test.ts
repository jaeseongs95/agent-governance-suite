import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { requestSessionMessageOnce, waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";

const pluginRoot = process.env.BROKER_TEST_PLUGIN_ROOT ?? fileURLToPath(new URL("../../", import.meta.url));
const broker = path.join(pluginRoot, "mcp-server/dist/session-message-broker.mjs");
const fixture = new URL("./fixtures/broker-endpoint-failure.mjs", import.meta.url).href;
const children: ChildProcess[] = [];
const directories: string[] = [];

function isolatedEnvironment(directory: string): NodeJS.ProcessEnv {
  const home = path.join(directory, "home");
  return { ...process.env, HOME: home, USERPROFILE: home,
    LOCALAPPDATA: path.join(directory, "local"), XDG_STATE_HOME: path.join(directory, "xdg"),
    AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(directory, "shared"),
    AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: directory };
}

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
    env: { ...isolatedEnvironment(directory), BROKER_TEST_RENAME_FAILURE: mode },
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
    capabilities: ["atomic-wake-claim", "deferred-boundary", "delivery-capabilities", "model-capabilities.v1"],
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
  const recovered = spawn(process.execPath, [broker, "--state-directory", directory], {
    windowsHide: true, stdio: "ignore", env: isolatedEnvironment(directory),
  });
  children.push(recovered);
  await waitForSessionMessageBrokerReady(directory, recovered, 3000);
  await expect(requestSessionMessageOnce("ping", {}, directory)).resolves.toMatchObject({
    protocolVersion: "1.0.0",
    capabilities: ["atomic-wake-claim", "deferred-boundary", "delivery-capabilities", "model-capabilities.v1"],
  });
});

it("delivers and acknowledges a message using only the packaged CLI and broker", async () => {
  const { directory, child } = await launch("transient");
  await waitForSessionMessageBrokerReady(directory, child, 3000);
  const sender = { host: "test-sender", sessionId: "sender" };
  const target = { host: "test-target", sessionId: "target" };
  const messageId = "packaged-broker-lifecycle-message";
  const request = (operation: string, payload: Record<string, unknown>) => {
    const result = spawnSync(process.execPath, [path.join(pluginRoot, "mcp-server/dist/session-message-cli.mjs")], {
      input: JSON.stringify({ operation, payload }), encoding: "utf8", timeout: 5000, windowsHide: true,
      env: isolatedEnvironment(directory),
    });
    expect(result.status, result.stderr).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response.ok).toBe(true);
    return response.data;
  };
  request("send", { sender, target, messageId, body: "Synthetic lifecycle check" });
  expect(request("claim", { target }).messages).toHaveLength(1);
  expect(request("acknowledge", { target, messageIds: [messageId] }).acknowledged).toBe(1);
  expect(request("status", { sender, messageId }).status.state).toBe("acknowledged");
});
