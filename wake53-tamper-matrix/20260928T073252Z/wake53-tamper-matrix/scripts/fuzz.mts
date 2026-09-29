// Seeded random multi-mutation fuzz. Invariants:
//  I1: any wake row change  => reader verifies (target, obs, receipt, now) AND every candidate is a registered row of target
//  I2: any message claim    => recognized && binding current (presence online, same instance/gen/transport, row not expired)
//  I3: recognized=false     => no message claim, no new wake rows
import { createHash } from "node:crypto"; import { mkdtempSync } from "node:fs"; import { DatabaseSync } from "node:sqlite"; import path from "node:path"; import { tmpdir } from "node:os";
const WT = process.env.WT!; const SEED = Number(process.env.SEED ?? 1); const N = Number(process.env.N ?? 300);
const { SessionMessageStore } = await import(`${WT}/mcp-server/src/session-message-store.ts`);
const { recordWakeHookObservation, createWakeHookObservationReader } = await import(`${WT}/mcp-server/src/session-message-wake-port.ts`);
let s = SEED >>> 0; const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]; const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const nonceOf = () => Array.from({ length: 32 }, () => A[Math.floor(rnd() * 64)]).join(""); const nd = (n: string) => createHash("sha256").update(n).digest("hex");
const CAPS = { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" };
const muts: Array<[string, (c: any) => void]> = [
  ["obs.host", (c) => { c.obs.host = pick(["claude-code", "", "codex "]); }], ["obs.session", (c) => { c.obs.sessionId += pick(["x", "\u0000", "é"]); }],
  ["obs.kind", (c) => { c.obs.kind = pick(["turn-end", "tool-boundary"]); }], ["obs.wakeOnly", (c) => { c.obs.wakeOnly = pick([false, "true", 1]); }],
  ["obs.actor.kind", (c) => { c.obs.actor.kind = pick(["subagent", "unknown"]); }], ["obs.assurance", (c) => { c.obs.actor.assurance = pick(["unknown", "verified"]); }],
  ["cand.add-unreg", (c) => { c.obs.wakeCandidates.push(nonceOf()); }], ["cand.replace", (c) => { c.obs.wakeCandidates = [nonceOf()]; }],
  ["cand.dup", (c) => { c.obs.wakeCandidates.push(c.obs.wakeCandidates[0]); }], ["cand.add-B", (c) => { c.obs.wakeCandidates.push(c.nonceB); }],
  ["receipt.other-target", (c) => { c.receipt = c.receiptB; }], ["receipt.garbage", (c) => { c.receipt = "source-" + nonceOf(); }],
  ["reissue-after-mut", (c) => { process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = c.tp; try { c.receipt = recordWakeHookObservation(c.obs, c.T + 3); } catch { /* invalid obs */ } }],
  ["now.shift", (c) => { c.now = c.T + pick([2, 3, 29_999, 30_003, 30_004, 20_010, -5]); }],
  ["gen.new", (c) => { c.store.startPresence({ ...c.target, instanceId: "inst-2", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: CAPS }, c.T + 4); }],
  ["presence.end", (c) => { c.store.endPresence(c.target, "fuzz", "inst-1", c.T + 4); }],
  ["row.expire", (c) => { const d = new DatabaseSync(c.dbPath); d.prepare("UPDATE wake_nonces SET expires_at=? WHERE nonce_digest=?").run(new Date(c.T + 5).toISOString(), nd(c.nonce)); d.close(); }],
];
let viol = 0; const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const dir = mkdtempSync(path.join(tmpdir(), "j1-fz-")); const dbPath = path.join(dir, "s.sqlite3"); const tp = path.join(dir, "trust.sqlite3");
  process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = tp; const T = Date.now(); const store = new SessionMessageStore(dbPath);
  const mk = (sid: string) => { const target = { host: "codex", sessionId: sid }; const nonce = nonceOf();
    store.startPresence({ ...target, instanceId: "inst-1", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: CAPS }, T);
    store.acquireRelay({ ...target, transport: "codex-queue", relayId: "relay-1", pid: process.pid, parentPid: process.pid }, T);
    store.send({ sender: { host: "p", sessionId: "snd" }, target, messageId: `msg-fuzz-${sid}`, body: "b" }, T);
    const r = store.reserveManagedWake({ ...target, nonce, instanceId: "inst-1", transport: "codex-queue", relayId: "relay-1" }, T);
    const st = store.startManagedWake(r.attempt, T + 1); const base = pick(["started", "submitted", "unknown"]);
    if (base !== "started") store.recordManagedWakeOutcome(st.attempt, base === "unknown" ? "accepted-or-unknown" : "submitted", T + 2);
    const obs = { host: "codex", sessionId: sid, kind: "user-input", actor: { kind: "main", observedBy: "codex:hook-payload", assurance: "observed" }, wakeCandidates: [nonce], wakeOnly: true };
    return { target, nonce, obs, receipt: recordWakeHookObservation(obs, T + 3), base }; };
  const a = mk("A" + i), b = mk("B" + i);
  const c: any = { ...a, dir, dbPath, tp, T, store, now: T + 10, nonceB: b.nonce, receiptB: b.receipt };
  const k = 1 + Math.floor(rnd() * 3); const applied: string[] = [];
  for (let j = 0; j < k; j++) { const [n, f] = pick(muts); applied.push(n); try { f(c); } catch (e: any) { applied.push("!" + n + ":" + e.message); } }
  const dumpAll = () => { const d = new DatabaseSync(dbPath, { readOnly: true }); try { return { w: d.prepare("SELECT * FROM wake_nonces ORDER BY rowid").all(), m: d.prepare("SELECT * FROM messages ORDER BY rowid").all() }; } finally { d.close(); } };
  const before = dumpAll(); const reader = createWakeHookObservationReader(tp);
  let verifies = false; try { verifies = reader.verifyObservation(c.target, c.obs, c.receipt, c.now); } catch { verifies = false; }
  const regs = Array.isArray(c.obs.wakeCandidates) && c.obs.wakeCandidates.every((n: any) => typeof n === "string" && (before.w as any[]).some((r) => r.nonce_digest === nd(n) && r.session_id === c.target.sessionId && ["started","submitted","unknown"].includes(r.state)));
  const pres = store.presence(c.target, c.now); const row = (before.w as any[]).find((r) => r.nonce_digest === nd(c.nonce));
  const current = pres.state === "online" && row && row.instance_id === pres.instanceId && row.birth_generation === pres.startedAt && row.expires_at > new Date(c.now).toISOString();
  let out: any, err: string | null = null; try { out = store.claimHostWake(c.target, c.obs, c.receipt, reader, c.now); } catch (e: any) { err = e.message; }
  const after = dumpAll();
  const wakeChanged = JSON.stringify(before.w) !== JSON.stringify(after.w); const claims = (after.m as any[]).filter((m, x) => m.claimed_at !== (before.m[x] as any).claimed_at).length;
  const v: string[] = [];
  if (wakeChanged && !(verifies && regs)) v.push("I1");
  if (claims > 0 && !(out?.recognized && current)) v.push("I2");
  if (!out?.recognized && (claims > 0 || after.w.length !== before.w.length)) v.push("I3");
  const rec = { i, seed: SEED, base: c.base, applied, verifies, regs, current: !!current, recognized: out?.recognized ?? null, claims, wakeChanged, err, violations: v };
  if (v.length) { viol++; (rec as any).dump = { before, after }; }
  process.stdout.write(JSON.stringify(rec) + "\n"); store.close();
}
process.stderr.write(`SEED=${SEED} N=${N} violations=${viol} ms=${Date.now() - t0}\n`);
