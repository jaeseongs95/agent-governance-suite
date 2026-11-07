// AGS3-D-0025: agents reused one checkpoint_context requestId for different
// content and got REQUEST_CONFLICT, because neither the tool description nor the
// input schema said that requestId is new for each saved content. The rule must
// reach the agent through tools/list in every shipped locale; the contract's
// required fields stay as they are.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { ACCEPT_LANGUAGE_META, type SupportedLocale } from "../../mcp-server/src/i18n.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));

type ListedTool = { name: string; description?: string; inputSchema: { required?: string[]; properties?: Record<string, unknown> } };

async function listedCheckpointTool(locale: SupportedLocale): Promise<ListedTool> {
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore());
  const server = createMcpServer(service, new PluginUpdateService(new InMemoryPluginUpdateStore()), undefined, undefined,
    undefined, validator, "default", null, null, undefined, null, null, null, locale);
  const client = new Client({ name: "ags3-d0025-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools({ _meta: { [ACCEPT_LANGUAGE_META]: locale } });
    const tool = (listed.tools as ListedTool[]).find((candidate) => candidate.name === "checkpoint_context");
    if (!tool) throw new Error("checkpoint_context is not listed");
    return tool;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("AGS3-D-0025 checkpoint_context requestId rule in tools/list", () => {
  it.each([
    ["ko", [
      "바뀐 내용에는 새 requestId를 쓰고, 응답 불명을 포함한 동일 payload 재송신은 같은 ID를 유지한다.",
      "REQUEST_CONFLICT를 ID만 바꿔 회피하지 않는다.",
    ]],
    ["en", [
      "New requestId for changed content.",
      "Keep ID for identical retries, including unknown responses.",
      "Never bypass REQUEST_CONFLICT by changing ID.",
    ]],
  ] as const)("the %s description says a requestId is new for each saved content", async (locale, phrases) => {
    const tool = await listedCheckpointTool(locale);
    for (const phrase of phrases) expect(tool.description).toContain(phrase);
  });

  it("keeps the contract's required fields", async () => {
    const tool = await listedCheckpointTool("en");
    expect(tool.inputSchema.required).toEqual(["schemaVersion", "requestId", "expectedStateToken", "status", "core", "evidenceRefs"]);
    expect(tool.inputSchema.properties).toHaveProperty("requestId");
  });
});
