import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { openModelRoutingService } from "../../mcp-server/src/model-routing-service.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const digest = `sha256:${"a".repeat(64)}`;
const binding = { assignmentId: "a-1", taskId: "t-1", runId: "r-1", stageId: "s-1", attemptId: "at-1", revision: 1, inputDigest: digest, candidateDigest: digest };
const selectionRequest = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "2.0.0", binding, role: "general-implementation", highRisk: false,
  requirements: {
    inputModalities: ["text"], tools: [], filesystem: "read", allowedSurfaces: ["local-subagent"], allowedRuntimeModes: ["standard"],
    allowNestedDelegation: false, requireObservable: [], excludedActors: [], excludedSessions: [], contextMode: "limited",
  },
  ...overrides,
});
const selection = { model: "m", resolvedModel: "m", modelOrigin: "openai", servingProvider: "openai", accessPath: "subscription", nativeReasoning: { kind: "not-exposed" }, runtimeMode: "standard" };
const applicationRequest = {
  schemaVersion: "2.0.0", binding, decisionDigest: digest, target: { actorId: "x", host: "h", sessionId: "s", instanceId: "i" },
  dispatched: selection, dispatchedAt: "2026-09-21T12:00:00.000Z",
};

function userVersion(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    database.close();
  }
}

type ToolResult = { ok: boolean; data: Record<string, unknown> | null; error: { code: string; details: Record<string, unknown> | null } | null };

async function connect(): Promise<Client> {
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore());
  const server = createMcpServer(service, new PluginUpdateService(new InMemoryPluginUpdateStore()), undefined, undefined, undefined, validator);
  const client = new Client({ name: "model-routing-service", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as ToolResult;
}

describe("model routing MCP facade", () => {
  it("serves the skill catalog and never resolves from caller-supplied capabilities", async () => {
    const client = await connect();
    try {
      const catalog = await call(client, "query_model_catalog", { provider: "anthropic" });
      expect(catalog.ok).toBe(true);
      expect(catalog.data).toMatchObject({ liveVerified: false });
      const blocked = await call(client, "resolve_model_assignment", selectionRequest());
      expect(blocked.data).toMatchObject({ status: "blocked", executionAuthorized: false, trustedGateSatisfied: false });
      expect((await call(client, "resolve_model_assignment", selectionRequest({ capabilities: [] }))).error?.code).toBe("INVALID_INPUT");
      expect((await call(client, "resolve_model_assignment", selectionRequest({ role: "independent-audit" }))).error?.code).toBe("INVALID_INPUT");
      const unstored = await call(client, "record_model_application", { application: applicationRequest });
      expect(unstored.error?.details).toMatchObject({ routingCode: "ROUTING_STORE_UNAVAILABLE" });
      const v3Application = { ...applicationRequest, schemaVersion: "3.0.0", semanticAdviceDigest: digest };
      const listed = await client.listTools();
      const recordSchema = listed.tools.find((tool) => tool.name === "record_model_application")?.inputSchema;
      expect(JSON.stringify(recordSchema)).toContain('"applicationV3"');
      expect(JSON.stringify(recordSchema)).toContain('"semanticAdviceDigest"');
      expect((await call(client, "record_model_application", { application: v3Application })).error?.details)
        .toMatchObject({ routingCode: "ROUTING_STORE_UNAVAILABLE" });
      expect((await call(client, "record_model_application", { application: {} })).error?.code).toBe("INVALID_INPUT");
    } finally {
      await client.close();
    }
  });

  it("adds routing tables to the workflow database and degrades to catalog-only on failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "ags-routing-facade-"));
    try {
      const databasePath = join(directory, "workflow.sqlite3");
      const workflow = new SqliteWorkflowStore(databasePath);
      const version = userVersion(databasePath);
      const opened = openModelRoutingService(databasePath);
      expect(opened.service.call("resolve_model_assignment", selectionRequest()).data).toMatchObject({ status: "blocked" });
      opened.close();
      workflow.close();
      // The unchanged workflow store (as shipped before routing v2) reopens the database and ignores the new tables.
      const reopened = new SqliteWorkflowStore(databasePath);
      expect(reopened.getPluginUpdateState("agent-governance-suite")).toBeNull();
      reopened.close();
      expect(userVersion(databasePath)).toBe(version);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ags_model_%'").all() as Array<{ name: string }>).map((row) => row.name);
      const decisions = database.prepare("SELECT COUNT(*) AS count FROM ags_model_decisions_v2").get() as { count: number };
      database.close();
      expect(tables).toContain("ags_model_dispatches_v2");
      expect(decisions.count).toBe(1);
      const unavailable = openModelRoutingService(directory);
      expect(unavailable.service.call("query_model_catalog", {}).ok).toBe(true);
      expect(unavailable.service.call("record_model_application", { application: applicationRequest }).error?.details.routingCode).toBe("ROUTING_STORE_UNAVAILABLE");
      unavailable.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
