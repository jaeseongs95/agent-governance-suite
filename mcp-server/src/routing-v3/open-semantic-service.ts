/** Optional server-owned semantic composition. No provider or adoption authority is installed yet. */
import { DatabaseSync } from "node:sqlite";

import semanticPolicyJson from "../../../skills/coordinate-subagents/references/semantic-decision/decision-policy.v1.json" with { type: "json" };
import { loadCatalog, loadPolicy } from "../../../skills/coordinate-subagents/scripts/model-catalog.mjs";
import { ModelRoutingStore } from "../../../skills/coordinate-subagents/scripts/model-routing-store.mjs";
import type { RoutingEnvironmentV2 } from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import { MODEL_CATALOG_DIRECTORY } from "../model-routing-service.js";
import { mergeRoutingCapabilities, readSharedModelCapabilities } from "../model-capability-client.js";
import { ContractValidator } from "../schema-validator.js";
import { SemanticEvaluationIntentStore } from "../semantic/evaluation-intent.js";
import { SemanticProviderRegistry } from "../semantic/provider-registry.js";
import { createSemanticGateway, type SemanticMcpGateway } from "./semantic-gateway.js";
import { SemanticRoutingService, type ServerSemanticEvidenceReader } from "./semantic-service.js";
import type { WorkflowStore } from "../workflow-store.js";

export interface OpenSemanticService {
  gateway: SemanticMcpGateway;
  journal: SemanticEvaluationIntentStore;
  registry: SemanticProviderRegistry;
  close(): void;
}

/** Opening is optional: a failed semantic schema/catalog never prevents the existing MCP server from booting. */
export function openSemanticService(databasePath: string,
  workflow: Pick<WorkflowStore, "getGuardedRunSnapshot">): OpenSemanticService | null {
  let database: DatabaseSync | null = null;
  try {
    const validator = new ContractValidator();
    const policy = validator.semanticDecisionPolicyV1(semanticPolicyJson);
    loadCatalog({ directory: MODEL_CATALOG_DIRECTORY });
    loadPolicy(MODEL_CATALOG_DIRECTORY);
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
    const routing = new ModelRoutingStore(database);
    const journal = new SemanticEvaluationIntentStore(database);
    const registry = new SemanticProviderRegistry();
    const adoptionReader = { read: () => null } satisfies ServerSemanticEvidenceReader;
    const service = new SemanticRoutingService(routing, workflow, null, async () => {
      const shared = await readSharedModelCapabilities();
      return { policy, environment: {
        catalog: loadCatalog({ directory: MODEL_CATALOG_DIRECTORY }),
        policy: loadPolicy(MODEL_CATALOG_DIRECTORY),
        capabilities: mergeRoutingCapabilities(routing.capabilities(), shared) as RoutingEnvironmentV2["capabilities"],
        now: new Date().toISOString(),
      } };
    }, adoptionReader);
    const opened = database;
    return { gateway: createSemanticGateway(service), journal, registry, close: () => opened.close() };
  } catch {
    database?.close();
    return null;
  }
}
