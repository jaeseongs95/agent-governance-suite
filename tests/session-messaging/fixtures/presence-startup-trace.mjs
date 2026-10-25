import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

// Disposable child only: never print arguments, results, messages or paths.
const origin = performance.now();
const prefix = "AGS_PRESENCE_STARTUP ";
const safeCodes = new Set(["ETIMEDOUT", "ENOENT", "EACCES", "EPERM", "EINTR", "ENOBUFS", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]);
let calls = 0;
process.stderr.on("error", () => {}); // A diagnostic pipe failure must not terminate the broker.
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
  const nativeExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = function (file, ...args) {
    if (typeof file !== "string" || !/(?:^|[\\/])powershell(?:\.exe)?$/iu.test(file) || calls >= 8) {
      return Reflect.apply(nativeExecFileSync, this, [file, ...args]);
    }
    const call = ++calls;
    emit({ event: "powershell-start", call, atMs: performance.now() - origin });
    const started = performance.now();
    try {
      const result = Reflect.apply(nativeExecFileSync, this, [file, ...args]);
      emit({ event: "powershell-end", call, atMs: performance.now() - origin,
        durationMs: performance.now() - started, outcome: "return", code: null });
      return result;
    } catch (error) {
      emit({ event: "powershell-end", call, atMs: performance.now() - origin,
        durationMs: performance.now() - started, outcome: "throw", code: safeCode(error) });
      throw error;
    }
  };
  syncBuiltinESMExports();
}
