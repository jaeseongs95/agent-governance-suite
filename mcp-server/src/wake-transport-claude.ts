import net from "node:net";
import { errorCode, type WakeDispatchOutcome, type WakeDispatchPort } from "./session-message-wake-port.js";

/** Claude messaging socket result. Nothing written means no effect; a write that did not close cleanly may have landed. */
export function claudeWakeOutcome(hadError: boolean, connected: boolean, wrote: boolean, code?: string): WakeDispatchOutcome {
  if (!hadError && wrote) return { result: "handed-off" };
  if (connected || wrote) return { result: "unknown", reasonCode: "CLAUDE_INBOX_WRITE_UNCONFIRMED" };
  return { result: "not-delivered", kind: "transient", reasonCode: code ? `CLAUDE_INBOX_CONNECT_FAILED:${code}` : "CLAUDE_INBOX_CONNECT_FAILED" };
}

export async function ringClaude(message: string, environment: NodeJS.ProcessEnv = process.env): Promise<WakeDispatchOutcome> {
  const socketPath = environment.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = environment.CLAUDE_CODE_MESSAGING_TOKEN;
  if (!socketPath || !token) return { result: "not-delivered", kind: "prerequisite-missing", reasonCode: "CLAUDE_MESSAGING_ENV_MISSING" };
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let wrote = false;
    let code: string | undefined;
    const finish = (outcome: WakeDispatchOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const socket = net.createConnection(socketPath);
    socket.setTimeout(5000, () => socket.destroy(new Error("Claude inbox timed out.")));
    socket.once("connect", () => {
      connected = true;
      try {
        wrote = true;
        // Queue behind ongoing host work instead of interrupting the receiving tool.
        socket.end(`${JSON.stringify({ type: "auth", token })}\n${JSON.stringify({ type: "user", message: { role: "user", content: message }, priority: "next" })}\n`);
      } catch { finish({ result: "unknown", reasonCode: "CLAUDE_INBOX_WRITE_UNCONFIRMED" }); }
    });
    socket.once("close", (hadError) => finish(claudeWakeOutcome(hadError, connected, wrote, code)));
    socket.once("error", (error) => { code = errorCode(error); finish(claudeWakeOutcome(true, connected, wrote, code)); });
  });
}

/** The host drops a held message after dialogExpiry (5 min default); resend after that plus margin (design 3.2). */
export const claudeInboxWakePort: WakeDispatchPort = {
  capabilities: { supportedInjection: ["peer-wake", "tool-boundary", "turn-end"], idleWake: "silent" },
  resendBaseMs: 10 * 60_000,
  dispatch: (_target, message) => ringClaude(message),
};
