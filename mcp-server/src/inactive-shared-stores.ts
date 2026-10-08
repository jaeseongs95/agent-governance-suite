import { InactiveSharedConnection, resolveInactiveSharedDatabasePath, type SharedModuleContext, type SqlDatabase } from "../../runtime/unified-state/shared-connection.mjs";
import { openBoard } from "../../skills/session-board/scripts/board-store.mjs";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";
import { SqliteContinuityStore } from "./continuity-store.js";
import { SessionMessageStore } from "./session-message-store.js";
import { TrustStore } from "./trust-store.js";
import { createWakeHookObservationReader, verifyHistoricalWakeObservation, type VerifiedInputSourceReader } from "./session-message-wake-port.js";
import { PLAN_SIGNING_KEY } from "./workflow-store.js";

export interface InactiveSharedStoresOptions {
  directory: string;
  mode: "fixture-only";
  clock: () => number;
  syntheticKeys: { workflow: string; continuity: string; trust: string };
}

/** Explicit inactive composition only; it never imports main, resolves a profile or starts a service. */
export function createInactiveSharedStores(options: InactiveSharedStoresOptions) {
  if (options.mode !== "fixture-only" || typeof options.clock !== "function") throw new Error("An explicit fixture-only mode and clock are required.");
  if (!options.syntheticKeys || Object.keys(options.syntheticKeys).sort().join(",") !== "continuity,trust,workflow") throw new Error("Exactly three synthetic key namespaces are required.");
  for (const key of Object.values(options.syntheticKeys)) {
    if (typeof key !== "string" || Buffer.from(key, "base64url").length !== 32
      || Buffer.from(key, "base64url").toString("base64url") !== key) throw new Error("Every module requires an explicit synthetic 32-byte key.");
  }
  if (new Set(Object.values(options.syntheticKeys)).size !== 3) throw new Error("Synthetic key namespaces must be distinct.");
  const owner = new InactiveSharedConnection({ databasePath: resolveInactiveSharedDatabasePath(options.directory), mode: options.mode, clock: options.clock });
  try {
    let workflow!: SqliteWorkflowStore;
    let continuity!: SqliteContinuityStore;
    let messaging!: SessionMessageStore<SharedModuleContext>;
    let trust!: TrustStore;
    let board!: SqlDatabase;
    owner.initialize(() => {
      workflow = new SqliteWorkflowStore(owner.borrow("workflow"));
      continuity = new SqliteContinuityStore(owner.borrow("continuity"));
      trust = new TrustStore(owner.borrow("trust"), options.syntheticKeys.trust);
      messaging = new SessionMessageStore(owner.borrow("messaging"));
      board = openBoard(owner.borrow("board"));
      const workflowKey = workflow.getOrCreateSecret(PLAN_SIGNING_KEY, () => options.syntheticKeys.workflow);
      const continuityKey = continuity.getOrCreateSecret(() => options.syntheticKeys.continuity);
      if (workflowKey !== options.syntheticKeys.workflow || continuityKey !== options.syntheticKeys.continuity) throw new Error("Existing key namespace differs from the explicit synthetic input.");
    });
    const verifiedSourceReader: VerifiedInputSourceReader = {
      readVerifiedInputSource(receiptId) { const receipt = trust.getInputSource(receiptId); return receipt && trust.verify(receipt) ? receipt : null; },
    };
    const wakeReader = createWakeHookObservationReader(verifiedSourceReader);
    const historicalWakeVerifier: typeof verifyHistoricalWakeObservation = (target, nonce, receiptId, started, late, now) =>
      verifyHistoricalWakeObservation(target, nonce, receiptId, started, late, now, verifiedSourceReader);
    return { owner, workflow, continuity, messaging, trust, board, wakeReader, historicalWakeVerifier };
  } catch (error) { owner.close(); throw error; }
}
