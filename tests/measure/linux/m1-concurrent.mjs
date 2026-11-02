// M1 two processes opening the same dataDir. Writer A starts; after READY, writer B opens the same dir.
// Both write for a while, then both are SIGKILLed and a verify run checks the result.
// usage: node m1-concurrent.mjs <dataDir> <writeSecondsBoth>
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [dir, secsArg] = process.argv.slice(2);
const secs = Number(secsArg ?? 3);
fs.rmSync(dir, { recursive: true, force: true });

function start(tag) {
  const c = spawn(process.execPath, [path.join(here, "m1-writer.mjs"), dir, tag], { stdio: ["ignore", "pipe", "pipe"] });
  const s = { tag, ready: false, readySeq: null, commits: 0, last: null, stderr: "", exit: null };
  let buf = "";
  c.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.startsWith("READY ")) {
        s.ready = true;
        s.readySeq = Number(line.slice(6));
      } else if (line.startsWith("C ")) {
        s.commits++;
        s.last = Number(line.slice(2));
      }
    }
  });
  c.stderr.on("data", (d) => (s.stderr += d));
  c.on("exit", (code, sig) => (s.exit = { code, sig }));
  return { c, s };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const a = start("A");
while (!a.s.ready && !a.s.exit) await sleep(20);
await sleep(500);
const b = start("B");
const tB = performance.now();
while (!b.s.ready && !b.s.exit && performance.now() - tB < 30000) await sleep(20);
const bOpenMs = Math.round(performance.now() - tB);
const aBefore = a.s.commits;
await sleep(secs * 1000);
for (const x of [a, b]) if (!x.s.exit) x.c.kill("SIGKILL");
await sleep(300);
const maxLast = Math.max(a.s.last ?? 0, b.s.last ?? 0);
let v;
try {
  v = JSON.parse(
    execFileSync(process.execPath, [path.join(here, "m1-verify.mjs"), dir, "0"], { timeout: 120000 }).toString().trim().split("\n").pop(),
  );
} catch (e) {
  v = { verifyFailed: String(e.message).slice(0, 300) };
}
// writer column tells which process wrote each row; count duplicates / overlaps
let overlap = null;
try {
  overlap = execFileSync(process.execPath, [
    "-e",
    `import("@electric-sql/pglite").then(async({PGlite})=>{const db=new PGlite("file://${dir}");await db.waitReady;const r=await db.query("select writer, count(*)::int4 c, min(seq)::int4 mn, max(seq)::int4 mx from k group by writer order by writer");console.log(JSON.stringify(r.rows));await db.close()}).catch(e=>console.log(JSON.stringify({err:String(e.message).slice(0,200)})))`,
  ], { cwd: here, timeout: 120000 }).toString().trim();
} catch (e) {
  overlap = "failed: " + String(e.message).slice(0, 200);
}
for (const x of [a, b]) x.s.stderr = x.s.stderr.slice(0, 400);
console.log(JSON.stringify({ A: a.s, B: b.s, bOpenMs, aCommitsBeforeB: aBefore, aCommitsWhileB: a.s.commits - aBefore, maxLast, verify: v, perWriter: overlap }));
