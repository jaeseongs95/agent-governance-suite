// M1 SIGKILL durability loop. Parent spawns writer, SIGKILLs it at a random time, then runs verify.
// usage: node m1-kill.mjs <dataDir> <iterations> <resultJsonl>
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [dir, itersArg, outFile] = process.argv.slice(2);
const iters = Number(itersArg ?? 100);
fs.rmSync(dir, { recursive: true, force: true });
fs.writeFileSync(outFile, "");

function runWriterAndKill(delayMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, "m1-writer.mjs"), dir], { stdio: ["ignore", "pipe", "pipe"] });
    let last = null;
    let ready = false;
    let readyAtMs = null;
    let buf = "";
    let err = "";
    const t0 = performance.now();
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.startsWith("READY ")) {
          ready = true;
          readyAtMs = Math.round(performance.now() - t0);
          last = Number(line.slice(6));
        } else if (line.startsWith("C ")) last = Number(line.slice(2));
      }
    });
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), delayMs);
    child.on("exit", (code, sig) => {
      clearTimeout(timer);
      resolve({ last: last ?? 0, ready, readyAtMs, code, sig, stderr: err.slice(0, 300) });
    });
  });
}

const summary = { iters: 0, killedBeforeReady: 0, openFail: 0, lost: 0, corrupt: 0, unexpectedExit: 0 };
let prevLast = 0;
// FRESH=1: wipe dataDir before every iteration so the kill lands during the first initdb (delay 100..4500ms)
const fresh = process.env.FRESH === "1";
for (let i = 1; i <= iters; i++) {
  if (fresh) {
    fs.rmSync(dir, { recursive: true, force: true });
    prevLast = 0;
  }
  const delay = fresh ? 100 + Math.floor(Math.random() * 4400) : 100 + Math.floor(Math.random() * 2900);
  const w = await runWriterAndKill(delay);
  // last reported in this run, or the previous known value if killed before READY/first commit
  const last = Math.max(w.last, prevLast);
  let v;
  try {
    v = JSON.parse(
      execFileSync(process.execPath, [path.join(here, "m1-verify.mjs"), dir, String(last)], { timeout: 120000 })
        .toString()
        .trim()
        .split("\n")
        .pop(),
    );
  } catch (e) {
    v = { open: false, openError: "verify process failed: " + String(e.message).slice(0, 200) };
  }
  if (v.maxSeq != null) prevLast = Math.max(last, v.maxSeq);
  summary.iters++;
  if (!w.ready) summary.killedBeforeReady++;
  if (w.sig !== "SIGKILL") summary.unexpectedExit++;
  if (!v.open) summary.openFail++;
  if (v.lost) summary.lost++;
  if (v.corrupt) summary.corrupt++;
  fs.appendFileSync(outFile, JSON.stringify({ i, delay, writer: w, verify: v }) + "\n");
}
summary.finalDataDirSize = execFileSync("du", ["-sh", dir]).toString().split("\t")[0];
console.log(JSON.stringify(summary));
