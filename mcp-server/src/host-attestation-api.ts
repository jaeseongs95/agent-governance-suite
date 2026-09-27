import { type HostExecutionAdapter, type HostObservation, withHostObservation } from "./host-attestation.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";

/** Public, dependency-free ingress; workflow ledger operations stay private to the server. */
export function openHostAttestation(databasePath: string, adapter: HostExecutionAdapter) {
  const store = new SqliteWorkflowStore(databasePath);
  return {
    runObserved<T>(tool: string, args: Record<string, unknown>, observe: () => Omit<HostObservation, "tool" | "input"> | null,
      dispatch: (input: Record<string, unknown>) => T): T {
      return withHostObservation(store, adapter, tool, args, observe, dispatch);
    },
    close(): void { store.close(); },
  };
}

export { hostActorId } from "./host-attestation.js";
export type { HostExecutionAdapter, HostObservation } from "./host-attestation.js";
export { claudeCodeExecutionAdapter, codexExecutionAdapter } from "./host-execution-adapters.js";
