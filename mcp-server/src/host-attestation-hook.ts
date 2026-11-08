import { isHookEntry } from "./hook-entry.js";
import { hookFailureContext, hookFailureReason, retainHookFailureSecondary, writeDiagnostic, writeFailureDiagnostic } from "./hook-error-diagnostics.js";
import { failureReason } from "./failure-diagnostics.js";
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
  | "SESSION_MODEL_READ_FAILED" | "SESSION_MODEL_INVALID" | "SESSION_MODEL_WRITE_FAILED" | "INVALID_HOOK_INPUT" | "CURRENT_CALL_INVALID_SHAPE";

/** The failed step is the code; the actual I/O or parse error is kept as the cause. */
class HookObservationFailure extends Error {
  readonly code: HookObservationFailureCode;
  constructor(code: HookObservationFailureCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.code = code;
  }
}

/** The failed observation step of a hook failure, so a caller can report it instead of a generic code. */
export function observationFailureCode(error: unknown): HookObservationFailureCode | null {
  try { return error instanceof HookObservationFailure ? error.code : null; }
  catch { return null; } // A proxy's prototype trap is not an observation failure.
}

function reportObservationFailure(phase: string, reason: string, cause?: unknown): void {
  try { writeDiagnostic("host-attestation-hook", "observation-failure", { phase, reason,
    ...(cause === undefined ? {} : { context: hookFailureContext(cause) }) }, line => writeFailureDiagnostic(line + "\n")); }
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
  /** Wait when no session model can stand in for the issuing message (headless sessions, subagents). */
  maxWaitWithoutSessionModelMs?: number;
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

/*
 * Only the newest part of the transcript is read: at most the last 2 MiB and 4000 lines, the window the lineage read
 * uses (builtin-hook-host-adapters.ts, CLAUDE_LINEAGE_MAX_BYTES and CLAUDE_LINEAGE_MAX_LINES). The issuing message of a
 * call is a recent row, and not finding it in the window costs nothing that reading the whole history would protect:
 * the main thread has no model or effort floor, so its session model may stand in for any call (3.1.1), and a subagent
 * never gets that stand-in (observeClaudeExecution) and stays CLAUDE_MODEL_UNOBSERVED. A row cut by the window start is
 * dropped, never parsed as a fragment. The last segment may still be written by the host, so it is read as a line.
 * Message bodies are never returned: only the issuer's model and effort.
 */
const CLAUDE_TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const CLAUDE_TRANSCRIPT_TAIL_LINES = 4000;

/** The lines of the transcript window, newest first; null when the file does not exist (normal absence). */
function readTranscriptTail(file: string): string[] | null {
  let descriptor: number;
  try { descriptor = openSync(file, "r"); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new HookObservationFailure("TRANSCRIPT_READ_FAILED", cause);
  }
  let failure: HookObservationFailure | null = null;
  let content = "";
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      // Retain the native directory-read cause with a bounded read; reject other non-files.
      if (stats.isDirectory()) readSync(descriptor, Buffer.alloc(1), 0, 1, 0);
      throw new HookObservationFailure("TRANSCRIPT_READ_FAILED");
    }
    const length = Math.min(stats.size, CLAUDE_TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    // A shorter read means the file shrank under the read; it is not the window that was asked for.
    if (readSync(descriptor, buffer, 0, length, stats.size - length) !== length) throw new HookObservationFailure("TRANSCRIPT_READ_FAILED");
    content = buffer.toString("utf8");
    if (stats.size > length) {
      const newline = content.indexOf("\n");
      content = newline < 0 ? "" : content.slice(newline + 1);
    }
  } catch (cause) {
    failure = cause instanceof HookObservationFailure ? cause : new HookObservationFailure("TRANSCRIPT_READ_FAILED", cause);
  }
  try { closeSync(descriptor); }
  catch (cleanup) {
    if (failure) retainHookFailureSecondary(failure, cleanup);
    else failure = new HookObservationFailure("TRANSCRIPT_READ_FAILED", cleanup);
  }
  if (failure) throw failure;
  // The complete lines are bounded; the last segment (empty after a final newline) is always kept.
  return content.split("\n").slice(-(CLAUDE_TRANSCRIPT_TAIL_LINES + 1)).reverse();
}

/** Where the issuing message of one call is looked up: the host's transcript files, or injected text (tests). */
interface TranscriptReader {
  find(file: string): TranscriptObservation | null;
  probe(file: string): IssuingMessageProbe;
}

function fileTranscriptReader(toolUseId: string, sessionId: string, agentId: string | null): TranscriptReader {
  return {
    find: (file) => {
      const newestFirst = readTranscriptTail(file);
      return newestFirst ? findToolUseObservationInLines(newestFirst, toolUseId, sessionId, agentId) : null;
    },
    probe: (file) => probeIssuingMessageInLines((readTranscriptTail(file) ?? []).reverse(), toolUseId),
  };
}

function textTranscriptReader(readText: (file: string) => string | null, toolUseId: string, sessionId: string, agentId: string | null): TranscriptReader {
  return {
    find: (file) => {
      const transcript = readText(file);
      return transcript ? findToolUseObservation(transcript, toolUseId, sessionId, agentId) : null;
    },
    probe: (file) => probeIssuingMessage(readText(file) ?? "", toolUseId),
  };
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
  return findToolUseObservationInLines(transcript.split("\n").reverse(), toolUseId, sessionId, agentId);
}

/** The same search over lines given newest first; it stops at the newest issuing message. */
export function findToolUseObservationInLines(
  newestFirst: Iterable<string>,
  toolUseId: string,
  sessionId: string,
  agentId: string | null,
): TranscriptObservation | null {
  for (const line of newestFirst) {
    const issuer = issuerInLine(line, toolUseId, sessionId, agentId);
    if (issuer !== undefined) return issuer;
  }
  return null;
}

/** undefined: the line did not issue toolUseId; null: it did, but this session's thread cannot use it. */
function issuerInLine(line: string, toolUseId: string, sessionId: string, agentId: string | null): TranscriptObservation | null | undefined {
  if (!line || !mentionsToolUseId(line, toolUseId)) return undefined;
  let entry: Record<string, unknown> | null;
  try {
    entry = record(JSON.parse(line));
  } catch {
    return undefined;
  }
  if (!entry || entry.type !== "assistant") return undefined;
  const message = record(entry.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const issued = content.some((block) => record(block)?.type === "tool_use" && record(block)?.id === toolUseId);
  if (!issued) return undefined;
  if (entry.sessionId !== undefined && entry.sessionId !== sessionId) return null;
  if (agentId ? entry.agentId !== agentId : entry.isSidechain === true) return null;
  const model = text(message?.model);
  if (!model) return null;
  return { model, effort: text(entry.effort) };
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
  return probeIssuingMessageInLines(transcript.split("\n"), toolUseId);
}

/** The same probe over lines given oldest first; the first non-absent line decides. */
export function probeIssuingMessageInLines(oldestFirst: Iterable<string>, toolUseId: string): IssuingMessageProbe {
  for (const line of oldestFirst) {
    const verdict = probeLine(line, toolUseId);
    if (verdict) return verdict;
  }
  return { state: "absent" };
}

/** The probe verdict of one line; null when the line is no evidence either way. */
function probeLine(line: string, toolUseId: string): IssuingMessageProbe | null {
  if (!mentionsToolUseId(line, toolUseId)) {
    return hasIncompleteIssuer(line, toolUseId) ? { state: "indeterminate", reason: "CURRENT_CALL_INCOMPLETE" } : null;
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
    return null;
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
  return null;
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
  const reader = options.readText ? textTranscriptReader(options.readText, toolUseId, sessionId, agentId)
    : fileTranscriptReader(toolUseId, sessionId, agentId);
  const sleep = options.sleep ?? sleepSync;
  const maxWaitMs = options.maxWaitMs ?? 300;
  // An explicit maxWaitMs bounds every wait; by default a call with no session model to fall back on waits longer.
  const maxWaitWithoutSessionModelMs = options.maxWaitWithoutSessionModelMs ?? options.maxWaitMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const candidates = transcriptCandidates(transcriptPath, sessionId, agentId);
  const startedAtMs = options.now?.().getTime() ?? Date.now();
  const elapsedMs = () => Math.max(0, (options.now?.().getTime() ?? Date.now()) - startedAtMs);
  let waited = 0;
  const search = (untilMs: number): TranscriptObservation | null => {
    for (; ; waited += pollIntervalMs) {
      for (const candidate of candidates) {
        const found = reader.find(candidate);
        if (found) return found;
      }
      if (waited >= untilMs || elapsedMs() >= untilMs) return null;
      sleep(pollIntervalMs);
    }
  };
  let provenance = `${host}:transcript-tool-use`;
  // An issuing message that was found but rejected (another session, a sidechain, no model) stays unobserved.
  const probeIssuer = (): TranscriptObservation | { unavailable: string } | null => {
    for (const candidate of candidates) {
      const probe = reader.probe(candidate);
      if (probe.state === "indeterminate") return { unavailable: probe.reason };
      if (probe.state === "present") {
        // The probe reopens the file, so it can see an issuer written after the search above read it.
        return reader.find(candidate) ?? { unavailable: "CLAUDE_ISSUING_MESSAGE_REJECTED" };
      }
    }
    return null;
  };
  // The harness writes the issuing message after the hook starts when it is still streaming: an interactive
  // turn, or a headless message that issues several tools at once (about 450 ms on the Windows test server).
  let observation = search(maxWaitMs);
  if (!observation) {
    const probed = probeIssuer();
    if (probed && "unavailable" in probed) return probed;
    observation = probed;
  }
  // Only an issuer absent from the transcript window reaches the session model. Subagents get no SessionStart or
  // model-switch hooks, so only their own written message counts.
  const session = observation || agentId ? null : options.readSessionModel?.(sessionId) ?? null;
  // ceiling: polling under the hook's 10 s limit; a batch still streaming after the wait stays unobserved.
  if (!observation && !session && waited < maxWaitWithoutSessionModelMs && elapsedMs() < maxWaitWithoutSessionModelMs) {
    observation = search(maxWaitWithoutSessionModelMs);
    if (!observation) {
      const probed = probeIssuer();
      if (probed && "unavailable" in probed) return probed;
      observation = probed;
    }
  }
  if (!observation) {
    if (!session) return { unavailable: "CLAUDE_MODEL_UNOBSERVED" };
    observation = { model: session.model, effort: null };
    provenance = `${host}:${session.source}`;
  }
  // The transcript records the effort of the exact message; the hook reports the effort of the
  // current tool-use context. When both are present and differ, the lower one counts.
  // A model without a reported effort is still observed, as for Codex; floors that need an effort refuse later.
  const effort = observedEffort(text(record(input.effort)?.level), observation.effort);
  return { model: observation.model, effort, turnId: text(input.turn_id), provenance };
}

/** Directory of the per-session model records, next to the workflow database. */
export function sessionModelDirectory(databasePath: string = resolveWorkflowDatabasePath()): string {
  return path.join(path.dirname(databasePath), "host-models");
}

/**
 * SessionStart and PostModelSwitch record the main thread's model; other events produce nothing and nothing is printed.
 * `raw` is the read input or its reader, so a read failure keeps the stdin phase. Every failure is reported, never thrown:
 * the Claude launcher calls this in its own process and must not block the host.
 */
export function runHostAttestationHook(raw: string | (() => string), environment: NodeJS.ProcessEnv = process.env,
  host: string | (() => string) = "claude-code"): void {
  let phase = "stdin";
  try {
    const text = typeof raw === "function" ? raw() : raw;
    phase = "input";
    const input = record(JSON.parse(text));
    if (!input) throw new HookObservationFailure("INVALID_HOOK_INPUT");
    phase = "host-entry";
    // Only Claude Code reports a session model here; other hosts' fields are never read as one.
    // The CLI resolves --host here, so an invalid selection is a host-entry diagnostic with exit 0, not a crash.
    if ((typeof host === "function" ? host() : host) !== "claude-code") return;
    phase = "input";
    const update = sessionModelUpdate(input);
    phase = "storage";
    if (update) writeSessionModel(sessionModelDirectory(resolveWorkflowDatabasePath(environment)), update.sessionId, update.record);
  } catch (cause) {
    // Failure stays distinct from normal absence, without logging native input or raw errors.
    // An OS cause (stdin EIO/EPIPE, for example) keeps its own class instead of one generic code.
    const reason = hookFailureReason(cause) ?? observationFailureCode(cause)
      ?? (cause instanceof SyntaxError && phase === "input" ? "INVALID_JSON" : failureReason(cause).reason ?? "OBSERVATION_UNAVAILABLE");
    reportObservationFailure(phase, reason, cause);
  }
}

if (isHookEntry(import.meta.url, "host-attestation-hook")) {
  runHostAttestationHook(() => readFileSync(0, "utf8"), process.env, () => resolveHookHost(process.argv.slice(2), "claude-code"));
}
