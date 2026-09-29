// E1: 8 MCP stdio server processes concurrently prepare->send 200 messages each to one target.
// usage: node e1-burst.mjs <seed> <variant: distinct|same|drain>
import { Mcp, envFor, cliAsync, dump, rng, sleep, ROOT } from "./lib.mjs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
const seed = Number(process.argv[2] ?? 1), variant = process.argv[3] ?? "distinct";
const P = 8, N = Number(process.env.E1_N ?? 200);
const base = `/tmp/exp/e1-${variant}-${seed}-${ROOT.split("/").pop()}`; rmSync(base, { recursive: true, force: true }); mkdirSync(base + "/home", { recursive: true });
const state = base + "/state", env = envFor(state, base + "/home");
const T = { host: "codex", sessionId: "target-e1" };
const servers = Array.from({ length: P }, () => new Mcp(env));
await Promise.all(servers.map((s) => s.init()));
const log = [];
let draining = variant === "drain", claims = [];
async function drainer(rid) {
  const r = rng(seed * 7919 + rid);
  while (draining) {
    const c = await cliAsync(env, "claim", { target: T, maxMessages: 10 });
    const msgs = c.data?.messages ?? [];
    for (const m of msgs) claims.push({ rid, id: m.messageId, attempt: m.deliveryAttempt, t: Date.now() });
    if (msgs.length) await cliAsync(env, "acknowledge", { target: T, messageIds: msgs.map((m) => m.messageId) });
    await sleep(Math.floor(r() * 20));
  }
}
const drainers = variant === "drain" ? [drainer(1), drainer(2)] : [];
const t0 = Date.now();
await Promise.all(servers.map(async (srv, p) => {
  const r = rng(seed * 1000 + p);
  const S = { host: "codex", sessionId: variant === "same" ? "sender-shared" : `sender-${p}` };
  for (let i = 0; i < N; i += 1) {
    const body = `seed=${seed} p=${p} i=${i} 한글본문-${Math.floor(r() * 1e9)}`;
    const prep = await srv.call("prepare_session_message", { schemaVersion: "1.0.0", targetHost: T.host, targetSessionId: T.sessionId, body, _sessionBinding: S });
    if (!prep.ok) { log.push({ p, i, phase: "prepare", ok: false, error: prep.error?.message ?? JSON.stringify(prep).slice(0, 300) }); continue; }
    const id = prep.data.messageId;
    await sleep(Math.floor(r() * 3));
    const send = await srv.call("send_session_message", { schemaVersion: "1.0.0", messageId: id, _sessionBinding: S });
    log.push({ p, i, id, body, sender: S.sessionId, phase: "send", ok: send.ok, duplicate: send.data?.duplicate ?? null, error: send.ok ? null : send.error?.message });
  }
}));
const elapsed = Date.now() - t0;
if (variant === "drain") { await sleep(300); draining = false; await Promise.all(drainers); }
servers.forEach((s) => s.close());
const rows = dump(state), prepared = dump(state, "SELECT message_id, sender_session_id, receipt IS NOT NULL AS has_receipt, body IS NOT NULL AS has_body FROM prepared_messages");
const byId = new Map(rows.map((r) => [r.message_id, r])), prepById = new Map(prepared.map((r) => [r.message_id, r]));
const v = [];
const sends = log.filter((l) => l.phase === "send");
const okNew = sends.filter((l) => l.ok && l.duplicate === false), okDup = sends.filter((l) => l.ok && l.duplicate === true), rej = sends.filter((l) => !l.ok);
const idCount = new Map(); for (const l of okNew) idCount.set(l.id, (idCount.get(l.id) ?? 0) + 1);
for (const [id, c] of idCount) if (c > 1) v.push({ kind: "new-twice", id, c });
for (const l of sends.filter((l) => l.ok)) { const row = byId.get(l.id); if (!row && variant !== "drain") v.push({ kind: "ok-but-missing", id: l.id }); else if (row && row.body !== l.body) v.push({ kind: "body-mismatch", id: l.id }); }
for (const l of rej) { if (byId.has(l.id)) v.push({ kind: "rejected-but-stored", id: l.id, err: l.error }); const pr = prepById.get(l.id); if (!pr || pr.has_receipt || !pr.has_body) v.push({ kind: "rejected-state-changed", id: l.id, prepared: pr ?? null }); }
for (const r of rows) if (!sends.some((l) => l.ok && l.id === r.message_id)) v.push({ kind: "stored-without-ok", id: r.message_id });
if (variant === "drain") {
  const seen = new Map(); for (const c of claims) { if (!seen.has(c.id)) seen.set(c.id, []); seen.get(c.id).push(c); }
  for (const [id, cs] of seen) if (cs.length > 1) v.push({ kind: "claimed-twice", id, cs });
  for (const l of sends.filter((l) => l.ok)) if (!seen.has(l.id) && !(byId.get(l.id)?.acknowledged_at === null)) v.push({ kind: "ok-not-claimed-and-not-pending", id: l.id });
  const pendingLeft = rows.filter((r) => r.acknowledged_at === null).length;
  log.push({ summary: "drain", claimed: claims.length, uniqueClaimed: seen.size, pendingLeft });
}
const errCounts = {}; for (const l of rej) errCounts[l.error] = (errCounts[l.error] ?? 0) + 1;
const summary = { exp: "E1", root: ROOT, seed, variant, processes: P, perProcess: N, elapsedMs: elapsed, sends: sends.length, prepareFail: log.filter((l) => l.phase === "prepare" && !l.ok).length,
  okNew: okNew.length, okDup: okDup.length, rejected: rej.length, rejectReasons: errCounts, storedRows: rows.length, preparedRows: prepared.length, claims: claims.length, violations: v.length };
writeFileSync(`/tmp/ev/e1-${variant}-${seed}-${ROOT.split("/").pop()}.json`, JSON.stringify({ summary, violations: v, log, claims }, null, 1));
console.log(JSON.stringify(summary)); if (v.length) console.log(JSON.stringify(v.slice(0, 20)));
