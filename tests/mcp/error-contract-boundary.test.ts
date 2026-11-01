import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { WorkflowContractError } from "../../contracts/types.js";
import { HostAttestationProvider } from "../../mcp-server/src/host-attestation.js";
import { SqliteKoreanProseGlossary, type KoreanProseGlossaryGateway } from "../../mcp-server/src/korean-prose-glossary.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import type { SkillClassificationGateway } from "../../mcp-server/src/skill-classification/gateway.js";
import { closeSessionMessaging } from "../../mcp-server/src/session-message-client.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { StateCleanupService } from "../../mcp-server/src/state-cleanup-service.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import type { CallerIngress } from "../../mcp-server/src/caller-identity.js";
import { fixedIngress, rootCaller } from "../helpers/caller.js";

// AGS 3.0 error model P1: a system failure is never relabeled INVALID_INPUT and never leaks its message.
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const SECRET = "/private/fixture-path token=FIXTURE_SECRET_SENTINEL";

type ErrorBody = { code: string; message: string; details: Record<string, unknown> | null } | null;
type Body = { ok: boolean; error: ErrorBody };
function payload(reply: unknown): Body {
  const content = (reply as { content: Array<{ type: string; text?: string }> }).content;
  return JSON.parse(content.find(item => item.type === "text")!.text!) as Body;
}

function expectServerFailure(body: { error: ErrorBody }): void {
  expect(body.error).toMatchObject({ code: "MCP_UNAVAILABLE", message: "The server could not complete the request.",
    details: { reason: "INTERNAL_FAILURE", cause: expect.objectContaining({ type: expect.any(String) }) } });
  expect(JSON.stringify(body)).not.toContain("FIXTURE_SECRET_SENTINEL");
  expect(JSON.stringify(body)).not.toContain("/private/fixture-path");
}

function workflowService(store = new InMemoryWorkflowStore()): WorkflowService {
  const validator = new ContractValidator();
  return new WorkflowService(new FileSkillRegistry(path.join(repositoryRoot, "skills", "registry.json"), validator), validator, store);
}

async function withServer(
  run: (call: (name: string, args: Record<string, unknown>) => Promise<Body>) => Promise<void>,
  options: { glossary?: KoreanProseGlossaryGateway; classification?: SkillClassificationGateway; hostAttestation?: HostAttestationProvider; ingress?: CallerIngress } = {},
): Promise<void> {
  const validator = new ContractValidator();
  const updates = new PluginUpdateService(new InMemoryPluginUpdateStore(), { fetcher: async () => { throw new Error("Unexpected network request."); } });
  const server = createMcpServer(workflowService(), updates, undefined, undefined, options.glossary, validator, "default",
    options.hostAttestation ?? null, null, undefined, null, options.classification ?? null, options.ingress ?? fixedIngress());
  const client = new Client({ name: "error-contract-boundary", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    // Every call is observed as a host root caller and reaches the tool boundary under test.
    await run(async (name, args) => payload(await client.callTool({ name, arguments: args })));
  } finally { await client.close(); await server.close(); }
}

const classificationInput = {
  schemaVersion: "1.0.0", requestId: "fixture", operationId: "fixture", originalPrompt: "fixture",
  confirmedContext: { taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null },
  contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: { vendorId: "fixture", reference: "fixture" },
  publicSynthetic: true,
};

describe("public boundary mapping (contractFailure)", () => {
  it("server failureResult: a non-contract glossary failure is MCP_UNAVAILABLE with a redacted cause", async () => {
    const glossary: KoreanProseGlossaryGateway = { lookup: () => { throw new Error(SECRET); } };
    const sourceText = "가";
    const sourceDigest = createHash("sha256").update(sourceText, "utf8").digest("hex");
    await withServer(async (call) => {
      expectServerFailure(await call("lookup_korean_prose_terms", { schemaVersion: "1.0.0", sourceText, sourceDigest }));
    }, { glossary });
  });

  it("the glossary rejects a mismatched caller digest as a contract INVALID_INPUT itself", () => {
    const glossary = new SqliteKoreanProseGlossary(":memory:");
    let caught: unknown;
    try { glossary.lookup({ schemaVersion: "1.0.0", sourceText: "가", sourceDigest: "0".repeat(64) } as never); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(WorkflowContractError);
    expect((caught as WorkflowContractError).code).toBe("INVALID_INPUT");
  });

  it("workflow-service attempt: a store TypeError is MCP_UNAVAILABLE, not INVALID_INPUT", () => {
    const store = new InMemoryWorkflowStore();
    vi.spyOn(store, "getRun").mockImplementation(() => { throw new TypeError(SECRET); });
    const result = workflowService(store).getWorkflowStatus("run-fixture");
    expect(result.ok).toBe(false);
    expectServerFailure(result);
  });

  it("state cleanup apiError: a clock failure is MCP_UNAVAILABLE, not INVALID_INPUT", () => {
    const workflow = new SqliteWorkflowStore(":memory:");
    try {
      const cleanup = new StateCleanupService(workflow, null, new ContractValidator(), () => { throw new Error(SECRET); });
      expectServerFailure(cleanup.prepare({ schemaVersion: "1.0.0" }));
    } finally { workflow.close(); }
  });

  it("caller admission: a non-contract ingress failure is MCP_UNAVAILABLE with a redacted cause", async () => {
    const ingress: CallerIngress = () => { throw new Error(SECRET); };
    await withServer(async (call) => {
      expectServerFailure(await call("get_skill_inventory", {}));
    }, { ingress });
  });

  it("session messaging: a storage failure is MCP_UNAVAILABLE with its reason and no path, a rejection keeps its message", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "error-contract-messaging-"));
    try {
      // A regular file where the state directory's parent is expected: the store cannot be opened.
      writeFileSync(path.join(directory, "not-a-directory"), "x");
      const state = path.join(directory, "state");
      const broken = new SessionMessageService(path.join(directory, "not-a-directory", "state"));
      const failed = await broken.send({ messageId: "fixture-message-id" }, rootCaller());
      expect(failed.error).toMatchObject({ code: "MCP_UNAVAILABLE", details: { reason: expect.any(String), cause: expect.any(Object) } });
      expect(failed.error?.message).toMatch(/^Session messaging could not complete the request\. Retry only the known prepared ID/u);
      expect(JSON.stringify(failed)).not.toContain(directory);
      const rejected = await new SessionMessageService(state).send({ messageId: "unknown-fixture-id" }, rootCaller());
      expect(rejected.error).toMatchObject({ code: "MCP_UNAVAILABLE", details: null });
      expect(rejected.error?.message).toMatch(/Retry only the known prepared ID/u);
    } finally {
      // The process keeps one open connection per state directory; Windows cannot remove an open database file.
      closeSessionMessaging(path.join(directory, "state"));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("unavailable state cleanup is MCP_UNAVAILABLE", async () => {
    await withServer(async (call) => {
      for (const tool of ["prepare_state_cleanup", "execute_state_cleanup"]) {
        expect((await call(tool, { schemaVersion: "1.0.0" })).error)
          .toMatchObject({ code: "MCP_UNAVAILABLE", details: { reason: "STATE_CLEANUP_UNAVAILABLE" } });
      }
    });
  });

  it("classification keeps an unavailable host observation as MCP_UNAVAILABLE (D0069)", async () => {
    let calls = 0;
    const classification: SkillClassificationGateway = { inventory: async () => null, classify: async () => { calls += 1; return null; }, accept: async () => null };
    const hostAttestation = new HostAttestationProvider({ host: "fixture", provider: "fixture-provider", modelClassForModel: () => "general" });
    vi.spyOn(hostAttestation, "run").mockImplementation(() => {
      throw new WorkflowContractError("MCP_UNAVAILABLE", "Observation store is unavailable.", { reasonCode: "OBSERVATION_STORE_UNAVAILABLE" });
    });
    await withServer(async (call) => {
      const body = await call("classify_skills", classificationInput);
      expect(body.error).toMatchObject({ code: "MCP_UNAVAILABLE",
        details: { category: "host-observation", reasonCode: "MCP_UNAVAILABLE", observationReasonCode: "OBSERVATION_STORE_UNAVAILABLE" } });
      expect(calls).toBe(0);
    }, { classification, hostAttestation });
  });

  it("classification runtime failure carries a reason and a redacted cause", async () => {
    const failing = async () => { throw new Error(SECRET); };
    await withServer(async (call) => {
      const body = await call("get_skill_inventory", {});
      expect(body.error).toMatchObject({ code: "MCP_UNAVAILABLE", details: { reason: "INTERNAL_FAILURE", cause: expect.any(Object) } });
      expect(JSON.stringify(body)).not.toContain("FIXTURE_SECRET_SENTINEL");
    }, { classification: { inventory: failing, classify: failing, accept: failing } });
  });
});
