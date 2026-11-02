// M2 measurement service: owner lock (D2), named pipe line-JSON server, heartbeat file. One-off script.
import net from "node:net";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const a = {};
for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/u, "")] = process.argv[i + 1];
const pipePath = "\\\\.\\pipe\\" + a.name;
const log = (o) => fs.appendFileSync(a.log, JSON.stringify({ t: Date.now(), pid: process.pid, ...o }) + "\n");

log({ ev: "start", ppid: process.ppid, uptimeMs: Math.round(process.uptime() * 1000), probeEnv: process.env.AGS_PROBE ?? null });
let lock;
try {
  lock = new DatabaseSync(a.lock);
  lock.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
} catch (e) {
  log({ ev: "already-running", err: String(e.message) });
  process.exit(0);
}

const server = net.createServer((sock) => {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("error", () => {});
  sock.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { sock.destroy(); return; }
      if (m.ags === "hello") sock.write(JSON.stringify({ ags: "welcome", protocol: 1, service: { pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000) } }) + "\n");
      else sock.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { ok: true } }) + "\n");
    }
  });
});
server.on("error", (e) => { log({ ev: "listen-error", code: e.code, message: e.message }); process.exit(1); });
server.listen(pipePath, () => log({ ev: "listening", uptimeMs: Math.round(process.uptime() * 1000) }));
if (a.hb) setInterval(() => fs.writeFileSync(a.hb, String(Date.now())), 250);
setTimeout(() => { log({ ev: "life-end" }); process.exit(0); }, Number(a.life ?? 120000));
