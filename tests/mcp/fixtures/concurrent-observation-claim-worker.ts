import { SqliteWorkflowStore } from "../../../mcp-server/src/sqlite-workflow-store.js";

const input = JSON.parse(process.argv[2]!) as {
  databasePath: string;
  observationId: string;
  expiresAt: string;
  consumedAt: string;
};
const store = new SqliteWorkflowStore(input.databasePath);

process.send!({ type: "ready" });
process.once("message", (message: unknown) => {
  if (message !== "claim") throw new Error("Unexpected worker command.");
  try {
    process.send!({
      type: "result",
      result: store.claimExecutionObservation(input.observationId, input.expiresAt, input.consumedAt),
    }, () => process.disconnect!());
  } finally {
    store.close();
  }
});
