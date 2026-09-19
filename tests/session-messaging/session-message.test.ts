import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureSessionMessageBroker,
  parseWakeMessages,
  requestSessionMessageOnce,
  sessionMessageBrokerEnvironment,
  SESSION_MESSAGE_PROTOCOL,
} from "../../mcp-server/src/session-message-client.js";
import { runSessionMessageCli } from "../../mcp-server/src/session-message-cli.js";
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import { wakeBackoffDelay } from "../../mcp-server/src/session-message-relay.js";
import { MESSAGE_BODY_MAX_BYTES, SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import { processIdentityState, processStartToken, processStillMatches } from "../../mcp-server/src/process-identity.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { CURRENT_VERSION } from "../mcp/version-fixtures.js";

const directories: string[] = [];
const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for test state.");
}

async function terminateBroker(stateDirectory: string): Promise<void> {
  const endpointPath = path.join(stateDirectory, "endpoint.json");
  try {
    const endpoint = JSON.parse(await readFile(endpointPath, "utf8")) as { pid: number };
    try { process.kill(endpoint.pid, "SIGTERM"); } catch { /* Already stopped. */ }
    await waitUntil(async () => {
      try { await readFile(endpointPath); return false; } catch { return true; }
    });
  } catch { /* No broker was started. */ }
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await terminateBroker(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

function stateDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "session-messaging-"));
  directories.push(directory);
  return directory;
}

describe("session message spool", () => {
  it("keeps stable IDs until ACK, enforces limits, and recovers stale relay leases", () => {
    const directory = stateDirectory();
    const databasePath = path.join(directory, "messages.sqlite3");
    const grok = { host: "grok", sessionId: "grok-1" };
    const spark = { host: "spark", sessionId: "spark-1" };
    const store = new SessionMessageStore(databasePath);
    const first = store.send({ messageId: "msg-0001", sender: grok, target: spark, body: "hello", ttlSeconds: 600 }, 1000);
    expect(store.send({ messageId: "msg-0001", sender: grok, target: spark, body: "hello", ttlSeconds: 600 }, 2000)).toMatchObject({ ...first, duplicate: true });
    expect(() => store.send({ messageId: "msg-0001", sender: grok, target: spark, body: "changed" }, 2000)).toThrow(/different message/u);
    expect(() => store.send({ sender: grok, target: spark, body: "x".repeat(MESSAGE_BODY_MAX_BYTES + 1) }, 2000)).toThrow(/4096/u);
    expect(() => store.send({ sender: grok, target: spark, body: "가".repeat(2048) }, 2000)).toThrow(/4096/u);
    expect(() => store.send({ sender: grok, target: spark, body: "ttl", ttlSeconds: 29 }, 2000)).toThrow(/ttlSeconds/u);
    expect(() => store.send({ sender: grok, target: spark, body: "ttl", ttlSeconds: 86401 }, 2000)).toThrow(/ttlSeconds/u);

    expect(store.claim(spark, 3000).map((message) => message.messageId)).toEqual(["msg-0001"]);
    expect(store.claim(spark, 4000)).toEqual([]);
    expect(store.pendingCount(spark, 4000)).toBe(0);
    store.close();

    const reopened = new SessionMessageStore(databasePath);
    expect(reopened.claim(spark, 123_001).map((message) => message.messageId)).toEqual(["msg-0001"]);
    expect(reopened.acknowledge(spark, ["msg-0001"], 124_000)).toBe(1);
    expect(reopened.pendingCount(spark, 125_000)).toBe(0);

    expect(reopened.acquireRelay({ ...spark, transport: "generic", relayId: "relay-a", pid: 1, parentPid: 1 }, 200_000)).toBe(true);
    expect(reopened.acquireRelay({ ...spark, transport: "generic", relayId: "relay-b", pid: 2, parentPid: 2 }, 201_000)).toBe(false);
    expect(reopened.acquireRelay({ ...spark, transport: "generic", relayId: "relay-b", pid: 2, parentPid: 2 }, 216_000)).toBe(true);
    reopened.issueWake(spark, "nonce-abcdefghijklmnop", 220_000);
    expect(reopened.consumeWake(spark, "nonce-abcdefghijklmnop", 221_000)).toBe(true);
    expect(reopened.consumeWake(spark, "nonce-abcdefghijklmnop", 222_000)).toBe(true);
    expect(reopened.consumeWake(spark, "nonce-abcdefghijklmnop", 220_000 + 86_400_000)).toBe(false);
    reopened.close();
  });

  it("applies caller claim budgets before leasing messages", () => {
    const store = new SessionMessageStore(":memory:");
    const sender = { host: "grok", sessionId: "grok-budget" };
    const target = { host: "spark", sessionId: "spark-budget" };
    store.send({ messageId: "budget-0001", sender, target, body: "abcd" }, 1000);
    store.send({ messageId: "budget-0002", sender, target, body: "efgh" }, 1001);
    expect(store.claim(target, 2000, { maxMessages: 10, maxBodyChars: 4 }).map((message) => message.messageId)).toEqual(["budget-0001"]);
    expect(store.claim(target, 2000, { maxMessages: 1, maxBodyChars: 4 }).map((message) => message.messageId)).toEqual(["budget-0002"]);
    expect(() => store.claim(target, 2000, { maxMessages: 0 })).toThrow(/maxMessages/u);
    expect(() => store.claim(target, 2000, { maxBodyChars: 0 })).toThrow(/maxBodyChars/u);
    store.close();
  });

  it("caps the unacknowledged spool and expires messages", () => {
    const store = new SessionMessageStore(":memory:");
    const sender = { host: "generic-a", sessionId: "a" };
    const target = { host: "generic-b", sessionId: "b" };
    for (let index = 0; index < 1000; index += 1) {
      store.send({ messageId: `bounded-${String(index).padStart(4, "0")}`, sender, target, body: "x", ttlSeconds: 60 }, 1000);
    }
    expect(() => store.send({ messageId: "bounded-overflow", sender, target, body: "x", ttlSeconds: 60 }, 1000)).toThrow(/spool is full/u);
    expect(store.pendingCount(target, 61_001)).toBe(0);
    store.close();
  });
});

describe("TLS 1.3 broker and vendor-neutral adapter", () => {
  it("rejects a reused PID when its process-start token changes", () => {
    const token = processStartToken(process.pid);
    expect(token).toBeTruthy();
    if (!token) throw new Error("The current process must expose a start token for this platform test.");
    expect(processStillMatches(process.pid, token)).toBe(true);
    expect(processStillMatches(process.pid, `${token}-different`)).toBe(false);
    expect(processStillMatches(process.pid, "")).toBe(false);
    expect(processIdentityState(process.pid, token, () => null)).toBe("unknown");
    expect(processStartToken(2_147_483_647)).toBeNull();
    expect(processStillMatches(2_147_483_647, token)).toBe(false);
  });

  it("parses merged wake bells without hiding mixed user text", () => {
    const first = "a".repeat(32);
    const second = "b".repeat(32);
    expect(parseWakeMessages(`[agent-governance-suite:wake:${first}]\n[agent-governance-suite:wake:${second}]`))
      .toEqual({ nonces: [first, second], wakeOnly: true });
    expect(parseWakeMessages(`ordinary text\n[agent-governance-suite:wake:${first}]`))
      .toEqual({ nonces: [first], wakeOnly: false });
    expect(parseWakeMessages(`[agent-governance-suite:wake:${first}]\n[agent-governance-suite:wake:bad]`))
      .toEqual({ nonces: [first], wakeOnly: false });
  });

  it("backs off repeated wake hints without exceeding ten minutes", () => {
    expect([0, 1, 2, 5, 20].map(wakeBackoffDelay)).toEqual([30_000, 60_000, 120_000, 600_000, 600_000]);
  });

  it("does not pass Claude inbox credentials into the broker process", () => {
    expect(sessionMessageBrokerEnvironment({
      KEEP_ME: "yes",
      CLAUDE_CODE_MESSAGING_SOCKET: "socket-secret",
      CLAUDE_CODE_MESSAGING_TOKEN: "token-secret",
    })).toEqual({ KEEP_ME: "yes" });
  });

  it("pins the certificate, authenticates requests, survives restart, and supports arbitrary hosts", async () => {
    const directory = stateDirectory();
    await ensureSessionMessageBroker(directory);
    const endpointPath = path.join(directory, "endpoint.json");
    const endpoint = JSON.parse(await readFile(endpointPath, "utf8")) as { port: number; pid: number; certificateFingerprint256: string };
    const certificate = await readFile(path.join(directory, "broker-cert.pem"), "utf8");
    const token = (await readFile(path.join(directory, "broker.token"), "utf8")).trim();

    const negotiated = await new Promise<string | null>((resolve, reject) => {
      const socket = tls.connect({ host: "127.0.0.1", port: endpoint.port, ca: certificate, servername: "localhost", minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
      socket.once("secureConnect", () => { const protocol = socket.getProtocol(); socket.destroy(); resolve(protocol); });
      socket.once("error", reject);
    });
    expect(negotiated).toBe("TLSv1.3");

    const wrongToken = await new Promise<Record<string, unknown>>((resolve, reject) => {
      let output = "";
      const socket = tls.connect({ host: "127.0.0.1", port: endpoint.port, ca: certificate, servername: "localhost", minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
      socket.once("secureConnect", () => socket.write(`${JSON.stringify({ protocolVersion: SESSION_MESSAGE_PROTOCOL, token: "wrong", operation: "ping", payload: {} })}\n`));
      socket.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      socket.once("end", () => resolve(JSON.parse(output) as Record<string, unknown>));
      socket.once("error", reject);
    });
    expect(wrongToken).toMatchObject({ ok: false, error: "Broker authentication failed." });

    const wrongFingerprint = Array.from({ length: 32 }, () => "00").join(":");
    await writeFile(endpointPath, `${JSON.stringify({ ...endpoint, protocolVersion: SESSION_MESSAGE_PROTOCOL, address: "127.0.0.1", startedAt: new Date().toISOString(), certificateFingerprint256: wrongFingerprint })}\n`, "utf8");
    await expect(requestSessionMessageOnce("ping", {}, directory)).rejects.toThrow(/certificate pin/u);
    await writeFile(endpointPath, `${JSON.stringify({ ...endpoint, protocolVersion: SESSION_MESSAGE_PROTOCOL, address: "127.0.0.1", startedAt: new Date().toISOString() })}\n`, "utf8");

    const send = await runSessionMessageCli(JSON.stringify({
      operation: "send",
      payload: { messageId: "portable-0001", sender: { host: "grok", sessionId: "g-1" }, target: { host: "spark", sessionId: "s-1" }, body: "portable hello", ttlSeconds: 600 },
    }), directory);
    expect(send).toMatchObject({ ok: true, data: { messageId: "portable-0001" } });
    const generatedId = await runSessionMessageCli(JSON.stringify({
      operation: "send",
      payload: { sender: { host: "grok", sessionId: "g-1" }, target: { host: "spark", sessionId: "s-2" }, body: "client-generated identifier", ttlSeconds: 600 },
    }), directory);
    expect((generatedId.data as { messageId: string }).messageId).toMatch(/^[0-9a-f-]{36}$/u);

    const escapedBody = "\0".repeat(4000);
    for (const messageId of ["escaped-0001", "escaped-0002"]) {
      await runSessionMessageCli(JSON.stringify({
        operation: "send",
        payload: { messageId, sender: { host: "grok", sessionId: "g-1" }, target: { host: "spark", sessionId: "escaped" }, body: escapedBody, ttlSeconds: 600 },
      }), directory);
    }
    const firstEscaped = await runSessionMessageCli(JSON.stringify({ operation: "claim", payload: { target: { host: "spark", sessionId: "escaped" } } }), directory);
    expect(firstEscaped).toMatchObject({ data: { messages: [{ messageId: "escaped-0001", body: escapedBody }] } });
    expect((firstEscaped.data as { messages: unknown[] }).messages).toHaveLength(1);
    await runSessionMessageCli(JSON.stringify({ operation: "acknowledge", payload: { target: { host: "spark", sessionId: "escaped" }, messageIds: ["escaped-0001"] } }), directory);
    const secondEscaped = await runSessionMessageCli(JSON.stringify({ operation: "claim", payload: { target: { host: "spark", sessionId: "escaped" } } }), directory);
    expect(secondEscaped).toMatchObject({ data: { messages: [{ messageId: "escaped-0002", body: escapedBody }] } });

    const metadataTarget = { host: "spark", sessionId: "wire-sized" };
    const metadataSender = { host: "가".repeat(64), sessionId: "나".repeat(200) };
    const expectedMetadataIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const messageId = `wire-${String(index).padStart(3, "0")}-${"m".repeat(119)}`;
      expectedMetadataIds.push(messageId);
      await runSessionMessageCli(JSON.stringify({
        operation: "send",
        payload: { messageId, sender: metadataSender, target: metadataTarget, body: "\0".repeat(400), ttlSeconds: 600 },
      }), directory);
    }
    const claimedMetadataIds: string[] = [];
    let batchCount = 0;
    while (claimedMetadataIds.length < expectedMetadataIds.length) {
      const batch = await runSessionMessageCli(JSON.stringify({
        operation: "claim",
        payload: { target: metadataTarget, maxMessages: 10, maxBodyChars: 800 },
      }), directory);
      const messages = (batch.data as { messages: Array<{ messageId: string }> }).messages;
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.length).toBeLessThanOrEqual(2);
      expect(Buffer.byteLength(JSON.stringify(batch), "utf8")).toBeLessThanOrEqual(32 * 1024);
      batchCount += 1;
      claimedMetadataIds.push(...messages.map((message) => message.messageId));
      await runSessionMessageCli(JSON.stringify({ operation: "acknowledge", payload: { target: metadataTarget, messageIds: messages.map((message) => message.messageId) } }), directory);
    }
    expect(batchCount).toBeGreaterThan(1);
    expect(claimedMetadataIds).toEqual(expectedMetadataIds);

    await terminateBroker(directory);
    await ensureSessionMessageBroker(directory);
    const claim = await runSessionMessageCli(JSON.stringify({ operation: "claim", payload: { target: { host: "spark", sessionId: "s-1" } } }), directory);
    expect(claim).toMatchObject({ ok: true, data: { messages: [{ messageId: "portable-0001", body: "portable hello" }] } });
    const acknowledged = await runSessionMessageCli(JSON.stringify({ operation: "acknowledge", payload: { target: { host: "spark", sessionId: "s-1" }, messageIds: ["portable-0001"] } }), directory);
    expect(acknowledged).toMatchObject({ ok: true, data: { acknowledged: 1 } });

    const database = await readFile(path.join(directory, "session-messages.sqlite3"));
    const privateKey = await readFile(path.join(directory, "broker-key.pem"));
    expect(database.includes(Buffer.from(token))).toBe(false);
    expect(database.includes(privateKey)).toBe(false);
    expect(database.includes(Buffer.from("claude-inbox-token-probe"))).toBe(false);
    expect(database.includes(Buffer.from("cc-msg-socket-probe"))).toBe(false);
  }, 30_000);

  it("keeps built-in hook context below the Claude injection limit", async () => {
    const directory = stateDirectory();
    const previous = process.env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR;
    process.env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR = directory;
    try {
      const target = { host: "codex", sessionId: "budget-hook" };
      for (const messageId of ["hook-budget-0001", "hook-budget-0002"]) {
        await runSessionMessageCli(JSON.stringify({
          operation: "send",
          payload: { messageId, sender: { host: "grok", sessionId: "grok-budget" }, target, body: "x".repeat(4096), ttlSeconds: 600 },
        }), directory);
      }
      const output = await handleSessionMessageHook({ hook_event_name: "UserPromptSubmit", session_id: target.sessionId }, "codex");
      const context = (output.hookSpecificOutput as { additionalContext: string }).additionalContext;
      expect(context.length).toBeLessThanOrEqual(9_000);
      expect(context).toContain("hook-budget-0001");
      expect(context).not.toContain("hook-budget-0002");
    } finally {
      if (previous === undefined) delete process.env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR;
      else process.env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR = previous;
    }
  }, 30_000);

  it("binds message tools to host hook identity", async () => {
    const output = await handleSessionMessageHook({
      hook_event_name: "PreToolUse",
      session_id: "third-party-session",
      tool_name: "mcp__suite__send_session_message",
      tool_input: { targetHost: "spark", targetSessionId: "s-1", body: "hello", _sessionBinding: { host: "forged", sessionId: "forged" } },
    }, "codex");
    expect(output).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { _sessionBinding: { host: "codex", sessionId: "third-party-session" } } } });
  });

  it("does not speak plaintext on the loopback port", async () => {
    const directory = stateDirectory();
    await ensureSessionMessageBroker(directory);
    const endpoint = JSON.parse(await readFile(path.join(directory, "endpoint.json"), "utf8")) as { port: number };
    const response = await new Promise<string>((resolve) => {
      let output = "";
      const socket = net.createConnection({ host: "127.0.0.1", port: endpoint.port });
      socket.setTimeout(2000, () => socket.destroy());
      socket.once("connect", () => socket.end('{"operation":"ping"}\n'));
      socket.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      socket.once("close", () => resolve(output));
      socket.once("error", () => resolve(output));
    });
    expect(response).not.toContain('"ok":true');
  });
});

describe("session message MCP tools", () => {
  async function connect(directory: string): Promise<Client> {
    const validator = new ContractValidator();
    const updateStore = new InMemoryPluginUpdateStore();
    updateStore.putPluginUpdateState({
      targetId: "agent-governance-suite", currentVersion: CURRENT_VERSION, latestVersion: CURRENT_VERSION, latestTag: `v${CURRENT_VERSION}`,
      latestCommit: "d".repeat(40), etag: "session-messages", comparison: "up-to-date", lastAttemptAt: "2026-09-19T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-09-19T00:00:00.000Z", nextCheckAt: "2099-01-01T00:00:00.000Z", lastNotifiedVersion: null,
      lastNotifiedAt: null, lastErrorCode: null,
    });
    const workflow = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore());
    const server = createMcpServer(workflow, new PluginUpdateService(updateStore), undefined, undefined, undefined, validator, "default", null, null, new SessionMessageService(directory));
    const client = new Client({ name: "session-messages", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  const payload = (response: unknown) => JSON.parse((response as { content: Array<{ text: string }> }).content[0]!.text) as { ok: boolean; data: Record<string, unknown>; error: { code: string } | null };

  it("validates bound send, status, and acknowledgement calls", async () => {
    const directory = stateDirectory();
    const client = await connect(directory);
    const sender = { host: "grok", sessionId: "grok-mcp" };
    const target = { host: "spark", sessionId: "spark-mcp" };
    const unbound = payload(await client.callTool({ name: "send_session_message", arguments: { schemaVersion: "1.0.0", targetHost: target.host, targetSessionId: target.sessionId, body: "hello" } }));
    expect(unbound.error?.code).toBe("BINDING_REQUIRED");

    const sent = payload(await client.callTool({ name: "send_session_message", arguments: { schemaVersion: "1.0.0", targetHost: target.host, targetSessionId: target.sessionId, body: "hello", messageId: "mcp-msg-0001", _sessionBinding: sender } }));
    expect(sent).toMatchObject({ ok: true, data: { messageId: "mcp-msg-0001" } });
    expect(payload(await client.callTool({ name: "get_session_message_status", arguments: { schemaVersion: "1.0.0", messageId: "mcp-msg-0001", _sessionBinding: sender } }))).toMatchObject({ ok: true, data: { status: { state: "queued" } } });

    const claimed = await runSessionMessageCli(JSON.stringify({ operation: "claim", payload: { target } }), directory);
    expect(claimed).toMatchObject({ data: { messages: [{ messageId: "mcp-msg-0001" }] } });
    expect(payload(await client.callTool({ name: "acknowledge_session_messages", arguments: { schemaVersion: "1.0.0", messageIds: ["mcp-msg-0001"], _sessionBinding: target } }))).toMatchObject({ ok: true, data: { acknowledged: 1 } });
    expect(payload(await client.callTool({ name: "get_session_message_status", arguments: { schemaVersion: "1.0.0", messageId: "mcp-msg-0001", _sessionBinding: sender } }))).toMatchObject({ ok: true, data: { status: { state: "acknowledged" } } });
  }, 30_000);
});
