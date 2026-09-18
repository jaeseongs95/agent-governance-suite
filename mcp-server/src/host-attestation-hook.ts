import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOST_ATTESTATION_FIELD,
  HOST_ATTESTATION_TOOLS,
  isReasoningEffort,
  issueHostAttestation,
  lowerReasoningEffort,
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

export interface HostAttestationHookOptions {
  readText?: (file: string) => string | null;
  sleep?: (milliseconds: number) => void;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
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

/** Actor IDs are persisted in plans and receipts, so raw session and agent IDs are stored only as digests. */
export function claudeCodeActorId(sessionId: string, agentId: string | null): string {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
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
  const maxWaitMs = options.maxWaitMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const candidates = transcriptCandidates(transcriptPath, sessionId, agentId);
  let observation: TranscriptObservation | null = null;
  // The transcript is written asynchronously and may lag the tool call.
  for (let waited = 0; ; waited += pollIntervalMs) {
    for (const candidate of candidates) {
      const transcript = readText(candidate);
      observation = transcript ? findToolUseObservation(transcript, toolUseId, sessionId, agentId) : null;
      if (observation) break;
    }
    if (observation || waited >= maxWaitMs) break;
    sleep(pollIntervalMs);
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
    store = new SqliteWorkflowStore(resolveWorkflowDatabasePath());
    output = handleHostAttestationHook(input, store);
  } catch {
    // Without a token the server fails closed with BINDING_REQUIRED; never block the tool call here.
    output = withoutCallerAttestation(input);
  } finally {
    try { store?.close(); } catch { /* Fail open. */ }
  }
  if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
