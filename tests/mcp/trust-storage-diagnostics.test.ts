import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { WorkflowContractError, type CollaborationDecisionV1 } from "../../contracts/types.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { TrustService } from "../../mcp-server/src/trust-service.js";
import { TrustStore } from "../../mcp-server/src/trust-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import type { WorkflowService } from "../../mcp-server/src/workflow-service.js";

const directories: string[] = [];
const stores: TrustStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function decision(sourceReceiptId: string): CollaborationDecisionV1 {
  return {
    schemaVersion: "1.2.0",
    sourceOriginKind: "peer",
    sourceReceiptId,
    authorityEffect: "none",
    userDirective: "unspecified",
    netBenefitCriteria: {
      independentlyCompletable: false,
      parallelBottleneckReduced: false,
      limitedContextSufficient: false,
      singleWriterOwnership: false,
      netBenefitAfterOverhead: false,
    },
    auditSeparationRequired: false,
    route: "direct",
  };
}

function updateService(): PluginUpdateService {
  const store = new InMemoryPluginUpdateStore();
  store.putPluginUpdateState({
    targetId: "agent-governance-suite",
    currentVersion: "2.2.6",
    latestVersion: "2.2.6",
    latestTag: "v2.2.6",
    latestCommit: "a".repeat(40),
    etag: "trust-storage",
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

async function brokenStore(): Promise<TrustStore> {
  const directory = await mkdtemp(join(tmpdir(), "trust-storage-"));
  directories.push(directory);
  const path = join(directory, "trust.sqlite3");
  const store = new TrustStore(path);
  stores.push(store);
  const other = new DatabaseSync(path);
  other.exec("DROP TABLE input_source_receipts;");
  other.close();
  return store;
}

describe("trust storage diagnostics", () => {
  it("keeps the native SQLite code in sanitized storage details", async () => {
    const store = await brokenStore();
    let thrown: unknown;
    try { store.getInputSource("source-abcdefghijklmnop"); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(WorkflowContractError);
    expect((thrown as WorkflowContractError).details).toMatchObject({
      storage: { reason: "TRUST_STORAGE_FAILED", nativeCode: "ERR_SQLITE_ERROR", sqliteErrcode: expect.any(Number) },
    });
  });

  it("preserves the storage diagnostic through the MCP validation boundary", async () => {
    const store = await brokenStore();
    const validator = new ContractValidator();
    const server = createMcpServer({} as WorkflowService, updateService(), undefined, undefined, undefined, validator, "default", null, null, undefined, new TrustService(store));
    const client = new Client({ name: "trust-storage", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const response = await client.callTool({
        name: "validate_collaboration_decision",
        arguments: { decision: decision("source-abcdefghijklmnop") },
      });
      const text = (response.content as Array<{ type: string; text: string }>).find((item) => item.type === "text")?.text ?? "{}";
      const parsed = JSON.parse(text);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("INVALID_INPUT");
      expect(parsed.error.details).toMatchObject({
        storage: { reason: "TRUST_STORAGE_FAILED", nativeCode: "ERR_SQLITE_ERROR", sqliteErrcode: expect.any(Number) },
      });
      expect(typeof parsed.error.details.cause).toBe("string");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
