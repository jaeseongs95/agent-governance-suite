import { msg, render, ROOT_LOCALE, type MessageKey } from "./i18n.js";
import type { PeerWaitSnapshotStore, SessionIdentity } from "./session-message-store.js";

export interface PeerWaitDecision {
  action: "deny" | "snapshot" | "bounded";
  reason: "async-resume" | "unchanged-peer-state" | "resume-unconfirmed" | "peer-unconfirmed";
  transmission: "observed" | "unknown";
  resume: "observed" | "unknown";
  /** Root-locale text; a hook renders `guidanceKey` and `guidanceParams` in its host locale (docs/i18n-design.md 3). */
  guidance: string;
  guidanceKey: PeerWaitGuidanceKey;
  guidanceParams: Readonly<Record<string, unknown>>;
}

type PeerWaitGuidanceKey = Extract<MessageKey, "peer.wait.snapshotGuidance" | "peer.wait.boundedGuidance">;

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

/** In-process records for a single caller (unit fixtures); the operation table passes the store's durable records. */
function memorySnapshots(): PeerWaitSnapshotStore {
  const records = new Map<string, { owner: string; fingerprint: string; expiresAt: number }>();
  return {
    now: () => Date.now(),
    get: (key) => records.get(key),
    set: (key, record) => {
      if (!records.has(key) && records.size >= RECORD_LIMIT) records.delete(records.keys().next().value!);
      records.set(key, record);
    },
    resetOwner: (owner) => { for (const [key, record] of records) if (record.owner === owner) records.delete(key); },
  };
}

/** Advisory state only: expiry and new input restore a first query. Records are shared by every process of a state directory. */
export class PeerWaitPolicy {
  constructor(private readonly snapshots: PeerWaitSnapshotStore = memorySnapshots()) {}

  reset(sender: SessionIdentity): void {
    this.snapshots.resetOwner(identityKey(sender));
  }

  decide(input: {
    sender: SessionIdentity; targets: SessionIdentity[]; timeoutMs: number;
    peersObserved: boolean; resumeObserved: boolean; fingerprint: string;
  }, nowMs = this.snapshots.now()): PeerWaitDecision {
    const transmission = input.peersObserved ? "observed" : "unknown";
    const resume = input.resumeObserved ? "observed" : "unknown";
    const guidanceKey: PeerWaitGuidanceKey = input.resumeObserved && input.peersObserved ? "peer.wait.snapshotGuidance" : "peer.wait.boundedGuidance";
    const guidanceRef = msg(guidanceKey, {});
    const text = { guidance: render(guidanceRef, ROOT_LOCALE), guidanceKey, guidanceParams: guidanceRef.params };
    if (!input.peersObserved || !input.resumeObserved) return {
      action: "bounded", reason: input.peersObserved ? "resume-unconfirmed" : "peer-unconfirmed", transmission, resume, ...text,
    };
    if (input.timeoutMs > 0) return { action: "deny", reason: "async-resume", transmission, resume, ...text };
    const owner = identityKey(input.sender);
    const key = JSON.stringify([owner, normalizePeerWaitTargets(input.targets).map(identityKey)]);
    const previous = this.snapshots.get(key);
    if (previous && previous.expiresAt > nowMs && previous.fingerprint === input.fingerprint) return { action: "deny", reason: "unchanged-peer-state", transmission, resume, ...text };
    this.snapshots.set(key, { owner, fingerprint: input.fingerprint, expiresAt: nowMs + RECORD_TTL_MS });
    return { action: "snapshot", reason: "async-resume", transmission, resume, ...text };
  }
}
