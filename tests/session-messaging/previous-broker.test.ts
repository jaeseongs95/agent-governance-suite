import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { requestSessionMessageOnce, waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";
import { SessionMessageStore, WAKE_RETIRE_GRACE_MS, WAKE_TTL_MS } from "../../mcp-server/src/session-message-store.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";

// A release check supplies the actual previous installation, not a simulated dispatcher.
const previousBroker = process.env.AGS_PREVIOUS_BROKER_PATH;
const pluginRoot = process.env.BROKER_TEST_PLUGIN_ROOT ?? fileURLToPath(new URL("../../", import.meta.url));
it.skipIf(!previousBroker)("preserves queued messages when new hooks meet the previous released broker", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-previous-broker-"));
  const environment = { ...process.env, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: directory,
    AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"),
    AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(directory, "shared-state") };
  const cli = (operation: string, payload: Record<string, unknown>, expectedCode = 0) => {
    const result = spawnSync(process.execPath, [path.join(pluginRoot, "mcp-server/dist/session-message-cli.mjs")], {
      env: environment, input: JSON.stringify({ operation, payload }), encoding: "utf8", windowsHide: true, timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(expectedCode);
    const response = JSON.parse(result.stdout);
    expect(response.ok).toBe(expectedCode === 0);
    return response;
  };
  const hook = (event: string) => {
    const result = spawnSync(process.execPath, [path.join(pluginRoot, "mcp-server/dist/session-message-hook.mjs")], {
      env: environment, input: JSON.stringify({ hook_event_name: event, session_id: "recipient", prompt: "Synthetic native input" }),
      encoding: "utf8", windowsHide: true, timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  const child = spawn(process.execPath, [previousBroker!, "--state-directory", directory], {
    windowsHide: true, stdio: "ignore", env: environment,
  });
  try {
    await waitForSessionMessageBrokerReady(directory, child, 5000);
    const sender = { host: "synthetic-host", sessionId: "sender" };
    const target = { host: "codex", sessionId: "recipient" };
    const body = "Synthetic compatibility check";
    const ping = await requestSessionMessageOnce<{ capabilities?: string[] }>("ping", {}, directory);
    const deferredBoundary = (ping.capabilities ?? []).includes("deferred-boundary");
    let messageId: string;
    if (deferredBoundary) {
      messageId = cli("prepare", { sender, target, body }).data.messageId;
      expect(messageId).toEqual(expect.any(String));
      cli("send", { sender, messageId });
      expect(cli("send", { sender, messageId }).data.duplicate).toBe(true);
      expect(cli("send", { sender, target, messageId, body: "Changed body" }, 1).error).toMatch(/send accepts only sender/u);
    } else {
      expect(cli("prepare", { sender, target, body }, 1).error).toBe("Unknown broker operation.");
      messageId = "previous-broker-compatibility-message";
      cli("send", { sender, target, messageId, body });
    }
    expect(cli("pending", { target }).data.count).toBe(1);
    expect(cli("status", { sender, messageId }).data.status.state).toBe("queued");
    expect(hook("UserPromptSubmit")).toBe("");
    expect(hook("PostToolUse")).toBe("");
    const delivered = hook("PostToolUse");
    if (deferredBoundary) {
      const context = JSON.parse(delivered).hookSpecificOutput.additionalContext as string;
      const lines = context.split("\n");
      expect(lines.filter(line => line === "[agent-governance-suite peer message BEGIN]")).toHaveLength(1);
      const peer = JSON.parse(lines.find(line => line.startsWith("{"))!);
      expect(peer).toMatchObject({ message: body, recipient: target, receipt: { messageId, deliveryAttempt: 1 } });
    } else {
      expect(delivered).toBe("");
    }
    expect(hook("PostToolUse")).toBe("");
    expect(cli("status", { sender, messageId }).data.status.state).toBe(deferredBoundary ? "delivered" : "queued");
    const database = new DatabaseSync(path.join(directory, "session-messages.sqlite3"), { readOnly: true });
    try {
      expect(database.prepare("SELECT delivery_attempts FROM messages WHERE message_id = ?").get(messageId))
        .toEqual({ delivery_attempts: deferredBoundary ? 1 : 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 1 });
    } finally { database.close(); }
    const claimed = cli("claim", { target }).data.messages;
    expect(claimed).toEqual(deferredBoundary ? [] : [expect.objectContaining({ messageId, body })]);
    expect(cli("acknowledge", { target, messageIds: [messageId] }).data.acknowledged).toBe(1);
    expect(cli("status", { sender, messageId }).data.status.state).toBe("acknowledged");
    expect(cli("claim", { target }).data.messages).toEqual([]);
    expect(hook("PostToolUse")).toBe("");
    expect(cli("unknown-operation", {}, 1).error).toBe("Unsupported session message operation.");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10 });
  }
}, 20_000);

it.skipIf(!previousBroker)("lets the previous released broker serve a schema 1 database with a retired wake", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-previous-broker-schema1-"));
  const environment = { ...process.env, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: directory,
    AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"),
    AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(directory, "shared-state") };
  const databasePath = path.join(directory, "session-messages.sqlite3");
  const target = { host: "codex", sessionId: "schema1-recipient" };
  const capabilities = { supportedInjection: ["peer-wake" as const, "tool-boundary" as const], idleWake: "user-message" as const };
  const nonce = "schema1-retired-nonce-abcdefghijklmnop";
  const seed = new SessionMessageStore(databasePath);
  try {
    const base = Date.now() - WAKE_TTL_MS - WAKE_RETIRE_GRACE_MS - 60_000;
    const presence = (instanceId: string, at: number) => {
      seed.startPresence({ ...target, instanceId, transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false,
        deliveryCapabilities: capabilities }, at);
      seed.acquireRelay({ ...target, transport: "codex-queue", relayId: `${instanceId}-relay`, pid: process.pid, parentPid: process.pid }, at);
    };
    presence("old-instance", base);
    seed.send({ sender: { host: "synthetic-host", sessionId: "sender" }, target, messageId: "schema1-old-body", body: "old", ttlSeconds: 86400 }, base);
    const reserved = seed.reserveManagedWake({ ...target, nonce, instanceId: "old-instance", transport: "codex-queue", relayId: "old-instance-relay" }, base);
    seed.recordManagedWakeOutcome(seed.startManagedWake(reserved.attempt!, base + 1).attempt!, "submitted", base + 2);
    presence("new-instance", Date.now());
  } finally { seed.close(); }
  const retiredRow = () => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return { version: (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
        row: database.prepare("SELECT * FROM wake_nonces WHERE nonce = ?").get(nonce) };
    } finally { database.close(); }
  };
  const before = retiredRow();
  expect(before).toMatchObject({ version: 1, row: { state: "expired-unobserved" } });
  const cli = (operation: string, payload: Record<string, unknown>) => {
    const result = spawnSync(process.execPath, [path.join(pluginRoot, "mcp-server/dist/session-message-cli.mjs")], {
      env: environment, input: JSON.stringify({ operation, payload }), encoding: "utf8", windowsHide: true, timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const child = spawn(process.execPath, [previousBroker!, "--state-directory", directory], { windowsHide: true, stdio: "ignore", env: environment });
  let managedWakeAware: boolean | undefined;
  try {
    await waitForSessionMessageBrokerReady(directory, child, 5000);
    const ping = await requestSessionMessageOnce<{ capabilities?: string[] }>("ping", {}, directory);
    managedWakeAware = (ping.capabilities ?? []).includes("delivery-capabilities");
    const sender = { host: "synthetic-host", sessionId: "sender" };
    let messageId = "schema1-previous-message";
    if ((ping.capabilities ?? []).includes("deferred-boundary")) {
      messageId = cli("prepare", { sender, target, body: "after upgrade" }).data.messageId;
      cli("send", { sender, messageId });
    } else cli("send", { sender, target, messageId, body: "after upgrade" });
    expect(cli("status", { sender, messageId }).data.status.state).toBe("queued");
    const claimed = cli("claim", { target }).data.messages.map((message: { messageId: string }) => message.messageId);
    expect(claimed).toEqual(["schema1-old-body", messageId]);
    expect(cli("acknowledge", { target, messageIds: claimed }).data.acknowledged).toBe(2);
    expect(cli("status", { sender, messageId }).data.status.state).toBe("acknowledged");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
  try {
    const after = retiredRow();
    expect(after.version).toBe(1);
    // Managed-wake brokers leave the terminal row untouched. Older brokers prune every expired nonce row
    // (their existing behavior for any v2.7 database) but never reopen or rewrite it.
    if (managedWakeAware === true) expect(after.row).toEqual(before.row);
    else expect([undefined, before.row]).toContainEqual(after.row);
    const reopened = new SessionMessageStore(databasePath);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10 });
  }
}, 20_000);

it.skipIf(!previousBroker)("gives the new batched presence request a defined result from a previous broker", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-previous-broker-presence-"));
  const environment = { ...process.env, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: directory,
    AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"),
    AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(directory, "shared-state") };
  const target = { host: "synthetic-host", sessionId: "presence-recipient" };
  const seed = new SessionMessageStore(path.join(directory, "session-messages.sqlite3"));
  try {
    seed.startPresence({ ...target, instanceId: "presence-instance", transport: "portable", wakeVisibility: "none", canWakeSilently: false }, Date.now());
  } finally { seed.close(); }
  const child = spawn(process.execPath, [previousBroker!, "--state-directory", directory], { windowsHide: true, stdio: "ignore", env: environment });
  try {
    await waitForSessionMessageBrokerReady(directory, child, 5000);
    const service = new SessionMessageService(directory);
    // A previous broker ignores the targets and lists every identity: a small database still answers the board.
    const small = await service.listPresence([target]);
    if (small.ok) expect(small.data!.sessions.find((item) => item.sessionId === target.sessionId)).toMatchObject({ state: "online" });
    else expect(small.error!.message).toMatch(/Unknown broker operation|exceeded its limit/u);
    // Past the response limit a previous broker cannot answer; the board falls back to unknown, never to wrong data.
    const many = new SessionMessageStore(path.join(directory, "session-messages.sqlite3"));
    try {
      for (let index = 0; index < 120; index += 1) {
        many.startPresence({ host: "synthetic-host", sessionId: `many-${index}`, instanceId: `many-${index}`, transport: "portable",
          wakeVisibility: "none", canWakeSilently: false, workspaceId: `/work/${"w".repeat(400)}` }, Date.now());
      }
    } finally { many.close(); }
    const large = await service.listPresence([target]);
    expect(large.ok).toBe(false);
    expect(large.error!.message).toMatch(/Unknown broker operation|exceeded its limit/u);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10 });
  }
}, 20_000);
