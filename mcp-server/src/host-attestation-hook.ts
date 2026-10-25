import { hookFailureContext, hookFailureReason, retainHookFailureSecondary } from "./hook-error-diagnostics.js";
import "./builtin-hook-host-adapters.js";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
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
import { hookAttestationKind, resolveHookHost } from "./host-input-adapter.js";

type HookInput = Record<string, unknown>;

const HOST_SKILL_OBSERVATION_FIELD = "_hostSkillObservation";

/** Caller claims cannot become host-owned observations or signed tool arguments. */
function withoutCallerHostClaims(input: HookInput): HookInput {
  const clean = withoutHostAttestation(input);
  delete clean[HOST_SKILL_OBSERVATION_FIELD];
  return clean;
}

type HookObservationFailureCode = "TRANSCRIPT_READ_FAILED" | "CURRENT_CALL_INVALID_JSON"
  | "SESSION_MODEL_READ_FAILED" | "SESSION_MODEL_INVALID" | "SESSION_MODEL_WRITE_FAILED"
  | "INVALID_HOOK_INPUT" | "CURRENT_CALL_INVALID_SHAPE";

/** The failed step is the code; the actual I/O or parse error is kept as the cause. */
class HookObservationFailure extends Error {
  readonly code: HookObservationFailureCode;
  constructor(code: HookObservationFailureCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.code = code;
  }
}

function reportObservationFailure(phase: string, reason: string, cause?: unknown): void {
  try { writeSync(2, JSON.stringify({ component: "host-attestation-hook", phase, reason,
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

function readTextOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new HookObservationFailure("TRANSCRIPT_READ_FAILED", cause);
  }
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
    // Synthetic or unknown-model messages are not a model the actor ran on.
    if (!model || !resolveAdapterModelCapability(adapter, model, `${adapter.host}:transcript-latest`)) continue;
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

export type IssuingMessageProbe =
  | { state: "absent" | "present" }
  | { state: "indeterminate"; reason: "CURRENT_CALL_INVALID_JSON" | "CURRENT_CALL_INVALID_SHAPE" };

/** A current-call parsing failure is not evidence that its issuing message is absent. */
export function probeIssuingMessage(transcript: string, toolUseId: string): IssuingMessageProbe {
  for (const line of transcript.split("\n")) {
    if (!mentionsToolUseId(line, toolUseId)) continue;
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

function attestedToolInput(input: HookInput): { tool: string; toolInput: Record<string, unknown> } | null {
  if (input.hook_event_name !== "PreToolUse") return null;
  const canonicalName = text(input.tool_name) ?? "";
  if (!/^mcp__(?:plugin_agent-governance-suite_agent-governance-suite|agent[-_]governance[-_]suite)__/u.test(canonicalName)) return null;
  const tool = canonicalName.split("__").at(-1) ?? "";
  const toolInput = record(input.tool_input);
  return HOST_ATTESTATION_TOOLS.has(tool) && toolInput ? { tool, toolInput } : null;
}

/**
 * When the hook cannot attest a call, a token the caller put in the arguments
 * must not reach the server, so it is removed instead of passed through.
 */
export function withoutCallerAttestation(input: HookInput): Record<string, unknown> {
  const target = attestedToolInput(input);
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
  const target = attestedToolInput(input);
  if (!target) return {};
  const {tool} = target;
  const adapter = options.adapter ?? claudeCodeExecutionAdapter;
  const toolInput = withoutCallerHostClaims(target.toolInput);
  const unattested = () => withoutCallerAttestation(input);
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
  options: CodexObservationOptions & { now?: () => Date } = {},
): Record<string, unknown> {
  const target = attestedToolInput(input);
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
      permissionDecision: "allow",
      updatedInput: token ? {...clean, [HOST_ATTESTATION_FIELD]: token} : clean,
    },
  };
}

async function main(): Promise<void> {
  let store: SqliteWorkflowStore | null = null;
  let input: HookInput = {};
  let output: Record<string, unknown>;
  let codex = false;
  let phase = "input";
  try {
    const parsed = record(JSON.parse(readFileSync(0, "utf8")));
    if (!parsed) throw new HookObservationFailure("INVALID_HOOK_INPUT");
    input = parsed;
    phase = "host-entry";
    const host = resolveHookHost(process.argv.slice(2), "claude-code");
    const attestationKind = hookAttestationKind(host);
    if (!attestationKind) {
      // Official effort and actual call identity are unavailable: issue no token or discovery snapshot.
      output = withoutCallerAttestation(input);
      if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
      return;
    }
    codex = attestationKind === "codex-rollout";
    phase = "storage";
    const databasePath = resolveWorkflowDatabasePath();
    const modelDirectory = path.join(path.dirname(databasePath), "host-models");
    const update = codex ? null : sessionModelUpdate(input);
    if (update) {
      writeSessionModel(modelDirectory, update.sessionId, update.record);
      return;
    }
    store = new SqliteWorkflowStore(databasePath);
    phase = "observation";
    output = codex ? handleCodexHostAttestationHook(input, store)
      : handleHostAttestationHook(input, store, { readSessionModel: (sessionId) => readSessionModel(modelDirectory, sessionId) });
  } catch (cause) {
    // Failure stays distinct from normal absence, without logging native input or raw errors.
    const reason = hookFailureReason(cause) ?? (cause instanceof HookObservationFailure ? cause.code
      : cause instanceof SyntaxError && phase === "input" ? "INVALID_JSON" : "OBSERVATION_UNAVAILABLE");
    reportObservationFailure(phase, reason, cause);
    // Without a token the server fails closed with BINDING_REQUIRED; never block the tool call here.
    output = withoutCallerAttestation(input);
    if (codex && attestedToolInput(input)) {
      output.systemMessage = `AGS execution observation unavailable: ${phase}:${reason}. No caller attestation is trusted.`;
      if (record(output.hookSpecificOutput)) (output.hookSpecificOutput as Record<string, unknown>).permissionDecision = "allow";
    }
  } finally {
    try { store?.close(); } catch { reportObservationFailure("store-close", "STORE_CLOSE_FAILED"); }
  }
  if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
