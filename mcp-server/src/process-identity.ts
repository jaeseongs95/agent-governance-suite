import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Returns an OS process creation token when the platform exposes one without native dependencies. */
export function processStartToken(pid: number, platform: NodeJS.Platform = process.platform): string | null {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    if (platform === "win32") {
      return execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ], { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    }
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
      return fields[19] ?? null;
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
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
