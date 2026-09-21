import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { ModelRoutingServiceCore } from "../../skills/coordinate-subagents/scripts/model-routing-service-core.mjs";
import { ModelRoutingWorkflowBridge } from "./model-routing-workflow.js";
import type { WorkflowStore } from "./workflow-store.js";

import { ModelRoutingStore } from "../../skills/coordinate-subagents/scripts/model-routing-store.mjs";

/**
 * One MCP facade over the skill-owned routing engine: no second router and no trusted gate. The catalog path is
 * resolved from this module because both mcp-server/src and the bundled mcp-server/dist sit two levels below the root.
 */
export const MODEL_CATALOG_DIRECTORY = fileURLToPath(new URL("../../skills/coordinate-subagents/references/model-catalog/", import.meta.url));

export type ModelRoutingGateway = ModelRoutingServiceCore;

export function unavailableModelRouting(): ModelRoutingGateway {
  // Catalog queries still work; resolve finds no capability snapshot and record reports the missing store.
  return new ModelRoutingServiceCore({ catalogDirectory: MODEL_CATALOG_DIRECTORY });
}

/** Adds the routing tables to the already-created workflow database. A failure never disables the rest of the server. */
export function openModelRoutingService(databasePath: string, workflow?: WorkflowStore): { service: ModelRoutingGateway; bridge: ModelRoutingWorkflowBridge | null; close: () => void } {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 5000;");
    database.exec("PRAGMA synchronous = FULL;");
    const store = new ModelRoutingStore(database);
    const bridge = workflow ? new ModelRoutingWorkflowBridge(workflow, store) : null;
    const service = new ModelRoutingServiceCore({ catalogDirectory: MODEL_CATALOG_DIRECTORY, store, historyProvider: bridge?.history ?? null });
    const opened = database;
    return { service, bridge, close: () => opened.close() };
  } catch {
    database?.close();
    return { service: unavailableModelRouting(), bridge: null, close: () => {} };
  }
}
