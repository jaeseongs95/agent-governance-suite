// M2/M4 service: Unix socket (0700 dir), line JSON, hello/welcome, JSON-RPC.
// mode "bare": echo only. mode "pglite": opens PGlite and runs writes through one FIFO queue.
// usage: node ipc-service.mjs <socketPath> <bare|pglite> [dataDir]
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const [sock, mode, dataDir] = process.argv.slice(2);
const QUEUE_MAX = 64;
const WAIT_LIMIT_MS = 1000;
fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
fs.chmodSync(path.dirname(sock), 0o700);
try {
  fs.unlinkSync(sock);
} catch {}

let db = null;
if (mode === "pglite") {
  const { PGlite } = await import("@electric-sql/pglite");
  db = new PGlite("file://" + dataDir);
  await db.waitReady;
  await db.exec(`create table if not exists msgs(id bigserial primary key, session int4 not null, seq int4 not null, payload text not null);
create table if not exists counters(k int4 primary key, v int8 not null);
insert into counters select g, 0 from generate_series(0,63) g on conflict do nothing;`);
}

// ---- FIFO queue in front of the single PGlite connection ----
const queue = [];
let busy = false;
let stats;
const resetStats = () => (stats = { waits: [], execs: [], done: 0, busyLen: 0, busyWait: 0, maxLen: 0, since: performance.now() });
resetStats();
function enqueue(job) {
  if (queue.length >= QUEUE_MAX) {
    stats.busyLen++;
    job.reply({ error: { code: -32001, message: "busy", data: { reason: "SERVICE_BUSY", cause: "queue_length", effect: "none" } } });
    return;
  }
  job.enq = performance.now();
  queue.push(job);
  if (queue.length > stats.maxLen) stats.maxLen = queue.length;
  if (!busy) drain();
}
async function drain() {
  busy = true;
  while (queue.length) {
    const job = queue.shift();
    const start = performance.now();
    const wait = start - job.enq;
    stats.waits.push(wait);
    if (wait > WAIT_LIMIT_MS) {
      stats.busyWait++;
      job.reply({ error: { code: -32001, message: "busy", data: { reason: "SERVICE_BUSY", cause: "queue_wait", effect: "none" } } });
      continue;
    }
    try {
      const result = await job.run();
      stats.execs.push(performance.now() - start);
      stats.done++;
      job.reply({ result: { ...result, waitMs: wait } });
    } catch (e) {
      job.reply({ error: { code: -32000, message: String(e.message).slice(0, 200) } });
    }
  }
  busy = false;
}
const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 100) / 100;
};
function vm(key) {
  const m = new RegExp(key + ":\\s+(\\d+)").exec(fs.readFileSync("/proc/self/status", "utf8"));
  return m ? Math.round(Number(m[1]) / 102.4) / 10 : null;
}

let connections = 0;
const server = net.createServer((s) => {
  connections++;
  let buf = "";
  let hello = false;
  const helloTimer = setTimeout(() => s.destroy(), 1000);
  const send = (o) => s.write(JSON.stringify(o) + "\n");
  s.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        s.destroy();
        return;
      }
      if (!hello) {
        if (msg.ags !== "hello") return s.destroy();
        hello = true;
        clearTimeout(helloTimer);
        send({ ags: "welcome", protocol: 1, service: { version: "measure", pid: process.pid, mode } });
        continue;
      }
      const reply = (r) => send({ jsonrpc: "2.0", id: msg.id, ...r });
      if (msg.method === "echo") reply({ result: msg.params ?? null });
      else if (msg.method === "write") {
        const p = msg.params;
        enqueue({
          reply,
          run: async () => {
            await db.transaction(async (tx) => {
              for (let j = 0; j < 3; j++)
                await tx.query("insert into msgs(session,seq,payload) values($1,$2,$3)", [p.session, p.seq * 3 + j, "m".repeat(300)]);
              await tx.query("update counters set v=v+1 where k=$1", [p.session % 64]);
            });
            return { ok: true };
          },
        });
      } else if (msg.method === "status") {
        const el = (performance.now() - stats.since) / 1000;
        reply({
          result: {
            pid: process.pid,
            connections,
            rssMB: Math.round((process.memoryUsage().rss / 1048576) * 10) / 10,
            hwmMB: vm("VmHWM"),
            queueLen: queue.length,
            maxLen: stats.maxLen,
            done: stats.done,
            throughputPerS: Math.round((stats.done / el) * 10) / 10,
            waitP50: pct(stats.waits, 50),
            waitP99: pct(stats.waits, 99),
            waitMax: stats.waits.length ? Math.round(Math.max(...stats.waits) * 100) / 100 : null,
            waitOver1s: stats.waits.filter((w) => w > 1000).length,
            execP50: pct(stats.execs, 50),
            execP99: pct(stats.execs, 99),
            busyLen: stats.busyLen,
            busyWait: stats.busyWait,
          },
        });
        if (msg.params?.reset) resetStats();
      } else if (msg.method === "shutdown") {
        reply({ result: { bye: true } });
        setTimeout(async () => {
          server.close();
          if (db) await db.close();
          process.exit(0);
        }, 10);
      } else reply({ error: { code: -32601, message: "no method" } });
    }
  });
  s.on("close", () => {
    connections--;
    clearTimeout(helloTimer);
  });
  s.on("error", () => {});
});
server.maxConnections = 256;
server.listen(sock);
