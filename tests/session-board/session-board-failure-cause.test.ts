import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tagHookFailure } from "../../mcp-server/src/hook-error-diagnostics.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { runSessionBoardHook } from "../../mcp-server/src/session-board-hook.js";
import type { sessionMessageRequest } from "../../mcp-server/src/session-message-client.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { CURRENT_VERSION } from "../mcp/version-fixtures.js";
import { createSyntheticRootProofFixture } from "../mcp/synthetic-root-proof-client.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const directories: string[] = [];

function temp(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "session-board-cause-"));
  directories.push(directory);
  return directory;
}

/** Raw and JSON-escaped forms: on Windows JSON doubles every backslash, so the raw form alone never matches. */
function pathForms(value: string): string[] {
  return [value, JSON.stringify(value).slice(1, -1)];
}

function lines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("board-hook-failure "));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("session board hook failure cause", () => {
  it("reports a consume-wake failure with its producer reason and still fails open", async () => {
    vi.stubEnv("AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH", path.join(temp(), "board.sqlite3"));
    const request = (async () => {
      throw tagHookFailure(new Error("PRIVATE_WAKE_MESSAGE"), "BROKER_TRANSPORT_FAILED");
    }) as unknown as typeof sessionMessageRequest;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const nonce = "a".repeat(32);
    expect(await runSessionBoardHook("claude-code", JSON.stringify({
      hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: `[agent-governance-suite:wake:${nonce}]`,
    }), request)).toBe("");
    const line = lines(spy).find((value) => value.includes('"phase":"consume-wake"'));
    expect(line).toBeDefined();
    expect(line).toContain('"reason":"BROKER_TRANSPORT_FAILED"');
    expect(line).not.toContain("PRIVATE_WAKE_MESSAGE");
  });

  it("reports an unreadable stdin as its own phase with the read cause, not as invalid input", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unreadable = (() => {
      throw Object.assign(new Error("PRIVATE_STDIN_MESSAGE"), { code: "EAGAIN" });
    }) as unknown as string;
    expect(await runSessionBoardHook("codex", unreadable)).toBe("");
    const reported = lines(spy);
    expect(reported).toHaveLength(1);
    const line = reported[0]!;
    const value = JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>;
    expect(value).toMatchObject({ phase: "stdin", context: { type: "error", code: {
      type: "string", prefixSha256: createHash("sha256").update(Buffer.from("EAGAIN", "utf16le")).digest("hex"),
    } } });
    expect(line).not.toContain("PRIVATE_STDIN_MESSAGE");
  });

  it("reports the failed open phase when the board is unusable", async () => {
    const directory = temp();
    const blocker = path.join(directory, "file");
    writeFileSync(blocker, "");
    vi.stubEnv("AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH", path.join(blocker, "session-board.sqlite3"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSessionBoardHook("claude-code", JSON.stringify({
      hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Edit", tool_input: {},
    }))).toBe("");
    const line = lines(spy).find((value) => value.includes('"phase":"open"'));
    expect(line).toBeDefined();
    for (const form of pathForms(directory)) expect(line).not.toContain(form);
  });
});

describe("session board MCP failure cause", () => {
  it("returns the failed step and a redacted cause with MCP_UNAVAILABLE", async () => {
    const databasePath = path.join(temp(), "session-board.sqlite3");
    writeFileSync(databasePath, "x".repeat(4096));
    const validator = new ContractValidator();
    const updates = new InMemoryPluginUpdateStore();
    updates.putPluginUpdateState({
      targetId: "agent-governance-suite", currentVersion: CURRENT_VERSION, latestVersion: CURRENT_VERSION, latestTag: `v${CURRENT_VERSION}`,
      latestCommit: "d".repeat(40), etag: "session-board", comparison: "up-to-date", lastAttemptAt: "2026-09-19T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-09-19T00:00:00.000Z", nextCheckAt: "2099-01-01T00:00:00.000Z", lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null,
    });
    const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore());
    const root = createSyntheticRootProofFixture();
    const server = createMcpServer(service, new PluginUpdateService(updates), undefined, undefined, undefined, validator, "default", null, databasePath, new SessionMessageService(), undefined, undefined, root.proofs);
    const client = new Client({ name: "session-board-cause", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({ name: "list_session_status", arguments: root.argumentsFor("list_session_status", { schemaVersion: "1.0.0" }) });
    const text = (response as { content: Array<{ text: string }> }).content[0]!.text;
    const result = JSON.parse(text) as { ok: boolean; error: { code: string; details: Record<string, unknown> | null } | null };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MCP_UNAVAILABLE");
    expect(result.error?.details).toMatchObject({ step: "open", cause: { type: "error" } });
    for (const form of pathForms(databasePath)) expect(text).not.toContain(form);
  });
});
