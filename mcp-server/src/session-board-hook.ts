import { isHookEntry } from "./hook-entry.js";
import { actorAccess } from "./input-observation.js";
import "./builtin-hook-host-adapters.js";
import { hookFailureContext, hookFailureReason } from "./hook-error-diagnostics.js";
import { failureReason } from "./failure-diagnostics.js";
import { readFileSync } from "node:fs";

import { BoardFormatError, openBoard, pruneBoard, recordInput } from "../../skills/session-board/scripts/board-store.mjs";
import { resolveSessionBoardDatabasePath } from "./runtime-config.js";
import { sessionMessageRequest } from "./session-message-client.js";
import { adaptHostInput, resolveHookHost } from "./host-input-adapter.js";

type BoardFailurePhase = "host-entry" | "stdin" | "stdout" | "input" | "consume-wake" | "open" | "handle" | "close";

function reportBoardFailure(phase: BoardFailurePhase, cause: unknown): void {
  try { console.error("[agent-governance-suite] board-hook-failure " + JSON.stringify({
    // An OS, SQLite or JSON cause keeps its own class instead of UNEXPECTED_FAILURE (same rule as the continuity hook).
    phase, reason: hookFailureReason(cause) ?? (cause instanceof BoardFormatError ? cause.code : null) ?? failureReason(cause).reason ?? "UNEXPECTED_FAILURE", context: hookFailureContext(cause),
  })); } catch { /* Diagnostics cannot change the fail-open behavior. */ }
}

type HookInput = Record<string, unknown>;
type Board = ReturnType<typeof openBoard>;

/**
 * Records one main-session user input on the board; identity always comes from the hook input, never from the model.
 * Only the prompt time and working directory are kept. Every other event is a no-op: liveness is the messaging
 * presence, and the summary is written by the MCP tool under the server-verified binding.
 */
export function handleSessionBoardHook(input: HookInput, board: Board | null, host: string, now: string = new Date().toISOString(), verifiedInternalWake = false): Record<string, unknown> {
  const observation = adaptHostInput(input, host).observation;
  const sessionId = observation.sessionId;
  // Unknown actors (subagents) cannot write the parent row.
  if (!sessionId || !board || observation.kind !== "user-input" || !actorAccess(observation.actor).allowed) return {};
  pruneBoard(board, now);
  recordInput(board, { host, sessionId, cwd: observation.workspaceId || null, now }, { prompt: !verifiedInternalWake });
  return {};
}

/**
 * Runs one hook event and returns the JSON to print; every failure is reported and lets the session continue.
 * `raw` is either the already-read input or a reader; a reader failure is reported as the stdin phase with its cause.
 */
export async function runSessionBoardHook(
  host: string,
  raw: string | (() => string),
  request: typeof sessionMessageRequest = sessionMessageRequest,
): Promise<string> {
  let board: Board | null = null;
  let phase: BoardFailurePhase = "stdin";
  let result = "";
  try {
    const text = typeof raw === "function" ? raw() : raw;
    phase = "input";
    const input = JSON.parse(text) as HookInput;
    const observation = adaptHostInput(input, host).observation;
    const main = actorAccess(observation.actor).allowed;
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
    if (main && observation.kind === "user-input" && observation.sessionId) {
      phase = "open";
      board = openBoard(resolveSessionBoardDatabasePath(), { busyTimeoutMs: 500 });
    }
    phase = "handle";
    const output = handleSessionBoardHook(input, board, host, new Date().toISOString(), verifiedInternalWake);
    result = Object.keys(output).length > 0 ? JSON.stringify(output) : "";
  } catch (cause) {
    reportBoardFailure(phase, cause);
  } finally {
    try { board?.close(); } catch (cause) { reportBoardFailure("close", cause); }
  }
  return result;
}

// Direct execution is the Codex hook; the Claude Code launcher imports runSessionBoardHook instead.
if (isHookEntry(import.meta.url, "session-board-hook")) {
  try {
    const host = resolveHookHost(process.argv.slice(2), "codex");
    // The hook reads stdin itself so a read failure keeps its own phase and cause instead of becoming invalid input.
    void runSessionBoardHook(host, () => readFileSync(0, "utf8")).then((output) => {
      process.exitCode = 0;
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
