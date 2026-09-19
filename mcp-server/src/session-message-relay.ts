import { execFile } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { newWakeNonce, sessionMessageRequest, wakeMessage } from "./session-message-client.js";
import { processExists, processIdentityState, type ProcessIdentityState } from "./process-identity.js";

const LOOP_MS = 5000;
const IDENTITY_RECHECK_MS = 10 * 60_000;
const IDENTITY_RETRY_MS = 60_000;
const IDENTITY_UNKNOWN_LIMIT = 3;
const WAKE_BACKOFF_BASE_MS = 30_000;
const WAKE_BACKOFF_MAX_MS = 10 * 60_000;

export function wakeBackoffDelay(attempt: number): number {
  return Math.min(WAKE_BACKOFF_MAX_MS, WAKE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
}

interface RelayOptions {
  host: string;
  sessionId: string;
  transport: "codex-queue" | "claude-inbox";
  parentPid: number;
  parentStartToken: string;
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
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const identity = processIdentityState(options.parentPid, options.parentStartToken);
    if (identity === "mismatch") return;
    try {
      if (identity === "match") {
        const result = await sessionMessageRequest<{ acquired: boolean }>("acquire-relay", {
          target,
          transport: options.transport,
          relayId,
          pid: process.pid,
          parentPid: options.parentPid,
        });
        acquired = result.acquired;
        if (acquired) break;
      }
    } catch { /* Retry while a stale lease expires. */ }
    await delay(3000);
  }
  if (!acquired) return;

  let outstandingNonce: string | null = null;
  let ringAttempts = 0;
  let nextRingAt = 0;
  let identityUnknowns = 0;
  let nextIdentityCheck = Date.now() + IDENTITY_RECHECK_MS;
  while (true) {
    if (!processExists(options.parentPid)) return;
    const now = Date.now();
    let checkedIdentity: ProcessIdentityState | null = null;
    if (now >= nextIdentityCheck) {
      checkedIdentity = processIdentityState(options.parentPid, options.parentStartToken);
      if (checkedIdentity === "mismatch") return;
      if (checkedIdentity === "unknown") {
        identityUnknowns += 1;
        if (identityUnknowns >= IDENTITY_UNKNOWN_LIMIT) return;
        nextIdentityCheck = now + IDENTITY_RETRY_MS;
      } else {
        identityUnknowns = 0;
        nextIdentityCheck = now + IDENTITY_RECHECK_MS;
      }
    }
    try {
      const heartbeat = await sessionMessageRequest<{ alive: boolean }>("heartbeat-relay", { target, transport: options.transport, relayId });
      if (!heartbeat.alive) return;
      const pending = await sessionMessageRequest<{ count: number }>("pending", { target });
      if (pending.count === 0) {
        outstandingNonce = null;
        ringAttempts = 0;
        nextRingAt = 0;
      } else if (now >= nextRingAt) {
        const identity = checkedIdentity ?? processIdentityState(options.parentPid, options.parentStartToken);
        if (identity === "mismatch") return;
        if (identity === "unknown") {
          if (checkedIdentity === null) identityUnknowns += 1;
          if (identityUnknowns >= IDENTITY_UNKNOWN_LIMIT) return;
          nextIdentityCheck = Math.min(nextIdentityCheck, now + IDENTITY_RETRY_MS);
          nextRingAt = now + IDENTITY_RETRY_MS;
          await delay(LOOP_MS);
          continue;
        }
        identityUnknowns = 0;
        nextIdentityCheck = now + IDENTITY_RECHECK_MS;
        if (outstandingNonce === null) {
          outstandingNonce = newWakeNonce();
          await sessionMessageRequest("issue-wake", { target, nonce: outstandingNonce });
        }
        const bell = wakeMessage(outstandingNonce);
        nextRingAt = now + wakeBackoffDelay(ringAttempts);
        ringAttempts += 1;
        if (options.transport === "codex-queue") await ringCodex(options.sessionId, bell);
        else await ringClaude(bell);
      }
    } catch {
      // Delivery remains durable in the broker and is retried on the next loop.
    }
    await delay(LOOP_MS);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const host = argument("--host");
  const sessionId = argument("--session-id");
  const transport = argument("--transport");
  const parentPid = Number.parseInt(argument("--parent-pid") ?? "", 10);
  const parentStartToken = argument("--parent-start-token");
  if (!host || !sessionId || (transport !== "codex-queue" && transport !== "claude-inbox") || !Number.isInteger(parentPid) || !parentStartToken) process.exitCode = 2;
  else void runSessionMessageRelay({ host, sessionId, transport, parentPid, parentStartToken }).catch(() => { process.exitCode = 1; });
}
