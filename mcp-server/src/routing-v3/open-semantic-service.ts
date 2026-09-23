/** Optional server-owned semantic composition. Registration grants no call or adoption authority. */
import { DatabaseSync } from "node:sqlite";

import semanticPolicyJson from "../../../skills/coordinate-subagents/references/semantic-decision/decision-policy.v1.json" with { type: "json" };
import { loadCatalog, loadPolicy } from "../../../skills/coordinate-subagents/scripts/model-catalog.mjs";
import { ModelRoutingStore } from "../../../skills/coordinate-subagents/scripts/model-routing-store.mjs";
import type { RoutingEnvironmentV2 } from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import { MODEL_CATALOG_DIRECTORY } from "../model-routing-service.js";
import { mergeRoutingCapabilities, readSharedModelCapabilities } from "../model-capability-client.js";
import { ContractValidator } from "../schema-validator.js";
import { SemanticEvaluationIntentStore } from "../semantic/evaluation-intent.js";
import type { SemanticAdoptionPolicyV1 } from "../../../contracts/types.js";
import { createOptionalJevRegistry, type JevRegistryResult } from "../semantic/provider-registry.js";
import { JEV_ENDPOINT } from "../semantic/providers/jev/http-client.js";
import { createSemanticGateway, type SemanticMcpGateway } from "./semantic-gateway.js";
import { SemanticRoutingService, type ServerSemanticEvidenceReader } from "./semantic-service.js";
import type { WorkflowStore } from "../workflow-store.js";

export interface OpenSemanticService {
  gateway: SemanticMcpGateway;
  journal: SemanticEvaluationIntentStore;
  registry: JevRegistryResult["registry"];
  jev: Omit<JevRegistryResult, "registry">;
  close(): void;
}

type JevRootInput = {
  enabled: boolean;
  egressConfig?: unknown;
  credential: () => string | null;
  adoption?: SemanticAdoptionPolicyV1;
};

function configuredJevRoute(value: unknown, validator: ContractValidator): boolean {
  try {
    const config = validator.semanticEgressConfigV1(typeof value === "string" ? JSON.parse(value) : value);
    return config.enabled && config.routes.filter(route => route.providerId === "jev"
      && route.endpoint === JEV_ENDPOINT && route.accessPaths.includes("api")
      && (["routing", "question", "catalog"] as const)
        .every(category => route.dataCategories.includes(category))).length === 1;
  } catch { return false; }
}

function environmentJev(): JevRootInput {
  return { enabled: process.env.AGENT_GOVERNANCE_JEV_ENABLED === "true",
    egressConfig: process.env.AGENT_GOVERNANCE_SEMANTIC_EGRESS_CONFIG,
    credential: () => process.env.TYPESAFE_API_KEY ?? null };
}

/** Opening is optional: a failed semantic schema/catalog never prevents the existing MCP server from booting. */
export function openSemanticService(databasePath: string,
  workflow: Pick<WorkflowStore, "getGuardedRunSnapshot">,
  jevInput: JevRootInput = environmentJev()): OpenSemanticService | null {
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
    const jev = jevInput.enabled && configuredJevRoute(jevInput.egressConfig, validator)
      ? createOptionalJevRegistry({ enabled: true, credential: jevInput.credential,
        timeoutMs: 30_000, maxResponseBytes: 256 * 1024,
        adoption: jevInput.adoption ?? policy.adoption })
      : createOptionalJevRegistry();
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
    const { registry, ...jevStatus } = jev;
    return { gateway: createSemanticGateway(service), journal, registry, jev: jevStatus,
      close: () => opened.close() };
  } catch {
    database?.close();
    return null;
  }
}
