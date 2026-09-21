/** Signed, bounded envelopes carried by the existing message spool. These are not execution permits. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ModelRoutingDecisionV2 } from "../../contracts/types.js";
import { canonicalJson, convergenceDigest } from "./convergence-logic.js";
import { decodePeerAssignment, MODEL_ROUTING_PEER_FEATURE } from "../../skills/coordinate-subagents/scripts/model-routing-peer.mjs";
import type { CapabilityIdentity } from "./session-model-capabilities.js";
import type { SessionMessage } from "./session-message-store.js";
import { SESSION_MESSAGE_BODY_MAX_BYTES } from "./session-message-protocol.js";

export const PEER_PACKET_FEATURE = "model-assignment-handoff.v1";
export type PeerDisposition = "accepted" | "rejected" | "unknown";
export interface PeerPacket {
  schemaVersion: "1.0.0";
  feature: typeof PEER_PACKET_FEATURE;
  kind: "proposal" | "receipt";
  sender: CapabilityIdentity;
  recipient: CapabilityIdentity;
  issuedAt: string;
  expiresAt: string;
  contents: Record<string, unknown>;
  mac: string;
}
export function peerCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function peerObject(value: unknown): Record<string, unknown> {
  peerCheck(value && typeof value === "object" && !Array.isArray(value), "Invalid peer object.");
  return value as Record<string, unknown>;
}
export function peerExact(value: Record<string, unknown>, fields: string[]): void {
  peerCheck(Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)), "Invalid peer fields.");
}
export function peerIdentity(value: unknown): CapabilityIdentity {
  const identity = peerObject(value); peerExact(identity, ["host", "sessionId", "instanceId"]);
  for (const [key, maximum] of [["host", 64], ["sessionId", 200], ["instanceId", 128]] as const) {
    peerCheck(typeof identity[key] === "string" && identity[key].length <= maximum
      && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(identity[key]), "Invalid peer identity.");
  }
  return identity as unknown as CapabilityIdentity;
}
export function peerInstant(value: unknown): number {
  peerCheck(typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "Invalid peer timestamp.");
  return Date.parse(value);
}
export function peerMessageId(body: string): string {
  return `ags-peer-${createHash("sha256").update(body, "utf8").digest("hex")}`;
}
export function isModelPeerPacket(body: string): boolean {
  if (Buffer.byteLength(body, "utf8") > SESSION_MESSAGE_BODY_MAX_BYTES) return false;
  try { return peerObject(JSON.parse(body)).feature === PEER_PACKET_FEATURE; } catch { return false; }
}
export function peerReceipt(packet: PeerPacket): {
  proposalId: string; decisionDigest: string; bindingDigest: string;
  disposition: PeerDisposition; reason: string;
} {
  peerCheck(packet.kind === "receipt", "Not a peer receipt.");
  const value = packet.contents;
  peerExact(value, ["proposalId", "decisionDigest", "bindingDigest", "disposition", "reason", "executionStarted", "completed"]);
  peerCheck(typeof value.proposalId === "string" && /^ags-peer-[a-f0-9]{64}$/u.test(value.proposalId)
    && typeof value.decisionDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(value.decisionDigest)
    && typeof value.bindingDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(value.bindingDigest), "Invalid peer receipt binding.");
  peerCheck(["accepted", "rejected", "unknown"].includes(String(value.disposition))
    && typeof value.reason === "string" && /^[A-Z_]{1,80}$/u.test(value.reason)
    && value.executionStarted === false && value.completed === false, "A handoff receipt cannot claim execution or completion.");
  return value as unknown as ReturnType<typeof peerReceipt>;
}

/** Same-OS-user integrity only. The key is domain-separated and is never sent to another session. */
export class ModelPeerPacketSigner {
  private readonly key: Buffer;
  constructor(brokerToken: string) {
    peerCheck(/^[A-Za-z0-9_-]{43}$/u.test(brokerToken), "Invalid peer transport credential.");
    this.key = createHmac("sha256", brokerToken).update("ags:model-assignment-handoff:v1").digest();
  }
  sign(value: Omit<PeerPacket, "schemaVersion" | "feature" | "mac">): string {
    const unsigned = { schemaVersion: "1.0.0" as const, feature: PEER_PACKET_FEATURE, ...structuredClone(value) };
    const mac = createHmac("sha256", this.key).update(canonicalJson(unsigned)).digest("hex");
    const body = canonicalJson({ ...unsigned, mac });
    this.verify(body, peerInstant(unsigned.issuedAt));
    return body;
  }
  verify(body: string, nowMs: number): PeerPacket {
    peerCheck(typeof body === "string" && !body.includes("\0") && Buffer.byteLength(body, "utf8") <= SESSION_MESSAGE_BODY_MAX_BYTES, "Peer packet exceeds the spool limit.");
    const packet = peerObject(JSON.parse(body));
    peerExact(packet, ["schemaVersion", "feature", "kind", "sender", "recipient", "issuedAt", "expiresAt", "contents", "mac"]);
    peerCheck(packet.schemaVersion === "1.0.0" && packet.feature === PEER_PACKET_FEATURE
      && ["proposal", "receipt"].includes(String(packet.kind)) && typeof packet.mac === "string" && /^[a-f0-9]{64}$/u.test(packet.mac), "Invalid peer packet version or signature.");
    peerIdentity(packet.sender); peerIdentity(packet.recipient);
    const issued = peerInstant(packet.issuedAt), expires = peerInstant(packet.expiresAt);
    peerCheck(Number.isFinite(nowMs) && issued <= nowMs && nowMs < expires && expires - issued <= 60000, "Peer packet is expired or future-dated.");
    const { mac, ...unsigned } = packet;
    peerCheck(timingSafeEqual(createHmac("sha256", this.key).update(canonicalJson(unsigned)).digest(), Buffer.from(String(mac), "hex")), "Peer signature mismatch.");
    const value = packet as unknown as PeerPacket;
    peerObject(value.contents);
    if (value.kind === "proposal") decodePeerAssignment(canonicalJson(value.contents), [MODEL_ROUTING_PEER_FEATURE]);
    else peerReceipt(value);
    return value;
  }
  verifyMessage(message: SessionMessage, own: CapabilityIdentity, nowMs: number): PeerPacket {
    const packet = this.verify(message.body, nowMs);
    peerCheck(message.messageId === peerMessageId(message.body) && peerInstant(message.expiresAt) > nowMs
      && message.sender.host === packet.sender.host && message.sender.sessionId === packet.sender.sessionId
      && message.recipient.host === packet.recipient.host && message.recipient.sessionId === packet.recipient.sessionId
      && canonicalJson(packet.recipient) === canonicalJson(own), "Peer packet does not match the claimed spool message or local instance.");
    return packet;
  }
}
export function packetMatchesDecision(packet: PeerPacket, decision: ModelRoutingDecisionV2): void {
  const proposal = decodePeerAssignment(canonicalJson(packet.contents), [MODEL_ROUTING_PEER_FEATURE]);
  peerCheck(packet.kind === "proposal" && proposal.decisionDigest === decision.decisionDigest
    && canonicalJson(proposal.binding) === canonicalJson(decision.binding)
    && canonicalJson(proposal.target) === canonicalJson(decision.target), "Peer proposal differs from the locally registered decision.");
}
export const peerBindingDigest = (decision: ModelRoutingDecisionV2): string => convergenceDigest(decision.binding);
