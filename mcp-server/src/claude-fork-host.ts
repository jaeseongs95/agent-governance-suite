import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ForkHostParentRead } from "./host-input-adapter.js";

/**
 * D0352 N1z: the parent a Claude Code fork child was started from, read from the host process's own start arguments.
 * Real-host observation (tester c613, CLI 2.1.314, r13 f0517f6d and r14 36eaca13): a fork child's hook runs under
 * `sh` -> `claude` (native), and that claude's argv holds `--resume <parent id> --fork-session` for both `-p` and
 * interactive forks, with no child id. Plain resume holds the session's own id; startup holds none.
 * The fork child's own hook stdin carries no value equal to the parent id (c613 k2exe-r02 e5cb9c7b), so the argv
 * is the only host fact naming the parent.
 *
 * Authority (auditor 5970 b8136ae1, chief 6cdc3fa4 boundary): the argv of the host process that launched this hook,
 * bound to its pid and start time, is a host-process fact; no other session's process, file or store is consulted.
 * The caller uses it only together with the host's SessionStart source=fork record.
 * Every failure is a distinct reason; none of them yields a parent.
 *
 * Linux reads /proc at the fork start. Windows reads one process snapshot with one PowerShell start, never at
 * SessionStart (auditor 5970 W-2: the session-message hook already runs PowerShell there), but at the fork's first
 * write-capable or AGS tool boundary, before that tool runs and before the parent is pinned (see claudeForkHostRead).
 * macOS and other platforms return FORK_HOST_PLATFORM_UNSUPPORTED.
 *
 * Limits (out of scope, same OS user, auditor 5970 W-1/L): a process can rewrite its own /proc cmdline memory, can be
 * ptraced, can be started with `exec -a`; its executable file can be replaced between the check and its use; on
 * Windows a certificate the same user adds to the CurrentUser root store makes a forged signature Valid, and the file
 * hash is not verified (below), so the same user's edit of claude.exe that keeps its signature block is not detected.
 * TUI `/branch` is not observed.
 */
export interface HostProcessView {
  exe: string;
  argv: readonly string[];
  ppid: number;
  startToken: string;
  /** Linux: owner and mode of the running executable file (stat of /proc/<pid>/exe). */
  file?: { uid: number; mode: number };
  /** Windows: the Authenticode result of the executable, read only for claude.exe. */
  signature?: { status: string; subject: string };
}
export type HostProcessReader = (pid: number) => HostProcessView | "unreadable" | "changed";

// Linux: the hook command runs through at most two shells (sh, then possibly bash). Windows: Git Bash starts through
// bin\bash.exe -> usr\bin\bash.exe -> usr\bin\bash.exe (observed for this host's own Bash tool, 2026-10-31); the hook
// chain itself is not observed yet, so a deeper chain is a distinct reason (auditor 5970 W-3), not a silent pass.
const MAX_SHELLS: Partial<Record<NodeJS.Platform, number>> = { linux: 2, win32: 3 };
const SHELL_EXECUTABLES: Partial<Record<NodeJS.Platform, ReadonlySet<string>>> = {
  linux: new Set(["sh", "bash", "dash", "zsh"]),
  win32: new Set(["bash.exe", "sh.exe", "cmd.exe"]),
};
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
// The native binary shipped in the CLI package, as /proc/<pid>/exe reads it on the real host (tester c613 k2exe-r01
// a9e7656f, CLI 2.1.314): an absolute path ending in node_modules/@anthropic-ai/claude-code/bin/claude.exe.
// A node + cli.js installation runs as `node` and is deliberately not recognized (auditor 5970 Q2(b)).
// The official native installer runs the versioned file itself: <home>/.local/share/claude/versions/<x.y.z> (tester c613
// k2argv1-r06 1749c788, 2.1.316, uid = the user, mode 0755).
// ponytail: only observed install shapes; apt, dnf and brew paths are not observed and read as FORK_HOST_UNRECOGNIZED
// (lineage decides), add each once its /proc exe is observed.
export const CLAUDE_NATIVE_EXECUTABLE_PATTERN = /^\/(?:[^/]+\/)+(?:node_modules\/@anthropic-ai\/claude-code\/bin\/claude\.exe|\.local\/share\/claude\/versions\/\d+\.\d+\.\d+)$/u;
// Shared temporary directories are never a recognized install, as for the agy runner (UNTRUSTED_WRITABLE_PATH_PATTERN).
const TEMPORARY_PATH_PATTERN = /(?:^|\/)(?:tmp|var\/tmp|dev\/shm|temp)(?:\/|$)/iu;
// Windows: the signer of the running claude.exe on the real host (this PC, 2026-10-31): Status Valid,
// O="Anthropic, PBC", issued by DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1. The organization is matched
// exactly (auditor 5970 W-1); the thumbprint is not pinned so a certificate renewal keeps working.
const CLAUDE_SIGNER_ORGANIZATION = "Anthropic, PBC";
/** Below the 10 s hook timeouts and the 9 s launcher limit, so a slow query ends as a recorded reason (W-2(b)). */
export const WINDOWS_QUERY_TIMEOUT_MS = 6000;

function statFields(pid: number): string[] {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
}

/** pid, executable, argv and parent from /proc, bound to one process instance by its start time read twice. */
export function linuxHostProcess(pid: number): HostProcessView | "unreadable" | "changed" {
  try {
    const before = statFields(pid);
    const exe = readlinkSync(`/proc/${pid}/exe`);
    const executable = statSync(`/proc/${pid}/exe`);
    const raw = readFileSync(`/proc/${pid}/cmdline`).toString("utf8");
    const after = statFields(pid);
    const ppid = Number(before[1]);
    const startToken = before[19];
    if (!startToken || !Number.isInteger(ppid) || ppid < 1) return "unreadable";
    if (after[19] !== startToken) return "changed";
    const argv = raw.split("\0");
    if (argv.at(-1) === "") argv.pop();
    return { exe, argv, ppid, startToken, file: { uid: executable.uid, mode: executable.mode } };
  } catch {
    return "unreadable";
  }
}

/** Windows command-line splitting as CommandLineToArgvW does it (program name first, then the MSVC rules). */
export function windowsCommandLineArgv(commandLine: string): string[] {
  const argv: string[] = [];
  const length = commandLine.length;
  let index = 0;
  // Program name: up to the first unquoted space or tab; quotes only toggle, backslashes are literal.
  let program = "";
  let quoted = false;
  for (; index < length; index += 1) {
    const character = commandLine[index]!;
    if (character === "\"") quoted = !quoted;
    else if (!quoted && (character === " " || character === "\t")) break;
    else program += character;
  }
  argv.push(program);
  for (;;) {
    while (index < length && (commandLine[index] === " " || commandLine[index] === "\t")) index += 1;
    if (index >= length) break;
    let argument = "";
    quoted = false;
    while (index < length) {
      const character = commandLine[index]!;
      if (character === "\\") {
        let slashes = 0;
        while (commandLine[index] === "\\") { slashes += 1; index += 1; }
        if (commandLine[index] === "\"") {
          argument += "\\".repeat(slashes >> 1);
          if (slashes % 2 === 1) { argument += "\""; index += 1; }
        } else argument += "\\".repeat(slashes);
        continue;
      }
      if (character === "\"") {
        if (quoted && commandLine[index + 1] === "\"") { argument += "\""; index += 2; continue; }
        quoted = !quoted;
        index += 1;
        continue;
      }
      if (!quoted && (character === " " || character === "\t")) break;
      argument += character;
      index += 1;
    }
    argv.push(argument);
  }
  return argv;
}

/** The single value of one attribute in a certificate subject; null when it is absent or repeated. */
export function distinguishedNameValue(subject: string, key: string): string | null {
  const values: string[] = [];
  for (const match of subject.matchAll(/(?:^|,)\s*([A-Za-z][A-Za-z0-9.]*)=("(?:[^"]|"")*"|[^,]*)/gu)) {
    if (match[1]!.toUpperCase() !== key.toUpperCase()) continue;
    const raw = match[2]!.trim();
    values.push(raw.startsWith("\"") ? raw.slice(1, -1).replaceAll("\"\"", "\"") : raw);
  }
  return values.length === 1 ? values[0]! : null;
}

export interface WindowsProcessRow {
  pid: number; ppid: number; exe: string; cmd: string; created: string;
  sig?: { status: string; subject: string } | null;
}
export type CommandRunner = (file: string, args: readonly string[]) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "error">;

// D0352 Windows real host (tester c613 4ac47189, reviewer 902e d6037769): Get-AuthenticodeSignature hashes the whole
// 335 MB claude.exe, about 2.9 s warm on this PC, so the snapshot ended in FORK_HOST_QUERY_TIMEOUT at 6 s. The signer
// certificate and its chain are read instead (the cold snapshot measured 1.4-1.7 s on the same PC; 4.9 s with the
// hash). The same-user file edit this skips is already out of scope (Limits above). Revocation is not checked and
// certificate downloads wait at most 1 s, so the read stays local and bounded. Unsigned -> NotSigned, chain not built
// -> NotTrusted (FORK_HOST_SIGNATURE_UNTRUSTED); any other failure fails the script (FORK_HOST_PROCESS_UNREADABLE).
function windowsSnapshotScript(pid: number): string {
  return "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$ErrorActionPreference='Stop';$all=@{};"
    + "foreach($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate){$all[[int]$p.ProcessId]=$p};"
    + `$id=${pid};$out=@();for($i=0;$i -lt 8 -and $all.ContainsKey($id);$i++){$p=$all[$id];$sig=$null;`
    + "if($p.Name -ieq 'claude.exe' -and $p.ExecutablePath){"
    + "try{$c=[System.Security.Cryptography.X509Certificates.X509Certificate2]::new([System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($p.ExecutablePath))}"
    + "catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};if($e -isnot [System.Security.Cryptography.CryptographicException]){throw};$c=$null};"
    + "if($c){$ch=[System.Security.Cryptography.X509Certificates.X509Chain]::new();$ch.ChainPolicy.RevocationMode='NoCheck';"
    + "$ch.ChainPolicy.UrlRetrievalTimeout=[TimeSpan]::FromSeconds(1);"
    + "$sig=@{status=$(if($ch.Build($c)){'Valid'}else{'NotTrusted'});subject=[string]$c.Subject}}"
    + "else{$sig=@{status='NotSigned';subject=''}}};"
    + "$out+=@{pid=[int]$p.ProcessId;ppid=[int]$p.ParentProcessId;exe=[string]$p.ExecutablePath;cmd=[string]$p.CommandLine;"
    + "created=[string]$p.CreationDate.ToFileTimeUtc();sig=$sig};$id=[int]$p.ParentProcessId};"
    + "ConvertTo-Json -Compress -Depth 4 -InputObject @($out)";
}

const runHidden: CommandRunner = (file, args) => spawnSync(file, args, {
  encoding: "utf8", windowsHide: true, timeout: WINDOWS_QUERY_TIMEOUT_MS, maxBuffer: 1 << 20, stdio: ["ignore", "pipe", "ignore"],
});

function validRow(row: unknown): row is WindowsProcessRow {
  if (!row || typeof row !== "object") return false;
  const value = row as Record<string, unknown>;
  const sig = value.sig as Record<string, unknown> | null | undefined;
  return Number.isInteger(value.pid) && Number.isInteger(value.ppid) && typeof value.exe === "string"
    && typeof value.cmd === "string" && typeof value.created === "string" && /^\d+$/u.test(value.created)
    && (sig === undefined || sig === null || (typeof sig.status === "string" && typeof sig.subject === "string"));
}

/**
 * This process and its ancestors from one Win32_Process snapshot, with the Authenticode result of each claude.exe,
 * from one hidden PowerShell start (System32 path, no profile). Over WINDOWS_QUERY_TIMEOUT_MS it is a reason.
 */
export function windowsHostSnapshot(pid: number = process.pid, run: CommandRunner = runHidden): WindowsProcessRow[] | { reason: string } {
  const shell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = run(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", windowsSnapshotScript(pid)]);
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") return { reason: "FORK_HOST_QUERY_TIMEOUT" };
  if (result.error || result.status !== 0) return { reason: "FORK_HOST_PROCESS_UNREADABLE" };
  let rows: unknown;
  try { rows = JSON.parse(result.stdout); } catch { return { reason: "FORK_HOST_PROCESS_UNREADABLE" }; }
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every(validRow) || rows[0]!.pid !== pid) return { reason: "FORK_HOST_PROCESS_UNREADABLE" };
  return rows;
}

/** Reader over a snapshot chain: an ancestor created after its child holds a reused pid (changed, auditor 5970 W-3). */
export function windowsHostReader(rows: readonly WindowsProcessRow[]): HostProcessReader {
  const views = new Map<number, HostProcessView | "changed">();
  rows.forEach((row, index) => {
    const child = rows[index - 1];
    const reused = child !== undefined && (child.ppid !== row.pid || BigInt(row.created) > BigInt(child.created));
    views.set(row.pid, reused ? "changed" : {
      exe: row.exe, argv: windowsCommandLineArgv(row.cmd), ppid: row.ppid, startToken: row.created,
      ...(row.sig ? { signature: { status: row.sig.status, subject: row.sig.subject } } : {}),
    });
  });
  return pid => views.get(pid) ?? "unreadable";
}

/**
 * `--resume <id>` (or `--resume=<id>`, or the CLI's short alias `-r <id>`) together with `--fork-session`, each exactly
 * once, before any `--`. Any other short form naming `r` (`-r<id>`, `-r=<id>`, a cluster such as `-cr`) is not parsed:
 * it counts as a resume without a readable id, so it never yields a parent and never lets another id win.
 */
export function forkParentFromArgv(argv: readonly string[], sessionId: string): ForkHostParentRead {
  let forks = 0;
  const ids: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") break;
    if (argument === "--fork-session") forks += 1;
    else if (argument === "--resume" || argument === "-r") {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith("-")) { ids.push(value); index += 1; } else ids.push("");
    } else if (argument.startsWith("--resume=")) ids.push(argument.slice("--resume=".length));
    else if (/^-[^-]/u.test(argument) && argument.slice(1).includes("r")) ids.push("");
  }
  if (forks === 0) return { reason: "FORK_HOST_ARGV_NOT_FORK" };
  if (ids.length === 0) return { reason: "FORK_HOST_ARGV_NO_PARENT" };
  if (forks > 1 || ids.length > 1) return { reason: "FORK_HOST_ARGV_AMBIGUOUS" };
  // `--resume` without an id opens the host's session picker: the argv does not say which session was forked.
  if (ids[0] === "") return { reason: "FORK_HOST_ARGV_NO_PARENT" };
  if (!SESSION_ID_PATTERN.test(ids[0]!)) return { reason: "FORK_HOST_ARGV_PARENT_INVALID" };
  if (ids[0] === sessionId) return { reason: "FORK_HOST_ARGV_SELF" };
  return { parentSessionId: ids[0]! };
}

/**
 * This hook's own Claude launcher: claude-plugin/hooks/<name>.mjs runs mcp-server/dist/<name>.mjs with the same node
 * (claude-overlay/hooks/*.mjs spawnSync(process.execPath, [hookPath])), so the bundled hook's parent is that launcher,
 * not the host (tester c613 k2argv1-r01 7b551a88: every fork-host-parent record was a reason). Null when this process is
 * not a bundled hook entry.
 */
export interface HookLauncher { exe: string; script: string }
export function ownHookLauncher(entry: string | undefined = process.argv[1], execPath: string = process.execPath): HookLauncher | null {
  if (!entry) return null;
  const dist = path.dirname(entry);
  if (path.basename(dist) !== "dist" || path.basename(path.dirname(dist)) !== "mcp-server") return null;
  return { exe: execPath, script: path.join(path.dirname(path.dirname(dist)), "hooks", path.basename(entry)) };
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sameFile(candidate: string | undefined, expected: string, platform: NodeJS.Platform): boolean {
  if (!candidate) return false;
  if (samePath((platform === "win32" ? path.win32 : path.posix).resolve(candidate), expected, platform)) return true;
  try { return samePath(realpathSync(candidate), realpathSync(expected), platform); } catch { return false; }
}

/** Null when the nearest non-shell process is the native claude of a recognized install, otherwise the reason. */
function unrecognizedHost(view: HostProcessView, platform: NodeJS.Platform, uid: number): string | null {
  if (platform === "win32") {
    if (path.win32.basename(view.exe).toLowerCase() !== "claude.exe" || TEMPORARY_PATH_PATTERN.test(view.exe.replaceAll("\\", "/"))) {
      return "FORK_HOST_UNRECOGNIZED";
    }
    const signature = view.signature;
    if (!signature || signature.status === "NotSigned") return "FORK_HOST_SIGNATURE_MISSING";
    if (signature.status === "HashMismatch") return "FORK_HOST_SIGNATURE_INVALID";
    if (signature.status !== "Valid") return "FORK_HOST_SIGNATURE_UNTRUSTED";
    return distinguishedNameValue(signature.subject, "O") === CLAUDE_SIGNER_ORGANIZATION ? null : "FORK_HOST_SIGNER_UNRECOGNIZED";
  }
  if (!CLAUDE_NATIVE_EXECUTABLE_PATTERN.test(view.exe) || TEMPORARY_PATH_PATTERN.test(view.exe)) return "FORK_HOST_UNRECOGNIZED";
  // Auditor 5970 L: owned by this user or root, and not writable by group or others.
  const file = view.file;
  if (!file || (file.uid !== uid && file.uid !== 0) || (file.mode & 0o022) !== 0) return "FORK_HOST_EXECUTABLE_UNSAFE";
  return null;
}

/**
 * The nearest host process above this hook: past this hook's own launcher (once, only when it is exactly that launcher
 * script under the same node) and at most MAX_SHELLS shells, it must be the native claude.
 */
export function readClaudeForkHostParent(sessionId: string, platform: NodeJS.Platform = process.platform,
  firstPid: number = process.ppid, read?: HostProcessReader, launcher: HookLauncher | null = ownHookLauncher(),
  uid: number = process.getuid?.() ?? -1): ForkHostParentRead {
  const maxShells = MAX_SHELLS[platform];
  const shellNames = SHELL_EXECUTABLES[platform];
  if (maxShells === undefined || shellNames === undefined) return { reason: "FORK_HOST_PLATFORM_UNSUPPORTED" };
  let reader = read;
  if (!reader) {
    if (platform === "linux") reader = linuxHostProcess;
    else {
      const snapshot = windowsHostSnapshot();
      if ("reason" in snapshot) return snapshot;
      reader = windowsHostReader(snapshot);
    }
  }
  const base = platform === "win32" ? path.win32.basename : path.posix.basename;
  let pid = firstPid;
  let launcherSkipped = launcher === null;
  for (let shells = 0; ; shells += 1) {
    const view = reader(pid);
    if (view === "unreadable") return { reason: "FORK_HOST_PROCESS_UNREADABLE" };
    if (view === "changed") return { reason: "FORK_HOST_PROCESS_CHANGED" };
    if (!launcherSkipped) {
      launcherSkipped = true;
      if (samePath(view.exe, launcher!.exe, platform) && sameFile(view.argv[1], launcher!.script, platform)) { pid = view.ppid; shells -= 1; continue; }
    }
    if (shellNames.has(base(view.exe).toLowerCase())) {
      if (shells >= maxShells) return { reason: "FORK_HOST_SHELL_DEPTH_EXCEEDED" };
      pid = view.ppid;
      continue;
    }
    const unrecognized = unrecognizedHost(view, platform, uid);
    if (unrecognized) return { reason: unrecognized };
    const parent = forkParentFromArgv(view.argv, sessionId);
    if (platform !== "win32" || !("parentSessionId" in parent)) return parent;
    // The CN is recorded only when the subject holds exactly one, so a record without `s` shows it had none (5970 F1).
    const commonName = distinguishedNameValue(view.signature!.subject, "CN");
    return commonName === null ? parent : { ...parent, signer: commonName };
  }
}

/**
 * The host-process read a Claude hook offers at this boundary. Linux reads at the fork start. Windows defers the
 * start (no PowerShell at SessionStart) and reads at a tool boundary; other platforms record their reason at the start.
 */
export function claudeForkHostRead(sessionId: string, phase: "start" | "boundary",
  platform: NodeJS.Platform = process.platform): (() => ForkHostParentRead) | undefined {
  if (phase === "boundary") return platform === "win32" ? () => readClaudeForkHostParent(sessionId, platform) : undefined;
  return platform === "win32" ? () => ({ deferred: true }) : () => readClaudeForkHostParent(sessionId, platform);
}
