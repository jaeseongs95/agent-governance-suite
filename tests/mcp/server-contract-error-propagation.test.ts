import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { WorkflowContractError } from "../../contracts/types.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import type { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import type { WorkflowService } from "../../mcp-server/src/workflow-service.js";

function updateService(): PluginUpdateService {
  const store = new InMemoryPluginUpdateStore();
  store.putPluginUpdateState({
    targetId: "agent-governance-suite",
    currentVersion: "2.2.6",
    latestVersion: "2.2.6",
    latestTag: "v2.2.6",
    latestCommit: "a".repeat(40),
    etag: "contract-error-propagation",
    comparison: "up-to-date",
    lastAttemptAt: "2026-09-20T00:00:00.000Z",
    lastSuccessfulCheckAt: "2026-09-20T00:00:00.000Z",
    nextCheckAt: "2099-01-01T00:00:00.000Z",
    lastNotifiedVersion: null,
    lastNotifiedAt: null,
    lastErrorCode: null,
  });
  return new PluginUpdateService(store);
}

describe("MCP boundary contract error propagation", () => {
  it("keeps a service contract error code and sanitized details instead of reclassifying it as invalid input", async () => {
    const failing = {
      prepare: async () => {
        throw new WorkflowContractError("MCP_UNAVAILABLE", "Synthetic message storage is unavailable.", { reason: "SYNTHETIC_STORAGE_FAILED" });
      },
    } as unknown as SessionMessageService;
    const server = createMcpServer({} as WorkflowService, updateService(), undefined, undefined, undefined, new ContractValidator(), "default", null, null, failing);
    const client = new Client({ name: "contract-error-propagation", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const response = await client.callTool({
        name: "prepare_session_message",
        arguments: { schemaVersion: "1.0.0", targetHost: "synthetic-host", targetSessionId: "synthetic-session", body: "hello" },
      });
      const text = (response.content as Array<{ type: string; text: string }>).find((item) => item.type === "text")?.text ?? "{}";
      const parsed = JSON.parse(text);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toEqual({
        code: "MCP_UNAVAILABLE",
        message: "Synthetic message storage is unavailable.",
        details: { reason: "SYNTHETIC_STORAGE_FAILED" },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
