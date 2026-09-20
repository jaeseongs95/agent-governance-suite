import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import type { CollaborationDecisionV1 } from "../../contracts/types.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { TrustService } from "../../mcp-server/src/trust-service.js";
import { TrustStore } from "../../mcp-server/src/trust-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { runSessionMessageCli } from "../../mcp-server/src/session-message-cli.js";
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";

const directories: string[] = [];
const stores = new Set<TrustStore>();
const binding = { host: "codex", sessionId: "session-1" };

function decision(overrides: Partial<CollaborationDecisionV1> = {}): CollaborationDecisionV1 {
  return {
    schemaVersion: "1.2.0",
    sourceOriginKind: "peer",
    sourceReceiptId: null,
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
    ...overrides,
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
    etag: "trust-provenance",
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

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function openStore(): Promise<{ store: TrustStore; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "trust-provenance-"));
  directories.push(directory);
  const path = join(directory, "trust.sqlite3");
  const store = new TrustStore(path);
  stores.add(store);
  return { store, path };
}

function peerInput(body: string) {
  return {
    originKind: "peer" as const,
    ...binding,
    eventId: "message-1",
    contentDigest: digest(body),
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    authorityEffect: "none" as const,
    attestation: { kind: "broker-peer-envelope" as const, adapter: "test", capabilityVersion: "1" },
  };
}

afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function terminateBroker(directory: string): Promise<void> {
  try {
    const { pid } = JSON.parse(readFileSync(join(directory, "endpoint.json"), "utf8")) as { pid: number };
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH" && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

describe("trust provenance", () => {
  it("reports authority and direct-user attestation as unavailable", async () => {
    const { store } = await openStore();
    expect(new TrustService(store).capabilities()).toMatchObject({
      ok: true,
      data: {
        provenanceRecording: true,
        directUserInputAttestation: false,
        authorityIssuance: false,
        scopedDelegation: false,
      },
    });
  });

  it("stores peer provenance by digest without persisting the raw body", async () => {
    const { store, path } = await openStore();
    const rawBody = "peer body that must not be persisted";
    const inputWithRawBody = { ...peerInput(rawBody), body: rawBody };
    expect(() => store.recordInputSource(inputWithRawBody)).toThrow(/unsupported fields/u);
    const inputWithNestedRawBody = {
      ...peerInput(rawBody),
      attestation: { ...peerInput(rawBody).attestation, body: rawBody },
    } as ReturnType<typeof peerInput>;
    expect(() => store.recordInputSource(inputWithNestedRawBody)).toThrow(/unsupported fields/u);
    const receipt = store.recordInputSource(peerInput(rawBody));
    expect(new ContractValidator().inputSourceReceipt(receipt)).toEqual(receipt);
    expect(receipt).toMatchObject({ originKind: "peer", authorityEffect: "none", contentDigest: digest(rawBody) });
    expect(store.verify(receipt)).toBe(true);
    expect(store.latestInputSource(binding)?.receiptId).toBe(receipt.receiptId);
    store.close();
    stores.delete(store);
    expect(readFileSync(path).includes(Buffer.from(rawBody))).toBe(false);
  });

  it("is idempotent for the same event and rejects changed content or security metadata", async () => {
    const { store } = await openStore();
    const input = peerInput("body");
    const first = store.recordInputSource(input);
    expect(store.recordInputSource({ ...input, observedAt: new Date().toISOString() }).receiptId).toBe(first.receiptId);
    expect(() => store.recordInputSource({ ...input, contentDigest: digest("changed") })).toThrow(/different content or provenance/u);
    expect(() => store.recordInputSource({ ...input, originKind: "system", attestation: { ...input.attestation, kind: "verified-internal-wake" } }))
      .toThrow(/different content or provenance/u);
  });

  it("records and verifies a claimed peer message before injecting its receipt-bound body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trust-hook-"));
    const trustPath = join(directory, "trust.sqlite3");
    const previousStateDirectory = process.env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR;
    const previousTrustPath = process.env.AGENT_GOVERNANCE_TRUST_DB_PATH;
    const target = { host: "claude-code", sessionId: "receipt-target" };
    const body = "peer body that must not reach the trust store";
    process.env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR = directory;
    process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = trustPath;
    try {
      await runSessionMessageCli(JSON.stringify({
        operation: "send",
        payload: { messageId: "receipt-message-1", sender: { host: "claude-code", sessionId: "sender" }, target, body, ttlSeconds: 600 },
      }), directory);
      const output = await handleSessionMessageHook({ hook_event_name: "Stop", session_id: target.sessionId }, "claude-code");
      const context = (output.hookSpecificOutput as { additionalContext: string }).additionalContext;
      const envelope = JSON.parse(context.split("\n").find((line) => line.startsWith("{"))!) as {
        message: string;
        receipt: { sourceReceiptId: string };
      };
      const sourceReceiptId = envelope.receipt.sourceReceiptId;
      expect(sourceReceiptId).toBeTruthy();
      expect(envelope.message).toBe(body);

      const store = new TrustStore(trustPath);
      try {
        const receipt = store.getInputSource(sourceReceiptId!);
        expect(receipt).toMatchObject({
          receiptId: sourceReceiptId,
          originKind: "peer",
          host: target.host,
          sessionId: target.sessionId,
          eventId: "receipt-message-1",
          contentDigest: digest(body),
          expiresAt: expect.any(String),
          authorityEffect: "none",
          attestation: { kind: "broker-peer-envelope", adapter: "session-message-hook", capabilityVersion: "1.0.0" },
        });
        expect(receipt && store.verify(receipt)).toBe(true);
      } finally {
        store.close();
      }
      expect(readFileSync(trustPath).includes(Buffer.from(body))).toBe(false);
    } finally {
      if (previousStateDirectory === undefined) delete process.env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR;
      else process.env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR = previousStateDirectory;
      if (previousTrustPath === undefined) delete process.env.AGENT_GOVERNANCE_TRUST_DB_PATH;
      else process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = previousTrustPath;
      await terminateBroker(directory);
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  it("rejects direct-user and approval-source records in the deferred release", async () => {
    const { store } = await openStore();
    const input = peerInput("body");
    expect(() => store.recordInputSource({
      ...input,
      originKind: "user-turn",
      attestation: { ...input.attestation, kind: "host-direct-user-event" },
    })).toThrow(/cannot attest direct-user/u);
    expect(() => store.recordInputSource({ ...input, eventId: "peer-authority", authorityEffect: "restrict-only" }))
      .toThrow(/non-authorizing broker envelope/u);
  });

  it("keeps missing and nullable receipts explicitly unverified", async () => {
    const { store } = await openStore();
    const service = new TrustService(store);
    const caller = { ...binding, actorKind: "subagent" as const, observedBy: "generic-host-adapter", assurance: "observational" };
    expect(service.validateCollaborationDecision({ decision: decision({ sourceOriginKind: "artifact" }), _sessionBinding: caller }).data)
      .toMatchObject({
        structuralValidity: "valid",
        receiptFound: false,
        receiptIntegrity: null,
        receiptBoundToCaller: null,
        receiptFreshness: null,
        sourceClaimMatch: null,
        callerObservation: caller,
        callerBindingAssurance: "observational",
        authorityCapabilities: { directUserInputAttestation: false, authorityIssuance: false, scopedDelegation: false },
      });
    expect(service.validateCollaborationDecision({
      decision: decision({ sourceReceiptId: "source-abcdefghijklmnop" }),
      _sessionBinding: caller,
    }).data).toMatchObject({ receiptFound: false, receiptIntegrity: null, sourceClaimMatch: null });
  });

  it("reports stale, differently bound, and conflicting receipt provenance independently", async () => {
    const { store } = await openStore();
    const service = new TrustService(store);
    const stale = store.recordInputSource({
      ...peerInput("stale"),
      eventId: "stale-message",
      observedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:01:00.000Z",
    });
    const input = { decision: decision({ sourceReceiptId: stale.receiptId }), _sessionBinding: { host: "other-host", sessionId: "other-session" } };
    expect(service.validateCollaborationDecision(input, new Date("2026-01-02T00:00:00.000Z")).data).toMatchObject({
      structuralValidity: "valid",
      receiptFound: true,
      receiptIntegrity: "valid",
      receiptBoundToCaller: false,
      receiptFreshness: "stale",
      sourceClaimMatch: true,
    });
    expect(service.validateCollaborationDecision({
      ...input,
      decision: decision({ sourceOriginKind: "user-turn", sourceReceiptId: stale.receiptId }),
    }).data).toMatchObject({ structuralValidity: "valid", sourceClaimMatch: false });
  });

  it("reports a stored receipt with a forged integrity token without trusting its other claims", async () => {
    const { store, path } = await openStore();
    const receipt = store.recordInputSource(peerInput("forged"));
    const database = new DatabaseSync(path);
    database.prepare("UPDATE input_source_receipts SET receipt_json = json_set(receipt_json, '$.integrityToken', ?) WHERE receipt_id = ?")
      .run("x".repeat(43), receipt.receiptId);
    database.close();
    expect(new TrustService(store).validateCollaborationDecision({
      decision: decision({ sourceReceiptId: receipt.receiptId }),
      _sessionBinding: binding,
    }).data).toMatchObject({
      receiptFound: true,
      receiptIntegrity: "invalid",
      receiptBoundToCaller: null,
      receiptFreshness: null,
      sourceClaimMatch: null,
    });
  });

  it("does not turn an arbitrary caller binding or unknown source claim into authority", async () => {
    const { store } = await openStore();
    const result = new TrustService(store).validateCollaborationDecision({
      decision: decision({ sourceOriginKind: "unknown" }),
      _sessionBinding: { host: "made-up-host", sessionId: "made-up-session", actorKind: "main", observedBy: "caller" },
    });
    expect(result.data).toMatchObject({
      structuralValidity: "valid",
      callerObservation: { host: "made-up-host", observedBy: "caller" },
      authorityCapabilities: { directUserInputAttestation: false, authorityIssuance: false, scopedDelegation: false },
    });
  });

  it("rejects a user-turn claim from an observed subagent without classifying missing provenance", async () => {
    const { store } = await openStore();
    const result = new TrustService(store).validateCollaborationDecision({
      decision: decision({ sourceOriginKind: "user-turn" }),
      _sessionBinding: { host: "generic", sessionId: "child", actorKind: "subagent", observedBy: "generic-host-adapter" },
    });
    expect(result.data).toMatchObject({
      structuralValidity: "valid",
      receiptFound: false,
      receiptIntegrity: null,
      sourceClaimMatch: false,
      callerBindingAssurance: "observational",
    });
  });

  it("exposes read-only MCP validation without trusting an arbitrary caller host name", async () => {
    const { store } = await openStore();
    const validator = new ContractValidator();
    const server = createMcpServer({} as WorkflowService, updateService(), undefined, undefined, undefined, validator, "default", null, null, undefined, new TrustService(store));
    const client = new Client({ name: "trust-provenance", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = (await client.listTools()).tools.find((tool) => tool.name === "validate_collaboration_decision");
      expect(listed?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      const response = await client.callTool({
        name: "validate_collaboration_decision",
        arguments: {
          decision: decision({ sourceOriginKind: "unknown" }),
          _sessionBinding: { host: "arbitrary-name", sessionId: "caller-supplied", actorKind: "main", observedBy: "caller" },
        },
      });
      const text = (response.content as Array<{ type: string; text: string }>).find((item) => item.type === "text")?.text ?? "{}";
      expect(JSON.parse(text)).toMatchObject({
        ok: true,
        data: {
          structuralValidity: "valid",
          receiptFound: false,
          authorityCapabilities: { directUserInputAttestation: false, authorityIssuance: false, scopedDelegation: false },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
