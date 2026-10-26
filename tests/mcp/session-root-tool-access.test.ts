import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { createMcpServer } from "../../mcp-server/src/server.js";
import { isObservedSessionRoot, type SessionActorAdapter, type SessionActorDecision } from "../../mcp-server/src/session-actor-access.js";
import type { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import type { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import type { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import type { TrustService } from "../../mcp-server/src/trust-service.js";

// Fake adapter evidence exercises the common boundary only; it is never native host evidence.
const root: SessionActorDecision = {
  kind: "root", identityId: "ags-owned-identity", rootIdentityId: "ags-owned-identity",
  evidence: { kind: "observed", reference: "owned-test:request-bound-root" },
};
const child: SessionActorDecision = { ...root, kind: "child", identityId: "ags-owned-child" };
const unknown: SessionActorDecision = {
  kind: "unknown", identityId: null, rootIdentityId: null,
  evidence: { kind: "unavailable", reference: null },
};

async function harness(adapter: SessionActorAdapter | null = null) {
  const capabilities = vi.fn(() => ({ schemaVersion: "1.0.0", ok: true, data: { marker: "owned-service" }, error: null }));
  const cachedStatus = vi.fn(() => null);
  const service = {} as WorkflowService;
  const updates = { cachedStatus, takeNotice: vi.fn(() => null) } as unknown as PluginUpdateService;
  const messages = {} as SessionMessageService;
  const trust = { capabilities } as unknown as TrustService;
  const server = createMcpServer(service, updates, undefined, undefined, undefined, undefined,
    "default", null, null, messages, trust, null, adapter);
  const client = new Client({ name: "owned-root-gate-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client, capabilities, cachedStatus,
    close: async () => { await client.close(); await server.close(); },
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{type: string; text: string}>).find(item => item.type === "text")?.text;
      return JSON.parse(text ?? "{}");
    },
  };
}

describe("vendor-neutral session root access", () => {
  it("requires observed, nonempty, same-root identity evidence", () => {
    expect(isObservedSessionRoot(root)).toBe(true);
    for (const decision of [null, undefined, unknown, child,
      {...root, identityId: ""}, {...root, rootIdentityId: "another-root"},
      {...root, evidence: {kind: "inferred" as const, reference: "inference"}},
      {...root, evidence: {kind: "unavailable" as const, reference: null}},
      {...root, evidence: {kind: "observed" as const, reference: " "}},
    ]) expect(isObservedSessionRoot(decision)).toBe(false);
  });

  it.each(["missing", "child", "unknown", "inferred-root"])("blocks every advertised tool for %s before service access", async kind => {
    const decision = kind === "child" ? child : kind === "inferred-root"
      ? {...root, evidence: {kind: "inferred" as const, reference: "absence-of-fields"}} : unknown;
    const adapter = kind === "missing" ? null : {observeCall: vi.fn(() => decision)};
    const h = await harness(adapter);
    try {
      const tools = (await h.client.listTools()).tools;
      expect(tools.some(tool => tool.name === "get_trust_capabilities")).toBe(true);
      for (const tool of tools) {
        const response = await h.call(tool.name, {agent_id: "", role: "main", _sessionBinding: {host: "invented-host", sessionId: "copied"}});
        expect(response.error, tool.name).toEqual({code: "BINDING_REQUIRED",
          message: "A verified session root is required to use AGS tools.", details: {reasonCode: "SESSION_ROOT_REQUIRED"}});
      }
      expect(h.capabilities).not.toHaveBeenCalled();
      expect(h.cachedStatus).not.toHaveBeenCalled();
      if (adapter) expect(adapter.observeCall).toHaveBeenCalledTimes(tools.length);
    } finally { await h.close(); }
  });

  it("allows an observed root through the real MCP handler and preserves domain validation", async () => {
    const observeCall = vi.fn<SessionActorAdapter["observeCall"]>(() => root);
    const h = await harness({observeCall});
    try {
      expect((await h.call("get_trust_capabilities")).data.marker).toBe("owned-service");
      expect(h.capabilities).toHaveBeenCalledOnce();
      const rejected = await h.call("get_trust_capabilities", {unexpected: true});
      expect(rejected.error.code).toBe("INVALID_INPUT");
      expect(h.capabilities).toHaveBeenCalledOnce();
      expect(observeCall).toHaveBeenCalledTimes(2);
      const [request, context] = observeCall.mock.calls[0]!;
      expect(request.params.name).toBe("get_trust_capabilities");
      expect(context.requestId).toBeDefined();
      expect(context.signal).toBeInstanceOf(AbortSignal);
    } finally { await h.close(); }
  });

  it("observes each request independently and never caches root permission", async () => {
    const observeCall = vi.fn<SessionActorAdapter["observeCall"]>()
      .mockReturnValueOnce(root).mockReturnValueOnce(child).mockReturnValueOnce(unknown);
    const h = await harness({observeCall});
    try {
      expect((await h.call("get_trust_capabilities")).ok).toBe(true);
      expect((await h.call("get_trust_capabilities")).error.code).toBe("BINDING_REQUIRED");
      expect((await h.call("get_trust_capabilities")).error.code).toBe("BINDING_REQUIRED");
      expect(h.capabilities).toHaveBeenCalledOnce();
    } finally { await h.close(); }
  });

  it("keeps an adapter failure distinct from unknown and does not reach a service", async () => {
    const h = await harness({observeCall: () => {throw new Error("synthetic-private-observation-failure");}});
    try {
      const rejected = await h.call("get_trust_capabilities");
      expect(rejected.error.code).toBe("MCP_UNAVAILABLE");
      expect(rejected.error.details.reasonCode).toBe("SESSION_ACTOR_OBSERVATION_FAILED");
      expect(h.capabilities).not.toHaveBeenCalled();
      expect(h.cachedStatus).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it("does not infer permission for unregistered tool names", async () => {
    const h = await harness();
    try {
      expect((await h.call("future_adapter_tool")).error.code).toBe("BINDING_REQUIRED");
      expect(h.cachedStatus).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
});
