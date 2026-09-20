import { execFile } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";

import { newWakeNonce, sessionMessageRequest, wakeMessage } from "./session-message-client.js";
import { processExists, processIdentityState, type ProcessIdentityState } from "./process-identity.js";
import type { DeliveryCapabilities } from "./input-observation.js";

const LOOP_MS = 5000;
const IDENTITY_RECHECK_MS = 10 * 60_000;
const IDENTITY_RETRY_MS = 60_000;
const IDENTITY_UNKNOWN_LIMIT = 3;
const WAKE_BACKOFF_BASE_MS = 30_000;
const WAKE_BACKOFF_MAX_MS = 10 * 60_000;

export function wakeBackoffDelay(attempt: number): number {
  return Math.min(WAKE_BACKOFF_MAX_MS, WAKE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
}

export function relayIdentityDecision(identity: ProcessIdentityState, previousUnknowns: number): {
  proceed: boolean;
  stop: boolean;
  unknowns: number;
} {
  if (identity === "mismatch") return { proceed: false, stop: true, unknowns: 0 };
  if (identity === "match") return { proceed: true, stop: false, unknowns: 0 };
  const unknowns = previousUnknowns + 1;
  return { proceed: false, stop: unknowns >= IDENTITY_UNKNOWN_LIMIT, unknowns };
}

export type SessionMessageTransport = "codex-deferred" | "codex-queue" | "claude-inbox";

export interface RelayOptions {
  host: string;
  sessionId: string;
  instanceId: string;
  transport: SessionMessageTransport;
  parentPid: number;
  parentStartToken: string;
}

export function transportWakeCapabilities(transport: SessionMessageTransport): {
  wakeVisibility: "silent" | "user-message" | "none";
  canWakeSilently: boolean;
} {
  const idleWake = transportDeliveryCapabilities(transport).idleWake;
  return { wakeVisibility: idleWake, canWakeSilently: idleWake === "silent" };
}

export function transportDeliveryCapabilities(transport: SessionMessageTransport): DeliveryCapabilities {
  if (transport === "claude-inbox") return { supportedInjection: ["peer-wake", "tool-boundary", "turn-end"], idleWake: "silent" };
  if (transport === "codex-queue") return { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" };
  return { supportedInjection: ["tool-boundary"], idleWake: "none" };
}

export type WakeDispatchOutcome = "submitted" | "definite-failure" | "accepted-or-unknown";

export function codexWakeOutcome(error: unknown, spawned: boolean): WakeDispatchOutcome {
  return !error ? "submitted" : spawned ? "accepted-or-unknown" : "definite-failure";
}

export function claudeWakeOutcome(hadError: boolean, connected: boolean, wrote: boolean): WakeDispatchOutcome {
  return !hadError && wrote ? "submitted" : connected || wrote ? "accepted-or-unknown" : "definite-failure";
}

export function shouldReleaseWake(outcome: WakeDispatchOutcome): boolean {
  return outcome === "definite-failure";
}

export function wakeRetryState(outcome: WakeDispatchOutcome, released: boolean, attempt: number, now: number): {
  retry: boolean;
  nextRingAt: number;
  ringAttempts: number;
} {
  const retry = outcome === "definite-failure" && released;
  return {
    retry,
    nextRingAt: retry ? now + wakeBackoffDelay(attempt) : 0,
    ringAttempts: retry ? attempt + 1 : 0,
  };
}

async function ringCodex(sessionId: string, message: string): Promise<WakeDispatchOutcome> {
  return new Promise<WakeDispatchOutcome>((resolve) => {
    let spawned = false;
    const child = execFile("codex", ["queue", "--thread", sessionId, "--message", message], { windowsHide: true, timeout: 10_000 }, (error) => resolve(codexWakeOutcome(error, spawned)));
    child.once("spawn", () => { spawned = true; });
  });
}

async function ringClaude(message: string): Promise<WakeDispatchOutcome> {
  const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  if (!socketPath || !token) return "definite-failure";
  return new Promise<WakeDispatchOutcome>((resolve) => {
    let settled = false;
    let connected = false;
    let wrote = false;
    const finish = (outcome: WakeDispatchOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const socket = net.createConnection(socketPath);
    socket.setTimeout(5000, () => socket.destroy(new Error("Claude inbox timed out.")));
    socket.once("connect", () => {
      connected = true;
      try {
        wrote = true;
        socket.end(`${JSON.stringify({ type: "auth", token })}\n${JSON.stringify({ type: "user", message: { role: "user", content: message }, priority: "now" })}\n`);
      } catch {
        finish("accepted-or-unknown");
      }
    });
    socket.once("close", (hadError) => finish(claudeWakeOutcome(hadError, connected, wrote)));
    socket.once("error", () => finish(claudeWakeOutcome(true, connected, wrote)));
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runSessionMessageRelay(options: RelayOptions): Promise<void> {
  const target = { host: options.host, sessionId: options.sessionId };
  const relayId = randomUUID();
  let acquired = false;
  let acquisitionUnknowns = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const identity = processIdentityState(options.parentPid, options.parentStartToken);
    const decision = relayIdentityDecision(identity, acquisitionUnknowns);
    acquisitionUnknowns = decision.unknowns;
    if (decision.stop) return;
    try {
      if (decision.proceed) {
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

  try {
    let retryNonce: string | null = null;
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
      await sessionMessageRequest("presence-heartbeat", { target, instanceId: options.instanceId });
      if (options.transport === "codex-deferred") {
        await delay(LOOP_MS);
        continue;
      }
      const pending = await sessionMessageRequest<{ count: number }>("pending", { target });
      if (pending.count === 0) {
        retryNonce = null;
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
        const nonce: string = retryNonce ?? newWakeNonce();
        const reservation = await sessionMessageRequest<{ dispatch: boolean }>("reserve-wake", { target, nonce });
        if (!reservation.dispatch) {
          retryNonce = null;
          ringAttempts = 0;
          nextRingAt = 0;
        } else {
          const bell = wakeMessage(nonce);
          const outcome = options.transport === "codex-queue"
            ? await ringCodex(options.sessionId, bell)
            : await ringClaude(bell);
          let released = false;
          if (shouldReleaseWake(outcome)) {
            const result = await sessionMessageRequest<{ released: boolean }>("release-wake", { target, nonce });
            released = result.released;
          }
          const retry = wakeRetryState(outcome, released, ringAttempts, now);
          retryNonce = retry.retry ? nonce : null;
          nextRingAt = retry.nextRingAt;
          ringAttempts = retry.ringAttempts;
        }
      }
    } catch {
      // Delivery remains durable in the broker and is retried on the next loop.
    }
      await delay(LOOP_MS);
    }
  } finally {
    try {
      await sessionMessageRequest("presence-end", {
        target,
        instanceId: options.instanceId,
        reason: "host-process-ended",
      }, undefined, { totalTimeoutMs: 3_000 });
    } catch { /* Lease expiry still provides an unreachable fallback. */ }
  }
}
