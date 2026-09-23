/** Native handoff adapter over the existing TLS spool. No process launcher, task import or new task queue. */
import { performance } from "node:perf_hooks";
import type { ModelRoutingDecisionV2 } from "../../contracts/types.js";
import { ModelRoutingStore } from "../../skills/coordinate-subagents/scripts/model-routing-store.mjs";
import { ModelRoutingServiceCore } from "../../skills/coordinate-subagents/scripts/model-routing-service-core.mjs";
import { acceptPeerAssignment, encodePeerAssignment, decodePeerAssignment, preflightPeerAssignment,
  MODEL_ROUTING_PEER_FEATURE } from "../../skills/coordinate-subagents/scripts/model-routing-peer.mjs";
import { canonicalJson, convergenceDigest } from "./convergence-logic.js";
import { readSharedModelCapabilities, mergeRoutingCapabilities, type CapabilityRequest } from "./model-capability-client.js";
import type { CapabilityIdentity } from "./session-model-capabilities.js";
import { requestSessionMessageOnce } from "./session-message-client.js";
import type { SessionMessage, SessionPresence } from "./session-message-store.js";
import { MODEL_CATALOG_DIRECTORY } from "./model-routing-service.js";
import { ModelRoutingWorkflowBridge } from "./model-routing-workflow.js";
import { ModelPeerJournal } from "./model-peer-journal.js";
import { ModelPeerPacketSigner, peerCheck, peerMessageId, peerReceipt, peerInstant,
  packetMatchesDecision, type PeerPacket, type PeerDisposition } from "./model-peer-packet.js";
import { ContractValidator } from "./schema-validator.js";

type Entry = Omit<NonNullable<ReturnType<ModelRoutingStore["decision"]>>, "decision"> & { decision: ModelRoutingDecisionV2 };
interface PeerPreflightDispatch {
  dispatch_key: string;
  assignment_id: string;
  write_key: string | null;
  decision_digest: string;
  state: string;
  revision: number;
  dispatched_at: string | null;
  payload: string;
}
export interface ModelPeerSessionOptions {
  store: ModelRoutingStore;
  workflowBridge: ModelRoutingWorkflowBridge;
  identity: CapabilityIdentity;
  actorId: string;
  signer: ModelPeerPacketSigner;
  stateDirectory: string;
  clock?: () => number;
  request?: CapabilityRequest;
  timeoutMs?: number;
}

/** Identity and enablement are supplied by the local native adapter, not the peer body. */
export class ModelRoutingPeerSession {
  readonly journal: ModelPeerJournal;
  private readonly validator = new ContractValidator();
  private readonly clock: () => number;
  constructor(private readonly options: ModelPeerSessionOptions) {
    this.journal = new ModelPeerJournal(options.store.database);
    this.clock = options.clock ?? Date.now;
  }
  private exchange() {
    const deadline = performance.now() + (this.options.timeoutMs ?? 4000);
    const request: CapabilityRequest = (operation, payload, directory, timeout) => {
      const remaining = Math.min(timeout, deadline - performance.now());
      peerCheck(remaining > 0, "Peer handoff deadline expired.");
      return (this.options.request ?? requestSessionMessageOnce)(operation, payload, directory, remaining);
    };
    const call = (operation: string, payload: Record<string, unknown>) => request(operation, payload, this.options.stateDirectory, deadline - performance.now());
    return { call, request };
  }
  private entry(id: string): Entry {
    const entry = this.options.store.decision(id); peerCheck(entry, "Local assignment is unavailable.");
    const decision = this.validator.modelRoutingDecisionV2(entry.decision), request = this.validator.modelSelectionRequestV2(entry.request);
    const { decisionDigest, ...unsigned } = decision;
    peerCheck(decisionDigest === id && convergenceDigest(unsigned) === id && convergenceDigest(request) === decision.requestDigest
      && canonicalJson(request.binding) === canonicalJson(decision.binding)
      && decision.status === "selected" && decision.invocationSurface === "peer-session" && decision.target,
    "The stored peer decision is invalid or not a peer-session selection.");
    return { ...entry, decision };
  }
  private async alive(identity: CapabilityIdentity, call: ReturnType<ModelRoutingPeerSession["exchange"]>["call"]): Promise<SessionPresence> {
    const response = await call("presence", { target: { host: identity.host, sessionId: identity.sessionId } }) as { presence?: SessionPresence } | null;
    const presence = response?.presence;
    peerCheck(presence && presence.host === identity.host && presence.sessionId === identity.sessionId
      && presence.instanceId === identity.instanceId && presence.state === "online" && presence.leaseUntil
      && peerInstant(presence.leaseUntil) > this.clock(), "Peer session is expired or its instance changed.");
    return presence;
  }
  private async current(entry: Entry, io: ReturnType<ModelRoutingPeerSession["exchange"]>) {
    const shared = await readSharedModelCapabilities(this.options.stateDirectory, { request: io.request, clock: this.clock, timeoutMs: this.options.timeoutMs ?? 4000 });
    peerCheck(shared.status === "available", "Peer capability discovery is unavailable or unsupported.");
    const target = entry.decision.target!;
    const selected = shared.entries.filter(item => item.snapshot.snapshotDigest === entry.decision.capabilitySnapshotDigest
      && canonicalJson({ host: item.snapshot.host, sessionId: item.snapshot.sessionId, instanceId: item.snapshot.instanceId, actorId: item.snapshot.actorId }) === canonicalJson(target));
    peerCheck(selected.length === 1, "Selected peer capability has changed or expired.");
    const remote = selected[0]!;
    const presence = await this.alive(remote.identity, io.call);
    await this.alive(this.options.identity, io.call);
    const capabilities = mergeRoutingCapabilities(this.options.store.capabilities(), shared);
    const now = new Date(this.clock()).toISOString();
    const environment = this.revalidateCurrent(entry, capabilities, presence, now);
    return { environment, transport: remote.identity, expiresAt: remote.snapshot.expiresAt, shared };
  }
  private revalidateCurrent(entry: Entry, capabilities: ReturnType<typeof mergeRoutingCapabilities>, presence: SessionPresence, now: string) {
    // Re-read policy/catalog and participation history; never substitute the frozen selection inputs.
    const fresh = new ModelRoutingServiceCore({ catalogDirectory: MODEL_CATALOG_DIRECTORY, clock: () => now, historyProvider: this.options.workflowBridge.history })
      .resolve(entry.request, capabilities) as ModelRoutingDecisionV2;
    peerCheck(fresh.decisionDigest === entry.decision.decisionDigest, "Peer selection changed; resolve a new decision before dispatch.");
    const environment = { ...entry.environment, capabilities, now, presence: { ...presence, host: entry.decision.target!.host } };
    preflightPeerAssignment(entry.request, entry.decision, environment);
    return environment;
  }
  private async transmit(body: string, io: ReturnType<ModelRoutingPeerSession["exchange"]>) {
    const packet = this.options.signer.verify(body, this.clock());
    peerCheck(canonicalJson(packet.sender) === canonicalJson(this.options.identity), "The local session is not the packet sender.");
    await this.alive(packet.sender, io.call); await this.alive(packet.recipient, io.call);
    // Spool and signature expiries are separate: a short-lived signature never gets refreshed by a retry.
    const ttlSeconds = Math.max(30, Math.ceil((peerInstant(packet.expiresAt) - peerInstant(packet.issuedAt)) / 1000));
    const result = await io.call("send", { sender: { host: packet.sender.host, sessionId: packet.sender.sessionId },
      target: { host: packet.recipient.host, sessionId: packet.recipient.sessionId }, body, messageId: peerMessageId(body), ttlSeconds }) as { messageId?: string } | null;
    peerCheck(result?.messageId === peerMessageId(body), "The broker did not acknowledge the peer message.");
    return result.messageId;
  }
  async send(decisionDigest: string, details: { delta?: string; inputReferences?: Array<{ uri: string; digest: string }> } = {}) {
    const entry = this.entry(decisionDigest), io = this.exchange();
    this.options.workflowBridge.validatePeerHandoff(entry.request);
    const current = await this.current(entry, io);
    this.options.workflowBridge.validatePeerHandoff(entry.request); // Recheck local state after the network awaits.
    const body = encodePeerAssignment(entry.request, entry.decision, details);
    const previous = this.journal.outbound(decisionDigest);
    let packet: string;
    if (previous) {
      const existing = this.options.signer.verify(previous.body, this.clock());
      peerCheck(canonicalJson(existing.contents) === body && canonicalJson(existing.sender) === canonicalJson(this.options.identity)
        && canonicalJson(existing.recipient) === canonicalJson(current.transport), "A retry must use the identical approved handoff.");
      if (previous.state === "accepted" || previous.state === "rejected") return this.status(previous.packetId);
      packet = previous.body;
    } else {
      const now = this.clock();
      packet = this.options.signer.sign({ kind: "proposal", sender: this.options.identity, recipient: current.transport,
        issuedAt: new Date(now).toISOString(), expiresAt: new Date(Math.min(now + 60000, Date.parse(current.expiresAt))).toISOString(),
        contents: JSON.parse(body) as Record<string, unknown> });
    }
    const transfer = this.journal.prepare("outbound", entry.decision, packet, entry.request.requirements.filesystem === "write", JSON.parse(packet).expiresAt as string);
    try { await this.transmit(packet, io); this.journal.sent(transfer.packetId); }
    catch { this.journal.unknown(transfer.packetId); }
    return this.status(transfer.packetId);
  }
  async status(packetId: string) {
    const transfer = this.journal.get(packetId); peerCheck(transfer?.direction === "outbound", "No outbound handoff has this ID.");
    // Historical immutable transfer metadata remains inspectable after its send window expires.
    const stored = JSON.parse(transfer.body) as PeerPacket;
    const packet = this.options.signer.verify(transfer.body, peerInstant(stored.issuedAt));
    peerCheck(canonicalJson(packet.sender) === canonicalJson(this.options.identity), "This handoff belongs to a different sender instance.");
    let delivery: unknown = null;
    try { delivery = await this.exchange().call("status", { sender: { host: packet.sender.host, sessionId: packet.sender.sessionId }, messageId: packetId }); } catch { /* Unknown delivery is not a rejection. */ }
    return { packetId, handoffState: transfer.state, accepted: transfer.state === "accepted", delivery,
      executionStarted: false, executionState: "not-observed", completed: false, executionAuthorized: false, trustedGateSatisfied: false };
  }
  /** Read-only diagnostic. A passing check is neither a start claim nor a reusable execution permit. */
  async preflight(packetId: string) {
    const observed = await this.observeExecutionPreflight(packetId);
    const { after, now } = this.finishExecutionPreflight(packetId, observed);
    return { packetId, decisionDigest: after.entry.decision.decisionDigest, dispatchKey: after.dispatch.dispatch_key,
      dispatchRevision: after.dispatch.revision, checkedAt: now, preflightPassed: true, requiresAtomicStart: true,
      executionStarted: false, executionState: "not-observed", completed: false, executionAuthorized: false, trustedGateSatisfied: false };
  }
  /** Claim only. No executor, observation, reusable token, new lease or approval is created here. */
  async start(packetId: string, expectedRevision: number) {
    peerCheck(Number.isSafeInteger(expectedRevision) && expectedRevision >= 1 && expectedRevision < Number.MAX_SAFE_INTEGER,
      "Invalid expected dispatch revision.");
    const observed = await this.observeExecutionPreflight(packetId, expectedRevision);
    const { entry, dispatch } = observed.before;
    // BEGIN IMMEDIATE excludes other writers before the final local reads. The workflow
    // bridge reads the same local database; no network await may enter this callback.
    const claim = this.options.store.claimExecutionStart(dispatch.dispatch_key, expectedRevision, entry.decision.decisionDigest,
      () => this.finishExecutionPreflight(packetId, observed).now);
    return { packetId, decisionDigest: entry.decision.decisionDigest, dispatchKey: claim.dispatchKey,
      dispatchRevision: claim.revision, dispatchState: claim.state, dispatchedAt: claim.dispatchedAt, startClaimAcquired: true,
      requiresNativeExecutor: true, executionStarted: false, executionState: "not-observed", completed: false,
      executionAuthorized: false, trustedGateSatisfied: false };
  }
  private async observeExecutionPreflight(packetId: string, expectedRevision: number | null = null) {
    const started = performance.now(), io = this.exchange();
    const before = this.acceptedForPreflight(packetId);
    peerCheck(expectedRevision === null || before.dispatch.revision === expectedRevision, "Peer dispatch revision changed before start.");
    this.options.workflowBridge.validatePeerExecutionPreflight(before.entry.request, this.options.actorId);
    const current = await this.current(before.entry, io);
    peerCheck(canonicalJson(current.transport) === canonicalJson(this.options.identity), "The selected capability belongs to another native transport.");
    const sender = await this.alive(before.packet.sender, io.call);
    const recipient = await this.alive(before.packet.recipient, io.call);
    return { started, before, current, sender, recipient };
  }
  private finishExecutionPreflight(packetId: string, observed: Awaited<ReturnType<ModelRoutingPeerSession["observeExecutionPreflight"]>>) {
    // Any awaited request can outlive an earlier observation. Use a new clock and local snapshot
    // after the final await, and reject competing dispatch/authorization changes without undoing them.
    const { started, before, current, sender, recipient } = observed;
    const now = new Date(this.clock()).toISOString();
    peerCheck(peerInstant(sender.leaseUntil) > peerInstant(now) && peerInstant(recipient.leaseUntil) > peerInstant(now), "Peer presence expired during execution preflight.");
    const after = this.acceptedForPreflight(packetId);
    peerCheck(canonicalJson(before) === canonicalJson(after), "The accepted handoff changed during execution preflight.");
    this.options.workflowBridge.validatePeerExecutionPreflight(after.entry.request, this.options.actorId);
    this.revalidateCurrent(after.entry, mergeRoutingCapabilities(this.options.store.capabilities(), current.shared), recipient, now);
    peerCheck(performance.now() - started < (this.options.timeoutMs ?? 4000), "Peer execution preflight deadline expired.");
    return { after, now };
  }
  private acceptedForPreflight(packetId: string) {
    peerCheck(typeof packetId === "string" && /^ags-peer-[a-f0-9]{64}$/u.test(packetId), "Invalid preflight packet ID.");
    const transfer = this.journal.get(packetId, "inbound");
    peerCheck(transfer?.state === "accepted" && transfer.reply !== null, "Execution preflight requires an accepted inbound handoff.");
    const packet = this.options.signer.verify(transfer.body, this.clock());
    peerCheck(packet.kind === "proposal" && peerMessageId(transfer.body) === packetId && transfer.expiresAt === packet.expiresAt
      && canonicalJson(packet.recipient) === canonicalJson(this.options.identity), "The accepted handoff belongs to another packet or receiver instance.");
    const entry = this.entry(transfer.decisionDigest); packetMatchesDecision(packet, entry.decision);
    const target = entry.decision.target!;
    peerCheck(target.actorId === this.options.actorId && target.sessionId === this.options.identity.sessionId
      && target.instanceId === this.options.identity.instanceId, "The accepted handoff belongs to another local actor.");
    // The immutable receipt is historical admission evidence, not a new permission or refreshed TTL.
    const storedReply = JSON.parse(transfer.reply) as PeerPacket;
    const reply = this.options.signer.verify(transfer.reply, peerInstant(storedReply.issuedAt));
    const receipt = peerReceipt(reply);
    peerCheck(peerInstant(reply.issuedAt) >= peerInstant(packet.issuedAt) && peerInstant(reply.issuedAt) <= this.clock()
      && canonicalJson(reply.sender) === canonicalJson(packet.recipient) && canonicalJson(reply.recipient) === canonicalJson(packet.sender)
      && receipt.proposalId === packetId && receipt.decisionDigest === entry.decision.decisionDigest
      && receipt.bindingDigest === convergenceDigest(entry.request.binding) && receipt.disposition === "accepted", "Invalid local acceptance receipt.");
    const binding = entry.request.binding, dispatchKey = convergenceDigest({ binding });
    const dispatch = this.options.store.database.prepare("SELECT * FROM ags_model_dispatches_v2 WHERE dispatch_key=?")
      .get(dispatchKey) as unknown as PeerPreflightDispatch | undefined;
    peerCheck(dispatch && dispatch.state === "accepted" && dispatch.dispatched_at === null
      && Number.isSafeInteger(dispatch.revision) && dispatch.revision >= 1
      && dispatch.assignment_id === binding.assignmentId && dispatch.decision_digest === entry.decision.decisionDigest
      && canonicalJson(JSON.parse(dispatch.payload)) === canonicalJson(entry.decision), "The accepted dispatch is missing, changed or already started.");
    const writeKey = entry.request.requirements.filesystem === "write"
      ? convergenceDigest({ taskId: binding.taskId, runId: binding.runId, stageId: binding.stageId }) : null;
    peerCheck(dispatch.write_key === writeKey, "The accepted dispatch does not retain its write exclusion.");
    return { transfer, packet, entry, dispatch };
  }
  async receive(message: SessionMessage) {
    const io = this.exchange(), packet = this.options.signer.verifyMessage(message, this.options.identity, this.clock());
    await this.alive(packet.sender, io.call); await this.alive(packet.recipient, io.call);
    if (packet.kind === "receipt") {
      const receipt = peerReceipt(packet), outbound = this.journal.get(receipt.proposalId);
      peerCheck(outbound?.direction === "outbound", "Unsolicited peer receipt.");
      const old = JSON.parse(outbound.body) as PeerPacket;
      const proposal = this.options.signer.verify(outbound.body, peerInstant(old.issuedAt));
      peerCheck(canonicalJson(proposal.sender) === canonicalJson(packet.recipient)
        && canonicalJson(proposal.recipient) === canonicalJson(packet.sender)
        && proposal.contents.decisionDigest === receipt.decisionDigest
        && convergenceDigest(proposal.contents.binding) === receipt.bindingDigest, "Cross-task or cross-instance peer receipt.");
      this.journal.settle(receipt.proposalId, receipt.disposition, message.body);
      return { kind: "receipt", packetId: receipt.proposalId, handoffState: receipt.disposition, executionStarted: false, completed: false };
    }
    const envelope = decodePeerAssignment(canonicalJson(packet.contents), [MODEL_ROUTING_PEER_FEATURE]);
    peerCheck(envelope.target.actorId === this.options.actorId && envelope.target.sessionId === this.options.identity.sessionId
      && envelope.target.instanceId === this.options.identity.instanceId, "The handoff is not for the observed local actor.");
    const transfer = this.journal.prepare("inbound", envelope, message.body, false, packet.expiresAt);
    if (transfer.reply) {
      try { await this.transmit(transfer.reply, io); } catch { /* Do not redo admission because a receipt could not be resent. */ }
      return { kind: "proposal", packetId: transfer.packetId, handoffState: transfer.state, duplicate: true, executionStarted: false, completed: false };
    }
    if (!this.journal.claimInbound(transfer.packetId)) {
      // Another process owns admission, or an earlier process stopped at an unknown boundary.
      // Do not manufacture a definitive rejection or repeat the authorization callback.
      return { kind: "proposal", packetId: transfer.packetId, handoffState: "unknown", duplicate: true,
        receiptDelivered: false, executionStarted: false, completed: false };
    }
    let disposition: PeerDisposition, reason: string;
    try {
      const entry = this.entry(envelope.decisionDigest); packetMatchesDecision(packet, entry.decision);
      const current = await this.current(entry, io);
      peerCheck(canonicalJson(current.transport) === canonicalJson(this.options.identity), "The capability belongs to another native transport.");
      const admitted = await acceptPeerAssignment(canonicalJson(packet.contents), {
        features: [MODEL_ROUTING_PEER_FEATURE], target: envelope.target,
        loadAssignment: async () => ({ request: entry.request, decision: entry.decision }), store: this.options.store,
        environment: { ...current.environment, refresh: async () => {
          this.options.signer.verify(message.body, this.clock());
          await this.alive(packet.sender, io.call);
          return (await this.current(entry, io)).environment;
        } },
        authorizeAndConsume: async () => {
          // This local check is read-only. An explicit denial is distinguishable from an
          // ambiguous external authorization failure, which the common helper keeps unknown.
          try { this.options.workflowBridge.validatePeerHandoff(entry.request, this.options.actorId); return true; }
          catch { return false; }
        },
        revalidateAuthorization: () => {
          this.options.signer.verify(message.body, this.clock());
          this.options.workflowBridge.validatePeerHandoff(entry.request, this.options.actorId); return true;
        },
      });
      // Admission ends here. In particular, do NOT treat shouldExecute as a call to a shell or worker.
      const state = this.options.store.dispatch(convergenceDigest({ binding: entry.request.binding }))?.state;
      disposition = admitted.accepted || state === "accepted" ? "accepted" : state === "not-started" ? "rejected" : "unknown";
      reason = disposition === "accepted" ? "HANDOFF_ACCEPTED" : disposition === "rejected" ? "LOCAL_HANDOFF_DENIED" : "ADMISSION_OUTCOME_UNKNOWN";
    } catch {
      const state = this.options.store.dispatch(convergenceDigest({ binding: envelope.binding }))?.state;
      disposition = state && state !== "not-started" ? "unknown" : "rejected";
      reason = disposition === "rejected" ? "LOCAL_HANDOFF_DENIED" : "ADMISSION_OUTCOME_UNKNOWN";
    }
    const now = this.clock();
    const reply = this.options.signer.sign({ kind: "receipt", sender: packet.recipient, recipient: packet.sender,
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
      contents: { proposalId: transfer.packetId, decisionDigest: envelope.decisionDigest, bindingDigest: convergenceDigest(envelope.binding),
        disposition, reason, executionStarted: false, completed: false } });
    this.journal.settle(transfer.packetId, disposition, reply, "inbound");
    let receiptDelivered = false;
    try { await this.transmit(reply, io); receiptDelivered = true; } catch { /* Keep immutable reply for a bounded retry; never admit a second time. */ }
    return { kind: "proposal", packetId: transfer.packetId, handoffState: disposition, receiptDelivered, executionStarted: false, completed: false };
  }
}
