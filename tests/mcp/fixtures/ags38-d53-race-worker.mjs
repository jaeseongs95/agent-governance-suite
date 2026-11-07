// TEST-owned worker: a separate SQLite connection/process, never a native model call.
import { SqliteContinuityStore } from "../../../mcp-server/src/continuity-store.ts";
import { clearTimeout, setTimeout } from "node:timers";

const [databasePath, task, epochText] = process.argv.slice(2);
const store = new SqliteContinuityStore(databasePath), epoch = Number(epochText);
const current = store.getCurrent(task, epoch);
if (!current) throw new Error("Owned race fixture has no current state");
const deadline = setTimeout(() => { store.close(); process.exit(73); }, 15_000);
process.once("message", command => {
  try {
    const result = store.checkpoint(task, epoch, current.stateToken, command.requestHash,
      command.commandDigest, command.memory, command.now);
    store.close();
    clearTimeout(deadline);
    process.send({ type: "result", pid: process.pid, kind: result.kind });
    process.disconnect();
  } catch (error) {
    store.close();
    clearTimeout(deadline);
    process.send({ type: "worker-error", reason: error instanceof Error ? error.name : "unknown" });
    process.disconnect();
    process.exitCode = 74;
  }
});
process.send({ type: "ready", pid: process.pid, stateToken: current.stateToken });
