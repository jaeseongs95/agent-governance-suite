import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { actorAccess, type DeliveryCapabilities, type InputObservation } from "./input-observation.js";
import type { SessionIdentity } from "./session-message-store.js";
import { TrustStore } from "./trust-store.js";
import { failureContext, producerFailure, producerFailureReason, retainFailureCause } from "./failure-diagnostics.js";
import type { InputSourceReceiptV1 } from "../../contracts/types.js";

export interface VerifiedInputSourceReader {
  readVerifiedInputSource(receiptId: string): InputSourceReceiptV1 | null;
}
import { resolveSessionMessageStateDirectory, resolveTrustDatabasePath } from "./runtime-config.js";

/** target-unavailable requires an authoritative host rejection for this exact target, never a generic transport error. */
export type WakeDispatchOutcome = "submitted" | "definite-failure" | "accepted-or-unknown" | "target-unavailable";
export type WakeLaunchObserver = (event: "native-launch-attempt" | "native-spawn") => void;
export interface WakeDispatchPort {
  capabilities: DeliveryCapabilities;
  /** Only adapters instrumenting their actual launch sites may declare complete coverage. */
  observesNativeLaunch?: boolean;
  dispatch(target: SessionIdentity, message: string, observe?: WakeLaunchObserver): Promise<WakeDispatchOutcome>;
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
export function geminiWakeOutcome(error: unknown, spawned: boolean): WakeDispatchOutcome {
  return !error ? "submitted" : spawned ? "accepted-or-unknown" : "definite-failure";
}
function isWindowsNativeExecutable(candidatePath: string): boolean {
  const root = path.win32.parse(candidatePath).root;
  return root !== "\\" && root !== "/" && path.win32.isAbsolute(candidatePath)
    && path.win32.extname(candidatePath).toLowerCase() === ".exe"
    && !/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(candidatePath);
}
function isVerifiedWindowsNativeExecutable(candidatePath: string): boolean {
  return isWindowsNativeExecutable(candidatePath)
    && !/(?:^|[\\/])(?:tmp|var[\\/]tmp|dev[\\/]shm|temp|appdata[\\/]local[\\/]temp|users[\\/]public)(?:[\\/]|$)/iu.test(candidatePath);
}
// # ponytail: host-internal format stopgap (language_server.log, projects/*.json, agentapi.bat); replace with official host wake contract when available
export function resolveWindowsAgentApiFromShim(homeDir: string): { exe: string | null; diagnostic?: string } {
  // Antigravity's native hook executor does not set ANTIGRAVITY_AGENTAPI_EXE when spawning hooks or
  // detached relays, and instead writes <HOME>/.gemini/antigravity/bin/agentapi.bat wrapping the
  // native language_server*.exe. Never execute the .bat shim or invoke cmd.exe (D-0311); read it
  // as inert text and extract the quoted absolute .exe target only when it exists on disk.
  if (!homeDir) return { exe: null, diagnostic: "AGENTAPI_SHIM_MISSING" };
  let shimText: string;
  try {
    shimText = readFileSync(path.join(homeDir, ".gemini", "antigravity", "bin", "agentapi.bat"), "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    return { exe: null, diagnostic: code === "ENOENT" ? "AGENTAPI_SHIM_MISSING" : "AGENTAPI_SHIM_READ_FAILED" };
  }
  const match = /^"([A-Za-z]:[\\/][^\r\n"]+?\.exe)"\s+agentapi(?:\s|$)/imu.exec(shimText);
  const extracted = match?.[1]?.trim() ?? "";
  if (!extracted) return { exe: null, diagnostic: "AGENTAPI_SHIM_FORMAT_UNRECOGNIZED" };
  if (!isVerifiedWindowsNativeExecutable(extracted)) return { exe: null, diagnostic: "AGENTAPI_SHIM_TARGET_UNTRUSTED" };
  if (!existsSync(extracted)) return { exe: null, diagnostic: "AGENTAPI_SHIM_TARGET_MISSING" };
  return { exe: extracted };
}
function resolveGeminiAgentApiWithDiagnostic(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { launch: { command: string; argsPrefix: string[] } | null; diagnostic?: string } {
  const configured = environment.ANTIGRAVITY_AGENTAPI_EXE;
  if (configured !== undefined) {
    if (!configured) {
      return platform === "win32"
        ? { launch: null, diagnostic: "missing-agentapi-exe:AGENTAPI_EXE_EMPTY" }
        : { launch: { command: "agentapi", argsPrefix: [] } };
    }
    if (platform === "win32" && !isWindowsNativeExecutable(configured)) {
      return { launch: null, diagnostic: "missing-agentapi-exe:AGENTAPI_EXE_UNVERIFIED" };
    }
    return { launch: { command: configured, argsPrefix: ["agentapi"] } };
  }
  const homeDir = environment.USERPROFILE || environment.HOME || "";
  if (platform === "win32") {
    const shim = resolveWindowsAgentApiFromShim(homeDir);
    if (shim.exe) {
      return { launch: { command: shim.exe, argsPrefix: ["agentapi"] } };
    }
    return { launch: null, diagnostic: `missing-agentapi-exe:${shim.diagnostic ?? "AGENTAPI_SHIM_MISSING"}` };
  }
  const command = path.join(homeDir, ".gemini", "antigravity", "bin", "agentapi");
  return { launch: { command: existsSync(command) ? command : "agentapi", argsPrefix: [] } };
}
export function resolveGeminiAgentApi(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { command: string; argsPrefix: string[] } | null {
  return resolveGeminiAgentApiWithDiagnostic(environment, platform).launch;
}
// A writer lifetime is diagnostic provenance, not an authoritative relay lease generation.
const failureWriter = `${Date.now().toString().padStart(13, "0")}-${process.pid}-${randomUUID()}`;
const FAILURE_HISTORY_LIMIT = 64;
const FAILURE_HISTORY_WRITERS_PER_KIND = 4;

export function writeRelayDiagnosticSnapshot(target: string, serialized: string): boolean {
  let descriptor: number | undefined;
  let written = false;
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
export function persistRelayFailure(serialized: string, environment: NodeJS.ProcessEnv = process.env): void {
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) return;
  try {
    const directory = resolveSessionMessageStateDirectory(environment);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
      || (process.getuid && directoryInfo.uid !== process.getuid())) return;
    try { chmodSync(directory, 0o700); } catch { if (process.platform !== "win32") return; }
    persistRelayFailureHistory(directory, serialized);
    writeRelayDiagnosticSnapshot(path.join(directory, "relay-failure.latest.json"), serialized);
  } catch { /* Diagnostic I/O cannot change the relay failure or stop cleanup. */ }
}
function sanitizeWakeEnvDiagnostic(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512) return undefined;
  if (/^[A-Z0-9_,:;.-]+$/u.test(trimmed)) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const codes: string[] = [];
    const collect = (val: unknown): void => {
      if (typeof val === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(val)) codes.push(val);
      else if (Array.isArray(val)) for (const item of val) collect(item);
      else if (val && typeof val === "object") for (const item of Object.values(val as Record<string, unknown>)) collect(item);
    };
    collect(parsed);
    return codes.length > 0 ? codes.join(",") : undefined;
  } catch {
    return undefined;
  }
}
/** Bounded diagnostic only: failureContext never emits messages, argv, stdout or paths. */
function reportWakeFailure(phase: string, error: Error, environment: NodeJS.ProcessEnv = process.env, detail?: string): void {
  const envDiag = sanitizeWakeEnvDiagnostic(environment.ANTIGRAVITY_WAKE_ENV_DIAGNOSTIC);
  const mergedDetail = [detail, envDiag].filter(Boolean).join(";") || undefined;
  const serialized = JSON.stringify({
    phase,
    reason: producerFailureReason(error),
    ...(mergedDetail ? { detail: mergedDetail } : {}),
    context: failureContext(error),
  });
  persistRelayFailure(serialized, environment);
  console.error(`agent-governance-suite wake diagnostic ${serialized}`);
}
async function ringGemini(sessionId: string, message: string, environment: NodeJS.ProcessEnv = process.env): Promise<WakeDispatchOutcome> {
  const childEnv: NodeJS.ProcessEnv = { ...environment };
  const sourceProjectId = childEnv.ANTIGRAVITY_PROJECT_ID;
  if (typeof sourceProjectId !== "string" || !sourceProjectId.trim()) {
    reportWakeFailure("gemini-preflight", producerFailure("GEMINI_PROJECT_ID_MISSING", "Gemini source project identity is missing."), childEnv, "missing-project-id");
    return "definite-failure";
  }
  const { launch, diagnostic: launchDiagnostic } = resolveGeminiAgentApiWithDiagnostic(childEnv);
  if (!launch) {
    reportWakeFailure("gemini-preflight", producerFailure("GEMINI_AGENTAPI_UNAVAILABLE", "Gemini agentapi executable is unavailable."), childEnv, launchDiagnostic ?? "missing-agentapi-exe");
    return "definite-failure";
  }
  const { command, argsPrefix } = launch;
  let targetProjectId: string;
  try {
    const meta = await new Promise<string>((resolve, reject) => {
      execFile(command, [...argsPrefix, "get-conversation-metadata", sessionId],
        { windowsHide: true, timeout: 5_000, env: childEnv, shell: false, windowsVerbatimArguments: false },
        (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    const parsed = JSON.parse(meta) as {
      response?: { conversationMetadata?: { metadata?: { projectId?: unknown } } };
    };
    const projectId = parsed.response?.conversationMetadata?.metadata?.projectId;
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw producerFailure("GEMINI_METADATA_PROJECT_MISSING", "Gemini conversation metadata has no project identity.");
    }
    targetProjectId = projectId;
  } catch (cause) {
    // Metadata failure happens before any send-message process is started. Keep the actual cause; never send.
    const error = producerFailureReason(cause) ? cause as Error
      : retainFailureCause(producerFailure("GEMINI_METADATA_FAILED", "Gemini conversation metadata lookup failed."), cause);
    reportWakeFailure("gemini-metadata", error, childEnv);
    return "definite-failure";
  }
  if (sourceProjectId !== targetProjectId) {
    reportWakeFailure("gemini-metadata", producerFailure("GEMINI_PROJECT_MISMATCH", "Gemini conversation project identity does not match."), childEnv);
    return "definite-failure";
  }
  return new Promise((resolve) => {
    let spawned = false;
    let settled = false;
    const finish = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (error) {
        const tagged = producerFailureReason(error) ? error as Error
          : retainFailureCause(producerFailure("GEMINI_SEND_FAILED", "Gemini send-message failed."), error);
        reportWakeFailure("gemini-send", tagged, childEnv);
      }
      resolve(geminiWakeOutcome(error, spawned));
    };
    try {
      const child = execFile(command, [...argsPrefix, "send-message", sessionId, message],
        { windowsHide: true, timeout: 10_000, env: childEnv, shell: false, windowsVerbatimArguments: false },
        (error) => finish(error));
      child.once("spawn", () => { spawned = true; });
      child.once("error", (error) => finish(error));
    } catch (cause) {
      finish(cause);
    }
  });
}
function ringCodex(sessionId: string, message: string, observe?: WakeLaunchObserver): Promise<WakeDispatchOutcome> {
  return new Promise((resolve) => {
    let spawned = false;
    try { observe?.("native-launch-attempt"); } catch { /* Observation never changes submission. */ }
    const child = execFile("codex", ["queue", "--thread", sessionId, "--message", message],
      { windowsHide: true, timeout: 10_000 }, (error) => resolve(codexWakeOutcome(error, spawned)));
    child.once("spawn", () => {
      spawned = true;
      try { observe?.("native-spawn"); } catch { /* Observation never changes the outcome. */ }
    });
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
  ["codex-queue", { capabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" }, observesNativeLaunch: true,
    dispatch: (target, message, observe) => ringCodex(target.sessionId, message, observe) }],
  ["codex-deferred", { capabilities: { supportedInjection: ["tool-boundary"], idleWake: "none" }, observesNativeLaunch: true,
    dispatch: async () => "definite-failure" }],
  ["gemini-deferred", { capabilities: { supportedInjection: ["tool-boundary"], idleWake: "none" }, observesNativeLaunch: true,
    dispatch: async () => "definite-failure" }],
  ["gemini-queue", { capabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" },
    dispatch: (target, message) => ringGemini(target.sessionId, message) }],
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

/** Local root-hook liveness only; this cannot attest permission or W06 authority. */
const WAKE_ACTOR_BASES = ["observed", "inferred"] as const;
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
  if (!receipt || receipt.schemaVersion !== "1.0.0" || receipt.receiptId !== sourceReceiptId
    || receipt.host !== target.host || receipt.sessionId !== target.sessionId
    || receipt.originKind !== "peer" || receipt.authorityEffect !== "none"
    || receipt.attestation?.kind !== "broker-peer-envelope" || receipt.attestation.adapter !== "session-message-wake-hook"
    || receipt.attestation.capabilityVersion !== WAKE_CAPABILITY_VERSION) return null;
  const [started, observed, late, expires] = [Date.parse(startedAt), Date.parse(receipt.observedAt),
    Date.parse(lateObservedAt), Date.parse(receipt.expiresAt)] as const;
  if (![started, observed, late, expires, nowMs].every(Number.isFinite)
    || !(started <= observed && observed <= late && late < expires && expires <= nowMs)) return null;
  // Exactly two admitted root observations; diagnostic reasons never enter the signed digest.
  let matches = 0;
  for (const basis of WAKE_ACTOR_BASES) {
    const observation: InputObservation = { ...target, kind: "user-input", wakeOnly: true, wakeCandidates: [nonce],
      actor: { role: "root", basis, reasonCode: "HISTORICAL_WAKE_RECONSTRUCTION" } };
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
