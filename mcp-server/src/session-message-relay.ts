import { execFile } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { newWakeNonce, sessionMessageRequest, wakeMessage } from "./session-message-client.js";
import { processStillMatches } from "./process-identity.js";

interface RelayOptions {
  host: string;
  sessionId: string;
  transport: "codex-queue" | "claude-inbox";
  parentPid: number;
  parentStartToken: string | null;
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function ringCodex(sessionId: string, message: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("codex", ["queue", "--thread", sessionId, "--message", message], { windowsHide: true, timeout: 10_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function ringClaude(message: string): Promise<void> {
  const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  if (!socketPath || !token) throw new Error("Claude inbox transport is unavailable.");
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setTimeout(5000, () => socket.destroy(new Error("Claude inbox timed out.")));
    socket.once("connect", () => {
      socket.end(`${JSON.stringify({ type: "auth", token })}\n${JSON.stringify({ type: "user", message: { role: "user", content: message }, priority: "now" })}\n`);
    });
    socket.once("close", (hadError) => { if (!hadError) resolve(); });
    socket.once("error", reject);
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runSessionMessageRelay(options: RelayOptions): Promise<void> {
  const target = { host: options.host, sessionId: options.sessionId };
  const relayId = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 6 && processStillMatches(options.parentPid, options.parentStartToken); attempt += 1) {
    try {
      const result = await sessionMessageRequest<{ acquired: boolean }>("acquire-relay", {
        target,
        transport: options.transport,
        relayId,
        pid: process.pid,
        parentPid: options.parentPid,
      });
      acquired = result.acquired;
      if (acquired) break;
    } catch { /* Retry while a stale lease expires. */ }
    await delay(3000);
  }
  if (!acquired) return;

  let lastPending = 0;
  let lastRingAt = 0;
  let nextIdentityCheck = 0;
  while (true) {
    if (Date.now() >= nextIdentityCheck) {
      if (!processStillMatches(options.parentPid, options.parentStartToken)) return;
      nextIdentityCheck = Date.now() + 60_000;
    }
    try {
      const heartbeat = await sessionMessageRequest<{ alive: boolean }>("heartbeat-relay", { target, transport: options.transport, relayId });
      if (!heartbeat.alive) return;
      const pending = await sessionMessageRequest<{ count: number }>("pending", { target });
      if (pending.count > 0 && (lastPending === 0 || Date.now() - lastRingAt >= 30_000)) {
        const nonce = newWakeNonce();
        await sessionMessageRequest("issue-wake", { target, nonce });
        const bell = wakeMessage(nonce);
        if (options.transport === "codex-queue") await ringCodex(options.sessionId, bell);
        else await ringClaude(bell);
        lastRingAt = Date.now();
      }
      lastPending = pending.count;
    } catch {
      // Delivery remains durable in the broker and is retried on the next loop.
    }
    await delay(5000);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const host = argument("--host");
  const sessionId = argument("--session-id");
  const transport = argument("--transport");
  const parentPid = Number.parseInt(argument("--parent-pid") ?? "", 10);
  const parentStartToken = argument("--parent-start-token");
  if (!host || !sessionId || (transport !== "codex-queue" && transport !== "claude-inbox") || !Number.isInteger(parentPid)) process.exitCode = 2;
  else void runSessionMessageRelay({ host, sessionId, transport, parentPid, parentStartToken }).catch(() => { process.exitCode = 1; });
}
