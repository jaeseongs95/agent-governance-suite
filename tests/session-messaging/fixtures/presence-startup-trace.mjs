import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import path from "node:path";
import crypto from "node:crypto";
import tls from "node:tls";

// Disposable child only: never print arguments, results, messages or paths.
const origin = performance.now();
const prefix = "AGS_PRESENCE_STARTUP ";
const stateIndex = process.argv.indexOf("--state-directory");
const state = stateIndex >= 0 ? process.argv[stateIndex + 1] : undefined;
// Parent owns this disposable directory; no path or query content is printed.
const phaseFile = state ? path.resolve(state, "startup-query-phases.log").replace(/'/gu, "''") : null;
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
  const stage = event => emit({ event, atMs: performance.now() - origin });
  const nativeKeyPair = crypto.generateKeyPairSync;
  crypto.generateKeyPairSync = function (...args) {
    stage("keygen-start");
    const result = Reflect.apply(nativeKeyPair, this, args);
    stage("keygen-end");
    return result;
  };
  const nativeCreateServer = tls.createServer;
  tls.createServer = function (...args) {
    stage("tls-create");
    const server = Reflect.apply(nativeCreateServer, this, args);
    stage("tls-created");
    server.once("listening", () => stage("tls-listening"));
    return server;
  };
  const nativeExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = function (file, ...args) {
    if (typeof file !== "string" || !/(?:^|[\\/])powershell(?:\.exe)?$/iu.test(file) || calls >= 8) {
      return Reflect.apply(nativeExecFileSync, this, [file, ...args]);
    }
    const call = ++calls;
    const command = Array.isArray(args[0]) ? args[0] : [];
    const script = command.at(-1);
    const query = typeof script === "string" && /^\[System\.Diagnostics\.Process\]::GetProcessById\(([1-9][0-9]*)\)\.StartTime\.ToUniversalTime\(\)\.ToString\('o'\)$/u.exec(script);
    const stack = new Error().stack ?? "";
    const caller = stack.includes("broker-process-lock.") ? "broker-lock"
      : stack.includes("session-message-broker.") ? "relay-sync"
      : stack.includes("session-message-hook.") ? "hook-sync" : "unknown";
    const kind = query ? (Number(query[1]) === process.pid ? "self-start-token" : "peer-start-token") : "other";
    if (query && phaseFile && command.at(-2) === "-Command") {
      const mark = phase => `try { [System.IO.File]::AppendAllText('${phaseFile}', '${call}:${phase}' + [Environment]::NewLine) } catch {}`;
      // Diagnostic only: distinguish PowerShell initialization from StartTime
      // evaluation. stdout and uncaught query errors still flow to the caller.
      args[0] = [...command.slice(0, -1), `${mark("script-enter")}; try { ${script}; ${mark("query-returned")} } finally { ${mark("query-finally")} }`];
    }
    emit({ event: "powershell-start", call, atMs: performance.now() - origin, caller, kind });
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
