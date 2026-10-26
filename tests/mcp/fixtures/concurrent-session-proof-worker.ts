import { WorkflowContractError } from "../../../contracts/types.js";
import { SessionActorProofs, type VerifiedSessionActor } from "../../../mcp-server/src/session-actor-proof.js";
import { SqliteWorkflowStore } from "../../../mcp-server/src/sqlite-workflow-store.js";

// Same IPC ready/claim/result protocol as the existing concurrent claim workers.
// Each worker owns a real SQLite connection; no native actor or operational DB is read.
const input = JSON.parse(process.argv[2]!) as {
  databasePath: string;
  tool: string;
  args: Record<string, unknown>;
  now: number;
};
const store = new SqliteWorkflowStore(input.databasePath);
const proofs = new SessionActorProofs(store, () => input.now);
let closed = false;
function close(): void {
  if (closed) return;
  store.close();
  closed = true;
}
const deadline = setTimeout(() => {
  close();
  process.exitCode = 1;
  process.disconnect?.();
}, 15_000);
process.once("disconnect", () => { clearTimeout(deadline); close(); });
process.send!({ type: "ready" });
process.once("message", (message: unknown) => {
  clearTimeout(deadline);
  let result: { ok: boolean; pid: number; actor?: VerifiedSessionActor; code?: string; reasonCode?: string };
  try {
    if (message !== "claim") throw new Error("Unexpected proof worker command.");
    result = { ok: true, actor: proofs.verify(input.tool, input.args), pid: process.pid };
  } catch (error) {
    // An unexpected storage/import/runtime error must fail the worker, not masquerade as replay rejection.
    if (!(error instanceof WorkflowContractError) || typeof error.details?.reasonCode !== "string") throw error;
    result = { ok: false, code: error.code, reasonCode: error.details.reasonCode, pid: process.pid };
  } finally {
    close();
  }
  process.send!({ type: "result", result }, (error: Error | null) => {
    if (error) throw error;
    process.disconnect!();
  });
});
