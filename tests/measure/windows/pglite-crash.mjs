// M1 parent: repeat {start child in crash mode -> taskkill /F at a random moment}; each next open verifies the previous kill.
// Committed-row loss = next open's max < last "C n" the child printed. Damage = open failure, non-contiguous rows, amcheck failure.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";

const [bundle, dataDir, cyclesStr = "100", out, deadlineMinStr = "40"] = process.argv.slice(2);
const deadline = Date.now() + Number(deadlineMinStr) * 60000;
const log = (o) => fs.appendFileSync(out, JSON.stringify({ t: Date.now(), ...o }) + "\n");
const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));

function runChild(mode, killPlan) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bundle, mode, dataDir], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const r = { pid: child.pid, open: null, lastC: 0, killedAt: null, phaseAtKill: null, stderr: "" };
    let buf = "", timer = null;
    const kill = () => {
      if (r.killedAt !== null) return;
      r.phaseAtKill = r.lastC > 0 ? "writing" : r.open ? "opened" : "starting";
      r.killedAt = Date.now();
      try { execFileSync("taskkill", ["/F", "/PID", String(child.pid)], { stdio: "ignore" }); } catch (e) { r.killError = String(e.status); }
    };
    if (killPlan?.kind === "startup") timer = setTimeout(kill, killPlan.ms);
    const hang = setTimeout(() => { r.hang = true; kill(); }, 90000);
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.startsWith("C ")) {
          r.lastC = Number(line.slice(2));
          if (killPlan?.kind === "writing" && !timer) timer = setTimeout(kill, killPlan.ms);
        } else { try { const o = JSON.parse(line); if (o.ev === "open") r.open = o; } catch { r.junk = line.slice(0, 200); } }
      }
    });
    child.stderr.on("data", (d) => { if (r.stderr.length < 2000) r.stderr += d; });
    child.on("exit", (code, signal) => { clearTimeout(timer); clearTimeout(hang); r.exitCode = code; r.signal = signal; resolve(r); });
  });
}

let prevLastC = null, cycles = 0, lost = 0, damaged = 0, openFail = 0;
const openMs = [];
for (let i = 1; i <= Number(cyclesStr) && Date.now() < deadline; i++) {
  const plan = i % 5 === 0 ? { kind: "startup", ms: rand(50, 2500) } : { kind: "writing", ms: rand(30, 1500) };
  const r = await runChild("crash", plan);
  cycles = i;
  const o = r.open;
  const loss = o && prevLastC !== null && o.max < prevLastC;
  const bad = o && (!o.contiguous || o.btreeOk !== true || o.heapCorruptRows !== 0);
  if (!o && (r.hang || r.killedAt === null)) openFail++; // a planned startup kill before "open" is not a failure
  if (loss) lost++;
  if (bad) damaged++;
  if (o) openMs.push(o.openMs);
  log({ ev: "cycle", i, plan, prevLastC, open: o, lastC: r.lastC, phaseAtKill: r.phaseAtKill, exitCode: r.exitCode, hang: r.hang ?? false,
    loss: Boolean(loss), damaged: Boolean(bad), stderr: o ? undefined : r.stderr, junk: r.junk });
  // The rows the next open must contain: what this child reported as committed (a startup kill keeps the previous floor).
  prevLastC = r.lastC > 0 ? r.lastC : (o ? o.max : prevLastC);
}
const final = await runChild("verify", null);
const fo = final.open;
const finalLoss = fo && prevLastC !== null && fo.max < prevLastC;
const s = [...openMs].sort((a, b) => a - b);
const summary = { ev: "summary", cycles, openFail, lost: lost + (finalLoss ? 1 : 0), damaged: damaged + (fo && (!fo.contiguous || fo.btreeOk !== true || fo.heapCorruptRows) ? 1 : 0),
  final: fo ?? { stderr: final.stderr }, lastCommitted: prevLastC,
  reopenMs: s.length ? { p50: s[Math.floor(s.length / 2)], max: s[s.length - 1] } : null };
log(summary);
console.log(JSON.stringify(summary));
