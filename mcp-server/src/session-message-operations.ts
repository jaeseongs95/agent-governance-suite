import { createHash } from "node:crypto";

import { SESSION_MESSAGE_MAX_RESPONSE_BYTES, SESSION_PRESENCE_LIST_MAX_TARGETS } from "./session-message-protocol.js";
import { SessionMessageStore, WAKE_RESEND_MAX_MS, type SessionIdentity, type WakeAttempt } from "./session-message-store.js";
import { isWakeDispatchOutcome, type WakeDispatchOutcome, type WakeHookObservationReader } from "./session-message-wake-port.js";
import type { InputObservation, InputObservationKind } from "./input-observation.js";
import { PeerWaitPolicy, normalizePeerWaitTargets } from "./peer-wait-policy.js";
import { readRelayCodeDigest, relayCodeDigest } from "./relay-code-identity.js";

/**
 * The validated operation table of session messaging. Every caller (MCP service, hooks, CLI, relay) runs it in its own
 * process against the shared SQLite file; each store call is one BEGIN IMMEDIATE transaction (docs/ags30-broker-redesign.md 3.1).
 */
export const SESSION_MESSAGE_OPERATIONS = ["prepare", "send", "claim", "claim-host-wake", "observe-native-input", "claim-deferred",
  "claim-turn-end", "clear-deferred", "acknowledge", "status", "peer-wait", "pending", "ensure-relay", "grant-relay", "release-relay",
  "relay-tick", "presence-start", "presence-heartbeat", "presence-end", "presence-end-host", "presence", "list-presence", "reserve-wake", "start-wake",
  "record-wake-outcome", "wake-status", "consume-wake"] as const;

function identity(value: unknown): SessionIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session identity is required.");
  const record = value as Record<string, unknown>;
  if (typeof record.host !== "string" || typeof record.sessionId !== "string") throw new Error("Session identity is invalid.");
  return { host: record.host, sessionId: record.sessionId };
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

function optionalInteger(record: Record<string, unknown>, name: string): number | undefined {
  return Object.hasOwn(record, name) ? integer(record[name], name) : undefined;
}

function optionalString(record: Record<string, unknown>, name: string): string | undefined {
  return Object.hasOwn(record, name) ? string(record[name], name) : undefined;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function wakeAttempt(value: unknown): WakeAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Wake attempt is required.");
  const attempt = value as Record<string, unknown>;
  const result = { ...identity(attempt), nonce: string(attempt.nonce, "nonce"), instanceId: string(attempt.instanceId, "instanceId"),
    transport: string(attempt.transport, "transport"), relayId: string(attempt.relayId, "relayId"), generation: string(attempt.generation, "generation"),
    attemptId: string(attempt.attemptId, "attemptId"), dispatchEpoch: integer(attempt.dispatchEpoch, "dispatchEpoch") };
  if (result.nonce.length > 128 || result.generation.length > 100 || result.attemptId.length > 128
    || result.instanceId.length > 128 || result.transport.length > 64 || result.relayId.length > 128 || result.dispatchEpoch < 0) throw new Error("Invalid wake attempt.");
  return result;
}

/** The relay reads this from its transport's port declaration; an out-of-range value is refused, never clamped. */
function resendBaseMs(value: unknown): number {
  const result = integer(value, "resendBaseMs");
  if (result < 1 || result > WAKE_RESEND_MAX_MS) throw new Error(`resendBaseMs must be 1 to ${WAKE_RESEND_MAX_MS}.`);
  return result;
}

function wakeOutcome(value: unknown): WakeDispatchOutcome {
  if (!isWakeDispatchOutcome(value)) throw new Error("Invalid wake dispatch outcome.");
  return value;
}

function supportedInjection(value: unknown): InputObservationKind[] {
  const allowed = new Set<InputObservationKind>(["user-input", "peer-wake", "tool-boundary", "turn-end", "unknown"]);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !allowed.has(item as InputObservationKind))) {
    throw new Error("supportedInjection is invalid.");
  }
  return [...new Set(value)] as InputObservationKind[];
}

function visibility(value: unknown, name: string): "silent" | "user-message" | "none" {
  if (value !== "silent" && value !== "user-message" && value !== "none") throw new Error(`${name} is invalid.`);
  return value;
}

function hostPid(record: Record<string, unknown>, name: string): number | undefined {
  if (!Object.hasOwn(record, name)) return undefined;
  const pid = integer(record[name], name);
  if (pid < 1) throw new Error(`${name} is invalid.`);
  return pid;
}

/** The relay entry this installation would start; a lease granted to other code is replaced at the next boundary (D0348). */
function installedRelayCode(): string | null {
  return readRelayCodeDigest(new URL("./session-message-relay.mjs", import.meta.url));
}

// A boundary hook of an unverified (instance-less) session learns here that its current generation has no relay,
// or that its relay runs code other than the installed one.
function withRelayRecovery(store: SessionMessageStore, payload: Record<string, unknown>, result: object): object {
  if (Object.hasOwn(payload, "instanceId")) return result;
  const target = identity(payload.target);
  const presence = store.presence(target);
  let instanceId = store.relayRecoveryInstance(target);
  let replace = false;
  const code = relayCodeDigest(payload.codeDigest);
  if (!instanceId && code && presence.state === "online" && presence.instanceId && presence.transport
    && !presence.instanceId.startsWith("host-process-v1:")) {
    const lease = store.liveRelay(target, presence.transport);
    if (lease && lease.instanceId === presence.instanceId && lease.codeDigest !== code) { instanceId = presence.instanceId; replace = true; }
  }
  if (!instanceId) return result;
  // The hook binds a recovery relay only to the host process this generation reported.
  const host = store.presenceHost(target, instanceId);
  return { ...result, relayRecovery: { instanceId, ...(host ? { hostPid: host.pid } : {}), ...(replace ? { replace: true } : {}) } };
}

function peerWait(store: SessionMessageStore, payload: Record<string, unknown>): unknown {
  const sender = identity(payload.sender);
  if (!Array.isArray(payload.targets) || payload.targets.length < 1 || payload.targets.length > 8) throw new Error("targets must contain 1..8 identities.");
  const targets = normalizePeerWaitTargets(payload.targets.map(identity));
  const timeoutMs = integer(payload.timeoutMs, "timeoutMs");
  if (timeoutMs < 0 || timeoutMs > 3_600_000) throw new Error("timeoutMs is out of range.");
  const queryRevision = optionalString(payload, "queryRevision") ?? "";
  if (queryRevision.length > 256) throw new Error("queryRevision is too long.");
  const presence = store.presence(sender);
  const resumeObserved = presence.deliveryCapabilities.idleWake !== "none" && presence.wakeVisibility === presence.deliveryCapabilities.idleWake
    && presence.deliveryCapabilities.supportedInjection.includes("peer-wake") && store.peerWaitResumeObserved(sender);
  const states = targets.map((target) => store.peerWaitState(sender, target));
  const decision = new PeerWaitPolicy(store.peerWaitSnapshots()).decide({ sender, targets, timeoutMs, peersObserved: states.every((state) => state.related), resumeObserved,
    fingerprint: JSON.stringify([presence.instanceId, queryRevision, states.map((state) => state.fingerprint)]) });
  return { ...decision, peers: targets.map((target, index) => ({ target, related: states[index]!.related, stateDigest: states[index]!.fingerprint })) };
}

function ensureRelay(store: SessionMessageStore, payload: Record<string, unknown>): unknown {
  const target = identity(payload.target);
  const pid = hostPid(payload, "parentPid");
  const start = string(payload.parentStartToken, "parentStartToken");
  if (pid === undefined || !start.trim() || start.length > 200) throw new Error("Invalid relay host observation.");
  const expected = Object.hasOwn(payload, "expectedPresenceInstanceId")
    ? payload.expectedPresenceInstanceId === null ? null : string(payload.expectedPresenceInstanceId, "expectedPresenceInstanceId") : undefined;
  if (typeof expected === "string" && expected.length > 128) throw new Error("Invalid expected host process generation.");
  const idleWake = visibility(payload.idleWake, "idleWake");
  return store.ensureVerifiedGeneration({ ...target,
    instanceId: "host-process-v1:" + createHash("sha256").update(JSON.stringify([target.host, target.sessionId, pid, start])).digest("hex"),
    transport: string(payload.transport, "transport"), hostPid: pid, hostStart: start,
    codeDigest: relayCodeDigest(payload.codeDigest) ?? installedRelayCode(),
    wakeVisibility: visibility(payload.wakeVisibility, "wakeVisibility"), canWakeSilently: boolean(payload.canWakeSilently, "canWakeSilently"),
    deliveryCapabilities: { supportedInjection: supportedInjection(payload.supportedInjection), idleWake },
    ...(expected !== undefined ? { expectedPresenceInstanceId: expected } : {}),
    ...(optionalString(payload, "collaborationId") ? { collaborationId: optionalString(payload, "collaborationId")! } : {}),
    ...(optionalString(payload, "workspaceId") ? { workspaceId: optionalString(payload, "workspaceId")! } : {}),
    ...(optionalString(payload, "role") ? { role: optionalString(payload, "role")! } : {}) });
}

function presenceStart(store: SessionMessageStore, payload: Record<string, unknown>): unknown {
  const target = identity(payload.target);
  const transport = string(payload.transport, "transport");
  const wakeVisibility = visibility(payload.wakeVisibility, "wakeVisibility");
  const idleWake = visibility(optionalString(payload, "idleWake") ?? wakeVisibility, "idleWake");
  const injection = Object.hasOwn(payload, "supportedInjection") ? supportedInjection(payload.supportedInjection) : [];
  const pid = hostPid(payload, "hostPid");
  const start = optionalString(payload, "hostStart");
  const code = relayCodeDigest(payload.codeDigest) ?? null;
  // D0354: the same host process keeps its served generation; replacing it would retire a working relay.
  if (code && pid !== undefined && store.liveRelayGeneration({ ...target, transport, hostPid: pid, codeDigest: code,
    ...(start !== undefined ? { hostStart: start } : {}) }) !== null) return { presence: store.presence(target), kept: true, relayId: null };
  const instanceId = string(payload.instanceId, "instanceId");
  const presence = store.startPresence({ ...target, instanceId, transport, wakeVisibility,
    canWakeSilently: boolean(payload.canWakeSilently, "canWakeSilently"), deliveryCapabilities: { supportedInjection: injection, idleWake },
    ...(optionalString(payload, "collaborationId") === undefined ? {} : { collaborationId: optionalString(payload, "collaborationId")! }),
    ...(optionalString(payload, "workspaceId") === undefined ? {} : { workspaceId: optionalString(payload, "workspaceId")! }),
    ...(optionalString(payload, "role") === undefined ? {} : { role: optionalString(payload, "role")! }),
    ...(pid !== undefined ? { hostPid: pid } : {}), ...(start !== undefined ? { hostStart: start } : {}) });
  // A generation without a reported host process gets no relay: nothing could watch its host.
  const grant = pid === undefined ? { relayId: null, reason: "HOST_UNREPORTED" }
    : store.grantRelay({ ...target, transport, instanceId, codeDigest: code, hostPid: pid });
  return { presence, relayId: grant.relayId, ...(grant.relayId === null ? { reason: grant.reason } : {}) };
}

/** One operation is one writer transaction: a multi-step operation (peer-wait snapshot read and write, relay recovery) is atomic. */
export function dispatchSessionMessageOperation(store: SessionMessageStore, operation: string, payload: Record<string, unknown>,
  wakeObserver?: WakeHookObservationReader): unknown {
  return store.atomically(() => dispatchOperation(store, operation, payload, wakeObserver));
}

function dispatchOperation(store: SessionMessageStore, operation: string, payload: Record<string, unknown>,
  wakeObserver?: WakeHookObservationReader): unknown {
  switch (operation) {
    case "prepare": {
      if (Object.keys(payload).some((key) => !["sender", "target", "body", "ttlSeconds"].includes(key))) throw new Error("prepare accepts sender, target, body and ttlSeconds; IDs are system-issued.");
      const ttlSeconds = optionalInteger(payload, "ttlSeconds");
      return store.prepare({ sender: identity(payload.sender), target: identity(payload.target), body: string(payload.body, "body"),
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }) });
    }
    case "send": {
      if (Object.keys(payload).some((key) => !["sender", "messageId"].includes(key))) throw new Error("send accepts only sender and the ID returned by prepare; message content is immutable. Retry the known ID or compare saved receipts/status if delivery is unknown.");
      return store.submitPrepared(identity(payload.sender), string(payload.messageId, "messageId"));
    }
    case "claim": {
      const maxMessages = optionalInteger(payload, "maxMessages");
      const maxBodyChars = optionalInteger(payload, "maxBodyChars");
      return { messages: store.claim(identity(payload.target), undefined, {
        ...(maxMessages === undefined ? {} : { maxMessages }), ...(maxBodyChars === undefined ? {} : { maxBodyChars }) }) };
    }
    case "claim-host-wake": {
      if (Object.keys(payload).some((key) => !["target", "observation", "sourceReceiptId", "maxMessages", "maxBodyChars"].includes(key))) {
        throw new Error("Host wake claim requires a non-authorizing hook source receipt.");
      }
      const maxMessages = optionalInteger(payload, "maxMessages");
      const maxBodyChars = optionalInteger(payload, "maxBodyChars");
      const result = store.claimHostWake(identity(payload.target), payload.observation as InputObservation,
        typeof payload.sourceReceiptId === "string" ? payload.sourceReceiptId : "", wakeObserver, undefined, {
          ...(maxMessages === undefined ? {} : { maxMessages }), ...(maxBodyChars === undefined ? {} : { maxBodyChars }) });
      // retired marks a verified arrival of an attempt the liveness rule already retired; it authorizes no claim.
      return { recognized: result.recognized, messages: result.messages, managed: result.binding !== null, ...(result.retired ? { retired: true } : {}) };
    }
    case "observe-native-input": {
      const target = identity(payload.target);
      store.observeNativeInput(target, undefined, optionalString(payload, "instanceId"));
      new PeerWaitPolicy(store.peerWaitSnapshots()).reset(target);
      return withRelayRecovery(store, payload, { observed: true });
    }
    case "claim-deferred":
    case "claim-turn-end": {
      const maxMessages = optionalInteger(payload, "maxMessages");
      const maxBodyChars = optionalInteger(payload, "maxBodyChars");
      const limits = { ...(Object.hasOwn(payload, "instanceId") ? { instanceId: string(payload.instanceId, "instanceId") } : {}),
        ...(maxMessages === undefined ? {} : { maxMessages }), ...(maxBodyChars === undefined ? {} : { maxBodyChars }) };
      const target = identity(payload.target);
      return withRelayRecovery(store, payload, { messages: operation === "claim-deferred" ? store.claimDeferred(target, undefined, limits)
        : store.claimTurnEnd(target, undefined, limits) });
    }
    case "clear-deferred": {
      store.clearDeferred(identity(payload.target), undefined, optionalString(payload, "instanceId"));
      return withRelayRecovery(store, payload, { cleared: true });
    }
    case "acknowledge": {
      if (payload.receipts !== undefined && !Array.isArray(payload.receipts)) throw new Error("receipts must be an array.");
      const claims = (payload.receipts ?? []) as Array<Record<string, unknown>>;
      return { acknowledged: store.acknowledge(identity(payload.target),
        Array.isArray(payload.messageIds) ? payload.messageIds.map(value => string(value, "messageId")) : [], undefined,
        claims.map(claim => ({ messageId: string(claim?.messageId, "messageId"), claimReceipt: string(claim?.claimReceipt, "claimReceipt") }))) };
    }
    case "status": {
      const status = store.status(identity(payload.sender), string(payload.messageId, "messageId"));
      return { status, ...(status === null ? { guidance: "Delivery is unknown; compare saved receipts. Prepare only a new intent, not an automatic resend." } : {}) };
    }
    case "peer-wait": return peerWait(store, payload);
    case "pending": return { count: store.pendingCount(identity(payload.target)) };
    case "ensure-relay": return ensureRelay(store, payload);
    case "grant-relay": {
      const target = identity(payload.target);
      const pid = hostPid(payload, "hostPid");
      const grant = store.grantRelay({ ...target, transport: string(payload.transport, "transport"), instanceId: string(payload.instanceId, "instanceId"),
        codeDigest: relayCodeDigest(payload.codeDigest) ?? installedRelayCode(), ...(pid !== undefined ? { hostPid: pid } : {}) });
      return grant.relayId !== null ? { relayId: grant.relayId } : { relayId: null, reason: grant.reason };
    }
    case "release-relay": return { released: store.releaseRelay({ ...identity(payload.target), transport: string(payload.transport, "transport"),
      relayId: string(payload.relayId, "relayId"), instanceId: string(payload.instanceId, "instanceId"), reason: string(payload.reason, "reason") }) };
    case "relay-tick": return store.relayTick({ ...identity(payload.target), transport: string(payload.transport, "transport"),
      relayId: string(payload.relayId, "relayId"), instanceId: string(payload.instanceId, "instanceId"),
      includePending: boolean(payload.includePending, "includePending"),
      ...(Object.hasOwn(payload, "hostStart") ? { hostStart: string(payload.hostStart, "hostStart") } : {}) });
    case "presence-start": return presenceStart(store, payload);
    case "presence-heartbeat": return { alive: store.heartbeatPresence(identity(payload.target), string(payload.instanceId, "instanceId")) };
    case "presence-end": return { ended: store.endPresence(identity(payload.target), string(payload.reason, "reason"), string(payload.instanceId, "instanceId")) };
    case "presence-end-host": return { ended: store.endHostSession({ ...identity(payload.target), hostPid: integer(payload.hostPid, "hostPid"),
      hostAliveAt: string(payload.hostAliveAt, "hostAliveAt"), hookStartedAt: integer(payload.hookStartedAt, "hookStartedAt"), reason: string(payload.reason, "reason") }) };
    case "presence": return { presence: store.presence(identity(payload.target)) };
    case "list-presence": {
      let targets: SessionIdentity[] | undefined;
      if (payload.targets !== undefined) {
        if (!Array.isArray(payload.targets) || payload.targets.length < 1 || payload.targets.length > SESSION_PRESENCE_LIST_MAX_TARGETS) {
          throw new Error(`targets must list 1 to ${SESSION_PRESENCE_LIST_MAX_TARGETS} session identities.`);
        }
        targets = payload.targets.map(identity);
      }
      const result = { sessions: store.listPresence(undefined, targets, installedRelayCode()) };
      // Refuse explicitly rather than send a reply a bounded consumer would drop; the untargeted request can grow with the DB.
      if (Buffer.byteLength(`${JSON.stringify({ ok: true, data: result })}\n`, "utf8") > SESSION_MESSAGE_MAX_RESPONSE_BYTES) {
        throw new Error("The presence list exceeds the response limit; request fewer targets.");
      }
      return result;
    }
    case "reserve-wake": return store.reserveManagedWake({ ...identity(payload.target), nonce: string(payload.nonce, "nonce"),
      instanceId: string(payload.instanceId, "instanceId"), relayId: string(payload.relayId, "relayId"), transport: string(payload.transport, "transport"),
      ...(payload.resume === undefined ? {} : { resume: boolean(payload.resume, "resume") }) });
    case "start-wake": return store.startManagedWake(wakeAttempt(payload.attempt), resendBaseMs(payload.resendBaseMs));
    case "record-wake-outcome": return { recorded: store.recordManagedWakeOutcome(wakeAttempt(payload.attempt), wakeOutcome(payload.outcome),
      resendBaseMs(payload.resendBaseMs)) };
    case "wake-status": return { wake: store.managedWakeStatus(identity(payload.target)) };
    case "consume-wake": return { consumed: store.consumeWake(identity(payload.target), string(payload.nonce, "nonce")) };
    default: throw new Error("Unknown session message operation.");
  }
}
