import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { FileSkillRegistry } from "./registry.js";
import { ContinuityService, type ContinuityGateway, UnavailableContinuityService } from "./continuity-service.js";
import { continuityUnavailableReason, SqliteContinuityStore } from "./continuity-store.js";
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
import { WorkflowService } from "./workflow-service.js";
import { HostAttestationProvider } from "./host-attestation.js";
import { claudeCodeExecutionAdapter, codexExecutionAdapter } from "./host-execution-adapters.js";
import { StateCleanupService } from "./state-cleanup-service.js";
import { SqliteKoreanProseGlossary } from "./korean-prose-glossary.js";
import { TrustStore } from "./trust-store.js";
import { TrustService } from "./trust-service.js";

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
  let continuityStore: SqliteContinuityStore | null = null;
  process.once("exit", () => {
    continuityStore?.close();
    trustStore.close();
    store.close();
  });

  const validator = new ContractValidator();
  const attestationHost = resolveHostAttestation();
  const hostAttestation = attestationHost ? new HostAttestationProvider(
    store, attestationHost === "codex" ? codexExecutionAdapter : claudeCodeExecutionAdapter,
  ) : null;
  // Neither bundled host currently exposes a cryptographically distinct direct-human approval event.
  const trust = new TrustService(trustStore);
  const service = new WorkflowService(
    new FileSkillRegistry(registryPath, validator),
    validator,
    store,
    null,
    hostAttestation,
  );
  const updates = new PluginUpdateService(store);
  let continuity: ContinuityGateway = new UnavailableContinuityService(continuityPathAvailable ? "STORE_UNAVAILABLE" : "DATABASE_PATH_CONFLICT");
  if (continuityPathAvailable) {
    try {
      continuityStore = new SqliteContinuityStore(continuityDatabasePath);
      continuity = new ContinuityService(continuityStore, validator, store);
    } catch (error) {
      // Optional continuity failures never prevent the workflow MCP server from starting.
      try { continuityStore?.close(); } catch { /* Preserve the optional initialization failure. */ }
      continuityStore = null;
      continuity = new UnavailableContinuityService(continuityUnavailableReason(error));
    }
  }
  const cleanup = new StateCleanupService(store, continuityStore, validator);
  const glossary = new SqliteKoreanProseGlossary(resolveKoreanProseGlossaryPath());
  const server = createMcpServer(service, updates, continuity, cleanup, glossary, validator, resolveToolSchemaProfile(), hostAttestation, resolveSessionBoardDatabasePath(), undefined, trust);
  await server.connect(new StdioServerTransport());
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
