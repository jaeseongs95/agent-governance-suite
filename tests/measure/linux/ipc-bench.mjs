// M2 Linux: cold start (detached spawn -> first response), round trips, shim RSS.
// usage: node ipc-bench.mjs <runDir> <pgDataDir>
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, pct, sleep } from "./ipc-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const [runDir, pgDir] = process.argv.slice(2);
const sock = path.join(runDir, "service.sock");
const service = path.join(here, "ipc-service.mjs");
const out = {};

async function ensureService(mode, dataDir, deadlineMs = 30000) {
  const t0 = performance.now();
  let c;
  try {
    c = await connect(sock);
    return { c, spawned: false, ms: performance.now() - t0 };
  } catch (e) {
    if (e.code !== "ENOENT" && e.code !== "ECONNREFUSED") throw e;
  }
  const child = spawn(process.execPath, [service, sock, mode, dataDir ?? ""], { detached: true, stdio: "ignore", cwd: here });
  child.unref();
  const delays = [50, 100, 200, 400, 800];
  let k = 0;
  let attempts = 0;
  for (;;) {
    await sleep(delays[Math.min(k++, delays.length - 1)]);
    attempts++;
    try {
      c = await connect(sock);
      break;
    } catch (e) {
      if (performance.now() - t0 > deadlineMs) throw new Error("deadline");
    }
  }
  await c.request("echo", { first: true });
  return { c, spawned: true, attempts, ms: performance.now() - t0 };
}
async function shutdown(c) {
  await c.request("shutdown");
  c.destroy();
  for (let i = 0; i < 100 && fs.existsSync(sock); i++) {
    try {
      await connect(sock).then((x) => x.destroy());
    } catch {
      break;
    }
    await sleep(20);
  }
  await sleep(100);
}

// ---- cold start ----
async function cold(mode, n, dataDir, fresh) {
  const ms = [];
  const attempts = [];
  for (let i = 0; i < n; i++) {
    if (fresh) fs.rmSync(dataDir, { recursive: true, force: true });
    const r = await ensureService(mode, dataDir);
    if (!r.spawned) throw new Error("service already running");
    ms.push(r.ms);
    attempts.push(r.attempts);
    await shutdown(r.c);
  }
  return { n, p50: pct(ms, 50), p99: pct(ms, 99), max: Math.round(Math.max(...ms)), min: Math.round(Math.min(...ms)), attempts: [...new Set(attempts)] };
}
fs.rmSync(pgDir, { recursive: true, force: true });
out.coldBare = await cold("bare", 20, null, false);
out.coldPgliteFreshInitdb = await cold("pglite", 3, pgDir, true);
out.coldPgliteExisting = await cold("pglite", 10, pgDir, false);

// ---- round trips on bare service ----
let { c } = await ensureService("bare");
const once = [];
for (let i = 0; i < 500; i++) {
  const t = performance.now();
  const x = await connect(sock);
  await x.request("echo", { i });
  once.push(performance.now() - t);
  x.destroy();
}
out.connectHelloPlus1Req = { n: 500, p50: pct(once, 50), p99: pct(once, 99), max: pct(once, 100) };
const keep = [];
for (let i = 0; i < 1000; i++) {
  const t = performance.now();
  await c.request("echo", { i, pad: "x".repeat(200) });
  keep.push(performance.now() - t);
}
out.keptConnection1000Req = { n: 1000, p50: pct(keep, 50), p99: pct(keep, 99), max: pct(keep, 100) };

// ---- shim RSS ----
function rssOf(pid) {
  const st = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  const g = (k) => Math.round(Number(new RegExp(k + ":\\s+(\\d+)").exec(st)[1]) / 102.4) / 10;
  return { rssMB: g("VmRSS"), hwmMB: g("VmHWM") };
}
const shims = [];
for (let i = 0; i < 5; i++) {
  const p = spawn(process.execPath, [path.join(here, "ipc-shim.mjs"), sock], { stdio: ["pipe", "pipe", "pipe"] });
  let got = "";
  const resp = new Promise((r) => p.stdout.on("data", (d) => ((got += d), got.includes("\n") && r())));
  await sleep(300);
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "echo", params: { hi: 1 } }) + "\n");
  await Promise.race([resp, sleep(5000)]);
  await sleep(1000);
  shims.push({ ok: got.includes('"hi"'), ...rssOf(p.pid) });
  p.stdin.end();
  await new Promise((r) => p.on("exit", r));
}
const idle = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)"], { stdio: "ignore" });
await sleep(1000);
out.baselineIdleNode = rssOf(idle.pid);
idle.kill();
out.shim = shims;
const st = await c.request("status");
out.bareServiceRssMB = st.result.rssMB;
await shutdown(c);
out.socketDirMode = (fs.statSync(runDir).mode & 0o777).toString(8);
console.log(JSON.stringify(out));
