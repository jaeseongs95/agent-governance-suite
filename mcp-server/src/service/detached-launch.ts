import { execFile, spawn } from "node:child_process";

import { producerFailure, retainFailureCause } from "../failure-diagnostics.js";

/**
 * Starts node with these arguments as a process that outlives the caller (docs/ags31-dbms-service-design.md 4.2).
 *
 * - Linux/macOS: a detached process group, so a signal the host sends to the hook's group does not reach it.
 * - Windows: CIM Win32_Process.Create (8.1 M2). The process is created by the WMI provider host, so it inherits
 *   neither this process's handles (a host waiting for pipe EOF would wait for it) nor its job (a KILL_ON_JOB_CLOSE
 *   job would end it with the first host). It inherits no environment either: every value goes in the arguments.
 *
 * Resolves with the new process ID; the caller still has to reach the service, which proves it started.
 */
export function launchDetached(args: readonly string[], timeoutMs: number,
  platform: NodeJS.Platform = process.platform): Promise<number> {
  return platform === "win32" ? launchThroughCim(args, timeoutMs) : launchProcessGroup(args);
}

function launchProcessGroup(args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
    } catch (cause) {
      reject(retainFailureCause(producerFailure("SERVICE_LAUNCH_FAILED", "The service process could not be started."), cause));
      return;
    }
    child.once("error", cause => {
      reject(retainFailureCause(producerFailure("SERVICE_LAUNCH_FAILED", "The service process could not be started."), cause));
    });
    child.once("spawn", () => {
      child.unref();
      if (child.pid === undefined) reject(producerFailure("SERVICE_LAUNCH_FAILED", "The service process has no ID."));
      else resolve(child.pid);
    });
  });
}

/** One argument in CommandLineToArgvW form, the quoting libuv applies to spawn arguments. */
function windowsArgument(value: string): string {
  if (value && !/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/u, "$1$1")}"`;
}

/** A PowerShell single-quoted literal; PowerShell also closes such a string at U+2018-U+201B. */
function powershellLiteral(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201a\u201b]/gu, "$&$&")}'`;
}

export function cimLaunchScript(args: readonly string[]): string {
  const commandLine = [process.execPath, ...args].map(windowsArgument).join(" ");
  return "$su = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; "
    + `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${powershellLiteral(commandLine)}; ProcessStartupInformation=$su}; `
    + "[Console]::Out.Write(\"$($r.ReturnValue) $($r.ProcessId)\")";
}

function launchThroughCim(args: readonly string[], timeoutMs: number): Promise<number> {
  const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const encoded = Buffer.from(cimLaunchScript(args), "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    try {
      // execFile accepts only a positive integer timeout; 0 would mean none.
      execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        { windowsHide: true, timeout: Math.max(1, Math.floor(timeoutMs)) }, (error, stdout) => {
          if (error) {
            reject(retainFailureCause(producerFailure("SERVICE_LAUNCH_FAILED", "The CIM launcher failed."), error));
            return;
          }
          const [returnValue, pid] = String(stdout).trim().split(" ").map(Number);
          if (returnValue !== 0) {
            // Win32_Process.Create return codes (2 access denied, 9 path not found, ...) stay as observed.
            reject(Object.assign(producerFailure("SERVICE_LAUNCH_FAILED", "Win32_Process.Create did not start the service."),
              { returnValue: Number.isSafeInteger(returnValue) ? returnValue : null }));
          } else if (!Number.isSafeInteger(pid) || pid! < 1) {
            reject(producerFailure("SERVICE_LAUNCH_FAILED", "Win32_Process.Create reported no process."));
          } else resolve(pid!);
        });
    } catch (cause) {
      reject(retainFailureCause(producerFailure("SERVICE_LAUNCH_FAILED", "The CIM launcher could not be started."), cause));
    }
  });
}
