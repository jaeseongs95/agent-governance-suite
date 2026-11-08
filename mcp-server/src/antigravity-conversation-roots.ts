import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hookFailure, retainHookFailureCause, retainHookFailureSecondary } from "./hook-error-diagnostics.js";
import { resolveWorkflowDatabasePath } from "./runtime-config.js";

/**
 * agy names a subagent's root conversation only in its MCP tools/call `_meta`; the subagent's own hook input carries its
 * conversation ID and nothing that names the root or the parent (agy 1.5.3 Linux capture, AGS3-D-0068). The caller
 * ingress records each subagent conversation's root here so the agy hook adapter can give that subagent's later hooks
 * its root session. Hooks that run before the subagent's first AGS tool call find no record.
 * ceiling: one small file per agy subagent conversation, never pruned; move into the workflow store with the state
 * cleanup if the count matters.
 */
export function antigravityConversationRootDirectory(databasePath: string = resolveWorkflowDatabasePath()): string {
  return path.join(path.dirname(databasePath), "antigravity-conversation-roots");
}

function rootFile(directory: string, conversation: string): string {
  return path.join(directory, `${createHash("sha256").update(conversation, "utf8").digest("hex").slice(0, 32)}.json`);
}

/** Called only with the conversation and root the host wrote into a verified tools/call `_meta`. */
export function recordAntigravityConversationRoot(directory: string, conversation: string, root: string): void {
  if (readAntigravityConversationRoot(directory, conversation) === root) return;
  const file = rootFile(directory, conversation);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, JSON.stringify({ conversation, root }), "utf8");
    renameSync(temporary, file);
  } catch (cause) {
    const failure = retainHookFailureCause(hookFailure("ANTIGRAVITY_CONVERSATION_ROOT_WRITE_FAILED", "agy conversation root write failed."), cause);
    try { rmSync(temporary, { force: true }); } catch (cleanup) { retainHookFailureSecondary(failure, cleanup); }
    throw failure;
  }
}

/** The recorded root of a subagent conversation; null when none is recorded. A record that is not this one throws. */
export function readAntigravityConversationRoot(directory: string, conversation: string): string | null {
  let raw: string;
  try { raw = readFileSync(rootFile(directory, conversation), "utf8"); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw retainHookFailureCause(hookFailure("ANTIGRAVITY_CONVERSATION_ROOT_READ_FAILED", "agy conversation root read failed."), cause);
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { value = null; }
  const fields = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (fields.conversation !== conversation || typeof fields.root !== "string" || !fields.root || fields.root === conversation) {
    throw hookFailure("ANTIGRAVITY_CONVERSATION_ROOT_INVALID", "agy conversation root record is invalid.");
  }
  return fields.root;
}
