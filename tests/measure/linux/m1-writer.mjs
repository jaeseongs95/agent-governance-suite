// M1 writer child: writes 3 rows per transaction forever and prints "C <seq>" after each commit.
// stdout to a pipe is synchronous on Linux, so a printed seq is already committed.
// usage: node m1-writer.mjs <dataDir> [tag]
import { PGlite } from "@electric-sql/pglite";

const dir = process.argv[2];
const tag = process.argv[3] ?? "w";
const db = new PGlite("file://" + dir);
await db.waitReady;
await db.exec(
  "create table if not exists k(seq int8 not null, j int4 not null, writer text not null, payload text not null, h text not null, primary key(seq, j))",
);
const { rows } = await db.query("select coalesce(max(seq),0)::int4 m from k");
let seq = Number(rows[0].m);
process.stdout.write(`READY ${seq}\n`);
for (;;) {
  seq++;
  await db.transaction(async (tx) => {
    for (let j = 0; j < 3; j++) {
      const p = `${tag}-${seq}-${j}-` + "p".repeat(300);
      await tx.query("insert into k(seq,j,writer,payload,h) values($1,$2,$3,$4,md5($4))", [seq, j, tag, p]);
    }
  });
  process.stdout.write(`C ${seq}\n`);
}
