import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { requestSessionMessageOnce, waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";
import { runSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";

// A release check supplies the actual previous installation, not a simulated dispatcher.
const previousBroker = process.env.AGS_PREVIOUS_BROKER_PATH;
it.skipIf(!previousBroker)("preserves queued messages when new hooks meet the previous released broker", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-previous-broker-"));
  const previousState = process.env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR;
  const home = path.join(directory, "home");
  const child = spawn(process.execPath, [previousBroker!, "--state-directory", directory], {
    windowsHide: true, stdio: "ignore",
    env: { ...process.env, HOME: home, USERPROFILE: home,
      LOCALAPPDATA: path.join(directory, "local"), XDG_STATE_HOME: path.join(directory, "xdg"),
      AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(directory, "shared"),
      AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: directory },
  });
  try {
    await waitForSessionMessageBrokerReady(directory, child, 5000);
    process.env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR = directory;
    const sender = { host: "synthetic-host", sessionId: "sender" };
    const target = { host: "codex", sessionId: "recipient" };
    const messageId = "previous-broker-compatibility-message";
    const ping = await requestSessionMessageOnce<{ capabilities?: string[] }>("ping", {}, directory);
    expect(ping.capabilities ?? []).not.toContain("deferred-boundary");
    await requestSessionMessageOnce("send", { sender, target, messageId, body: "Synthetic compatibility check" }, directory);
    for (const event of ["UserPromptSubmit", "PostToolUse", "PostToolUse"]) {
      expect(await runSessionMessageHook("codex", JSON.stringify({
        hook_event_name: event, session_id: target.sessionId, prompt: "Synthetic native input",
      }))).toBe("");
    }
    const status = await requestSessionMessageOnce<{ status: { state: string } }>("status", { sender, messageId }, directory);
    expect(status.status.state).toBe("queued");
    const database = new DatabaseSync(path.join(directory, "session-messages.sqlite3"), { readOnly: true });
    try {
      expect(database.prepare("SELECT delivery_attempts FROM messages WHERE message_id = ?").get(messageId))
        .toEqual({ delivery_attempts: 0 });
    } finally { database.close(); }
    const claimed = await requestSessionMessageOnce<{ messages: Array<{ messageId: string; body: string }> }>("claim", { target }, directory);
    expect(claimed.messages).toEqual([expect.objectContaining({ messageId, body: "Synthetic compatibility check" })]);
  } finally {
    if (previousState === undefined) delete process.env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR;
    else process.env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR = previousState;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10 });
  }
}, 20_000);
