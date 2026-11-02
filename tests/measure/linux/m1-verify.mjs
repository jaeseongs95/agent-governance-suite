// M1 verify: reopen dataDir and check committed rows and integrity.
// usage: node m1-verify.mjs <dataDir> <lastReportedSeq>
import { PGlite } from "@electric-sql/pglite";
import { amcheck } from "@electric-sql/pglite/contrib/amcheck";

const dir = process.argv[2];
const last = Number(process.argv[3] ?? 0);
const out = { last };
let db;
try {
  const t = performance.now();
  db = new PGlite("file://" + dir, { extensions: { amcheck } });
  await db.waitReady;
  out.openMs = Math.round(performance.now() - t);
  out.open = true;
} catch (e) {
  out.open = false;
  out.openError = String(e?.message ?? e).slice(0, 300);
  console.log(JSON.stringify(out));
  process.exit(0);
}
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
try {
  const exists = await one("select to_regclass('k') is not null e");
  if (!exists.e) {
    out.tableMissing = true;
    out.lost = last > 0;
    console.log(JSON.stringify(out));
    await db.close();
    process.exit(0);
  }
  const s = await one("select count(*)::int4 c, coalesce(max(seq),0)::int4 m from k");
  out.rows = s.c;
  out.maxSeq = s.m;
  const missing = await one(
    "select count(*)::int4 c from generate_series(1,$1::int4) g where (select count(*) from k where seq=g) <> 3",
    [last],
  );
  out.missingOrPartialUpToLast = missing.c;
  const partial = await one("select count(*)::int4 c from (select seq from k group by seq having count(*)<>3) x");
  out.partialTxnsAnySeq = partial.c;
  const badHash = await one("select count(*)::int4 c from k where h <> md5(payload)");
  out.badHash = badHash.c;
  await db.exec("set enable_indexscan=off; set enable_bitmapscan=off; set enable_indexonlyscan=off");
  const seqScan = await one("select count(*)::int4 c from k where seq > 0");
  await db.exec("set enable_seqscan=off; set enable_indexscan=on; set enable_bitmapscan=on; set enable_indexonlyscan=on");
  const idxScan = await one("select count(*)::int4 c from k where seq > 0");
  await db.exec("reset all");
  out.seqVsIndexMismatch = seqScan.c !== idxScan.c;
  await db.exec("create extension if not exists amcheck");
  await db.query("select bt_index_check('k_pkey'::regclass, true)");
  out.btIndexCheck = "ok";
  const heap = await one("select count(*)::int4 c from verify_heapam('k')");
  out.verifyHeapamProblems = heap.c;
} catch (e) {
  out.checkError = String(e?.message ?? e).slice(0, 300);
}
out.lost = out.missingOrPartialUpToLast > 0;
out.corrupt =
  !!out.checkError || out.badHash > 0 || out.partialTxnsAnySeq > 0 || out.seqVsIndexMismatch || out.verifyHeapamProblems > 0;
await db.close();
console.log(JSON.stringify(out));
