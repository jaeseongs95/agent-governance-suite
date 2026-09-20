import { parentPort, workerData } from "node:worker_threads";

import { SessionMessageStore } from "../../../mcp-server/src/session-message-store.js";

const input = workerData as { databasePath: string; host: string; sessionId: string; nonce: string; nowMs: number };
const store = new SessionMessageStore(input.databasePath);

parentPort!.postMessage({ type: "ready" });
parentPort!.once("message", (message: unknown) => {
  if (message !== "claim") throw new Error("Unexpected worker command.");
  try {
    parentPort!.postMessage({
      type: "result",
      result: store.claimWake({ host: input.host, sessionId: input.sessionId }, [input.nonce], input.nowMs),
    });
  } finally {
    store.close();
  }
});
