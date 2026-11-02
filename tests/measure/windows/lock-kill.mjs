// D2: node:sqlite owner lock (locking_mode=EXCLUSIVE + BEGIN EXCLUSIVE, busy_timeout 0).
// How soon after `taskkill /F` of the owner can another process take the lock?
import { DatabaseSync } from "node:sqlite";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const [mode, lockPath, nStr = "50", out] = process.argv.slice(2);
let firstError = null;
function tryLock() {
  const db = new DatabaseSync(lockPath);
  try { db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;"); return db; }
  catch (e) { firstError ??= String(e.message); db.close(); return null; }
}

if (mode === "hold") {
  const db = tryLock();
  if (!db) { fs.writeSync(1, "fail\n"); process.exit(2); }
  fs.writeSync(1, "locked\n");
  setInterval(() => {}, 1e6);
} else {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const rows = [];
  for (let i = 1; i <= Number(nStr); i++) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "hold", lockPath], { stdio: ["ignore", "pipe", "ignore"] });
    const exited = new Promise((r) => child.once("exit", r));
    const first = await new Promise((r) => { let b = ""; child.stdout.on("data", (d) => { b += d; if (b.includes("\n")) r(b.trim()); }); child.once("exit", () => r("exit")); });
    if (first !== "locked") { rows.push({ i, holder: first }); continue; }
    const ctrl = tryLock();
    const controlBlocked = !ctrl;
    if (ctrl) ctrl.close();
    const t0 = performance.now();
    execFileSync("taskkill", ["/F", "/PID", String(child.pid)], { stdio: "ignore" });
    const taskkillMs = performance.now() - t0;
    let attempts = 0, got = null;
    while (!got && performance.now() - t0 < 10000) { attempts++; got = tryLock(); if (!got) Atomics.wait(sleeper, 0, 0, 1); }
    const acquiredMs = performance.now() - t0;
    got?.close();
    await exited;
    rows.push({ i, controlBlocked, taskkillMs: +taskkillMs.toFixed(2), acquiredMs: got ? +acquiredMs.toFixed(2) : null, attempts });
  }
  const ok = rows.filter((r) => r.acquiredMs != null);
  const s = ok.map((r) => r.acquiredMs).sort((x, y) => x - y);
  const pct = (p) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
  const summary = { ev: "lock-kill", n: rows.length, acquired: ok.length, controlBlockedAll: rows.every((r) => r.controlBlocked),
    firstAttemptSuccess: ok.filter((r) => r.attempts === 1).length, maxAttempts: Math.max(...ok.map((r) => r.attempts)),
    acquiredMs: { p50: pct(50), p99: pct(99), max: s[s.length - 1] }, busyError: firstError, rows };
  if (out) fs.appendFileSync(out, JSON.stringify(summary) + "\n");
  const { rows: _r, ...brief } = summary;
  console.log(JSON.stringify(brief));
}
