import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { actorAccess, type DeliveryCapabilities, type InputObservation } from "./input-observation.js";
import type { SessionIdentity } from "./session-message-store.js";
import { TrustStore } from "./trust-store.js";
import { failureContext, producerFailureReason } from "./failure-diagnostics.js";
import type { InputSourceReceiptV1 } from "../../contracts/types.js";
import { resolveSessionMessageStateDirectory, resolveTrustDatabasePath } from "./runtime-config.js";

// Common wake contract only. Vendor transports live in wake-transport-*.ts; wake-transports.ts composes them.

export interface VerifiedInputSourceReader {
  readVerifiedInputSource(receiptId: string): InputSourceReceiptV1 | null;
}

/**
 * handed-off: the host accepted the marker; consumption is unknown and never delivery.
 * unknown: whether the host accepted it cannot be told (spawned non-zero exit, timeout, partial write).
 * not-delivered: definitely not handed over, no external effect. prerequisite-missing holds for the birth;
 * transient backs off and retries. Unsupported is a capability declaration, never an outcome.
 */
export type WakeDispatchOutcome =
  | { result: "handed-off" }
  | { result: "unknown"; reasonCode?: string }
  | { result: "not-delivered"; kind: "transient" | "prerequisite-missing"; reasonCode: string };
const REASON_CODE = /^[A-Za-z0-9_:.-]{1,128}$/u;
/** Trust-boundary check for an outcome crossing the broker request (relay → broker → store). */
export function isWakeDispatchOutcome(value: unknown): value is WakeDispatchOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { result, kind, reasonCode, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return false;
  if (result === "handed-off") return kind === undefined && reasonCode === undefined;
  if (result === "unknown") return kind === undefined && (reasonCode === undefined || (typeof reasonCode === "string" && REASON_CODE.test(reasonCode)));
  return result === "not-delivered" && (kind === "transient" || kind === "prerequisite-missing")
    && typeof reasonCode === "string" && REASON_CODE.test(reasonCode);
}
export type WakeLaunchObserver =(event: "native-launch-attempt" | "native-spawn") => void;
export interface WakeDispatchPort {
  capabilities: DeliveryCapabilities;
  /** Only adapters instrumenting their actual launch sites may declare complete coverage. */
  observesNativeLaunch?: boolean;
  /** Time after which an unobserved hand-off may be rung again (doubled per unanswered streak). Not stored in presence. */
  resendBaseMs: number;
  dispatch(target: SessionIdentity, message: string, observe?: WakeLaunchObserver): Promise<WakeDispatchOutcome>;
  /**
   * A prerequisite this port can tell is missing before any wake, without an external effect: the reason code its
   * dispatch would report as prerequisite-missing, or null. Never throws. The relay reports it on its first tick, so the
   * birth is degraded before a sender is told the wake is available.
   */
  prerequisite?(environment?: NodeJS.ProcessEnv): string | null;
}
export function wakeBackoffDelay(attempt: number): number {
  return Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, attempt));
}
/** Node spawn/exec error code (ENOENT etc.); undefined when the cause carries none. */
export function errorCode(cause: unknown): string | undefined {
  const code = cause && typeof cause === "object" && "code" in cause ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

// A writer lifetime is diagnostic provenance, not an authoritative relay lease generation.
const failureWriter = `${Date.now().toString().padStart(13, "0")}-${process.pid}-${randomUUID()}`;
const FAILURE_HISTORY_LIMIT = 64;
const FAILURE_HISTORY_WRITERS_PER_KIND = 4;

export function writeRelayDiagnosticSnapshot(target: string, serialized: string): boolean {
  let descriptor: number | undefined;
  let written: boolean;
  try {
    // O_NOFOLLOW is not supplied on every platform; the opened descriptor is also checked before any write.
    descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK
      | (constants.O_NOFOLLOW ?? 0), 0o600);
    const opened = fstatSync(descriptor);
    const linked = lstatSync(target);
    if (!opened.isFile() || opened.nlink !== 1 || linked.isSymbolicLink() || !linked.isFile()
      || opened.dev !== linked.dev || opened.ino !== linked.ino
      || (process.getuid && opened.uid !== process.getuid())) return false;
    try { fchmodSync(descriptor, 0o600); } catch { if (process.platform !== "win32") return false; }
    // Best-effort snapshot: concurrent readers may see a partial record; never an authority source.
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, serialized + "\n", { encoding: "utf8" });
    written = true;
  } finally {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch { written = false; }
  }
  return written;
}

/** Keep failure kinds separate so repeated tick failures cannot erase a wake failure. */
function persistRelayFailureHistory(directory: string, serialized: string): void {
  try {
    const diagnostic: unknown = JSON.parse(serialized);
    if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return;
    const { phase, reason } = diagnostic as { phase?: unknown; reason?: unknown };
    const kind = createHash("sha256").update(JSON.stringify([
      typeof phase === "string" ? phase : null, typeof reason === "string" ? reason : null,
    ])).digest("hex").slice(0, 16);
    const history = path.join(directory, "relay-failures");
    mkdirSync(history, { recursive: true, mode: 0o700 });
    const info = lstatSync(history);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) return;
    try { chmodSync(history, 0o700); } catch { if (process.platform !== "win32") return; }
    writeRelayDiagnosticSnapshot(path.join(history, `${failureWriter}-${kind}.json`), serialized);
    // ponytail: reserve one observation per kind before allocating spare history slots.
    // At most 64 settled snapshots (~4 MiB), at most 4 per kind; bursts can briefly exceed it.
    const records = readdirSync(history, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^\d{13}-\d+-[a-f0-9-]{36}-[a-f0-9]{16}\.json$/u.test(entry.name))
      .flatMap(entry => {
        try {
          const current = lstatSync(path.join(history, entry.name));
          return current.isFile() ? [{ name: entry.name, modified: current.mtimeMs }] : [];
        } catch (cause) {
          if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") return [];
          throw cause;
        }
      })
      .sort((left, right) => left.modified - right.modified || left.name.localeCompare(right.name))
      .map(entry => entry.name);
    const byKind = new Map<string, string[]>();
    for (const name of records) {
      const key = name.slice(-21, -5);
      const writers = byKind.get(key) ?? [];
      writers.push(name);
      byKind.set(key, writers);
    }
    const rank = new Map(records.map((name, index) => [name, index]));
    const kinds = [...byKind.values()]
      .sort((left, right) => rank.get(left.at(-1)!)! - rank.get(right.at(-1)!)!)
      .slice(-FAILURE_HISTORY_LIMIT);
    const latest = kinds.map(writers => writers.at(-1)!);
    const spare = kinds.flatMap(writers => writers.slice(-FAILURE_HISTORY_WRITERS_PER_KIND, -1))
      .sort((left, right) => rank.get(right)! - rank.get(left)!).slice(0, FAILURE_HISTORY_LIMIT - latest.length);
    const retained = new Set([...latest, ...spare]);
    for (const name of records.filter(record => !retained.has(record))) {
      try { unlinkSync(path.join(history, name)); }
      catch (cause) { if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")) throw cause; }
    }
  } catch (cause) {
    // A failed diagnostic sink cannot replace the original relay/wake outcome; expose only safe metadata.
    try { console.error("[agent-governance-suite] relay-history-failure " + JSON.stringify(failureContext(cause))); }
    catch { /* The primary failure remains independent of stderr too. */ }
  }
}

/** Latest-file compatibility plus bounded per-writer/failure-kind observations. */
/** `create: false` writes only into an existing state directory (a refused hook must not create state). */
export function persistRelayFailure(serialized: string, environment: NodeJS.ProcessEnv = process.env, create = true): void {
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) return;
  try {
    const directory = resolveSessionMessageStateDirectory(environment);
    if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
      || (process.getuid && directoryInfo.uid !== process.getuid())) return;
    try { chmodSync(directory, 0o700); } catch { if (process.platform !== "win32") return; }
    persistRelayFailureHistory(directory, serialized);
    writeRelayDiagnosticSnapshot(path.join(directory, "relay-failure.latest.json"), serialized);
  } catch { /* Diagnostic I/O cannot change the relay failure or stop cleanup. */ }
}
/** Bounded diagnostic only: failureContext never emits messages, argv, stdout or paths. Vendors pass their own detail. */
export function reportWakeFailure(phase: string, error: Error, environment: NodeJS.ProcessEnv = process.env, detail?: string): void {
  const serialized = JSON.stringify({
    phase,
    reason: producerFailureReason(error),
    ...(detail ? { detail } : {}),
    context: failureContext(error),
  });
  persistRelayFailure(serialized, environment);
  console.error(`agent-governance-suite wake diagnostic ${serialized}`);
}

/** Local root-hook liveness only; this cannot attest permission or W06 authority. */
const WAKE_CAPABILITY_VERSION = "3.0.0";
export function isWakeHookObservation(value: unknown, target: SessionIdentity): value is InputObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as InputObservation;
  return event.host === target.host && event.sessionId === target.sessionId && event.kind === "user-input"
    && event.wakeOnly === true && actorAccess(event.actor).allowed
    && Array.isArray(event.wakeCandidates) && event.wakeCandidates.length > 0
    && event.wakeCandidates.length <= 10 && event.wakeCandidates.every((nonce) => typeof nonce === "string"
      && /^[A-Za-z0-9_-]{22,128}$/u.test(nonce));
}

export interface WakeHookObservationReader {
  verifyObservation(target: SessionIdentity, observation: InputObservation, receiptId: string, nowMs: number): boolean;
}
function observationDigest(event: InputObservation): `sha256:${string}` {
  const normalized = [event.host, event.sessionId, event.kind, event.wakeOnly,
    event.actor.role, event.actor.basis, [...new Set(event.wakeCandidates)].sort()];
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

/** Uses existing, non-authorizing source provenance. No public tool issues this hook receipt. */
export function recordWakeHookObservation(observation: InputObservation, nowMs = Date.now()): string {
  if (!isWakeHookObservation(observation, observation)) throw new Error("Invalid host wake observation.");
  const trust = new TrustStore(resolveTrustDatabasePath());
  try {
    return trust.recordInputSource({ originKind: "peer", host: observation.host, sessionId: observation.sessionId,
      eventId: `wake-hook-${randomUUID()}`, contentDigest: observationDigest(observation),
      observedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + 30_000).toISOString(), authorityEffect: "none",
      attestation: { kind: "broker-peer-envelope", adapter: "session-message-wake-hook", capabilityVersion: WAKE_CAPABILITY_VERSION } }).receiptId;
  } finally { trust.close(); }
}
export function createWakeHookObservationReader(source: string | VerifiedInputSourceReader = resolveTrustDatabasePath()): WakeHookObservationReader {
  return {
  verifyObservation(target, observation, receiptId, nowMs) {
    if (!isWakeHookObservation(observation, target) || !receiptId) return false;
    const receipt = typeof source === "string" ? TrustStore.readVerifiedInputSource(source, receiptId) : source.readVerifiedInputSource(receiptId);
    return receipt !== null && receipt.schemaVersion === "1.0.0" && receipt.receiptId === receiptId
      && receipt.host === target.host && receipt.sessionId === target.sessionId
      && receipt.originKind === "peer" && receipt.authorityEffect === "none"
      && receipt.attestation?.kind === "broker-peer-envelope" && receipt.attestation.adapter === "session-message-wake-hook"
      && receipt.attestation.capabilityVersion === WAKE_CAPABILITY_VERSION && receipt.contentDigest === observationDigest(observation)
      && Date.parse(receipt.observedAt) <= nowMs && Date.parse(receipt.expiresAt) > nowMs;
  },
  };
}
export const wakeHookObservationReader: WakeHookObservationReader = {
  verifyObservation: (...args) => createWakeHookObservationReader().verifyObservation(...args),
};
