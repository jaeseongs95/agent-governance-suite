import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { FileSkillRegistry } from "./registry.js";
import { ContinuityService, type ContinuityGateway, UnavailableContinuityService } from "./continuity-service.js";
import { SqliteContinuityStore } from "./continuity-store.js";
import {
  assertDistinctDatabasePaths,
  resolveContinuityDatabasePath,
  resolveHostAttestation,
  resolveKoreanProseGlossaryPath,
  resolveRegistryPath,
  resolveSessionBoardDatabasePath,
  resolveToolSchemaProfile,
  resolveTrustDatabasePath,
  resolveWorkflowDatabasePath,
} from "./runtime-config.js";
import { ContractValidator } from "./schema-validator.js";
import { createMcpServer } from "./server.js";
import { PluginUpdateService } from "./plugin-update-service.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";
import { RoutingAwareWorkflowService } from "./routing-aware-workflow-service.js";
import { HostAttestationProvider } from "./host-attestation.js";
import { StateCleanupService } from "./state-cleanup-service.js";
import { SqliteKoreanProseGlossary } from "./korean-prose-glossary.js";
import { TrustStore } from "./trust-store.js";
import { TrustService } from "./trust-service.js";
import { openModelRoutingService } from "./model-routing-service.js";
import { VmCurrentInvocation } from "./host-integration/vm-current-invocation.js";
import { openSemanticService, type OpenSemanticService } from "./routing-v3/open-semantic-service.js";
import { VmModelPolicy } from "./host-integration/vm-model-policy.js";

async function main(): Promise<void> {
  const registryPath = resolveRegistryPath();
  const workflowDatabasePath = resolveWorkflowDatabasePath();
  const continuityDatabasePath = resolveContinuityDatabasePath();
  let continuityPathAvailable = true;
  try {
    assertDistinctDatabasePaths(workflowDatabasePath, continuityDatabasePath);
  } catch {
    continuityPathAvailable = false;
  }
  const store = new SqliteWorkflowStore(workflowDatabasePath);
  const trustStore = new TrustStore(resolveTrustDatabasePath());
  // Additive routing tables share the workflow database, which the workflow store has already created.
  const modelRouting = openModelRoutingService(workflowDatabasePath, store);
  let continuityStore: SqliteContinuityStore | null = null;
  let semantic: OpenSemanticService | null = null;
  process.once("exit", () => {
    semantic?.close();
    continuityStore?.close();
    modelRouting.close();
    trustStore.close();
    store.close();
  });

  const validator = new ContractValidator();
  const hostAttestation = resolveHostAttestation() === "claude-code" ? new HostAttestationProvider(store) : null;
  const vmPolicy = VmModelPolicy.installed();
  const vmInvocation = vmPolicy ? new VmCurrentInvocation(store, Date.now, vmPolicy) : null;
  // Neither bundled host currently exposes a cryptographically distinct direct-human approval event.
  const trust = new TrustService(trustStore);
  const service = new RoutingAwareWorkflowService(
    modelRouting.bridge,
    new FileSkillRegistry(registryPath, validator),
    validator,
    store,
    null,
    hostAttestation,
  );
  const updates = new PluginUpdateService(store);
  let continuity: ContinuityGateway = new UnavailableContinuityService();
  if (continuityPathAvailable) {
    try {
      continuityStore = new SqliteContinuityStore(continuityDatabasePath);
      continuity = new ContinuityService(continuityStore, validator, store);
    } catch {
      // Optional continuity failures never prevent the workflow MCP server from starting.
    }
  }
  const cleanup = new StateCleanupService(store, continuityStore, validator);
  const glossary = new SqliteKoreanProseGlossary(resolveKoreanProseGlossaryPath());
  if (process.env.AGENT_GOVERNANCE_SEMANTIC_ROUTING_ENABLED === "true") {
    semantic = openSemanticService(workflowDatabasePath, store);
  }
  const server = createMcpServer(service, updates, continuity, cleanup, glossary, validator, resolveToolSchemaProfile(), hostAttestation, resolveSessionBoardDatabasePath(), undefined, trust, modelRouting.service, vmInvocation,
    { enabled: semantic !== null, gateway: semantic?.gateway ?? null });
  await server.connect(new StdioServerTransport());
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
