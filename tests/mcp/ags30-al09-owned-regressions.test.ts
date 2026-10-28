import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HostAttestationProvider } from "../../mcp-server/src/host-attestation.js";
import { PLUGIN_INFO } from "../../mcp-server/src/plugin-info.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { resolveToolSchemaProfile } from "../../mcp-server/src/runtime-config.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer, planWorkflowToolInputSchema } from "../../mcp-server/src/server.js";
import type { SkillClassificationGateway } from "../../mcp-server/src/skill-classification/gateway.js";
import { inlineSchemaReferences } from "../../mcp-server/src/tool-schema-inline.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import {
  computeDirectoryChecksum, computeKoreanProseToolchainDigest, digestCanonical, digestRaw,
  evaluateKoreanProseReadiness, REQUIRED_KOREAN_PROSE_THRESHOLDS,
} from "../../scripts/korean-prose-readiness.js";
import { NEXT_TAG, NEXT_VERSION } from "./version-fixtures.js";
import { createSyntheticRootProofFixture } from "./synthetic-root-proof-client.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const tagObjectUrl = `${PLUGIN_INFO.tagsApi.split("/git/matching-refs/")[0]}/git/tags/${"b".repeat(40)}`;
const stableReference = { ref: `refs/tags/${NEXT_TAG}`, object: { type: "commit", sha: "a".repeat(40), url: "https://example.test/commit" } };
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value));

function payload(reply: unknown): { ok: boolean; error: { code: string; message: string; details: Record<string, unknown> | null } | null } {
  const content = (reply as { content: Array<{ type: string; text?: string }> }).content;
  return JSON.parse(content.find(item => item.type === "text")!.text!) as ReturnType<typeof payload>;
}

async function withServer(
  run: (client: Client, call: (name: string, args: Record<string, unknown>) => ReturnType<Client["callTool"]>) => Promise<void>,
  options: { updates?: PluginUpdateService; classification?: SkillClassificationGateway; hostAttestation?: HostAttestationProvider } = {},
): Promise<void> {
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(path.join(repositoryRoot, "skills", "registry.json"), validator), validator, new InMemoryWorkflowStore());
  const updates = options.updates ?? new PluginUpdateService(new InMemoryPluginUpdateStore(), { fetcher: async () => { throw new Error("Unexpected network request."); } });
  const root = createSyntheticRootProofFixture();
  const server = createMcpServer(service, updates, undefined, undefined, undefined, validator, "default", options.hostAttestation, null, undefined, null, options.classification, root.proofs);
  const client = new Client({ name: "al09-owned-regressions", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  // Explicit signed calls reach domain validation; raw client calls remain available for ingress negatives.
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: root.argumentsFor(name, args) });
  try { await client.connect(clientTransport); await run(client, call); }
  finally { await client.close(); await server.close(); }
}

describe("AL09 server boundary regressions", () => {
  it("D0069 separates malformed caller input from unavailable configuration", async () => {
    let calls = 0;
    const unavailable = async () => { calls += 1; throw new Error("PRIVATE_CONFIGURATION_PATH"); };
    await withServer(async (_client, call) => {
      expect(payload(await call("classify_skills", {})).error?.code).toBe("INVALID_INPUT");
      expect(payload(await call("get_skill_inventory", { unexpected: true })).error?.code).toBe("INVALID_INPUT");
      expect(calls).toBe(0);
      const reply = await call("get_skill_inventory", {});
      expect(payload(reply).error?.code).toBe("MCP_UNAVAILABLE");
      expect(JSON.stringify(reply)).not.toContain("PRIVATE_CONFIGURATION_PATH");
      expect(calls).toBe(1);
    }, { classification: { inventory: unavailable, classify: unavailable, accept: unavailable } });
  });

  it("D0069 preserves typed observation failures instead of relabeling them", async () => {
    let calls = 0;
    const classification: SkillClassificationGateway = {
      inventory: async () => null,
      classify: async () => { calls += 1; return null; }, accept: async () => null,
    };
    const hostAttestation = new HostAttestationProvider(new InMemoryWorkflowStore(), { host: "fixture", provider: "fixture-provider", modelClassForModel: () => "general" });
    await withServer(async (_client, call) => {
      const reply = await call("classify_skills", {
        schemaVersion: "1.0.0", requestId: "fixture", operationId: "fixture", originalPrompt: "fixture",
        confirmedContext: { taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null },
        contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: { vendorId: "fixture", reference: "fixture" },
        publicSynthetic: true, _hostAttestation: "malformed",
      });
      expect(payload(reply).error?.code).toBe("INVALID_INPUT");
      expect(payload(reply).error?.details).toMatchObject({ category: "host-observation", reasonCode: "BINDING_INVALID" });
      expect(calls).toBe(0);
    }, { classification, hostAttestation });
  });

  it("D0069 keeps existing request-state rejection codes and supplies a safe reason", async () => {
    await withServer(async (_client, call) => {
      const reply = await call("get_skill_inventory", {});
      expect(payload(reply).error?.code).toBe("INVALID_INPUT");
      expect(payload(reply).error?.details).toMatchObject({ category: "request-state", reasonCode: "OPERATION_DIGEST_CONFLICT" });
    }, { classification: { inventory: async () => { throw new Error("OPERATION_DIGEST_CONFLICT"); }, classify: async () => null, accept: async () => null } });
  });

  it("D0077 keeps closed-world calls offline and still serves cached advisory notices", async () => {
    let fetches = 0;
    const updates = new PluginUpdateService(new InMemoryPluginUpdateStore(), { fetcher: async () => { fetches += 1; return jsonResponse([stableReference]); } });
    await withServer(async (_client, call) => {
      await call("get_workflow_status", { runId: "missing" });
      expect(fetches).toBe(0);
      await updates.check(true);
      const reply = await call("get_workflow_status", { runId: "missing" });
      expect(fetches).toBe(1);
      expect(JSON.stringify(reply)).toContain("plugin-update-notice");
      await call("check_for_updates", { force: true });
      expect(fetches).toBe(2);
    }, { updates });
  });

  it("D0078 preserves structured contract validation causes", async () => {
    await withServer(async (_client, call) => {
      const result = payload(await call("lookup_korean_prose_terms", {}));
      expect(result.error?.code).toBe("INVALID_INPUT");
      expect(result.error?.details?.validationErrors).toEqual(expect.any(String));
      expect(result.error?.details?.validationErrors).toContain("sourceDigest");
      const rejected = await call("prepare_session_message", {
        schemaVersion: "1.0.0", targetHost: "fixture", targetSessionId: "fixture", body: "PRIVATE_MESSAGE_BODY", ttlSeconds: 10,
      });
      expect(payload(rejected).error?.details?.validationErrors).toContain("/ttlSeconds must be >= 30");
      expect(JSON.stringify(rejected)).not.toContain("PRIVATE_MESSAGE_BODY");
    });
  });

  it("D0079 supports a normalized host-neutral profile and the historical alias", () => {
    expect(resolveToolSchemaProfile({ AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE: " InLiNe-ReFeRenCes " })).toBe("inline-references");
    expect(resolveToolSchemaProfile({ AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE: "anthropic" })).toBe("anthropic");
    expect(resolveToolSchemaProfile({ AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE: "Anthropic" })).toBe("default");
    expect(resolveToolSchemaProfile({ AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE: "unknown" })).toBe("default");
    expect(planWorkflowToolInputSchema("inline-references")).toEqual(planWorkflowToolInputSchema("anthropic"));
  });

  it("D0017 refuses a missing binding without claiming that the hook did not run", async () => {
    await withServer(async client => {
      const result = payload(await client.callTool({ name: "update_session_status", arguments: { schemaVersion: "1.0.0", summary: "fixture" } }));
      expect(result.error?.code).toBe("BINDING_REQUIRED");
      expect(result.error?.details).toMatchObject({ reasonCode: "ROOT_HOOK_PROOF_REQUIRED" });
      expect(result.error?.message).toContain("current root hook proof");
      expect(result.error?.message).not.toContain("did not run");
    });
  });

  it("D0080 advertises the actual unguarded-start rejection", async () => {
    await withServer(async (client, call) => {
      const tools = (await client.listTools()).tools;
      expect(tools.find(tool => tool.name === "start_workflow")?.description).toContain("Reject unguarded");
      expect(payload(await call("start_workflow", {})).error?.code).toBe("INVALID_INPUT");
    });
  });
});

it("D0081 resolves schema positions while preserving literal annotation and assertion data", () => {
  const literal = { $id: "literal", $ref: "missing-data.json", $defs: { title: "data" }, nested: { $schema: "data" } };
  const schema = {
    type: "object", const: literal, enum: [literal], default: literal, examples: [literal],
    properties: { value: { $ref: "#/$defs/text", default: literal } },
    $defs: { text: { type: "string" } },
  };
  const original = structuredClone(schema);
  expect(inlineSchemaReferences(schema, [])).toEqual({
    type: "object", const: literal, enum: [literal], default: literal, examples: [literal],
    properties: { value: { type: "string", default: literal } },
  });
  expect(schema).toEqual(original);
});

describe("AL09 update response regressions", () => {
  it.each(["references", "tag-object"] as const)("D0082 distinguishes %s stream failures from malformed JSON", async boundary => {
    for (const mode of ["stream", "json", "abort"] as const) {
      const response = () => mode === "json" ? new Response("{") : new Response(new ReadableStream({
        start(controller) { controller.error(mode === "abort" ? new DOMException("aborted", "AbortError") : new TypeError("stream failed")); },
      }));
      const service = new PluginUpdateService(new InMemoryPluginUpdateStore(), { fetcher: async input => boundary === "references" || input === tagObjectUrl
        ? response() : jsonResponse([{ ...stableReference, object: { type: "tag", sha: "b".repeat(40), url: tagObjectUrl } }]) });
      expect((await service.check()).lastErrorCode).toBe(mode === "stream" ? "NETWORK" : mode === "abort" ? "TIMEOUT" : "INVALID_RESPONSE");
    }
  });

  it("D0083 enforces the streamed byte boundary, including when Content-Length is absent", async () => {
    const json = JSON.stringify([stableReference]);
    for (const extra of [0, 1]) {
      let cancelled = false;
      let sent = false;
      const body = new TextEncoder().encode(json + " ".repeat(1024 * 1024 - json.length + extra));
      const service = new PluginUpdateService(new InMemoryPluginUpdateStore(), { fetcher: async () => new Response(new ReadableStream({
        pull(controller) { if (sent) { if (extra === 0) controller.close(); } else { sent = true; controller.enqueue(body); } },
        cancel() { cancelled = true; },
      })) });
      const status = await service.check();
      expect(status.lastErrorCode).toBe(extra === 0 ? null : "INVALID_RESPONSE");
      if (extra === 1) expect(cancelled).toBe(true);
    }
  });

  it("D0083 bounds tag item count independently of byte count", async () => {
    for (const count of [10_000, 10_001]) {
      const body: unknown[] = Array.from({ length: count }, () => null);
      body[0] = stableReference;
      const service = new PluginUpdateService(new InMemoryPluginUpdateStore(), { fetcher: async () => jsonResponse(body) });
      expect((await service.check()).lastErrorCode).toBe(count === 10_000 ? null : "INVALID_RESPONSE");
    }
  });

  it("D0083 applies the byte limit to annotated tag objects too", async () => {
    const service = new PluginUpdateService(new InMemoryPluginUpdateStore(), { fetcher: async input => input === tagObjectUrl
      ? new Response(" ".repeat(1024 * 1024 + 1))
      : jsonResponse([{ ...stableReference, object: { type: "tag", sha: "b".repeat(40), url: tagObjectUrl } }]) });
    expect((await service.check()).lastErrorCode).toBe("INVALID_RESPONSE");
  });

  it("D0084 ignores unsafe-integer tag candidates without losing a valid stable tag", async () => {
    const service = new PluginUpdateService(new InMemoryPluginUpdateStore(), { fetcher: async () => jsonResponse([
      { ...stableReference, ref: "refs/tags/v9007199254740992.0.0" }, stableReference,
    ]) });
    expect(await service.check()).toMatchObject({ latestVersion: NEXT_VERSION, lastErrorCode: null });
  });
});

it("D0147 accepts reordered strata keys but rejects a changed count with valid self-digests", async () => {
  const cycle = await mkdtemp(path.join(tmpdir(), "ags-al09-strata-"));
  try {
    const records = [{ id: "legacy", sourceText: "legacy" }, { id: "holdout", sourceText: "holdout" }];
    const labels = [{ id: "legacy", suite: "legacy-100", expectedDecision: "edit" }, { id: "holdout", suite: "holdout-30", expectedDecision: "retain" }];
    const suiteRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
    const checksum = await computeDirectoryChecksum(path.join(repositoryRoot, "skills", "korean-prose-editor"));
    const validityEvidence = "fixture validity evidence\n";
    const prior = [{ frameId: "0.1.0-rc1", disposition: "invalid-corpus" }, { frameId: "0.1.0-rc2", disposition: "failed-recovery" }].map(item => ({
      ...item, evidenceLocator: `${item.frameId}.json`, bytes: `${JSON.stringify({ schemaVersion: "1.0.0", ...item, status: "terminal" })}\n`,
    }));
    const framePayload = {
      schemaVersion: "1.0.0", frameId: "al09-strata", status: "frozen", createdAt: "2026-09-13T00:00:00.000Z",
      candidate: { suiteRevision, skillSourceCommit: suiteRevision, skillSourceChecksum: checksum, integratedSkillChecksum: checksum, toolchainDigest: await computeKoreanProseToolchainDigest(repositoryRoot) },
      corpus: { caseCount: 2, inputDigest: digestCanonical(records), orderedCaseIdsDigest: digestCanonical(["legacy", "holdout"]), labelsLocator: "quality-labels.jsonl", labelsDigest: digestCanonical(labels), visibility: "mixed-gate", strata: { legacyCount: 1, holdoutCount: 1 } },
      controls: { rubricLocator: "verification-rubric.md", rubricDigest: digestRaw("fixture rubric\n"), thresholdsDigest: digestCanonical(REQUIRED_KOREAN_PROSE_THRESHOLDS), corpusValidityEvidenceDigest: digestRaw(validityEvidence) },
      runBudget: 1, aggregation: "all-runs-complete", thresholds: REQUIRED_KOREAN_PROSE_THRESHOLDS,
      priorFrames: prior.map(({ bytes, ...item }) => ({ ...item, evidenceDigest: digestRaw(bytes) })), executionMetadataSchemaVersion: "3.0.0",
    };
    const frame = { ...framePayload, frameDigest: digestCanonical(framePayload) };
    const validityPayload = {
      schemaVersion: "1.0.0", frameId: frame.frameId, frameDigest: frame.frameDigest, corpusDigest: frame.corpus.inputDigest, status: "valid",
      auditedAt: "2020-01-01T00:01:00.000Z", executionStartedAt: "2020-01-01T00:02:00.000Z",
      actors: { author: "10000000-0000-4000-8000-000000000001", auditor: "10000000-0000-4000-8000-000000000002", adjudicator: "10000000-0000-4000-8000-000000000003" },
      checks: { sourceAuthoritative: true, noDuplicateCases: true, noCorpusOverlap: true, strataComplete: true, auditedBeforeExecution: true },
      strataCounts: { holdoutCount: 1, legacyCount: 1 }, evidence: [{ locator: "validity-evidence.txt", digest: digestRaw(validityEvidence), verified: true }],
    };
    const writeJson = (file: string, value: unknown) => writeFile(path.join(cycle, file), `${JSON.stringify(value)}\n`, "utf8");
    const writeValidity = () => writeJson("evaluation-validity-report.json", { ...validityPayload, reportDigest: digestCanonical(validityPayload) });
    await Promise.all([
      writeFile(path.join(cycle, "input.jsonl"), `${records.map(record => JSON.stringify(record)).join("\n")}\n`, "utf8"),
      writeFile(path.join(cycle, "quality-labels.jsonl"), `${labels.map(label => JSON.stringify(label)).join("\n")}\n`, "utf8"),
      writeFile(path.join(cycle, "verification-rubric.md"), "fixture rubric\n", "utf8"), writeFile(path.join(cycle, "validity-evidence.txt"), validityEvidence, "utf8"),
      ...prior.map(item => writeFile(path.join(cycle, item.evidenceLocator), item.bytes, "utf8")),
      writeJson("evaluation-frame.json", frame), writeJson("manifest.json", { schemaVersion: "1.0.0", cycleId: frame.frameId, frameDigest: frame.frameDigest }), writeValidity(),
    ]);
    await expect(evaluateKoreanProseReadiness(cycle)).resolves.toMatchObject({ status: "READY_TO_EVALUATE" });
    validityPayload.strataCounts.legacyCount = 2;
    await writeValidity();
    await expect(evaluateKoreanProseReadiness(cycle)).rejects.toThrow("not bound to the frozen frame and corpus");
  } finally { await rm(cycle, { recursive: true, force: true }); }
});
