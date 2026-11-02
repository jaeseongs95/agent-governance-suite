// M1 PGlite basic: first init, second open, RSS, 10k writes, int8 type. One-off measurement script.
// usage: node m1-basic.mjs <dataDir>
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import { execSync } from "node:child_process";

const dir = process.argv[2];
fs.rmSync(dir, { recursive: true, force: true });
const mb = () => Math.round((process.memoryUsage().rss / 1048576) * 10) / 10;
const hwm = () => {
  const m = /VmHWM:\s+(\d+)/.exec(fs.readFileSync("/proc/self/status", "utf8"));
  return m ? Math.round(Number(m[1]) / 102.4) / 10 : null;
};
const out = { node: process.version, rssStart: mb() };

let t = performance.now();
let db = new PGlite("file://" + dir);
await db.waitReady;
out.firstInitMs = Math.round(performance.now() - t);
out.rssAfterInit = mb();
await db.exec(
  "create table t(id bigserial primary key, n int8 not null, payload text not null, h text not null)",
);
await db.close();
out.dataDirAfterInit = execSync(`du -sh ${dir}`).toString().split("\t")[0];

t = performance.now();
db = new PGlite("file://" + dir);
await db.waitReady;
out.secondOpenMs = Math.round(performance.now() - t);
out.rssAfterSecondOpen = mb();

t = performance.now();
for (let i = 0; i < 10000; i++) {
  const p = "x".repeat(200) + i;
  await db.query("insert into t(n,payload,h) values($1,$2,md5($2))", [i, p]);
}
out.insert10kAutocommitMs = Math.round(performance.now() - t);
out.rssAfter10k = mb();

const r = await db.query(
  "select 1::int8 a, 9007199254740993::int8 b, (select id from t order by id limit 1) id, (select n from t order by id limit 1) n, 1::int4 c",
);
const row = r.rows[0];
out.int8 = Object.fromEntries(
  Object.entries(row).map(([k, v]) => [k, { type: typeof v, value: String(v) }]),
);
await db.close();
out.rssPeakHWM = hwm();
out.dataDirAfter10k = execSync(`du -sh ${dir}`).toString().split("\t")[0];
console.log(JSON.stringify(out));
