// E3/E4: concurrent receiver claims (CLI, Claude Stop hook, Codex PostToolUse hook), lease expiry under a
// broker time fixture, and ACK rules. usage: node e3-claim-ack.mjs <seed>
import { Mcp, envFor, cliAsync, hookAsync, dump, rng, sleep, ROOT, brokerRaw } from "./lib.mjs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
const seed = Number(process.argv[2] ?? 1); const tag = ROOT.split("/").pop();
const base = `/tmp/exp/e3-${seed}-${tag}`; rmSync(base, { recursive: true, force: true }); mkdirSync(base + "/home", { recursive: true });
const state = base + "/state", clock = base + "/clock";
const env = { ...envFor(state, base + "/home"), NODE_OPTIONS: "--import /tmp/ev/scripts/fakeclock.mjs", FAKE_CLOCK_FILE: clock };
let now = Date.now(); const setClock = (ms) => { now = ms; writeFileSync(clock, String(ms)); };
setClock(now);
const r = rng(seed); const v = []; const notes = [];
const m = new Mcp(env); await m.init();
const S = { host: "codex", sessionId: "sender-e3" };
async function enqueue(target, body, sender = S, mcp = m, ttlSeconds = undefined) {
  const p = await mcp.call("prepare_session_message", { schemaVersion: "1.0.0", targetHost: target.host, targetSessionId: target.sessionId, body, _sessionBinding: sender, ...(ttlSeconds ? { ttlSeconds } : {}) });
  const s = await mcp.call("send_session_message", { schemaVersion: "1.0.0", messageId: p.data.messageId, _sessionBinding: sender });
  if (!s.ok) throw new Error("enqueue failed " + JSON.stringify(s)); return p.data.messageId;
}
function hookIds(out) { if (!out) return []; const ctx = JSON.parse(out).hookSpecificOutput?.additionalContext ?? ""; const ids = []; const lines = ctx.split("\n");
  for (let i = 0; i < lines.length; i += 1) if (lines[i] === "[agent-governance-suite peer message BEGIN]") ids.push(JSON.parse(lines[i + 2]).receipt.messageId); return ids; }
const claimers = {
  cli: async (t) => (await cliAsync(env, "claim", { target: t, maxMessages: 1 + Math.floor(r() * 10) })).data?.messages?.map((x) => x.messageId) ?? [],
  claudeStop: async (t) => hookIds(await hookAsync(env, ROOT + "/claude-plugin/hooks/session-message-hook.mjs", { hook_event_name: "Stop", session_id: t.sessionId })),
  codexPost: async (t) => hookIds(await hookAsync(env, ROOT + "/mcp-server/dist/session-message-hook.mjs", { hook_event_name: "PostToolUse", session_id: t.sessionId, tool_name: "shell", tool_input: {} })),
};
// (a) concurrent claims by two receiver processes for one session
const conc = [];
for (let round = 0; round < 6; round += 1) {
  const kind = ["cli", "claudeStop", "codexPost"][round % 3];
  const t = { host: kind === "claudeStop" ? "claude-code" : "codex", sessionId: `recv-a-${round}` };
  const ids = []; for (let i = 0; i < 12; i += 1) ids.push(await enqueue(t, `a r${round} i${i} 가나다`));
  const got = [[], []]; let empty = 0, iter = 0;
  while (empty < 3 && iter < 60) { iter += 1;
    const pair = await Promise.all([0, 1].map(async (w) => { await sleep(Math.floor(r() * 4)); return claimers[kind](t); }));
    pair.forEach((x, w) => got[w].push(...x)); if (pair[0].length + pair[1].length === 0) empty += 1; }
  const all = [...got[0], ...got[1]]; const dup = all.filter((x, i) => all.indexOf(x) !== i);
  const missing = ids.filter((x) => !all.includes(x));
  conc.push({ round, kind, enqueued: ids.length, w0: got[0].length, w1: got[1].length, dup: dup.length, missing: missing.length, iterations: iter });
  if (dup.length || missing.length) v.push({ kind: "concurrent-claim", round, claimKind: kind, dup, missing, rows: dump(state, "SELECT message_id, delivery_attempts, claim_until, acknowledged_at FROM messages WHERE target_session_id = ?", [t.sessionId]) });
}
// (b) lease expiry boundary under the time fixture: redelivery must carry the same ID
const tB = { host: "codex", sessionId: "recv-lease" };
const idB = await enqueue(tB, "lease 본문", S, m, 86400);
const leaseLog = []; let first = null; let claimAt = now;
const c1 = await cliAsync(env, "claim", { target: tB }); const m1 = c1.data.messages[0]; first = m1.firstDeliveredAt;
leaseLog.push({ attempt: m1.deliveryAttempt, id: m1.messageId, at: new Date(claimAt).toISOString() });
const expected = [240000, 480000, 960000, 1800000, 1800000];
let lease = 120000;
for (let a = 2; a <= 6; a += 1) {
  setClock(claimAt + lease - 1);
  const early = await Promise.all([cliAsync(env, "claim", { target: tB }), cliAsync(env, "claim", { target: tB })]);
  const earlyCount = early.reduce((n, x) => n + (x.data?.messages?.length ?? 0), 0);
  setClock(claimAt + lease);
  const on = await Promise.all([cliAsync(env, "claim", { target: tB }), cliAsync(env, "claim", { target: tB })]);
  const msgs = on.flatMap((x) => x.data?.messages ?? []);
  leaseLog.push({ attempt: a, leaseMsBefore: lease, earlyCount, onBoundaryCount: msgs.length, ids: msgs.map((x) => x.messageId), deliveryAttempt: msgs[0]?.deliveryAttempt, firstDeliveredAt: msgs[0]?.firstDeliveredAt });
  if (earlyCount !== 0 || msgs.length !== 1 || msgs[0].messageId !== idB || msgs[0].deliveryAttempt !== a || msgs[0].firstDeliveredAt !== first) v.push({ kind: "lease-redelivery", attempt: a, earlyCount, msgs });
  claimAt = claimAt + lease; lease = expected[a - 2];
}
const rowB = dump(state, "SELECT * FROM messages WHERE message_id = ?", [idB])[0];
leaseLog.push({ finalRow: rowB });
if (Date.parse(rowB.claim_until) - Date.parse(rowB.claimed_at) !== 1800000) v.push({ kind: "lease-cap", rowB });
// (c) ACK rules
const tC = { host: "codex", sessionId: "recv-ack" }, other = { host: "codex", sessionId: "recv-other" };
const idC = await enqueue(tC, "ack target"); const idO = await enqueue(other, "other target");
await cliAsync(env, "claim", { target: tC }); await cliAsync(env, "claim", { target: other });
const snap = () => JSON.stringify(dump(state, "SELECT * FROM messages WHERE message_id IN (?, ?) ORDER BY message_id", [idC, idO]));
const ack = (binding, ids) => m.call("acknowledge_session_messages", { schemaVersion: "1.0.0", messageIds: ids, _sessionBinding: binding });
const ackLog = [];
let s0 = snap(); let a1 = await ack(tC, [idO]); ackLog.push({ case: "other-session-id", res: a1.data, unchanged: snap() === s0 }); if (a1.data?.acknowledged !== 0 || snap() !== s0) v.push({ kind: "ack-other", a1 });
s0 = snap(); a1 = await ack(S, [idC]); ackLog.push({ case: "sender-acks-own-sent", res: a1.data, unchanged: snap() === s0 }); if (a1.data?.acknowledged !== 0 || snap() !== s0) v.push({ kind: "ack-by-sender", a1 });
s0 = snap(); a1 = await ack(tC, ["00000000-0000-4000-8000-000000000000"]); ackLog.push({ case: "unknown-id", res: a1.data, unchanged: snap() === s0 }); if (a1.data?.acknowledged !== 0 || snap() !== s0) v.push({ kind: "ack-unknown", a1 });
s0 = snap(); a1 = await ack(tC, [idC, idC]); ackLog.push({ case: "duplicate-in-array-mcp", ok: a1.ok, code: a1.error?.code, unchanged: snap() === s0 }); if (snap() !== s0) v.push({ kind: "ack-dup-array-changed", a1 });
a1 = await ack(tC, [idC]); ackLog.push({ case: "first-ack", res: a1.data });
s0 = snap(); a1 = await ack(tC, [idC]); ackLog.push({ case: "second-ack", res: a1.data, unchanged: snap() === s0 }); if (a1.data?.acknowledged !== 0 || snap() !== s0) v.push({ kind: "ack-twice", a1 });
const rawDup = await brokerRaw(state, "acknowledge", { target: other, messageIds: [idO, idO, idO] }); ackLog.push({ case: "broker-dup-array", res: rawDup });
if (rawDup.data?.acknowledged !== 1) v.push({ kind: "broker-dup-array", rawDup });
setClock(now + 3600_000); const after = await cliAsync(env, "claim", { target: tC }); ackLog.push({ case: "no-redelivery-after-ack", count: after.data?.messages?.length });
if ((after.data?.messages?.length ?? 0) !== 0) v.push({ kind: "redelivered-after-ack", after });
// ACK before any claim (queued message) by the recipient
const idQ = await enqueue(tC, "never claimed"); a1 = await ack(tC, [idQ]); ackLog.push({ case: "ack-before-claim", res: a1.data, row: dump(state, "SELECT delivery_attempts, claimed_at, acknowledged_at FROM messages WHERE message_id = ?", [idQ])[0] });
notes.push("ACK of a queued, never-claimed message by its recipient is accepted (delivery_attempts=0)." );
// (d) PreToolUse binding: a forged _sessionBinding in tool input is overwritten by the hook
const hookOut = await hookAsync(env, ROOT + "/mcp-server/dist/session-message-hook.mjs", { hook_event_name: "PreToolUse", session_id: "recv-ack", agent_id: "", tool_name: "mcp__agent-governance-suite__acknowledge_session_messages", tool_input: { schemaVersion: "1.0.0", messageIds: [idO], _sessionBinding: other } });
const upd = JSON.parse(hookOut).hookSpecificOutput?.updatedInput; ackLog.push({ case: "pretooluse-forged-binding", updatedBinding: upd?._sessionBinding });
if (upd?._sessionBinding?.sessionId !== "recv-ack") v.push({ kind: "hook-binding-forgery", upd });
// (e) direct MCP call without the hook: caller-asserted binding (trust-boundary observation, not counted as a violation)
const idE = await enqueue(other, "forge target"); const forged = await ack(other, [idE]); ackLog.push({ case: "mcp-without-hook-caller-asserted-binding", res: forged.data });
notes.push("MCP server and packaged CLI trust the caller-supplied identity; the PreToolUse hook is the binding boundary. Any same-user process holding the broker token can claim/ACK for any session.");
m.close();
const summary = { exp: "E3/E4", root: ROOT, seed, concurrentRounds: conc.length, concurrentClaimed: conc.reduce((n, c) => n + c.w0 + c.w1, 0), leaseChecks: 5, ackCases: ackLog.length, violations: v.length };
writeFileSync(`/tmp/ev/e3-${seed}-${tag}.json`, JSON.stringify({ summary, violations: v, conc, leaseLog, ackLog, notes }, null, 1));
console.log(JSON.stringify(summary)); console.log(JSON.stringify(conc)); console.log(JSON.stringify(leaseLog.slice(0, 6))); console.log(JSON.stringify(ackLog)); if (v.length) console.log(JSON.stringify(v).slice(0, 3000));
