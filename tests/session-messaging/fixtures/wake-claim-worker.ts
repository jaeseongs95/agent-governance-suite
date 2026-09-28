import { SessionMessageStore } from "../../../mcp-server/src/session-message-store.js";

const input = JSON.parse(process.argv[2]!) as { databasePath: string; host: string; sessionId: string; nonce: string; nowMs: number };
const store = new SessionMessageStore(input.databasePath);

process.send!({ type: "ready" });
process.once("message", (message: unknown) => {
  if (message !== "claim") throw new Error("Unexpected worker command.");
  try {
    process.send!({
      type: "result",
      result: store.claimWake({ host: input.host, sessionId: input.sessionId }, [input.nonce], input.nowMs),
    }, () => process.disconnect!());
  } finally {
    store.close();
  }
});
