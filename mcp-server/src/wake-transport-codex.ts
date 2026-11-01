import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { errorCode, type WakeDispatchOutcome, type WakeDispatchPort, type WakeLaunchObserver } from "./session-message-wake-port.js";

/** Codex rejects a queue for a thread it is not running yet; nothing was queued, and it may start shortly. */
const NO_ACTIVE_SESSION = "No active session found";

/** Codex `queue --thread` result. Spawn failure is definite; a spawned non-zero exit or timeout may have queued. */
export function codexWakeOutcome(error: unknown, spawned: boolean, stderr = ""): WakeDispatchOutcome {
  if (!error) return { result: "handed-off" };
  const code = errorCode(error);
  if (!spawned) {
    return code === "ENOENT"
      ? { result: "not-delivered", kind: "prerequisite-missing", reasonCode: "CODEX_EXECUTABLE_MISSING" }
      : { result: "not-delivered", kind: "transient", reasonCode: code ? `CODEX_SPAWN_FAILED:${code}` : "CODEX_SPAWN_FAILED" };
  }
  if (stderr.includes(NO_ACTIVE_SESSION)) return { result: "not-delivered", kind: "transient", reasonCode: "CODEX_NO_ACTIVE_SESSION" };
  const killed = Boolean(error && typeof error === "object" && "killed" in error && (error as { killed?: unknown }).killed);
  return { result: "unknown", reasonCode: killed ? "CODEX_QUEUE_TIMEOUT" : "CODEX_QUEUE_EXIT_NONZERO" };
}

/**
 * An npm-style Windows install puts only codex.cmd on PATH, which execFile cannot start without cmd.exe (CVE-2024-27980),
 * and cmd.exe would reparse the arguments. The official launcher (bin/codex.js) exports its package root to Codex and so
 * to its hooks and this relay; run that launcher with this node instead. A native codex.exe on PATH, and every other
 * platform, start as `codex`.
 */
export function codexLaunch(environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform):
  { command: string; argsPrefix: string[] } | { missing: string } {
  const root = environment.CODEX_MANAGED_PACKAGE_ROOT;
  if (platform !== "win32" || !root) return { command: "codex", argsPrefix: [] };
  const launcher = path.join(root, "bin", "codex.js");
  // An absolute root also keeps the launcher from reading as a node option.
  return path.isAbsolute(root) && existsSync(launcher) ? { command: process.execPath, argsPrefix: [launcher] }
    : { missing: "CODEX_NPM_LAUNCHER_MISSING" };
}

function ringCodex(sessionId: string, message: string, observe?: WakeLaunchObserver): Promise<WakeDispatchOutcome> {
  return new Promise((resolve) => {
    let spawned = false;
    try { observe?.("native-launch-attempt"); } catch { /* Observation never changes submission. */ }
    const launch = codexLaunch();
    if ("missing" in launch) {
      resolve({ result: "not-delivered", kind: "prerequisite-missing", reasonCode: launch.missing });
      return;
    }
    const child = execFile(launch.command, [...launch.argsPrefix, "queue", "--thread", sessionId, "--message", message],
      { windowsHide: true, timeout: 10_000 }, (error, _stdout, stderr) => resolve(codexWakeOutcome(error, spawned, String(stderr ?? ""))));
    child.once("spawn", () => {
      spawned = true;
      try { observe?.("native-spawn"); } catch { /* Observation never changes the outcome. */ }
    });
  });
}

/** Persistent host queue: a held marker survives, so a resend is useful only after a longer wait (design 3.2). */
export const codexQueueWakePort: WakeDispatchPort = {
  capabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" },
  observesNativeLaunch: true,
  resendBaseMs: 20 * 60_000,
  dispatch: (target, message, observe) => ringCodex(target.sessionId, message, observe),
};
