// Run only as an owned TEST child with --import tsx. No transport, session discovery or process creation.
import { writeSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.ts";
import { sessionMessageRequest, closeSessionMessaging } from "../../mcp-server/src/session-message-client.ts";
import { HOOK_COMMAND_BUDGET } from "../../mcp-server/src/session-message-hook.ts";
import { producerFailureReason } from "../../mcp-server/src/failure-diagnostics.ts";

const [mode, state] = process.argv.slice(2);
if (!["setup", "request"].includes(mode) || !state || !path.isAbsolute(state)
  || path.basename(state) !== "messaging" || !path.basename(path.dirname(state)).startsWith("ags38-peer-elapsed-")
  || process.env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR !== state) throw new Error("Invalid owned TEST arguments");
const target = { host: "codex", sessionId: "ags38-peer-elapsed-recipient" };
const marker = "AGS38_PEER_ELAPSED ";
const observe = (phase, detail = {}) => writeSync(2, marker + JSON.stringify({ phase, nowMs: performance.now(), ...detail }) + "\n");

if (HOOK_COMMAND_BUDGET.deadlineMonotonicMs !== 6500 || HOOK_COMMAND_BUDGET.postClaimReserveMs !== 1000) {
  throw new Error("Original shared CLI budget changed; review this test contract");
}

if (mode === "setup") {
  const store = new SessionMessageStore(path.join(state, "session-messages.sqlite3"));
  let primary;
  try {
    store.send({ messageId: "ags38-peer-elapsed-owned-message", target,
      sender: { host: "codex", sessionId: "ags38-peer-elapsed-sender" },
      body: "Owned TEST body; no wake or external session", ttlSeconds: 600 });
    observe("setup-complete");
  } catch (error) { primary = error; }
  try { store.close(); }
  catch (error) { throw primary ? new AggregateError([primary, error], "Setup and store close failed", { cause: primary }) : error; }
  if (primary) throw primary;
} else {
  const deadline = HOOK_COMMAND_BUDGET.deadlineMonotonicMs - HOOK_COMMAND_BUDGET.postClaimReserveMs;
  if (performance.now() >= deadline) throw new Error("TEST helper startup exhausted original claim budget");
  let attempts = 0;
  observe("request-ready", { deadlineMs: deadline });
  try {
    const result = await sessionMessageRequest("claim-turn-end", { target, maxMessages: 1, maxBodyChars: 4096 }, state, {
      totalTimeoutMs: 8000, deadlineMonotonicMs: deadline, noOperationReplay: true,
      onOperationWrite: () => { attempts += 1; observe("operation-attempt", { attempts }); },
    });
    observe("request-complete", { attempts, messages: result.messages.length });
    process.exitCode = 2; // A successful claim violates this fixture's held-writer precondition.
  } catch (error) {
    observe("request-failed", { attempts, reason: producerFailureReason(error) ?? "UNCLASSIFIED_FAILURE" });
  } finally {
    closeSessionMessaging(state);
    observe("client-closed");
  }
}
