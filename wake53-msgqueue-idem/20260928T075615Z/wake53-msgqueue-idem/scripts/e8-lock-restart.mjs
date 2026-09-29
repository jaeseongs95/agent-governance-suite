// E8: send while the queue DB is write-locked by another process, and send bursts while the broker is killed.
import { Mcp, envFor, dump, rng, sleep, ROOT } from "./lib.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
const seed = Number(process.argv[2] ?? 1); const tag = ROOT.split("/").pop();
const base = `/tmp/exp/e8-${seed}-${tag}`; rmSync(base, { recursive: true, force: true }); mkdirSync(base + "/home", { recursive: true });
const state = base + "/state", env = envFor(state, base + "/home"); const r = rng(seed);
const servers = Array.from({ length: 4 }, () => new Mcp(env)); await Promise.all(servers.map((s) => s.init()));
const S = { host: "codex", sessionId: "sender-e8" }, T = { host: "codex", sessionId: "target-e8" };
const v = [], lockLog = [], killLog = [];
const prep = async (srv, body) => (await srv.call("prepare_session_message", { schemaVersion: "1.0.0", targetHost: T.host, targetSessionId: T.sessionId, body, _sessionBinding: S })).data.messageId;
const send = async (srv, id) => { const t = Date.now(); const x = await srv.call("send_session_message", { schemaVersion: "1.0.0", messageId: id, _sessionBinding: S }); return { ok: x.ok, dup: x.data?.duplicate ?? null, err: x.error?.message?.slice(0, 160) ?? null, ms: Date.now() - t }; };
const brokerPid = () => { try { return JSON.parse(readFileSync(state + "/endpoint.json", "utf8")).pid; } catch { return null; } };
await prep(servers[0], "warm");
for (const hold of [1000, 3000, 7000]) {
  const ids = await Promise.all(servers.map((s, i) => prep(s, `lock ${hold} ${i}`)));
  const pid0 = brokerPid();
  const locker = spawn(process.execPath, ["/tmp/ev/scripts/holdlock.mjs", state + "/session-messages.sqlite3", String(hold)]);
  const lockerClosed = new Promise((res) => locker.on("close", res));
  await new Promise((res) => locker.stdout.once("data", res));
  const first = await Promise.all(servers.map((s, i) => send(s, ids[i])));
  await lockerClosed; await sleep(200);
  const retry = await Promise.all(servers.map((s, i) => send(s, ids[i])));
  const rows = ids.map((id) => dump(state, "SELECT count(*) n FROM messages WHERE message_id = ?", [id])[0].n);
  const rec = { hold, brokerPidBefore: pid0, brokerPidAfter: brokerPid(), first, retry, rows };
  lockLog.push(rec);
  ids.forEach((id, i) => {
    const news = [first[i], retry[i]].filter((x) => x.ok && x.dup === false).length;
    if (rows[i] !== 1 || news > 1 || !retry[i].ok) v.push({ kind: "lock-send", hold, id, first: first[i], retry: retry[i], rows: rows[i] });
    if (!first[i].ok && rows[i] === 1 && retry[i].dup === false) v.push({ kind: "lock-reject-but-stored", hold, id });
  });
}
// Broker kill during burst
const KILLS = Number(process.env.E8_KILLS ?? 6); const TOTAL = 4 * Number(process.env.E8_N ?? 100);
const killAfter = Array.from({ length: KILLS }, () => 20 + Math.floor(r() * (TOTAL - 60))).sort((a, b) => a - b);
const signals = killAfter.map((_, i) => (i % 3 === 1 ? "SIGTERM" : "SIGKILL")); const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }; let lastKilled = null;
const results = []; const t0 = Date.now();
const killer = (async () => { for (let k = 0; k < killAfter.length; k += 1) {
  while (results.length < killAfter[k] && results.length < TOTAL) await sleep(1);
  let pid = brokerPid(); const w0 = Date.now(); while ((pid === null || pid === lastKilled || !alive(pid)) && Date.now() - w0 < 5000) { await sleep(2); pid = brokerPid(); }
  lastKilled = pid; try { process.kill(pid, signals[k]); killLog.push({ afterSends: results.length, atMs: Date.now() - t0, pid, signal: signals[k] }); } catch (e) { killLog.push({ afterSends: results.length, atMs: Date.now() - t0, pid, signal: signals[k], error: String(e.code) }); } } })();
await Promise.all(servers.map(async (srv, p) => { for (let i = 0; i < Number(process.env.E8_N ?? 100); i += 1) {
  let id; try { id = await prep(srv, `burst p${p} i${i}`); } catch (e) { results.push({ p, i, prepFail: true }); continue; }
  const attempts = [await send(srv, id)];
  while (!attempts.at(-1).ok && attempts.length < 4) { await sleep(100 * 2 ** attempts.length); attempts.push(await send(srv, id)); }
  results.push({ p, i, id, attempts });
} }));
await killer;
const burstViolations = [];
for (const res of results.filter((x) => x.id)) {
  const n = dump(state, "SELECT count(*) n FROM messages WHERE message_id = ?", [res.id])[0].n;
  const news = res.attempts.filter((a) => a.ok && a.dup === false).length; const anyOk = res.attempts.some((a) => a.ok);
  res.rows = n;
  if (n > 1 || news > 1 || (anyOk && n !== 1)) burstViolations.push({ kind: "burst", ...res });
  if (!anyOk && n === 1) res.note = "all replies failed but stored (delivery unknown to sender)";
}
v.push(...burstViolations);
servers.forEach((s) => s.close());
const summary = { exp: "E8", root: ROOT, seed, lockCases: lockLog.length * 4, burstSends: results.length, burstPrepFail: results.filter((x) => x.prepFail).length,
  burstFirstFail: results.filter((x) => x.attempts && !x.attempts[0].ok).length, burstEventuallyFail: results.filter((x) => x.attempts && !x.attempts.some((a) => a.ok)).length,
  firstVisibleDuplicate: results.filter((x) => x.attempts && x.attempts.find((a) => a.ok)?.dup === true).length, kills: killLog, violations: v.length };
writeFileSync(`/tmp/ev/e8-${seed}-${tag}.json`, JSON.stringify({ summary, violations: v, lockLog, killLog, results }, null, 1));
console.log(JSON.stringify(summary)); for (const l of lockLog) console.log(JSON.stringify(l)); if (v.length) console.log(JSON.stringify(v).slice(0, 3000));
