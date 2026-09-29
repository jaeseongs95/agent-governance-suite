// Audit-only copy of the new real slow broker test that also logs the elapsed time; delay from AGS_AUDIT_SLOW_MS.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";

const sourceBroker = fileURLToPath(new URL("../../mcp-server/src/session-message-broker.ts", import.meta.url));
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const task of cleanup.splice(0).reverse()) await task(); });
const count = Number(process.env.AGS_AUDIT_SESSIONS ?? "90");

it("real slow broker lookup (audit timing)", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "ags-v276-audit-"));
  cleanup.push(() => rmSync(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const slow = pathToFileURL(fileURLToPath(new URL("../session-messaging/fixtures/slow-list-presence.mjs", import.meta.url))).href;
  const spawnedAt = performance.now();
  const child = spawn(process.execPath, ["--import", "tsx", "--import", slow, sourceBroker, "--state-directory", state],
    { windowsHide: true, stdio: "ignore", env: { ...process.env, AGS_TEST_LIST_PRESENCE_DELAY_MS: process.env.AGS_AUDIT_SLOW_MS ?? "1000" } });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; } });
  await waitForSessionMessageBrokerReady(state, child, 5000);
  const brokerReadyMs = Math.round(performance.now() - spawnedAt);
  const board = Array.from({ length: count }, (_, index) => ({ host: "portable", sessionId: `slow-${index}` }));
  const started = Date.now();
  const result = await new SessionMessageService(state).listPresence(board);
  const elapsed = Date.now() - started;
  const answered = result.data!.sessions.length;
  appendFileSync(process.env.AGS_AUDIT_LOG!, `${JSON.stringify({ label: process.env.AGS_AUDIT_LABEL, slowMs: Number(process.env.AGS_AUDIT_SLOW_MS ?? "1000"), sessions: count, brokerReadyMs, elapsedMs: elapsed, overDeadlineMs: elapsed - 20_000, answered, unanswered: result.data!.unanswered.length })}\n`);
  expect(answered).toBeGreaterThanOrEqual(0);
}, 120_000);
