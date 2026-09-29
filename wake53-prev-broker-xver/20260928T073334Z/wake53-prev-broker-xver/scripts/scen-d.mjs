// (d) two broker versions at once on one state dir: lock, endpoint ownership, schema, user_version.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startBroker, stopBroker, cli, rpc, dump, Log, sleep, rng, envFor, VERSIONS, schemaOnly } from "./lib.mjs";
const out = "/tmp/ev/dumps/d"; mkdirSync(out, { recursive: true });
const log = new Log(`${out}/run.log`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readJ = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const readT = (f) => { try { return readFileSync(f, "utf8").trim(); } catch { return null; } };
const F = { sequential: [], races: [], schema: {} };

// d1: sequential second start while the other version serves
for (const [first, second] of [["2.7.1", "53"], ["53", "2.7.1"], ["2.2.6", "53"], ["53", "2.2.6"]]) {
  const dir = `/tmp/ev-state/d1-${first}-then-${second}`; rmSync(dir, { recursive: true, force: true });
  const a = await startBroker(first, dir, log);
  const ep1 = readJ(path.join(dir, "endpoint.json")); const lock1 = readT(path.join(dir, "broker.lock"));
  const c = spawn(process.execPath, [path.join(VERSIONS[second], "mcp-server/dist/session-message-broker.mjs"), "--state-directory", dir], { env: envFor(dir), stdio: ["ignore", "ignore", "pipe"] });
  let err = ""; c.stderr.on("data", (d) => { err += d; });
  const code = await new Promise((r) => { const t = setTimeout(() => r("still-running-after-5s"), 5000); c.once("exit", (x, s) => { clearTimeout(t); r({ code: x, sig: s }); }); });
  if (code === "still-running-after-5s") c.kill();
  const ep2 = readJ(path.join(dir, "endpoint.json")); const lock2 = readT(path.join(dir, "broker.lock"));
  // clients of the second version still reach the first broker
  const p = cli(second, dir, "prepare", { sender: { host: "codex", sessionId: "x" }, target: { host: "codex", sessionId: "y" }, body: "d1" });
  const r = { first, second, secondExit: code, secondStderr: err.trim(), endpointPidBefore: ep1?.pid, endpointPidAfter: ep2?.pid, firstPid: a.child.pid,
    lockBefore: lock1, lockAfter: lock2, secondClientOk: p.ok, secondClientErr: p.error ?? null };
  await stopBroker(a, log);
  r.lockAfterStop = existsSync(path.join(dir, "broker.lock")); r.endpointAfterStop = existsSync(path.join(dir, "endpoint.json"));
  const d = dump(dir, `${out}/d1-${first}-then-${second}.json`); r.user_version = d.user_version; r.integrity = d.integrity;
  log.w("d1", r); F.sequential.push(r);
}

// d2: simultaneous start races, seeded, fresh and stale-lock variants
async function race(seed, stale, k) {
  const r = rng(seed); const vers = Array.from({ length: k }, () => (r() < 0.5 ? "2.7.1" : "53"));
  const dir = `/tmp/ev-state/d2-s${seed}-${stale ? "stale" : "fresh"}`; rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (stale) writeFileSync(path.join(dir, "broker.lock"), "999999\n");
  const kids = vers.map((v) => { const c = spawn(process.execPath, [path.join(VERSIONS[v], "mcp-server/dist/session-message-broker.mjs"), "--state-directory", dir], { env: envFor(dir), stdio: "ignore" });
    const ex = new Promise((res) => c.once("exit", (code, sig) => res({ code, sig }))); return { v, c, ex, exit: null }; });
  for (const k2 of kids) k2.ex.then((e) => { k2.exit = e; });
  await sleep(4000);
  const ep = readJ(path.join(dir, "endpoint.json")); const lock = readT(path.join(dir, "broker.lock"));
  const running = kids.filter((x) => x.exit === null).map((x) => ({ v: x.v, pid: x.c.pid }));
  const ping = await rpc(dir, "ping", {});
  // exercise the store through whichever broker serves
  const s = { host: "codex", sessionId: "rs" }, t = { host: "codex", sessionId: "rt" };
  const pr = cli("53", dir, "prepare", { sender: s, target: t, body: `race-${seed}` }); const se = cli("2.7.1", dir, "send", { sender: s, messageId: pr.data?.messageId });
  const cl = cli("2.7.1", dir, "claim", { target: t });
  const res = { seed, stale, k, versions: vers, running, endpointPid: ep?.pid, endpointOwner: kids.find((x) => x.c.pid === ep?.pid)?.v ?? null, lockPid: lock, pingOk: ping.ok,
    exits: kids.map((x) => ({ v: x.v, pid: x.c.pid, exit: x.exit })), messageRoundTrip: se.ok && (cl.data?.messages?.length === 1) };
  // orphan check: if >1 running, kill the endpoint owner and see whether the orphan's cleanup removes a newer lock
  if (running.length > 1) res.multipleBrokers = true;
  for (const x of kids) if (x.exit === null) x.c.kill("SIGTERM");
  await Promise.all(kids.map((x) => x.ex));
  const d = dump(dir, `${out}/d2-s${seed}-${stale ? "stale" : "fresh"}.json`); res.integrity = d.integrity; res.user_version = d.user_version;
  res.lockLeft = existsSync(path.join(dir, "broker.lock")); res.endpointLeft = existsSync(path.join(dir, "endpoint.json"));
  log.w("d2", res); F.races.push(res);
}
const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
log.w(`d2 seeds=${JSON.stringify(seeds)} k=6 variants=fresh,stale(lock pid 999999)`);
for (const seed of seeds) { await race(seed, false, 6); await race(seed, true, 6); }

// d3: schema created by each version on an empty dir, then opened by 53 and by 2.7.1
for (const v of ["53", "2.7.1", "2.7.0", "2.6.0", "2.2.6"]) {
  const dir = `/tmp/ev-state/d3-created-by-${v}`; rmSync(dir, { recursive: true, force: true });
  const b = await startBroker(v, dir, log); await stopBroker(b, log);
  const created = dump(dir, `${out}/d3-created-by-${v}.json`);
  const b2 = await startBroker("53", dir, log); await stopBroker(b2, log);
  const after53 = dump(dir, `${out}/d3-created-by-${v}-opened-by-53.json`);
  const b3 = await startBroker("2.7.1", dir, log); await stopBroker(b3, log);
  const after271 = dump(dir, `${out}/d3-created-by-${v}-opened-by-53-then-2.7.1.json`);
  F.schema[v] = { user_version: [created.user_version, after53.user_version, after271.user_version], integrity: [created.integrity, after53.integrity, after271.integrity],
    schemaVersion: [created.schema_version, after53.schema_version, after271.schema_version],
    changedBy53: schemaOnly(created) !== schemaOnly(after53), changedBy271After53: schemaOnly(after53) !== schemaOnly(after271),
    tables: created.schema.filter((s) => s.type === "table").map((s) => s.name) };
}
const ref = readJ(`${out}/d3-created-by-53.json`);
for (const v of Object.keys(F.schema)) F.schema[v].equalTo53CreatedAfterOpenBy53 = schemaOnly(readJ(`${out}/d3-created-by-${v}-opened-by-53.json`)) === schemaOnly(ref);
log.w("FINDINGS", F); writeFileSync(`${out}/findings.json`, JSON.stringify(F, null, 1));
