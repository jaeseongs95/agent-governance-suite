// M1 PGlite child (bundled by esbuild into one .mjs; pglite.wasm, initdb.wasm, pglite.data sit beside it).
// mode init  : open an empty dataDir, report first-init time and RSS, close.
// mode crash : open (recovery after a kill), verify rows and indexes, then insert forever, printing "C <n>" after each commit.
// mode verify: open, verify, close.
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { amcheck } from "@electric-sql/pglite/contrib/amcheck";

const [mode, dataDir] = process.argv.slice(2);
const out = (o) => fs.writeSync(1, JSON.stringify(o) + "\n");
const rss = () => Math.round(process.memoryUsage().rss / 1048576);
const rssBefore = rss();
const t0 = performance.now();
const db = await PGlite.create(dataDir, { extensions: { amcheck } });
const openMs = Math.round(performance.now() - t0);
const rssOpen = rss();

async function verify() {
  await db.exec("CREATE TABLE IF NOT EXISTS t (n integer PRIMARY KEY, pad text NOT NULL); CREATE EXTENSION IF NOT EXISTS amcheck;");
  const r = (await db.query("SELECT count(*)::int AS c, coalesce(max(n),0)::int AS m, coalesce(sum(n),0)::text AS s FROM t")).rows[0];
  let idx; // bt_index_check returns void and raises on corruption
  try { await db.query("SELECT bt_index_check('t_pkey'::regclass, true)"); idx = true; } catch (e) { idx = String(e.message); }
  const heap = (await db.query("SELECT count(*)::int AS bad FROM verify_heapam('t')")).rows[0].bad;
  const contiguous = r.c === r.m && BigInt(r.s) === (BigInt(r.m) * BigInt(r.m + 1)) / 2n;
  return { count: r.c, max: r.m, contiguous, btreeOk: idx, heapCorruptRows: heap };
}

if (mode === "init") {
  await db.query("SELECT 1");
  out({ ev: "init", openMs, rssBeforeMb: rssBefore, rssOpenMb: rssOpen, rssAfterQueryMb: rss(), version: (await db.query("SELECT version() AS v")).rows[0].v });
  const c0 = performance.now(); await db.close(); out({ ev: "closed", closeMs: Math.round(performance.now() - c0) });
} else if (mode === "verify") {
  out({ ev: "open", openMs, rssOpenMb: rssOpen, ...(await verify()) });
  await db.close();
} else if (mode === "crash") {
  const v = await verify();
  out({ ev: "open", openMs, rssOpenMb: rssOpen, ...v });
  let n = v.max;
  for (;;) {
    n++;
    await db.query("INSERT INTO t VALUES ($1, $2)", [n, "x".repeat(200)]);
    fs.writeSync(1, "C " + n + "\n");
  }
}
