import childProcess, { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import tls from "node:tls";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { ensureSessionMessageBroker, requestSessionMessageOnce, waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";

import { producerFailureReason } from "../../mcp-server/src/failure-diagnostics.js";
import { SESSION_MESSAGE_MAX_REQUEST_BYTES, SESSION_MESSAGE_MAX_RESPONSE_BYTES, SESSION_MESSAGE_PROTOCOL, sessionMessageLineReader } from "../../mcp-server/src/session-message-protocol.js";

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
  const started = performance.now();
  const child = spawn(process.execPath, ["--import", fixture, broker, "--state-directory", directory], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, BROKER_TEST_RENAME_FAILURE: mode },
  });
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  async function diagnose(error: unknown) {
    const snapshot = {
      mode, pid: child.pid, elapsedMs: performance.now() - started,
      exitCode: child.exitCode, signalCode: child.signalCode,
      error: error instanceof Error ? error.message : String(error),
      stderr: stderr.slice(0, 8192), stderrTruncated: stderr.length > 8192,
    };
    async function fileState(name: string) {
      try {
        if (name === "broker.lock") {
          const owners = await readdir(path.join(directory, name));
          return { exists: true, kind: "directory", owners };
        }
        const file = await open(path.join(directory, name), "r");
        try {
          const buffer = Buffer.alloc(4096);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          return { exists: true, content: buffer.subarray(0, bytesRead).toString("utf8"),
            truncated: (await file.stat()).size > bytesRead };
        } finally {
          await file.close();
        }
      } catch (failure) {
        const code = (failure as NodeJS.ErrnoException).code;
        return { exists: code === "ENOENT" ? false : null, errorCode: code ?? "UNKNOWN" };
      }
    }
    const [endpoint, lock] = await Promise.all([fileState("endpoint.json"), fileState("broker.lock")]);
    console.error("Disposable broker readiness failure:", { ...snapshot, endpoint, lock });
  }
  return { directory, child, stderr: () => stderr, diagnose };
}

it("retries transient endpoint publication failures and serves the published endpoint", async () => {
  const { directory, child, diagnose } = await launch("transient");
  try {
    await waitForSessionMessageBrokerReady(directory, child, 3000);
  } catch (error) {
    await diagnose(error).catch(() => {});
    throw error;
  }
  expect(JSON.parse(await readFile(path.join(directory, "endpoint.json"), "utf8"))).toMatchObject({ pid: child.pid, claimReceiptVersion: 1 });
  await expect(requestSessionMessageOnce("ping", {}, directory)).resolves.toMatchObject({
    protocolVersion: "1.0.0",
    capabilities: ["atomic-wake-claim", "deferred-boundary", "delivery-capabilities", "peer-wait-policy", "verified-relay-start", "claim-receipts-v1"],
  });
  expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

it.each(["permanent", "ENOSPC", "credentials", "database"])("releases startup resources after %s failure and allows recovery", async (mode) => {
  const { directory, child, stderr, diagnose } = await launch(mode);
  try {
    await expect(waitForSessionMessageBrokerReady(directory, child, 3000)).rejects.toThrow(/exited before it was ready/u);
  } catch (error) {
    await diagnose(error).catch(() => {});
    throw error;
  }
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
    capabilities: ["atomic-wake-claim", "deferred-boundary", "delivery-capabilities", "peer-wait-policy", "verified-relay-start", "claim-receipts-v1"],
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
  const claimed = request("claim", { target }).messages;
  expect(claimed).toHaveLength(1);
  expect(request("acknowledge", { target, messageIds: [messageId], receipts: claimed.map((message: { messageId: string; claimReceipt: string }) => ({ messageId: message.messageId, claimReceipt: message.claimReceipt })) }).acknowledged).toBe(1);
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
  const claimed = await requestSessionMessageOnce<{ messages: Array<{ messageId: string; claimReceipt: string }> }>("claim", { target }, directory);
  expect(claimed).toMatchObject({ messages: [{ messageId: draft.messageId, body: "One immutable message" }] });
  await expect(requestSessionMessageOnce("acknowledge", { target, messageIds: [draft.messageId], receipts: claimed.messages.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt })) }, directory)).resolves.toEqual({ acknowledged: 1 });
  expect(JSON.parse(await readFile(countsPath, "utf8"))).toMatchObject({ send: 2, responseDrops: 1 });
});

it.each(["empty-directory", "legacy-empty-file", "legacy-pid-file"] as const)(
  "reports preserved unsupported lock state through the packaged CLI (%s)", async mode => {
    const directory = await mkdtemp(path.join(tmpdir(), "broker-lock-diagnostic-"));
    directories.push(directory);
    const lockPath = path.join(directory, "broker.lock");
    const legacyBytes = mode === "legacy-pid-file" ? "999999\n" : "";
    if (mode === "empty-directory") await mkdir(lockPath);
    else await writeFile(lockPath, legacyBytes, "utf8");
    await writeFile(path.join(directory, "endpoint.json"), "previous endpoint\n", "utf8");
    const child = spawn(process.execPath, [broker, "--state-directory", directory], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
    });
    children.push(child);
    let stdout = "", stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const [exitCode, signal] = await once(child, "close");
    expect(signal).toBeNull();
    expect(exitCode).toBe(1);
    const code = mode === "empty-directory" ? "BROKER_LOCK_EMPTY_DIRECTORY" : "BROKER_LOCK_UNSUPPORTED_PATH";
    expect(stderr).toBe(`Session message broker startup failed (${code}).\n`);
    expect(stdout).toBe("");
    expect(await readFile(path.join(directory, "endpoint.json"), "utf8")).toBe("previous endpoint\n");
    if (mode === "empty-directory") expect(await readdir(lockPath)).toEqual([]);
    else expect(await readFile(lockPath, "utf8")).toBe(legacyBytes);
    expect((await readdir(directory)).sort()).toEqual(["broker.lock", "endpoint.json"]);
  });

it("a successfully probed live owner keeps the CLI contention outcome", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "broker-live-contention-"));
  directories.push(directory);
  const owner = "owner-" + process.pid + "-" + "a".repeat(32);
  await mkdir(path.join(directory, "broker.lock", owner), { recursive: true });
  const child = spawn(process.execPath, [broker, "--state-directory", directory], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
  });
  children.push(child);
  let stdout = "", stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const [exitCode, signal] = await once(child, "close");
  expect(signal).toBeNull();
  expect(exitCode).toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
  expect(await readdir(path.join(directory, "broker.lock"))).toEqual([owner]);
  expect(await readdir(directory)).toEqual(["broker.lock"]);
});

it("지원 표시가 없는 기존 endpoint는 명확히 거부하고 자동 새 브로커를 기동하지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "broker-old-receipts-"));
  directories.push(directory);
  const files = {
    "endpoint.json": JSON.stringify({ protocolVersion: "1.0.0", address: "127.0.0.1", port: 1,
      pid: process.pid, startedAt: new Date(0).toISOString(), certificateFingerprint256: Array(32).fill("AA").join(":") }),
    "broker.token": "a".repeat(43),
    "broker-cert.pem": "synthetic certificate: endpoint support is checked before TLS",
  };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(directory, name), content, "utf8");
  const automaticSpawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => { throw new Error("Unexpected automatic broker spawn."); });
  const prepare = vi.fn(async () => { throw new Error("Unexpected state preparation."); });
  syncBuiltinESMExports();
  try {
    const directError = await requestSessionMessageOnce("ping", {}, directory).catch(error => error);
    expect(directError).toBeInstanceOf(Error);
    expect(producerFailureReason(directError)).toBe("BROKER_CLAIM_RECEIPTS_REQUIRED");
    const ensureError = await ensureSessionMessageBroker(directory, 1000, undefined, prepare).catch(error => error);
    expect(ensureError).toBeInstanceOf(Error);
    expect(producerFailureReason(ensureError)).toBe("BROKER_CLAIM_RECEIPTS_REQUIRED");
    expect(prepare).not.toHaveBeenCalled();
    expect(automaticSpawn).not.toHaveBeenCalled();
    expect((await readdir(directory)).sort()).toEqual(Object.keys(files).sort());
    for (const [name, content] of Object.entries(files)) expect(await readFile(path.join(directory, name), "utf8")).toBe(content);
  } finally {
    automaticSpawn.mockRestore();
    syncBuiltinESMExports();
  }
});


it("실제 TLS 입구는 구형 인수 frame을 상태 변경과 영수증 노출 전에 거부하고 정상 소비자는 원영수증으로 ACK한다", async () => {
  const { directory, child } = await launch("transient");
  await waitForSessionMessageBrokerReady(directory, child, 3000);
  const sender = { host: "fixture", sessionId: "receipt-negotiation-sender" };
  const target = { host: "fixture", sessionId: "receipt-negotiation-target" };
  const send = async (body: string) => {
    const draft = await requestSessionMessageOnce<{ messageId: string }>("prepare", { sender, target, body }, directory);
    await requestSessionMessageOnce("send", { sender, messageId: draft.messageId }, directory);
    return draft.messageId;
  };
  const previousId = await send("already claimed negotiation body");
  const previous = await requestSessionMessageOnce<{ messages: Array<{ messageId: string; claimReceipt: string }> }>("claim", { target }, directory);
  expect(previous.messages).toMatchObject([{ messageId: previousId }]);
  const previousReceipt = previous.messages[0]!.claimReceipt;
  expect(previousReceipt).toMatch(/^1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  const body = "pending original negotiation body";
  const messageId = await send(body);
  const endpoint = JSON.parse(await readFile(path.join(directory, "endpoint.json"), "utf8")) as { address: string; port: number; certificateFingerprint256: string };
  const token = (await readFile(path.join(directory, "broker.token"), "utf8")).trim();
  const certificate = await readFile(path.join(directory, "broker-cert.pem"), "utf8");
  const inspector = new DatabaseSync(path.join(directory, "session-messages.sqlite3"), { readOnly: true });
  try {
    const snapshot = () => Object.fromEntries([
      "messages", "prepared_messages", "input_observations", "session_activity", "wake_nonces", "session_presence", "relay_leases",
    ].map(table => [table, inspector.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = snapshot();
    const rawFrame = async (operation: string, version: unknown): Promise<string> => {
      // 실제 구 소비자의 outer frame을 직접 보낸다. trusted 내부 dispatch로 협상 검사를 대신하지 않는다.
      const frame = Buffer.from(JSON.stringify({ protocolVersion: SESSION_MESSAGE_PROTOCOL, token, operation, payload: { target },
        ...(version === undefined ? {} : { claimReceiptVersion: version }) }) + "\n");
      expect(frame.length).toBeLessThanOrEqual(SESSION_MESSAGE_MAX_REQUEST_BYTES);
      return new Promise((resolve, reject) => {
        const readLine = sessionMessageLineReader(SESSION_MESSAGE_MAX_RESPONSE_BYTES);
        let settled = false;
        const socket = tls.connect({ host: endpoint.address, port: endpoint.port, ca: certificate, servername: "localhost",
          minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: true,
          checkServerIdentity: (_host, peer) => peer.fingerprint256 === endpoint.certificateFingerprint256
            ? undefined : new Error("Owned fixture certificate pin mismatch."),
        });
        const finish = (error?: Error, line?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          socket.destroy();
          if (error) reject(error); else resolve(line!);
        };
        const deadline = setTimeout(() => finish(new Error("Owned TLS frame deadline exceeded.")), 2500);
        socket.once("error", error => finish(error));
        socket.once("end", () => finish(new Error("Owned TLS frame ended before a complete response.")));
        socket.once("secureConnect", () => socket.write(frame));
        socket.on("data", (chunk: Buffer) => {
          try { const line = readLine(chunk); if (line !== null) finish(undefined, line); }
          catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
        });
      });
    };
    // 독립 목록을 써 제품의 연산 목록 누락도 검출한다. 누락·다른 버전·문자열 표지를 각각 보낸다.
    for (const operation of ["claim", "claim-wake", "claim-host-wake", "claim-deferred", "claim-turn-end"]) {
      for (const version of [undefined, 2, "1"]) {
        const line = await rawFrame(operation, version);
        const rejected = JSON.parse(line);
        expect(rejected, operation).toMatchObject({ ok: false, error: expect.stringContaining("BROKER_CLAIM_RECEIPTS_REQUIRED") });
        expect(Object.keys(rejected).sort()).toEqual(["error", "ok"]);
        expect(line).not.toContain(previousReceipt);
        expect(line).not.toContain(body);
        expect(snapshot()).toEqual(before);
      }
    }
    expect(inspector.prepare("SELECT delivery_attempts, claim_receipt, claimed_at FROM messages WHERE message_id = ?").get(messageId))
      .toMatchObject({ delivery_attempts: 0, claim_receipt: null, claimed_at: null });
    const claimed = await requestSessionMessageOnce<{ messages: Array<{ messageId: string; body: string; claimReceipt: string }> }>("claim", { target }, directory);
    expect(claimed.messages).toMatchObject([{ messageId, body }]);
    const originalReceipt = claimed.messages[0]!.claimReceipt;
    expect(originalReceipt).toMatch(/^1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    await expect(requestSessionMessageOnce("acknowledge", { target, messageIds: [messageId],
      receipts: [{ messageId, claimReceipt: originalReceipt }] }, directory)).resolves.toEqual({ acknowledged: 1 });
    await expect(requestSessionMessageOnce("status", { sender, messageId }, directory)).resolves.toMatchObject({ status: { state: "acknowledged", deliveryAttempts: 1 } });
  } finally { inspector.close(); }
}, 15_000);
