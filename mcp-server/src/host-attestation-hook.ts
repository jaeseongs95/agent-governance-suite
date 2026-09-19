import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOST_ATTESTATION_FIELD,
  HOST_ATTESTATION_TOOLS,
  isReasoningEffort,
  issueHostAttestation,
  lowerReasoningEffort,
  modelClassForClaudeModel,
  withoutHostAttestation,
} from "./host-attestation.js";
import { resolveWorkflowDatabasePath } from "./runtime-config.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";
import type { WorkflowStore } from "./workflow-store.js";

type HookInput = Record<string, unknown>;

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
  } catch {
    return null;
  }
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);

/** Actor IDs are persisted in plans and receipts, so raw session and agent IDs are stored only as digests. */
export function claudeCodeActorId(sessionId: string, agentId: string | null): string {
  return agentId
    ? `claude-code:session-${digest(sessionId)}:agent-${digest(agentId)}`
    : `claude-code:session-${digest(sessionId)}`;
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
    if (!line?.includes(toolUseId)) continue;
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
    if (!model || !modelClassForClaudeModel(model)) continue;
    return { model, at };
  }
  return null;
}

/** True when an assistant message that issued toolUseId is in the transcript, whoever wrote it. */
export function hasIssuingMessage(transcript: string, toolUseId: string): boolean {
  return transcript.split("\n").some((line) => {
    if (!line.includes(toolUseId)) return false;
    try {
      const entry = record(JSON.parse(line));
      const content = record(entry?.message)?.content;
      return entry?.type === "assistant" && Array.isArray(content)
        && content.some((block) => record(block)?.type === "tool_use" && record(block)?.id === toolUseId);
    } catch {
      return false;
    }
  });
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
  mkdirSync(directory, { recursive: true });
  const file = sessionModelFile(directory, sessionId);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), "utf8");
  renameSync(temporary, file);
}

export function readSessionModel(directory: string, sessionId: string): SessionModelRecord | null {
  try {
    const value = record(JSON.parse(readFileSync(sessionModelFile(directory, sessionId), "utf8")));
    const model = text(value?.model);
    const source = value?.source === "session-start" || value?.source === "model-switch" ? value.source : null;
    const observedAt = text(value?.observedAt);
    return model && source && observedAt && !Number.isNaN(Date.parse(observedAt)) ? { model, source, observedAt } : null;
  } catch {
    return null;
  }
}

function attestedToolInput(input: HookInput): { tool: string; toolInput: Record<string, unknown> } | null {
  if (input.hook_event_name !== "PreToolUse") return null;
  const canonicalName = text(input.tool_name) ?? "";
  if (!canonicalName.startsWith("mcp__")) return null;
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
  if (!target || !Object.prototype.hasOwnProperty.call(target.toolInput, HOST_ATTESTATION_FIELD)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: withoutHostAttestation(target.toolInput),
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
  const { tool, toolInput } = target;
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
    if (transcripts.some((transcript) => hasIssuingMessage(transcript, toolUseId))) return unattested();
    const nowMs = (options.now?.() ?? new Date()).getTime();
    let latest: ReturnType<typeof findLatestAssistantObservation> = null;
    for (const transcript of transcripts) {
      latest = findLatestAssistantObservation(transcript, sessionId, agentId, nowMs);
      if (latest) break;
    }
    // Subagents get no SessionStart or model-switch hooks, so only their own written messages count.
    const session = agentId ? null : options.readSessionModel?.(sessionId) ?? null;
    const model = session && (!latest || Date.parse(session.observedAt) >= latest.at) ? session.model : latest?.model;
    // Without the issuing message, effort comes only from the hook: a message effort may belong to another model.
    observation = model ? { model, effort: null } : null;
  }
  if (!observation) return unattested();

  // The transcript records the effort of the exact message; the hook reports the effort of the
  // current tool-use context. When both are present and differ, the lower one is attested.
  const effort = observedEffort(text(record(input.effort)?.level), observation.effort);
  if (!effort) return unattested();
  const token = issueHostAttestation(store, {
    tool,
    input: toolInput,
    model: observation.model,
    reasoningEffort: effort,
    actorId: claudeCodeActorId(sessionId, agentId),
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

async function main(): Promise<void> {
  let store: SqliteWorkflowStore | null = null;
  let input: HookInput = {};
  let output: Record<string, unknown>;
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
    const databasePath = resolveWorkflowDatabasePath();
    const modelDirectory = path.join(path.dirname(databasePath), "host-models");
    const update = sessionModelUpdate(input);
    if (update) {
      writeSessionModel(modelDirectory, update.sessionId, update.record);
      return;
    }
    store = new SqliteWorkflowStore(databasePath);
    output = handleHostAttestationHook(input, store, { readSessionModel: (sessionId) => readSessionModel(modelDirectory, sessionId) });
  } catch {
    // Without a token the server fails closed with BINDING_REQUIRED; never block the tool call here.
    output = withoutCallerAttestation(input);
  } finally {
    try { store?.close(); } catch { /* Fail open. */ }
  }
  if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
