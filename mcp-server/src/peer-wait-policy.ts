import type { SessionIdentity } from "./session-message-store.js";

export interface PeerWaitDecision {
  action: "deny" | "snapshot" | "bounded";
  reason: "async-resume" | "unchanged-peer-state" | "resume-unconfirmed" | "peer-unconfirmed";
  transmission: "observed" | "unknown";
  resume: "observed" | "unknown";
  guidance: string;
}

const RECORD_TTL_MS = 30_000;
const RECORD_LIMIT = 1000;

function identityKey(identity: SessionIdentity): string {
  return JSON.stringify([identity.host, identity.sessionId]);
}

/** Peer queries concern an identity set, independent of order or repeated rows. */
export function normalizePeerWaitTargets(targets: SessionIdentity[]): SessionIdentity[] {
  const unique = new Map(targets.map((target) => [identityKey(target), { host: target.host, sessionId: target.sessionId }]));
  return [...unique.keys()].sort().map((key) => unique.get(key)!);
}

/** Advisory state only: expiry, new input and broker restart restore a first query. */
export class PeerWaitPolicy {
  private readonly snapshots = new Map<string, { owner: string; fingerprint: string; expiresAt: number }>();

  reset(sender: SessionIdentity): void {
    const owner = identityKey(sender);
    for (const [key, record] of this.snapshots) if (record.owner === owner) this.snapshots.delete(key);
  }

  decide(input: {
    sender: SessionIdentity; targets: SessionIdentity[]; timeoutMs: number;
    peersObserved: boolean; resumeObserved: boolean; fingerprint: string;
  }, nowMs = Date.now()): PeerWaitDecision {
    for (const [key, record] of this.snapshots) if (record.expiresAt <= nowMs) this.snapshots.delete(key);
    const transmission = input.peersObserved ? "observed" : "unknown";
    const resume = input.resumeObserved ? "observed" : "unknown";
    const guidance = input.resumeObserved && input.peersObserved
      ? "Use one immediate snapshot (timeoutMs: 0), then continue independent work or return; peer delivery can resume this session. A receipt or ACK is not task completion or approval."
      : "Async resume is unconfirmed. Use a bounded query or bounded wait and continue on the next user turn; do not assume returning will wake this session.";
    if (!input.peersObserved || !input.resumeObserved) return {
      action: "bounded", reason: input.peersObserved ? "resume-unconfirmed" : "peer-unconfirmed", transmission, resume, guidance,
    };
    if (input.timeoutMs > 0) return { action: "deny", reason: "async-resume", transmission, resume, guidance };
    const owner = identityKey(input.sender);
    const key = JSON.stringify([owner, normalizePeerWaitTargets(input.targets).map(identityKey)]);
    const previous = this.snapshots.get(key);
    if (previous?.fingerprint === input.fingerprint) return { action: "deny", reason: "unchanged-peer-state", transmission, resume, guidance };
    if (this.snapshots.size >= RECORD_LIMIT) this.snapshots.delete(this.snapshots.keys().next().value!);
    this.snapshots.set(key, { owner, fingerprint: input.fingerprint, expiresAt: nowMs + RECORD_TTL_MS });
    return { action: "snapshot", reason: "async-resume", transmission, resume, guidance };
  }
}
