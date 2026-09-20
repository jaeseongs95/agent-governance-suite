import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TrustService } from "../../mcp-server/src/trust-service.js";
import { TrustStore } from "../../mcp-server/src/trust-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { runSessionMessageCli } from "../../mcp-server/src/session-message-cli.js";
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";

const directories: string[] = [];
const stores = new Set<TrustStore>();
const binding = { host: "codex", sessionId: "session-1" };

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
    const target = { host: "codex", sessionId: "receipt-target" };
    const body = "peer body that must not reach the trust store";
    process.env.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR = directory;
    process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = trustPath;
    try {
      await runSessionMessageCli(JSON.stringify({
        operation: "send",
        payload: { messageId: "receipt-message-1", sender: { host: "claude-code", sessionId: "sender" }, target, body, ttlSeconds: 600 },
      }), directory);
      const output = await handleSessionMessageHook({ hook_event_name: "UserPromptSubmit", session_id: target.sessionId }, "codex");
      const context = (output.hookSpecificOutput as { additionalContext: string }).additionalContext;
      const sourceReceiptId = context.match(/^sourceReceiptId: (source-[A-Za-z0-9_-]+)$/mu)?.[1];
      expect(sourceReceiptId).toBeTruthy();
      expect(context).toMatch(new RegExp(`sourceReceiptId: ${sourceReceiptId}\\nbody:\\n${body}`, "u"));

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
});
