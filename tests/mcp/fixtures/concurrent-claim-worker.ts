import { parentPort, workerData } from "node:worker_threads";

import { FileSkillRegistry } from "../../../mcp-server/src/registry.js";
import { ContractValidator } from "../../../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../../../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService } from "../../../mcp-server/src/workflow-service.js";

const input = workerData as { databasePath: string; registryPath: string; proposal: unknown };
const store = new SqliteWorkflowStore(input.databasePath);
const validator = new ContractValidator();
const service = new WorkflowService(new FileSkillRegistry(input.registryPath, validator), validator, store);

parentPort!.postMessage({ type: "ready" });
parentPort!.once("message", (message: unknown) => {
  if (message !== "claim") throw new Error("Unexpected worker command.");
  try {
    parentPort!.postMessage({ type: "result", result: service.claimWorkflowAttempt(input.proposal) });
  } finally {
    store.close();
  }
});
