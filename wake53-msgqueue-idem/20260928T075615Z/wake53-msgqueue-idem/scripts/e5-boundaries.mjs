// E5: TTL/draft expiry boundaries under a broker time fixture; UTF-8 body boundaries end to end through the Stop hook.
import { Mcp, envFor, cliAsync, hookAsync, dump, ROOT } from "./lib.mjs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const tag = ROOT.split("/").pop();
const base = `/tmp/exp/e5-${tag}`; rmSync(base, { recursive: true, force: true }); mkdirSync(base + "/home", { recursive: true });
const state = base + "/state", clock = base + "/clock";
const env = { ...envFor(state, base + "/home"), NODE_OPTIONS: "--import /tmp/ev/scripts/fakeclock.mjs", FAKE_CLOCK_FILE: clock };
let now = Date.now(); const setClock = (ms) => { now = ms; writeFileSync(clock, String(ms)); }; setClock(now);
const m = new Mcp(env); await m.init();
const S = { host: "codex", sessionId: "sender-e5" }; const v = []; const log = [];
const counts = () => JSON.stringify([dump(state, "SELECT count(*) n FROM messages")[0].n, dump(state, "SELECT count(*) n FROM prepared_messages")[0].n, dump(state, "SELECT coalesce(sum(receipt IS NOT NULL),0) n FROM prepared_messages")[0].n]);
const prep = (t, body, ttlSeconds) => m.call("prepare_session_message", { schemaVersion: "1.0.0", targetHost: t.host, targetSessionId: t.sessionId, body, _sessionBinding: S, ...(ttlSeconds === undefined ? {} : { ttlSeconds }) });
const send = (id) => m.call("send_session_message", { schemaVersion: "1.0.0", messageId: id, _sessionBinding: S });
await prep({ host: "codex", sessionId: "warm" }, "warm"); // start broker
// TTL argument bounds
for (const ttl of [29, 30, 86400, 86401, 30.5, 0, -1]) {
  const c0 = counts(); const p = await prep({ host: "codex", sessionId: "ttl-arg" }, "x", ttl);
  log.push({ case: "ttl-arg", ttl, ok: p.ok, code: p.error?.code });
  const expectOk = ttl === 30 || ttl === 86400; if (p.ok !== expectOk) v.push({ kind: "ttl-arg", ttl, p });
  if (!p.ok && counts() !== c0) v.push({ kind: "reject-changed-state", ttl });
}
// TTL expiry boundary with pending/claim/status/ack/retry
const tT = { host: "codex", sessionId: "ttl-exp" };
const T0 = now; const pA = await prep(tT, "ttl A", 30); const pB = await prep(tT, "ttl B", 30);
const sA = await send(pA.data.messageId); const sB = await send(pB.data.messageId);
const E = Date.parse(sA.data.expiresAt); log.push({ case: "ttl-sent", createdAt: sA.data.createdAt, expiresAt: sA.data.expiresAt, deltaMs: E - Date.parse(sA.data.createdAt) });
if (E - Date.parse(sA.data.createdAt) !== 30000) v.push({ kind: "ttl-delta", sA });
setClock(E - 1); const pendM1 = (await cliAsync(env, "pending", { target: tT })).data?.count;
const claimM1 = (await cliAsync(env, "claim", { target: tT, maxMessages: 1 })).data?.messages ?? [];
setClock(E); const pend0 = (await cliAsync(env, "pending", { target: tT })).data?.count; const claim0 = (await cliAsync(env, "claim", { target: tT })).data?.messages ?? [];
const ack0 = await m.call("acknowledge_session_messages", { schemaVersion: "1.0.0", messageIds: claimM1.map((x) => x.messageId), _sessionBinding: tT });
setClock(E + 1); const pendP1 = (await cliAsync(env, "pending", { target: tT })).data?.count;
const stP1 = await m.call("get_session_message_status", { schemaVersion: "1.0.0", messageId: pB.data.messageId, _sessionBinding: S });
const c1 = counts(); const retryP1 = await send(pB.data.messageId); const c2 = counts();
log.push({ case: "ttl-boundary", pendingAtEm1: pendM1, claimedAtEm1: claimM1.length, pendingAtE: pend0, claimedAtE: claim0.length, ackAtE_ofClaimed: ack0.data, pendingAtEp1: pendP1, statusAfterExpiry: stP1.data, retryAfterExpiry: retryP1.data ?? retryP1.error, retryChangedCounts: c1 !== c2 });
if (pendM1 !== 2 || claimM1.length !== 1 || pend0 !== 0 || claim0.length !== 0 || pendP1 !== 0 || retryP1.data?.duplicate !== true || c1 !== c2) v.push({ kind: "ttl-boundary", pendM1, claimM1: claimM1.length, pend0, claim0: claim0.length, pendP1, retryP1 });
if (ack0.data?.acknowledged !== 0) log.push({ note: "ACK at exact expiry of a claimed message", ack0: ack0.data });
// receipt expiry: E + 3600000
const RE = E + 3600000; setClock(RE - 1); const rm1 = await send(pB.data.messageId); setClock(RE); const c3 = counts(); const r0 = await send(pB.data.messageId); const c4 = counts();
log.push({ case: "receipt-expiry", atREm1: rm1.data ?? rm1.error, atRE: r0.data ?? r0.error, rejectChangedCounts: c3 !== c4 });
if (rm1.data?.duplicate !== true || r0.ok || c3 !== c4) v.push({ kind: "receipt-expiry", rm1, r0 });
// draft expiry: prepared_at + 600000
const P0 = now; const d1 = await prep(tT, "draft 1"); const d2 = await prep(tT, "draft 2");
setClock(Date.parse(d1.data.expiresAt) - 1); const ds1 = await send(d1.data.messageId);
setClock(Date.parse(d2.data.expiresAt)); const c5 = counts(); const ds2 = await send(d2.data.messageId); const c6 = counts();
log.push({ case: "draft-expiry", draftTtlMs: Date.parse(d1.data.expiresAt) - Date.parse(d1.data.preparedAt), atEm1: ds1.data ?? ds1.error, atE: ds2.data ?? ds2.error, rejectChangedCounts: c5 !== c6 });
if (!ds1.ok || ds1.data.duplicate !== false || ds2.ok) v.push({ kind: "draft-expiry", ds1, ds2 });
// Body boundaries
const K = "가", EMO = "😀";
const bodies = [
  ["ascii-4096", "a".repeat(4096), true], ["ascii-4097", "a".repeat(4097), false],
  ["ko-1365+a=4096B", K.repeat(1365) + "a", true], ["ko-1365+ab=4097B", K.repeat(1365) + "ab", false], ["ko-1366=4098B", K.repeat(1366), false],
  ["a4093+ko=4096B", "a".repeat(4093) + K, true], ["a4094+ko=4097B(split)", "a".repeat(4094) + K, false],
  ["emoji-1024=4096B", EMO.repeat(1024), true], ["emoji-1024+a=4097B", EMO.repeat(1024) + "a", false], ["a4093+emoji=4097B", "a".repeat(4093) + EMO, false], ["a4092+emoji=4096B", "a".repeat(4092) + EMO, true],
  ["ctrl-4096", "\u0001".repeat(4096), true], ["quote-backslash-4096", "\"\\".repeat(2048), true], ["whitespace-only", " \n\t ", false], ["nul", "a\u0000b", false],
  ["lone-surrogate", "a\uD800b", true], ["ko-nfd-vs-nfc", "가", true],
];
const tBody = { host: "claude-code", sessionId: "body-recv" }; setClock(now + 1000);
for (const [name, body, expect] of bodies) {
  const c0 = counts(); const p = await prep(tBody, body);
  const rec = { case: "body", name, bytes: Buffer.byteLength(body, "utf8"), codeUnits: body.length, prepareOk: p.ok, code: p.error?.code ?? null };
  if (!p.ok) { rec.rejectChangedCounts = counts() !== c0; if (rec.rejectChangedCounts) v.push({ kind: "reject-changed-state", name }); if (expect) v.push({ kind: "body-unexpected-reject", name, p }); log.push(rec); continue; }
  if (!expect) v.push({ kind: "body-unexpected-accept", name, bytes: rec.bytes });
  const s = await send(p.data.messageId); rec.sendOk = s.ok;
  const out = await hookAsync(env, ROOT + "/claude-plugin/hooks/session-message-hook.mjs", { hook_event_name: "Stop", session_id: tBody.sessionId });
  if (!out) { rec.hook = "empty"; v.push({ kind: "hook-empty", name }); log.push(rec); continue; }
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext; const lines = ctx.split("\n"); const j = JSON.parse(lines[lines.indexOf("[agent-governance-suite peer message BEGIN]") + 2]);
  const delivered = j.messageEncoding === "base64-utf8" ? Buffer.from(j.message, "base64").toString("utf8") : j.message;
  const stored = dump(state, "SELECT body, body_bytes FROM messages WHERE message_id = ?", [p.data.messageId])[0];
  rec.encoding = j.messageEncoding; rec.contextBytes = Buffer.byteLength(ctx, "utf8"); rec.deliveredEqualsSent = delivered === body; rec.storedEqualsSent = stored.body === body; rec.storedBodyBytes = stored.body_bytes;
  rec.digestMatchesSent = j.receipt.contentDigest === "sha256:" + createHash("sha256").update(body).digest("hex");
  if (!rec.deliveredEqualsSent || j.receipt.messageId !== p.data.messageId) (name === "lone-surrogate" ? log.push({ note: "lone surrogate normalized to U+FFFD", name }) : v.push({ kind: "body-roundtrip", name, rec }));
  await m.call("acknowledge_session_messages", { schemaVersion: "1.0.0", messageIds: [p.data.messageId], _sessionBinding: tBody });
  log.push(rec);
}
// Hook fail-open after claim: trust DB unwritable for the hook only; message stays leased, then redelivered with the same ID.
const tH = { host: "claude-code", sessionId: "hook-fail" }; const ph = await prep(tH, "hook fail body"); await send(ph.data.messageId);
const badEnv = { ...env, AGENT_GOVERNANCE_TRUST_DB_PATH: "/dev/null/trust.sqlite3" };
const o1 = await hookAsync(badEnv, ROOT + "/claude-plugin/hooks/session-message-hook.mjs", { hook_event_name: "Stop", session_id: tH.sessionId });
const rowH = dump(state, "SELECT delivery_attempts, claimed_at, claim_until FROM messages WHERE message_id = ?", [ph.data.messageId])[0];
setClock(Date.parse(rowH.claim_until)); const o2 = await hookAsync(env, ROOT + "/claude-plugin/hooks/session-message-hook.mjs", { hook_event_name: "Stop", session_id: tH.sessionId });
let redeliveredId = null, attempt = null; if (o2) { const L = JSON.parse(o2).hookSpecificOutput.additionalContext.split("\n"); const j = JSON.parse(L[2]); redeliveredId = j.receipt.messageId; attempt = j.receipt.deliveryAttempt; }
log.push({ case: "hook-fail-open-after-claim", firstHookOutput: o1 === "" ? "empty" : o1.slice(0, 100), rowAfterFailedHook: rowH, invisibleLeaseMs: Date.parse(rowH.claim_until) - Date.parse(rowH.claimed_at), redeliveredSameId: redeliveredId === ph.data.messageId, deliveryAttemptOnRedelivery: attempt });
if (redeliveredId !== ph.data.messageId) v.push({ kind: "hook-fail-lost", rowH, o2 });
m.close();
const summary = { exp: "E5", root: ROOT, cases: log.length, violations: v.length };
writeFileSync(`/tmp/ev/e5-${tag}.json`, JSON.stringify({ summary, violations: v, log }, null, 1));
console.log(JSON.stringify(summary)); for (const l of log) console.log(JSON.stringify(l).slice(0, 600)); if (v.length) console.log(JSON.stringify(v).slice(0, 3000));
