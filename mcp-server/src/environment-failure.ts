/** A tool result's tail read for a run failure: an error ends up last, and a hook stays fast on a large result. */
export const HOOK_TOOL_RESULT_MAX_CHARACTERS = 65_536;

/** Characters kept on each side of a matched failure to tell it from another failure. */
const FAILURE_CONTEXT_CHARACTERS = 80;

/**
 * A tool result that says the run's environment lacked something: a program, a path or a permission (AGS3-D-0049).
 * These are operating-system and runtime messages, the same whichever host or task produced them.
 * ceiling: a result that only quotes such a message (a log read through a shell or a remote command) matches too; the
 * caller shows one short line once per distinct failure, so a false match costs that line.
 */
const ENVIRONMENT_FAILURE = /ENOENT|EACCES|command not found|is not recognized as|No such file or directory|Permission denied|FileNotFoundError|ModuleNotFoundError|\b(?:Python \d|executable|program)\b.{0,40}\bnot found|cannot find the (?:file|path)|지정된 (?:파일|경로)를 찾을 수 없습니다/iu;

/** The key that tells one failure from another (digits differ between runs of the same failure), or null when there is none. */
export function environmentFailureKey(toolResult: string): string | null {
  const match = ENVIRONMENT_FAILURE.exec(toolResult);
  if (!match) return null;
  const start = Math.max(0, match.index - FAILURE_CONTEXT_CHARACTERS);
  return toolResult.slice(start, match.index + match[0].length + FAILURE_CONTEXT_CHARACTERS).replace(/\d+/gu, "#");
}
