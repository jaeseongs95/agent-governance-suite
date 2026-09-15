import { parentPort, workerData } from "node:worker_threads";

import { SqliteWorkflowStore } from "../../../mcp-server/src/sqlite-workflow-store.js";

const input = workerData as {
  databasePath: string;
  observationId: string;
  expiresAt: string;
  consumedAt: string;
};
const store = new SqliteWorkflowStore(input.databasePath);

parentPort!.postMessage({ type: "ready" });
parentPort!.once("message", (message: unknown) => {
  if (message !== "claim") throw new Error("Unexpected worker command.");
  try {
    parentPort!.postMessage({
      type: "result",
      claimed: store.claimExecutionObservation(input.observationId, input.expiresAt, input.consumedAt),
    });
  } finally {
    store.close();
  }
});
