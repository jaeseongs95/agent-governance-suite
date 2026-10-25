import { hookFailureContext, hookFailureReason, retainHookFailureSecondary, writeFailureDiagnostic } from "./hook-error-diagnostics.js";
import "./builtin-hook-host-adapters.js";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOST_ATTESTATION_FIELD,
  HOST_ATTESTATION_TOOLS,
  type HostExecutionAdapter,
  isReasoningEffort,
  issueHostAttestation,
  hostActorId,
  hostIdentityDigest,
  lowerReasoningEffort,
  resolveAdapterModelCapability,
  withoutHostAttestation,
} from "./host-attestation.js";
import { claudeCodeExecutionAdapter, codexExecutionAdapter } from "./host-execution-adapters.js";
import { observeCodexHook, type CodexObservationOptions } from "./codex-host-observation.js";
import { resolveWorkflowDatabasePath } from "./runtime-config.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";
import type { WorkflowStore } from "./workflow-store.js";
import { hookAttestationKind, isGovernanceHookTool, resolveHookHost } from "./host-input-adapter.js";
import { HOST_SKILL_OBSERVATION_FIELD } from "./skill-classification/host-discovery-adapter.js";

type HookInput = Record<string, unknown>;

/** Caller claims cannot become host-owned observations or signed tool arguments. */
function withoutCallerHostClaims(input: HookInput): HookInput {
  const clean = withoutHostAttestation(input);
  delete clean[HOST_SKILL_OBSERVATION_FIELD];
  return clean;
}

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

/**
 * Finds the newest assistant message this actor already wrote, with its timestamp.
 * Interactive Claude Code writes the message that issues a tool call only after the
 * call returns, so this is the latest model the harness recorded for the actor.
 */
export function findLatestAssistantObservation(
  transcript: string,
  sessionId: string,
  agentId: string | null,
  nowMs: number = Date.now(),
  adapter: HostExecutionAdapter = claudeCodeExecutionAdapter,
): { model: string; at: number } | null {
  const lines = transcript.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.includes("\"assistant\"")) continue;
    let entry: Record<string, unknown> | null;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry || entry.type !== "assistant") continue;
    // Unlike the exact lookup, nothing ties this line to the call, so it must name the session
    // and carry a timestamp that is not in the future.
    if (entry.sessionId !== sessionId) continue;
    if (agentId ? entry.agentId !== agentId : entry.isSidechain === true) continue;
    const at = Date.parse(text(entry.timestamp) ?? "");
    if (Number.isNaN(at) || at > nowMs) continue;
    const model = text(record(entry.message)?.model);
    // Retain the harness placeholder control, but never replace an actual unknown model with an older one.
    if (!model || (model === "<synthetic>" && !resolveAdapterModelCapability(adapter, model, `${adapter.host}:transcript-latest`))) continue;
    return { model, at };
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
 * An open issuer block cannot prove the current call absent before its ID finishes.
 * The closed copy is only a refusal hint; it never supplies an observation.
 */
function hasIncompleteIssuer(line: string, toolUseId: string): boolean {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      stringStart = index;
    } else if (char === "{") closers.push("}");
    else if (char === "[") closers.push("]");
    else if ((char === "}" || char === "]") && closers.pop() !== char) return false;
  }
  if (closers.length === 0) return false;
  let fragment = line.trimEnd();
  let prefix = "";
  // Longer than the entire source line, so no existing JSON string can equal it.
  const unfinished = "!".repeat(line.length + 1);
  if (inString) {
    const tail = line.slice(stringStart + 1);
    try { prefix = JSON.parse('"' + tail + '"') as string; }
    catch {
      // A writer can stop within a JSON escape, including a Unicode code unit.
      const incompleteEscape = /\\(?:u[0-9a-fA-F]{0,3})?$/u.exec(tail)?.[0];
      if (!incompleteEscape) return false;
      try { prefix = JSON.parse('"' + tail.slice(0, -incompleteEscape.length) + '"') as string; }
      catch { return false; }
    }
    fragment = line.slice(0, stringStart) + JSON.stringify(unfinished);
  } else if (fragment.endsWith(",")) fragment = fragment.slice(0, -1);
  else if (fragment.endsWith(":")) fragment += "null";
  if (!inString) {
    // A value may be unfinished inside input before the issuer's ID is written.
    const partialValue = /(?:^|[[:,])\s*(t|tr|tru|f|fa|fal|fals|n|nu|nul|-|-?(?:0|[1-9]\d*)\.|-?(?:0|[1-9]\d*)(?:\.\d+)?[eE][+-]?)$/u.exec(fragment)?.[1];
    if (partialValue) fragment = fragment.slice(0, -partialValue.length) + "null";
  }
  const closing = closers.reverse().join("");
  let entry: Record<string, unknown> | null;
  try { entry = record(JSON.parse(fragment + closing)); }
  catch {
    // A key may be unfinished, or complete with its colon not written yet.
    try { entry = record(JSON.parse(fragment + ":null" + closing)); }
    catch { return false; }
  }
  if (!entry || entry.type === "user" || entry.type === "system") return false;
  const content = record(entry.message)?.content;
  const block = Array.isArray(content) ? record(content.at(-1)) : null;
  if (!block || block.type === "text" || block.type === "tool_result") return false;
  if (block.id === unfinished) return toolUseId.startsWith(prefix);
  // A complete different ID proves this open block belongs to another call.
  if (text(block.id)) return false;
  return block.type === "tool_use" || (block.type === unfinished && "tool_use".startsWith(prefix));
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

function attestedToolInput(input: HookInput, host: string): { tool: string; toolInput: Record<string, unknown> } | null {
  if (input.hook_event_name !== "PreToolUse") return null;
  const canonicalName = text(input.tool_name) ?? "";
  if (!isGovernanceHookTool(host, canonicalName)) return null;
  const tool = canonicalName.split("__").at(-1) ?? "";
  const toolInput = record(input.tool_input);
  return HOST_ATTESTATION_TOOLS.has(tool) && toolInput ? { tool, toolInput } : null;
}

/**
 * When the hook cannot attest a call, a token the caller put in the arguments
 * must not reach the server, so it is removed instead of passed through.
 */
export function withoutCallerAttestation(input: HookInput, host: string = claudeCodeExecutionAdapter.host): Record<string, unknown> {
  const target = attestedToolInput(input, host);
  if (!target || (!Object.prototype.hasOwnProperty.call(target.toolInput, HOST_ATTESTATION_FIELD) && !Object.prototype.hasOwnProperty.call(target.toolInput, HOST_SKILL_OBSERVATION_FIELD))) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: withoutCallerHostClaims(target.toolInput),
    },
  };
}

export function observedEffort(hookEffort: string | null, messageEffort: string | null): string | null {
  const hook = isReasoningEffort(hookEffort) ? hookEffort : null;
  const message = isReasoningEffort(messageEffort) ? messageEffort : null;
  if (hook && message) return lowerReasoningEffort(hook, message);
  return hook ?? message;
}

export function handleHostAttestationHook(
  input: HookInput,
  store: WorkflowStore,
  options: HostAttestationHookOptions = {},
): Record<string, unknown> {
  const host = options.host ?? claudeCodeExecutionAdapter.host;
  const target = attestedToolInput(input, host);
  if (!target) return {};
  const {tool} = target;
  const adapter = options.adapter ?? claudeCodeExecutionAdapter;
  const toolInput = withoutCallerHostClaims(target.toolInput);
  const unattested = () => withoutCallerAttestation(input, host);
  const sessionId = text(input.session_id);
  const toolUseId = text(input.tool_use_id);
  const transcriptPath = text(input.transcript_path);
  if (!sessionId || !toolUseId || !transcriptPath) return unattested();
  const agentId = text(input.agent_id);

  const readText = options.readText ?? readTextOrNull;
  const sleep = options.sleep ?? sleepSync;
  const maxWaitMs = options.maxWaitMs ?? 300;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const candidates = transcriptCandidates(transcriptPath, sessionId, agentId);
  let observation: TranscriptObservation | null = null;
  let provenance = `${adapter.host}:transcript-tool-use`;
  // Headless sessions write the issuing message before the hook runs; interactive ones do not,
  // so the wait stays short and the fallbacks below cover interactive sessions.
  for (let waited = 0; ; waited += pollIntervalMs) {
    for (const candidate of candidates) {
      const transcript = readText(candidate);
      observation = transcript ? findToolUseObservation(transcript, toolUseId, sessionId, agentId) : null;
      if (observation) break;
    }
    if (observation || waited >= maxWaitMs) break;
    sleep(pollIntervalMs);
  }
  if (!observation) {
    const transcripts = candidates.map((candidate) => readText(candidate) ?? "");
    // An issuing message that was found but rejected (another session, a sidechain, no model) stays unattested.
    for (const transcript of transcripts) {
      const probe = probeIssuingMessage(transcript, toolUseId);
      if (probe.state === "indeterminate") {
        reportObservationFailure("fallback", probe.reason);
        return unattested();
      }
      if (probe.state === "present") return unattested();
    }
    const nowMs = (options.now?.() ?? new Date()).getTime();
    let latest: ReturnType<typeof findLatestAssistantObservation> = null;
    for (const transcript of transcripts) {
      latest = findLatestAssistantObservation(transcript, sessionId, agentId, nowMs, adapter);
      if (latest) break;
    }
    // Subagents get no SessionStart or model-switch hooks, so only their own written messages count.
    const session = agentId ? null : options.readSessionModel?.(sessionId) ?? null;
    const useSession = Boolean(session && (!latest || Date.parse(session.observedAt) >= latest.at));
    const model = useSession ? session!.model : latest?.model;
    provenance = useSession ? `${adapter.host}:${session!.source}` : `${adapter.host}:transcript-latest`;
    // Without the issuing message, effort comes only from the hook: a message effort may belong to another model.
    observation = model ? { model, effort: null } : null;
  }
  if (!observation) return unattested();

  // The transcript records the effort of the exact message; the hook reports the effort of the
  // current tool-use context. When both are present and differ, the lower one is attested.
  const effort = observedEffort(text(record(input.effort)?.level), observation.effort);
  if (!effort) return unattested();
  const token = issueHostAttestation(store, adapter, {
    tool,
    input: toolInput,
    model: observation.model,
    reasoningEffort: effort,
    actorId: hostActorId(adapter.host, sessionId, agentId),
    sessionId,
    agentId,
    turnId: text(input.turn_id),
    toolUseId,
    provenance,
    ...(options.now ? { now: options.now() } : {}),
  });
  if (!token) return unattested();
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...toolInput, [HOST_ATTESTATION_FIELD]: token },
    },
  };
}

export function handleCodexHostAttestationHook(
  input: HookInput,
  store: WorkflowStore,
  options: CodexObservationOptions & { now?: () => Date; host?: string } = {},
): Record<string, unknown> {
  const host = options.host ?? codexExecutionAdapter.host;
  const target = attestedToolInput(input, host);
  if (!target) return {};
  const adapter = options.adapter ?? codexExecutionAdapter;
  const observed = observeCodexHook(input, options);
  const clean = withoutCallerHostClaims(target.toolInput);
  const token = observed.observation ? issueHostAttestation(store, adapter, {
    ...observed.observation, tool: target.tool, input: clean,
    ...(options.now ? { now: options.now() } : {}),
  }) : null;
  return {
    ...(!token ? { systemMessage: `AGS execution observation unavailable: ${observed.reason ?? "invalid-workflow-binding"}. Requires the current host session/turn/model/effort and tool call; caller settings cannot supply them.` } : {}),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: token ? {...clean, [HOST_ATTESTATION_FIELD]: token} : clean,
    },
  };
}

export interface HookAttestationStrategyContext {
  host?: string;
  databasePath: string;
  openStore(): WorkflowStore;
}

export interface HookAttestationStrategy {
  observe(input: HookInput, context: HookAttestationStrategyContext): Record<string, unknown>;
  unavailable?(input: HookInput, failure: Readonly<{ phase: string; reason: string; host?: string }>): Record<string, unknown>;
}

const attestationStrategies = new Map<string, Readonly<HookAttestationStrategy>>();

/** Trusted installation composition, never selected or registered from hook payloads. */
export function registerHookAttestationStrategy(kind: string, strategy: HookAttestationStrategy): void {
  if (typeof kind !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(kind)
    || !strategy || typeof strategy.observe !== "function"
    || (strategy.unavailable !== undefined && typeof strategy.unavailable !== "function")) {
    throw new Error("INVALID_HOOK_ATTESTATION_STRATEGY");
  }
  if (attestationStrategies.has(kind)) throw new Error("DUPLICATE_HOOK_ATTESTATION_STRATEGY");
  attestationStrategies.set(kind, Object.freeze({ ...strategy }));
}

export function handleRegisteredHostAttestationHook(
  kind: string, input: HookInput, context: HookAttestationStrategyContext,
): Record<string, unknown> {
  return attestationStrategies.get(kind)?.observe(input, context) ?? withoutCallerAttestation(input, context.host);
}

registerHookAttestationStrategy("claude-hook", {
  observe(input, context) {
    const modelDirectory = path.join(path.dirname(context.databasePath), "host-models");
    const update = sessionModelUpdate(input);
    if (update) {
      writeSessionModel(modelDirectory, update.sessionId, update.record);
      return {};
    }
    return handleHostAttestationHook(input, context.openStore(), {
      host: context.host ?? claudeCodeExecutionAdapter.host,
      readSessionModel: (sessionId) => readSessionModel(modelDirectory, sessionId),
    });
  },
});

registerHookAttestationStrategy("codex-rollout", {
  observe: (input, context) => handleCodexHostAttestationHook(input, context.openStore(), {
    host: context.host ?? codexExecutionAdapter.host,
  }),
  unavailable(input, failure) {
    const host = failure.host ?? codexExecutionAdapter.host;
    const output = withoutCallerAttestation(input, host);
    if (attestedToolInput(input, host)) {
      output.systemMessage = `AGS execution observation unavailable: ${failure.phase}:${failure.reason}. No caller attestation is trusted.`;
    }
    return output;
  },
});

async function main(): Promise<void> {
  const resources: { store: SqliteWorkflowStore | null } = { store: null };
  let input: HookInput = {};
  let output: Record<string, unknown>;
  let strategy: Readonly<HookAttestationStrategy> | undefined;
  let host = claudeCodeExecutionAdapter.host;
  let phase = "stdin";
  try {
    const raw = readFileSync(0, "utf8");
    phase = "input";
    const parsed = record(JSON.parse(raw));
    if (!parsed) throw new HookObservationFailure("INVALID_HOOK_INPUT");
    input = parsed;
    phase = "host-entry";
    host = resolveHookHost(process.argv.slice(2), "claude-code");
    const attestationKind = hookAttestationKind(host);
    strategy = attestationKind ? attestationStrategies.get(attestationKind) : undefined;
    if (!strategy || !attestationKind) {
      // Official effort and actual call identity are unavailable: issue no token or discovery snapshot.
      output = withoutCallerAttestation(input, host);
      if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
      return;
    }
    phase = "storage";
    const databasePath = resolveWorkflowDatabasePath();
    output = handleRegisteredHostAttestationHook(attestationKind, input, {
      host,
      databasePath,
      openStore() {
        resources.store ??= new SqliteWorkflowStore(databasePath);
        phase = "observation";
        return resources.store;
      },
    });
  } catch (cause) {
    // Failure stays distinct from normal absence, without logging native input or raw errors.
    const reason = hookFailureReason(cause) ?? (cause instanceof HookObservationFailure ? cause.code
      : cause instanceof SyntaxError && phase === "input" ? "INVALID_JSON" : "OBSERVATION_UNAVAILABLE");
    reportObservationFailure(phase, reason, cause);
    // Without a token the server fails closed with BINDING_REQUIRED; never block the tool call here.
    output = withoutCallerAttestation(input, host);
    try { output = strategy?.unavailable?.(input, { phase, reason, host }) ?? output; }
    catch { /* An unavailable adapter cannot prevent caller-claim stripping. */ }
  } finally {
    try { resources.store?.close(); } catch (cause) { reportObservationFailure("store-close", "STORE_CLOSE_FAILED", cause); }
  }
  if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
