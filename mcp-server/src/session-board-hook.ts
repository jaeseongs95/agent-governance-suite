import "./builtin-hook-host-adapters.js";
import { hookFailureContext, hookFailureReason } from "./hook-error-diagnostics.js";
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
import { adaptHostInput, isGovernanceHookTool, resolveHookHost } from "./host-input-adapter.js";

type BoardFailurePhase = "host-entry" | "stdin" | "stdout" | "input" | "consume-wake" | "open" | "handle" | "close";

function reportBoardFailure(phase: BoardFailurePhase, cause: unknown): void {
  try { console.error("[agent-governance-suite] board-hook-failure " + JSON.stringify({
    phase, reason: hookFailureReason(cause) ?? "UNEXPECTED_FAILURE", context: hookFailureContext(cause),
  })); } catch { /* Diagnostics cannot change the fail-open behavior. */ }
}

type HookInput = Record<string, unknown>;
type Board = ReturnType<typeof openBoard>;

const BOARD_TOOLS = new Set(["update_session_status", "list_session_status"]);
// Claude Code tool names plus candidate Codex shell/patch tool names; a name a host never sends is never gated.
const GATED_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "PowerShell", "Agent", "Task", "shell", "local_shell", "exec_command", "apply_patch"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "shell", "local_shell", "exec_command"]);

export const GATE_REASON = "세션 현황판: 이 요청에서 무엇을 하는지 한 줄로 먼저 적어야 합니다. update_session_status를 {\"schemaVersion\":\"1.0.0\",\"summary\":\"<무엇을 · 어디서(브랜치) · 다음 외부 작업>\"}로 호출한 뒤 다시 시도하세요. 같은 작업이 이어지면 같은 문장도 됩니다. 도구를 쓸 수 없으면 그대로 다시 시도하세요. 다음 시도는 허용됩니다.";

function preToolUse(permissionDecision: "deny" | undefined, extra: Record<string, unknown>): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", ...(permissionDecision ? { permissionDecision } : {}), ...extra } };
}

/** Maps one host hook event onto the board; identity always comes from the hook input, never from the model. */
export function handleSessionBoardHook(input: HookInput, board: Board | null, host: string, now: string = new Date().toISOString(), verifiedInternalWake = false): Record<string, unknown> {
  const adapted = adaptHostInput(input, host);
  const observation = adapted.observation;
  const sessionId = observation.sessionId;
  if (!sessionId) return {};
  const main = observation.actor.kind === "main" && observation.actor.assurance === "observed";
  const toolName = observation.toolName ?? "";
  const toolInput = observation.toolInput ?? {};
  const localTool = toolName.split("__").at(-1) ?? "";
  const boardTool = observation.kind === "tool-boundary" && observation.boundaryPhase === "before"
    && isGovernanceHookTool(host, toolName) && BOARD_TOOLS.has(localTool);
  if (boardTool && !main) return preToolUse("deny", {
    permissionDecisionReason: "세션 현황판 조회와 갱신은 관측된 메인 세션만 수행합니다.",
  });
  // Unknown actors cannot write a parent row or receive its binding.
  if (!main || !board) return {};
  const session = { host, sessionId, cwd: observation.workspaceId || process.cwd(), now };

  if (adapted.lifecycle === "start") {
    pruneSessions(board, now);
    touchSession(board, session);
    return {};
  }
  if (observation.kind === "user-input") {
    pruneSessions(board, now);
    if (verifiedInternalWake) touchSession(board, session);
    else recordPrompt(board, session);
    return {};
  }
  if (observation.kind !== "tool-boundary" || observation.boundaryPhase !== "before") return {};

  if (boardTool) {
    if (localTool === "update_session_status") {
      if (!normalizeSummary(toolInput.summary)) {
        return preToolUse("deny", { permissionDecisionReason: `summary는 ${SUMMARY_MAX_LENGTH}자 이하의 한 줄이어야 합니다.` });
      }
      setSummary(board, session, toolInput.summary);
    }
    return preToolUse(undefined, { updatedInput: { ...toolInput, _sessionBinding: { host, sessionId } } });
  }

  if (!GATED_TOOLS.has(toolName)) return {};
  if (SHELL_TOOLS.has(toolName) && isReadOnlyCommand(toolInput.command)) return {};
  return gateDecision(board, session) === "deny" ? preToolUse("deny", { permissionDecisionReason: GATE_REASON }) : {};
}

/**
 * Runs one hook event and returns the JSON to print; every failure lets the tool call through.
 * `raw` is either the already-read input or a reader; a reader failure is reported as the stdin phase with its cause.
 */
export async function runSessionBoardHook(
  host: string,
  raw: string | (() => string),
  request: typeof sessionMessageRequest = sessionMessageRequest,
): Promise<string> {
  let board: Board | null = null;
  let phase: BoardFailurePhase = "stdin";
  try {
    const text = typeof raw === "function" ? raw() : raw;
    phase = "input";
    const input = JSON.parse(text) as HookInput;
    const observation = adaptHostInput(input, host).observation;
    const main = observation.actor.kind === "main" && observation.actor.assurance === "observed";
    let verifiedInternalWake = false;
    if (observation.kind === "user-input" && main) {
      const nonces = observation.wakeCandidates ?? [];
      const sessionId = observation.sessionId;
      let allRecognized = nonces.length > 0;
      if (sessionId) {
        for (const nonce of nonces) {
          try {
            // Ownership check only: the message hook owns observation and atomic claim.
            const result = await request<{ consumed: boolean }>("consume-wake", { target: { host, sessionId }, nonce });
            allRecognized &&= result.consumed;
          } catch (cause) {
            // Unverified wake: treated as an ordinary prompt, but the cause stays observable.
            allRecognized = false;
            reportBoardFailure("consume-wake", cause);
          }
        }
      } else allRecognized = false;
      verifiedInternalWake = observation.wakeOnly === true && allRecognized;
    }
    if (main) {
      phase = "open";
      board = openBoard(resolveSessionBoardDatabasePath(), { busyTimeoutMs: 500 });
    }
    phase = "handle";
    const output = handleSessionBoardHook(input, board, host, new Date().toISOString(), verifiedInternalWake);
    return Object.keys(output).length > 0 ? JSON.stringify(output) : "";
  } catch (cause) {
    // Fail open, but keep the failed phase and redacted cause.
    reportBoardFailure(phase, cause);
    return "";
  } finally {
    try { board?.close(); } catch (cause) { reportBoardFailure("close", cause); }
  }
}

// Direct execution is the Codex hook; the Claude Code launcher imports runSessionBoardHook instead.
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const host = resolveHookHost(process.argv.slice(2), "codex");
    // The hook reads stdin itself so a read failure keeps its own phase and cause instead of becoming invalid input.
    void runSessionBoardHook(host, () => readFileSync(0, "utf8")).then((output) => {
      if (!output) return;
      let reported = false;
      const outputFailed = (cause: unknown) => {
        if (reported) return;
        reported = true;
        reportBoardFailure("stdout", cause);
      };
      process.stdout.on("error", outputFailed);
      try { process.stdout.write(output, (cause) => { if (cause) outputFailed(cause); }); }
      catch (cause) { outputFailed(cause); }
    }).catch((cause) => reportBoardFailure("stdout", cause));
  } catch (cause) {
    // Invalid explicit hosts still issue no binding and touch no board.
    reportBoardFailure("host-entry", cause);
  }
}
