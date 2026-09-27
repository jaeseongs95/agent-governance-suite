import { SessionMessageStore } from "../../../mcp-server/src/session-message-store.js";

const store = new SessionMessageStore(process.argv[2]!);
process.send!({ type: "ready" });
process.once("message", (input: { operation: "prepare" | "send"; sender: { host: string; sessionId: string }; target: { host: string; sessionId: string }; messageId: string; nowMs: number }) => {
  try {
    const result = input.operation === "prepare"
      ? store.prepare({ sender: input.sender, target: input.target, body: "Concurrent preparation" }, input.nowMs)
      : store.submitPrepared(input.sender, input.messageId, input.nowMs);
    process.send!({ type: "result", result }, () => { store.close(); process.disconnect!(); });
  } catch (error) {
    process.send!({ type: "result", error: error instanceof Error ? error.message : "worker failed" }, () => { store.close(); process.disconnect!(); });
  }
});
