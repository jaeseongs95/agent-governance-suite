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
// The released version of that broker (for example 2.7.5 or v2.7.5), for checks whose expected result depends on it.
const previousVersion = process.env.AGS_PREVIOUS_BROKER_VERSION;
function previousAtLeast(minimum: [number, number, number]): boolean {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(previousVersion ?? "");
  if (!parts) throw new Error("Set AGS_PREVIOUS_BROKER_VERSION to the previous broker's release version (for example 2.7.5).");
  const version = parts.slice(1).map(Number);
  for (let index = 0; index < 3; index += 1) if (version[index] !== minimum[index]) return version[index]! > minimum[index]!;
  return true;
}
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
    seed.startPresence({ host: "synthetic-host", sessionId: "presence-other", instanceId: "presence-other", transport: "portable",
      wakeVisibility: "none", canWakeSilently: false }, Date.now());
    // The broker reads the wall clock after a possibly slow start; keep the row live well past the 20-second lease.
    seed.database.prepare("UPDATE session_presence SET lease_until = ? WHERE session_id = ?")
      .run(new Date(Date.now() + 10 * 60_000).toISOString(), target.sessionId);
  } finally { seed.close(); }
  const child = spawn(process.execPath, [previousBroker!, "--state-directory", directory], { windowsHide: true, stdio: "ignore", env: environment });
  try {
    await waitForSessionMessageBrokerReady(directory, child, 5000);
    const service = new SessionMessageService(directory);
    // A previous broker ignores the targets and lists every identity: a small database still answers the board.
    const small = await service.listPresence([target]);
    expect(small.ok).toBe(true);
    expect(small.data!.sessions.find((item) => item.sessionId === target.sessionId)).toMatchObject({ state: "online" });
    expect(small.data!.unanswered).toEqual([]);
    // A 2.7.4 or later broker answers only the requested targets; an earlier one lists every identity.
    const targeted = !small.data!.sessions.some((item) => item.sessionId === "presence-other");
    // Past the response limit an earlier broker cannot answer; each batch is unanswered (unknown, autoWake null), never wrong data.
    const many = new SessionMessageStore(path.join(directory, "session-messages.sqlite3"));
    try {
      for (let index = 0; index < 120; index += 1) {
        many.startPresence({ host: "synthetic-host", sessionId: `many-${index}`, instanceId: `many-${index}`, transport: "portable",
          wakeVisibility: "none", canWakeSilently: false, workspaceId: `/work/${"w".repeat(400)}` }, Date.now());
      }
    } finally { many.close(); }
    const large = await service.listPresence([target]);
    if (targeted) {
      expect(large.data!.unanswered).toEqual([]);
      expect(large.data!.sessions.map((item) => item.sessionId)).toEqual([target.sessionId]);
      expect(large.data!.sessions[0]).toMatchObject({ state: "online" });
    } else expect(large.data).toEqual({ sessions: [], unanswered: [target] });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10 });
  }
}, 20_000);

it.skipIf(!previousBroker)("leaves a previous broker's latch of an ended birth for the new broker to retire, or finds it retired", async () => {
  // Strict without a version: the test fails rather than guess which result the broker owes.
  const retiringBroker = previousAtLeast([2, 7, 5]);
  const directory = await mkdtemp(path.join(tmpdir(), "ags-previous-broker-ended-"));
  const environment = { ...process.env, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: directory,
    AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(directory, "trust.sqlite3"),
    AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(directory, "shared-state") };
  const databasePath = path.join(directory, "session-messages.sqlite3");
  const target = { host: "codex", sessionId: "ended-recipient" };
  const nonce = "ended-birth-nonce-abcdefghijklmnopqr";
  const seed = new SessionMessageStore(databasePath);
  try {
    // The birth ended long ago and never came back, so no wall-clock lease is involved.
    const base = Date.now() - WAKE_TTL_MS - WAKE_RETIRE_GRACE_MS - 60_000;
    seed.startPresence({ ...target, instanceId: "ended-instance", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false,
      deliveryCapabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" } }, base);
    seed.acquireRelay({ ...target, transport: "codex-queue", relayId: "ended-relay", pid: process.pid, parentPid: process.pid }, base);
    seed.send({ sender: { host: "synthetic-host", sessionId: "sender" }, target, messageId: "ended-body", body: "b", ttlSeconds: 86400 }, base);
    const reserved = seed.reserveManagedWake({ ...target, nonce, instanceId: "ended-instance", transport: "codex-queue", relayId: "ended-relay" }, base);
    seed.recordManagedWakeOutcome(seed.startManagedWake(reserved.attempt!, base + 1).attempt!, "submitted", base + 2);
    seed.endPresence(target, "session-end", "ended-instance", base + 3);
  } finally { seed.close(); }
  const wakeRow = () => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { return database.prepare("SELECT * FROM wake_nonces WHERE nonce = ?").get(nonce) as Record<string, unknown> | undefined; }
    finally { database.close(); }
  };
  const before = wakeRow();
  expect(before).toMatchObject({ state: "submitted" });
  const child = spawn(process.execPath, [previousBroker!, "--state-directory", directory], { windowsHide: true, stdio: "ignore", env: environment });
  let managedWakeAware: boolean | undefined;
  try {
    await waitForSessionMessageBrokerReady(directory, child, 5000);
    const ping = await requestSessionMessageOnce<{ capabilities?: string[] }>("ping", {}, directory);
    managedWakeAware = (ping.capabilities ?? []).includes("delivery-capabilities");
    // Any request prunes; a previous broker does not know the ended-birth rule.
    const pending = spawnSync(process.execPath, [path.join(pluginRoot, "mcp-server/dist/session-message-cli.mjs")], {
      env: environment, input: JSON.stringify({ operation: "pending", payload: { target } }), encoding: "utf8", windowsHide: true, timeout: 5000,
    });
    expect(pending.status, pending.stderr).toBe(0);
    expect(JSON.parse(pending.stdout).data.count).toBe(1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
  try {
    const kept = wakeRow();
    const binding = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !["state", "retired_at"].includes(key)));
    // Only a 2.7.5 or later broker may already have retired it (same binding, terminal state); by the stated version, not
    // by what is observed. 2.7.4 and 2.7.3 must keep the latch unchanged.
    if (retiringBroker && kept?.state === "expired-unobserved") expect(binding(kept)).toEqual(binding(before!));
    else if (managedWakeAware === true) expect(kept).toEqual(before);
    else expect([undefined, before]).toContainEqual(kept);
    const current = new SessionMessageStore(databasePath);
    try {
      current.prune();
      if (kept) expect(wakeRow()).toMatchObject({ state: "expired-unobserved", observed_at: null, consumed_at: null });
    } finally { current.close(); }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10 });
  }
}, 20_000);
