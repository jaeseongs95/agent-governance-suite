import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { FileSkillRegistry } from "./registry.js";
import { resolveRegistryPath, resolveWorkflowDatabasePath } from "./runtime-config.js";
import { ContractValidator } from "./schema-validator.js";
import { createMcpServer } from "./server.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";
import { WorkflowService } from "./workflow-service.js";

async function main(): Promise<void> {
  const registryPath = resolveRegistryPath();
  const store = new SqliteWorkflowStore(resolveWorkflowDatabasePath());
  process.once("exit", () => store.close());

  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store);
  const server = createMcpServer(service);
  await server.connect(new StdioServerTransport());
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
