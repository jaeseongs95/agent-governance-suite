// J1 tamper matrix harness. Usage: WT=/tmp/v53 LABEL=v53 SEED=... tsx matrix.ts > out.jsonl
// Runs against the worktree's *source* modules. No product files are modified.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { tmpdir } from "node:os";

const WT = process.env.WT!;
const LABEL = process.env.LABEL ?? path.basename(WT);
const SEED = Number(process.env.SEED ?? 20260928);
const ONLY = process.env.ONLY;
const storeMod = await import(`${WT}/mcp-server/src/session-message-store.ts`);
const portMod = await import(`${WT}/mcp-server/src/session-message-wake-port.ts`);
const brokerMod = await import(`${WT}/mcp-server/src/session-message-broker.ts`);
const { SessionMessageStore } = storeMod;
const { recordWakeHookObservation, createWakeHookObservationReader } = portMod;
const { dispatchSessionMessageBrokerOperation } = brokerMod;

// deterministic PRNG (mulberry32) for nonce generation
let s = SEED >>> 0;
const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const nonceOf = (n = 32) => Array.from({ length: n }, () => ALPH[Math.floor(rnd() * 64)]).join("");

const sha = (p: string) => existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16) : null;
const size = (p: string) => existsSync(p) ? statSync(p).size : null;
function fileState(dir: string) {
  const out: Record<string, unknown> = {};
  for (const f of ["session-messages.sqlite3", "session-messages.sqlite3-wal", "session-messages.sqlite3-shm", "trust.sqlite3", "trust.sqlite3-wal", "trust.sqlite3-shm"]) {
    const p = path.join(dir, f); out[f] = existsSync(p) ? { size: size(p), sha: f.endsWith("-shm") ? "(shm)" : sha(p) } : null;
  }
  return out;
}
function dump(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      wake: db.prepare("SELECT nonce_digest, host, session_id, state, instance_id, birth_generation, transport, attempt_id, dispatch_epoch, expires_at, consumed_at, observed_at, late_observed_at FROM wake_nonces ORDER BY rowid").all(),
      msgs: db.prepare("SELECT message_id, target_session_id, claimed_at, claim_until, delivery_attempts, first_delivered_at, acknowledged_at FROM messages ORDER BY rowid").all(),
    };
  } finally { db.close(); }
}
function trustKey(trustPath: string): Buffer {
  const db = new DatabaseSync(trustPath);
  try { return Buffer.from((db.prepare("SELECT value FROM trust_metadata WHERE key='trust-signing-key'").get() as { value: string }).value, "base64url"); } finally { db.close(); }
}
function canonical(v: unknown): string { // mirrors canonicalJson for plain objects (sorted keys)
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
function rewriteReceipt(trustPath: string, receiptId: string, mut: (r: Record<string, unknown>) => void, resign: boolean) {
  const db = new DatabaseSync(trustPath);
  try {
    const row = db.prepare("SELECT receipt_json FROM input_source_receipts WHERE receipt_id=?").get(receiptId) as { receipt_json: string };
    const r = JSON.parse(row.receipt_json); mut(r);
    if (resign) {
      const key = Buffer.from((db.prepare("SELECT value FROM trust_metadata WHERE key='trust-signing-key'").get() as { value: string }).value, "base64url");
      const { integrityToken, ...unsigned } = r; void integrityToken;
      r.integrityToken = createHmac("sha256", key).update(canonical(unsigned)).digest("base64url");
    }
    db.prepare("UPDATE input_source_receipts SET receipt_json=? WHERE receipt_id=?").run(JSON.stringify(r), receiptId);
  } finally { db.close(); }
}

const CAPS = { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" };
type Ctx = { dir: string; dbPath: string; trustPath: string; target: { host: string; sessionId: string }; nonce: string; T: number; obs: any; receipt: string; store: any; other?: any };
function setup(opts: { base: "submitted" | "unknown" | "started" | "legacy"; host?: string; session?: string; T?: number; noReceipt?: boolean } ): Ctx {
  const dir = mkdtempSync(path.join(tmpdir(), `j1-${LABEL}-`));
  const dbPath = path.join(dir, "session-messages.sqlite3"); const trustPath = path.join(dir, "trust.sqlite3");
  process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = trustPath;
  const target = { host: opts.host ?? "codex", sessionId: opts.session ?? `s-${nonceOf(8)}` };
  const T = opts.T ?? Date.now();
  const nonce = nonceOf(32);
  const store = new SessionMessageStore(dbPath);
  store.startPresence({ ...target, instanceId: "inst-1", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: CAPS }, T);
  store.acquireRelay({ ...target, transport: "codex-queue", relayId: "relay-1", pid: process.pid, parentPid: process.pid }, T);
  store.send({ sender: { host: "portable", sessionId: "sender-1" }, target, messageId: `body-${target.sessionId}`, body: "hello-body" }, T);
  if (opts.base === "legacy") { store.reserveWake(target, nonce, T); }
  else {
    const r = store.reserveManagedWake({ ...target, nonce, instanceId: "inst-1", transport: "codex-queue", relayId: "relay-1" }, T);
    const st = store.startManagedWake(r.attempt, T + 1);
    if (!st.dispatch) throw new Error("setup start failed");
    if (opts.base !== "started") store.recordManagedWakeOutcome(st.attempt, opts.base === "unknown" ? "accepted-or-unknown" : "submitted", T + 2);
  }
  const obs = { host: target.host, sessionId: target.sessionId, kind: "user-input",
    actor: { kind: "main", observedBy: `${target.host}:hook-payload`, assurance: "observed" }, wakeCandidates: [nonce], wakeOnly: true };
  const receipt = opts.noReceipt ? "" : recordWakeHookObservation(obs, T + 3);
  return { dir, dbPath, trustPath, target, nonce, T, obs, receipt, store };
}

type Case = { id: string; group: string; base?: "submitted" | "unknown" | "started" | "legacy"; expect: "reject-nochange" | "accept-claim" | "retire-noclaim" | "throw-nochange" | "reject-any";
  prep?: (c: Ctx) => void; call?: (c: Ctx) => unknown; note?: string; postReserve?: boolean };
const clone = (o: any) => JSON.parse(JSON.stringify(o));
const withObs = (f: (o: any) => void) => (c: Ctx) => { const o = clone(c.obs); f(o); return c.store.claimHostWake(c.target, o, c.receipt, createWakeHookObservationReader(c.trustPath), c.T + 10); };
const hb = (c: Ctx, until: number) => { for (let t = c.T + 15_000; t <= until; t += 15_000) if (!c.store.heartbeatPresence(c.target, "inst-1", t)) throw new Error("heartbeat failed at " + t); };
const at = (dt: number | ((c: Ctx) => number)) => (c: Ctx) => c.store.claimHostWake(c.target, c.obs, c.receipt, createWakeHookObservationReader(c.trustPath), typeof dt === "function" ? dt(c) : c.T + dt);
const LONG = "A".repeat(1 << 20);

const cases: Case[] = [];
for (const base of ["unknown", "submitted", "started"] as const) {
  cases.push({ id: `control-valid-${base}`, group: "control", base, expect: "accept-claim", call: at(10) });
}
const B = "unknown" as const;
// ---- observation tampering (receipt issued for original obs) ----
const obsMut: Array<[string, (o: any) => void, Case["expect"]?]> = [
  ["obs.host=claude-code", (o) => { o.host = "claude-code"; }],
  ["obs.host missing", (o) => { delete o.host; }],
  ["obs.host=number", (o) => { o.host = 1; }],
  ["obs.host=''", (o) => { o.host = ""; }],
  ["obs.sessionId other", (o) => { o.sessionId = o.sessionId + "x"; }],
  ["obs.sessionId missing", (o) => { delete o.sessionId; }],
  ["obs.sessionId=1MB", (o) => { o.sessionId = LONG; }],
  ["obs.sessionId unicode", (o) => { o.sessionId = o.sessionId + "é"; }],
  ["obs.sessionId ctrl NUL", (o) => { o.sessionId = o.sessionId + "\u0000"; }],
  ["obs.kind=turn-end", (o) => { o.kind = "turn-end"; }],
  ["obs.kind missing", (o) => { delete o.kind; }],
  ["obs.wakeOnly=false", (o) => { o.wakeOnly = false; }],
  ["obs.wakeOnly='true'", (o) => { o.wakeOnly = "true"; }],
  ["obs.wakeOnly missing", (o) => { delete o.wakeOnly; }],
  ["obs.actor.observedBy other host", (o) => { o.actor.observedBy = "claude-code:hook-payload"; }],
  ["obs.actor.observedBy ''", (o) => { o.actor.observedBy = ""; }],
  ["obs.actor.kind=subagent", (o) => { o.actor.kind = "subagent"; }],
  ["obs.actor.kind=unknown (digest differs)", (o) => { o.actor.kind = "unknown"; }],
  ["obs.actor.assurance=unknown (digest differs)", (o) => { o.actor.assurance = "unknown"; }],
  ["obs.actor.assurance=verified", (o) => { o.actor.assurance = "verified"; }],
  ["obs.actor missing", (o) => { delete o.actor; }],
  ["obs.actor=null", (o) => { o.actor = null; }],
  ["obs.wakeCandidates other nonce", (o) => { o.wakeCandidates = [nonceOf(32)]; }],
  ["obs.wakeCandidates +extra unregistered", (o) => { o.wakeCandidates = [...o.wakeCandidates, nonceOf(32)]; }],
  ["obs.wakeCandidates missing", (o) => { delete o.wakeCandidates; }],
  ["obs.wakeCandidates []", (o) => { o.wakeCandidates = []; }],
  ["obs.wakeCandidates string", (o) => { o.wakeCandidates = o.wakeCandidates[0]; }],
  ["obs.wakeCandidates [number]", (o) => { o.wakeCandidates = [123]; }],
  ["obs.wakeCandidates ['']", (o) => { o.wakeCandidates = [""]; }],
  ["obs.wakeCandidates len129", (o) => { o.wakeCandidates = ["A".repeat(129)]; }],
  ["obs.wakeCandidates len21", (o) => { o.wakeCandidates = ["A".repeat(21)]; }],
  ["obs.wakeCandidates 11 items", (o) => { o.wakeCandidates = Array.from({ length: 11 }, () => o.wakeCandidates[0]); }],
  ["obs.wakeCandidates unicode suffix", (o) => { o.wakeCandidates = [o.wakeCandidates[0] + "é"]; }],
  ["obs.wakeCandidates ctrl \\n suffix", (o) => { o.wakeCandidates = [o.wakeCandidates[0] + "\n"]; }],
  ["obs.wakeCandidates case-flipped", (o) => { o.wakeCandidates = [o.wakeCandidates[0].replace(/[a-z]/, (m: string) => m.toUpperCase()).replace(/^[A-Z]/, (m: string) => m.toLowerCase())]; }],
  ["obs.wakeCandidates duplicate same nonce (digest set-equal)", (o) => { o.wakeCandidates = [o.wakeCandidates[0], o.wakeCandidates[0]]; }, "accept-claim"],
  ["obs extra field ignored (digest subset)", (o) => { o.extra = "x"; o.workspaceId = "/w"; }, "accept-claim"],
];
for (const [name, f, exp] of obsMut) cases.push({ id: `obs:${name}`, group: "observation", base: B, expect: exp ?? "reject-nochange", call: withObs(f) });
cases.push({ id: "obs=array [obs]", group: "observation", base: B, expect: "reject-nochange", call: (c) => c.store.claimHostWake(c.target, [c.obs], c.receipt, createWakeHookObservationReader(c.trustPath), c.T + 10) });
cases.push({ id: "obs=null", group: "observation", base: B, expect: "reject-nochange", call: (c) => c.store.claimHostWake(c.target, null, c.receipt, createWakeHookObservationReader(c.trustPath), c.T + 10) });
cases.push({ id: "obs=string", group: "observation", base: B, expect: "reject-nochange", call: (c) => c.store.claimHostWake(c.target, "x", c.receipt, createWakeHookObservationReader(c.trustPath), c.T + 10) });
cases.push({ id: "reader undefined", group: "observation", base: B, expect: "reject-nochange", call: (c) => c.store.claimHostWake(c.target, c.obs, c.receipt, undefined, c.T + 10) });
// ---- receiptId tampering ----
const rid: Array<[string, (c: Ctx) => unknown]> = [
  ["receiptId=''", () => ""], ["receiptId other uuid", () => `source-${crypto.randomUUID()}`], ["receiptId flipped last char", (c) => c.receipt.slice(0, -1) + (c.receipt.endsWith("a") ? "b" : "a")],
  ["receiptId 1MB", () => LONG], ["receiptId unicode", (c) => c.receipt + "é"], ["receiptId ctrl NUL", (c) => c.receipt + "\u0000"],
  ["receiptId SQL-ish", () => "' OR 1=1 --"], ["receiptId uppercased", (c) => c.receipt.toUpperCase()],
];
for (const [name, f] of rid) cases.push({ id: `rid:${name}`, group: "receiptId", base: B, expect: "reject-nochange", call: (c) => c.store.claimHostWake(c.target, c.obs, f(c), createWakeHookObservationReader(c.trustPath), c.T + 10) });
// broker-level type errors (payload coercion); uses real Date.now()
for (const [name, v] of [["number", 42], ["null", null], ["object", { id: 1 }], ["array", ["x"]], ["missing", undefined]] as Array<[string, unknown]>) {
  cases.push({ id: `broker:sourceReceiptId ${name}`, group: "receiptId-type", base: B, expect: "reject-nochange",
    call: (c) => dispatchSessionMessageBrokerOperation(c.store, "claim-host-wake", { target: c.target, observation: c.obs, ...(v === undefined ? {} : { sourceReceiptId: v }) }, createWakeHookObservationReader(c.trustPath)) });
}
cases.push({ id: "broker:control valid (real clock)", group: "control", base: B, expect: "accept-claim",
  call: (c) => dispatchSessionMessageBrokerOperation(c.store, "claim-host-wake", { target: c.target, observation: c.obs, sourceReceiptId: c.receipt }, createWakeHookObservationReader(c.trustPath)) });
cases.push({ id: "broker:target.host number", group: "receiptId-type", base: B, expect: "throw-nochange",
  call: (c) => dispatchSessionMessageBrokerOperation(c.store, "claim-host-wake", { target: { host: 1, sessionId: c.target.sessionId }, observation: c.obs, sourceReceiptId: c.receipt }, createWakeHookObservationReader(c.trustPath)) });
// ---- stored receipt tampering (signature / fields) ----
const recMut: Array<[string, (r: any) => void]> = [
  ["host", (r) => { r.host = "claude-code"; }], ["sessionId", (r) => { r.sessionId += "x"; }], ["contentDigest", (r) => { r.contentDigest = "sha256:" + "0".repeat(64); }],
  ["originKind=tool", (r) => { r.originKind = "tool"; }], ["authorityEffect=approve", (r) => { r.authorityEffect = "approve"; }],
  ["attestation.kind", (r) => { r.attestation.kind = "host-direct-user-event"; }], ["attestation.adapter", (r) => { r.attestation.adapter = "other"; }],
  ["attestation.capabilityVersion", (r) => { r.attestation.capabilityVersion = "1.0.1"; }],
  ["observedAt future+60s", (r) => { r.observedAt = new Date(Date.parse(r.observedAt) + 60_000).toISOString(); }],
  ["expiresAt past", (r) => { r.expiresAt = new Date(Date.parse(r.observedAt) - 1).toISOString(); }],
  ["expiresAt invalid string", (r) => { r.expiresAt = "not-a-date"; }],
  ["observedAt invalid string", (r) => { r.observedAt = "not-a-date"; }],
  ["receiptId inside json", (r) => { r.receiptId = "source-other"; }],
];
for (const [name, f] of recMut.filter(([n]) => n !== "receiptId inside json")) {
  cases.push({ id: `rec-nosign:${name}`, group: "receipt-unsigned-tamper", base: B, expect: "reject-nochange", prep: (c) => rewriteReceipt(c.trustPath, c.receipt, f, false), call: at(10) });
  cases.push({ id: `rec-resign:${name}`, group: "receipt-resigned-tamper", base: B, expect: "reject-nochange", prep: (c) => rewriteReceipt(c.trustPath, c.receipt, f, true), call: at(10) });
}
cases.push({ id: "rec-resign:expiresAt extended +1h (key holder)", group: "receipt-resigned-tamper", base: B, expect: "accept-claim",
  note: "key holder can extend TTL; documented limit (same OS user)", prep: (c) => { hb(c, c.T + 3_000_000); rewriteReceipt(c.trustPath, c.receipt, (r) => { r.expiresAt = new Date(Date.parse(r.expiresAt) + 3600_000).toISOString(); }, true); }, call: at(3_000_000) });
cases.push({ id: "rec-nosign:receiptId inside json", group: "receipt-unsigned-tamper", base: B, expect: "reject-nochange", prep: (c) => rewriteReceipt(c.trustPath, c.receipt, (r) => { r.receiptId = "source-other"; }, false), call: at(10) });
cases.push({ id: "rec-resign:receiptId inside json (key holder)", group: "receipt-resigned-tamper", base: B, expect: "accept-claim", note: "INFO: JSON receiptId not compared with lookup id; needs signing key", prep: (c) => rewriteReceipt(c.trustPath, c.receipt, (r) => { r.receiptId = "source-other"; }, true), call: at(10) });
cases.push({ id: "rec-nosign:integrityToken flipped", group: "receipt-unsigned-tamper", base: B, expect: "reject-nochange", prep: (c) => rewriteReceipt(c.trustPath, c.receipt, (r) => { r.integrityToken = (r.integrityToken[0] === "A" ? "B" : "A") + r.integrityToken.slice(1); }, false), call: at(10) });
cases.push({ id: "rec-nosign:integrityToken missing", group: "receipt-unsigned-tamper", base: B, expect: "reject-nochange", prep: (c) => rewriteReceipt(c.trustPath, c.receipt, (r) => { delete r.integrityToken; }, false), call: at(10) });
cases.push({ id: "rec-nosign:integrityToken number", group: "receipt-unsigned-tamper", base: B, expect: "reject-nochange", prep: (c) => rewriteReceipt(c.trustPath, c.receipt, (r) => { r.integrityToken = 7; }, false), call: at(10) });
cases.push({ id: "rec-nosign:integrityToken truncated", group: "receipt-unsigned-tamper", base: B, expect: "reject-nochange", prep: (c) => rewriteReceipt(c.trustPath, c.receipt, (r) => { r.integrityToken = r.integrityToken.slice(0, 20); }, false), call: at(10) });
cases.push({ id: "rec:receipt_json corrupt (not JSON)", group: "receipt-unsigned-tamper", base: B, expect: "throw-nochange", prep: (c) => { const db = new DatabaseSync(c.trustPath); db.prepare("UPDATE input_source_receipts SET receipt_json='{bad' WHERE receipt_id=?").run(c.receipt); db.close(); }, call: at(10) });
// ---- TTL boundaries (receipt: observedAt=T+3, expiresAt=T+3+30000) ----
cases.push({ id: "ttl:now=observedAt-1ms", group: "ttl", base: B, expect: "reject-nochange", call: at(2) });
cases.push({ id: "ttl:now=observedAt exact", group: "ttl", base: B, expect: "accept-claim", call: at(3) });
cases.push({ id: "ttl:now=expiresAt-1ms (presence heartbeated)", group: "ttl", base: B, expect: "accept-claim", prep: (c) => hb(c, c.T + 30_002), call: at(3 + 30_000 - 1) });
cases.push({ id: "ttl:now=expiresAt-1ms (presence lease lapsed)", group: "ttl", base: B, expect: "retire-noclaim", note: "receipt verified (row changed) but presence lease 20s < receipt TTL 30s -> retire", call: at(3 + 30_000 - 1) });
cases.push({ id: "ttl:now=expiresAt exact (presence heartbeated)", group: "ttl", base: B, expect: "reject-nochange", prep: (c) => hb(c, c.T + 30_003), call: at(3 + 30_000) });
cases.push({ id: "ttl:now=expiresAt exact", group: "ttl", base: B, expect: "reject-nochange", call: at(3 + 30_000) });
cases.push({ id: "ttl:now=expiresAt+1ms", group: "ttl", base: B, expect: "reject-nochange", call: at(3 + 30_000 + 1) });
cases.push({ id: "ttl:receipt issued in future (+60s) used now", group: "ttl", base: B, expect: "reject-nochange",
  prep: (c) => { c.receipt = recordWakeHookObservation(c.obs, c.T + 60_000); }, call: at(10) });
// wake row TTL (WAKE_TTL_MS=1h). Receipt re-issued near the boundary so only row expiry varies.
const WTTL = 60 * 60_000;
for (const [name, dt, exp] of [["row expires_at-1ms", WTTL - 1, "accept-claim"], ["row expires_at exact", WTTL, "retire-noclaim"], ["row expires_at+1ms", WTTL + 1, "retire-noclaim"]] as Array<[string, number, Case["expect"]]>) {
  cases.push({ id: `rowttl:${name}`, group: "row-ttl", base: B, expect: exp, note: "53eff30a: verified arrival on expired row retires it (documented)",
    prep: (c) => { hb(c, c.T + dt); c.receipt = recordWakeHookObservation(c.obs, c.T + dt - 5); }, call: at(dt) });
}
// ---- replay / cross-target ----
cases.push({ id: "replay:same receipt twice", group: "replay", base: B, expect: "reject-nochange", prep: (c) => { const r = at(10)(c) as any; if (!r.recognized) throw new Error("first claim not recognized"); }, call: at(11), note: "first call accepted in prep; measured second" });
cases.push({ id: "replay:receipt of target A with target B obs", group: "replay", base: B, expect: "reject-nochange",
  prep: (c) => { // create a second target B in same DB with its own active wake; use A's receipt on B
    const tB = { host: "codex", sessionId: c.target.sessionId + "-B" }; const nB = nonceOf(32);
    c.store.startPresence({ ...tB, instanceId: "inst-1", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: CAPS }, c.T);
    c.store.acquireRelay({ ...tB, transport: "codex-queue", relayId: "relay-1", pid: process.pid, parentPid: process.pid }, c.T);
    c.store.send({ sender: { host: "portable", sessionId: "sender-1" }, target: tB, messageId: `body-${tB.sessionId}`, body: "b" }, c.T);
    const r = c.store.reserveManagedWake({ ...tB, nonce: nB, instanceId: "inst-1", transport: "codex-queue", relayId: "relay-1" }, c.T);
    const st = c.store.startManagedWake(r.attempt, c.T + 1); c.store.recordManagedWakeOutcome(st.attempt, "accepted-or-unknown", c.T + 2);
    c.other = { target: tB, obs: { ...clone(c.obs), sessionId: tB.sessionId, wakeCandidates: [nB] } };
  },
  call: (c) => c.store.claimHostWake(c.other.target, c.other.obs, c.receipt, createWakeHookObservationReader(c.trustPath), c.T + 10) });
cases.push({ id: "replay:A's nonce + A's receipt presented for target B", group: "replay", base: B, expect: "reject-nochange",
  call: (c) => { const tB = { host: "codex", sessionId: c.target.sessionId + "-B" }; return c.store.claimHostWake(tB, { ...clone(c.obs), sessionId: tB.sessionId }, c.receipt, createWakeHookObservationReader(c.trustPath), c.T + 10); } });
cases.push({ id: "replay:A obs+receipt, target arg B (target/obs mismatch)", group: "replay", base: B, expect: "reject-nochange",
  call: (c) => c.store.claimHostWake({ host: "codex", sessionId: c.target.sessionId + "-B" }, c.obs, c.receipt, createWakeHookObservationReader(c.trustPath), c.T + 10) });
cases.push({ id: "replay:receipt from a different trust DB (other key)", group: "replay", base: B, expect: "reject-nochange",
  prep: (c) => { const d2 = mkdtempSync(path.join(tmpdir(), "j1-otherkey-")); process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = path.join(d2, "trust.sqlite3");
    c.receipt = recordWakeHookObservation(c.obs, c.T + 3); process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = c.trustPath; }, call: at(10) });
// ---- key / trust DB ----
cases.push({ id: "key:trust DB missing", group: "key", base: B, expect: "reject-nochange", prep: (c) => { for (const x of ["", "-wal", "-shm"]) rmSync(c.trustPath + x, { force: true }); }, call: at(10) });
cases.push({ id: "key:trust signing key row deleted", group: "key", base: B, expect: "reject-nochange", prep: (c) => { const db = new DatabaseSync(c.trustPath); db.exec("DELETE FROM trust_metadata WHERE key='trust-signing-key'"); db.close(); }, call: at(10) });
cases.push({ id: "key:different 32B key", group: "key", base: B, expect: "reject-nochange", prep: (c) => { const db = new DatabaseSync(c.trustPath); db.prepare("UPDATE trust_metadata SET value=? WHERE key='trust-signing-key'").run(randomBytes(32).toString("base64url")); db.close(); }, call: at(10) });
cases.push({ id: "key:corrupt key (16B)", group: "key", base: B, expect: "throw-nochange", prep: (c) => { const db = new DatabaseSync(c.trustPath); db.prepare("UPDATE trust_metadata SET value=? WHERE key='trust-signing-key'").run(randomBytes(16).toString("base64url")); db.close(); }, call: at(10) });
cases.push({ id: "key:corrupt key (non-base64 text)", group: "key", base: B, expect: "throw-nochange", prep: (c) => { const db = new DatabaseSync(c.trustPath); db.prepare("UPDATE trust_metadata SET value=? WHERE key='trust-signing-key'").run("!!!!"); db.close(); }, call: at(10) });
cases.push({ id: "key:trust DB file garbage", group: "key", base: B, expect: "throw-nochange", prep: (c) => { for (const x of ["-wal", "-shm"]) rmSync(c.trustPath + x, { force: true }); writeFileSync(c.trustPath, randomBytes(8192)); }, call: at(10) });
cases.push({ id: "key:trust DB zero-length", group: "key", base: B, expect: "reject-nochange", prep: (c) => { for (const x of ["-wal", "-shm"]) rmSync(c.trustPath + x, { force: true }); writeFileSync(c.trustPath, ""); }, call: at(10) });
cases.push({ id: "key:trust DB newer schema (user_version 999)", group: "key", base: B, expect: "throw-nochange", prep: (c) => { const db = new DatabaseSync(c.trustPath); db.exec("PRAGMA user_version=999"); db.close(); }, call: at(10) });
cases.push({ id: "key:trust DB file read-only (0400)", group: "key", base: B, expect: "reject-any", prep: (c) => { const db = new DatabaseSync(c.trustPath); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close(); chmodSync(c.trustPath, 0o400); }, call: at(10), note: "root in container may bypass perms" });
// ---- binding / generation (valid receipt, non-current row) ----
const newPresence = (c: Ctx, inst: string, transport = "codex-queue", caps: any = CAPS, dt = 5) => c.store.startPresence({ ...c.target, instanceId: inst, transport, wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: caps }, c.T + dt);
cases.push({ id: "gen:new instance (new generation)", group: "generation", base: B, expect: "retire-noclaim", prep: (c) => newPresence(c, "inst-2"), call: at(10) });
cases.push({ id: "gen:same instance restarted (new birth_generation)", group: "generation", base: B, expect: "retire-noclaim", prep: (c) => newPresence(c, "inst-1b"), call: at(10) });
cases.push({ id: "gen:transport differs (codex-deferred)", group: "generation", base: B, expect: "retire-noclaim", prep: (c) => newPresence(c, "inst-3", "codex-deferred", { supportedInjection: ["tool-boundary"], idleWake: "none" }), call: at(10) });
cases.push({ id: "gen:presence lease lapsed (unreachable, same gen)", group: "generation", base: B, expect: "retire-noclaim", note: "same-generation marker retired only because lease lapsed", prep: (c) => { c.receipt = recordWakeHookObservation(c.obs, c.T + 25_000); }, call: at(25_010) });
cases.push({ id: "gen:presence ended (same gen)", group: "generation", base: B, expect: "retire-noclaim", prep: (c) => { const db = new DatabaseSync(c.dbPath); db.prepare("UPDATE session_presence SET ended_at=?, end_reason='test' WHERE session_id=?").run(new Date(c.T + 4).toISOString(), c.target.sessionId); db.close(); }, call: at(10) });
cases.push({ id: "gen:no presence row", group: "generation", base: B, expect: "retire-noclaim", prep: (c) => { const db = new DatabaseSync(c.dbPath); db.prepare("DELETE FROM session_presence WHERE session_id=?").run(c.target.sessionId); db.close(); }, call: at(10) });
// ---- mixed candidates ----
const addRow = (c: Ctx, state: string, extra: Record<string, unknown> = {}) => { const n = nonceOf(32); const db = new DatabaseSync(c.dbPath);
  const d = createHash("sha256").update(n).digest("hex");
  const row = { nonce_digest: d, host: c.target.host, session_id: c.target.sessionId, expires_at: new Date(c.T + WTTL).toISOString(), consumed_at: null, state, ...extra };
  const cols = Object.keys(row); db.prepare(`INSERT INTO wake_nonces (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...(Object.values(row) as any[])); db.close(); return n; };
const nd = (n: string) => createHash("sha256").update(n).digest("hex");
function mixed(id: string, mk: (c: Ctx) => string, exp: Case["expect"], note?: string) {
  cases.push({ id: `mixed:${id}`, group: "mixed", base: B, expect: exp, note, prep: (c) => { const n2 = mk(c); c.obs = { ...c.obs, wakeCandidates: [c.nonce, n2] }; c.receipt = recordWakeHookObservation(c.obs, c.T + 3); }, call: at(10) });
}
mixed("current + unregistered", () => nonceOf(32), "reject-nochange");
mixed("current + legacy fresh", (c) => addRow(c, "legacy"), "accept-claim", "legacy fresh + current: both consumed");
mixed("current + legacy already consumed", (c) => addRow(c, "legacy", { consumed_at: new Date(c.T).toISOString() }), "reject-any", "legacy replay companion");
mixed("current + legacy expired", (c) => addRow(c, "legacy", { expires_at: new Date(c.T).toISOString() }), "reject-any");
mixed("current + already observed row", (c) => addRow(c, "observed"), "reject-nochange");
mixed("current + not-submitted row", (c) => addRow(c, "not-submitted"), "reject-nochange");
mixed("current + other session's nonce", (c) => { const n = nonceOf(32); const db = new DatabaseSync(c.dbPath); db.prepare("INSERT INTO wake_nonces (nonce_digest,host,session_id,expires_at,state) VALUES (?,?,?,?,'legacy')").run(nd(n), "codex", "other-session", new Date(c.T + WTTL).toISOString()); db.close(); return n; }, "reject-nochange");
// ---- legacy base ----
cases.push({ id: "legacy:valid legacy marker", group: "legacy", base: "legacy", expect: "reject-any", call: at(10), note: "legacy: recognized, messages claimed, binding null (managed=false)" });

type Res = Record<string, unknown>;
const results: Res[] = [];
for (const k of cases) {
  if (ONLY && !k.id.includes(ONLY)) continue;
  let c: Ctx | undefined; const rec: Res = { label: LABEL, seed: SEED, id: k.id, group: k.group, base: k.base, expect: k.expect, note: k.note };
  try {
    c = setup({ base: k.base ?? "unknown" });
    if (k.prep) k.prep(c);
    // flush WAL so body bytes comparisons are meaningful
    const before = dump(c.dbPath); const fb = fileState(c.dir); const trustExisted = existsSync(c.trustPath);
    let out: any; let err: string | null = null;
    try { out = k.call!(c); } catch (e: any) { err = `${e?.code ?? e?.name ?? "Error"}: ${String(e?.message ?? e).slice(0, 200)}`; }
    const after = dump(c.dbPath); const fa = fileState(c.dir);
    const wakeChanged = JSON.stringify(before.wake) !== JSON.stringify(after.wake);
    const msgChanged = JSON.stringify(before.msgs) !== JSON.stringify(after.msgs);
    const newRows = after.wake.length - before.wake.length;
    const claimed = after.msgs.filter((m: any, i: number) => m.claimed_at !== (before.msgs[i] as any)?.claimed_at).length;
    const mainRowAfter = after.wake.find((r: any) => r.nonce_digest === nd(c!.nonce)) as any;
    // post-check: can a new managed wake be reserved? (i.e. did the active row get released)
    let postReserve: unknown = null;
    try { postReserve = c.store.reserveManagedWake({ ...c.target, nonce: nonceOf(32), instanceId: c.store.presence(c.target, c.T + 20).instanceId ?? "inst-1", transport: "codex-queue", relayId: "relay-1" }, c.T + 20).dispatch; } catch (e: any) { postReserve = `throw:${e.message}`; }
    Object.assign(rec, {
      recognized: out?.recognized ?? null, managed: out ? (out.managed ?? (out.binding !== undefined ? out.binding !== null : null)) : null,
      messagesReturned: Array.isArray(out?.messages) ? out.messages.length : null, error: err,
      wakeChanged, msgChanged, newWakeRows: newRows, newClaims: claimed,
      mainRowBefore: (before.wake.find((r: any) => r.nonce_digest === nd(c!.nonce)) as any)?.state ?? null,
      mainRowAfter: mainRowAfter?.state ?? null, lateObservedSet: mainRowAfter?.late_observed_at != null,
      sessionDbMainChanged: (fb as any)["session-messages.sqlite3"]?.sha !== (fa as any)["session-messages.sqlite3"]?.sha,
      sessionWalChanged: JSON.stringify((fb as any)["session-messages.sqlite3-wal"]) !== JSON.stringify((fa as any)["session-messages.sqlite3-wal"]),
      trustExistedBefore: trustExisted, trustExistsAfter: existsSync(c.trustPath),
      trustMainChanged: (fb as any)["trust.sqlite3"]?.sha !== (fa as any)["trust.sqlite3"]?.sha,
      trustWalBefore: (fb as any)["trust.sqlite3-wal"]?.size ?? null, trustWalAfter: (fa as any)["trust.sqlite3-wal"]?.size ?? null,
      postReserveDispatch: postReserve,
    });
    const rowDiff = { before: before.wake, after: after.wake, msgsBefore: before.msgs, msgsAfter: after.msgs };
    // verdict
    const noState = !wakeChanged && !msgChanged && newRows === 0;
    let verdict = "UNKNOWN";
    if (k.expect === "reject-nochange") verdict = !out?.recognized && !err && noState && !out?.messages?.length ? "PASS" : (err && noState ? "PASS(throw)" : "FAIL");
    else if (k.expect === "throw-nochange") verdict = (err || !out?.recognized) && noState ? "PASS" : "FAIL";
    else if (k.expect === "accept-claim") verdict = out?.recognized && claimed >= 1 && mainRowAfter?.state === "observed" && newRows === 0 ? "PASS" : "FAIL";
    else if (k.expect === "retire-noclaim") verdict = !out?.recognized && !err && claimed === 0 && !msgChanged && newRows === 0 ? "PASS" : "FAIL";
    else if (k.expect === "reject-any") verdict = claimed === 0 && newRows === 0 ? "PASS" : "OBSERVE";
    rec.verdict = verdict; if (verdict !== "PASS") rec.rowDiff = rowDiff;
    if (k.id.startsWith("mixed:") || k.id.startsWith("gen:") || k.id.startsWith("legacy:") || k.id.startsWith("rowttl:")) rec.rowDiff = rowDiff;
  } catch (e: any) { rec.verdict = "UNKNOWN"; rec.harnessError = String(e?.stack ?? e).slice(0, 500); }
  finally { try { c?.store.close(); } catch { /* */ } }
  results.push(rec); process.stdout.write(JSON.stringify(rec) + "\n");
}
