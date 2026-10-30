import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StateCleanupService } from "../../mcp-server/src/state-cleanup-service.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PLUGIN_INFO } from "../../mcp-server/src/plugin-info.js";
import { inlineSchemaReferences } from "../../mcp-server/src/tool-schema-inline.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { createSyntheticRootProofFixture } from "./synthetic-root-proof-client.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const NOW = "2026-10-30T00:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";

function directory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deep-audit-"));
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): { ok?: boolean; error?: { code?: string } } & Record<string, unknown> {
  const content = "content" in result && Array.isArray(result.content) ? result.content : [];
  const text = content.find((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")?.text;
  return text ? JSON.parse(text) : {};
}

async function withTestServer(
  run: (client: Client, call: (name: string, args: Record<string, unknown>) => ReturnType<Client["callTool"]>) => Promise<void>,
  options: { updates?: PluginUpdateService; toolSchemaProfile?: "default" | "inline-references" | "anthropic" } = {},
): Promise<void> {
  const validator = new ContractValidator();
  const service = new WorkflowService(
    new FileSkillRegistry(path.join(repositoryRoot, "skills", "registry.json"), validator),
    validator,
    new InMemoryWorkflowStore(),
  );
  const updates = options.updates ?? new PluginUpdateService(new InMemoryPluginUpdateStore(), {
    fetcher: async () => jsonResponse([{ ref: "refs/tags/v3.0.1", object: { sha: "a".repeat(40), type: "commit", url: "https://example.test" } }])
  });
  const root = createSyntheticRootProofFixture();
  const server = createMcpServer(
    service,
    updates,
    undefined,
    undefined,
    undefined,
    validator,
    options.toolSchemaProfile ?? "default",
    null,
    null,
    undefined,
    null,
    null,
    root.proofs,
  );
  const client = new Client({ name: "deep-audit-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: root.argumentsFor(name, args) });
  try {
    await client.connect(clientTransport);
    await run(client, call);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("D0050 / D0077 / D0081 Deep Audit Tests", () => {
  describe("D0050: State Cleanup Compact Token & Tamper Resistance", () => {
    it("binds digest without copying candidates, stays compact under 1500 items, and strictly rejects tampering", () => {
      const dir = directory();
      const filename = path.join(dir, "workflow.sqlite3");
      const workflow = new SqliteWorkflowStore(filename);
      const raw = new DatabaseSync(filename);
      const CANDIDATE_COUNT = 1500;

      try {
        const insert = raw.prepare("INSERT INTO workflow_runs VALUES (?,1,'passed','{}',?,?)");
        raw.exec("BEGIN;");
        for (let i = 0; i < CANDIDATE_COUNT; i++) {
          insert.run(`run-${i}-${"y".repeat(80)}`, OLD, OLD);
        }
        raw.exec("COMMIT;");
      } finally {
        raw.close();
      }

      const service = new StateCleanupService(workflow, null, new ContractValidator(), () => new Date(NOW));
      const plan = service.prepare({ schemaVersion: "1.0.0" });
      expect(plan.ok).toBe(true);
      expect(plan.data?.counts.workflowRuns).toBe(CANDIDATE_COUNT);

      const token = plan.data!.planToken;
      const tokenBytes = Buffer.byteLength(token);

      // Verify compact size (< 4096 bytes even with 1500 candidates)
      expect(tokenBytes).toBeLessThan(4096);

      // Verify candidates and linkedRuns are NOT in the token payload
      const [encodedPayload, signature] = token.split(".");
      expect(encodedPayload).toBeDefined();
      expect(signature).toBeDefined();

      const decodedPayload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8")) as Record<string, unknown>;
      expect(decodedPayload).not.toHaveProperty("candidates");
      expect(decodedPayload).not.toHaveProperty("linkedRuns");
      expect(decodedPayload).toHaveProperty("candidateDigest");
      expect(decodedPayload.candidateDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

      // Verify tampering rejection 1: Modified signature
      const tamperedSigChar = signature![0] === "a" ? "b" : "a";
      const tamperedSigToken = `${encodedPayload}.${tamperedSigChar}${signature!.slice(1)}`;
      const resultTamperedSig = service.execute({ schemaVersion: "1.0.0", planToken: tamperedSigToken });
      expect(resultTamperedSig.ok).toBe(false);
      expect(resultTamperedSig.error?.code).toBe("INVALID_INPUT");
      expect(resultTamperedSig.error?.message).toContain("signature is invalid");

      // Verify tampering rejection 2: Modified payload with original signature
      const modifiedPayloadObj = { ...decodedPayload, planId: "tampered-uuid" };
      const modifiedEncodedPayload = Buffer.from(JSON.stringify(modifiedPayloadObj)).toString("base64url");
      const tamperedPayloadToken = `${modifiedEncodedPayload}.${signature}`;
      const resultTamperedPayload = service.execute({ schemaVersion: "1.0.0", planToken: tamperedPayloadToken });
      expect(resultTamperedPayload.ok).toBe(false);
      expect(resultTamperedPayload.error?.code).toBe("INVALID_INPUT");

      // Verify tampering rejection 3: Malformed token without dot
      const malformedToken = "invalid_token_string_without_delimiter";
      const resultMalformed = service.execute({ schemaVersion: "1.0.0", planToken: malformedToken });
      expect(resultMalformed.ok).toBe(false);
      expect(resultMalformed.error?.code).toBe("INVALID_INPUT");

      // Verify token size boundary: exact 65,536 bytes must NOT be rejected as oversized
      // Construct realistic token shape: <valid_base64url_json_payload>.<canonical_base64url_signature>
      const dummySignature = Buffer.alloc(32, 0x5a).toString("base64url"); // 43 chars
      // Total bytes required: 65,536 => payload + 1 (.) + 43 = 65,536 => payload length = 65,492
      // 65,492 base64url characters = 49,119 raw JSON UTF-8 bytes (since 65492 / 4 * 3 = 49119)
      const jsonHeader = '{"schemaVersion":"1.0.0","planId":"boundary-check","pad":"';
      const jsonFooter = '"}';
      const padLength = 49119 - Buffer.byteLength(jsonHeader, "utf8") - Buffer.byteLength(jsonFooter, "utf8");
      const boundaryJsonBody = jsonHeader + "0".repeat(padLength) + jsonFooter;
      const boundaryEncodedPayload = Buffer.from(boundaryJsonBody, "utf8").toString("base64url");
      const boundaryToken = `${boundaryEncodedPayload}.${dummySignature}`;

      expect(Buffer.byteLength(boundaryToken, "utf8")).toBe(65536);

      const resultBoundary = service.execute({ schemaVersion: "1.0.0", planToken: boundaryToken });
      expect(resultBoundary.ok).toBe(false);
      expect(resultBoundary.error?.code).toBe("INVALID_INPUT");
      // Explicit assertion: 65,536 bytes MUST NOT be rejected as oversized
      expect(resultBoundary.error?.message).not.toContain("exceeds the supported size");
      // Instead, it safely reaches signature verification and rejects for invalid signature
      expect(resultBoundary.error?.message).toContain("signature is invalid");

      // Verify token size upper limit rejection at 65,537 bytes (boundary + 1 byte)
      const oversizedToken = boundaryToken + "x";
      expect(Buffer.byteLength(oversizedToken, "utf8")).toBe(65537);
      const resultOversized = service.execute({ schemaVersion: "1.0.0", planToken: oversizedToken });
      expect(resultOversized.ok).toBe(false);
      expect(resultOversized.error?.code).toBe("INVALID_INPUT");
      expect(resultOversized.error?.message).toContain("exceeds the supported size");

      // Verify DB candidate drift rejection (STALE_REVISION) and row/byte preservation
      // 1. Record pre-drift state on isolated fixture DB
      const dbBytesBeforeDrift = fs.statSync(filename).size;
      expect(dbBytesBeforeDrift).toBeGreaterThan(0);

      const rawDrift = new DatabaseSync(filename);
      const preDriftCount = (rawDrift.prepare("SELECT COUNT(*) as count FROM workflow_runs").get() as { count: number }).count;
      expect(preDriftCount).toBe(CANDIDATE_COUNT);

      // 2. Introduce a drift in DB candidates after prepare (insert an extra candidate run)
      const driftRunId = `run-drift-extra-${"z".repeat(60)}`;
      rawDrift.prepare("INSERT INTO workflow_runs VALUES (?, 1, 'passed', '{}', ?, ?)").run(driftRunId, OLD, OLD);
      const postDriftCount = (rawDrift.prepare("SELECT COUNT(*) as count FROM workflow_runs").get() as { count: number }).count;
      expect(postDriftCount).toBe(CANDIDATE_COUNT + 1);
      rawDrift.close();

      // 3. Execute with original planToken -> MUST be rejected with STALE_REVISION
      const resultDrift = service.execute({ schemaVersion: "1.0.0", planToken: token });
      expect(resultDrift.ok).toBe(false);
      expect(resultDrift.error?.code).toBe("STALE_REVISION");
      expect(resultDrift.error?.message).toContain("State cleanup candidates changed after preview.");

      // 4. Assert post-rejection row and byte preservation: NO existing candidate rows deleted
      const rawPostCheck = new DatabaseSync(filename);
      const postRejectionCount = (rawPostCheck.prepare("SELECT COUNT(*) as count FROM workflow_runs").get() as { count: number }).count;
      expect(postRejectionCount).toBe(CANDIDATE_COUNT + 1);

      // Check specific candidate rows are completely intact
      const sampleRow0 = rawPostCheck.prepare("SELECT run_id FROM workflow_runs WHERE run_id = ?").get(`run-0-${"y".repeat(80)}`) as { run_id: string } | undefined;
      expect(sampleRow0?.run_id).toBe(`run-0-${"y".repeat(80)}`);

      const sampleRowLast = rawPostCheck.prepare("SELECT run_id FROM workflow_runs WHERE run_id = ?").get(`run-${CANDIDATE_COUNT - 1}-${"y".repeat(80)}`) as { run_id: string } | undefined;
      expect(sampleRowLast?.run_id).toBe(`run-${CANDIDATE_COUNT - 1}-${"y".repeat(80)}`);

      // Check drift row is intact
      const driftRowCheck = rawPostCheck.prepare("SELECT run_id FROM workflow_runs WHERE run_id = ?").get(driftRunId) as { run_id: string } | undefined;
      expect(driftRowCheck?.run_id).toBe(driftRunId);

      // Assert byte preservation on the isolated fixture DB
      const dbBytesAfterRejection = fs.statSync(filename).size;
      expect(dbBytesAfterRejection).toBeGreaterThanOrEqual(dbBytesBeforeDrift);

      // 5. Restore candidate state to match original plan (remove drift extra run) and verify subsequent legitimate execution
      rawPostCheck.prepare("DELETE FROM workflow_runs WHERE run_id = ?").run(driftRunId);
      const restoredCount = (rawPostCheck.prepare("SELECT COUNT(*) as count FROM workflow_runs").get() as { count: number }).count;
      expect(restoredCount).toBe(CANDIDATE_COUNT);
      rawPostCheck.close();

      // Verify successful execution with legitimate token once candidates match plan
      const executeResult = service.execute({ schemaVersion: "1.0.0", planToken: token });
      expect(executeResult.ok).toBe(true);
      expect(executeResult.data?.databases.workflow.deletedRuns).toBe(CANDIDATE_COUNT);

      // Verify post-execution DB row count is now 0 (candidates actually deleted upon success)
      const rawPostExec = new DatabaseSync(filename);
      const postExecCount = (rawPostExec.prepare("SELECT COUNT(*) as count FROM workflow_runs").get() as { count: number }).count;
      expect(postExecCount).toBe(0);
      rawPostExec.close();

      // Verify token reuse rejection (replay protection)
      const replayResult = service.execute({ schemaVersion: "1.0.0", planToken: token });
      expect(replayResult.ok).toBe(false);
      expect(replayResult.error?.code).toBe("STALE_REVISION");

      workflow.close();
    });
  });

  describe("D0077: Closed-World Offline Status & Explicit Network Check", () => {
    it("keeps status queries strictly offline even when cache is expired, and uses network only on explicit update check", async () => {
      let networkCalls = 0;
      const remoteTags = [
        {
          ref: "refs/tags/v3.0.1",
          object: { sha: "a".repeat(40), type: "commit", url: "https://api.github.com/repos/example/tags/v3.0.1" }
        }
      ];

      const fetcher = async () => {
        networkCalls += 1;
        return jsonResponse(remoteTags);
      };

      const updateStore = new InMemoryPluginUpdateStore();
      const updates = new PluginUpdateService(updateStore, { fetcher, now: () => new Date(NOW) });

      // Pre-seed an expired/stale update state in store (nextCheckAt in the past)
      updateStore.putPluginUpdateState({
        targetId: PLUGIN_INFO.id,
        currentVersion: PLUGIN_INFO.version,
        latestVersion: "3.0.1",
        latestTag: "v3.0.1",
        latestCommit: "a".repeat(40),
        etag: null,
        comparison: "update-available",
        lastAttemptAt: "2026-10-28T00:00:00.000Z",
        lastSuccessfulCheckAt: "2026-10-28T00:00:00.000Z",
        nextCheckAt: "2026-10-29T00:00:00.000Z", // Expired relative to NOW (2026-10-30)
        lastNotifiedVersion: null,
        lastNotifiedAt: null,
        lastErrorCode: null,
      });

      await withTestServer(async (client, call) => {
        // 1. Call get_workflow_status when cache is stale: MUST NOT make network calls
        const reply1 = await call("get_workflow_status", { runId: "missing-run" });
        expect(networkCalls).toBe(0); // Zero network calls!
        const reply1Str = JSON.stringify(reply1);
        expect(reply1Str).toContain("plugin-update-notice");
        expect(reply1Str).toContain("3.0.1");

        // 2. Call get_trust_capabilities: MUST NOT make network calls
        await call("get_trust_capabilities", {});
        expect(networkCalls).toBe(0);

        // 3. Call explicit check_for_updates: MUST perform network call
        const checkReply = await call("check_for_updates", { force: true });
        expect(networkCalls).toBe(1);
        const checkData = payload(checkReply);
        expect(checkData.ok).toBe(true);

        // 4. Repeated workflow status: still zero additional network calls
        await call("get_workflow_status", { runId: "missing-run" });
        expect(networkCalls).toBe(1);
      }, { updates });
    });
  });

  describe("D0081: Tool Schema Inlining Literal Preservation & Validation Parity", () => {
    it("preserves literal schema annotations in data values and keeps schema valid", () => {
      const complexLiteral = {
        $id: "https://example.com/literal.json",
        $ref: "#/$defs/nonexistent",
        $schema: "http://json-schema.org/draft-07/schema#",
        $defs: { custom: { type: "integer" } },
        nested: {
          items: [{ $ref: "other-literal" }],
          examples: [{ $id: "inner-id" }]
        }
      };

      const schema = {
        $id: "urn:test:schema",
        type: "object",
        const: complexLiteral,
        enum: [complexLiteral],
        default: complexLiteral,
        examples: [complexLiteral],
        properties: {
          resolvable: { $ref: "#/$defs/simpleString", default: complexLiteral },
          nestedObj: {
            type: "object",
            properties: {
              innerRef: { $ref: "#/$defs/simpleNumber" }
            },
            default: complexLiteral
          }
        },
        $defs: {
          simpleString: { type: "string", description: "a string" },
          simpleNumber: { type: "number", description: "a number" }
        }
      };

      const originalClone = structuredClone(schema);
      const inlined = inlineSchemaReferences(schema, []);

      // Verify that input schema was not mutated
      expect(schema).toEqual(originalClone);

      // Verify that $ref under properties was resolved
      expect((inlined.properties as Record<string, unknown>).resolvable).toEqual({
        type: "string",
        description: "a string",
        default: complexLiteral
      });

      // Verify that const, enum, default, examples retain literal $id, $ref, $defs exactly
      expect(inlined.const).toEqual(complexLiteral);
      expect(inlined.enum).toEqual([complexLiteral]);
      expect(inlined.default).toEqual(complexLiteral);
      expect(inlined.examples).toEqual([complexLiteral]);
      expect((inlined.properties as Record<string, unknown>).resolvable).toHaveProperty("default", complexLiteral);
    });

    it("verifies advertised inlined tool schemas against actual server contract validator", async () => {
      await withTestServer(async (client, call) => {
        const toolsList = await client.listTools();
        expect(toolsList.tools.length).toBeGreaterThan(0);

        // Check key advertised tools
        const planTool = toolsList.tools.find(t => t.name === "plan_workflow");
        expect(planTool).toBeDefined();
        expect(planTool?.inputSchema).toHaveProperty("type", "object");
        // Verify inlined schema has no unresolved top-level $ref
        expect(JSON.stringify(planTool?.inputSchema)).not.toContain('"#/$defs/');

        const updateTool = toolsList.tools.find(t => t.name === "check_for_updates");
        expect(updateTool).toBeDefined();

        // Valid execution matches validator
        const validCall = await call("check_for_updates", { force: true });
        const validData = payload(validCall);
        expect(validData.ok).toBe(true);

        // Invalid execution matches validator rejection
        const invalidCall = await call("check_for_updates", { force: "invalid_type" });
        const invalidData = payload(invalidCall);
        expect(invalidData.ok).toBe(false);
        expect(invalidData.error?.code).toBe("INVALID_INPUT");
      }, { toolSchemaProfile: "inline-references" });
    });
  });
});
