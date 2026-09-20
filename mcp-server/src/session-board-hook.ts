import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SUMMARY_MAX_LENGTH,
  gateDecision,
  isReadOnlyCommand,
  normalizeSummary,
  openBoard,
  pruneSessions,
  recordPrompt,
  setSummary,
  touchSession,
} from "../../skills/session-board/scripts/board-store.mjs";
import { resolveSessionBoardDatabasePath } from "./runtime-config.js";
import { sessionMessageRequest } from "./session-message-client.js";
import { adaptHostInput } from "./host-input-adapter.js";
import { isObservedSubagent } from "./input-observation.js";

type HookInput = Record<string, unknown>;
type Board = ReturnType<typeof openBoard>;

const BOARD_TOOLS = new Set(["update_session_status", "list_session_status"]);
// Claude Code tool names plus candidate Codex shell/patch tool names; a name a host never sends is never gated.
const GATED_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "PowerShell", "Agent", "Task", "shell", "local_shell", "exec_command", "apply_patch"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "shell", "local_shell", "exec_command"]);

export const GATE_REASON = "세션 현황판: 이 요청에서 무엇을 하는지 한 줄로 먼저 적어야 합니다. update_session_status를 {\"schemaVersion\":\"1.0.0\",\"summary\":\"<무엇을 · 어디서(브랜치) · 다음 외부 작업>\"}로 호출한 뒤 다시 시도하세요. 같은 작업이 이어지면 같은 문장도 됩니다. 도구를 쓸 수 없으면 그대로 다시 시도하세요. 다음 시도는 허용됩니다.";

function preToolUse(permissionDecision: "allow" | "deny", extra: Record<string, unknown>): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, ...extra } };
}

/** Maps one host hook event onto the board; identity always comes from the hook input, never from the model. */
export function handleSessionBoardHook(input: HookInput, board: Board, host: string, now: string = new Date().toISOString(), verifiedInternalWake = false): Record<string, unknown> {
  const adapted = adaptHostInput(input, host);
  const observation = adapted.observation;
  const sessionId = observation.sessionId;
  if (!sessionId) return {};
  const session = { host, sessionId, cwd: observation.workspaceId || process.cwd(), now };
  const subagent = isObservedSubagent(observation);

  if (adapted.lifecycle === "start") {
    pruneSessions(board, now);
    touchSession(board, session);
    return {};
  }
  if (observation.kind === "user-input") {
    if (!subagent) {
      pruneSessions(board, now);
      if (verifiedInternalWake) touchSession(board, session);
      else recordPrompt(board, session);
    }
    return {};
  }
  if (observation.kind !== "tool-boundary" || observation.boundaryPhase !== "before") return {};

  const toolName = observation.toolName ?? "";
  const toolInput = observation.toolInput ?? {};
  const localTool = toolName.split("__").at(-1) ?? "";
  if (toolName.startsWith("mcp__") && BOARD_TOOLS.has(localTool)) {
    if (localTool === "update_session_status") {
      if (subagent) return preToolUse("deny", { permissionDecisionReason: "세션 현황판 줄은 메인 세션만 갱신합니다. 서브에이전트는 update_session_status를 호출하지 않습니다." });
      if (!normalizeSummary(toolInput.summary)) {
        return preToolUse("deny", { permissionDecisionReason: `summary는 ${SUMMARY_MAX_LENGTH}자 이하의 한 줄이어야 합니다.` });
      }
      setSummary(board, session, toolInput.summary);
    }
    return preToolUse("allow", { updatedInput: { ...toolInput, _sessionBinding: { host, sessionId } } });
  }

  if (subagent || !GATED_TOOLS.has(toolName)) return {};
  if (SHELL_TOOLS.has(toolName) && isReadOnlyCommand(toolInput.command)) return {};
  return gateDecision(board, session) === "deny" ? preToolUse("deny", { permissionDecisionReason: GATE_REASON }) : {};
}

/** Runs one hook event and returns the JSON to print; every failure lets the tool call through. */
export async function runSessionBoardHook(host: string, raw: string): Promise<string> {
  let board: Board | null = null;
  try {
    const input = JSON.parse(raw) as HookInput;
    const observation = adaptHostInput(input, host).observation;
    let verifiedInternalWake = false;
    if (observation.kind === "user-input") {
      const nonces = observation.wakeCandidates ?? [];
      const sessionId = observation.sessionId;
      let allRecognized = nonces.length > 0;
      if (sessionId) {
        for (const nonce of nonces) {
          try {
            const result = await sessionMessageRequest<{ consumed: boolean }>("consume-wake", { target: { host, sessionId }, nonce });
            allRecognized &&= result.consumed;
          } catch { allRecognized = false; }
        }
      } else allRecognized = false;
      verifiedInternalWake = observation.wakeOnly === true && allRecognized;
    }
    board = openBoard(resolveSessionBoardDatabasePath(), { busyTimeoutMs: 500 });
    const output = handleSessionBoardHook(input, board, host, new Date().toISOString(), verifiedInternalWake);
    return Object.keys(output).length > 0 ? JSON.stringify(output) : "";
  } catch {
    return "";
  } finally {
    try { board?.close(); } catch { /* Fail open. */ }
  }
}

// Direct execution is the Codex hook; the Claude Code launcher imports runSessionBoardHook instead.
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch { /* Fail open. */ }
  void runSessionBoardHook("codex", raw).then((output) => { if (output) process.stdout.write(output); });
}
