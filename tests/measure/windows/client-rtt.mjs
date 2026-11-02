// M2 IPC round trip over a Windows named pipe: per-connection (connect+hello+1 request) and persistent connection.
import net from "node:net";
import fs from "node:fs";
import { spawn } from "node:child_process";

const [root = "C:\\ags-measure-dbms", perConn = "300", persistent = "2000"] = process.argv.slice(2);
const name = "ags-m2-rtt-" + process.pid;
const pipePath = "\\\\.\\pipe\\" + name;
const work = root + "\\work";
fs.mkdirSync(work, { recursive: true });
const svc = spawn(process.execPath, [root + "\\service.mjs", "--name", name, "--lock", `${work}\\${name}.lock`, "--log", `${work}\\${name}.log`, "--life", "120000"],
  { detached: true, stdio: "ignore", windowsHide: true });

const connect = () => new Promise((res, rej) => { const s = net.connect(pipePath); s.once("connect", () => res(s)); s.once("error", rej); });
function lines(sock) {
  let buf = ""; const waiters = [];
  sock.setEncoding("utf8");
  sock.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); waiters.shift()?.(l); } });
  return () => new Promise((r) => waiters.push(r));
}
const pct = (xs, p) => { const s = [...xs].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)].toFixed(3); };
const stats = (xs) => ({ n: xs.length, p50: pct(xs, 50), p99: pct(xs, 99), max: +Math.max(...xs).toFixed(3) });

const t0 = performance.now();
let ready = false;
while (!ready && performance.now() - t0 < 10000) { try { (await connect()).destroy(); ready = true; } catch { await new Promise((r) => setTimeout(r, 20)); } }
const spawnToListenMs = Math.round(performance.now() - t0);

async function oneConnection(requests) {
  const a = performance.now();
  const s = await connect();
  const next = lines(s);
  const c = performance.now();
  s.write(JSON.stringify({ ags: "hello", protocol: 1, role: "rpc" }) + "\n"); await next();
  const h = performance.now();
  const req = [];
  for (let i = 0; i < requests; i++) {
    const r0 = performance.now();
    s.write(JSON.stringify({ jsonrpc: "2.0", id: i, method: "messaging", params: { operation: "status", payload: { pad: "x".repeat(200) }, deadlineMs: 4200 } }) + "\n");
    await next(); req.push(performance.now() - r0);
  }
  const e = performance.now();
  s.end();
  return { total: e - a, connect: c - a, hello: h - c, connectHello: h - a, req };
}

for (let i = 0; i < 30; i++) await oneConnection(1); // warm-up
const totals = [], connectHello = [], connectOnly = [];
for (let i = 0; i < Number(perConn); i++) { const r = await oneConnection(1); totals.push(r.total); connectHello.push(r.connectHello); connectOnly.push(r.connect); }
const p = await oneConnection(Number(persistent));
const result = { ev: "rtt", node: process.version, spawnToListenMs,
  perConnection_connectHelloRequest: stats(totals), perConnection_connectHello: stats(connectHello), connectOnly: stats(connectOnly),
  persistent_request: stats(p.req.slice(50)) };
svc.kill();
fs.appendFileSync(root + "\\results\\rtt.jsonl", JSON.stringify(result) + "\n");
console.log(JSON.stringify(result));
process.exit(0);
