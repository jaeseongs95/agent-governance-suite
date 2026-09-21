/** Thin, negotiated client for the existing TLS broker. Never starts a broker or executes an assignment. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { HostModelCapabilitiesV1 } from "../../contracts/types.js";
import { canonicalJson } from "./convergence-logic.js";
import { resolveSessionMessageStateDirectory } from "./runtime-config.js";
import { ContractValidator } from "./schema-validator.js";
import { requestSessionMessageOnce } from "./session-message-client.js";
import { SESSION_MESSAGE_PROTOCOL, SESSION_MESSAGE_MAX_RESPONSE_BYTES } from "./session-message-protocol.js";
import { capabilitySigner, capabilitySlot, MODEL_CAPABILITY_FEATURE, MODEL_CAPABILITY_MAX_SLOTS,
  validateCapabilityEntry, type CapabilityIdentity, type CapabilityPage, type CapabilityEntry, type CapabilityCursor } from "./session-model-capabilities.js";

export type CapabilityRequest = (operation: string, payload: Record<string, unknown>, directory: string, timeout: number) => Promise<unknown>;
interface ExchangeOptions { request?: CapabilityRequest; clock?: () => number; timeoutMs?: number; }
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function requester(directory: string, options: ExchangeOptions) {
  const deadline = performance.now() + (options.timeoutMs ?? 1500);
  return (operation: string, payload: Record<string, unknown>): Promise<unknown> => {
    const remaining = deadline - performance.now();
    check(remaining > 0, "Capability exchange deadline expired.");
    return (options.request ?? requestSessionMessageOnce)(operation, payload, directory, remaining);
  };
}
async function negotiate(call: (operation: string, payload: Record<string, unknown>) => Promise<unknown>): Promise<boolean> {
  const ping = await call("ping", {}) as { protocolVersion?: unknown; capabilities?: unknown } | null;
  check(ping?.protocolVersion === SESSION_MESSAGE_PROTOCOL && Array.isArray(ping.capabilities), "Invalid capability negotiation response.");
  return ping.capabilities.includes(MODEL_CAPABILITY_FEATURE);
}

/** The native adapter calls this only after local validation/publication. Old brokers receive no new command. */
export async function publishSharedModelCapability(snapshot: HostModelCapabilitiesV1, identity: CapabilityIdentity,
  directory = resolveSessionMessageStateDirectory(), options: ExchangeOptions = {}): Promise<"published" | "unsupported" | "unavailable"> {
  try {
    const call = requester(directory, options);
    if (!await negotiate(call)) return "unsupported";
    const token = (await readFile(path.join(directory, "broker.token"), "utf8")).trim();
    const now = new Date((options.clock ?? Date.now)()).toISOString();
    const receipt = capabilitySigner(token).issue("capability", { schemaVersion: "1.0.0", identity, snapshot }, { issuedAt: now, expiresAt: snapshot.expiresAt });
    const result = await call("publish-model-capability", { receipt }) as { snapshotDigest?: unknown } | null;
    check(result?.snapshotDigest === snapshot.snapshotDigest, "Capability publication was not acknowledged.");
    return "published";
  } catch { return "unavailable"; }
}

export type SharedCapabilityResult = { status: "available" | "unsupported" | "unavailable"; entries: CapabilityEntry[] };
/** A partial, concurrently changed or malformed page set is discarded; nothing is cached into the workflow DB. */
export async function readSharedModelCapabilities(directory = resolveSessionMessageStateDirectory(), options: ExchangeOptions = {}): Promise<SharedCapabilityResult> {
  try {
    const call = requester(directory, options), clock = options.clock ?? Date.now;
    if (!await negotiate(call)) return { status: "unsupported", entries: [] };
    const validator = new ContractValidator(), entries: CapabilityEntry[] = [], seen = new Set<string>();
    let cursor: CapabilityCursor | null = null, revision: number | null = null, presenceDigest: string | null = null;
    for (let pageCount = 0; pageCount < MODEL_CAPABILITY_MAX_SLOTS; pageCount += 1) {
      const page = await call("list-model-capabilities", { cursor }) as CapabilityPage;
      check(page && Object.keys(page).sort().join(",") === "entries,nextCursor,presenceDigest,revision,schemaVersion" && page.schemaVersion === "1.0.0"
        && Number.isSafeInteger(page.revision) && page.revision >= 0 && Array.isArray(page.entries), "Invalid capability page.");
      check(Buffer.byteLength(JSON.stringify({ ok: true, data: page }), "utf8") + 1 <= SESSION_MESSAGE_MAX_RESPONSE_BYTES, "Capability page exceeds broker limit.");
      check(revision === null || revision === page.revision, "Capability page revisions differ."); revision = page.revision;
      check(typeof page.presenceDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(page.presenceDigest)
        && (presenceDigest === null || presenceDigest === page.presenceDigest), "Capability presence changed while paging."); presenceDigest = page.presenceDigest;
      let last = cursor?.after ?? "";
      for (const raw of page.entries) {
        const entry = validateCapabilityEntry(raw, validator, clock()), slot = capabilitySlot(entry.identity);
        check(slot > last && !seen.has(slot), "Capability pages repeat or regress.");
        seen.add(slot); entries.push(entry); last = slot;
        check(entries.length <= MODEL_CAPABILITY_MAX_SLOTS, "Capability set exceeds resolver limit.");
      }
      if (page.nextCursor === null) {
        // The first page's presence can expire while the remaining pages are in transit.
        for (const entry of entries) validateCapabilityEntry(entry, validator, clock());
        return { status: "available", entries };
      }
      check(page.entries.length > 0 && Object.keys(page.nextCursor).sort().join(",") === "after,presenceDigest,revision"
        && page.nextCursor.revision === revision && page.nextCursor.presenceDigest === presenceDigest && typeof page.nextCursor.after === "string"
        && /^[a-f0-9]{64}$/u.test(page.nextCursor.after) && page.nextCursor.after >= last && page.nextCursor.after > (cursor?.after ?? ""), "Capability cursor did not advance.");
      cursor = page.nextCursor;
    }
    throw new Error("Capability paging bound exceeded.");
  } catch { return { status: "unavailable", entries: [] }; }
}

/** Keep other local adapters, but never resurrect broker-managed native snapshots after disconnect or expiry. */
export function mergeRoutingCapabilities(local: unknown[], shared: SharedCapabilityResult): unknown[] {
  const remote = shared.status === "available" ? shared.entries.map(entry => entry.snapshot) : [];
  const managed = new Set(remote.map(snapshot => `${snapshot.host}\0${snapshot.sessionId}`));
  const retained = local.filter(raw => {
    const snapshot = raw as Partial<HostModelCapabilitiesV1> | null;
    return snapshot && !snapshot.sourceReference?.startsWith("native-hook:") && !managed.has(`${snapshot.host}\0${snapshot.sessionId}`);
  });
  // Deterministic collision handling, not arrival order; never allow two authorities to disagree on one routing slot.
  const slots = new Map<string, unknown>();
  for (const snapshot of [...retained, ...remote]) {
    const s = snapshot as HostModelCapabilitiesV1, key = canonicalJson([s.host, s.sessionId, s.instanceId]);
    const previous = slots.get(key);
    check(!previous || canonicalJson(previous) === canonicalJson(snapshot), "Conflicting shared capability routing identities.");
    slots.set(key, snapshot);
  }
  check(slots.size <= MODEL_CAPABILITY_MAX_SLOTS, "Combined capability set exceeds resolver limit.");
  return [...slots.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, snapshot]) => snapshot);
}
