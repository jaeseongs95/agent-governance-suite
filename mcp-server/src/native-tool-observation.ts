/** Read-only native tool transcript and identity helpers. No tokens, database or executable entrypoint. */
import { createHash } from "node:crypto";
import path from "node:path";

interface TranscriptObservation { model: string; effort: string | null; }
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);

/** Actor IDs are persisted in plans and receipts, so raw session and agent IDs are stored only as digests. */
export function claudeCodeActorId(sessionId: string, agentId: string | null): string {
  return agentId
    ? `claude-code:session-${digest(sessionId)}:agent-${digest(agentId)}`
    : `claude-code:session-${digest(sessionId)}`;
}

export function transcriptCandidates(transcriptPath: string, sessionId: string, agentId: string | null): string[] {
  const candidates = [transcriptPath];
  if (agentId) {
    candidates.push(path.join(path.dirname(transcriptPath), sessionId, "subagents", `agent-${agentId}.jsonl`));
  }
  return [...new Set(candidates)];
}

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
