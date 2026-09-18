import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { resolveToolSchemaProfile } from "../../mcp-server/src/runtime-config.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { ANTHROPIC_SERVER_INSTRUCTIONS, createMcpServer, planWorkflowToolInputSchema, serverInstructions, type ToolSchemaProfile } from "../../mcp-server/src/server.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { CURRENT_VERSION } from "./version-fixtures.js";

const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const bundledServer = fileURLToPath(new URL("../../mcp-server/dist/server.mjs", import.meta.url));
const combinators = ["oneOf", "anyOf", "allOf", "not", "if", "then", "else"];

type ListedTool = { name: string; inputSchema: Record<string, unknown> };

function updateService(): PluginUpdateService {
  const store = new InMemoryPluginUpdateStore();
  store.putPluginUpdateState({
    targetId: "agent-governance-suite",
    currentVersion: CURRENT_VERSION,
    latestVersion: CURRENT_VERSION,
    latestTag: `v${CURRENT_VERSION}`,
    latestCommit: "d".repeat(40),
    etag: "tool-schema-profile",
    comparison: "up-to-date",
    lastAttemptAt: "2026-09-17T00:00:00.000Z",
    lastSuccessfulCheckAt: "2026-09-17T00:00:00.000Z",
    nextCheckAt: "2099-01-01T00:00:00.000Z",
    lastNotifiedVersion: null,
    lastNotifiedAt: null,
    lastErrorCode: null,
  });
  return new PluginUpdateService(store);
}

async function connect(profile?: ToolSchemaProfile): Promise<Client> {
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore());
  const server = profile === undefined
    ? createMcpServer(service, updateService(), undefined, undefined, undefined, validator)
    : createMcpServer(service, updateService(), undefined, undefined, undefined, validator, profile);
  const client = new Client({ name: "tool-schema-profile", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function errorCode(response: unknown): string | null {
  const content = (response as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  const text = content.find((item) => item.type === "text")?.text ?? "{}";
  return (JSON.parse(text) as { error?: { code?: string } | null }).error?.code ?? null;
}

describe("MCP tool schema profiles", () => {
  it("keeps the historical schemas when no profile is selected", async () => {
    const implicit = await connect();
    const explicit = await connect("default");
    try {
      const implicitTools = (await implicit.listTools()).tools;
      expect((await explicit.listTools()).tools).toEqual(implicitTools);
      const planning = implicitTools.find((tool) => tool.name === "plan_workflow")?.inputSchema;
      expect(planning).toEqual(planWorkflowToolInputSchema("default"));
      expect(planning).toMatchObject({ type: "object", oneOf: expect.any(Array) });
    } finally {
      await implicit.close();
      await explicit.close();
    }
  });

  it("removes top-level combinators from every advertised schema for Anthropic hosts", async () => {
    const client = await connect("anthropic");
    const fallback = await connect();
    try {
      const tools = (await client.listTools()).tools as ListedTool[];
      const defaults = (await fallback.listTools()).tools as ListedTool[];
      expect(tools.map((tool) => tool.name)).toEqual(defaults.map((tool) => tool.name));
      for (const tool of tools) {
        expect(tool.inputSchema.type, tool.name).toBe("object");
        for (const keyword of combinators) expect(tool.inputSchema, `${tool.name}.${keyword}`).not.toHaveProperty(keyword);
      }
      const planning = tools.find((tool) => tool.name === "plan_workflow")!.inputSchema;
      expect(Object.keys(planning.properties as object)).toEqual(expect.arrayContaining(["taskEnvelope", "evaluationAuditPurpose", "taskId"]));
      expect(JSON.stringify(planning)).not.toContain("executionContext");
      expect(JSON.stringify(planning)).not.toContain("$ref");
      const changed = tools.filter((tool) => JSON.stringify(tool) !== JSON.stringify(defaults.find((entry) => entry.name === tool.name)));
      expect(changed.map((tool) => tool.name)).toEqual(["plan_workflow"]);
    } finally {
      await client.close();
      await fallback.close();
    }
  });

  it("validates plan_workflow input identically in both profiles", async () => {
    const anthropic = await connect("anthropic");
    const fallback = await connect();
    const inputs: Array<Record<string, unknown>> = [
      {},
      { schemaVersion: "1.0.0" },
      { schemaVersion: "1.0.0", taskEnvelope: { schemaVersion: "1.0.0" } },
      { schemaVersion: "1.0.0", taskEnvelope: {}, unexpected: true },
      { taskId: "mixed", taskEnvelope: {} },
    ];
    try {
      for (const input of inputs) {
        const fromAnthropic = errorCode(await anthropic.callTool({ name: "plan_workflow", arguments: input }));
        const fromDefault = errorCode(await fallback.callTool({ name: "plan_workflow", arguments: input }));
        expect(fromAnthropic, JSON.stringify(input)).toBe(fromDefault);
        expect(fromAnthropic, JSON.stringify(input)).not.toBeNull();
      }
    } finally {
      await anthropic.close();
      await fallback.close();
    }
  });

  it("enables the Anthropic profile only for the exact environment value", () => {
    expect(resolveToolSchemaProfile({})).toBe("default");
    expect(resolveToolSchemaProfile({ AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE: "" })).toBe("default");
    expect(resolveToolSchemaProfile({ AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE: "Anthropic" })).toBe("default");
    expect(resolveToolSchemaProfile({ AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE: "anthropic" })).toBe("anthropic");
  });

  it("advertises intake session instructions only for Anthropic hosts", async () => {
    expect(serverInstructions()).toBeUndefined();
    expect(serverInstructions("default")).toBeUndefined();
    expect(serverInstructions("anthropic")).toBe(ANTHROPIC_SERVER_INSTRUCTIONS);
    expect(ANTHROPIC_SERVER_INSTRUCTIONS).toMatch(/실패 영향/u);
    expect(ANTHROPIC_SERVER_INSTRUCTIONS).toContain("/agent-governance-suite:orchestrator");
    const implicit = await connect();
    const codex = await connect("default");
    const claude = await connect("anthropic");
    try {
      expect(implicit.getInstructions()).toBeUndefined();
      expect(codex.getInstructions()).toBeUndefined();
      expect(claude.getInstructions()).toBe(ANTHROPIC_SERVER_INSTRUCTIONS);
    } finally {
      await implicit.close();
      await codex.close();
      await claude.close();
    }
  });

  it("applies the environment profile in the bundled server", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "tool-schema-profile-"));
    const environment = getDefaultEnvironment();
    environment.AGENT_GOVERNANCE_DB_PATH = join(stateDirectory, "workflows.sqlite3");
    environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH = join(stateDirectory, "continuity.sqlite3");
    environment.AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE = "anthropic";
    const transport = new StdioClientTransport({ command: process.execPath, args: [bundledServer], cwd: rootDirectory, env: environment, stderr: "pipe" });
    const client = new Client({ name: "tool-schema-profile-stdio", version: "1.0.0" });
    try {
      await client.connect(transport);
      const planning = (await client.listTools()).tools.find((tool) => tool.name === "plan_workflow")?.inputSchema;
      expect(planning).toBeDefined();
      expect(planning).not.toHaveProperty("oneOf");
      expect(client.getInstructions()).toBe(ANTHROPIC_SERVER_INSTRUCTIONS);
    } finally {
      try { await transport.close(); } finally { await rm(stateDirectory, { recursive: true, force: true }); }
    }
  }, 30_000);
});
