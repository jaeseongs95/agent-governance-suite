import { isHookEntry } from "./hook-entry.js";
import { hookFailureContext, hookFailureReason, retainHookFailureSecondary, writeFailureDiagnostic } from "./hook-error-diagnostics.js";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  type HostExecutionAdapter,
  hostActorId,
  hostIdentityDigest,
  lowerReasoningEffort,
  isReasoningEffort,
} from "./host-attestation.js";
import { claudeCodeExecutionAdapter } from "./host-execution-adapters.js";
import { resolveWorkflowDatabasePath } from "./runtime-config.js";
import type { CallerExecution } from "./caller-identity.js";
import { resolveHookHost } from "./host-input-adapter.js";

type HookInput = Record<string, unknown>;

type HookObservationFailureCode = "TRANSCRIPT_READ_FAILED" | "CURRENT_CALL_INVALID_JSON"
  | "SESSION_MODEL_READ_FAILED" | "SESSION_MODEL_INVALID" | "SESSION_MODEL_WRITE_FAILED" | "INVALID_HOOK_INPUT" | "CURRENT_CALL_INVALID_SHAPE"
  | "TRANSCRIPT_LIMIT_EXCEEDED";

/** The failed step is the code; the actual I/O or parse error is kept as the cause. */
class HookObservationFailure extends Error {
  readonly code: HookObservationFailureCode;
  constructor(code: HookObservationFailureCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.code = code;
  }
}

function reportObservationFailure(phase: string, reason: string, cause?: unknown): void {
  try { writeFailureDiagnostic(JSON.stringify({ component: "host-attestation-hook", phase, reason,
    ...(cause === undefined ? {} : { context: hookFailureContext(cause) }) }) + "\n"); }
  catch { /* Diagnostics cannot authorize a call or block argument stripping. */ }
}

export interface TranscriptObservation {
  model: string;
  effort: string | null;
}

/** The session model that SessionStart or PostModelSwitch reported, and when the hook saw it. */
export interface SessionModelRecord {
  model: string;
  source: "session-start" | "model-switch";
  observedAt: string;
}

export interface HostAttestationHookOptions {
  /** Trusted tool-ownership adapter, separate from the execution model policy. */
  host?: string;
  readText?: (file: string) => string | null;
  sleep?: (milliseconds: number) => void;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  readSessionModel?: (sessionId: string) => SessionModelRecord | null;
  adapter?: HostExecutionAdapter;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export const CLAUDE_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;

function readTextOrNull(file: string): string | null {
  let descriptor: number | null = null;
  let failure: HookObservationFailure | null = null;
  let content: string | null = null;
  try {
    descriptor = openSync(file, "r");
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      // Retain the native directory-read cause with a bounded read; reject other non-files.
      if (stats.isDirectory()) readSync(descriptor, Buffer.alloc(1), 0, 1, 0);
      throw new HookObservationFailure("TRANSCRIPT_READ_FAILED");
    }
    if (stats.size > CLAUDE_TRANSCRIPT_MAX_BYTES) throw new HookObservationFailure("TRANSCRIPT_LIMIT_EXCEEDED");
    // Include one growth sentinel; a partial history must never authorize a model fallback.
    const buffer = Buffer.alloc(CLAUDE_TRANSCRIPT_MAX_BYTES + 1);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes > CLAUDE_TRANSCRIPT_MAX_BYTES) throw new HookObservationFailure("TRANSCRIPT_LIMIT_EXCEEDED");
    if (bytes < stats.size) throw new HookObservationFailure("TRANSCRIPT_READ_FAILED");
    content = buffer.subarray(0, bytes).toString("utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      failure = cause instanceof HookObservationFailure ? cause : new HookObservationFailure("TRANSCRIPT_READ_FAILED", cause);
    }
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); }
      catch (cleanup) {
        if (failure) retainHookFailureSecondary(failure, cleanup);
        else failure = new HookObservationFailure("TRANSCRIPT_READ_FAILED", cleanup);
      }
    }
  }
  if (failure) throw failure;
  return content;
}

const digest = hostIdentityDigest;

/** Actor IDs are persisted in plans and receipts, so raw session and agent IDs are stored only as digests. */
export function claudeCodeActorId(sessionId: string, agentId: string | null): string {
  return hostActorId(claudeCodeExecutionAdapter.host, sessionId, agentId);
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Transcripts that can hold the assistant message for this call: the given one and the subagent's own file. */
export function transcriptCandidates(transcriptPath: string, sessionId: string, agentId: string | null): string[] {
  const candidates = [transcriptPath];
  if (agentId) {
    candidates.push(path.join(path.dirname(transcriptPath), sessionId, "subagents", `agent-${agentId}.jsonl`));
  }
  return [...new Set(candidates)];
}

/**
 * Finds the assistant message that issued toolUseId, as recorded by the harness,
 * and returns the model and effort stored with it.
 */
export function findToolUseObservation(
  transcript: string,
  toolUseId: string,
  sessionId: string,
  agentId: string | null,
): TranscriptObservation | null {
  const lines = transcript.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line || !mentionsToolUseId(line, toolUseId)) continue;
    let entry: Record<string, unknown> | null;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry || entry.type !== "assistant") continue;
    const message = record(entry.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const issued = content.some((block) => record(block)?.type === "tool_use" && record(block)?.id === toolUseId);
    if (!issued) continue;
    if (entry.sessionId !== undefined && entry.sessionId !== sessionId) return null;
    if (agentId ? entry.agentId !== agentId : entry.isSidechain === true) return null;
    const model = text(message?.model);
    if (!model) return null;
    return { model, effort: text(entry.effort) };
  }
  return null;
}

function mentionsToolUseId(line: string, toolUseId: string): boolean {
  if (line.includes(toolUseId)) return true;
  if (!line.includes("\\")) return false;
  // Safe ASCII IDs can only be hidden by Unicode escapes, not quote/slash/control escapes.
  if (/^[A-Za-z0-9._:-]+$/u.test(toolUseId) && !line.includes("\\u")) return false;
  // A hint only: decoding valid escapes in a damaged row never establishes an issuer.
  // One pass preserves double-escaped literals instead of decoding them recursively.
  const decoded = line.replace(/\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/gu,
    (escape) => JSON.parse('"' + escape + '"') as string);
  return decoded.includes(toolUseId);
}

/**
 * A damaged content block stays unknown unless intact metadata proves it unrelated.
 * Prefix checks never supply model, effort, identity or signing observations.
 */
function hasIncompleteIssuer(line: string, toolUseId: string): boolean {
  try {
    const entry = record(JSON.parse(line));
    const content = record(entry?.message)?.content;
    return entry?.type !== "user" && entry?.type !== "system" && Array.isArray(content)
      && content.some(value => record(value)?.type === "tool_use" && !text(record(value)?.id));
  } catch { /* A damaged row needs absence evidence, not successful recovery. */ }

  type Role = "root" | "message" | "content" | "block" | "other";
  type Prefix = { end: number; closing: string; partial?: "id" | "type"; value?: string; start?: number };
  const frames: { closing: string; role: Role }[] = [];
  let hasBlock = false;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let stringField: unknown = null;
  let lastTokenWasString = false;
  let field: unknown = null;
  let rootType: Prefix | null = null;
  let blockType: Prefix | null = null;
  let blockId: Prefix | null = null;
  let typeStart = -1;
  let idStart = -1;
  const snapshot = (end: number): Prefix => ({ end, closing: frames.map(frame => frame.closing).reverse().join("") });

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const parent = frames.at(-1)?.role;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        inString = false;
        lastTokenWasString = true;
        if (parent === "root" && stringField === "type") rootType = snapshot(index + 1);
        if (parent === "block" && stringField === "type") blockType = snapshot(index + 1);
        if (parent === "block" && stringField === "id") blockId = snapshot(index + 1);
      }
      continue;
    }
    if (!char?.trim()) continue;
    if (char === ":" && lastTokenWasString) {
      try { field = JSON.parse(line.slice(stringStart, index).trimEnd()); } catch { field = null; }
      if (parent === "block" && field === "id") idStart = index;
      if (parent === "block" && field === "type") typeStart = index;
    } else {
      const valueField = field;
      field = null;
      if (char === '"') {
        inString = true;
        stringStart = index;
        stringField = valueField;
      } else if (char === "{" || char === "[") {
        const role: Role = char === "{" && frames.length === 0 ? "root"
          : char === "{" && parent === "root" && valueField === "message" ? "message"
            : char === "[" && parent === "message" && valueField === "content" ? "content"
              : char === "{" && parent === "content" ? "block" : "other";
        frames.push({ closing: char === "{" ? "}" : "]", role });
        if (role === "block") {
          hasBlock = true;
          blockType = null; blockId = null; typeStart = -1; idStart = -1;
        }
      } else if ((char === "}" || char === "]") && frames.pop()?.closing !== char) break;
    }
    lastTokenWasString = false;
  }
  if (!hasBlock) return false; // Preserve unrelated root damage and actual absence.
  if (rootType) {
    try {
      const entry = record(JSON.parse(line.slice(0, rootType.end) + rootType.closing));
      if (entry?.type === "user" || entry?.type === "system") return false;
    } catch { /* No non-issuer proof. */ }
  }

  let partial: Prefix | null = null;
  if (inString && frames.at(-1)?.role === "block" && (stringField === "id" || stringField === "type")) {
    const tail = line.slice(stringStart + 1);
    let value: string | null = null;
    try { value = JSON.parse('"' + tail + '"') as string; }
    catch {
      const escape = /\\(?:u[0-9a-fA-F]{0,3})?$/u.exec(tail)?.[0];
      if (escape) {
        try { value = JSON.parse('"' + tail.slice(0, -escape.length) + '"') as string; } catch { /* Unknown metadata. */ }
      }
    }
    if (value !== null) partial = { ...snapshot(line.length), partial: stringField, value, start: stringStart };
  }
  const proofs = [partial, blockId, blockType].filter((value): value is Prefix => value !== null)
    .sort((left, right) => right.end - left.end);
  for (const proof of proofs) {
    try {
      const prefix = proof.partial ? line.slice(0, proof.start) + JSON.stringify(proof.value) : line.slice(0, proof.end);
      const entry = record(JSON.parse(prefix + proof.closing));
      if (entry?.type === "user" || entry?.type === "system") return false;
      const content = record(entry?.message)?.content;
      // A later non-issuer cannot erase an earlier unidentified tool-use block.
      if (Array.isArray(content) && content.some(value => record(value)?.type === "tool_use" && !text(record(value)?.id))) return true;
      const block = Array.isArray(content) ? record(content.at(-1)) : null;
      if (!block) continue;
      const type = typeStart > proof.end ? null : text(block.type);
      const id = idStart > proof.end ? null : text(block.id);
      if (type === "text" || type === "tool_result") return false;
      if (proof.partial === "id" && id !== null) return toolUseId.startsWith(id);
      if (id !== null && id !== toolUseId) return false;
      if (proof.partial === "type" && type !== null) return "tool_use".startsWith(type);
      return true;
    } catch { /* Failed metadata proof leaves a possible issuer unknown. */ }
  }
  return true;
}

export type IssuingMessageProbe =
  | { state: "absent" | "present" }
  | { state: "indeterminate"; reason: "CURRENT_CALL_INVALID_JSON" | "CURRENT_CALL_INVALID_SHAPE" | "CURRENT_CALL_INCOMPLETE" };

/** A current-call parsing failure is not evidence that its issuing message is absent. */
export function probeIssuingMessage(transcript: string, toolUseId: string): IssuingMessageProbe {
  for (const line of transcript.split("\n")) {
    if (!mentionsToolUseId(line, toolUseId)) {
      if (hasIncompleteIssuer(line, toolUseId)) return { state: "indeterminate", reason: "CURRENT_CALL_INCOMPLETE" };
      continue;
    }
    let entry: Record<string, unknown> | null;
    try { entry = record(JSON.parse(line)); }
    catch { return { state: "indeterminate", reason: "CURRENT_CALL_INVALID_JSON" }; }
    if (!entry) return { state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" };
    const message = record(entry.message);
    if (entry.type !== "assistant") {
      // A known non-issuer row may mention a call. An unrecognized issuer-shaped row cannot prove absence.
      if (entry.type !== "user" && entry.type !== "system" && Array.isArray(message?.content)
        && message.content.some((value) => record(value)?.id === toolUseId)) {
        return { state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" };
      }
      continue;
    }
    if (!message || !Array.isArray(message.content)) {
      return { state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" };
    }
    for (const value of message.content) {
      const block = record(value);
      if (!block) {
        if (typeof value === "string" && value.includes(toolUseId))
          return { state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" };
        continue;
      }
      if (block.id === toolUseId) {
        if (block.type === "tool_use") return { state: "present" };
        if (block.type !== "text" && block.type !== "tool_result")
          return { state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" };
      }
      if (block.type !== "tool_use") continue;
      if (!text(block.id)) return { state: "indeterminate", reason: "CURRENT_CALL_INVALID_SHAPE" };
    }
  }
  return { state: "absent" };
}

/** The model a SessionStart or PostModelSwitch hook reports for the main thread, if any. */
export function sessionModelUpdate(input: HookInput, now: Date = new Date()): { sessionId: string; record: SessionModelRecord } | null {
  const sessionId = text(input.session_id);
  if (!sessionId || text(input.agent_id)) return null;
  const source = input.hook_event_name === "SessionStart" ? "session-start"
    : input.hook_event_name === "PostModelSwitch" ? "model-switch"
      : null;
  const model = source === "session-start" ? text(input.model) : source === "model-switch" ? text(input.to_model) : null;
  return source && model ? { sessionId, record: { model, source, observedAt: now.toISOString() } } : null;
}

function sessionModelFile(directory: string, sessionId: string): string {
  return path.join(directory, `${digest(sessionId)}.json`);
}

export function writeSessionModel(directory: string, sessionId: string, value: SessionModelRecord): void {
  const file = sessionModelFile(directory, sessionId);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, JSON.stringify(value), "utf8");
    renameSync(temporary, file);
  } catch (cause) {
    const failure = new HookObservationFailure("SESSION_MODEL_WRITE_FAILED", cause);
    try { rmSync(temporary, { force: true }); } catch (cleanup) { retainHookFailureSecondary(failure, cleanup); }
    throw failure;
  }
}

export function readSessionModel(directory: string, sessionId: string): SessionModelRecord | null {
  try {
    const value = record(JSON.parse(readFileSync(sessionModelFile(directory, sessionId), "utf8")));
    const model = text(value?.model);
    const source = value?.source === "session-start" || value?.source === "model-switch" ? value.source : null;
    const observedAt = text(value?.observedAt);
    if (!model || !source || !observedAt || Number.isNaN(Date.parse(observedAt))) {
      throw new HookObservationFailure("SESSION_MODEL_INVALID");
    }
    return { model, source, observedAt };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (cause instanceof HookObservationFailure) throw cause;
    throw new HookObservationFailure(cause instanceof SyntaxError ? "SESSION_MODEL_INVALID" : "SESSION_MODEL_READ_FAILED", cause);
  }
}

export function observedEffort(hookEffort: string | null, messageEffort: string | null): string | null {
  const hook = isReasoningEffort(hookEffort) ? hookEffort : null;
  const message = isReasoningEffort(messageEffort) ? messageEffort : null;
  if (hook && message) return lowerReasoningEffort(hook, message);
  return hook ?? message;
}

/**
 * Model and effort of one Claude tool call for its admission row. The model comes from the issuing
 * message in the transcript, else from the session model SessionStart/PostModelSwitch recorded;
 * the effort comes from the hook. Nothing is inferred from the latest unrelated message (D-0033).
 */
export function observeClaudeExecution(input: HookInput, options: HostAttestationHookOptions = {}): CallerExecution {
  const host = options.host ?? claudeCodeExecutionAdapter.host;
  const sessionId = text(input.session_id);
  const toolUseId = text(input.tool_use_id);
  const transcriptPath = text(input.transcript_path);
  if (!sessionId || !toolUseId || !transcriptPath) return { unavailable: "CLAUDE_CALL_FIELDS_MISSING" };
  const agentId = text(input.agent_id);
  const readText = options.readText ?? readTextOrNull;
  const sleep = options.sleep ?? sleepSync;
  const maxWaitMs = options.maxWaitMs ?? 300;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const candidates = transcriptCandidates(transcriptPath, sessionId, agentId);
  const startedAtMs = options.now?.().getTime() ?? Date.now();
  const elapsedMs = () => Math.max(0, (options.now?.().getTime() ?? Date.now()) - startedAtMs);
  let observation: TranscriptObservation | null = null;
  let provenance = `${host}:transcript-tool-use`;
  // Headless sessions write the issuing message before the hook runs; interactive ones do not,
  // so the wait stays short and the session model below covers interactive sessions.
  for (let waited = 0; ; waited += pollIntervalMs) {
    for (const candidate of candidates) {
      const transcript = readText(candidate);
      observation = transcript ? findToolUseObservation(transcript, toolUseId, sessionId, agentId) : null;
      if (observation) break;
    }
    if (observation || waited >= maxWaitMs || elapsedMs() >= maxWaitMs) break;
    sleep(pollIntervalMs);
  }
  if (!observation) {
    // An issuing message that was found but rejected (another session, a sidechain, no model) stays unobserved.
    for (const candidate of candidates) {
      const probe = probeIssuingMessage(readText(candidate) ?? "", toolUseId);
      if (probe.state === "indeterminate") return { unavailable: probe.reason };
      if (probe.state === "present") return { unavailable: "CLAUDE_ISSUING_MESSAGE_REJECTED" };
    }
    // Subagents get no SessionStart or model-switch hooks, so only their own written message counts.
    const session = agentId ? null : options.readSessionModel?.(sessionId) ?? null;
    if (!session) return { unavailable: "CLAUDE_MODEL_UNOBSERVED" };
    observation = { model: session.model, effort: null };
    provenance = `${host}:${session.source}`;
  }
  // The transcript records the effort of the exact message; the hook reports the effort of the
  // current tool-use context. When both are present and differ, the lower one counts.
  const effort = observedEffort(text(record(input.effort)?.level), observation.effort);
  if (!effort) return { unavailable: "CLAUDE_EFFORT_UNOBSERVED" };
  return { model: observation.model, effort, turnId: text(input.turn_id), provenance };
}

/** Directory of the per-session model records, next to the workflow database. */
export function sessionModelDirectory(databasePath: string = resolveWorkflowDatabasePath()): string {
  return path.join(path.dirname(databasePath), "host-models");
}

/** SessionStart and PostModelSwitch record the main thread's model; other events produce nothing. */
function main(): void {
  let phase = "stdin";
  try {
    const raw = readFileSync(0, "utf8");
    phase = "input";
    const input = record(JSON.parse(raw));
    if (!input) throw new HookObservationFailure("INVALID_HOOK_INPUT");
    phase = "host-entry";
    // Only Claude Code reports a session model here; other hosts' fields are never read as one.
    if (resolveHookHost(process.argv.slice(2), "claude-code") !== "claude-code") return;
    phase = "input";
    const update = sessionModelUpdate(input);
    phase = "storage";
    if (update) writeSessionModel(sessionModelDirectory(), update.sessionId, update.record);
  } catch (cause) {
    // Failure stays distinct from normal absence, without logging native input or raw errors.
    const reason = hookFailureReason(cause) ?? (cause instanceof HookObservationFailure ? cause.code
      : cause instanceof SyntaxError && phase === "input" ? "INVALID_JSON" : "OBSERVATION_UNAVAILABLE");
    reportObservationFailure(phase, reason, cause);
  }
}

if (isHookEntry(import.meta.url, "host-attestation-hook")) main();
