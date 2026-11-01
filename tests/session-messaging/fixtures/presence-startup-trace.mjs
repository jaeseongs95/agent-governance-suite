import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

// Disposable child only: never print arguments, results, messages or paths.
// 3.0 has no broker, TLS listener or key generation (docs/ags30-broker-redesign.md 3.1). The one PowerShell child left
// is the relay's host watcher (3.4); a PowerShell child created by any other caller during startup is the regression
// this trace makes visible.
const origin = performance.now();
const prefix = "AGS_PRESENCE_STARTUP ";
const safeCodes = new Set(["ETIMEDOUT", "ENOENT", "EACCES", "EPERM", "EINTR", "ENOBUFS", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]);
let calls = 0;
process.stderr.on("error", () => {}); // A diagnostic pipe failure must not terminate the traced process.
function emit(record) {
  try { process.stderr.write(prefix + JSON.stringify(record) + "\n"); }
  catch { /* An observation cannot change a native call's result. */ }
}
function safeCode(error) {
  try {
    const value = Object.getOwnPropertyDescriptor(error, "code")?.value;
    return safeCodes.has(value) ? value : null;
  } catch { return null; }
}
emit({ event: "preload", atMs: performance.now() - origin });
if (process.platform === "win32") {
  const isPowerShell = file => typeof file === "string" && /(?:^|[\\/])powershell(?:\.exe)?$/iu.test(file);
  const describe = args => {
    const command = Array.isArray(args[0]) ? args[0] : [];
    const script = command.at(-1);
    const stack = new Error().stack ?? "";
    const caller = stack.includes("host-process-watch.") ? "host-watch"
      : stack.includes("session-message-relay.") ? "relay"
      : stack.includes("session-message-hook.") ? "hook" : "unknown";
    return { caller, kind: typeof script === "string" && script.includes("GetProcessById") ? "host-handle" : "other" };
  };
  const traceSync = native => function (file, ...args) {
    if (!isPowerShell(file) || calls >= 8) return Reflect.apply(native, this, [file, ...args]);
    const call = ++calls;
    emit({ event: "powershell-start", call, atMs: performance.now() - origin, ...describe(args) });
    const started = performance.now();
    try {
      const result = Reflect.apply(native, this, [file, ...args]);
      emit({ event: "powershell-end", call, atMs: performance.now() - origin, durationMs: performance.now() - started, outcome: "return", code: null });
      return result;
    } catch (error) {
      emit({ event: "powershell-end", call, atMs: performance.now() - origin, durationMs: performance.now() - started, outcome: "throw", code: safeCode(error) });
      throw error;
    }
  };
  const traceAsync = native => function (file, ...args) {
    if (!isPowerShell(file) || calls >= 8) return Reflect.apply(native, this, [file, ...args]);
    const call = ++calls;
    emit({ event: "powershell-start", call, atMs: performance.now() - origin, ...describe(args) });
    const started = performance.now();
    const child = Reflect.apply(native, this, [file, ...args]);
    child.once("error", error => emit({ event: "powershell-end", call, atMs: performance.now() - origin,
      durationMs: performance.now() - started, outcome: "throw", code: safeCode(error) }));
    child.once("exit", () => emit({ event: "powershell-end", call, atMs: performance.now() - origin,
      durationMs: performance.now() - started, outcome: "exit", code: null }));
    return child;
  };
  childProcess.execFileSync = traceSync(childProcess.execFileSync);
  childProcess.spawnSync = traceSync(childProcess.spawnSync);
  childProcess.spawn = traceAsync(childProcess.spawn);
  childProcess.execFile = traceAsync(childProcess.execFile);
  syncBuiltinESMExports();
}
