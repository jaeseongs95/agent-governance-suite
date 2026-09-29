// Bundled Codex UserPromptSubmit hook vs real (bundled) broker: only verified empty current managed wakes may block.
import { spawn, spawnSync } from "node:child_process"; import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import path from "node:path"; import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const WT = process.env.WT!; const SEED = Number(process.env.SEED ?? 7);
const { SessionMessageStore } = await import(`${WT}/mcp-server/src/session-message-store.ts`);
const { waitForSessionMessageBrokerReady } = await import(`${WT}/mcp-server/src/session-message-client.ts`);
const { handleSessionMessageHook } = await import(`${WT}/mcp-server/src/session-message-hook.ts`);
const D = mkdtempSync(path.join(tmpdir(), "j1-hook-")); const dbPath = path.join(D, "session-messages.sqlite3");
process.env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR = D; process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = path.join(D, "trust.sqlite3"); process.env.AGENT_GOVERNANCE_CODEX_QUEUE_WAKE = "1";
const broker = spawn(process.execPath, [`${WT}/mcp-server/dist/session-message-broker.mjs`, "--state-directory", D], { stdio: "ignore", env: process.env });
await waitForSessionMessageBrokerReady(D, broker, 10_000);
let s = SEED >>> 0; const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"; const nonceOf = () => Array.from({ length: 32 }, () => A[Math.floor(rnd() * 64)]).join("");
const CAPS = { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" };
const M = (n: string) => `[agent-governance-suite:wake:${n}]`;
let k = 0;
function setup(opts: { host?: string; body?: "empty" | "pending"; late?: boolean; state?: "submitted" | "unknown" } = {}) {
  const target = { host: opts.host ?? "codex", sessionId: `hb-${SEED}-${k++}` }; const nonce = nonceOf(); const now = Date.now();
  const st = new SessionMessageStore(dbPath);
  try {
    st.startPresence({ ...target, instanceId: "i1", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: CAPS }, now);
    st.acquireRelay({ ...target, transport: "codex-queue", relayId: "r1", pid: process.pid, parentPid: process.pid }, now);
    const mid = `hbody-${target.sessionId}`; st.send({ sender: { host: "portable", sessionId: "hb-sender" }, target, messageId: mid, body: `body-${target.sessionId}` }, now);
    const r = st.reserveManagedWake({ ...target, nonce, instanceId: "i1", transport: "codex-queue", relayId: "r1" }, now);
    const a = st.startManagedWake(r.attempt, now + 1); st.recordManagedWakeOutcome(a.attempt, opts.state === "unknown" ? "accepted-or-unknown" : "submitted", now + 2);
    if ((opts.body ?? "empty") === "empty") { st.observeNativeInput(target, now + 3); st.claimDeferred(target, now + 4); st.claimDeferred(target, now + 5); st.acknowledge(target, [mid], now + 6); }
    if (opts.late) st.startPresence({ ...target, instanceId: "i2", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: CAPS }, now + 7);
  } finally { st.close(); }
  return { target, nonce };
}
function state(target: any) { const d = new DatabaseSync(dbPath, { readOnly: true }); try {
  return { wake: d.prepare("SELECT state, late_observed_at IS NOT NULL AS late FROM wake_nonces WHERE session_id=?").all(target.sessionId).map((r: any) => `${r.state}${r.late ? "(late)" : ""}`).join(","),
    pendingClaims: (d.prepare("SELECT count(*) n FROM messages WHERE target_session_id=? AND claimed_at IS NOT NULL").get(target.sessionId) as any).n,
    allWake: (d.prepare("SELECT count(*) n FROM wake_nonces").get() as any).n }; } finally { d.close(); } }
function codexHook(input: any) { const c = spawnSync(process.execPath, [`${WT}/mcp-server/dist/session-message-hook.mjs`], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", timeout: 15_000, env: process.env });
  return { status: c.status, out: c.stdout ? (() => { try { return JSON.parse(c.stdout); } catch { return { raw: c.stdout }; } })() : {}, stderr: c.stderr.slice(0, 200) }; }
type V = { id: string; expectBlock: boolean; opts?: any; prompt: (n: string, ctx: any) => unknown; extra?: any; host?: "claude-code"; pre?: (ctx: any) => void };
const V: V[] = [
  { id: "exact marker (control)", expectBlock: true, prompt: (n) => M(n) },
  { id: "exact marker, unknown state", expectBlock: true, opts: { state: "unknown" }, prompt: (n) => M(n) },
  { id: "marker + trailing \\n", expectBlock: true, prompt: (n) => M(n) + "\n" },
  { id: "marker + CRLF + marker (same)", expectBlock: true, prompt: (n) => M(n) + "\r\n" + M(n) },
  { id: "leading/trailing spaces", expectBlock: true, prompt: (n) => "   " + M(n) + "   " },
  { id: "marker + \\t", expectBlock: true, prompt: (n) => M(n) + "\t" },
  { id: "marker + NBSP (U+00A0, trimmed by JS)", expectBlock: true, prompt: (n) => M(n) + " " },
  { id: "BOM + marker (U+FEFF, trimmed by JS)", expectBlock: true, prompt: (n) => "﻿" + M(n) },
  { id: "marker + U+2028 (line sep, trimmed)", expectBlock: true, prompt: (n) => M(n) + " " },
  { id: "marker + ZWSP U+200B", expectBlock: false, prompt: (n) => M(n) + "​" },
  { id: "marker + NUL", expectBlock: false, prompt: (n) => M(n) + "\u0000" },
  { id: "marker + ESC[0m", expectBlock: false, prompt: (n) => M(n) + "\u001b[0m" },
  { id: "marker + lone CR + text", expectBlock: false, prompt: (n) => M(n) + "\rtext" },
  { id: "marker + \\n + user text (mixed)", expectBlock: false, prompt: (n) => M(n) + "\nactual user request" },
  { id: "marker with extra ']'", expectBlock: false, prompt: (n) => M(n) + "]" },
  { id: "uppercase prefix", expectBlock: false, prompt: (n) => M(n).replace("agent-governance-suite", "AGENT-GOVERNANCE-SUITE") },
  { id: "fullwidth brackets", expectBlock: false, prompt: (n) => "［" + M(n).slice(1, -1) + "］" },
  { id: "lookalike prefix (Cyrillic a)", expectBlock: false, prompt: (n) => M(n).replace("agent", "аgent") },
  { id: "unregistered nonce", expectBlock: false, prompt: () => M(nonceOf()) },
  { id: "other session's registered marker", expectBlock: false, prompt: (_n, ctx) => M(ctx.other.nonce), pre: (ctx) => { ctx.other = setup(); } },
  { id: "empty prompt", expectBlock: false, prompt: () => "" },
  { id: "whitespace-only prompt", expectBlock: false, prompt: () => "   \n \t " },
  { id: "prompt number", expectBlock: false, prompt: () => 42 },
  { id: "prompt missing", expectBlock: false, prompt: () => undefined },
  { id: "subagent (agent_id set)", expectBlock: false, prompt: (n) => M(n), extra: { agent_id: "sub-1" } },
  { id: "hook_event_name=Stop", expectBlock: false, prompt: (n) => M(n), extra: { hook_event_name: "Stop" } },
  { id: "old generation marker (late)", expectBlock: false, opts: { late: true }, prompt: (n) => M(n) },
  { id: "pending body (not empty) -> deliver", expectBlock: false, opts: { body: "pending" }, prompt: (n) => M(n) },
  { id: "duplicate: second delivery of same marker", expectBlock: false, prompt: (n) => M(n), pre: (ctx) => { ctx.first = codexHook({ hook_event_name: "UserPromptSubmit", session_id: ctx.target.sessionId, agent_id: "", prompt: M(ctx.nonce) }); } },
  { id: "claude-code host same state", expectBlock: false, host: "claude-code", opts: { host: "claude-code" }, prompt: (n) => M(n) },
  { id: "malformed stdin JSON", expectBlock: false, prompt: () => null, extra: { __raw: "{not json" } },
];
for (const v of V) {
  const ctx: any = setup(v.opts); if (v.pre) v.pre(ctx);
  const before = state(ctx.target); const otherBefore = ctx.other ? state(ctx.other.target) : null;
  const p = v.prompt(ctx.nonce, ctx);
  const input: any = { hook_event_name: "UserPromptSubmit", session_id: ctx.target.sessionId, agent_id: "", ...(p === undefined ? {} : { prompt: p }), ...(v.extra ?? {}) };
  let res: any;
  if (v.host === "claude-code") res = { status: 0, out: await handleSessionMessageHook(input, "claude-code").catch((e: any) => ({ error: e.message })) };
  else res = codexHook(v.extra?.__raw ?? input);
  const after = state(ctx.target); const otherAfter = ctx.other ? state(ctx.other.target) : null;
  const blocked = res.out?.decision === "block";
  const verdict = blocked === v.expectBlock && (!ctx.other || JSON.stringify(otherBefore) === JSON.stringify(otherAfter)) ? "PASS" : "FAIL";
  console.log(JSON.stringify({ seed: SEED, id: v.id, expectBlock: v.expectBlock, blocked, verdict, status: res.status, output: JSON.stringify(res.out).slice(0, 160), before, after, other: ctx.other ? { before: otherBefore, after: otherAfter } : undefined, first: ctx.first?.out }));
}
broker.kill("SIGTERM");
