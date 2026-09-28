import { randomUUID } from "node:crypto";

import { newWakeNonce, sessionMessageRequest, wakeMessage } from "./session-message-client.js";
import { processExists, processIdentityState, type ProcessIdentityState } from "./process-identity.js";
import { transportWakePort, transportDeliveryCapabilities, wakeBackoffDelay, type WakeDispatchPort, type WakeDispatchOutcome } from "./session-message-wake-port.js";
import type { WakeReservation } from "./session-message-store.js";
export { transportDeliveryCapabilities, wakeBackoffDelay, codexWakeOutcome, claudeWakeOutcome, ringClaude,
  type WakeDispatchOutcome } from "./session-message-wake-port.js";

const LOOP_MS = 5000;
const IDENTITY_RECHECK_MS = 10 * 60_000;
const IDENTITY_RETRY_MS = 60_000;
const IDENTITY_UNKNOWN_LIMIT = 3;
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

export type SessionMessageTransport = string;

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

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** One dispatch cycle shared by the loop and isolated process regression fixtures. */
export async function dispatchManagedWake(options: Pick<RelayOptions, "host" | "sessionId" | "instanceId" | "transport">,
  relayId: string, port: WakeDispatchPort, request: typeof sessionMessageRequest = sessionMessageRequest): Promise<boolean> {
  if (port.capabilities.idleWake === "none" || !port.capabilities.supportedInjection.includes("peer-wake")) return false;
  const target = { host: options.host, sessionId: options.sessionId };
  const reserved = await request<WakeReservation>("reserve-wake", { target, nonce: newWakeNonce(),
    instanceId: options.instanceId, transport: options.transport, relayId, resume: true });
  if (!reserved.dispatch || !reserved.attempt) return false;
  const started = await request<WakeReservation>("start-wake", { attempt: reserved.attempt });
  if (!started.dispatch || !started.attempt) return false;
  let outcome: WakeDispatchOutcome = "accepted-or-unknown";
  try { outcome = await port.dispatch(target, wakeMessage(started.attempt.nonce)); }
  catch { /* A thrown adapter cannot prove that no bytes were submitted. */ }
  await request("record-wake-outcome", { attempt: started.attempt, outcome });
  return true;
}

export async function runSessionMessageRelay(options: RelayOptions, port: WakeDispatchPort = transportWakePort(options.transport)): Promise<void> {
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
          instanceId: options.instanceId,
        });
        acquired = result.acquired;
        if (acquired) break;
      }
    } catch { /* Retry while a stale lease expires. */ }
    await delay(3000);
  }
  if (!acquired) return;

  try {

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
      const pending = await sessionMessageRequest<{ alive: boolean; count: number }>("relay-tick", {
        target, transport: options.transport, relayId, instanceId: options.instanceId, includePending: port.capabilities.idleWake !== "none",
      });
      if (!pending.alive) return;
      if (port.capabilities.idleWake === "none") {
        await delay(LOOP_MS);
        continue;
      }
      if (pending.count > 0) {
        const identity = checkedIdentity ?? processIdentityState(options.parentPid, options.parentStartToken);
        if (identity === "mismatch") return;
        if (identity === "unknown") {
          if (checkedIdentity === null) identityUnknowns += 1;
          if (identityUnknowns >= IDENTITY_UNKNOWN_LIMIT) return;
          nextIdentityCheck = Math.min(nextIdentityCheck, now + IDENTITY_RETRY_MS);
          await delay(LOOP_MS);
          continue;
        }
        identityUnknowns = 0;
        nextIdentityCheck = now + IDENTITY_RECHECK_MS;
        await dispatchManagedWake(options, relayId, port);
      }
    } catch {
      // Messages remain durable. A committed start is never retried on an uncertain response.
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
