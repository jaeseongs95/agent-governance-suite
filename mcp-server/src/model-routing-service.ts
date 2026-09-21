import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { ModelRoutingServiceCore, type RoutingApiResult } from "../../skills/coordinate-subagents/scripts/model-routing-service-core.mjs";
import { ModelRoutingWorkflowBridge } from "./model-routing-workflow.js";
import type { WorkflowStore } from "./workflow-store.js";

import { ModelRoutingStore } from "../../skills/coordinate-subagents/scripts/model-routing-store.mjs";
import { readSharedModelCapabilities, mergeRoutingCapabilities, type SharedCapabilityResult } from "./model-capability-client.js";

/**
 * One MCP facade over the skill-owned routing engine: no second router and no trusted gate. The catalog path is
 * resolved from this module because both mcp-server/src and the bundled mcp-server/dist sit two levels below the root.
 */
export const MODEL_CATALOG_DIRECTORY = fileURLToPath(new URL("../../skills/coordinate-subagents/references/model-catalog/", import.meta.url));

export type ModelRoutingGateway = ModelRoutingServiceCore & {
  resolveFromBroker?: (input: unknown) => Promise<RoutingApiResult>;
};

export function unavailableModelRouting(): ModelRoutingGateway {
  // Catalog queries still work; resolve finds no capability snapshot and record reports the missing store.
  return new ModelRoutingServiceCore({ catalogDirectory: MODEL_CATALOG_DIRECTORY });
}

/** Adds the routing tables to the already-created workflow database. A failure never disables the rest of the server. */
export function openModelRoutingService(databasePath: string, workflow?: WorkflowStore,
  readCapabilities: () => Promise<SharedCapabilityResult> = readSharedModelCapabilities): { service: ModelRoutingGateway; bridge: ModelRoutingWorkflowBridge | null; close: () => void } {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 5000;");
    database.exec("PRAGMA synchronous = FULL;");
    const store = new ModelRoutingStore(database);
    const bridge = workflow ? new ModelRoutingWorkflowBridge(workflow, store) : null;
    const service: ModelRoutingGateway = new ModelRoutingServiceCore({ catalogDirectory: MODEL_CATALOG_DIRECTORY, store, historyProvider: bridge?.history ?? null });
    service.resolveFromBroker = async (input) => {
      try {
        // Per-call snapshots: concurrent requests never mutate a shared provider/cache.
        const shared = await readCapabilities();
        return service.call("resolve_model_assignment", input, mergeRoutingCapabilities(store.capabilities(), shared));
      } catch {
        return { schemaVersion: "1.0.0", ok: false, data: null, error: { code: "MCP_UNAVAILABLE",
          message: "Model capability exchange is unavailable or inconsistent.", details: { routingCode: "CAPABILITY_EXCHANGE_UNAVAILABLE" } } };
      }
    };
    const opened = database;
    return { service, bridge, close: () => opened.close() };
  } catch {
    database?.close();
    return { service: unavailableModelRouting(), bridge: null, close: () => {} };
  }
}
