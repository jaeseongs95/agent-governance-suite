// M2 hook emulation: starts the service the way the design does (ensureService) and waits for the first welcome.
// --mode shellexecute: same script as launchWithoutInheritedHandles (session-message-hook.ts:192-213).
// --mode cim: Win32_Process.Create through CIM (job-free candidate, D7).  --mode detached: node spawn detached (reference).
import { execFile, spawn } from "node:child_process";
import net from "node:net";

const a = {};
for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/u, "")] = process.argv[i + 1];
const pipePath = "\\\\.\\pipe\\" + a.name;
const svcArgs = [a.service, "--name", a.name, "--lock", a.lock, "--log", a.log, "--hb", a.hb, "--life", a.life ?? "120000"];

function windowsArgument(value) {
  if (value && !/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/u, "$1$1")}"`;
}
const literal = (value) => `'${value.replace(/['\u2018\u2019\u201a\u201b]/gu, "$&$&")}'`;
const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const runPs = (script, timeout) => new Promise((resolve, reject) => execFile(powershell,
  ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  { windowsHide: true, timeout }, (e, out) => (e ? reject(e) : resolve(String(out).trim()))));

async function launch(mode) {
  if (mode === "shellexecute") {
    return Number(await runPs(`$p = Start-Process -FilePath ${literal(process.execPath)} -ArgumentList ${literal(svcArgs.map(windowsArgument).join(" "))}`
      + " -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)", 5000));
  }
  if (mode === "cim") {
    const cmd = [process.execPath, ...svcArgs].map(windowsArgument).join(" ");
    const out = await runPs("$su = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; "
      + `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${literal(cmd)}; ProcessStartupInformation=$su}; `
      + "[Console]::Out.Write(\"$($r.ReturnValue) $($r.ProcessId)\")", 15000);
    const [rv, pid] = out.split(" ").map(Number);
    if (rv !== 0) throw new Error("Win32_Process.Create returned " + rv);
    return pid;
  }
  if (mode === "detached") {
    const c = spawn(process.execPath, svcArgs, { detached: true, stdio: "ignore", windowsHide: true });
    c.unref();
    return c.pid;
  }
  throw new Error("unknown mode");
}

function hello() {
  return new Promise((resolve, reject) => {
    const s = net.connect(pipePath);
    const timer = setTimeout(() => { s.destroy(); reject(new Error("HELLO_TIMEOUT")); }, 1000);
    let buf = "";
    s.setEncoding("utf8");
    s.on("connect", () => s.write(JSON.stringify({ ags: "hello", protocol: 1, role: "rpc" }) + "\n"));
    s.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) { clearTimeout(timer); s.end(); resolve(JSON.parse(buf.slice(0, i))); }
    });
    s.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

const t0 = performance.now();
let launchedPid, launcherMs, err, welcome, attempts = 0;
try { launchedPid = await launch(a.mode); launcherMs = Math.round(performance.now() - t0); } catch (e) { err = String(e.code ?? e.message); }
const delays = [50, 100, 200, 400];
while (!err && performance.now() - t0 < 15000) {
  attempts++;
  try { welcome = await hello(); break; } catch { await new Promise((r) => setTimeout(r, delays[Math.min(attempts - 1, delays.length - 1)])); }
}
process.stdout.write(JSON.stringify({ mode: a.mode, hookPid: process.pid, launchedPid, launcherMs,
  coldStartMs: welcome ? Math.round(performance.now() - t0) : null, attempts, servicePid: welcome?.service?.pid ?? null, err: err ?? null }) + "\n");
