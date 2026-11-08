import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { WorkflowContractError } from "../../contracts/types.js";
import { ACCEPT_LANGUAGE_META, CONTENT_LANGUAGE_META, msg, type SupportedLocale } from "../../mcp-server/src/i18n.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));

async function connect(defaultLocale: SupportedLocale) {
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore());
  const server = createMcpServer(service, new PluginUpdateService(new InMemoryPluginUpdateStore()), undefined, undefined,
    undefined, validator, "default", null, null, undefined, null, null, null, defaultLocale);
  const client = new Client({ name: "i18n-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    async forged(meta?: Record<string, unknown>) {
      const response = await client.callTool({ name: "get_trust_capabilities", arguments: { _hostAttestation: {} }, ...(meta ? { _meta: meta } : {}) });
      const text = (response.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      return { body: JSON.parse(text) as { error: Record<string, unknown> }, meta: response._meta };
    },
    async close() { await client.close(); await server.close(); },
  };
}

describe("server locale edge (docs/contributing/i18n.md 4.1 ②, 6)", () => {
  it("renders the top-level error in the request's SEP-2792 language and says which", async () => {
    const fixture = await connect("en");
    try {
      const korean = await fixture.forged({ [ACCEPT_LANGUAGE_META]: "ko-KR, en;q=0.5" });
      expect(korean.body.error).toMatchObject({
        code: "INVALID_INPUT", message: "호출자 신원은 호스트가 정하므로 도구 인자로 받지 않는다.",
        messageKey: "server.call.reservedCallerField", params: {}, details: { reasonCode: "RESERVED_CALLER_FIELD" },
      });
      expect(korean.meta).toEqual({ [CONTENT_LANGUAGE_META]: "ko" });
      const unnamed = await fixture.forged();
      expect(unnamed.body.error).toMatchObject({ message: "Caller identity is host-owned and is not accepted in tool arguments." });
      expect(unnamed.meta).toEqual({ [CONTENT_LANGUAGE_META]: "en" });
    } finally { await fixture.close(); }
  });

  it("uses the service default when the request names an unsupported or malformed language", async () => {
    const fixture = await connect("ko");
    try {
      for (const value of ["fr-FR", "en;q=7", 12]) {
        const response = await fixture.forged({ [ACCEPT_LANGUAGE_META]: value });
        expect(response.meta).toEqual({ [CONTENT_LANGUAGE_META]: "ko" });
      }
    } finally { await fixture.close(); }
  });
});

describe("contract errors from catalog messages", () => {
  it("keep root-locale text with the key and params, so stored bodies do not depend on the reader", () => {
    const error = new WorkflowContractError("INVALID_INPUT", msg("server.call.reservedCallerField", {}), { field: "x" });
    expect(error.message).toBe("Caller identity is host-owned and is not accepted in tool arguments.");
    expect(error.toBody()).toEqual({
      code: "INVALID_INPUT", message: "Caller identity is host-owned and is not accepted in tool arguments.",
      messageKey: "server.call.reservedCallerField", params: {}, details: { field: "x" },
    });
  });
});
