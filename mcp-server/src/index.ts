import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { FileSkillRegistry } from "./registry.js";
import { ContinuityService, type ContinuityGateway, UnavailableContinuityService } from "./continuity-service.js";
import { SqliteContinuityStore } from "./continuity-store.js";
import { resolveContinuityDatabasePath, resolveRegistryPath, resolveWorkflowDatabasePath } from "./runtime-config.js";
import { ContractValidator } from "./schema-validator.js";
import { createMcpServer } from "./server.js";
import { PluginUpdateService } from "./plugin-update-service.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";
import { WorkflowService } from "./workflow-service.js";

async function main(): Promise<void> {
  const registryPath = resolveRegistryPath();
  const store = new SqliteWorkflowStore(resolveWorkflowDatabasePath());
  let continuityStore: SqliteContinuityStore | null = null;
  process.once("exit", () => {
    continuityStore?.close();
    store.close();
  });

  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store);
  const updates = new PluginUpdateService(store);
  let continuity: ContinuityGateway = new UnavailableContinuityService();
  try {
    continuityStore = new SqliteContinuityStore(resolveContinuityDatabasePath());
    continuity = new ContinuityService(continuityStore, validator, store);
  } catch {
    // Optional continuity failures never prevent the workflow MCP server from starting.
  }
  const server = createMcpServer(service, updates, continuity);
  await server.connect(new StdioServerTransport());
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
