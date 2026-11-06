import { isHookEntry } from "./hook-entry.js";
import { actorAccess } from "./input-observation.js";
import { hookFailure, hookFailureContext, hookFailureReason, retainHookFailureCause, retainHookFailureSecondary, tagHookFailure, writeDiagnostic } from "./hook-error-diagnostics.js";
import "./builtin-hook-host-adapters.js";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { persistRelayFailure, recordWakeHookObservation } from "./session-message-wake-port.js";
import { sessionMessageRequest } from "./session-message-client.js";
import { resolveTrustDatabasePath } from "./runtime-config.js";
import type { SessionMessageTransport } from "./session-message-relay.js";
import type { SessionMessage } from "./session-message-store.js";
import { TrustStore } from "./trust-store.js";
import { hostAliveAtBound } from "./host-process-watch.js";
import { readRelayCodeDigest } from "./relay-code-identity.js";
import { adaptHostInput, hostDeliveryProfile, nativePeerWait, resolveHookHost, resolveHookProcessPid, turnEndContinuation, type SupportedHookHost } from "./host-input-adapter.js";

// Addons register and consume this exact bundled namespace; other bundles/processes have separate registries.
export { registerHookHostAdapter } from "./host-input-adapter.js";
import { supportsInjection } from "./input-observation.js";
import type { PeerWaitDecision } from "./peer-wait-policy.js";
import { SESSION_MESSAGE_HOOK_CONTEXT_MAX_BYTES } from "./session-message-protocol.js";
import { msg, render, resolveHostLocale, type SupportedLocale } from "./i18n.js";

const HOST_CLAIM_MAX_MESSAGES = 1;
const HOST_CLAIM_MAX_BODY_CHARS = 4096;
const HOST_MESSAGE_REQUEST_TIMEOUT_MS = 8_000;

export function sessionMessageTransport(host: SupportedHookHost, environment: NodeJS.ProcessEnv = process.env, defaultQueueWake = false): SessionMessageTransport {
  return hostDeliveryProfile(host, environment, undefined, defaultQueueWake).transport;
}

export interface SessionMessageHookOptions {
  /** Call-local adapter default only; explicit ENV and bounded file settings take precedence.
   * Adapters without a configurable queue default ignore this setting. */
  defaultQueueWake?: boolean;
  /** Adapter-observed OS process generation, never an attestation or caller payload binding. */
  hostProcess?: Readonly<{ pid: number; startToken: string }>;
  /** Opt-in atomic ensure. Requires verified hostProcess and a caller execution budget. */
  ensureRelay?: boolean;
  /** Reconnect on an observed main-session event, using the same atomic startup grant. */
  recoverExistingSession?: boolean;
  /** Host adapter callback; snapshots the claiming event's generation before asynchronous recovery. */
  resolveHostProcess?: () => Readonly<{ pid: number; startToken: string }> | null | Promise<Readonly<{ pid: number; startToken: string }> | null>;
  /** Host PID read only when relay recovery needs it, within timeoutMs; an explicit host PID takes precedence.
   * Rejects with a fixed reason when the PID cannot be read. */
  resolveHostPid?: (timeoutMs: number) => Promise<number>;
  /** Adapter-scoped environment overrides passed only to a spawned relay child; never mutates process.env. */
  relayEnv?: Readonly<Record<string, string | undefined>>;
  /** 비동기 수명 어댑터가 참조된 자식을 close까지 소유한다. 동기 복구 훅에서는 사용하지 않는다. */
  relayOwner?: (child: ChildProcess) => void;
  /** Windows only. Set by a hook entry whose host shell hands this process the host's own pipes as inheritable handles
   * (Codex runs hook commands through PowerShell and waits for pipe EOF). A detached relay spawned by node would inherit
   * them, so the host would wait until its hook timeout and then terminate the hook's job with the relay in it.
   * The relay is then started through ShellExecute, which inherits no handles (launchWithoutInheritedHandles). */
  isolateDetachedHandles?: boolean;
  /** Adapter starts this same-process monotonic deadline before imports/resolution, excluding its stdout reserve. */
  executionBudget?: Readonly<{ deadlineMonotonicMs: number; postClaimReserveMs: number }>;
  /** Synchronous observation only, IDs only. Returns are ignored; throws/rejections cannot change claim or cleanup.
   * Synchronous hook reentry is rejected. Async continuations are caller code, not an awaited hook phase. */
  onClaimState?: (state: Readonly<{ phase: "request-attempted" | "response-received"; messageIds: readonly string[] }>) => void;
}

export type HookFailurePhase = "options" | "input" | "handle" | "serialize" | "stdin" | "host-entry" | "stdout"
  | "presence-start" | "clear-deferred" | "ensure-relay" | "relay-start" | "recovery" | "peer-wait" | "observer-sync" | "observer-async"
  | "presence-end" | "wake-claim";

/** The step a handle-phase failure stopped in: a messaging operation name or a fixed local step. Never input values. */
export type HookFailureStep = string;

/** The same bounded classification that the diagnostic line carries; never messages, paths or peer bodies. */
export type SessionMessageHookFailure = Readonly<{
  phase: HookFailurePhase;
  reason: string;
  reasonBasis: "unverified-observation" | "producer" | "unknown";
  producerReason?: string;
  /** Present when the failure happened inside a known step of the phase (for example a budget that expired there). */
  step?: HookFailureStep;
}>;

/** Distinguishes a failed hook from a successful hook that had nothing to inject. Both stay fail-open (empty output). */
export type SessionMessageHookOutcome =
  | Readonly<{ ok: true; output: string }>
  | Readonly<{ ok: false; output: ""; failure: SessionMessageHookFailure }>;

// Hook stderr may be discarded by the host; relay-path outcomes are also kept in the local relay failure record.
const PERSISTED_HOOK_PHASES: ReadonlySet<HookFailurePhase> = new Set(["presence-start", "ensure-relay", "relay-start", "recovery", "wake-claim"]);
/** Bounded metadata only: an OS exit status or signal name, never child output, argv or environment. */
type HookFailureDetail = Readonly<{ grantReason?: string; exitCode?: number | null; signal?: string | null }>;

/** Fixed producer/OS reasons plus bounded metadata; never error messages, SQL, paths or peer bodies. */
function reportHookFailure(phase: HookFailurePhase, error: unknown, detail?: HookFailureDetail, step?: HookFailureStep): SessionMessageHookFailure {
  const context = hookFailureContext(error);
  let reason = "UNEXPECTED_FAILURE";
  try {
    if (context.type === "syntax-error") reason = "INVALID_JSON";
    else if (context.opaque !== "proxy" && error && typeof error === "object") {
      const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
      const sqliteCode = (context.sqlite as { primaryCode?: number } | undefined)?.primaryCode;
      if (typeof code === "string" && ["EACCES", "EPERM", "EIO", "ENOENT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(code)) reason = code;
      else if (sqliteCode === 5 || sqliteCode === 6) reason = "STORE_BUSY";
      else if (sqliteCode === 11 || sqliteCode === 26) reason = "STORE_CORRUPT";
      else if (sqliteCode !== undefined) reason = ({ 3: "STORE_PERMISSION", 8: "STORE_READONLY",
        10: "STORE_IO", 13: "STORE_FULL", 14: "STORE_CANTOPEN", 19: "STORE_CONSTRAINT" } as Record<number, string>)[sqliteCode] ?? "STORE_ERROR";
    }
  } catch { /* Unreadable error properties are not trusted diagnostics. */ }
  const ownedReason = hookFailureReason(error);
  const observed = reason !== "UNEXPECTED_FAILURE";
  const reasonBasis: SessionMessageHookFailure["reasonBasis"] = observed ? "unverified-observation" : ownedReason ? "producer" : "unknown";
  if (!observed) reason = ownedReason ?? reason;
  const failure: SessionMessageHookFailure = Object.freeze({ phase, reason, reasonBasis,
    ...(ownedReason ? {producerReason: ownedReason} : {}), ...(step ? { step } : {}) });
  try { writeDiagnostic("session-message-hook", "peer-hook-failure", { ...failure, context }); }
  catch { /* A broken diagnostic sink cannot block a hook or authorize replay. */ }
  if (PERSISTED_HOOK_PHASES.has(phase)) {
    // A hook refused before any broker contact (unverified host birth) leaves no state: it never creates the directory.
    try { persistRelayFailure(JSON.stringify({ phase: "hook-" + phase, reason: failure.reason, reasonBasis, context, ...detail }), process.env, false); }
    catch { /* The record is diagnostic only. */ }
  }
  return failure;
}

/** A relay that is not started is a recorded outcome with a fixed reason, never a silent return. */
function relayNotStarted(reason: string, detail?: HookFailureDetail): void {
  reportHookFailure("relay-start", hookFailure(reason, "The session relay was not started."), detail);
}

type HookBudget = SessionMessageHookOptions["executionBudget"];
let observingClaimState = false;

function remainingBudget(budget: HookBudget, reserve = 0): number {
  return budget ? budget.deadlineMonotonicMs - performance.now() - reserve : Infinity;
}

function assertHookBudget(budget: HookBudget, reserve = 0): void {
  if (remainingBudget(budget, reserve) < 1) throw hookFailure("HOOK_BUDGET_EXPIRED", "The session message hook budget expired.");
}

/** Check synchronous I/O and output boundaries, never cleanup. Keep a producer failure as the primary cause. */
function budgetedStep<T>(budget: HookBudget, run: () => T): T {
  assertHookBudget(budget);
  const result = run();
  assertHookBudget(budget);
  return result;
}

function budgetedTimeout(budget: HookBudget, maximumMs: number): number {
  assertHookBudget(budget);
  return Math.min(maximumMs, remainingBudget(budget));
}

/** A child step bounded by the remaining budget that ended at the deadline reports the expired budget, keeping its cause. */
function budgetExpiredOr(budget: HookBudget, error: unknown): unknown {
  return budget && budget.deadlineMonotonicMs - performance.now() < 1
    ? retainHookFailureCause(hookFailure("HOOK_BUDGET_EXPIRED", "The session message hook budget expired."), error) : error;
}

function snapshotOptions(options: SessionMessageHookOptions): SessionMessageHookOptions {
  if (observingClaimState) throw hookFailure("CLAIM_OBSERVER_REENTRY", "Claim observers cannot reenter the hook synchronously.");
  const budget = options.executionBudget ? Object.freeze({ ...options.executionBudget }) : undefined;
  if (budget && (!Number.isFinite(budget.deadlineMonotonicMs) || !Number.isFinite(budget.postClaimReserveMs) || budget.postClaimReserveMs < 0)) {
    throw hookFailure("INVALID_HOOK_BUDGET", "The session message hook budget is invalid.");
  }
  if (options.onClaimState !== undefined && (typeof options.onClaimState !== "function" || !budget)) {
    throw hookFailure("CLAIM_OBSERVER_BUDGET_REQUIRED", "Claim observation requires an execution budget.");
  }
  if (options.defaultQueueWake !== undefined && typeof options.defaultQueueWake !== "boolean") throw hookFailure("INVALID_QUEUE_DEFAULT", "Invalid queue default setting.");
  if (options.ensureRelay !== undefined && typeof options.ensureRelay !== "boolean") throw hookFailure("INVALID_RELAY_ENSURE_OPTION", "Invalid relay ensure capability.");
  if (options.recoverExistingSession !== undefined && typeof options.recoverExistingSession !== "boolean") throw hookFailure("INVALID_RELAY_RECOVERY_OPTION", "Invalid relay recovery capability.");
  if (options.resolveHostProcess !== undefined && typeof options.resolveHostProcess !== "function") throw hookFailure("INVALID_HOST_PROCESS_RESOLVER", "Invalid host process resolver.");
  if (options.resolveHostPid !== undefined && typeof options.resolveHostPid !== "function") throw hookFailure("INVALID_HOST_PID_RESOLVER", "Invalid host PID resolver.");
  if (options.relayOwner !== undefined && typeof options.relayOwner !== "function") throw hookFailure("INVALID_RELAY_OWNER", "Invalid relay owner.");
  if (options.isolateDetachedHandles !== undefined && typeof options.isolateDetachedHandles !== "boolean") {
    throw hookFailure("INVALID_HANDLE_ISOLATION_OPTION", "Invalid handle isolation option.");
  }
  if (options.relayEnv !== undefined && (!options.relayEnv || typeof options.relayEnv !== "object" || Array.isArray(options.relayEnv))) {
    throw hookFailure("INVALID_RELAY_ENV", "Invalid relay environment overrides.");
  }
  if (options.recoverExistingSession && (!budget || (!options.hostProcess && !options.resolveHostProcess))) throw hookFailure("RELAY_RECOVERY_CONTEXT_REQUIRED", "Relay recovery requires a host process resolver and budget.");
  if (options.ensureRelay && (!options.hostProcess || !budget)) throw hookFailure("RELAY_ENSURE_CONTEXT_REQUIRED", "Relay ensure requires a host process observation and budget.");
  assertHookBudget(budget);
  return { ...options, ...(budget ? { executionBudget: budget } : {}),
    ...(options.hostProcess ? { hostProcess: { ...options.hostProcess } } : {}),
    ...(options.relayEnv ? { relayEnv: options.relayEnv } : {}) };
}

function observeClaim(options: SessionMessageHookOptions, phase: "request-attempted" | "response-received", messageIds: string[]): void {
  observingClaimState = true;
  try {
    const state = Object.freeze({ phase, messageIds: Object.freeze([...messageIds]) });
    Promise.resolve(options.onClaimState?.(state)).catch((error) => reportHookFailure("observer-async", error));
  } catch (error) { reportHookFailure("observer-sync", error); }
  finally { observingClaimState = false; }
}


type RelayRecoveryHint = { relayRecovery?: { instanceId?: string; hostPid?: number; replace?: boolean } };
const RELAY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The environment a relay of this hook receives: the host's own, overlaid with adapter-derived relay values. */
function relayEnvironment(relayEnv?: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  return relayEnv && Object.keys(relayEnv).length > 0 ? { ...process.env, ...relayEnv } : process.env;
}
type ClaimWithRecovery = { messages: SessionMessage[] } & RelayRecoveryHint;

/** The relay installed beside this hook; its digest names the code a grant is for (D0348). */
function installedRelayCode(): string | null {
  const entry = new URL("./session-message-relay.mjs", import.meta.url);
  return existsSync(entry) ? readRelayCodeDigest(entry) : null;
}

/** One argument in CommandLineToArgvW form, the quoting libuv applies to spawn arguments. */
function windowsArgument(value: string): string {
  if (value && !/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/u, "$1$1")}"`;
}

function windowsPowerShell(): string {
  return `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** Windows: starts node with these arguments through Start-Process without -NoNewWindow, i.e. ShellExecuteEx, so the
 * process gets this process's environment and job but none of its handles. */
function launchWithoutInheritedHandles(args: readonly string[], environment: NodeJS.ProcessEnv, timeoutMs: number,
  done: (error: Error | null, pid?: number) => void): void {
  // PowerShell also closes a single-quoted string at U+2018-U+201B.
  const literal = (value: string) => `'${value.replace(/['\u2018\u2019\u201a\u201b]/gu, "$&$&")}'`;
  const script = `$p = Start-Process -FilePath ${literal(process.execPath)} -ArgumentList ${literal(args.map(windowsArgument).join(" "))}`
    + " -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)";
  const powershell = windowsPowerShell();
  try {
    // execFile accepts only an unsigned integer timeout, and 0 would mean no timeout.
    execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: environment, windowsHide: true, timeout: Math.max(1, Math.floor(timeoutMs)) }, (error, stdout) => {
        const pid = Number(String(stdout).trim());
        if (error) done(error);
        else if (!Number.isSafeInteger(pid) || pid < 1) done(hookFailure("LAUNCHER_PID_MISSING", "The launcher reported no process."));
        else done(null, pid);
      });
  } catch (error) {
    done(error instanceof Error ? error : new Error(String(error)));
  }
}

const RELAY_LAUNCHER_TIMEOUT_MS = 5_000;
const HOST_PID_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * The parent PID of a live process, read from the OS within timeoutMs. Node has no API for another process's parent;
 * Windows reads it through CIM, which costs a PowerShell start, so callers read it only when they need it.
 */
export function readParentProcessId(pid: number, timeoutMs: number, platform: NodeJS.Platform = process.platform): Promise<number> {
  if (!Number.isSafeInteger(pid) || pid < 1) return Promise.reject(hookFailure("HOST_PID_LOOKUP_INVALID", "The process id is invalid."));
  const [command, args] = platform === "win32"
    ? [windowsPowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive",
      "-EncodedCommand", Buffer.from(`[Console]::Out.Write((Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop).ParentProcessId)`, "utf16le").toString("base64")]]
    : ["ps", ["-o", "ppid=", "-p", String(pid)]];
  return new Promise((resolve, reject) => {
    try {
      execFile(command, args, { windowsHide: true, timeout: Math.max(1, Math.floor(timeoutMs)) }, (error, stdout) => {
        const parent = Number(String(stdout).trim());
        if (error) reject(retainHookFailureCause(hookFailure((error as { killed?: unknown }).killed === true ? "HOST_PID_LOOKUP_TIMED_OUT" : "HOST_PID_LOOKUP_FAILED",
          "The host process id could not be read."), error));
        else if (!Number.isSafeInteger(parent) || parent < 1) reject(hookFailure("HOST_PID_LOOKUP_FAILED", "The host process id could not be read."));
        else resolve(parent);
      });
    } catch (error) {
      reject(retainHookFailureCause(hookFailure("HOST_PID_LOOKUP_FAILED", "The host process id could not be read."), error));
    }
  });
}

/** The launcher exits before this hook does, so the host sees its hook pipes close when the hook exits. A budgeted hook
 * waits for it no longer than its remaining budget: the host would end the hook, with the launcher in its job, first. */
function launchRelayWithoutInheritedHandles(args: readonly string[], environment: NodeJS.ProcessEnv, budget: HookBudget): void {
  launchWithoutInheritedHandles(args, environment, budgetedTimeout(budget, RELAY_LAUNCHER_TIMEOUT_MS), (error) => {
    if (!error) return;
    const expired = budgetExpiredOr(budget, error);
    const { code, signal } = error as { code?: unknown; signal?: unknown };
    if (expired !== error) {
      reportHookFailure("relay-start", expired, { exitCode: null, signal: typeof signal === "string" ? signal : null }, "relay-launcher");
    } else {
      // An OS start code or a launcher reason stays as observed; a launcher exit or timeout gets a fixed reason.
      reportHookFailure("relay-start", typeof code === "string" || hookFailureReason(error) ? error
        : retainHookFailureCause(hookFailure("RELAY_LAUNCHER_FAILED", "The relay launcher reported no relay process."), error),
        { exitCode: typeof code === "number" ? code : null, signal: typeof signal === "string" ? signal : null });
    }
  });
}

function startRelay(host: SupportedHookHost, sessionId: string, instanceId: string, transport: SessionMessageTransport, explicitHostPid: number | undefined, hostProcess: Readonly<{ pid: number; startToken: string }> | undefined, budget: HookBudget, relayId: string, relayEnv?: Readonly<Record<string, string | undefined>>, relayOwner?: SessionMessageHookOptions["relayOwner"], isolateHandles = false): void {
  assertHookBudget(budget);
  const relayPath = fileURLToPath(new URL("./session-message-relay.mjs", import.meta.url));
  // D0011: the relay process records its own abnormal end; this hook may exit before the relay does.
  const relayGuard = new URL("./session-message-relay-guard.mjs", import.meta.url).href;
  const hostPid = hostProcess?.pid ?? resolveHookProcessPid(host, explicitHostPid, hostProcess);
  if (!hostPid || !Number.isInteger(hostPid) || hostPid < 1) { relayNotStarted("RELAY_HOST_PID_UNRESOLVED"); return; }
  // No OS identity query runs here (D0331): the relay's host watcher binds the birth, bounded by this hook's own start.
  const startToken = hostProcess?.startToken;
  const hostAliveAt = hostAliveAtBound();
  assertHookBudget(budget);
  const environment = relayEnvironment(relayEnv);
  const relayArgs = [
    "--import", relayGuard,
    relayPath,
    "--host", host,
    "--session-id", sessionId,
    "--instance-id", instanceId,
    "--transport", transport,
    "--parent-pid", String(hostPid),
    "--relay-id", relayId,
    ...(hostAliveAt ? ["--host-alive-at", hostAliveAt] : []),
    ...(startToken ? ["--parent-start-token", startToken] : []),
  ];
  if (isolateHandles && !relayOwner && process.platform === "win32") {
    launchRelayWithoutInheritedHandles(relayArgs, environment, budget);
    return;
  }
  const child = spawn(process.execPath, relayArgs, {
    detached: !relayOwner,
    windowsHide: true,
    stdio: "ignore",
    env: environment,
  });
  // stdio stays ignored so a healthy detached relay never depends on this short-lived hook. An abnormal relay end
  // (module load failure, rejected arguments, early crash) is recorded by the preloaded guard inside the relay.
  // spawn 실패는 모든 시작 경로에서 비동기로 온다. 수신자가 없으면 보고 없이 훅 밖으로 빠진다.
  child.once("error", (error) => {
    reportHookFailure("relay-start", error); // 확인된 시작은 잠긴 채 남고 자동으로 다시 띄우지 않는다.
  });
  if (relayOwner) {
    // 프로세스 참조와 OS 계보를 유지한다. 비동기 어댑터의 종료 대기는 훅 요청 예산 밖에 둔다.
    try { relayOwner(child); }
    catch (error) {
      try { child.kill(); } catch (stopError) { reportHookFailure("relay-start", stopError); }
      throw error;
    }
  } else child.unref();
}

export type RecordedSessionMessage = SessionMessage & { sourceReceiptId: string; contentDigest: string };

function recordPeerMessages(host: SupportedHookHost, sessionId: string, messages: SessionMessage[], budget?: HookBudget): RecordedSessionMessage[] {
  const databasePath = budgetedStep(budget, resolveTrustDatabasePath);
  assertHookBudget(budget);
  const store = budget ? new TrustStore(databasePath, undefined, { busyTimeoutMs: 0 }) : new TrustStore(databasePath);
  let failed = false;
  let primary: unknown;
  let recorded: RecordedSessionMessage[] = [];
  try {
    recorded = messages.map((message) => {
      const contentDigest: `sha256:${string}` = `sha256:${createHash("sha256").update(message.body).digest("hex")}`;
      const receipt = budgetedStep(budget, () => store.recordInputSource({
        originKind: "peer",
        host,
        sessionId,
        eventId: message.messageId,
        contentDigest,
        observedAt: new Date().toISOString(),
        expiresAt: message.expiresAt,
        authorityEffect: "none",
        attestation: { kind: "broker-peer-envelope", adapter: "session-message-hook", capabilityVersion: "1.0.0" },
      }));
      const verified = budgetedStep(budget, () => store.verify(receipt));
      if (!verified) throw hookFailure("PEER_RECEIPT_VERIFICATION_FAILED", "The recorded peer source receipt did not verify.");
      return { ...message, sourceReceiptId: receipt.receiptId, contentDigest };
    });
  } catch (error) {
    failed = true;
    primary = error && (typeof error === "object" || typeof error === "function") ? error
      : retainHookFailureCause(tagHookFailure(new Error("Cannot process the peer source receipt."), "PEER_RECEIPT_PROCESSING_FAILED"), error);
  }
  try { store.close(); }
  catch (closeError) {
    if (failed) retainHookFailureSecondary(primary, closeError);
    else throw closeError;
  }
  if (failed) throw primary;
  return recorded;
}

/**
 * The acknowledgement contract travels with the messages: a host may show the model neither MCP server instructions
 * nor a deferred tool's description (Codex, measured), so without this line a received message is never acknowledged.
 */
export function sessionMessageEnvelope(messages: RecordedSessionMessage[], locale: SupportedLocale = resolveHostLocale().locale): string {
  const lines: string[] = [render(msg("peer.envelope.ackGuidance", {}), locale)];
  const warning = render(msg("peer.envelope.warning", {}), locale);
  for (const message of messages) {
    const receipt = {
      messageId: message.messageId,
      sourceReceiptId: message.sourceReceiptId,
      contentDigest: message.contentDigest,
      sentAt: message.createdAt,
      expiresAt: message.expiresAt,
      deliveryAttempt: message.deliveryAttempt,
      firstDeliveredAt: message.firstDeliveredAt,
      ...(message.claimReceipt ? { claimReceipt: message.claimReceipt } : {}),
    };
    const block = (body: string, messageEncoding: "plain-json" | "base64-utf8") => [
      // The BEGIN/END markers are fixed delimiters that connectors match; only the warning between them is prose.
      "[agent-governance-suite peer message BEGIN]",
      warning,
      JSON.stringify({
        sender: message.sender,
        recipient: message.recipient,
        message: body,
        messageEncoding,
        receipt,
      }),
      "[agent-governance-suite peer message END]",
    ];
    let encoded = block(message.body, "plain-json");
    if (Buffer.byteLength([...lines, ...encoded].join("\n"), "utf8") > SESSION_MESSAGE_HOOK_CONTEXT_MAX_BYTES) {
      encoded = block(Buffer.from(message.body, "utf8").toString("base64"), "base64-utf8");
    }
    lines.push(...encoded);
  }
  const output = lines.join("\n");
  if (Buffer.byteLength(output, "utf8") > SESSION_MESSAGE_HOOK_CONTEXT_MAX_BYTES) {
    throw hookFailure("PEER_ENVELOPE_TOO_LARGE", "The peer envelope exceeds the host context budget.");
  }
  return output;
}

function additionalContext(event: string, context: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}

/** The broker's guidance in the host locale; a broker without the key, or a key this catalog lacks, keeps its own text. */
function peerWaitGuidance(decision: PeerWaitDecision, locale: SupportedLocale): string {
  if (typeof decision.guidanceKey !== "string") return decision.guidance;
  const rendered = render({ key: decision.guidanceKey, params: decision.guidanceParams ?? {} }, locale);
  return rendered === decision.guidanceKey ? decision.guidance : rendered;
}

/** progress.step names the step in progress; runSessionMessageHookOutcome reports it with a failure of this call. */
export async function handleSessionMessageHook(input: Record<string, unknown>, host: SupportedHookHost, explicitHostPid?: number, options: SessionMessageHookOptions = {},
  progress: { step?: HookFailureStep | undefined } = {}): Promise<Record<string, unknown>> {
  options = snapshotOptions(options);
  const budget = options.executionBudget;
  // Read once, and only when this call shows text (docs/i18n-design.md 4.1 ①).
  let hostLocale: SupportedLocale | undefined;
  const locale = (): SupportedLocale => (hostLocale ??= resolveHostLocale().locale);
  const adapted = adaptHostInput(input, host);
  assertHookBudget(budget);
  const observation = adapted.observation;
  const sessionId = observation.sessionId;
  if (!sessionId) return {};
  const main = actorAccess(observation.actor).allowed;
  // D0364: a wake transport's prerequisites may exist only in the adapter-derived relay environment, so the profile
  // is read from the environment this hook's relay receives. A host resolver may complete that environment later.
  const readProfile = () => hostDeliveryProfile(host, relayEnvironment(options.relayEnv), undefined, options.defaultQueueWake);
  let profile = readProfile();
  const profileRelayEnv = JSON.stringify(Object.entries(options.relayEnv ?? {}));
  const target = { host, sessionId };
  // Names the synchronous step a failure stops in. Its own lock wait cannot be preempted, so under a budget its store
  // waits for no lock (busy timeout 0) and the step fails with its reason instead of running past the budget.
  const stepped = <T>(step: HookFailureStep, run: () => T): T => {
    progress.step = step;
    const value = budgetedStep(budget, run);
    progress.step = undefined;
    return value;
  };
  async function request<T>(operation: string, payload: Record<string, unknown>): Promise<T> {
    progress.step = operation;
    // Every operation that claims bodies keeps the post-claim reserve and is never replayed.
    const claim = operation === "claim-deferred" || operation === "claim-turn-end" || operation === "claim-host-wake";
    assertHookBudget(budget, claim ? budget?.postClaimReserveMs ?? 0 : 0);
    let attempted = false;
    const result = await sessionMessageRequest<T>(operation, payload, undefined, budget ? {
      totalTimeoutMs: HOST_MESSAGE_REQUEST_TIMEOUT_MS,
      deadlineMonotonicMs: budget.deadlineMonotonicMs - (claim ? budget.postClaimReserveMs : 0),
      // A synchronous SQLite busy wait cannot be interrupted at the deadline. Leave queued work for the next
      // activity boundary instead; BEGIN IMMEDIATE failure writes nothing and does not spend the receipt reserve.
      busyTimeoutMs: 0,
      ...(claim || operation === "ensure-relay" ? {noOperationReplay:true}:{}),
      ...(claim ? { onOperationWrite: () => {
        if (attempted) return;
        attempted = true;
        observeClaim(options, "request-attempted", []);
      } } : {}),
    } : { totalTimeoutMs: HOST_MESSAGE_REQUEST_TIMEOUT_MS, ...(operation === "ensure-relay" ? {noOperationReplay:true}:{}) });
    if (budget && claim) {
      const messages = (result as { messages: SessionMessage[] }).messages;
      observeClaim(options, "response-received", messages.map((message) => message.messageId));
    }
    assertHookBudget(budget);
    progress.step = undefined;
    return result;
  }
  async function ensureVerifiedRelay(hostProcess: Readonly<{ pid: number; startToken: string }>, expectedPresenceInstanceId?: string | null): Promise<void> {
    const hostPid = hostProcess.pid;
    if (!Number.isInteger(hostPid) || hostPid < 1 || typeof hostProcess.startToken !== "string" || !hostProcess.startToken.trim()
      || (explicitHostPid !== undefined && explicitHostPid !== hostPid)) { relayNotStarted("RELAY_HOST_START_MISMATCH"); return; }
    const transport = profile.transport;
    const expectedInstance = "host-process-v1:" + createHash("sha256").update(JSON.stringify([host, sessionId, hostPid, hostProcess.startToken])).digest("hex");
    try {
      const result = await request<{ spawn: boolean; relayId: string | null; instanceId: string; reason?: unknown }>("ensure-relay", {
        target, transport, parentPid: hostPid, parentStartToken: hostProcess.startToken,
        ...(expectedPresenceInstanceId !== undefined ? { expectedPresenceInstanceId } : {}),
        ...(installedRelayCode() ? { codeDigest: installedRelayCode() } : {}),
        wakeVisibility: profile.capabilities.idleWake, canWakeSilently: profile.capabilities.idleWake === "silent",
        supportedInjection: profile.capabilities.supportedInjection, idleWake: profile.capabilities.idleWake,
        ...(observation.collaborationId ? { collaborationId: observation.collaborationId } : {}),
        ...(observation.workspaceId ? { workspaceId: observation.workspaceId } : {}),
        ...(observation.role ? { role: observation.role } : {}),
      });
      if (!result.spawn) {
        // A live relay is the normal refusal; every other one is recorded with the broker's fixed reason.
        const grantReason = typeof result.reason === "string" && /^[A-Z_]{1,64}$/u.test(result.reason) ? result.reason : "UNREPORTED";
        if (grantReason !== "RELAY_ALIVE") relayNotStarted("RELAY_SPAWN_NOT_GRANTED", { grantReason });
        return;
      }
      if (result.instanceId !== expectedInstance || !result.relayId || !RELAY_ID.test(result.relayId)) throw hookFailure("INVALID_STARTUP_GRANT", "Invalid relay startup grant.");
      startRelay(host, sessionId, result.instanceId, transport, explicitHostPid, hostProcess, budget, result.relayId, options.relayEnv, adapted.lifecycle === "start" ? options.relayOwner : undefined,
        options.isolateDetachedHandles === true);
    } catch (error) {
      reportHookFailure("ensure-relay", error); // Never retry or fall back after an uncertain grant.
    }
  }
  if (adapted.lifecycle === "start") {
    if (!main) return {};
    // Snapshot the adapter observation before presence awaits; later mutation cannot adopt a new generation.
    const hostProcess = options.hostProcess ? { pid: options.hostProcess.pid, startToken: options.hostProcess.startToken } : undefined;
    if (options.ensureRelay) {
      await ensureVerifiedRelay(hostProcess!);
      return {};
    }
    const hostPid = resolveHookProcessPid(host, explicitHostPid, hostProcess);
    if (hostPid === undefined) { relayNotStarted("RELAY_HOST_PID_UNRESOLVED"); return {}; }
    if (hostProcess && (!Number.isInteger(hostProcess.pid) || hostProcess.pid < 1 || hostProcess.pid !== hostPid
      || typeof hostProcess.startToken !== "string" || !hostProcess.startToken.trim())) { relayNotStarted("RELAY_HOST_START_MISMATCH"); return {}; }
    const instanceId = randomUUID();
    const transport = profile.transport;
    const wakeVisibility = profile.capabilities.idleWake;
    // D0354: a start event inside a host process whose relay already serves this session (compact) keeps that
    // generation and relay; the store decides from the reported host process and this hook's relay entry code.
    const codeDigest = installedRelayCode();
    let relayId: string | null;
    try {
      const started = await request<{ kept?: unknown; relayId?: unknown; reason?: unknown }>("presence-start", {
        target, instanceId, transport, hostPid,
        ...(hostProcess ? { hostStart: hostProcess.startToken } : {}),
        ...(codeDigest ? { codeDigest } : {}),
        wakeVisibility,
        canWakeSilently: wakeVisibility === "silent",
        supportedInjection: profile.capabilities.supportedInjection,
        idleWake: profile.capabilities.idleWake,
        ...(observation.collaborationId ? { collaborationId: observation.collaborationId } : {}),
        ...(observation.workspaceId ? { workspaceId: observation.workspaceId } : {}),
        ...(observation.role ? { role: observation.role } : {}),
      });
      if (started?.kept === true) return {};
      relayId = typeof started?.relayId === "string" && RELAY_ID.test(started.relayId) ? started.relayId : null;
      if (!relayId) {
        relayNotStarted("RELAY_SPAWN_NOT_GRANTED", { grantReason: typeof started?.reason === "string" && /^[A-Z_]{1,64}$/u.test(started.reason) ? started.reason : "UNREPORTED" });
        return {};
      }
    } catch (error) {
      reportHookFailure("presence-start", error);
      return {}; // No relay can start without a confirmed presence response.
    }
    startRelay(host, sessionId, instanceId, transport, explicitHostPid, hostProcess, budget, relayId, options.relayEnv, options.relayOwner, options.isolateDetachedHandles === true);
    return {};
  }
  if (adapted.lifecycle === "end") {
    // The relay's own release cannot cover every end: Windows ends the async hook tree with the relay unsignalled
    // (R5), and `/clear` keeps the host process, so the old session's relay keeps serving it (R10). The hook payload
    // has no presence instance, so this ends only the current birth whose reported host is this hook's host
    // (same PID, bound start no later than this hook's start) and that started before this hook. A late SessionEnd
    // thus cannot end a newer resume generation of another process; compact sends no SessionEnd (Claude Code hooks
    // reference). No OS identity query runs here: SessionEnd has a 1.5 s budget. The relay's release stays; the
    // first end wins.
    if (!main) return {};
    const hostPid = resolveHookProcessPid(host, explicitHostPid, options.hostProcess);
    if (hostPid === undefined) return {};
    try {
      await request("presence-end-host", { target, hostPid, hostAliveAt: hostAliveAtBound(),
        hookStartedAt: Math.floor(performance.timeOrigin), reason: "host-session-ended" });
    } catch (error) { reportHookFailure("presence-end", error); }
    return {};
  }
  // The relay owns lifecycle heartbeats for its exact presence instance. Hook
  // events do not carry instanceId, so mutating "latest" here would let a late
  // event from an older generation extend a newer one.
  if (observation.kind === "tool-boundary" && observation.boundaryPhase === "before") {
    const wait = nativePeerWait(observation);
    if (wait && actorAccess(observation.actor).allowed) {
      try {
        const decision = await request<PeerWaitDecision>("peer-wait", { sender: target, ...wait });
        const guidance = peerWaitGuidance(decision, locale());
        return { hookSpecificOutput: { hookEventName: adapted.outputEventName,
          ...(decision.action === "deny" ? { permissionDecision: "deny", permissionDecisionReason: guidance } : {}),
          additionalContext: guidance } };
      } catch (error) {
        reportHookFailure("peer-wait", error);
        assertHookBudget(budget);
        return additionalContext(adapted.outputEventName, render(msg("peer.wait.unavailable", {}), locale()));
      }
    }
    // AGS tools need no hook binding: the server identifies the caller from host-owned call metadata.
    return {};
  }
  if (!main) return {};

  // Capture the event's own process before any liveness request can see a replacement birth.
  // Do not infer generation from the broker's latest presence or from hook payload fields.
  const claimsAtBoundary = observation.kind === "user-input" || observation.kind === "turn-end"
    || (observation.kind === "tool-boundary" && observation.boundaryPhase === "after");
  let claimHostProcess: Readonly<{ pid: number; startToken: string }> | undefined;
  let claimInstanceId: string | undefined;
  if (claimsAtBoundary && (options.hostProcess || options.resolveHostProcess)) {
    assertHookBudget(budget);
    const observed = options.hostProcess ?? await options.resolveHostProcess?.();
    assertHookBudget(budget);
    if (!observed) throw hookFailure("HOOK_HOST_GENERATION_UNVERIFIED", "The hook host process generation is unavailable.");
    claimHostProcess = { pid: observed.pid, startToken: observed.startToken };
    if (!Number.isInteger(claimHostProcess.pid) || claimHostProcess.pid < 1
      || typeof claimHostProcess.startToken !== "string" || !claimHostProcess.startToken.trim()
      || (explicitHostPid !== undefined && explicitHostPid !== claimHostProcess.pid)) {
      throw hookFailure("HOOK_HOST_GENERATION_UNVERIFIED", "The hook host process generation did not verify.");
    }
    claimInstanceId = "host-process-v1:" + createHash("sha256")
      .update(JSON.stringify([host, sessionId, claimHostProcess.pid, claimHostProcess.startToken])).digest("hex");
    // D0364: the resolver may have completed the relay environment; re-read the profile only when it changed, so
    // recovery compares and starts relays under the transport that environment selects.
    const resolvedRelayEnv = JSON.stringify(Object.entries(options.relayEnv ?? {}));
    if (resolvedRelayEnv !== profileRelayEnv) {
      profile = readProfile();
    }
  }

  if (options.recoverExistingSession && actorAccess(observation.actor).allowed
    && (observation.kind === "user-input" || observation.kind === "turn-end"
      || (observation.kind === "tool-boundary" && observation.boundaryPhase === "after"))) {
    try {
      const listed = await request<{ sessions: Array<{ host: string; sessionId: string; instanceId: string | null; state: string; transport: string | null; relayLive: boolean }> }>("list-presence", { targets: [target] });
      const current = listed.sessions.find((session) => session.host === host && session.sessionId === sessionId);
      // The broker's explicit relay-lease fact, never inferred from the advisory autoWake outlook.
      const relayLive = current?.state === "online" && current.transport === profile.transport && current.relayLive === true;
      if (!relayLive) {
        if (claimHostProcess) await ensureVerifiedRelay(claimHostProcess, current?.instanceId ?? null);
      }
    } catch (error) {
      reportHookFailure("recovery", error); // Normal claiming retains its original deadline and no-replay rules.
    }
  }

  // Unverified relays start only at SessionStart. When the broker reports that the current generation has no
  // relay (it never acquired or died), this boundary starts one single-attempt relay for it; the lease keeps one
  // owner and acquire-relay fences superseded generations. Until such a hook runs, an idle session has no relay.
  // The relay parent must be the exact host birth that generation's SessionStart reported. This hook's own host
  // process is compared with it; a hook without its host's identity, another process of the same session or a reused
  // PID is refused with a recorded reason and starts nothing. A generation a pre-3.0 SessionStart created has no
  // reported host: a relay-less one (no replacement of a live relay) is adopted by this hook's live host, which
  // grantRelay records only while the generation still has none, so a second process then gets HOST_MISMATCH.
  const recoverUnverifiedRelay = async (claimed: RelayRecoveryHint | undefined): Promise<void> => {
    const recovery = claimed?.relayRecovery;
    if (!recovery?.instanceId || options.recoverExistingSession || !actorAccess(observation.actor).allowed) return;
    try {
      // A host whose hook command passes no host PID (the Windows Codex shell) has it read here, only for recovery.
      let observedHostPid = explicitHostPid;
      if (observedHostPid === undefined && options.resolveHostPid) {
        progress.step = "host-pid";
        try { observedHostPid = await options.resolveHostPid(budgetedTimeout(budget, HOST_PID_LOOKUP_TIMEOUT_MS)); }
        catch (error) { throw budgetExpiredOr(budget, error); }
        progress.step = undefined;
        assertHookBudget(budget);
      }
      const hostPid = resolveHookProcessPid(host, observedHostPid, undefined);
      if (!hostPid) throw hookFailure("RELAY_RECOVERY_HOST_UNIDENTIFIED", "This hook did not receive its host process identity.");
      if (!Number.isInteger(recovery.hostPid) && recovery.replace === true) throw hookFailure("RELAY_RECOVERY_PARENT_UNREPORTED", "A live relay of a generation without a reported host process is not replaced.");
      if (Number.isInteger(recovery.hostPid) && recovery.hostPid !== hostPid) throw hookFailure("RELAY_RECOVERY_PARENT_MISMATCH", "This hook's host process is not the generation's reported host.");
      const codeDigest = installedRelayCode();
      const grant = await request<{ relayId: unknown; reason?: unknown }>("grant-relay", { target, transport: profile.transport,
        instanceId: recovery.instanceId, hostPid, ...(codeDigest ? { codeDigest } : {}) });
      if (typeof grant.relayId !== "string" || !RELAY_ID.test(grant.relayId)) {
        if (grant.reason !== "RELAY_ALIVE") relayNotStarted("RELAY_SPAWN_NOT_GRANTED", { grantReason: typeof grant.reason === "string" && /^[A-Z_]{1,64}$/u.test(grant.reason) ? grant.reason : "UNREPORTED" });
        return;
      }
      startRelay(host, sessionId, recovery.instanceId, profile.transport, hostPid, undefined, budget, grant.relayId, options.relayEnv, undefined,
        options.isolateDetachedHandles === true);
    } catch (error) { reportHookFailure("recovery", error, undefined, progress.step); }
    progress.step = undefined;
  };
  const limits = { target, maxMessages: HOST_CLAIM_MAX_MESSAGES, maxBodyChars: HOST_CLAIM_MAX_BODY_CHARS };
  const relayCode = installedRelayCode();
  const hookTarget = { target, ...(claimInstanceId ? { instanceId: claimInstanceId } : { ...(relayCode ? { codeDigest: relayCode } : {}) }) };
  const fencedLimits = { ...limits, ...hookTarget };
  let messages: SessionMessage[] = [];
  if (observation.kind === "user-input") {
    if (observation.wakeOnly && observation.wakeCandidates?.length && supportsInjection(profile.capabilities, "peer-wake")) {
      const sourceReceiptId = stepped("wake-observation", () => recordWakeHookObservation(observation, Date.now(), budget ? { busyTimeoutMs: 0 } : {}));
      const result = await request<{ recognized: boolean; messages: SessionMessage[]; managed: boolean; retired?: boolean; rejectionReason?: string }>("claim-host-wake", {
        ...limits,
        observation,
        sourceReceiptId,
      });
      if (!result.recognized) {
        // Diagnose the exact refusal without exposing the marker or treating it as authority for a fallback claim.
        const reason = ["WAKE_OBSERVATION_INVALID", "WAKE_READER_UNAVAILABLE", "WAKE_RECEIPT_REJECTED", "WAKE_NONCE_UNKNOWN", "WAKE_GENERATION_NOT_CURRENT"]
          .find((known) => known === result.rejectionReason) ?? "WAKE_CLAIM_UNRECOGNIZED";
        reportHookFailure("wake-claim", hookFailure(reason, "The peer wake claim was not recognized."));
      }
      // UserPromptSubmit blocks before a model request. An empty/unavailable
      // claim alone cannot discard input: require a verified current managed wake.
      if (profile.blocksEmptyWakePrompt && result.recognized && result.managed === true && result.messages.length === 0) {
        return { decision: "block", reason: render(msg("peer.wake.noMessage", {}), locale()) };
      }
      // A verified marker whose attempts have all ended (observed, released or not delivered) and that claimed no
      // body is a stale duplicate; current bodies have their own wake. Stop the empty model turn; the host still shows the marker.
      if (profile.blocksEmptyWakePrompt && !result.recognized && result.retired === true && result.messages.length === 0) {
        return { decision: "block", reason: render(msg("peer.wake.retired", {}), locale()) };
      }
      if (result.recognized) messages = result.messages;
      else await recoverUnverifiedRelay(await request<RelayRecoveryHint>("observe-native-input", hookTarget));
    } else if (!observation.wakeOnly) {
      await recoverUnverifiedRelay(await request<RelayRecoveryHint>("observe-native-input", hookTarget));
    }
  } else if (observation.kind === "tool-boundary" && observation.boundaryPhase === "after" && supportsInjection(profile.capabilities, "tool-boundary")) {
    const claimed = await request<ClaimWithRecovery>("claim-deferred", fencedLimits);
    messages = claimed.messages;
    await recoverUnverifiedRelay(claimed);
  } else if (observation.kind === "turn-end") {
    // A turn the host already continued through its Stop hook gets no second continuation from messaging: a body waits
    // for the next boundary, so a stream of messages cannot extend one turn without end.
    if (supportsInjection(profile.capabilities, "turn-end") && observation.stopHookActive !== true) {
      const claimed = await request<ClaimWithRecovery>("claim-turn-end", fencedLimits);
      messages = claimed.messages;
      await recoverUnverifiedRelay(claimed);
    } else {
      await recoverUnverifiedRelay(await request<RelayRecoveryHint>("clear-deferred", hookTarget));
    }
  }
  if (messages.length === 0) return {};
  const recorded = stepped("peer-receipt", () => recordPeerMessages(host, sessionId, messages, budget));
  const envelope = stepped("peer-envelope", () => sessionMessageEnvelope(recorded, locale()));
  // At a turn end the body continues the turn; the host decides the form (Codex: decision/reason).
  return observation.kind === "turn-end" ? turnEndContinuation(host, adapted.outputEventName, envelope)
    : additionalContext(adapted.outputEventName, envelope);
}

/** Every failure is fail-open (empty output), but the outcome keeps the failed step and reason distinct from an
 * empty success so a caller can tell "no message" from "messaging failed". */
export async function runSessionMessageHookOutcome(host: SupportedHookHost, raw: string, explicitHostPid?: number, options: SessionMessageHookOptions = {}): Promise<SessionMessageHookOutcome> {
  let phase: HookFailurePhase = "options";
  const progress: { step?: HookFailureStep | undefined } = {};
  try {
    options = snapshotOptions(options);
    phase = "input";
    const input = JSON.parse(raw) as Record<string, unknown>;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw hookFailure("INVALID_HOOK_INPUT", "Invalid hook input.");
    phase = "handle";
    const output = await handleSessionMessageHook(input, host, explicitHostPid, options, progress);
    assertHookBudget(options.executionBudget);
    phase = "serialize";
    const serialized = budgetedStep(options.executionBudget, () => Object.keys(output).length > 0 ? JSON.stringify(output) : "");
    return { ok: true, output: serialized };
  } catch (error) {
    return { ok: false, output: "", failure: reportHookFailure(phase, error, undefined, phase === "handle" ? progress.step : undefined) };
  }
}

/**
 * The hook command budget (3.6.0). Every hooks/hooks.json entry that runs this file with a `timeout` gives
 * HOOK_COMMAND_TIMEOUT_MS (tests/session-messaging/codex-hook-boundaries.test.ts checks it). The host's clock starts before
 * node does: the host checks the plugin's trust hash and, on Windows, starts PowerShell first. This process's own clock
 * (performance.now(), from node's start) therefore gets the timeout less that pre-start reserve and a stdout reserve,
 * so a budget that expires is reported with its step before the host ends the hook without any record.
 */
export const HOOK_COMMAND_TIMEOUT_MS = 10_000;
const HOOK_COMMAND_PRE_START_RESERVE_MS = 3_000;
const HOOK_COMMAND_STDOUT_RESERVE_MS = 500;
export const HOOK_COMMAND_BUDGET: Readonly<{ deadlineMonotonicMs: number; postClaimReserveMs: number }> = Object.freeze({
  deadlineMonotonicMs: HOOK_COMMAND_TIMEOUT_MS - HOOK_COMMAND_PRE_START_RESERVE_MS - HOOK_COMMAND_STDOUT_RESERVE_MS,
  // A claim starts only while this much budget remains for its receipt and envelope; a body claimed and then lost
  // waits out its claim lease before it is claimed again.
  postClaimReserveMs: 1_000,
});

/** `--name <positive integer>` once, or undefined. */
function pidArgument(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number.parseInt(process.argv[index + 1] ?? "", 10) : Number.NaN;
  return Number.isInteger(value) ? value : undefined;
}

/** Every broker failure is fail-open so messaging never blocks the host. Use runSessionMessageHookOutcome to
 * distinguish a failure from an empty success. */
export async function runSessionMessageHook(host: SupportedHookHost, raw: string, explicitHostPid?: number, options: SessionMessageHookOptions = {}): Promise<string> {
  return (await runSessionMessageHookOutcome(host, raw, explicitHostPid, options)).output;
}

if (isHookEntry(import.meta.url, "session-message-hook")) {
  // Fail-open stdout/exit status stay unchanged; each failed stage retains its phase/reason diagnostic.
  const failed = (phase: HookFailurePhase, error: unknown): void => {
    reportHookFailure(phase, error);
  };
  let raw: string | null = null;
  try { raw = readFileSync(0, "utf8"); } catch (error) { failed("stdin", error); }
  if (raw !== null) {
    const hostPid = pidArgument("--host-pid");
    // `--host-shell-pid <shell PID>`: the host started this hook in that shell, so the host is the shell's parent. Reading
    // it costs an OS query (Windows CIM), which runs only when relay recovery needs the host (see recoverUnverifiedRelay).
    const shellPid = hostPid === undefined ? pidArgument("--host-shell-pid") : undefined;
    const resolveHostPid = shellPid === undefined ? undefined : async (timeoutMs: number): Promise<number> => {
      if (process.ppid !== shellPid) throw hookFailure("HOOK_SHELL_PID_MISMATCH", "The named shell is not this hook's parent process.");
      return await readParentProcessId(shellPid, timeoutMs);
    };
    try {
      const host = resolveHookHost(process.argv.slice(2), "codex");
      // This entry is the Codex hook command; Codex runs it through PowerShell on Windows (see isolateDetachedHandles).
      void runSessionMessageHookOutcome(host, raw, hostPid, { isolateDetachedHandles: true, executionBudget: HOOK_COMMAND_BUDGET,
        ...(resolveHostPid ? { resolveHostPid } : {}) })
        .then((outcome) => {
          // The typed outcome already reported its failed phase and reason; public exit remains fail-open.
          if (!outcome.ok) return;
          if (!outcome.output) return;
          let reported = false;
          const outputFailed = (error: unknown) => {
            if (reported) return;
            reported = true;
            failed("stdout", error);
          };
          // This CLI writes once. A stream error may follow its write callback.
          process.stdout.on("error", outputFailed);
          try { process.stdout.write(outcome.output, (error) => { if (error) outputFailed(error); }); }
          catch (error) { outputFailed(error); }
        })
        .catch((error) => failed("stdout", error));
    } catch (error) { failed("host-entry", error); }
  }
}
