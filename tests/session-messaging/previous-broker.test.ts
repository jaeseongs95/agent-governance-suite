import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { requestSessionMessageOnce, waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";

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
