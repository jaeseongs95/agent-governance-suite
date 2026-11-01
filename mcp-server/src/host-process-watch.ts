import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tagProducerFailure } from "./failure-diagnostics.js";

/**
 * The relay's only process-identity need: has its host process ended? (docs/ags30-broker-redesign.md 3.4)
 * Nothing here runs inside a hook, MCP request or test deadline. A start token has the format earlier adapters already
 * produce: Linux /proc starttime ticks, Windows StartTime.ToUniversalTime().ToString('o'), other POSIX `ps -o lstart=`.
 *
 * - Linux: starttime is read every poll and compared, so a reused PID (different starttime) ends the watch.
 * - Windows: one PowerShell child opens the host handle first, reads StartTime through that handle and waits for exit.
 *   While a handle is open the process object, and so its PID, cannot be reused (PROCESS_INFORMATION, "Terminating a
 *   Process"). The child also exits when the relay is gone, so it is not left behind.
 *   ponytail: about 52 MB private memory per relay (measured, Windows Server 2022); a compiled OpenProcess/
 *   WaitForSingleObject helper costs about 9.5 MB if this becomes a limit.
 * - aliveAt: a bound at which the host was certainly alive (the spawning hook's own start). A host born later is a
 *   different process that took the PID after the host ended, so the watch refuses it.
 */
export interface HostWatch {
  /** Resolves with the host start token once the watcher holds the host; rejects with a fixed reason. */
  readonly bound: Promise<string>;
  /** Resolves with a fixed reason when the host ended or its PID now names another process. */
  readonly exited: Promise<string>;
  close(): void;
}

export const HOST_WATCH_POLL_MS = 5000;

const reason = (code: string, message: string, cause?: unknown) => tagProducerFailure(new Error(message, { cause }), code);

/**
 * Linux /proc starttime (field 22, clock ticks since boot) of a process that has not ended: monotonic and never a wall
 * clock. A zombie (state Z) or dead (X, x) entry still has its stat file until it is reaped, but the process has ended,
 * so it has no live start (proc(5), field 3 state).
 */
export function linuxStartTicks(stat: string): string | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
  if (fields[0] === "Z" || fields[0] === "X" || fields[0] === "x") return null;
  return fields[19] ?? null;
}

/** The bound the spawning hook passes: its own start, in the same clock the watcher compares on this platform. */
export function hostAliveAtBound(platform: NodeJS.Platform = process.platform): string {
  if (platform === "linux") {
    try { return linuxStartTicks(readFileSync("/proc/self/stat", "utf8")) ?? ""; } catch { return ""; }
  }
  return String(Math.floor(performance.timeOrigin));
}

/**
 * The watcher's bound check outside the watcher: was a bound start token born no later than a hook's `hostAliveAtBound`?
 * Linux compares boot ticks; Windows ISO and other POSIX lstart compare as wall time with the hook's start in ms.
 * An unreadable pair proves nothing and answers false.
 */
export function startNotAfter(token: string, aliveAt: string): boolean {
  if (/^[0-9]{1,20}$/u.test(token) && /^[0-9]{1,20}$/u.test(aliveAt)) return BigInt(token) <= BigInt(aliveAt);
  const at = Date.parse(token);
  return /^[0-9]{1,16}$/u.test(aliveAt) && Number.isFinite(at) && at <= Number(aliveAt);
}

export function watchHostProcess(pid: number, aliveAt: string | undefined, options: {
  platform?: NodeJS.Platform; pollMs?: number; ownerPid?: number;
} = {}): HostWatch {
  const platform = options.platform ?? process.platform;
  if (!Number.isSafeInteger(pid) || pid < 1) throw reason("HOST_PID_INVALID", "The host process id is invalid.");
  return platform === "win32" ? windowsWatch(pid, aliveAt, options.ownerPid ?? process.pid) : pollingWatch(pid, aliveAt, platform, options.pollMs ?? HOST_WATCH_POLL_MS);
}

function settle() {
  let resolveBound!: (token: string) => void, rejectBound!: (error: Error) => void, resolveExit!: (code: string) => void;
  const bound = new Promise<string>((resolve, reject) => { resolveBound = resolve; rejectBound = reject; });
  const exited = new Promise<string>((resolve) => { resolveExit = resolve; });
  bound.catch(() => {});
  return { bound, exited, resolveBound, rejectBound, resolveExit };
}

function pollingWatch(pid: number, aliveAt: string | undefined, platform: NodeJS.Platform, pollMs: number): HostWatch {
  const state = settle();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let token: string | null = null;
  const read = async (): Promise<string | null> => {
    if (platform === "linux") {
      try { return linuxStartTicks(await readFile(`/proc/${pid}/stat`, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    }
    return await new Promise((resolve, reject) => execFile("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", windowsHide: true },
      (error, stdout) => { if (error && (error as { code?: unknown }).code === 1) resolve(null); else if (error) reject(error); else resolve(stdout.trim() || null); }));
  };
  const end = (code: string) => { if (closed) return; closed = true; clearTimeout(timer); state.resolveExit(code); };
  const poll = async () => {
    try {
      const current = await read();
      if (closed) return;
      if (token === null) {
        if (current === null) { state.rejectBound(reason("HOST_PROCESS_GONE", "The host process ended before the relay bound it.")); end("HOST_PROCESS_GONE"); return; }
        // Linux compares boot ticks; other POSIX lstart has no comparable bound, so only Linux refuses a later birth.
        if (platform === "linux" && aliveAt && Number(current) > Number(aliveAt)) {
          state.rejectBound(reason("HOST_BORN_AFTER_BOUND", "The process with the host PID started after the hook; the host had ended."));
          end("HOST_BORN_AFTER_BOUND"); return;
        }
        token = current;
        state.resolveBound(current);
      } else if (current !== token) { end(current === null ? "HOST_PROCESS_ENDED" : "HOST_IDENTITY_CHANGED"); return; }
    } catch (error) {
      if (token === null) state.rejectBound(reason("HOST_WATCH_FAILED", "The host process could not be observed.", error));
      end("HOST_WATCH_FAILED"); return;
    }
    timer = setTimeout(() => { void poll(); }, pollMs);
    timer.unref();
  };
  void poll();
  return { bound: state.bound, exited: state.exited, close: () => end("HOST_WATCH_CLOSED") };
}

/** Handle first, then StartTime from that handle, then the bound check, then wait. Relay gone: exit 3. */
export function windowsWatchScript(pid: number, aliveAtMs: number | null, ownerPid: number): string {
  return [
    `$ErrorActionPreference='Stop'`,
    `try{$p=[System.Diagnostics.Process]::GetProcessById(${pid});$null=$p.Handle}catch [System.ArgumentException]{[Console]::Out.WriteLine('GONE');exit 0}catch{[Console]::Out.WriteLine('DENIED');exit 0}`,
    `$s=$p.StartTime.ToUniversalTime()`,
    ...(aliveAtMs === null ? [] : [`if(([DateTimeOffset]$s).ToUnixTimeMilliseconds() -gt ${aliveAtMs}){[Console]::Out.WriteLine('LATE');exit 0}`]),
    `[Console]::Out.WriteLine('OK '+$s.ToString('o'));[Console]::Out.Flush()`,
    `while(-not $p.WaitForExit(${HOST_WATCH_POLL_MS})){if(-not (Get-Process -Id ${ownerPid} -ErrorAction SilentlyContinue)){exit 3}}`,
    `[Console]::Out.WriteLine('EXIT');exit 0`,
  ].join(";");
}

function windowsWatch(pid: number, aliveAt: string | undefined, ownerPid: number): HostWatch {
  const state = settle();
  const bound = aliveAt && /^[0-9]{1,16}$/u.test(aliveAt) ? Number(aliveAt) : null;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsWatchScript(pid, bound, ownerPid)],
    { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  let bound_ = false;
  let closed = false;
  const end = (code: string) => { if (closed) return; closed = true; state.resolveExit(code); };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    if (bound_ || !output.includes("\n")) return;
    const line = output.split(/\r?\n/u)[0]!.trim();
    if (line.startsWith("OK ")) { bound_ = true; state.resolveBound(line.slice(3)); return; }
    const code = line === "GONE" ? "HOST_PROCESS_GONE" : line === "LATE" ? "HOST_BORN_AFTER_BOUND" : line === "DENIED" ? "HOST_WATCH_DENIED" : "HOST_WATCH_FAILED";
    state.rejectBound(reason(code, "The relay could not bind its host process."));
    end(code);
  });
  child.once("error", (error) => {
    if (!bound_) state.rejectBound(reason("HOST_WATCH_FAILED", "The host watcher could not start.", error));
    end("HOST_WATCH_FAILED");
  });
  child.once("exit", (exitCode) => {
    if (!bound_) state.rejectBound(reason("HOST_WATCH_FAILED", "The host watcher ended before it bound the host."));
    end(bound_ && exitCode === 0 ? "HOST_PROCESS_ENDED" : "HOST_WATCH_FAILED");
  });
  return { bound: state.bound, exited: state.exited, close: () => { end("HOST_WATCH_CLOSED"); try { child.kill(); } catch { /* Already gone. */ } } };
}
