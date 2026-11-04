import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { closeSessionMessaging } from "../../mcp-server/src/session-message-client.js";
import { runSessionMessageHook, runSessionMessageHookOutcome } from "../../mcp-server/src/session-message-hook.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";

// AGS 3.6.0: a Codex turn that uses one tool gets its peer message at the turn's Stop (real in-process store and trust
// store on temporary files). Before 3.6.0 the user input deferred the first after-tool claim and Codex had no turn-end
// claim, so the body waited for a later turn.
const sender = { host: "claude-code", sessionId: "stop-sender" };
const target = { host: "codex", sessionId: "stop-target" };
const event = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ hook_event_name: name, session_id: target.sessionId, ...extra });
const tool = (name: string) => event(name, { tool_name: "shell", tool_input: { command: "true" } });

let directory = "";
let store: SessionMessageStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "ags-codex-stop-"));
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", path.join(directory, "messaging"));
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", path.join(directory, "trust.sqlite3"));
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
  mkdirSync(path.join(directory, "messaging"));
  store = new SessionMessageStore(path.join(directory, "messaging", "session-messages.sqlite3"));
});
afterEach(() => {
  store.close();
  closeSessionMessaging(path.join(directory, "messaging"));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

it("a one-tool Codex turn delivers the waiting message at Stop as the continued turn, once", async () => {
  store.send({ sender, target, messageId: "stop-message", body: "Peer body for the turn end", ttlSeconds: 3600 });
  expect(await runSessionMessageHook("codex", event("UserPromptSubmit", { prompt: "edit the file" }), 4242)).toBe("");
  // The user input defers this first after-tool claim.
  expect(await runSessionMessageHook("codex", tool("PostToolUse"), 4242)).toBe("");
  const output = JSON.parse(await runSessionMessageHook("codex", event("Stop", { stop_hook_active: false }), 4242)) as Record<string, unknown>;
  expect(output.decision).toBe("block");
  expect(String(output.reason)).toContain("Peer body for the turn end");
  expect(store.status(sender, "stop-message")).toMatchObject({ state: "delivered", deliveryAttempts: 1 });
  // The continued turn ends with stop_hook_active: no second continuation and no second claim.
  store.send({ sender, target, messageId: "stop-message-2", body: "Second body", ttlSeconds: 3600 });
  expect(await runSessionMessageHook("codex", event("Stop", { stop_hook_active: true }), 4242)).toBe("");
  expect(store.status(sender, "stop-message-2")).toMatchObject({ state: "queued", deliveryAttempts: 0 });
});

it("a body claimed by a Stop hook that then fails is not delivered again until its claim lease ends", async () => {
  store.send({ sender, target, messageId: "lost-message", body: "Body lost after its claim", ttlSeconds: 7200 });
  // The peer receipt store cannot open (its path is a directory), so the hook fails after the claim.
  mkdirSync(path.join(directory, "trust-dir"));
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", path.join(directory, "trust-dir"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  const outcome = await runSessionMessageHookOutcome("codex", event("Stop"), 4242);
  expect(outcome).toMatchObject({ ok: false, output: "", failure: { phase: "handle", step: "peer-receipt" } });
  const claimedAt = Date.parse(String(store.status(sender, "lost-message")!.claimedAt));
  expect(store.claimTurnEnd(target, claimedAt + 1_000)).toEqual([]);
  // After the longest claim lease (30 minutes) the body is claimable again, as its next delivery attempt.
  const again = store.claimTurnEnd(target, claimedAt + 30 * 60_000 + 1_000);
  expect(again.map((item) => [item.messageId, item.deliveryAttempt])).toEqual([["lost-message", 2]]);
});
