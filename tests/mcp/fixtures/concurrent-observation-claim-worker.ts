import { SqliteWorkflowStore } from "../../../mcp-server/src/sqlite-workflow-store.js";

const input = JSON.parse(process.argv[2]!) as {
  databasePath: string;
  observationId: string;
  expiresAt: string;
  consumedAt: string;
};
const store = new SqliteWorkflowStore(input.databasePath);

const deadline = setTimeout(() => { store.close(); process.exitCode = 1; process.disconnect?.(); }, 15000);
process.once("disconnect", () => { clearTimeout(deadline); store.close(); });
process.send!({ type: "ready" });
process.once("message", (message: unknown) => {
  clearTimeout(deadline);
  try {
    if (message !== "claim") throw new Error("Unexpected worker command.");
    process.send!({
      type: "result",
      result: store.claimExecutionObservation(input.observationId, input.expiresAt, input.consumedAt),
    }, () => process.disconnect!());
  } finally {
    store.close();
  }
});
