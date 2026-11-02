// M2 host emulation (Node host, e.g. Claude Code): runs the hook command through PowerShell with piped stdio,
// waits for pipe EOF ('close'), then exits. libuv puts non-detached children in its kill-on-close job.
import { spawn } from "node:child_process";
import fs from "node:fs";

const [out, timeoutMs = "20000"] = process.argv.slice(2);
const t0 = performance.now();
const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
  "$a = ConvertFrom-Json $env:AGS_HOOK_ARGS; & $env:AGS_NODE $env:AGS_HOOK $a"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
child.stdin.end();
let so = "", se = "", exitMs = null;
child.stdout.on("data", (d) => { so += d; });
child.stderr.on("data", (d) => { se += d; });
child.on("exit", () => { exitMs = Math.round(performance.now() - t0); });
const done = (timedOut) => {
  fs.writeFileSync(out, JSON.stringify({ host: "node", hostPid: process.pid, hookShellPid: child.pid, exitMs,
    closeMs: timedOut ? null : Math.round(performance.now() - t0), timedOut, stdout: so, stderr: se.slice(0, 1500) }));
  process.exit(0);
};
child.on("close", () => done(false));
setTimeout(() => { try { child.kill(); } catch { /* measurement */ } done(true); }, Number(timeoutMs));
