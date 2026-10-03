import { createHash, createPublicKey, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { SESSION_MESSAGE_MAX_REQUEST_BYTES, SESSION_MESSAGE_MAX_RESPONSE_BYTES, SESSION_MESSAGE_PROTOCOL,
  SESSION_PRESENCE_BATCH_LIMIT, sessionMessageLineReader, sessionMessageSuccessFrame } from "./session-message-protocol.js";
import { MessageCapacityError, SessionMessageStore, type CurrentActivityReporterReader, type CurrentTaskBindingReader,
  type SessionIdentity, type WakeAttempt } from "./session-message-store.js";
import { createWakeHookObservationReader, verifyHistoricalWakeObservation, type WakeHookObservationReader } from "./session-message-wake-port.js";
import type { InputObservation, InputObservationKind } from "./input-observation.js";
import { PeerWaitPolicy, normalizePeerWaitTargets } from "./peer-wait-policy.js";
import { createSelfSignedCertificate } from "./self-signed-certificate.js";
import { SessionModelCapabilityStore, capabilitySigner, MODEL_CAPABILITY_FEATURE } from "./session-model-capabilities.js";
import type { RoutingObserverReceipt } from "../../skills/coordinate-subagents/scripts/model-routing-store.mjs";
import type { SessionTaskActivityObservationV1, SessionTaskRequestV1, SessionTaskTerminalOutcomeV1 } from "../../contracts/types.js";

const IDLE_EXIT_MS = 60_000;
export const SESSION_MESSAGE_BROKER_CAPABILITIES = ["atomic-wake-claim", "deferred-boundary", "delivery-capabilities", "session-contact-v1", "peer-wait-policy"] as const;

interface BrokerRequest {
  protocolVersion: string;
  token: string;
  operation: string;
  payload: Record<string, unknown>;
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

function acquireProcessLock(lockPath: string): number | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      return descriptor;
    } catch {
      try {
        const owner = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
        if (Number.isInteger(owner) && alive(owner)) return null;
        rmSync(lockPath, { force: true });
      } catch {
        return null;
      }
    }
  }
  return null;
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

export function dispatchSessionMessageBrokerOperation(store: SessionMessageStore, operation: string, payload: Record<string, unknown>, modelCapabilities?: SessionModelCapabilityStore,
  taskBindingReader?: CurrentTaskBindingReader, activityReporterReader?: CurrentActivityReporterReader, wakeObserver?: WakeHookObservationReader, historicalWakeVerifier = verifyHistoricalWakeObservation): unknown {
  switch (operation) {
    case "ping": return { protocolVersion: SESSION_MESSAGE_PROTOCOL, capabilities: [...SESSION_MESSAGE_BROKER_CAPABILITIES, ...(modelCapabilities ? [MODEL_CAPABILITY_FEATURE] : [])] };
    case "resource-admission": throw new Error("Resource admission is unavailable.");
    case "publish-model-capability": {
      if (!modelCapabilities) throw new Error("Model capability exchange is unavailable.");
      if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, "receipt")) throw new Error("A signed capability receipt is required.");
      return modelCapabilities.publish(payload.receipt as RoutingObserverReceipt);
    }
    case "list-model-capabilities": {
      if (!modelCapabilities) throw new Error("Model capability exchange is unavailable.");
      return modelCapabilities.list(payload);
    }
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
    case "contact-session": {
      const expectedActor = payload.expectedActor as Record<string, unknown> | undefined;
      if (!expectedActor || typeof expectedActor.instanceId !== "string") throw new Error("Expected actor is required.");
      const actor = identity(expectedActor);
      const target = identity(payload.target);
      if (actor.host !== target.host || actor.sessionId !== target.sessionId) throw new Error("Expected actor and target differ.");
      return store.contact({
        messageId: string(payload.messageId, "messageId"), sender: identity(payload.sender), target,
        body: string(payload.body, "body"),
        ...(Object.hasOwn(payload, "ttlSeconds") ? { ttlSeconds: integer(payload.ttlSeconds, "ttlSeconds") } : {}),
        expectedActor: { ...actor, instanceId: expectedActor.instanceId },
        expectedTurnId: string(payload.expectedTurnId, "expectedTurnId"),
        expectedRevision: integer(payload.expectedRevision, "expectedRevision"),
      }, Boolean(activityReporterReader));
    }
    case "prepare-task-request": return store.prepareTaskRequest({
      request: payload.request as SessionTaskRequestV1,
      body: string(payload.body, "body"),
      ...(Object.hasOwn(payload, "ttlSeconds") ? { ttlSeconds: integer(payload.ttlSeconds, "ttlSeconds") } : {}),
    });
    case "receipt-task-request": return store.registerTaskRequest({
      request: payload.request as SessionTaskRequestV1,
      body: string(payload.body, "body"),
      ...(Object.hasOwn(payload, "ttlSeconds") ? { ttlSeconds: integer(payload.ttlSeconds, "ttlSeconds") } : {}),
    }, Date.now(), undefined, string(payload.reconcileToken, "reconcileToken"));
    case "register-contact-task-request": {
      if (Object.hasOwn(payload, "messageId")) throw new Error("Task request messageId is broker-assigned.");
      const expectedActor = payload.expectedActor as Record<string, unknown> | undefined;
      if (!expectedActor || typeof expectedActor.instanceId !== "string") throw new Error("Expected actor is required.");
      return store.registerTaskRequest({
        request: payload.request as SessionTaskRequestV1,
        body: string(payload.body, "body"),
        ...(Object.hasOwn(payload, "ttlSeconds") ? { ttlSeconds: integer(payload.ttlSeconds, "ttlSeconds") } : {}),
      }, Date.now(), { expectedActor: { ...identity(expectedActor), instanceId: expectedActor.instanceId },
        expectedTurnId: string(payload.expectedTurnId, "expectedTurnId"),
        expectedRevision: integer(payload.expectedRevision, "expectedRevision"),
        trustedActivity: Boolean(activityReporterReader),
        reconcileToken: string(payload.reconcileToken, "reconcileToken") });
    }
    case "record-task-outcome": {
      if (!taskBindingReader) throw new Error("Current task binding is unavailable.");
      if (Object.keys(payload).sort().join() !== "outcome,reporterProof") throw new Error("A terminal outcome and reporter proof are required.");
      return store.recordTaskOutcome(payload.outcome as SessionTaskTerminalOutcomeV1,
        string(payload.reporterProof, "reporterProof"), taskBindingReader);
    }
    case "reconcile-task-request": return store.reconcileTaskRequest(
      identity(payload.sender), string(payload.requestId, "requestId"),
      string(payload.reconcileToken, "reconcileToken"));
    case "record-session-activity": {
      if (!activityReporterReader) throw new Error("Current activity reporter is unavailable.");
      if (Object.keys(payload).sort().join() !== "event,reporterProof,turnId") {
        throw new Error("An activity event, turnId and reporter proof are required.");
      }
      return store.recordActivity(payload.event as SessionTaskActivityObservationV1,
        string(payload.turnId, "turnId"), string(payload.reporterProof, "reporterProof"), activityReporterReader);
    }
    case "session-activity": {
      const target = identity(payload.target);
      return { activity: activityReporterReader ? store.activityStatus(target) : {
        actor: null, activity: "unknown", turnId: null, revision: 0, observedAt: null, source: null,
      } };
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
    case "acquire-relay": {
      const target = identity(payload.target);
      const acquired = store.acquireRelay({
        ...target,
        transport: string(payload.transport, "transport"),
        relayId: string(payload.relayId, "relayId"),
        pid: integer(payload.pid, "pid"),
        parentPid: integer(payload.parentPid, "parentPid"),
      });
      observePeerRelay(store, payload, acquired);
      return { acquired };
    }
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
      if (!Array.isArray(payload.targets) || payload.targets.length > SESSION_PRESENCE_BATCH_LIMIT) {
        throw new Error(`Presence lookup requires at most ${SESSION_PRESENCE_BATCH_LIMIT} targets.`);
      }
      return { sessions: store.listPresence(payload.targets.map(identity)) };
    }
    case "reserve-wake": {
      const target = identity(payload.target);
      const nonce = string(payload.nonce, "nonce");
      if (["instanceId", "relayId", "transport", "resume"].some((key) => Object.hasOwn(payload, key))) {
        return store.reserveManagedWake({ ...target, nonce, instanceId: string(payload.instanceId, "instanceId"),
          relayId: string(payload.relayId, "relayId"), transport: string(payload.transport, "transport"),
          ...(payload.resume === undefined ? {} : { resume: boolean(payload.resume, "resume") }) }, Date.now(), Boolean(activityReporterReader));
      }
      const shouldDispatch = store.reserveWake(target, nonce, Date.now(), Boolean(activityReporterReader));
      const runtime = peerWaitRuntime(store);
      const owner = JSON.stringify(target);
      const binding = runtime.relays.get(owner);
      if (shouldDispatch && binding && binding.instanceId === store.presence(target).instanceId) {
        if (runtime.wakes.size >= 1000) runtime.wakes.delete(runtime.wakes.keys().next().value!);
        runtime.wakes.set(createHash("sha256").update(nonce).digest("hex"), { owner, instanceId: binding.instanceId, relayId: binding.relayId, expiresAt: Date.now() + 3_600_000 });
      }
      return { dispatch: shouldDispatch };
    }
    case "start-wake": return store.startManagedWake(wakeAttempt(payload.attempt), Date.now(), Boolean(activityReporterReader));
    case "record-wake-outcome": {
      const outcome = string(payload.outcome, "outcome");
      if (outcome !== "submitted" && outcome !== "definite-failure" && outcome !== "accepted-or-unknown") throw new Error("Invalid wake dispatch outcome.");
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

async function publishEndpoint(temporary: string, endpointPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temporary, endpointPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      await delay(50 * 2 ** attempt);
    }
  }
}

export async function startSessionMessageBroker(stateDirectory: string): Promise<"started" | "already-running"> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  try { await chmod(stateDirectory, 0o700); } catch { /* Windows ACLs remain governed by the user profile. */ }
  const lockPath = path.join(stateDirectory, "broker.lock");
  const lockDescriptor = acquireProcessLock(lockPath);
  if (lockDescriptor === null) return "already-running";
  const endpointPath = path.join(stateDirectory, "endpoint.json");
  const databasePath = path.join(stateDirectory, "session-messages.sqlite3");
  let store: SessionMessageStore | undefined;
  let server: tls.Server | undefined;
  let temporary: string | undefined;
  let published = false;
  let cleaned = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const sockets = new Set<tls.TLSSocket>();
  const onSignal = () => { cleanup(); process.exit(0); };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(idleTimer);
    for (const socket of sockets) socket.destroy();
    try { server?.close(); } catch { /* Already closed. */ }
    try { store?.close(); } catch { /* Already closed. */ }
    if (published) {
      try { rmSync(endpointPath, { force: true }); } catch { /* Best effort. */ }
    }
    if (temporary) {
      try { rmSync(temporary, { force: true }); } catch { /* Best effort. */ }
    }
    try { closeSync(lockDescriptor); } catch { /* Best effort. */ }
    try { rmSync(lockPath, { force: true }); } catch { /* Best effort. */ }
    process.off("exit", cleanup);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
  process.once("exit", cleanup);
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    const { key, certificate, token, fingerprint256 } = await credentials(stateDirectory);
    const activeStore = new SessionMessageStore(databasePath);
    store = activeStore;
    let modelCapabilities: SessionModelCapabilityStore | undefined;
    try { modelCapabilities = new SessionModelCapabilityStore(activeStore, capabilitySigner(token)); }
    catch { /* Optional exchange failures must not disable legacy messaging. */ }
    const trustDatabasePath = process.env.AGENT_GOVERNANCE_TRUST_DB_PATH?.trim()
      ? path.resolve(process.env.AGENT_GOVERNANCE_TRUST_DB_PATH.trim()) : path.join(stateDirectory, "trust.sqlite3");
    const wakeHookObservationReader = createWakeHookObservationReader(trustDatabasePath);
    const historicalWakeVerifier: typeof verifyHistoricalWakeObservation = (target, nonce, receiptId, started, late, now) =>
      verifyHistoricalWakeObservation(target, nonce, receiptId, started, late, now, trustDatabasePath);
    let lastActivity = Date.now();
    const activeServer = tls.createServer({ key, cert: certificate, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, (socket) => {
      lastActivity = Date.now();
      // A peer can reset after reading a response. Isolate that socket failure from the broker.
      socket.on("error", () => socket.destroy());
      const readLine = sessionMessageLineReader(SESSION_MESSAGE_MAX_REQUEST_BYTES);
      let answered = false;
      socket.setTimeout(5000, () => socket.destroy());
      socket.on("data", (chunk: Buffer) => {
        if (answered) return;
        let line: string | null;
        try { line = readLine(chunk); } catch {
          answered = true;
          socket.end(`${JSON.stringify({ ok: false, error: "Request exceeds the broker limit." })}\n`);
          return;
        }
        if (line === null) return;
        answered = true;
        try {
          const request = JSON.parse(line) as BrokerRequest;
          if (request.protocolVersion !== SESSION_MESSAGE_PROTOCOL || !tokenMatches(request.token ?? "", token)) throw new Error("Broker authentication failed.");
          const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload) ? request.payload : {};
          const data = dispatchSessionMessageBrokerOperation(activeStore, request.operation, payload, modelCapabilities, undefined, undefined, wakeHookObservationReader, historicalWakeVerifier);
          const response = sessionMessageSuccessFrame(data);
          if (Buffer.byteLength(response, "utf8") > SESSION_MESSAGE_MAX_RESPONSE_BYTES) {
            throw new Error("The broker response exceeded its limit.");
          }
          socket.end(response);
        } catch (error) {
          socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Broker request failed.",
            ...(error instanceof MessageCapacityError ? { details: error.details } : {}) })}\n`);
        }
      });
    });
    server = activeServer;
    activeServer.on("connection", (socket: tls.TLSSocket) => {
      sockets.add(socket);
      // Includes connections that fail before the TLS handshake completes.
      socket.on("error", () => socket.destroy());
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      activeServer.once("error", reject);
      activeServer.listen(0, "127.0.0.1", () => resolve());
    });
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
    await publishEndpoint(temporary, endpointPath);
    published = true;
    idleTimer = setInterval(() => {
      if (Date.now() - lastActivity < IDLE_EXIT_MS) return;
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
  const stateDirectory = argument("--state-directory");
  if (!stateDirectory) process.exitCode = 2;
  else void startSessionMessageBroker(path.resolve(stateDirectory)).then((result) => {
    if (result === "already-running") process.exit(0);
  }).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException)?.code;
    const safeCode = typeof code === "string" && /^[A-Z0-9_]+$/u.test(code) ? code : "STARTUP_FAILED";
    process.stderr.write(`Session message broker startup failed (${safeCode}).\n`);
    process.exitCode = 1;
  });
}
