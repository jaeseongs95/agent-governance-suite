import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import { hostActorId, type HostObservation, isReasoningEffort } from "./host-attestation.js";
import { codexExecutionAdapter } from "./host-execution-adapters.js";

export const CODEX_METADATA_HEAD_BYTES = 256 * 1024;
export const CODEX_METADATA_TAIL_BYTES = 8 * 1024 * 1024;

export interface CodexMetadataWindow { head: string; tail: string }
export interface CodexObservationOptions {
  readMetadata?: (file: string) => CodexMetadataWindow | null;
}
export type CodexObservationResult =
  | { observation: Omit<HostObservation, "tool" | "input">; reason: null }
  | { observation: null; reason: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

/** Fixed read budget, no whole-history scan, polling or persistent metadata cache. */
export function readCodexMetadata(file: string): CodexMetadataWindow | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(file, "r");
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) return null;
    const read = (position: number, bytes: number): string => {
      const buffer = Buffer.alloc(bytes);
      return buffer.subarray(0, readSync(descriptor!, buffer, 0, bytes, position)).toString("utf8");
    };
    const head = read(0, Math.min(stats.size, CODEX_METADATA_HEAD_BYTES));
    const position = Math.max(0, stats.size - CODEX_METADATA_TAIL_BYTES);
    const tail = read(position, stats.size - position);
    return { head, tail: position > 0 ? tail.slice(tail.indexOf("\n") + 1) : tail };
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/** Only host metadata records are parsed; chat content, credentials and tool bodies are not exported. */
export function observeCodexHook(input: Record<string, unknown>, options: CodexObservationOptions = {}): CodexObservationResult {
  const missing = (reason: string): CodexObservationResult => ({ observation: null, reason });
  const sessionId = text(input.session_id);
  const turnId = text(input.turn_id);
  const toolUseId = text(input.tool_use_id);
  const model = text(input.model);
  const transcript = text(input.transcript_path);
  if (!sessionId || !turnId || !toolUseId || !model || !transcript) return missing("missing-current-session-turn-call-model-or-transcript");
  // Codex documents parent session IDs for subagent hooks. Never borrow the parent's execution settings.
  if (text(input.agent_id)) return missing("subagent-identity-not-supported");
  const window = (options.readMetadata ?? readCodexMetadata)(transcript);
  if (!window) return missing("host-metadata-unreadable");
  let metadata: Record<string, unknown> | null = null;
  try {
    const first = record(JSON.parse(window.head.split("\n", 1)[0] ?? ""));
    if (first?.type === "session_meta") metadata = record(first.payload);
  } catch { /* A truncated or changed metadata format remains unsupported. */ }
  if (!metadata || metadata.id !== sessionId || (metadata.session_id !== undefined && metadata.session_id !== sessionId)) {
    return missing("host-session-mismatch-or-unsupported-metadata");
  }
  if (record(metadata.source)?.subagent || record(metadata.thread_source)?.subagent) return missing("subagent-identity-not-supported");
  let context: Record<string, unknown> | null = null;
  const lines = window.tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.slice(0, 200).includes('"type":"turn_context"')) continue;
    try {
      const entry = record(JSON.parse(line));
      if (entry?.type === "turn_context") { context = record(entry.payload); break; }
    } catch { /* Ignore incomplete lines, never replace metadata with caller settings. */ }
  }
  if (!context) return missing("current-turn-metadata-outside-bounded-window-or-missing");
  if (context.turn_id !== turnId) return missing("host-turn-mismatch");
  if (context.model !== model) return missing("host-model-mismatch");
  if (!isReasoningEffort(context.effort)) return missing("host-reasoning-effort-missing-or-unsupported");
  if (!codexExecutionAdapter.modelClassForModel(model)) return missing("host-model-policy-unsupported");
  return {
    observation: {
      model, reasoningEffort: context.effort,
      actorId: hostActorId(codexExecutionAdapter.host, sessionId),
      sessionId, turnId, toolUseId,
    },
    reason: null,
  };
}
