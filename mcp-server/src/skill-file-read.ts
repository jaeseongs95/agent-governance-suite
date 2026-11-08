import { fileURLToPath } from "node:url";

/** This package's root: hooks and the skills they watch are installed together (`mcp-server/dist/x.mjs`, `skills/`). */
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// A command that names the file without one of these (`ls`, `test -f`) only looked at it. The list follows the skill-call
// rule of tests/real-host/cue-ab/DESIGN.md.
const READ_COMMAND = /(?:^|[\s;&|("'`])(?:cat|sed|head|tail|nl|less|more|bat|awk|perl|python3?|node|type|Get-Content|gc|cut|strings|od|xxd)(?=[\s"'`]|$)/iu;

const slashes = (value: string): string => value.replace(/\\+/gu, "/");

/**
 * The AGS skills whose SKILL.md `value` names under this package. Another copy of the same file (a source checkout an
 * agent is working on) is not a skill being used, and a skill of another plugin is not one AGS tracks.
 */
export function skillFilesNamed(value: unknown, root: string = PACKAGE_ROOT): string[] {
  if (typeof value !== "string") return [];
  const base = slashes(root).replace(/\/+$/u, "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`${base}/skills/([a-z0-9][a-z0-9-]*)/SKILL\\.md`, process.platform === "win32" ? "giu" : "gu");
  return [...new Set([...slashes(value).matchAll(pattern)].map(match => match[1]!))];
}

/** The same for a shell command, given as one string or as an argument list. */
export function skillFilesReadByCommand(command: unknown, root: string = PACKAGE_ROOT): string[] {
  const line = Array.isArray(command) ? command.filter(part => typeof part === "string").join(" ") : command;
  return typeof line === "string" && READ_COMMAND.test(line) ? skillFilesNamed(line, root) : [];
}
