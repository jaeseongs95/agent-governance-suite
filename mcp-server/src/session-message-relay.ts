import { failureContext, producerFailure, producerFailureReason } from "./failure-diagnostics.js";
import { writeDiagnostic } from "./hook-error-diagnostics.js";
import { newWakeNonce, sessionMessageRequest, wakeMessage } from "./session-message-client.js";
import { watchHostProcess, type HostWatch } from "./host-process-watch.js";
import { persistRelayFailure, type WakeDispatchPort, type WakeDispatchOutcome } from "./session-message-wake-port.js";
import { transportDeliveryCapabilities, transportWakePort } from "./wake-transports.js";
import type { WakeReservation } from "./session-message-store.js";

const LOOP_MS = 5000;

export type SessionMessageTransport = string;

export type RelayFailurePhase = "arguments" | "acquire" | "tick" | "release" | "run";

/** Local diagnostic only: producer reason plus bounded fingerprinted context, never messages, paths or bodies. */
export function reportRelayFailure(phase: RelayFailurePhase, error: unknown): void {
  try {
    const diagnostic = { phase,
      reason: producerFailureReason(error) ?? "UNEXPECTED_FAILURE", context: failureContext(error) };
    persistRelayFailure(JSON.stringify(diagnostic));
    writeDiagnostic("session-message-relay", "relay-failure", diagnostic);
  } catch { /* A broken diagnostic sink cannot stop the relay or its cleanup. */ }
}

export interface RelayOptions {
  host: string;
  sessionId: string;
  instanceId: string;
  transport: SessionMessageTransport;
  /** The host process the granting hook resolved. */
  parentPid: number;
  /** The grant's holder id; the store fences every other relay of this lease (docs/ags30-broker-redesign.md 3.3). */
  relayId: string;
  /** The spawning hook's own start: a process with the host PID born later is not the host (3.4). */
  hostAliveAt?: string;
  /** A birth the caller already read (adapter observation); the watcher must see exactly this one. */
  parentStartToken?: string;
}

export interface RelayDependencies {
  request?: typeof sessionMessageRequest;
  watch?: (pid: number, aliveAt: string | undefined) => HostWatch;
  delay?: (milliseconds: number, stop: Promise<void>) => Promise<void>;
}

export function transportWakeCapabilities(transport: SessionMessageTransport): {
  wakeVisibility: "silent" | "user-message" | "none";
  canWakeSilently: boolean;
} {
  const idleWake = transportDeliveryCapabilities(transport).idleWake;
  return { wakeVisibility: idleWake, canWakeSilently: idleWake === "silent" };
}

function delay(milliseconds: number, stop: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds); }), stop]).finally(() => clearTimeout(timer));
}

/** One dispatch cycle shared by the loop and isolated process regression fixtures. Lease renewal runs beside it. */
export async function dispatchManagedWake(options: Pick<RelayOptions, "host" | "sessionId" | "instanceId" | "transport">,
  relayId: string, port: WakeDispatchPort, request: typeof sessionMessageRequest = sessionMessageRequest): Promise<boolean> {
  if (port.capabilities.idleWake === "none" || !port.capabilities.supportedInjection.includes("peer-wake")) return false;
  const target = { host: options.host, sessionId: options.sessionId };
  const reserved = await request<WakeReservation>("reserve-wake", { target, nonce: newWakeNonce(),
    instanceId: options.instanceId, transport: options.transport, relayId, resume: true });
  if (!reserved.dispatch || !reserved.attempt) return false;
  // The resend base comes from this port's declaration, never from a client hook (3.1).
  const started = await request<WakeReservation>("start-wake", { attempt: reserved.attempt, resendBaseMs: port.resendBaseMs });
  if (!started.dispatch || !started.attempt) return false;
  let outcome: WakeDispatchOutcome = { result: "unknown", reasonCode: "ADAPTER_THREW" };
  try {
    outcome = await port.dispatch(target, wakeMessage(started.attempt.nonce));
  }
  catch { /* A thrown adapter cannot prove that no bytes were submitted. */ }
  // A lost record leaves the row started; the store's start timeout turns it unknown with a resend deadline.
  await request("record-wake-outcome", { attempt: started.attempt, outcome, resendBaseMs: port.resendBaseMs });
  return true;
}

const HOST_ENDED = new Set(["HOST_PROCESS_ENDED", "HOST_PROCESS_GONE"]);
/**
 * The owner's stop request. Claude Code ends an async SessionStart hook by sending SIGTERM to the hook's process group,
 * which holds this relay, and SIGKILL about 2 s later (measured, Claude Code 2.1.314 Linux). Node's default SIGTERM
 * action skips `finally`, so without this the birth stays online until its lease expires and reads as unreachable.
 */
const STOP_SIGNAL = "SIGTERM";
const STOPPED = "RELAY_STOP_REQUESTED";
/** Its birth was ended by the host's SessionEnd (store.endHostSession); the relay's end is then normal. */
const BIRTH_ENDED = "RELAY_BIRTH_ENDED";

/**
 * Serves one granted lease until the host ends or the lease is fenced. Renewal ticks every LOOP_MS and is never queued
 * behind a dispatch (D0003). No PID is trusted: liveness is the watcher's handle (Windows) or starttime (Linux).
 */
export async function runSessionMessageRelay(options: RelayOptions, port: WakeDispatchPort = transportWakePort(options.transport),
  dependencies: RelayDependencies = {}): Promise<void> {
  const request = dependencies.request ?? sessionMessageRequest;
  const wait = dependencies.delay ?? delay;
  const target = { host: options.host, sessionId: options.sessionId };
  let ended: string | null = null;
  let wakeStop!: () => void;
  const stopped = new Promise<void>((resolve) => { wakeStop = resolve; });
  const stop = (reason: string) => { ended ??= reason; wakeStop(); };
  let hostStart: string | undefined;
  let hostSent = false;
  // Known before any wake (for example no codex on PATH): the first tick records it on the birth, so a sender sees a
  // degraded wake instead of one that is available until the first dispatch fails.
  const prerequisiteMissing = port.prerequisite?.() ?? null;
  let prerequisiteSent = prerequisiteMissing === null;
  let dispatching: Promise<void> | null = null;
  let watcher: HostWatch | undefined;
  const stopRequested = () => stop(STOPPED);
  // `on`, not `once`: a repeated SIGTERM during the release must not fall back to the default action.
  process.on(STOP_SIGNAL, stopRequested);
  try {
    try { watcher = (dependencies.watch ?? watchHostProcess)(options.parentPid, options.hostAliveAt); }
    catch (error) { stop(producerFailureReason(error) ?? "HOST_WATCH_FAILED"); }
    watcher?.bound.then((token) => {
      if (options.parentStartToken !== undefined && token !== options.parentStartToken) stop("RELAY_PARENT_IDENTITY_MISMATCH");
      else hostStart = token;
    }, (error: unknown) => stop(producerFailureReason(error) ?? "HOST_WATCH_FAILED"));
    void watcher?.exited.then(stop);
    while (ended === null) {
      try {
        const binding = hostStart !== undefined && !hostSent ? hostStart : undefined;
        const tick = await request<{ alive: boolean; count: number; hostBound: boolean; ended?: boolean }>("relay-tick", {
          target, transport: options.transport, relayId: options.relayId, instanceId: options.instanceId,
          includePending: port.capabilities.idleWake !== "none", ...(binding !== undefined ? { hostStart: binding } : {}),
          ...(!prerequisiteSent ? { prerequisiteMissing } : {}),
        });
        if (!tick.alive) { stop(tick.ended === true ? BIRTH_ENDED : binding !== undefined ? "RELAY_HOST_BIRTH_MISMATCH" : "RELAY_LEASE_LOST"); break; }
        if (binding !== undefined) hostSent = true;
        prerequisiteSent = true;
        if (port.capabilities.idleWake !== "none" && tick.count > 0 && tick.hostBound && dispatching === null) {
          dispatching = dispatchManagedWake(options, options.relayId, port, request).then(() => {},
            // Messages remain durable. A committed start is never retried on an uncertain result.
            (error: unknown) => reportRelayFailure("tick", error)).finally(() => { dispatching = null; });
        }
      } catch (error) {
        reportRelayFailure("tick", error);
      }
      if (ended === null) await wait(LOOP_MS, stopped);
    }
  } finally {
    if (dispatching) await dispatching;
    watcher?.close();
    const reason: string = ended ?? "RELAY_ENDED";
    const hostEnded = HOST_ENDED.has(reason);
    const normalEnd = hostEnded || reason === STOPPED || reason === BIRTH_ENDED;
    if (!normalEnd) reportRelayFailure("run", producerFailure(reason, "The relay ended before its host."));
    try {
      await request("release-relay", { target, transport: options.transport, relayId: options.relayId, instanceId: options.instanceId,
        reason: hostEnded ? "host-process-ended" : reason === STOPPED ? "relay-stop-requested" : reason === BIRTH_ENDED ? "birth-ended" : "relay-ended" });
    } catch (error) {
      reportRelayFailure("release", error); // Lease expiry still provides an unreachable fallback.
    } finally {
      process.removeListener(STOP_SIGNAL, stopRequested);
    }
  }
}
