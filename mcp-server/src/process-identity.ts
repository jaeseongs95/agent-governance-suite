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
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString('o')`,
      ], { encoding: "utf8", windowsHide: true, timeout: 3000 }).trim() || null;
    }
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
      return fields[19] ?? null;
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 3000 }).trim() || null;
  } catch {
    return null;
  }
}

export function processStillMatches(pid: number, expectedStartToken: string | null): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return expectedStartToken === null || processStartToken(pid) === expectedStartToken;
}
