#!/usr/bin/env node
// Antigravity/Gemini isolated hook connector (r09).
// Translates Antigravity camelCase hook inputs and output contracts at the
// host boundary without touching shared Codex/Claude hook contracts.
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { failureContext, retainFailureCause, retainFailureSecondary } from "../../runtime/failure-diagnostics.mjs";

// Queue wake defaults are passed per invocation; importing this module never changes user ENV.

export const ALLOWED_EVENTS = new Set([
  "SessionStart",
  "PreInvocation",
  "PostInvocation",
  "PreToolUse",
  "PostToolUse",
  "Stop",
]);

// b70204be (1): Terminal/cancel reasons on Stop must never force continuation even if peer messages are queued.
export const NON_CONTINUABLE_STOP_REASONS = new Set([
  "USER_CANCELED",
  "ERROR",
  "MAX_INVOCATIONS",
  "MAX_FORCED_INVOCATIONS",
  "MAX_TOKEN_BUDGET_EXCEEDED",
  "TERMINAL_STEP_TYPE",
  "TERMINAL_CUSTOM_HOOK",
]);

const CONTINUITY_BOUND_TOOLS = new Set([
  "open_convergence_root",
  "checkpoint_context",
  "inspect_context",
  "load_context",
  "suppress_context_restore",
  "purge_direct_context",
]);

export const RESERVED_TOOL_KEYS = [
  "_hostAttestation",
  "_sessionBinding",
  "_continuityBinding",
];

function findFirstReservedKey(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "";
  for (const key of RESERVED_TOOL_KEYS) {
    if (Object.hasOwn(obj, key)) return key;
  }
  return "";
}

const TOOL_NAME_MAP = {
  run_command: "Bash",
  write_file: "Write",
  edit_file: "Edit",
  invoke_subagent: "Agent",
};

// Note (G1 / #3272 / R04-F03 / R05-F01 / R05-F02 / R05-F03 / 0cdb9b8b / 256e030b / feaa4fb5 / 5eb3d511 / #3313 N1~N3):
// - Handler 1 (--hook=host-attestation, pure in-memory) in hooks.json is the primary
//   fail-closed defense line for _hostAttestation stripping/denial.
// - Handler 2 avoids broker I/O on PreToolUse by computing _sessionBinding locally.
// - Lifecycle events (SessionStart, PreInvocation, PostInvocation, Stop) have a 10s hooks.json budget.
//   The adapter owns the 10s native budget anchored at process start `timeOrigin` (`performance.now() === 0`,
//   so Node startup + ESM module load elapsed time is automatically deducted from `DEFAULT_HOOK_TOTAL_BUDGET_MS = 9200`
//   when `options.entryMonotonicMs` is omitted in real CLI execution — `#3313 N2`), subtracts
//   `DEFAULT_STDOUT_FLUSH_RESERVE_MS` (800ms) upfront, and passes `options.executionBudget = { deadlineMonotonicMs, postClaimReserveMs }`
//   plus `options.onClaimState` (4-state classification: `before-claim` -> `claim-result-unknown` ->
//   `after-claim-before-output` -> adapter-owned `stdout-written-not-consumed`, with `stdout.write` callback != host
//   consumption/ACK, single claim after `ensureBroker`/`ping`, 0 automatic re-claim on unknown, and 0 hard-10s
//   guarantee on non-preemptible sync FS/SQLite/stdout).
// - `#3313 N1`: Claim state tracking is in-memory/programmatic (`getSnapshot` / ` getSecretFreeDiagnostic`), with
//   0 disk persistence and secret-free 1-line stderr diagnostic emitted ONLY when a claim is stranded in
//   `claim-result-unknown` or `after-claim-before-output` (or when `AGS_ANTIGRAVITY_DIAGNOSTIC_STDERR === "1"`).
// - `#3313 N3`: When remaining budget for `resolveLongLivedHostProcess` is `< MIN_RESOLVER_BUDGET_MS` (100ms),
//   the resolver is skipped immediately (`null`) instead of clamping up to 100ms.
const STAGE_TIMEOUT_MS = 2000;
const PID_RESOLVER_TIMEOUT_MS = 1500;
export const MIN_RESOLVER_BUDGET_MS = 100;
const MIN_PRIMARY_HOOK_BUDGET_MS = 500;
export const NATIVE_HOOK_HARD_TIMEOUT_MS = 10000;
export const DEFAULT_STDOUT_FLUSH_RESERVE_MS = 800;
export const DEFAULT_HOOK_TOTAL_BUDGET_MS = NATIVE_HOOK_HARD_TIMEOUT_MS - DEFAULT_STDOUT_FLUSH_RESERVE_MS;
export const DEFAULT_POST_CLAIM_RESERVE_MS = 1000;
export const MIN_SECONDARY_STAGE_BUDGET_MS = 1500;
const MAX_ANCESTOR_DEPTH = 6;

const TRANSIENT_SHELL_OR_NODE_PATTERN = /^(?:cmd|powershell|pwsh|conhost|sh|bash|dash|zsh|fish|node|nodejs)(?:\.exe)?$/iu;
const EXACT_ANTIGRAVITY_BINARY_PATTERN = /^(?:antigravity(?:\.exe)?|language_server(?:_(?:windows|linux|macos|darwin)(?:_(?:x64|arm64|amd64|aarch64))?)?(?:\.exe)?)$/iu;

// N1 (#3299 d826652f) & R07-N1/R07-N2 (#3300 24068174):
// 1. Explicitly reject dot-dot (`..`) traversal segments (`DOT_DOT_SEGMENT_PATTERN`) before AND after path normalization.
// 2. Reject world/public/temp writable directories (`UNTRUSTED_WRITABLE_PATH_PATTERN`).
// 3. Require an anchored standard Antigravity installation root prefix (`TRUSTED_ANTIGRAVITY_INSTALL_ROOT_PATTERN`,
//    excluding `C:\Antigravity` because standard Windows ACLs allow authenticated users to create folders under `C:\`),
//    or an exact `ANTIGRAVITY_AGENTAPI_EXE` match.
// Limitations (N1-b, R07-N1, R07-N2):
// - Syntactic normalized path-prefix + writable-directory exclusion filter; does NOT inspect OS filesystem ACLs or code signatures.
// - Per-user installation roots under a user's home directory (`AppData\Local\Programs\Antigravity`, `.gemini/antigravity`)
//   are writable by processes running as that same OS user and do not defend against same-user tampering.
// - On Linux, `defaultProcessInspector` resolves `/proc/<pid>/exe` via `readlinkSync` (failing closed if unreadable);
//   on non-Linux Unix (e.g. macOS) where `/proc/<pid>/exe` is unavailable, `ps -o args=` uses `argv[0]`, which a process
//   can spoof via `exec -a` and therefore is not a kernel-verified executable path guarantee.
const DOT_DOT_SEGMENT_PATTERN = /(?:^|[\\/])\.\.(?:[\\/]|$)/u;
const UNTRUSTED_WRITABLE_PATH_PATTERN = /(?:^|[\\/])(?:tmp|var[\\/]tmp|dev[\\/]shm|temp|appdata[\\/]local[\\/]temp|users[\\/]public)(?:[\\/]|$)/iu;
const TRUSTED_ANTIGRAVITY_INSTALL_ROOT_PATTERN = /^(?:[A-Za-z]:[\\/](?:Program Files(?: \(x86\))?[\\/]Antigravity|Users[\\/][^\\/]+[\\/](?:AppData[\\/]Local[\\/]Programs[\\/]Antigravity|\.gemini[\\/]antigravity))|\/(?:opt\/antigravity|usr\/(?:local\/)?(?:lib|share)\/antigravity|Applications\/Antigravity\.app|home\/[^/]+\/\.gemini\/antigravity|Users\/[^/]+\/\.gemini\/antigravity))(?:[\\/]|$)/iu;

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function firstString(value) {
  if (!Array.isArray(value)) return "";
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) return item;
  }
  return "";
}

function extractPrimaryExecutableToken(commandOrPath = "") {
  const s = String(commandOrPath).trim();
  if (!s) return "";
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end > 1 ? s.slice(1, end).trim() : s.slice(1).trim();
  }
  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1);
    return end > 1 ? s.slice(1, end).trim() : s.slice(1).trim();
  }
  // Unquoted Windows path that may contain spaces before ".exe" (e.g. C:\Program Files\Antigravity\Antigravity.exe --flag)
  const winExeMatch = /^([A-Za-z]:[\\/][^\r\n"]*?\.exe)(?:\s|$)/iu.exec(s);
  if (winExeMatch?.[1]) {
    return winExeMatch[1].trim();
  }
  const firstSpace = s.search(/\s/u);
  return firstSpace === -1 ? s : s.slice(0, firstSpace);
}

function normalizeCandidateExecutablePath(rawPath) {
  const s = String(rawPath).trim();
  if (!s) return "";
  if (s.startsWith("/")) {
    return path.posix.normalize(s.replaceAll("\\", "/"));
  }
  if (/^[A-Za-z]:[\\/]/u.test(s)) {
    return path.win32.normalize(s);
  }
  return "";
}

/**
 * R05-F01, N1 (#3299 d826652f), R07-N1/R07-N2 (#3300 24068174) & #3304 (f105c266):
 * Strict Antigravity host process identity check.
 * 1. Rejects transient shells, `node`/`nodejs`, and any arbitrary interpreter (`python3`, etc.).
 * 2. Never scans trailing command-line arguments; only inspects `name` and the primary executable path (`argv[0]`).
 * 3. Rejects any unlinked/replaced executable path ending with `" (deleted)"` (`#3304` note 1), any path containing
 *    `..` traversal segments (`DOT_DOT_SEGMENT_PATTERN`) before or after normalization, and any path under temporary
 *    or public writable directories (`UNTRUSTED_WRITABLE_PATH_PATTERN`).
 * 4. Requires both an exact supported Antigravity binary name (`EXACT_ANTIGRAVITY_BINARY_PATTERN`) AND an anchored
 *    standard Antigravity installation root prefix (`TRUSTED_ANTIGRAVITY_INSTALL_ROOT_PATTERN`, excluding `C:\Antigravity`,
 *    or exact `ANTIGRAVITY_AGENTAPI_EXE` match) on the normalized path.
 * 5. Limitations: Does not inspect OS filesystem ACLs; per-user roots (`AppData\Local\Programs\Antigravity`, `.gemini/antigravity`)
 *    are writable by the same OS user; on non-Linux Unix without `/proc/<pid>/exe`, `ps` `argv[0]` can be spoofed via `exec -a`.
 */
export function isRecognizedAntigravityHostProcess(name = "", commandOrPath = "", env = process.env) {
  const rawName = String(name).trim();
  const rawCommand = String(commandOrPath).trim();
  // #3304 (f105c266) note 1: Never accept unlinked/replaced binaries carrying the kernel " (deleted)" suffix.
  if (rawName.endsWith(" (deleted)") || rawCommand.endsWith(" (deleted)") || /\s+\(deleted\)$/iu.test(rawName) || /\s+\(deleted\)$/iu.test(rawCommand)) {
    return false;
  }
  const baseName = rawName ? path.win32.basename(rawName) : "";
  const primaryExec = extractPrimaryExecutableToken(rawCommand);
  if (DOT_DOT_SEGMENT_PATTERN.test(rawName) || DOT_DOT_SEGMENT_PATTERN.test(primaryExec)) {
    return false;
  }

  const candidatePath = primaryExec || (rawName.includes("/") || rawName.includes("\\") ? rawName : "");
  if (!candidatePath || DOT_DOT_SEGMENT_PATTERN.test(candidatePath)) return false;

  const normalizedPath = normalizeCandidateExecutablePath(candidatePath);
  if (!normalizedPath || DOT_DOT_SEGMENT_PATTERN.test(normalizedPath)) return false;

  const execBase = path.win32.basename(normalizedPath);
  if (!baseName && !execBase) return false;
  if (baseName && TRANSIENT_SHELL_OR_NODE_PATTERN.test(baseName)) return false;
  if (execBase && TRANSIENT_SHELL_OR_NODE_PATTERN.test(execBase)) return false;

  // If both process name and normalized executable basename are present, neither may be a foreign binary.
  if (baseName && !EXACT_ANTIGRAVITY_BINARY_PATTERN.test(baseName)) return false;
  if (execBase && !EXACT_ANTIGRAVITY_BINARY_PATTERN.test(execBase)) return false;

  if (UNTRUSTED_WRITABLE_PATH_PATTERN.test(candidatePath) || UNTRUSTED_WRITABLE_PATH_PATTERN.test(normalizedPath)) {
    return false;
  }

  const configuredExe = typeof env?.ANTIGRAVITY_AGENTAPI_EXE === "string" ? env.ANTIGRAVITY_AGENTAPI_EXE.trim() : "";
  if (configuredExe && !DOT_DOT_SEGMENT_PATTERN.test(configuredExe) && !UNTRUSTED_WRITABLE_PATH_PATTERN.test(configuredExe)) {
    const normalizedConfigured = normalizeCandidateExecutablePath(configuredExe);
    if (
      normalizedConfigured &&
      !DOT_DOT_SEGMENT_PATTERN.test(normalizedConfigured) &&
      !UNTRUSTED_WRITABLE_PATH_PATTERN.test(normalizedConfigured) &&
      normalizedPath.toLowerCase() === normalizedConfigured.toLowerCase()
    ) {
      return true;
    }
  }

  return TRUSTED_ANTIGRAVITY_INSTALL_ROOT_PATTERN.test(normalizedPath);
}

/**
 * 256e030b (R05-F03 caller-callee startToken parity):
 * Extracts the exact same Linux `/proc/<pid>/stat` `starttime` clock-ticks token (`fields[19]` after the closing `)`)
 * as shared `mcp-server/src/process-identity.ts:16-20` (`processStartToken`).
 */
export function extractLinuxProcStatStartToken(statText = "") {
  const stat = String(statText);
  const rparen = stat.lastIndexOf(")");
  if (rparen < 0) return null;
  const fields = stat.slice(rparen + 2).trim().split(/\s+/u);
  const token = (fields[19] ?? "").trim();
  return token || null;
}

function windowsProcessChainScript(startPid, maxDepth, timeoutMs) {
  return [
    "$agsRows = [System.Collections.Generic.List[object]]::new()",
    "$agsSeen = @{}",
    "$agsWatch = [System.Diagnostics.Stopwatch]::StartNew()",
    "$agsCursor = " + startPid,
    "for ($agsDepth=0; $agsDepth -lt " + maxDepth + "; $agsDepth++) {",
    "  if ($agsCursor -lt 1 -or $agsSeen.ContainsKey($agsCursor) -or (" + timeoutMs + " - $agsWatch.ElapsedMilliseconds) -lt " + MIN_RESOLVER_BUDGET_MS + ") { break }",
    "  $agsSeen[$agsCursor] = $true",
    "  try {",
    "    $agsBefore = Get-Process -Id $agsCursor -ErrorAction Stop",
    "    $agsStart = $agsBefore.StartTime.ToUniversalTime()",
    "    $agsPath = $agsBefore.Path",
    "    $agsMeta = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $agsCursor) -ErrorAction Stop",
    "    $agsAfter = Get-Process -Id $agsCursor -ErrorAction Stop",
    "    if (!$agsMeta -or !$agsPath -or $agsMeta.ProcessId -ne $agsCursor -or $agsStart.Ticks -ne $agsAfter.StartTime.ToUniversalTime().Ticks -or $agsPath -ine $agsAfter.Path -or $agsPath -ine $agsMeta.ExecutablePath) { break }",
    "    if ($agsStart.ToString('yyyy-MM-ddTHH:mm:ss.ffffff') -cne $agsMeta.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffff')) { break }",
    "    $agsRows.Add([pscustomobject]@{pid=[int]$agsMeta.ProcessId; parentPid=[int]$agsMeta.ParentProcessId; name=[string]$agsMeta.Name; command=[string]$agsMeta.ExecutablePath; startToken=$agsStart.ToString('o')})",
    "    $agsCursor = [int]$agsMeta.ParentProcessId",
    "  } catch { break }",
    "}",
    "ConvertTo-Json -InputObject @($agsRows.ToArray()) -Compress -Depth 3",
  ].join("; ");
}

function defaultWindowsProcessChain(startPid, maxDepth, timeoutMs) {
  if (!Number.isInteger(startPid) || startPid < 1 || timeoutMs < MIN_RESOLVER_BUDGET_MS) return null;
  const script = windowsProcessChainScript(startPid, maxDepth, timeoutMs);
  const output = execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{
    encoding:"utf8",windowsHide:true,timeout:Math.min(PID_RESOLVER_TIMEOUT_MS,Math.floor(timeoutMs)),
    maxBuffer:16384,stdio:["ignore","pipe","ignore"],
  }).trim();
  if (!output) return null;
  const rows = JSON.parse(output);
  return Array.isArray(rows) && rows.length > 0 && rows.length <= maxDepth ? rows : null;
}

function defaultProcessInspector(pid, platform, timeoutMs) {
  // #3313 N3 & R03R09-R01 (bcbf684e): Never clamp a < 100ms remaining budget up to 100ms;
  // enforce `MIN_RESOLVER_BUDGET_MS` (100ms) consistently and clip to `PID_RESOLVER_TIMEOUT_MS`.
  const rawBudget = Number.isFinite(timeoutMs) ? Math.floor(Number(timeoutMs)) : PID_RESOLVER_TIMEOUT_MS;
  if (rawBudget < MIN_RESOLVER_BUDGET_MS) return null;
  const totalBudget = Math.min(PID_RESOLVER_TIMEOUT_MS, rawBudget);
  const stepStart = performance.now();
  if (platform === "win32") {
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue`,
      "if ($p) {",
      "  $gp = Get-Process -Id $p.ProcessId -ErrorAction Stop",
      "  $st = $gp.StartTime.ToUniversalTime().ToString('o')",
      "  Write-Output \"$($p.ProcessId)|$($p.ParentProcessId)|$($p.Name)|$($p.ExecutablePath)|$st\"",
      "}",
    ].join("; ");
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: totalBudget,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    const [pidStr, ppidStr, name = "", exePath = "", startToken = ""] = out.split("|");
    const parsedPid = Number.parseInt(pidStr ?? "", 10);
    const parentPid = Number.parseInt(ppidStr ?? "", 10);
    if (!Number.isInteger(parsedPid) || parsedPid < 1 || !startToken.trim()) return null;
    return {
      pid: parsedPid,
      parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : 0,
      name: name.trim(),
      command: exePath.trim(),
      startToken: startToken.trim(),
    };
  }

  // On Linux, only 1 `ps` call is needed because executable path and `startToken` come from `/proc/<pid>/{exe,stat}`.
  // On non-Linux Unix (`darwin`, etc.), share `totalBudget` across both `ps` calls (`R05-F02`).
  const firstBudget = platform === "linux" ? totalBudget : Math.max(50, Math.floor(totalBudget * 0.6));
  const metaOut = execFileSync("ps", ["-p", String(pid), "-o", "ppid=,comm=,args="], {
    encoding: "utf8",
    timeout: firstBudget,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!metaOut) return null;
  const match = /^(\d+)\s+(\S+)(?:\s+(.*))?$/u.exec(metaOut);
  if (!match) return null;
  const parentPid = Number.parseInt(match[1], 10);
  const name = match[2] ?? "";
  let command = (match[3] ?? name).trim();
  if (platform === "linux") {
    // R07-N1 (#3300), #3304 (f105c266) & 256e030b:
    // 1. Resolve kernel-verified `/proc/<pid>/exe` via `readlinkSync` (failing closed if unreadable or if the binary
    //    has been unlinked/replaced and ends with `" (deleted)"`; note: cross-user ancestors may fail with EACCES -> null).
    // 2. Read `/proc/<pid>/stat` and extract `fields[19]` (`starttime` clock ticks) via `extractLinuxProcStatStartToken`,
    //    matching `mcp-server/src/process-identity.ts:16-20` (`processStartToken`) 100% so T1 and T2 never mismatch by format.
    try {
      const realExe = readlinkSync(`/proc/${pid}/exe`).trim();
      if (!realExe || realExe.endsWith(" (deleted)") || /\s+\(deleted\)$/iu.test(realExe)) return null;
      command = realExe;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const startToken = extractLinuxProcStatStartToken(stat);
      if (!startToken) return null;
      return {
        pid,
        parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : 0,
        name,
        command,
        startToken,
      };
    } catch {
      return null;
    }
  }
  const elapsed = performance.now() - stepStart;
  const secondBudget = Math.floor(totalBudget - elapsed);
  if (secondBudget < 40) return null;
  const startToken = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: secondBudget,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!startToken) return null;
  return {
    pid,
    parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : 0,
    name,
    command,
    startToken,
  };
}

/**
 * R04-F02 & R05-F01: Walk up the parent process tree (up to 6 hops on both Windows and Unix)
 * past transient shells (`cmd.exe`, `powershell.exe`, `pwsh.exe`, `sh`, `bash`, `node`)
 * and verify that the candidate ancestor is genuinely a recognized Antigravity host process
 * with trusted installation path provenance and a non-empty `startToken`.
 * Never fall back to `startPid` or an unverified ancestor; return `null` when unverified.
 */
export function resolveLongLivedHostProcess(startPid = process.ppid, platform = process.platform, options = {}) {
  if (!Number.isInteger(startPid) || startPid < 1) return null;
  const maxDepth = Math.min(MAX_ANCESTOR_DEPTH, Number.isInteger(options?.maxDepth) && options.maxDepth > 0 ? options.maxDepth : MAX_ANCESTOR_DEPTH);
  if (options?.timeoutMs !== undefined) {
    const explicitTimeout = Math.floor(Number(options.timeoutMs));
    if (!Number.isFinite(explicitTimeout) || explicitTimeout < MIN_RESOLVER_BUDGET_MS) {
      return null;
    }
  }
  const timeoutMs = Number.isFinite(options?.timeoutMs) && options.timeoutMs >= MIN_RESOLVER_BUDGET_MS
    ? Math.min(PID_RESOLVER_TIMEOUT_MS, Math.floor(Number(options.timeoutMs)))
    : PID_RESOLVER_TIMEOUT_MS;
  const inspectProcess = typeof options?.inspectProcess === "function" ? options.inspectProcess : defaultProcessInspector;
  const nowFn = typeof options?.now === "function" ? options.now : () => performance.now();
  const deadline = nowFn() + timeoutMs;

  try {
    let chain = null;
    let chainIndex = 0;
    if (platform === "win32" && typeof options?.inspectProcess !== "function") {
      const remaining = Math.floor(deadline - nowFn());
      if (remaining < MIN_RESOLVER_BUDGET_MS) return null;
      const inspectChain = typeof options?.inspectProcessChain === "function" ? options.inspectProcessChain : defaultWindowsProcessChain;
      chain = inspectChain(startPid,maxDepth,remaining);
      if (!Array.isArray(chain) || chain.length < 1 || chain.length > maxDepth) return null;
    }
    let curPid = startPid;
    const visited = new Set();
    for (let depth = 0; depth < maxDepth; depth++) {
      if (!Number.isInteger(curPid) || curPid < 1 || visited.has(curPid)) break;
      visited.add(curPid);
      const remaining = Math.floor(deadline - nowFn());
      // R03R09-R01 (bcbf684e): Use the same 100ms (`MIN_RESOLVER_BUDGET_MS`) floor inside the ancestor loop
      // so a 50-99ms residual budget after entry or between ancestors is never expanded back to a 100ms OS query.
      if (remaining < MIN_RESOLVER_BUDGET_MS) return null;

      let info;
      try {
        info = chain ? chain[chainIndex++] : inspectProcess(curPid, platform, remaining);
      } catch {
        return null;
      }
      if (!info || !Number.isInteger(info.pid) || info.pid !== curPid) return null;

      const startToken = text(info.startToken).trim();
      const procName = text(info.name).trim();
      const procCmd = text(info.command || info.executablePath).trim();
      if (isRecognizedAntigravityHostProcess(procName, procCmd, options?.env)) {
        return startToken
          ? Object.freeze({ pid: Number(info.pid), startToken: String(startToken) })
          : null;
      }

      const nextPid = Number(info.parentPid ?? info.ppid ?? 0);
      if (!Number.isInteger(nextPid) || nextPid < 1 || nextPid === curPid) break;
      curPid = nextPid;
    }
    return null;
  } catch {
    return null;
  }
}

// Actual hook callers await native inspection; the synchronous resolver above remains
// compatible with existing injected inspection consumers.
const inspectionFailures = new WeakMap();

function inspectionFailure(code, phase, cause) {
  const failure = Object.assign(new Error("Antigravity host process inspection failed.", { cause }), { code, phase });
  inspectionFailures.set(failure, { code, phase, cause });
  return retainFailureCause(failure, cause);
}

function inspectionBudget(options) {
  const now = typeof options?.now === "function" ? options.now : () => performance.now();
  let last = Number(now());
  if (!Number.isFinite(last) || (Number.isFinite(options?.entryMonotonicMs) && last < options.entryMonotonicMs)) {
    throw inspectionFailure("HOST_PROCESS_CLOCK_INVALID", "clock");
  }
  const configured = record(options?.pidResolverOptions).timeoutMs;
  const timeout = configured === undefined ? PID_RESOLVER_TIMEOUT_MS : Math.floor(Number(configured));
  if (!Number.isFinite(timeout) || timeout < MIN_RESOLVER_BUDGET_MS) {
    throw inspectionFailure("HOST_PROCESS_BUDGET_EXHAUSTED", "budget");
  }
  const callerDeadline = buildExecutionBudgetOption(options)?.deadlineMonotonicMs ?? Infinity;
  const deadline = Math.min(callerDeadline, last + Math.min(PID_RESOLVER_TIMEOUT_MS, timeout));
  const checkedNow = () => {
    const current = Number(now());
    if (!Number.isFinite(current) || current < last) throw inspectionFailure("HOST_PROCESS_CLOCK_INVALID", "clock");
    last = current;
    return current;
  };
  const remaining = () => {
    const current = checkedNow();
    const callerRemaining = typeof options?.remainingBudgetMs === "function" ? Number(options.remainingBudgetMs()) : Infinity;
    const left = Math.floor(Math.min(deadline - current, callerRemaining));
    if (!Number.isFinite(left) || left < MIN_RESOLVER_BUDGET_MS) {
      throw inspectionFailure("HOST_PROCESS_BUDGET_EXHAUSTED", "budget");
    }
    return left;
  };
  return { now: checkedNow, remaining };
}

function reportInspectionFailure(error, options) {
  const failure = inspectionFailures.has(error) ? error : inspectionFailure("HOST_PROCESS_INSPECTION_FAILED", "inspection", error);
  try {
    if (typeof options?.onProcessIdentityFailure === "function") {
      Promise.resolve(options.onProcessIdentityFailure(failure)).catch(secondary => retainFailureSecondary(failure, secondary));
    } else {
      const detail = inspectionFailures.get(failure);
      // Match the core native-code allowlist; never evaluate arbitrary error accessors or Proxy traps.
      let nativeCode;
      try { nativeCode = detail.cause && !types.isProxy(detail.cause) ? Object.getOwnPropertyDescriptor(detail.cause, "code")?.value : undefined; }
      catch { /* Opaque native values use the fixed fallback. */ }
      const diagnostic = {
        reason: ["HOST_PROCESS_CLOCK_INVALID", "HOST_PROCESS_BUDGET_EXHAUSTED", "HOST_PROCESS_INSPECTION_FAILED"].includes(detail.code) ? detail.code : "HOST_PROCESS_INSPECTION_FAILED",
        phase: ["clock", "budget", "inspection", "spawn"].includes(detail.phase) ? detail.phase : "inspection",
        nativeCode: typeof nativeCode === "string" && ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ENOBUFS", "EIO", "EINVAL", "ESRCH", "ABORT_ERR"].includes(nativeCode) ? nativeCode : null,
        context: failureContext(failure),
      };
      console.error(JSON.stringify({ agsAntigravityProcessIdentityFailure: diagnostic }));
    }
  } catch (secondary) { retainFailureSecondary(failure, secondary); /* Diagnostics do not grant identity or change cleanup. */ }
  return null;
}

async function inspectNativeHostProcess(startPid, platform, options, budget) {
  const maxDepth = Math.min(MAX_ANCESTOR_DEPTH, Number.isInteger(options.maxDepth) && options.maxDepth > 0 ? options.maxDepth : MAX_ANCESTOR_DEPTH);
  if (typeof options.inspectProcess === "function" || typeof options.inspectProcessChain === "function") {
    const result = resolveLongLivedHostProcess(startPid, platform, { ...options, timeoutMs: budget.remaining(), now: budget.now });
    budget.remaining();
    return result;
  }
  const query = async (command, args) => {
    const timeout = budget.remaining();
    // execFile's callback follows child close, including timeout/error cleanup.
    const output = await new Promise((resolve, reject) => execFile(command, args, {
      encoding: "utf8", windowsHide: true, timeout, killSignal: "SIGKILL", maxBuffer: 16384, stdio: ["ignore", "pipe", "ignore"],
    }, (error, stdout) => error ? reject(inspectionFailure("HOST_PROCESS_INSPECTION_FAILED", "spawn", error)) : resolve(stdout)));
    budget.remaining();
    return String(output).trim();
  };
  let rows;
  if (platform === "win32") {
    const timeout = budget.remaining();
    const output = await query("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsProcessChainScript(startPid, maxDepth, timeout)]);
    rows = output ? JSON.parse(output) : null;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > maxDepth) return null;
  } else {
    rows = [];
    let pid = startPid;
    const seen = new Set();
    for (let depth = 0; depth < maxDepth && Number.isInteger(pid) && pid > 0 && !seen.has(pid); depth++) {
      seen.add(pid);
      const output = await query("ps", ["-p", String(pid), "-o", "ppid=,comm=,args="]);
      const match = /^(\d+)\s+(\S+)(?:\s+(.*))?$/u.exec(output);
      if (!match) return null;
      const parentPid = Number.parseInt(match[1], 10);
      let command = match[3] ?? match[2];
      let startToken;
      if (platform === "linux") {
        budget.remaining();
        command = (await readlink(`/proc/${pid}/exe`)).trim();
        budget.remaining();
        startToken = extractLinuxProcStatStartToken(await readFile(`/proc/${pid}/stat`, "utf8"));
      } else startToken = await query("ps", ["-p", String(pid), "-o", "lstart="]);
      budget.remaining();
      if (!command || command.endsWith(" (deleted)") || !startToken) return null;
      const row = { pid, parentPid, name: match[2], command, startToken };
      rows.push(row);
      if (isRecognizedAntigravityHostProcess(row.name, row.command, options.env)) break;
      pid = parentPid;
    }
  }
  budget.remaining();
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const result = resolveLongLivedHostProcess(startPid, platform, { ...options, timeoutMs: budget.remaining(), now: budget.now,
    inspectProcess: platform === "win32" ? undefined : pid => byPid.get(pid), inspectProcessChain: () => rows });
  budget.remaining();
  return result;
}

export function validateExplicitEvent(explicitEvent, rawInput) {
  if (!explicitEvent || !ALLOWED_EVENTS.has(explicitEvent)) return null;
  const payloadEvent = text(rawInput.hook_event_name) || text(rawInput.hookEventName);
  if (payloadEvent && payloadEvent !== explicitEvent) return null;
  return explicitEvent;
}

export function normalizeAntigravityToolCall(input) {
  const toolCall = record(input.toolCall);
  const rawName = text(toolCall.name) || text(input.tool_name);
  const rawArgs = Object.hasOwn(toolCall, "args") ? record(toolCall.args) : record(input.tool_input);

  if (rawName === "call_mcp_tool" || rawName === "default_api:call_mcp_tool") {
    const serverName = text(rawArgs.ServerName);
    const wrappedTool = text(rawArgs.ToolName);
    if (serverName === "agent-governance-suite" && wrappedTool) {
      return {
        canonicalName: `mcp__agent-governance-suite__${wrappedTool}`,
        localTool: wrappedTool,
        toolInput: record(rawArgs.Arguments),
        rawArgs,
        isMcpWrapperCall: true,
        isShellMapped: false,
      };
    }
  }

  const agsPrefix = /^(?:default_api:)?mcp_(?:plugin_agent[-_]governance[-_]suite_)?agent[-_]governance[-_]suite_(.+)$/u.exec(rawName);
  if (agsPrefix?.[1]) {
    return {
      canonicalName: `mcp__agent-governance-suite__${agsPrefix[1]}`,
      localTool: agsPrefix[1],
      toolInput: rawArgs,
      rawArgs,
      isMcpWrapperCall: false,
      isShellMapped: false,
    };
  }

  const stripped = rawName.startsWith("default_api:") ? rawName.slice("default_api:".length) : rawName;
  const mappedName = TOOL_NAME_MAP[stripped] ?? stripped;
  const localTool = mappedName.includes("__") ? (mappedName.split("__").at(-1) ?? mappedName) : mappedName;
  const isShellMapped = stripped === "run_command";
  const normalizedInput = isShellMapped && typeof rawArgs.CommandLine === "string" && rawArgs.command === undefined
    ? { ...rawArgs, command: rawArgs.CommandLine }
    : rawArgs;

  return {
    canonicalName: mappedName,
    localTool,
    toolInput: normalizedInput,
    rawArgs,
    isMcpWrapperCall: false,
    isShellMapped,
  };
}

export function buildCanonicalHookInput(rawInput, explicitEvent, hookTarget) {
  const event = validateExplicitEvent(explicitEvent, rawInput);
  if (!event) return { event: "", canonicalEvent: "", toolBoundary: null, canonicalInput: {} };

  const sessionId = text(rawInput.conversationId) || text(rawInput.session_id);
  const workspaceId = firstString(rawInput.workspacePaths) || text(rawInput.workspace_id) || text(rawInput.cwd);
  const transcriptPath = text(rawInput.transcriptPath) || text(rawInput.transcript_path);
  const model = text(rawInput.modelName) || text(rawInput.model);

  // Never promote stepIdx or caller digest to turn_id or tool_use_id (9517df5a boundary 2).
  const turnId = text(rawInput.turn_id);
  const toolUseId = text(record(rawInput.toolCall).id);

  let canonicalEvent = event;
  if (event === "PreInvocation" || event === "PostInvocation") {
    canonicalEvent = hookTarget === "session-board" ? "SessionStart" : "PostToolUse";
  }

  const toolBoundary = (event === "PreToolUse" || event === "PostToolUse")
    ? normalizeAntigravityToolCall(rawInput)
    : null;

  const cleanBase = { ...rawInput };
  delete cleanBase.stepIdx;
  delete cleanBase.tool_use_id;

  return {
    event,
    canonicalEvent,
    toolBoundary,
    canonicalInput: {
      ...cleanBase,
      hook_event_name: canonicalEvent,
      session_id: sessionId,
      ...(workspaceId ? { workspace_id: workspaceId, cwd: workspaceId } : {}),
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
      ...(model ? { model } : {}),
      ...(turnId ? { turn_id: turnId } : {}),
      ...(toolUseId ? { tool_use_id: toolUseId } : {}),
      ...(canonicalEvent === "SessionStart" && !rawInput.source ? { source: "startup" } : {}),
      ...(toolBoundary ? { tool_name: toolBoundary.canonicalName, tool_input: toolBoundary.toolInput } : {}),
    },
  };
}

export function translateCanonicalOutputToAntigravity(event, canonicalOutput, toolBoundary) {
  const out = record(canonicalOutput);
  const specific = record(out.hookSpecificOutput);

  if (event === "PostToolUse") {
    return {};
  }

  if (event === "PreToolUse") {
    const decision = text(specific.permissionDecision) || text(out.decision);
    const reason = text(specific.permissionDecisionReason) || text(out.reason);
    if (decision === "deny" || decision === "block") {
      return { decision: "deny", ...(reason ? { reason } : {}) };
    }
    if (Object.hasOwn(specific, "updatedInput")) {
      const updated = record(specific.updatedInput);
      const cleanUpdated = { ...updated };
      if (toolBoundary?.isShellMapped && Object.hasOwn(cleanUpdated, "command") && !Object.hasOwn(record(toolBoundary.rawArgs), "command")) {
        delete cleanUpdated.command;
      }
      if (toolBoundary?.isMcpWrapperCall) {
        return { decision: "allow", overwrite: { Arguments: cleanUpdated } };
      }
      const orig = toolBoundary?.toolInput ?? {};
      const changed = {};
      for (const [k, v] of Object.entries(cleanUpdated)) {
        if (orig[k] !== v) changed[k] = v;
      }
      if (Object.keys(changed).length > 0) {
        return { decision: "allow", overwrite: changed };
      }
    }
    return {};
  }

  const additionalContext = text(specific.additionalContext);
  if (additionalContext) {
    if (event === "Stop") {
      return { decision: "continue", reason: additionalContext };
    }
    if (event === "SessionStart" || event === "PreInvocation" || event === "PostInvocation") {
      return { injectSteps: [{ ephemeralMessage: additionalContext }] };
    }
  }

  return {};
}

// R05-F02 Caller Budget & Claim-State Observer Contract (0cdb9b8b / feaa4fb5 / 796904a4):
// - `options.executionBudget = { deadlineMonotonicMs, postClaimReserveMs }`:
//   Uses the same Node process `performance.now()` origin (`entryMonotonicMs`, captured at adapter entry before
//   PID resolution or dynamic `import(...)`), with the final stdout reserve (`DEFAULT_STDOUT_FLUSH_RESERVE_MS`)
//   excluded upfront (`DEFAULT_HOOK_TOTAL_BUDGET_MS = 9200`).
// - `options.onClaimState({ phase: "request-attempted" | "response-received", messageIds: readonly string[] })`:
//   Programmatic observer tracking the 4 failure states:
//   1. `before-claim`: initial state before any broker claim socket write is attempted.
//   2. `claim-result-unknown`: entered on `phase === "request-attempted"` (actual socket write attempted; timeout or
//      disconnect after this point means broker commit is unknown — never treated as rollback or automatic re-claim).
//   3. `after-claim-before-output`: entered on `phase === "response-received"` (broker claim confirmed with `messageIds`,
//      before TrustStore receipt/verify/envelope/stdout completes — never treated as ACK, lease release, or delivery).
//   4. `stdout-written-not-consumed`: adapter-owned state after `process.stdout.write` completes (still not proof of
//      native host consumption or peer ACK).
// - Guardrails:
//   * Never exposes raw message body or authority/approval fields (`messageIds` is sanitized to frozen `string[]`).
//   * Isolates observer exceptions (`try/catch`) and blocks synchronous re-entry (`inCallback` guard) so a throwing or
//     re-entrant observer can never regress `claim-result-unknown` back to `before-claim` or trigger a duplicate claim.
export function buildExecutionBudgetOption(options = {}) {
  const explicit = record(options?.executionBudget);
  const deadlineMonotonicMs = Number.isFinite(explicit.deadlineMonotonicMs)
    ? Number(explicit.deadlineMonotonicMs)
    : Number.isFinite(options?.deadlineMonotonicMs)
      ? Number(options.deadlineMonotonicMs)
      : NaN;
  if (!Number.isFinite(deadlineMonotonicMs)) return undefined;
  const postClaimReserveMs = Number.isFinite(explicit.postClaimReserveMs) && explicit.postClaimReserveMs >= 0
    ? Number(explicit.postClaimReserveMs)
    : Number.isFinite(options?.postClaimReserveMs) && options.postClaimReserveMs >= 0
      ? Number(options.postClaimReserveMs)
      : DEFAULT_POST_CLAIM_RESERVE_MS;
  return Object.freeze({
    deadlineMonotonicMs,
    postClaimReserveMs,
  });
}

export function createClaimStateTracker(externalObserver) {
  let state = "before-claim";
  let messageIds = Object.freeze([]);
  let inCallback = false;
  let reentered = false;
  let observerError = false;

  const onClaimState = (rawEvent) => {
    if (inCallback) {
      reentered = true;
      return;
    }
    const ev = record(rawEvent);
    const phase = text(ev.phase);
    if (phase !== "request-attempted" && phase !== "response-received") {
      return;
    }
    const rawIds = Array.isArray(ev.messageIds) ? ev.messageIds : [];
    const cleanIds = Object.freeze(
      rawIds.filter((id) => typeof id === "string" && id.trim().length > 0).map((id) => String(id).trim()),
    );

    if (phase === "request-attempted") {
      if (state === "before-claim") {
        state = "claim-result-unknown";
      }
    } else if (phase === "response-received") {
      if (state === "before-claim" || state === "claim-result-unknown") {
        state = "after-claim-before-output";
      }
      messageIds = cleanIds;
    }

    if (typeof externalObserver === "function") {
      inCallback = true;
      try {
        const maybeThenable = externalObserver(
          Object.freeze({
            phase,
            messageIds: cleanIds,
          }),
        );
        // 7f008c42 (1): Never `await` an async `externalObserver` (which would stall execution budget / cleanup),
        // but attach a non-blocking rejection handler when a Promise/thenable is returned so async rejections are
        // absorbed into `observerError = true` and can never escape as an unhandledRejection.
        if (
          maybeThenable !== null &&
          (typeof maybeThenable === "object" || typeof maybeThenable === "function") &&
          typeof maybeThenable.then === "function"
        ) {
          Promise.resolve(maybeThenable).catch(() => {
            observerError = true;
          });
        }
      } catch {
        observerError = true;
      } finally {
        inCallback = false;
      }
    }
  };

  const markStdoutWritten = () => {
    if (state === "after-claim-before-output") {
      state = "stdout-written-not-consumed";
    }
  };

  const getSnapshot = () =>
    Object.freeze({
      state,
      messageIds,
      reentered,
      observerError,
      hostConsumedConfirmed: false,
    });

  // #3313 N1: Secret-free / body-free / messageId-free diagnostic summary for post-failure state classification.
  const getSecretFreeDiagnostic = () =>
    Object.freeze({
      claimState: state,
      messageCount: messageIds.length,
      reentered,
      observerError,
      hostConsumedConfirmed: false,
    });

  return Object.freeze({
    onClaimState,
    markStdoutWritten,
    getSnapshot,
    getSecretFreeDiagnostic,
  });
}

export function formatSecretFreeClaimDiagnosticLine(claimTracker) {
  if (!claimTracker || typeof claimTracker.getSecretFreeDiagnostic !== "function") return "";
  const diag = claimTracker.getSecretFreeDiagnostic();
  return `${JSON.stringify({ agsAntigravityHookDiagnostic: diag })}\n`;
}

// R04-F01, R04-F04, R05-F02, R05-F03, #3313 N3 & #3317 M2 (aligned with central 01a14016 10193bee/10411a0d/796904a4/5eb3d511):
// - Preserve observed actor identity (`agent_id`) on SessionStart and block observed subagents early.
// - Resolve `{ pid, startToken }` (T1, using `/proc/<pid>/stat` fields[19] on Linux, `ps -o lstart=` on non-Linux Unix,
//   and ISO-8601 UTC StartTime on Windows to match `mcp-server/src/process-identity.ts` 100%) and defensively copy it
//   as an immutable pair so caller/inspector mutation after return cannot corrupt the passed token.
// - `#3313 N3` / `#3317 M2`: If `options.remainingBudgetMs()` is provided and `< MIN_RESOLVER_BUDGET_MS` (100ms, including `<= 0`),
//   skip resolver and hook invocation immediately (`return`) instead of clamping up with `Math.max(100, ...)`.
// - Pass `explicitHostPid` (3rd arg) AND `{ hostProcess: { pid, startToken }, ...(executionBudget ? { executionBudget } : {}) }`
//   (4th options arg) when verified; an unverified pair skips ensure entirely.
export function resolveVerifiedAntigravityHostProcess(options = {}) {
  try {
    const budget = inspectionBudget(options);
    const resolverOptions = { ...record(options?.pidResolverOptions), timeoutMs: budget.remaining(), now: budget.now };
    const raw = typeof options?.resolveHostProcess === "function"
      ? options.resolveHostProcess(process.ppid, process.platform, resolverOptions)
      : inspectNativeHostProcess(process.ppid, process.platform, resolverOptions, budget);
    const snapshot = (info) => {
      budget.remaining();
      const pid = info && Number.isInteger(info.pid) && info.pid > 0 ? Number(info.pid) : 0;
      const startToken = info && typeof info.startToken === "string" ? info.startToken.trim() : "";
      return pid > 0 && startToken ? Object.freeze({ pid, startToken }) : null;
    };
    return raw && typeof raw.then === "function"
      ? Promise.resolve(raw).then(snapshot).catch(error => reportInspectionFailure(error, options))
      : snapshot(raw);
  } catch (error) {
    return reportInspectionFailure(error, options);
  }
}

export async function startAntigravitySessionPresenceAndRelay(canonicalInput, options = {}) {
  try {
    const hostProcess = await resolveVerifiedAntigravityHostProcess(options);
    if (!hostProcess) return;
    const executionBudget = buildExecutionBudgetOption(options);
    if (!executionBudget) return;
    const hookHandler = typeof options?.sessionMessageHook === "function"
      ? options.sessionMessageHook
      : (await import("../../mcp-server/dist/session-message-hook.mjs")).handleSessionMessageHook;
    await hookHandler(canonicalInput, "antigravity", hostProcess.pid, Object.freeze({
      ensureRelay: true, hostProcess, executionBudget, defaultQueueWake: true,
    }));
  } catch {
    // Presence and relay startup are advisory and fail-open.
  }
}

async function runSingleHookStage(hookName, event, rawInput, currentToolInput, options = {}) {
  const { canonicalInput, toolBoundary } = buildCanonicalHookInput(rawInput, event, hookName);
  if (!canonicalInput.session_id) return { output: {}, updatedToolInput: currentToolInput, mutated: false };

  const inputWithCurrentArgs = toolBoundary
    ? { ...canonicalInput, tool_input: currentToolInput }
    : canonicalInput;

  if (hookName === "host-attestation") {
    // Effort is unexposed in Antigravity hooks (r03): never mint a token.
    // G2: For non-wrapper direct tool calls, Antigravity shallow top-level overwrite cannot delete keys;
    // any caller-supplied _hostAttestation on a direct tool call is denied outright (fail-closed).
    if (event === "PreToolUse" && Object.hasOwn(currentToolInput, "_hostAttestation")) {
      if (!toolBoundary?.isMcpWrapperCall) {
        return {
          output: { decision: "deny", reason: "Direct tool call cannot carry unverified _hostAttestation on Antigravity." },
          updatedToolInput: currentToolInput,
          mutated: false,
        };
      }
      const clean = { ...currentToolInput };
      delete clean._hostAttestation;
      return { output: {}, updatedToolInput: clean, mutated: true };
    }
    return { output: {}, updatedToolInput: currentToolInput, mutated: false };
  }

  if (hookName === "session-message") {
    if (event === "PostToolUse") return { output: {}, updatedToolInput: currentToolInput, mutated: false };

    // b70204be (1): Check terminationReason (e.g. USER_CANCELED, ERROR, MAX_*) as well as error/fullyIdle/executionNum on Stop.
    if (event === "Stop") {
      const reason = text(rawInput.terminationReason);
      if (
        rawInput.error ||
        rawInput.fullyIdle === false ||
        Number(rawInput.executionNum ?? 0) > 3 ||
        (reason && NON_CONTINUABLE_STOP_REASONS.has(reason))
      ) {
        return { output: {}, updatedToolInput: currentToolInput, mutated: false };
      }
    }

    // AGS PreToolUse is handled once by the common governance entry below.
    if (event === "PreToolUse") return { output: {}, updatedToolInput: currentToolInput, mutated: false };

    if (event === "SessionStart") {
      await startAntigravitySessionPresenceAndRelay(canonicalInput, options);
      return { output: {}, updatedToolInput: currentToolInput, mutated: false };
    }

    // b70204be (3) & R05-F02 (0cdb9b8b / feaa4fb5 / 796904a4):
    // For PreInvocation / PostInvocation / Stop where broker claim runs:
    // - Do NOT race with a short local Promise.race that would abandon an in-flight broker claim.
    // - Pass `options.executionBudget = { deadlineMonotonicMs, postClaimReserveMs }` and safe `options.onClaimState`
    //   into `handleSessionMessageHook(effectiveInput, "antigravity", undefined, hookOptions)`.
    const hookHandler = typeof options?.sessionMessageHook === "function"
      ? options.sessionMessageHook
      : (await import("../../mcp-server/dist/session-message-hook.mjs")).handleSessionMessageHook;
    const effectiveInput = event === "Stop"
      ? { ...inputWithCurrentArgs, hook_event_name: "PostToolUse" }
      : inputWithCurrentArgs;
    const executionBudget = buildExecutionBudgetOption(options);
    const claimTracker = options?.claimTracker ?? createClaimStateTracker(options?.onClaimState);
    const hookOptions = Object.freeze({
      defaultQueueWake: true,
      ...(executionBudget ? { executionBudget } : {}),
      onClaimState: claimTracker.onClaimState,
    });
    const canonicalOutput = await hookHandler(effectiveInput, "antigravity", undefined, hookOptions);
    return { output: canonicalOutput, updatedToolInput: currentToolInput, mutated: false };
  }

  if (hookName === "continuity") {
    let cleanArgs = currentToolInput;
    let mutated = false;
    if (event === "PreToolUse") {
      if (Object.hasOwn(cleanArgs, "_continuityBinding")) {
        if (!toolBoundary?.isMcpWrapperCall) {
          return {
            output: { decision: "deny", reason: "Direct tool call cannot carry unverified caller _continuityBinding on Antigravity." },
            updatedToolInput: currentToolInput,
            mutated: false,
          };
        }
        cleanArgs = { ...cleanArgs };
        delete cleanArgs._continuityBinding;
        mutated = true;
      }
      // Optimization (G1): Only spawn continuity-hook.mjs on PreToolUse when the tool is actually a continuity-bound tool!
      const localTool = toolBoundary?.localTool ?? "";
      if (!CONTINUITY_BOUND_TOOLS.has(localTool)) {
        return { output: {}, updatedToolInput: cleanArgs, mutated };
      }
    }
    const remainingBudgetMs = typeof options?.remainingBudgetMs === "function"
      ? options.remainingBudgetMs()
      : STAGE_TIMEOUT_MS;
    const effectiveTimeoutMs = Math.max(250, Math.min(STAGE_TIMEOUT_MS, Math.floor(remainingBudgetMs)));
    const preservedSessionBinding = cleanArgs._sessionBinding;
    const hookPath = fileURLToPath(new URL("../../mcp-server/dist/continuity-hook.mjs", import.meta.url));
    const res = spawnSync(process.execPath, [hookPath, "--host=antigravity"], {
      input: JSON.stringify({ ...inputWithCurrentArgs, ...(toolBoundary ? { tool_input: cleanArgs } : {}) }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: effectiveTimeoutMs,
      env: process.env,
    });
    if (res.status === 0 && res.stdout?.trim()) {
      const parsed = record(JSON.parse(res.stdout));
      const specific = record(parsed.hookSpecificOutput);
      if (Object.hasOwn(specific, "updatedInput")) {
        cleanArgs = { ...record(specific.updatedInput) };
        // Defensive guard (R02-D): continuity-hook.ts only touches _continuityBinding today,
        // but preserve any caller-resolved Gemini _sessionBinding across updatedInput spreads.
        if (preservedSessionBinding !== undefined) {
          cleanArgs._sessionBinding = { ...record(preservedSessionBinding), host: "antigravity", sessionId: canonicalInput.session_id };
        } else if (Object.hasOwn(cleanArgs, "_sessionBinding") && record(cleanArgs._sessionBinding).host === "codex") {
          cleanArgs._sessionBinding = { ...record(cleanArgs._sessionBinding), host: "antigravity", sessionId: canonicalInput.session_id };
        }
        specific.updatedInput = cleanArgs;
        mutated = true;
      }
      return { output: parsed, updatedToolInput: cleanArgs, mutated };
    }
    return { output: {}, updatedToolInput: cleanArgs, mutated };
  }

  if (hookName === "session-board") {
    const { runSessionBoardHook } = await import("../../mcp-server/dist/session-board-hook.mjs");
    const outStr = await runSessionBoardHook("antigravity", JSON.stringify({ ...inputWithCurrentArgs, ...(toolBoundary ? { tool_input: currentToolInput } : {}) }));
    if (!outStr) return { output: {}, updatedToolInput: currentToolInput, mutated: false };
    const parsed = record(JSON.parse(outStr));
    const specific = record(parsed.hookSpecificOutput);
    let nextArgs = currentToolInput;
    let mutated = false;
    if (Object.hasOwn(specific, "updatedInput")) {
      nextArgs = record(specific.updatedInput);
      mutated = true;
    }
    return { output: parsed, updatedToolInput: nextArgs, mutated };
  }

  return { output: {}, updatedToolInput: currentToolInput, mutated: false };
}

export async function executeAntigravityHookEvent(rawInput, explicitEvent, explicitHook, options = {}) {
  const event = validateExplicitEvent(explicitEvent, rawInput);
  if (!event) return {};

  const { canonicalInput, toolBoundary } = buildCanonicalHookInput(rawInput, event, explicitHook || "session-message");
  if (event === "PreToolUse" && toolBoundary?.canonicalName.startsWith("mcp__agent-governance-suite__")) {
    // ponytail: 3.0 infers root for every Antigravity call, so caller binding keys are refused here
    // instead of by the actor denial. Drop once the child gate returns after 3.0.
    const forgedKey = findFirstReservedKey(toolBoundary.toolInput);
    if (forgedKey) return { decision: "deny", reason: `Unverified caller ${forgedKey} rejected.` };
    try {
      const { runGovernanceHook } = await import("../../mcp-server/dist/governance-hook.mjs");
      const outcome = await runGovernanceHook("antigravity", JSON.stringify(canonicalInput));
      if (!outcome || typeof outcome.ok !== "boolean" || typeof outcome.output !== "string" || !outcome.output.trim()) {
        throw new Error("Invalid governance hook outcome.");
      }
      const output = translateCanonicalOutputToAntigravity("PreToolUse", JSON.parse(outcome.output), toolBoundary);
      if ((!outcome.ok && output.decision !== "deny") || !["allow", "deny"].includes(output.decision)) {
        throw new Error("Invalid governance hook decision.");
      }
      return output;
    } catch {
      return { decision: "deny", reason: "GOVERNANCE_HOOK_FAILED" };
    }
  }

  if (!canonicalInput.session_id) {
    // F1 + R02-F05 fail-closed: if PreToolUse carries any reserved binding key without a valid sessionId, deny immediately.
    if (event === "PreToolUse" && toolBoundary) {
      const forgedKey = findFirstReservedKey(toolBoundary.toolInput);
      if (forgedKey) {
        return { decision: "deny", reason: `Unverified caller ${forgedKey} rejected (missing session context).` };
      }
    }
    return {};
  }

  if (event === "PostToolUse") {
    return {};
  }

  const nowFn = typeof options?.now === "function" ? options.now : () => performance.now();
  const entryMonotonicMs = Number.isFinite(options?.entryMonotonicMs) ? Number(options.entryMonotonicMs) : nowFn();
  const totalBudgetMs = Number.isFinite(options?.totalBudgetMs) && options.totalBudgetMs > 0
    ? Number(options.totalBudgetMs)
    : DEFAULT_HOOK_TOTAL_BUDGET_MS;
  const postClaimReserveMs = Number.isFinite(options?.postClaimReserveMs) && options.postClaimReserveMs >= 0
    ? Number(options.postClaimReserveMs)
    : DEFAULT_POST_CLAIM_RESERVE_MS;
  const minSecondaryBudgetMs = Number.isFinite(options?.minSecondaryBudgetMs) && options.minSecondaryBudgetMs >= 0
    ? Number(options.minSecondaryBudgetMs)
    : MIN_SECONDARY_STAGE_BUDGET_MS;
  const deadlineMonotonicMs = entryMonotonicMs + totalBudgetMs;
  const remainingBudgetMs = () => deadlineMonotonicMs - nowFn();
  const executionBudget = Object.freeze({
    deadlineMonotonicMs,
    postClaimReserveMs,
  });
  const claimTracker = options?.claimTracker ?? createClaimStateTracker(options?.onClaimState);
  const stageOptions = {
    ...options,
    entryMonotonicMs,
    deadlineMonotonicMs,
    postClaimReserveMs,
    executionBudget,
    claimTracker,
    onClaimState: claimTracker.onClaimState,
    remainingBudgetMs,
  };
  const runStage = typeof options?.stageRunner === "function" ? options.stageRunner : runSingleHookStage;

  if (event === "PreToolUse") {
    let currentToolInput = { ...(toolBoundary?.toolInput ?? {}) };
    let anyMutated = false;

    // F1 + G2 + R02-F05: Handle all caller-supplied reserved binding keys (_hostAttestation, _sessionBinding,
    // _continuityBinding) synchronously before any stage runs.
    // On non-wrapper direct tool calls, shallow top-level overwrite cannot delete keys, so deny immediately.
    // On wrapper calls, strip all reserved keys upfront so even if a downstream stage throws, the caller's
    // unverified keys are guaranteed to be overwritten out of Arguments.
    for (const reservedKey of RESERVED_TOOL_KEYS) {
      if (Object.hasOwn(currentToolInput, reservedKey)) {
        if (!toolBoundary?.isMcpWrapperCall) {
          return { decision: "deny", reason: `Direct tool call cannot carry unverified ${reservedKey} on Antigravity.` };
        }
        delete currentToolInput[reservedKey];
        anyMutated = true;
      }
    }

    const stages = explicitHook
      ? [explicitHook]
      : ["host-attestation", "session-message", "continuity", "session-board"];

    for (const stage of stages) {
      try {
        const res = await runStage(stage, event, rawInput, currentToolInput, stageOptions);
        const specific = record(record(res.output).hookSpecificOutput);
        const decision = text(specific.permissionDecision) || text(record(res.output).decision);
        const reason = text(specific.permissionDecisionReason) || text(record(res.output).reason);
        if (decision === "deny" || decision === "block") {
          return { decision: "deny", ...(reason ? { reason } : {}) };
        }
        if (res.mutated) {
          currentToolInput = res.updatedToolInput;
          anyMutated = true;
        }
      } catch {
        // F1 fail-closed: if the host-attestation stage throws, deny the tool call immediately.
        if (stage === "host-attestation") {
          return { decision: "deny", reason: "Host attestation boundary check failed closed." };
        }
        // Other stages remain fail-open while preserving the already-stripped reserved keys state.
      }
    }

    if (!anyMutated) return {};
    return translateCanonicalOutputToAntigravity(
      "PreToolUse",
      { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: currentToolInput } },
      toolBoundary,
    );
  }

  if (event === "SessionStart" || event === "PreInvocation" || event === "PostInvocation") {
    const stages = explicitHook
      ? [explicitHook]
      : event === "SessionStart"
        ? ["session-message", "continuity", "session-board"]
        : ["session-message", "session-board"];
    const injected = [];
    const seenTexts = new Set();

    for (let idx = 0; idx < stages.length; idx++) {
      const stage = stages[idx];
      // R04-F03: Never skip the primary stage (idx === 0, typically session-message),
      // but if an earlier stage consumed most of the 10s native hook budget, skip secondary
      // advisory stages (continuity, session-board) so any claimed peer message envelope is
      // flushed to stdout before the host kills the hook process.
      if (idx > 0 && remainingBudgetMs() < minSecondaryBudgetMs) {
        break;
      }
      try {
        const res = await runStage(stage, event, rawInput, {}, stageOptions);
        const ctx = text(record(record(res.output).hookSpecificOutput).additionalContext);
        if (ctx && !seenTexts.has(ctx)) {
          seenTexts.add(ctx);
          injected.push({ ephemeralMessage: ctx });
        }
      } catch {
        // Fail open per stage.
      }
    }
    return injected.length > 0 ? { injectSteps: injected } : {};
  }

  if (event === "Stop") {
    if (remainingBudgetMs() < MIN_PRIMARY_HOOK_BUDGET_MS) {
      return {};
    }
    try {
      const res = await runStage(explicitHook || "session-message", "Stop", rawInput, {}, stageOptions);
      return translateCanonicalOutputToAntigravity("Stop", res.output, null);
    } catch {
      return {};
    }
  }

  return {};
}

export function failClosedPreToolUseFallback(raw, eventArg, hookArg) {
  const matchedReservedKey = RESERVED_TOOL_KEYS.find((k) => raw.includes(`"${k}"`)) ?? "";
  const isPreToolOrAttestation = eventArg === "PreToolUse" || hookArg === "host-attestation" || Boolean(matchedReservedKey);
  if (!isPreToolOrAttestation) return null;
  if (matchedReservedKey) {
    return { decision: "deny", reason: `Fail-closed: unparsed or failed PreToolUse input contained ${matchedReservedKey}.` };
  }
  if (hookArg === "host-attestation") {
    return { decision: "deny", reason: "Fail-closed: host-attestation connector encountered an unexpected error." };
  }
  return null;
}

export async function runConnectorFromRaw(raw, argv = process.argv, options = {}) {
  // #3313 N2: Anchor default process deadline at `performance.timeOrigin` (`entryMonotonicMs = 0`) so Node startup +
  // ESM module load elapsed time (`performance.now()` at entry) is automatically deducted from `9200ms` rather than
  // consuming the `800ms` stdout reserve. When unit tests supply a custom `options.now` clock without `entryMonotonicMs`,
  // anchor at `options.now()`.
  const entryMonotonicMs = Number.isFinite(options?.entryMonotonicMs)
    ? Number(options.entryMonotonicMs)
    : typeof options?.now === "function"
      ? Number(options.now())
      : 0;
  const hookArg = argv.find((a) => a.startsWith("--hook="))?.slice(7) ?? "";
  const eventArg = argv.find((a) => a.startsWith("--event="))?.slice(8) ?? "";
  try {
    if (!raw.trim()) return "";
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const fb = failClosedPreToolUseFallback(raw, eventArg, hookArg);
      return fb ? JSON.stringify(fb) : "";
    }
    const agyOutput = await executeAntigravityHookEvent(parsed, eventArg, hookArg, {
      ...options,
      entryMonotonicMs,
    });
    return Object.keys(agyOutput).length > 0 ? JSON.stringify(agyOutput) : "";
  } catch {
    const fb = failClosedPreToolUseFallback(raw, eventArg, hookArg);
    return fb ? JSON.stringify(fb) : "";
  }
}

export function emitStrandedClaimDiagnosticIfNeeded(claimTracker, env = process.env, writeStderr = (line) => process.stderr.write(line)) {
  if (!claimTracker || typeof claimTracker.getSecretFreeDiagnostic !== "function") return false;
  const diag = claimTracker.getSecretFreeDiagnostic();
  const isStrandedClaim = diag.claimState === "claim-result-unknown" || diag.claimState === "after-claim-before-output";
  const forceDiag = env?.AGS_ANTIGRAVITY_DIAGNOSTIC_STDERR === "1";
  if (!isStrandedClaim && !forceDiag) return false;
  try {
    writeStderr(formatSecretFreeClaimDiagnosticLine(claimTracker));
    return true;
  } catch {
    return false;
  }
}

export function finalizeConnectorOutput(out, claimTracker, options = {}) {
  const env = options?.env ?? process.env;
  const writeStderr = typeof options?.writeStderr === "function"
    ? options.writeStderr
    : (line) => process.stderr.write(line);
  const stdoutStream = options?.stdoutStream ?? (!options?.writeStdout ? process.stdout : null);
  const writeStdout = typeof options?.writeStdout === "function"
    ? options.writeStdout
    : (text, cb) => stdoutStream.write(text, cb);

  if (out) {
    // 0cdb9b8b / feaa4fb5 / #3317 M1 / R03R09-F02 (7f008c42 & bcbf684e):
    // Adapter owns `stdout-written-not-consumed`.
    // - Only transition `after-claim-before-output` -> `stdout-written-not-consumed` when `writeStdout`
    //   completes WITHOUT an error (`!writeErr`). If `writeStdout` passes a callback error (e.g. `EPIPE`),
    //   emits a stream `"error"` event, or throws synchronously, do NOT call `markStdoutWritten()`, keeping
    //   `after-claim-before-output` (or `claim-result-unknown`) intact so `emitStrandedClaimDiagnosticIfNeeded`
    //   emits the default secret-free stderr diagnostic line once.
    // - Even when `!writeErr`, calling `emitStrandedClaimDiagnosticIfNeeded` unconditionally inside the
    //   write callback (#3317 M1) ensures that if `SessionStart` produced non-empty `out` from
    //   `continuity`/`session-board` while a `session-message` claim remained `claim-result-unknown`,
    //   the default stderr diagnostic still fires without requiring `AGS_ANTIGRAVITY_DIAGNOSTIC_STDERR === "1"`.
    let settled = false;
    let onStreamError = null;
    const cleanupStreamListener = () => {
      if (onStreamError && stdoutStream && typeof stdoutStream.removeListener === "function") {
        stdoutStream.removeListener("error", onStreamError);
      }
      onStreamError = null;
    };
    // R10-F02 (bc631ee6): Preserve `settled` once-guard for state transition and diagnostic emission while keeping
    // the stream `"error"` listener alive across `callback(writeErr)` so the subsequent `"error"` event emitted by
    // Node Writable streams (`@types/node/stream.d.ts:864-868`) is consumed without `ERR_UNHANDLED_ERROR` and cleaned
    // up when that `"error"` event fires (or immediately on clean `!writeErr` / `"sync-throw"` completion).
    const settleWrite = (writeErr, source) => {
      if (!writeErr || source === "stream-error" || source === "sync-throw") {
        cleanupStreamListener();
      }
      if (settled) return;
      settled = true;
      if (!writeErr) {
        claimTracker.markStdoutWritten();
      }
      emitStrandedClaimDiagnosticIfNeeded(claimTracker, env, writeStderr);
    };
    if (stdoutStream && typeof stdoutStream.once === "function") {
      onStreamError = (streamErr) => {
        settleWrite(streamErr ?? new Error("stdout stream error"), "stream-error");
      };
      stdoutStream.once("error", onStreamError);
    }
    try {
      writeStdout(out, (writeErr) => {
        settleWrite(writeErr ?? null, "callback");
      });
    } catch (syncErr) {
      settleWrite(syncErr ?? new Error("stdout write sync throw"), "sync-throw");
    }
  } else {
    // #3313 N1: When a claim was attempted (`claim-result-unknown`) or received (`after-claim-before-output`)
    // but output is empty (e.g. response lost, timeout, or post-claim TrustStore failure), emit a 1-line
    // secret-free / body-free / messageId-free diagnostic to stderr so post-failure classification is observable.
    emitStrandedClaimDiagnosticIfNeeded(claimTracker, env, writeStderr);
  }
}

async function runConnector() {
  // #3313 N2: Anchor deadline at `timeOrigin` (`entryMonotonicMs = 0`) so `deadlineMonotonicMs = 9200` includes
  // Node startup and module load time, preserving the full 800ms reserve for final stdout serialization/flush.
  const entryMonotonicMs = 0;
  const claimTracker = createClaimStateTracker();
  let raw;
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    const hookArg = process.argv.find((a) => a.startsWith("--hook="))?.slice(7) ?? "";
    if (hookArg === "host-attestation") {
      process.stdout.write(JSON.stringify({ decision: "deny", reason: "Fail-closed: unable to read stdin for host-attestation." }));
    }
    return;
  }
  const out = await runConnectorFromRaw(raw, process.argv, { entryMonotonicMs, claimTracker });
  finalizeConnectorOutput(out, claimTracker);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runConnector().catch(() => {
    const hookArg = process.argv.find((a) => a.startsWith("--hook="))?.slice(7) ?? "";
    const eventArg = process.argv.find((a) => a.startsWith("--event="))?.slice(8) ?? "";
    if (hookArg === "host-attestation" || eventArg === "PreToolUse") {
      process.stdout.write(JSON.stringify({ decision: "deny", reason: "Fail-closed: unexpected top-level connector exception." }));
    }
  });
}
