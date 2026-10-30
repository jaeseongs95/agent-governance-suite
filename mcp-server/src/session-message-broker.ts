import { createHash, createPublicKey, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { closeSync, existsSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  brokerStartupCode, SESSION_MESSAGE_MAX_REQUEST_BYTES, SESSION_MESSAGE_MAX_RESPONSE_BYTES, SESSION_MESSAGE_PROTOCOL, SESSION_PRESENCE_LIST_MAX_TARGETS, sessionMessageLineReader,
} from "./session-message-protocol.js";
import { MessageCapacityError, SessionMessageStore, type SessionIdentity, type WakeAttempt } from "./session-message-store.js";
import { createWakeHookObservationReader, verifyHistoricalWakeObservation, type WakeHookObservationReader } from "./session-message-wake-port.js";
import type { InputObservation, InputObservationKind } from "./input-observation.js";
import { PeerWaitPolicy, normalizePeerWaitTargets } from "./peer-wait-policy.js";
import { createSelfSignedCertificate } from "./self-signed-certificate.js";
import { processStartToken, processStartTokenAsync, type ProcessIdentityBudget, type ProcessIdentityFailureObserver } from "./process-identity.js";
import { readRelayCodeDigest, relayCodeDigest } from "./relay-code-identity.js";
import { decodeIdentityDeadline, remainingIdentityBudget } from "./broker-identity-budget.js";
import { producerFailureReason, retainFailureCause } from "./failure-diagnostics.js";
import { acquireBrokerProcessLockWhenReady, ownsBrokerProcessLock, releaseBrokerProcessLock } from "./broker-process-lock.js";
import { performance } from "node:perf_hooks";

const IDLE_EXIT_MS = 60_000;
export const SESSION_MESSAGE_BROKER_CAPABILITIES = ["atomic-wake-claim", "deferred-boundary", "delivery-capabilities", "peer-wait-policy", "verified-relay-start"] as const;

interface BrokerRequest {
  protocolVersion: string;
  token: string;
  operation: string;
  payload: Record<string, unknown>;
  identityDeadlineNs?: unknown;
}

function brokerFailureCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return brokerStartupCode(code) ?? brokerStartupCode(producerFailureReason(error)) ?? "STARTUP_FAILED";
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

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

function supportedInjection(value: unknown): InputObservationKind[] {
  const allowed = new Set<InputObservationKind>(["user-input", "peer-wake", "tool-boundary", "turn-end", "unknown"]);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !allowed.has(item as InputObservationKind))) {
    throw new Error("supportedInjection is invalid.");
  }
  return [...new Set(value)] as InputObservationKind[];
}

function tokenMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function credentials(stateDirectory: string): Promise<{ key: string; certificate: string; token: string; fingerprint256: string }> {
  const keyPath = path.join(stateDirectory, "broker-key.pem");
  const certificatePath = path.join(stateDirectory, "broker-cert.pem");
  const tokenPath = path.join(stateDirectory, "broker.token");
  let key = "";
  let certificate = "";
  let regenerate = true;
  if (existsSync(keyPath) && existsSync(certificatePath)) {
    try {
      [key, certificate] = await Promise.all([readFile(keyPath, "utf8"), readFile(certificatePath, "utf8")]);
      const parsed = new X509Certificate(certificate);
      const privatePublic = createPublicKey(key).export({ type: "spki", format: "der" });
      const certificatePublic = parsed.publicKey.export({ type: "spki", format: "der" });
      regenerate = Date.parse(parsed.validTo) <= Date.now() + 24 * 3600_000 || !privatePublic.equals(certificatePublic);
    } catch {
      regenerate = true;
    }
  }
  if (regenerate) {
    const generated = createSelfSignedCertificate();
    key = generated.privateKeyPem;
    certificate = generated.certificatePem;
    if (existsSync(keyPath) || existsSync(certificatePath)) {
      await Promise.all([
        writeFile(keyPath, key, { encoding: "utf8", mode: 0o600 }),
        writeFile(certificatePath, certificate, { encoding: "utf8", mode: 0o600 }),
      ]);
    } else {
      const suffix = `${process.pid}.${Date.now()}.tmp`;
      const temporaryKey = `${keyPath}.${suffix}`;
      const temporaryCertificate = `${certificatePath}.${suffix}`;
      await Promise.all([
        writeFile(temporaryKey, key, { encoding: "utf8", mode: 0o600 }),
        writeFile(temporaryCertificate, certificate, { encoding: "utf8", mode: 0o600 }),
      ]);
      renameSync(temporaryKey, keyPath);
      renameSync(temporaryCertificate, certificatePath);
    }
  }
  let token: string;
  if (existsSync(tokenPath)) token = (await readFile(tokenPath, "utf8")).trim();
  else token = "";
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    token = randomBytes(32).toString("base64url");
    await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  }
  for (const target of [keyPath, certificatePath, tokenPath]) {
    try { await chmod(target, 0o600); } catch { /* Best effort on Windows. */ }
  }
  return { key, certificate, token, fingerprint256: new X509Certificate(certificate).fingerprint256 };
}

interface PeerWaitRuntime {
  policy: PeerWaitPolicy;
  wakes: Map<string, { owner: string; instanceId: string; relayId: string; expiresAt: number }>;
  relays: Map<string, { instanceId: string; relayId: string; expiresAt: number; wakeObservedAt?: number }>;
}
const peerWaitRuntimes = new WeakMap<SessionMessageStore, PeerWaitRuntime>();
function peerWaitRuntime(store: SessionMessageStore): PeerWaitRuntime {
  let runtime = peerWaitRuntimes.get(store);
  if (!runtime) {
    runtime = { policy: new PeerWaitPolicy(), relays: new Map(), wakes: new Map() };
    peerWaitRuntimes.set(store, runtime);
  }
  for (const [key, value] of runtime.relays) if (value.expiresAt <= Date.now()) runtime.relays.delete(key);
  for (const [key, value] of runtime.wakes) if (value.expiresAt <= Date.now()) runtime.wakes.delete(key);
  return runtime;
}
function observePeerRelay(store: SessionMessageStore, payload: Record<string, unknown>, accepted: boolean): void {
  if (!accepted || typeof payload.instanceId !== "string") return;
  const target = identity(payload.target);
  const presence = store.presence(target);
  const relay = store.liveRelay(target, string(payload.transport, "transport"));
  if (presence.instanceId !== payload.instanceId || presence.transport !== payload.transport || presence.state !== "online" || relay === null || relay.relayId !== payload.relayId) return;
  const runtime = peerWaitRuntime(store);
  if (runtime.relays.size >= 1000) runtime.relays.delete(runtime.relays.keys().next().value!);
  const key = JSON.stringify(target);
  const previous = runtime.relays.get(key);
  const wakeObservedAt = previous?.instanceId === payload.instanceId && previous.relayId === relay.relayId ? previous.wakeObservedAt : undefined;
  runtime.relays.set(key, { instanceId: payload.instanceId, relayId: relay.relayId, expiresAt: Date.now() + 15_000,
    ...(wakeObservedAt === undefined ? {} : { wakeObservedAt }) });
}

type IdentityObservation = { token: string | null; cause?: unknown; diagnostic?: Parameters<ProcessIdentityFailureObserver>[1] };
type IdentityQuery = { pid: number; timeoutMs: number | undefined };
type IdentitySteps = Generator<IdentityQuery, unknown, IdentityObservation>;

function* queryIdentity(pid: number, budget?: ProcessIdentityBudget): Generator<IdentityQuery, IdentityObservation, IdentityObservation> {
  const observation = yield { pid, timeoutMs: remainingIdentityBudget(budget) };
  try { remainingIdentityBudget(budget); }
  catch (error) { throw retainFailureCause(error as Error, observation.cause); }
  return observation;
}

function deniedIdentity(observation: IdentityObservation) {
  const denied = { acquired: false, ...(observation.diagnostic ? { diagnostic: observation.diagnostic } : {}) };
  // Keep the actual local cause; JSON replies carry only the bounded diagnostic.
  if (observation.cause !== undefined) Object.defineProperty(denied, "cause", { value: observation.cause });
  return denied;
}

function runIdentitySync(steps: IdentitySteps): unknown {
  let step = steps.next();
  while (!step.done) {
    const observation: IdentityObservation = { token: null };
    observation.token = processStartToken(step.value.pid, process.platform, step.value.timeoutMs,
      (cause, diagnostic) => Object.assign(observation, { cause, diagnostic }));
    step = steps.next(observation);
  }
  return step.value;
}

async function runIdentityAsync(steps: IdentitySteps, signal: AbortSignal): Promise<unknown> {
  let step = steps.next();
  while (!step.done) {
    const observation: IdentityObservation = { token: null };
    observation.token = await processStartTokenAsync(step.value.pid, process.platform, step.value.timeoutMs,
      (cause, diagnostic) => Object.assign(observation, { cause, diagnostic }), signal);
    if (signal.aborted) throw retainFailureCause(new Error("The broker identity query was cancelled."), observation.cause);
    step = steps.next(observation);
  }
  return step.value;
}

/** One authority path, with synchronous compatibility and an asynchronous network driver. */
function* relayIdentityOperation(store: SessionMessageStore, operation: string, payload: Record<string, unknown>,
  requestBudget?: ProcessIdentityBudget): IdentitySteps {
  switch (operation) {
    case "ensure-relay": {
      const target = identity(payload.target);
      const parentPid = integer(payload.parentPid,"parentPid");
      const parentStartToken = string(payload.parentStartToken,"parentStartToken");
      const timeout = integer(payload.identityTimeoutMs,"identityTimeoutMs");
      if (parentPid < 1 || !parentStartToken.trim() || parentStartToken.length > 200 || timeout < 1 || timeout > 8000) throw new Error("Invalid relay host observation or budget.");
      const transport = string(payload.transport,"transport");
      const previous = store.relayOwner(target,transport);
      const deadline = performance.now() + timeout;
      const budget = () => Math.min(deadline - performance.now(), requestBudget?.() ?? Infinity);
      const parent = yield* queryIdentity(parentPid, budget);
      if (parent.token !== parentStartToken) throw retainFailureCause(new Error("Relay host generation is unverified."), parent.cause);
      const instanceId = "host-process-v1:" + createHash("sha256").update(JSON.stringify([target.host,target.sessionId,parentPid,parentStartToken])).digest("hex");
      const wakeVisibility = string(payload.wakeVisibility,"wakeVisibility");
      const idleWake = string(payload.idleWake,"idleWake");
      if (!["silent","user-message","none"].includes(wakeVisibility) || !["silent","user-message","none"].includes(idleWake)) throw new Error("Invalid relay delivery capabilities.");
      let confirmedDead: {relayId: string; pid: number} | undefined;
      let confirmedAlive = false;
      if (previous && previous.pid > 0) {
        try {
          process.kill(previous.pid,0);
          if (typeof previous.relayStartToken === "string" && previous.relayStartToken.length > 0) {
            const actual = (yield* queryIdentity(previous.pid, budget)).token;
            if (actual !== null && actual !== previous.relayStartToken) confirmedDead = {relayId:previous.relayId,pid:previous.pid};
            else if (actual !== null && actual === previous.relayStartToken) confirmedAlive = true;
          }
        }
        catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") confirmedDead = {relayId:previous.relayId,pid:previous.pid};
        }
      }
      remainingIdentityBudget(budget);
      return store.prepareVerifiedRelay({...target,instanceId,transport,parentPid,expectedOwner:previous,
        wakeVisibility:wakeVisibility as "silent" | "user-message" | "none",canWakeSilently:boolean(payload.canWakeSilently,"canWakeSilently"),
        deliveryCapabilities:{supportedInjection:supportedInjection(payload.supportedInjection),idleWake:idleWake as "silent" | "user-message" | "none"},
        confirmedAlive,
        ...(confirmedDead ? {confirmedDead}:{}),
        ...(optionalString(payload,"collaborationId") ? {collaborationId:optionalString(payload,"collaborationId")!}:{}),
        ...(optionalString(payload,"workspaceId") ? {workspaceId:optionalString(payload,"workspaceId")!}:{}),
        ...(optionalString(payload,"role") ? {role:optionalString(payload,"role")!}:{})});
    }
    case "acquire-relay": {
      const target = identity(payload.target);
      const relayId = string(payload.relayId,"relayId");
      const parentPid = integer(payload.parentPid,"parentPid");
      const reserved = relayId.startsWith("verified-relay-v1:");
      let parent: IdentityObservation | undefined;
      if (reserved) {
        const parentStartToken = string(payload.parentStartToken,"parentStartToken");
        const expected = "host-process-v1:" + createHash("sha256").update(JSON.stringify([target.host,target.sessionId,parentPid,parentStartToken])).digest("hex");
        if (parentPid < 1 || !parentStartToken.trim() || string(payload.instanceId,"instanceId") !== expected) return {acquired:false};
        parent = yield* queryIdentity(parentPid, requestBudget);
        if (parent.token !== parentStartToken) return deniedIdentity(parent);
      }
      const pid = integer(payload.pid,"pid");
      const relay = reserved ? yield* queryIdentity(pid, requestBudget) : undefined;
      const relayStartToken = relay?.token ?? null;
      if (reserved && relayStartToken === null) return deniedIdentity(relay!);
      remainingIdentityBudget(requestBudget);
      const acquired = reserved ? store.activateVerifiedRelay({...target,transport:string(payload.transport,"transport"),relayId,
        pid,relayStartToken,parentPid,instanceId:string(payload.instanceId,"instanceId"),codeDigest:relayCodeDigest(payload.codeDigest) ?? null}) : store.acquireRelay({
        ...target,
        transport: string(payload.transport, "transport"),
        relayId: string(payload.relayId, "relayId"),
        pid,
        codeDigest: relayCodeDigest(payload.codeDigest) ?? null,
        parentPid: integer(payload.parentPid, "parentPid"),
        ...(optionalString(payload, "instanceId") ? { instanceId: optionalString(payload, "instanceId")! } : {}),
      });
      observePeerRelay(store, payload, acquired);
      return { acquired };
    }
    default: throw new Error("Unknown identity operation.");
  }
}

export function dispatchSessionMessageBrokerOperation(store: SessionMessageStore, operation: string, payload: Record<string, unknown>,
  wakeObserver?: WakeHookObservationReader, historicalWakeVerifier = verifyHistoricalWakeObservation): unknown {
  switch (operation) {
    case "ping": return { protocolVersion: SESSION_MESSAGE_PROTOCOL, capabilities: SESSION_MESSAGE_BROKER_CAPABILITIES };
    case "prepare": {
      if (Object.keys(payload).some((key) => !["sender", "target", "body", "ttlSeconds"].includes(key))) throw new Error("prepare accepts sender, target, body and ttlSeconds; IDs are system-issued.");
      const ttlSeconds = optionalInteger(payload, "ttlSeconds");
      return store.prepare({
        sender: identity(payload.sender),
        target: identity(payload.target),
        body: string(payload.body, "body"),
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      });
    }
    case "send": {
      if (Object.keys(payload).some((key) => !["sender", "messageId"].includes(key))) throw new Error("send accepts only sender and the ID returned by prepare; message content is immutable. Retry the known ID or compare saved receipts/status if delivery is unknown.");
      return store.submitPrepared(identity(payload.sender), string(payload.messageId, "messageId"));
    }
    case "claim": {
      const maxMessages = optionalInteger(payload, "maxMessages");
      const maxBodyChars = optionalInteger(payload, "maxBodyChars");
      return { messages: store.claim(identity(payload.target), Date.now(), {
        ...(maxMessages === undefined ? {} : { maxMessages }),
        ...(maxBodyChars === undefined ? {} : { maxBodyChars }),
      }) };
    }
    case "claim-wake": {
      const maxMessages = optionalInteger(payload, "maxMessages");
      const maxBodyChars = optionalInteger(payload, "maxBodyChars");
      const nonces = Array.isArray(payload.nonces) ? payload.nonces.map((value) => string(value, "nonce")) : [];
      const target = identity(payload.target);
      const result = store.claimWake(target, nonces, Date.now(), {
        ...(maxMessages === undefined ? {} : { maxMessages }),
        ...(maxBodyChars === undefined ? {} : { maxBodyChars }),
      });
      const runtime = peerWaitRuntime(store);
      const owner = JSON.stringify(target);
      const binding = runtime.relays.get(owner);
      const presence = store.presence(target);
      const wakeKeys = nonces.map((nonce) => createHash("sha256").update(nonce).digest("hex"));
      const sameGeneration = wakeKeys.length > 0 && wakeKeys.every((key) => {
        const wake = runtime.wakes.get(key);
        return wake?.owner === owner && wake.instanceId === binding?.instanceId && wake.relayId === binding?.relayId;
      });
      if (result.recognized && sameGeneration && binding?.instanceId === presence.instanceId && presence.state === "online") binding.wakeObservedAt = Date.now();
      for (const key of wakeKeys) runtime.wakes.delete(key);
      return result;
    }
    case "claim-host-wake": {
      if (Object.keys(payload).some((key) => !["target", "observation", "sourceReceiptId", "maxMessages", "maxBodyChars"].includes(key))) {
        throw new Error("Host wake claim requires a non-authorizing hook source receipt.");
      }
      const target = identity(payload.target);
      const maxMessages = optionalInteger(payload, "maxMessages");
      const maxBodyChars = optionalInteger(payload, "maxBodyChars");
      const result = store.claimHostWake(target, payload.observation as InputObservation,
        typeof payload.sourceReceiptId === "string" ? payload.sourceReceiptId : "", wakeObserver, Date.now(), {
          ...(maxMessages === undefined ? {} : { maxMessages }), ...(maxBodyChars === undefined ? {} : { maxBodyChars }),
        });
      const runtime = peerWaitRuntime(store);
      const binding = runtime.relays.get(JSON.stringify(target));
      if (result.recognized && result.binding && binding?.instanceId === result.binding.instanceId
        && binding.relayId === result.binding.relayId) binding.wakeObservedAt = Date.now();
      // Legacy markers drain naturally, but only the actual hook supplies this receipt.
      if (result.recognized && !result.binding && binding) {
        const nonces = (payload.observation as InputObservation).wakeCandidates ?? [];
        const owner = JSON.stringify(target);
        const presence = store.presence(target);
        const keys = nonces.map((nonce) => createHash("sha256").update(nonce).digest("hex"));
        if (keys.length > 0 && keys.every((key) => {
          const wake = runtime.wakes.get(key);
          return wake?.owner === owner && wake.instanceId === binding.instanceId && wake.relayId === binding.relayId;
        }) && presence.state === "online" && presence.instanceId === binding.instanceId) binding.wakeObservedAt = Date.now();
        for (const key of keys) runtime.wakes.delete(key);
      }
      // retired marks a verified arrival of an attempt the liveness rule already retired; it authorizes no claim.
      return { recognized: result.recognized, messages: result.messages, managed: result.binding !== null, ...(result.retired ? { retired: true } : {}) };
    }
    case "observe-native-input": {
      peerWaitRuntime(store).policy.reset(identity(payload.target));
      store.observeNativeInput(identity(payload.target));
      return { observed: true };
    }
    case "claim-deferred": {
      const maxMessages = optionalInteger(payload, "maxMessages");
      const maxBodyChars = optionalInteger(payload, "maxBodyChars");
      return { messages: store.claimDeferred(identity(payload.target), Date.now(), {
        ...(maxMessages === undefined ? {} : { maxMessages }),
        ...(maxBodyChars === undefined ? {} : { maxBodyChars }),
      }) };
    }
    case "claim-turn-end": {
      const maxMessages = optionalInteger(payload, "maxMessages");
      const maxBodyChars = optionalInteger(payload, "maxBodyChars");
      return { messages: store.claimTurnEnd(identity(payload.target), Date.now(), {
        ...(maxMessages === undefined ? {} : { maxMessages }),
        ...(maxBodyChars === undefined ? {} : { maxBodyChars }),
      }) };
    }
    case "clear-deferred": {
      store.clearDeferred(identity(payload.target));
      return { cleared: true };
    }
    case "acknowledge": return { acknowledged: store.acknowledge(identity(payload.target), Array.isArray(payload.messageIds) ? payload.messageIds.map((value) => string(value, "messageId")) : []) };
    case "status": {
      const status = store.status(identity(payload.sender), string(payload.messageId, "messageId"));
      return { status, ...(status === null ? { guidance: "Delivery is unknown; compare saved receipts. Prepare only a new intent, not an automatic resend." } : {}) };
    }
    case "peer-wait": {
      const sender = identity(payload.sender);
      if (!Array.isArray(payload.targets) || payload.targets.length < 1 || payload.targets.length > 8) throw new Error("targets must contain 1..8 identities.");
      const targets = normalizePeerWaitTargets(payload.targets.map(identity));
      const timeoutMs = integer(payload.timeoutMs, "timeoutMs");
      if (timeoutMs < 0 || timeoutMs > 3_600_000) throw new Error("timeoutMs is out of range.");
      const queryRevision = optionalString(payload, "queryRevision") ?? "";
      if (queryRevision.length > 256) throw new Error("queryRevision is too long.");
      const runtime = peerWaitRuntime(store);
      const presence = store.presence(sender);
      const binding = runtime.relays.get(JSON.stringify(sender));
      const relay = presence.transport ? store.liveRelay(sender, presence.transport) : null;
      const resumeObserved = presence.state === "online" && presence.instanceId !== null && binding?.instanceId === presence.instanceId
        && binding.wakeObservedAt !== undefined && Date.now() - binding.wakeObservedAt < 30_000
        && binding.relayId === relay?.relayId && relay !== null && alive(relay.pid) && alive(relay.parentPid)
        && presence.deliveryCapabilities.idleWake !== "none" && presence.wakeVisibility === presence.deliveryCapabilities.idleWake
        && presence.deliveryCapabilities.supportedInjection.includes("peer-wake");
      const states = targets.map((target) => store.peerWaitState(sender, target));
      const decision = runtime.policy.decide({ sender, targets, timeoutMs, peersObserved: states.every((state) => state.related), resumeObserved,
        fingerprint: JSON.stringify([presence.instanceId, queryRevision, states.map((state) => state.fingerprint)]) });
      return { ...decision, peers: targets.map((target, index) => ({ target, related: states[index]!.related, stateDigest: states[index]!.fingerprint })) };
    }
    case "pending": return { count: store.pendingCount(identity(payload.target)) };
    case "ensure-relay": return runIdentitySync(relayIdentityOperation(store, operation, payload));
    case "release-verified-relay": return {released:store.releaseVerifiedRelay({...identity(payload.target),
      transport:string(payload.transport,"transport"),relayId:string(payload.relayId,"relayId"),instanceId:string(payload.instanceId,"instanceId"),pid:integer(payload.pid,"pid")})};
    case "acquire-relay": return runIdentitySync(relayIdentityOperation(store, operation, payload));
    case "heartbeat-relay": {
      const target = identity(payload.target);
      const isAlive = store.heartbeatRelay({ ...target, transport: string(payload.transport, "transport"), relayId: string(payload.relayId, "relayId") });
      observePeerRelay(store, payload, isAlive);
      return { alive: isAlive };
    }
    case "relay-tick": {
      const result = store.relayTick({ ...identity(payload.target), transport: string(payload.transport, "transport"),
        relayId: string(payload.relayId, "relayId"), instanceId: string(payload.instanceId, "instanceId"),
        includePending: boolean(payload.includePending, "includePending") });
      observePeerRelay(store, payload, result.alive);
      return result;
    }
    case "presence-start": {
      const target = identity(payload.target);
      const wakeVisibility = string(payload.wakeVisibility, "wakeVisibility");
      const collaborationId = optionalString(payload, "collaborationId");
      const workspaceId = optionalString(payload, "workspaceId");
      const role = optionalString(payload, "role");
      const idleWake = optionalString(payload, "idleWake") ?? wakeVisibility;
      const injection = Object.hasOwn(payload, "supportedInjection") ? supportedInjection(payload.supportedInjection) : [];
      if (wakeVisibility !== "silent" && wakeVisibility !== "user-message" && wakeVisibility !== "none") throw new Error("wakeVisibility is invalid.");
      if (idleWake !== "silent" && idleWake !== "user-message" && idleWake !== "none") throw new Error("idleWake is invalid.");
      return { presence: store.startPresence({
        ...target,
        instanceId: string(payload.instanceId, "instanceId"),
        transport: string(payload.transport, "transport"),
        wakeVisibility,
        canWakeSilently: boolean(payload.canWakeSilently, "canWakeSilently"),
        deliveryCapabilities: { supportedInjection: injection, idleWake },
        ...(collaborationId === undefined ? {} : { collaborationId }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(role === undefined ? {} : { role }),
      }) };
    }
    case "presence-heartbeat": return { alive: store.heartbeatPresence(
      identity(payload.target), string(payload.instanceId, "instanceId"),
    ) };
    case "presence-end": return { ended: store.endPresence(
      identity(payload.target), string(payload.reason, "reason"), string(payload.instanceId, "instanceId"),
    ) };
    case "presence": return { presence: store.presence(identity(payload.target)) };
    case "list-presence": {
      let targets: SessionIdentity[] | undefined;
      if (payload.targets !== undefined) {
        if (!Array.isArray(payload.targets) || payload.targets.length < 1 || payload.targets.length > SESSION_PRESENCE_LIST_MAX_TARGETS) {
          throw new Error(`targets must list 1 to ${SESSION_PRESENCE_LIST_MAX_TARGETS} session identities.`);
        }
        targets = payload.targets.map(identity);
      }
      const result = { sessions: store.listPresence(Date.now(), targets, readRelayCodeDigest(new URL("./session-message-relay.mjs", import.meta.url))) };
      // Refuse explicitly rather than send a reply the client would drop; the untargeted request can grow with the DB.
      if (Buffer.byteLength(`${JSON.stringify({ ok: true, data: result })}\n`, "utf8") > SESSION_MESSAGE_MAX_RESPONSE_BYTES) {
        throw new Error("The presence list exceeds the broker response limit; request fewer targets.");
      }
      return result;
    }
    case "reserve-wake": {
      const target = identity(payload.target);
      const nonce = string(payload.nonce, "nonce");
      if (["instanceId", "relayId", "transport", "resume"].some((key) => Object.hasOwn(payload, key))) {
        return store.reserveManagedWake({ ...target, nonce, instanceId: string(payload.instanceId, "instanceId"),
          relayId: string(payload.relayId, "relayId"), transport: string(payload.transport, "transport"),
          ...(payload.resume === undefined ? {} : { resume: boolean(payload.resume, "resume") }) });
      }
      const shouldDispatch = store.reserveWake(target, nonce);
      const runtime = peerWaitRuntime(store);
      const owner = JSON.stringify(target);
      const binding = runtime.relays.get(owner);
      if (shouldDispatch && binding && binding.instanceId === store.presence(target).instanceId) {
        if (runtime.wakes.size >= 1000) runtime.wakes.delete(runtime.wakes.keys().next().value!);
        runtime.wakes.set(createHash("sha256").update(nonce).digest("hex"), { owner, instanceId: binding.instanceId, relayId: binding.relayId, expiresAt: Date.now() + 3_600_000 });
      }
      return { dispatch: shouldDispatch };
    }
    case "start-wake": return store.startManagedWake(wakeAttempt(payload.attempt));
    case "record-wake-outcome": {
      const outcome = string(payload.outcome, "outcome");
      if (outcome !== "submitted" && outcome !== "definite-failure" && outcome !== "accepted-or-unknown" && outcome !== "target-unavailable") throw new Error("Invalid wake dispatch outcome.");
      return { recorded: store.recordManagedWakeOutcome(wakeAttempt(payload.attempt), outcome) };
    }
    case "reconcile-wake-observation": {
      if (Object.keys(payload).some((key) => !["target", "attemptId", "sourceReceiptId"].includes(key))
        || !payload.target || typeof payload.target !== "object" || Array.isArray(payload.target)
        || Object.keys(payload.target).some((key) => !["host", "sessionId"].includes(key))) {
        throw new Error("Historical wake reconciliation contains unsupported fields.");
      }
      return store.reconcileHistoricalWake(identity(payload.target), string(payload.attemptId, "attemptId"),
        string(payload.sourceReceiptId, "sourceReceiptId"), Date.now(), historicalWakeVerifier);
    }
    case "wake-status": return { wake: store.managedWakeStatus(identity(payload.target)) };
    case "release-wake": return { released: store.releaseWake(identity(payload.target), string(payload.nonce, "nonce")) };
    case "consume-wake": return { consumed: store.consumeWake(identity(payload.target), string(payload.nonce, "nonce")) };
    default: throw new Error("Unknown broker operation.");
  }
}

async function publishEndpoint(temporary: string, endpointPath: string, budget?: ProcessIdentityBudget): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      remainingIdentityBudget(budget);
      renameSync(temporary, endpointPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      await delay(Math.min(50 * 2 ** attempt, remainingIdentityBudget(budget) ?? Infinity));
    }
  }
}

export async function startSessionMessageBroker(stateDirectory: string, budget?: ProcessIdentityBudget): Promise<"started" | "already-running"> {
  remainingIdentityBudget(budget);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  try { await chmod(stateDirectory, 0o700); } catch { /* Windows ACLs remain governed by the user profile. */ }
  const lockPath = path.join(stateDirectory, "broker.lock");
  const processLock = await acquireBrokerProcessLockWhenReady(lockPath, budget);
  if (processLock === null) return "already-running";
  const endpointPath = path.join(stateDirectory, "endpoint.json");
  const databasePath = path.join(stateDirectory, "session-messages.sqlite3");
  let store: SessionMessageStore | undefined;
  let server: tls.Server | undefined;
  let temporary: string | undefined;
  let published = false;
  let cleaned = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const sockets = new Set<tls.TLSSocket>();
  const identityQueries = new AbortController();
  const onSignal = () => { cleanup(); process.exit(0); };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    identityQueries.abort();
    clearInterval(idleTimer);
    for (const socket of sockets) socket.destroy();
    try { server?.close(); } catch { /* Already closed. */ }
    try { store?.close(); } catch { /* Already closed. */ }
    try {
      if (published && ownsBrokerProcessLock(processLock)) rmSync(endpointPath, { force: true });
    } catch (error) {
      process.stderr.write(`Session message broker endpoint cleanup failed (${brokerFailureCode(error)}).\n`);
    }
    if (temporary) {
      try { rmSync(temporary, { force: true }); } catch { /* Best effort. */ }
    }
    try { releaseBrokerProcessLock(processLock); } catch (error) {
      process.stderr.write(`Session message broker lock release failed (${brokerFailureCode(error)}).\n`);
    }
    process.off("exit", cleanup);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
  process.once("exit", cleanup);
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    remainingIdentityBudget(budget);
    const { key, certificate, token, fingerprint256 } = await credentials(stateDirectory);
    remainingIdentityBudget(budget);
    const activeStore = new SessionMessageStore(databasePath);
    store = activeStore;
    remainingIdentityBudget(budget);
    const trustDatabasePath = process.env.AGENT_GOVERNANCE_TRUST_DB_PATH?.trim()
      ? path.resolve(process.env.AGENT_GOVERNANCE_TRUST_DB_PATH.trim()) : path.join(stateDirectory, "trust.sqlite3");
    const wakeHookObservationReader = createWakeHookObservationReader(trustDatabasePath);
    const historicalWakeVerifier: typeof verifyHistoricalWakeObservation = (target, nonce, sourceReceiptId, startedAt, lateObservedAt, nowMs) =>
      verifyHistoricalWakeObservation(target, nonce, sourceReceiptId, startedAt, lateObservedAt, nowMs, trustDatabasePath);
    let lastActivity = Date.now();
    let activeRequests = 0;
    const activeServer = tls.createServer({ key, cert: certificate, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, (socket) => {
      const readLine = sessionMessageLineReader(SESSION_MESSAGE_MAX_REQUEST_BYTES);
      // A failed client must not terminate the broker or undo a committed request.
      socket.on("error", () => socket.destroy());
      socket.setTimeout(5000, () => socket.destroy());
      socket.on("data", async (chunk: Buffer) => {
        let line: string | null;
        try { line = readLine(chunk); } catch {
          socket.end(`${JSON.stringify({ ok: false, error: "Request exceeds the broker limit." })}\n`);
          return;
        }
        if (line === null) return;
        let authenticated = false;
        try {
          const request = JSON.parse(line) as BrokerRequest;
          if (request.protocolVersion !== SESSION_MESSAGE_PROTOCOL || !tokenMatches(request.token ?? "", token)) throw new Error("Broker authentication failed.");
          authenticated = true;
          activeRequests += 1;
          const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload) ? request.payload : {};
          const requestBudget = decodeIdentityDeadline(request.identityDeadlineNs);
          const data = ["ensure-relay", "acquire-relay"].includes(request.operation)
            ? await runIdentityAsync(relayIdentityOperation(activeStore, request.operation, payload, requestBudget), identityQueries.signal)
            : dispatchSessionMessageBrokerOperation(activeStore, request.operation, payload, wakeHookObservationReader, historicalWakeVerifier);
          // Relay leases are maintained while the host is idle; maintenance is not user activity.
          if (!["ping", "relay-tick", "heartbeat-relay", "presence-heartbeat"].includes(request.operation)) lastActivity = Date.now();
          socket.end(`${JSON.stringify({ ok: true, data })}\n`);
        } catch (error) {
          // Older clients ignore the optional details field.
          socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Broker request failed.",
            ...(error instanceof MessageCapacityError ? { details: error.details } : {}) })}\n`);
        } finally {
          if (authenticated) activeRequests -= 1;
        }
      });
    });
    server = activeServer;
    activeServer.on("connection", (socket: tls.TLSSocket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      activeServer.once("error", reject);
      activeServer.listen(0, "127.0.0.1", () => resolve());
    });
    remainingIdentityBudget(budget);
    const address = activeServer.address();
    if (!address || typeof address === "string") throw new Error("The broker did not receive a TCP port.");
    const endpoint = {
      protocolVersion: SESSION_MESSAGE_PROTOCOL,
      address: "127.0.0.1",
      port: address.port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      certificateFingerprint256: fingerprint256,
    };
    temporary = `${endpointPath}.${process.pid}.${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 8)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(endpoint)}\n`, { encoding: "utf8", mode: 0o600 });
    await publishEndpoint(temporary, endpointPath, budget);
    published = true;
    remainingIdentityBudget(budget);
    idleTimer = setInterval(() => {
      if (activeRequests > 0 || Date.now() - lastActivity < IDLE_EXIT_MS) return;
      cleanup();
      process.exit(0);
    }, 5000);
    idleTimer.unref();
    return "started";
  } catch (error) {
    cleanup();
    throw error;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  // fd 3 is supplied only by our launcher; a standalone broker has no diagnostic pipe.
  const diagnosticPipe = process.argv.includes("--startup-diagnostic");
  const finishDiagnostic = (code?: string) => {
    if (!diagnosticPipe) return;
    // A caller may already have timed out and closed its end. Diagnostics are best effort.
    try { if (code) writeSync(3, `${code}\n`); } catch { /* Closed or unavailable pipe. */ }
    try { closeSync(3); } catch { /* Closed or unavailable pipe. */ }
  };
  const stateDirectory = argument("--state-directory");
  if (!stateDirectory) { finishDiagnostic("STARTUP_FAILED"); process.exitCode = 2; }
  else void (async () => startSessionMessageBroker(path.resolve(stateDirectory),
    decodeIdentityDeadline(argument("--startup-identity-deadline-ns") ?? undefined)))().then((result) => {
    finishDiagnostic();
    if (result === "already-running") process.exit(0);
  }).catch((error: unknown) => {
    const safeCode = brokerFailureCode(error);
    finishDiagnostic(safeCode);
    process.stderr.write(`Session message broker startup failed (${safeCode}).\n`);
    process.exitCode = 1;
  });
}
