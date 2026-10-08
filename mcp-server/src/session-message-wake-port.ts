import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import type { DeliveryCapabilities, InputObservation } from "./input-observation.js";
import type { SessionIdentity } from "./session-message-store.js";
import { TrustStore } from "./trust-store.js";
import type { InputSourceReceiptV1 } from "../../contracts/types.js";

export interface VerifiedInputSourceReader {
  readVerifiedInputSource(receiptId: string): InputSourceReceiptV1 | null;
}
import { resolveTrustDatabasePath } from "./runtime-config.js";

export type WakeDispatchOutcome = "submitted" | "definite-failure" | "accepted-or-unknown";
export interface WakeDispatchPort {
  capabilities: DeliveryCapabilities;
  dispatch(target: SessionIdentity, message: string): Promise<WakeDispatchOutcome>;
}
export function wakeBackoffDelay(attempt: number): number {
  return Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, attempt));
}
export function codexWakeOutcome(error: unknown, spawned: boolean): WakeDispatchOutcome {
  return !error ? "submitted" : spawned ? "accepted-or-unknown" : "definite-failure";
}
export function claudeWakeOutcome(hadError: boolean, connected: boolean, wrote: boolean): WakeDispatchOutcome {
  return !hadError && wrote ? "submitted" : connected || wrote ? "accepted-or-unknown" : "definite-failure";
}
function ringCodex(sessionId: string, message: string): Promise<WakeDispatchOutcome> {
  return new Promise((resolve) => {
    let spawned = false;
    const child = execFile("codex", ["queue", "--thread", sessionId, "--message", message],
      { windowsHide: true, timeout: 10_000 }, (error) => resolve(codexWakeOutcome(error, spawned)));
    child.once("spawn", () => { spawned = true; });
  });
}
export async function ringClaude(message: string): Promise<WakeDispatchOutcome> {
  const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  if (!socketPath || !token) return "definite-failure";
  return new Promise((resolve) => {
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
        // Queue behind ongoing host work instead of interrupting the receiving tool.
        socket.end(`${JSON.stringify({ type: "auth", token })}\n${JSON.stringify({ type: "user", message: { role: "user", content: message }, priority: "next" })}\n`);
      } catch { finish("accepted-or-unknown"); }
    });
    socket.once("close", (hadError) => finish(claudeWakeOutcome(hadError, connected, wrote)));
    socket.once("error", () => finish(claudeWakeOutcome(true, connected, wrote)));
  });
}

// Concrete registration is the composition boundary; the relay consumes only the port.
const ports: ReadonlyMap<string, WakeDispatchPort> = new Map<string, WakeDispatchPort>([
  ["claude-inbox", { capabilities: { supportedInjection: ["peer-wake", "tool-boundary", "turn-end"], idleWake: "silent" },
    dispatch: (_target, message) => ringClaude(message) }],
  ["codex-queue", { capabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" },
    dispatch: (target, message) => ringCodex(target.sessionId, message) }],
  ["codex-deferred", { capabilities: { supportedInjection: ["tool-boundary"], idleWake: "none" },
    dispatch: async () => "definite-failure" }],
]);
export function transportWakePort(transport: string): WakeDispatchPort {
  const port = ports.get(transport);
  if (!port) throw new Error("Wake transport adapter is unavailable.");
  return port;
}
export function transportDeliveryCapabilities(transport: string): DeliveryCapabilities {
  const capabilities = transportWakePort(transport).capabilities;
  return { supportedInjection: [...capabilities.supportedInjection], idleWake: capabilities.idleWake };
}

/** Local hook liveness only; this cannot attest an actor, permission, or W06 authority. */
const WAKE_ACTOR_KINDS = ["main", "unknown"] as const;
const WAKE_ACTOR_ASSURANCES = ["observed", "unknown"] as const;
export function isWakeHookObservation(value: unknown, target: SessionIdentity): value is InputObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as InputObservation;
  return event.host === target.host && event.sessionId === target.sessionId && event.kind === "user-input"
    && event.wakeOnly === true && event.actor?.observedBy === `${target.host}:hook-payload`
    && WAKE_ACTOR_KINDS.some((kind) => kind === event.actor.kind)
    && WAKE_ACTOR_ASSURANCES.some((assurance) => assurance === event.actor.assurance)
    && Array.isArray(event.wakeCandidates) && event.wakeCandidates.length > 0
    && event.wakeCandidates.length <= 10 && event.wakeCandidates.every((nonce) => typeof nonce === "string"
      && /^[A-Za-z0-9_-]{22,128}$/u.test(nonce));
}

export interface WakeHookObservationReader {
  verifyObservation(target: SessionIdentity, observation: InputObservation, receiptId: string, nowMs: number): boolean;
}
function observationDigest(event: InputObservation): `sha256:${string}` {
  const normalized = [event.host, event.sessionId, event.kind, event.wakeOnly,
    event.actor.kind, event.actor.observedBy, event.actor.assurance, [...new Set(event.wakeCandidates)].sort()];
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

export interface HistoricalWakeEvidence {
  sourceReceiptId: string;
  contentDigest: string;
  observedAt: string;
  receiptExpiresAt: string;
}

/** Historical liveness proof, never a current hook claim or an approval source. */
export function verifyHistoricalWakeObservation(target: SessionIdentity, nonce: string, sourceReceiptId: string,
  startedAt: string, lateObservedAt: string, nowMs: number,
  source: string | VerifiedInputSourceReader = resolveTrustDatabasePath()): HistoricalWakeEvidence | null {
  const receipt = typeof source === "string" ? TrustStore.readVerifiedInputSource(source, sourceReceiptId) : source.readVerifiedInputSource(sourceReceiptId);
  if (!receipt || receipt.schemaVersion !== "1.0.0" || receipt.host !== target.host || receipt.sessionId !== target.sessionId
    || receipt.originKind !== "peer" || receipt.authorityEffect !== "none"
    || receipt.attestation?.kind !== "broker-peer-envelope" || receipt.attestation.adapter !== "session-message-wake-hook"
    || receipt.attestation.capabilityVersion !== "1.0.0") return null;
  const [started, observed, late, expires] = [Date.parse(startedAt), Date.parse(receipt.observedAt),
    Date.parse(lateObservedAt), Date.parse(receipt.expiresAt)] as const;
  if (![started, observed, late, expires, nowMs].every(Number.isFinite)
    || !(started <= observed && observed <= late && late < expires && expires <= nowMs)) return null;
  // The stored digest selects exactly one supported normalization. No actor default,
  // nonce subset search or approximation can stand in for the original signed digest.
  let matches = 0;
  for (const kind of WAKE_ACTOR_KINDS) for (const assurance of WAKE_ACTOR_ASSURANCES) {
    const observation: InputObservation = { ...target, kind: "user-input", wakeOnly: true, wakeCandidates: [nonce],
      actor: { kind, assurance, observedBy: `${target.host}:hook-payload` } };
    if (isWakeHookObservation(observation, target) && observationDigest(observation) === receipt.contentDigest) matches++;
  }
  return matches === 1 ? { sourceReceiptId, contentDigest: receipt.contentDigest, observedAt: receipt.observedAt,
    receiptExpiresAt: receipt.expiresAt } : null;
}
/** Uses existing, non-authorizing source provenance. No public tool issues this hook receipt. */
export function recordWakeHookObservation(observation: InputObservation, nowMs = Date.now()): string {
  if (!isWakeHookObservation(observation, observation)) throw new Error("Invalid host wake observation.");
  const trust = new TrustStore(resolveTrustDatabasePath());
  try {
    return trust.recordInputSource({ originKind: "peer", host: observation.host, sessionId: observation.sessionId,
      eventId: `wake-hook-${randomUUID()}`, contentDigest: observationDigest(observation),
      observedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + 30_000).toISOString(), authorityEffect: "none",
      attestation: { kind: "broker-peer-envelope", adapter: "session-message-wake-hook", capabilityVersion: "1.0.0" } }).receiptId;
  } finally { trust.close(); }
}
export function createWakeHookObservationReader(source: string | VerifiedInputSourceReader = resolveTrustDatabasePath()): WakeHookObservationReader {
  return {
  verifyObservation(target, observation, receiptId, nowMs) {
    if (!isWakeHookObservation(observation, target) || !receiptId) return false;
    const receipt = typeof source === "string" ? TrustStore.readVerifiedInputSource(source, receiptId) : source.readVerifiedInputSource(receiptId);
    return receipt !== null && receipt.host === target.host && receipt.sessionId === target.sessionId
      && receipt.originKind === "peer" && receipt.authorityEffect === "none"
      && receipt.attestation.kind === "broker-peer-envelope" && receipt.attestation.adapter === "session-message-wake-hook"
      && receipt.attestation.capabilityVersion === "1.0.0" && receipt.contentDigest === observationDigest(observation)
      && Date.parse(receipt.observedAt) <= nowMs && Date.parse(receipt.expiresAt) > nowMs;
  },
  };
}
export const wakeHookObservationReader: WakeHookObservationReader = {
  verifyObservation: (...args) => createWakeHookObservationReader().verifyObservation(...args),
};
