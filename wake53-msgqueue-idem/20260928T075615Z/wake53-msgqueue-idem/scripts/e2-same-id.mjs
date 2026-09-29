// E2: one prepared ID sent concurrently by k MCP server processes (k=2..8); then client-kill-after-send + retry.
import { Mcp, envFor, dump, rng, sleep, ROOT } from "./lib.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
const seed = Number(process.argv[2] ?? 1), ROUNDS = Number(process.argv[3] ?? 20);
const tag = ROOT.split("/").pop();
const base = `/tmp/exp/e2-${seed}-${tag}`; rmSync(base, { recursive: true, force: true }); mkdirSync(base + "/home", { recursive: true });
const state = base + "/state", env = envFor(state, base + "/home");
const S = { host: "codex", sessionId: "sender-e2" }, T = { host: "claude-code", sessionId: "target-e2" };
const servers = Array.from({ length: 8 }, () => new Mcp(env)); await Promise.all(servers.map((s) => s.init()));
const r = rng(seed); const results = [], v = [];
for (let round = 0; round < ROUNDS; round += 1) {
  for (let k = 2; k <= 8; k += 1) {
    const prep = await servers[0].call("prepare_session_message", { schemaVersion: "1.0.0", targetHost: T.host, targetSessionId: T.sessionId, body: `r${round} k${k}`, _sessionBinding: S });
    const id = prep.data.messageId;
    const order = servers.slice(0, k).map((s, i) => ({ s, i, d: Math.floor(r() * 3) }));
    const out = await Promise.all(order.map(async ({ s, i, d }) => { await sleep(d); const x = await s.call("send_session_message", { schemaVersion: "1.0.0", messageId: id, _sessionBinding: S }); return { i, d, ok: x.ok, duplicate: x.data?.duplicate, createdAt: x.data?.createdAt, err: x.error?.message }; }));
    const rows = dump(state, "SELECT message_id, created_at FROM messages WHERE message_id = ?", [id]);
    const news = out.filter((o) => o.ok && o.duplicate === false).length;
    const created = new Set(out.filter((o) => o.ok).map((o) => o.createdAt));
    const bad = rows.length !== 1 || news !== 1 || created.size !== 1 || out.some((o) => !o.ok);
    results.push({ round, k, id, news, rows: rows.length, createdAtDistinct: created.size, out });
    if (bad) v.push({ kind: "concurrent-send", round, k, id, out, rows });
  }
}
// Kill phase: a packaged CLI send is SIGKILLed after a seeded delay, then the same ID is retried via MCP.
const killResults = [];
for (let j = 0; j < ROUNDS * 3; j += 1) {
  const prep = await servers[1].call("prepare_session_message", { schemaVersion: "1.0.0", targetHost: T.host, targetSessionId: T.sessionId, body: `kill ${j}`, _sessionBinding: S });
  const id = prep.data.messageId; const delay = Math.floor(r() * 120);
  const child = spawn(process.execPath, [ROOT + "/mcp-server/dist/session-message-cli.mjs"], { env });
  let out = ""; child.stdout.on("data", (d) => out += d);
  const closed = new Promise((res) => child.on("close", (code, sig) => res({ code, sig })));
  child.stdin.end(JSON.stringify({ operation: "send", payload: { sender: S, messageId: id } }));
  await sleep(delay); child.kill("SIGKILL"); const ex = await closed;
  const before = dump(state, "SELECT count(*) AS n FROM messages WHERE message_id = ?", [id])[0].n;
  const retry = await servers[2].call("send_session_message", { schemaVersion: "1.0.0", messageId: id, _sessionBinding: S });
  const retry2 = await servers[3].call("send_session_message", { schemaVersion: "1.0.0", messageId: id, _sessionBinding: S });
  const after = dump(state, "SELECT count(*) AS n FROM messages WHERE message_id = ?", [id])[0].n;
  let childResp = null; try { childResp = JSON.parse(out); } catch {}
  const rec = { j, id, killDelayMs: delay, childExit: ex, childGotReply: Boolean(childResp), childDuplicate: childResp?.data?.duplicate ?? null, rowsBeforeRetry: before, retryOk: retry.ok, retryDuplicate: retry.data?.duplicate, retry2Duplicate: retry2.data?.duplicate, rowsAfter: after };
  killResults.push(rec);
  const expectedDup = before === 1;
  if (after !== 1 || !retry.ok || retry.data.duplicate !== expectedDup || retry2.data?.duplicate !== true) v.push({ kind: "kill-retry", ...rec });
  if (childResp?.data?.duplicate === false && retry.data?.duplicate === false) v.push({ kind: "new-twice-after-kill", ...rec });
}
servers.forEach((s) => s.close());
const summary = { exp: "E2", root: ROOT, seed, rounds: ROUNDS, concurrentCases: results.length, killCases: killResults.length,
  killRowsBeforeRetry: killResults.reduce((a, k) => (a[k.rowsBeforeRetry] = (a[k.rowsBeforeRetry] ?? 0) + 1, a), {}), childRepliedBeforeKill: killResults.filter((k) => k.childGotReply).length, violations: v.length };
writeFileSync(`/tmp/ev/e2-${seed}-${tag}.json`, JSON.stringify({ summary, violations: v, results, killResults }, null, 1));
console.log(JSON.stringify(summary)); if (v.length) console.log(JSON.stringify(v.slice(0, 5)));
