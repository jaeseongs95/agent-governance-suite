// AGS3-D-0025: agents reused one checkpoint_context requestId for different
// content and got REQUEST_CONFLICT, because neither the tool description nor the
// input schema said that requestId is new for each saved content. The rule must
// reach the agent through tools/list (4.0.0: always in MODEL_LOCALE, en; the ko
// catalog keeps the translation); the contract's required fields stay as they are.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { render } from "../../mcp-server/src/i18n.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));

type ListedTool = { name: string; description?: string; inputSchema: { required?: string[]; properties?: Record<string, unknown> } };

// 4.0.0: tools/list is rendered in MODEL_LOCALE (en) and ignores the SEP-2792 request language it used to honor.
const ACCEPT_LANGUAGE_META = "io.modelcontextprotocol/acceptLanguage";

async function listedCheckpointTool(language?: string): Promise<ListedTool> {
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore());
  const server = createMcpServer(service, new PluginUpdateService(new InMemoryPluginUpdateStore()), undefined, undefined,
    undefined, validator, "default", null, null, undefined, null, null, null);
  const client = new Client({ name: "ags3-d0025-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools(language ? { _meta: { [ACCEPT_LANGUAGE_META]: language } } : undefined);
    const tool = (listed.tools as ListedTool[]).find((candidate) => candidate.name === "checkpoint_context");
    if (!tool) throw new Error("checkpoint_context is not listed");
    return tool;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("AGS3-D-0025 checkpoint_context requestId rule in tools/list", () => {
  // 3.9.0 (AGS3-D-0053) shortened the en description; the requestId rule is unchanged.
  const EN = [
    "Changed content: new requestId; identical retries, even unknown responses: same ID;",
    "never bypass REQUEST_CONFLICT by changing ID.",
    "If body/token absent, load_context; echo stateToken as expectedStateToken.",
  ];
  it.each([[undefined], ["ko"], ["en"]] as const)("the listed description says a requestId is new for each saved content (requested language %s)", async (language) => {
    const tool = await listedCheckpointTool(language);
    for (const phrase of EN) expect(tool.description).toContain(phrase);
    expect(tool.description).not.toMatch(/[가-힣]/u);
  });

  it("keeps the same rule in the ko catalog (translation material)", () => {
    const text = render({ key: "tools.checkpoint_context.description", params: {} }, "ko");
    for (const phrase of [
      "내용 변경에는 새 requestId, 응답 불명을 포함한 동일 payload 재송신에는 같은 ID를 쓴다.",
      "REQUEST_CONFLICT를 ID만 바꿔 회피하지 않는다.",
      "현재 본문·토큰이 없으면 load_context로 읽고 stateToken을 expectedStateToken에 그대로 넣는다.",
    ]) expect(text).toContain(phrase);
  });

  it("keeps the contract's required fields", async () => {
    const tool = await listedCheckpointTool();
    expect(tool.inputSchema.required).toEqual(["schemaVersion", "requestId", "expectedStateToken", "status", "core", "evidenceRefs"]);
    expect(tool.inputSchema.properties).toHaveProperty("requestId");
  });
});
