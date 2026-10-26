import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { types } from "node:util";
import { retainFailureSecondary, tagProducerFailure } from "./failure-diagnostics.js";

export type ProcessIdentityBudget = () => number;
export type ProcessIdentityFailureObserver = (cause: unknown, diagnostic: Readonly<{
  stage: "windows-query" | "posix-query" | "proc-read";
  elapsedMs: number; timeoutMs: number | null; nativeCode: string | null;
  status: number | null; signal: string | null; stderrIndication: string | null;
}>) => void;

function tokenCommand(pid: number, platform: NodeJS.Platform): [string, string[]] {
  return platform === "win32" ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().ToString('o')`]]
    : ["ps", ["-p", String(pid), "-o", "lstart="]];
}

function tokenOptions(platform: NodeJS.Platform, timeoutMs?: number) {
  const cap = platform === "win32" ? 5000 : 3000;
  return { encoding: "utf8" as const, windowsHide: true, timeout: Math.min(cap, Math.floor(timeoutMs ?? cap)),
    maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
}

function identityFailure(error: unknown, platform: NodeJS.Platform, started: number, timeoutMs: number | undefined,
  observer?: ProcessIdentityFailureObserver, capturedStderr?: unknown): null {
  const cause = error && (typeof error === "object" || typeof error === "function") ? error : new Error("Process identity query failed.", { cause: error });
  tagProducerFailure(cause as Error, "PROCESS_START_TOKEN_FAILED");
  const field = (key: string): unknown => {
    try { return types.isProxy(cause) ? undefined : Object.getOwnPropertyDescriptor(cause, key)?.value; } catch { return undefined; }
  };
  const nativeCode = field("code"), status = field("status") ?? (typeof nativeCode === "number" ? nativeCode : undefined), signal = field("signal"), raw = capturedStderr ?? field("stderr");
  const stderr = Buffer.isBuffer(raw) ? raw.subarray(0, 4096).toString("utf8") : typeof raw === "string" ? raw.slice(0, 4096) : "";
  const diagnostic = Object.freeze({
    stage: platform === "win32" ? "windows-query" as const : platform === "linux" ? "proc-read" as const : "posix-query" as const,
    elapsedMs: Math.max(0, performance.now() - started), timeoutMs: platform === "linux" ? null : tokenOptions(platform, timeoutMs).timeout,
    nativeCode: typeof nativeCode === "string" && ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ENOBUFS", "EIO", "EINVAL", "ESRCH", "ABORT_ERR"].includes(nativeCode) ? nativeCode : null,
    status: typeof status === "number" && Number.isInteger(status) && Math.abs(status) <= 2147483648 ? status : null,
    signal: typeof signal === "string" && ["SIGTERM", "SIGKILL", "SIGINT", "SIGBREAK", "SIGHUP", "SIGABRT"].includes(signal) ? signal : null,
    // A fixed indication, never native error text or proof of the underlying OS cause.
    stderrIndication: /UnauthorizedAccessException|PermissionDenied|AccessDenied/u.test(stderr) ? "permission-denied-indication" : stderr ? "unclassified" : null,
  });
  try { process.stderr.write("[agent-governance-suite] process-identity-failure " + JSON.stringify(diagnostic) + "\n"); }
  catch (secondary) { retainFailureSecondary(cause, secondary); }
  try { observer?.(cause, diagnostic); }
  catch (secondary) { retainFailureSecondary(cause, secondary); }
  return null;
}

function procToken(stat: string): string | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
  return fields[19] ?? null;
}

/** Returns an OS process creation token when the platform exposes one without native dependencies. */
export function processStartToken(pid: number, platform: NodeJS.Platform = process.platform, timeoutMs?: number,
  onFailure?: ProcessIdentityFailureObserver): string | null {
  if (!Number.isInteger(pid) || pid < 1) return null;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 1)) return null;
  const started = performance.now();
  try {
    if (platform === "linux") {
      return procToken(readFileSync(`/proc/${pid}/stat`, "utf8"));
    }
    const [executable, args] = tokenCommand(pid, platform);
    return execFileSync(executable, args, tokenOptions(platform, timeoutMs)).trim() || null;
  } catch (error) {
    return identityFailure(error, platform, started, timeoutMs, onFailure);
  }
}

/** Broker request queries yield the event loop; sync callers retain the original API. */
export async function processStartTokenAsync(pid: number, platform: NodeJS.Platform = process.platform, timeoutMs?: number,
  onFailure?: ProcessIdentityFailureObserver, signal?: AbortSignal): Promise<string | null> {
  if (!Number.isInteger(pid) || pid < 1 || (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 1))) return null;
  const started = performance.now();
  if (platform === "linux") {
    try { return procToken(await readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal })); }
    catch (error) { return identityFailure(error, platform, started, timeoutMs, onFailure); }
  }
  const [executable, args] = tokenCommand(pid, platform);
  try {
    return await new Promise(resolve => execFile(executable, args, { ...tokenOptions(platform, timeoutMs), signal }, (error, stdout, stderr) => {
      resolve(error ? identityFailure(error, platform, started, timeoutMs, onFailure, stderr) : stdout.trim() || null);
    }));
  } catch (error) { return identityFailure(error, platform, started, timeoutMs, onFailure); }
}

export function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type ProcessIdentityState = "match" | "mismatch" | "unknown";

export function processIdentityState(
  pid: number,
  expectedStartToken: string,
  readStartToken: (targetPid: number) => string | null = processStartToken,
): ProcessIdentityState {
  if (!expectedStartToken) return "mismatch";
  if (!processExists(pid)) return "mismatch";
  const actual = readStartToken(pid);
  if (actual === null) return "unknown";
  return actual === expectedStartToken ? "match" : "mismatch";
}

export function processStillMatches(pid: number, expectedStartToken: string): boolean {
  return processIdentityState(pid, expectedStartToken) === "match";
}
