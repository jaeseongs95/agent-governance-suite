import { FileSkillRegistry } from "../../../mcp-server/src/registry.js";
import { ContractValidator } from "../../../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../../../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService } from "../../../mcp-server/src/workflow-service.js";

const input = JSON.parse(process.argv[2]!) as { databasePath: string; registryPath: string; proposal: unknown };
const store = new SqliteWorkflowStore(input.databasePath);
const validator = new ContractValidator();
const service = new WorkflowService(new FileSkillRegistry(input.registryPath, validator), validator, store);

process.send!({ type: "ready" });
process.once("message", (message: unknown) => {
  if (message !== "claim") throw new Error("Unexpected worker command.");
  try {
    process.send!({ type: "result", result: service.claimWorkflowAttempt(input.proposal) }, () => process.disconnect!());
  } finally {
    store.close();
  }
});
