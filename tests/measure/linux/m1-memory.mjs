// M1 memory: node m1-memory.mjs <dataDir> ["k=v;k=v" postgresqlconf] [initialMemory MiB]
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
const rss = () => { const s = readFileSync("/proc/self/status","utf8"); const g = k => Math.round(+s.match(new RegExp(k+":\s+(\d+)"))[1]/1024); return { rss: g("VmRSS"), hwm: g("VmHWM") }; };
const [dir, conf, initMem] = [process.argv[2], process.argv[3] || "", process.argv[4]];
const opts = { dataDir: dir };
if (conf) opts.postgresqlconf = conf.split(";");
if (initMem) opts.initialMemory = Number(initMem) * 1024 * 1024;
const t0 = Date.now(); const db = new PGlite(opts); await db.waitReady; const tOpen = Date.now() - t0; const a = rss();
await db.exec("CREATE TABLE IF NOT EXISTS t (id serial primary key, v text)");
for (let i = 0; i < 2000; i++) await db.query("INSERT INTO t (v) VALUES ($1)", ["x".repeat(200)]);
const sb = (await db.query("SHOW shared_buffers")).rows[0];
const b = rss(); await db.close();
console.log(JSON.stringify({ conf, initMem: initMem ?? null, openMs: tOpen, afterOpen: a, after2k: b, shared_buffers: sb }));
