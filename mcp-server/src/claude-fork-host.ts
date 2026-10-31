import { readFileSync, readlinkSync } from "node:fs";
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
 * Limits (out of scope, same OS user): a process can rewrite its own /proc cmdline memory, can be ptraced, can be
 * started with `exec -a`, and its executable file can be replaced. Only Linux /proc is read; macOS and Windows return
 * FORK_HOST_PLATFORM_UNSUPPORTED (no PowerShell or ps query is added to SessionStart; real-host Windows argv is not
 * observed yet). TUI `/branch` is not observed.
 */
export interface HostProcessView { exe: string; argv: readonly string[]; ppid: number; startToken: string }
export type HostProcessReader = (pid: number) => HostProcessView | "unreadable" | "changed";

/** The hook command runs through at most this many shells before the host process. */
const MAX_SHELLS = 2;
const SHELL_EXECUTABLES = new Set(["sh", "bash", "dash", "zsh"]);
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
// The native binary shipped in the CLI package, as /proc/<pid>/exe reads it on the real host (tester c613 k2exe-r01
// a9e7656f, CLI 2.1.314): an absolute path ending in node_modules/@anthropic-ai/claude-code/bin/claude.exe.
// A node + cli.js installation runs as `node` and is deliberately not recognized (auditor 5970 Q2(b)).
// ponytail: only the observed install shape; the standalone installer's path is not observed yet and reads as
// FORK_HOST_UNRECOGNIZED (lineage decides), add it once its /proc exe is observed.
export const CLAUDE_NATIVE_EXECUTABLE_PATTERN = /^\/(?:[^/]+\/)+node_modules\/@anthropic-ai\/claude-code\/bin\/claude\.exe$/u;

function statFields(pid: number): string[] {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
}

/** pid, executable, argv and parent from /proc, bound to one process instance by its start time read twice. */
export function linuxHostProcess(pid: number): HostProcessView | "unreadable" | "changed" {
  try {
    const before = statFields(pid);
    const exe = readlinkSync(`/proc/${pid}/exe`);
    const raw = readFileSync(`/proc/${pid}/cmdline`).toString("utf8");
    const after = statFields(pid);
    const ppid = Number(before[1]);
    const startToken = before[19];
    if (!startToken || !Number.isInteger(ppid) || ppid < 1) return "unreadable";
    if (after[19] !== startToken) return "changed";
    const argv = raw.split("\0");
    if (argv.at(-1) === "") argv.pop();
    return { exe, argv, ppid, startToken };
  } catch {
    return "unreadable";
  }
}

/** `--resume <id>` (or `--resume=<id>`) together with `--fork-session`, each exactly once, before any `--`. */
export function forkParentFromArgv(argv: readonly string[], sessionId: string): ForkHostParentRead {
  let forks = 0;
  const ids: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") break;
    if (argument === "--fork-session") forks += 1;
    else if (argument === "--resume") {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith("-")) { ids.push(value); index += 1; } else ids.push("");
    } else if (argument.startsWith("--resume=")) ids.push(argument.slice("--resume=".length));
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

/** The nearest host process above this hook: past at most MAX_SHELLS shells, it must be the native claude. */
export function readClaudeForkHostParent(sessionId: string, platform: NodeJS.Platform = process.platform,
  firstPid: number = process.ppid, read: HostProcessReader = linuxHostProcess): ForkHostParentRead {
  if (platform !== "linux") return { reason: "FORK_HOST_PLATFORM_UNSUPPORTED" };
  let pid = firstPid;
  for (let shells = 0; ; shells += 1) {
    const view = read(pid);
    if (view === "unreadable") return { reason: "FORK_HOST_PROCESS_UNREADABLE" };
    if (view === "changed") return { reason: "FORK_HOST_PROCESS_CHANGED" };
    if (SHELL_EXECUTABLES.has(path.posix.basename(view.exe)) && shells < MAX_SHELLS) { pid = view.ppid; continue; }
    if (!CLAUDE_NATIVE_EXECUTABLE_PATTERN.test(view.exe)) return { reason: "FORK_HOST_UNRECOGNIZED" };
    return forkParentFromArgv(view.argv, sessionId);
  }
}
