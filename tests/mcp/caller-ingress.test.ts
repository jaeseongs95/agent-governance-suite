import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowContractError } from "../../contracts/types.js";
import { admitCaller, MAX_PARENT_CHAIN, RESERVED_CALLER_KEYS, type CallerIngress, type IngressResult, type ObservedCaller } from "../../mcp-server/src/caller-identity.js";
import { antigravityMetaIngress, claudeAdmissionIngress, codexMetaIngress } from "../../mcp-server/src/builtin-caller-ingress.js";
import { UnavailableContinuityService } from "../../mcp-server/src/continuity-service.js";
import { runGovernanceHook } from "../../mcp-server/src/governance-hook.js";
import { HostAttestationProvider, hostActorId } from "../../mcp-server/src/host-attestation.js";
import { codexExecutionAdapter } from "../../mcp-server/src/host-execution-adapters.js";
import { UnavailableKoreanProseGlossary } from "../../mcp-server/src/korean-prose-glossary.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { TrustService } from "../../mcp-server/src/trust-service.js";
import { TrustStore } from "../../mcp-server/src/trust-store.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { CURRENT_VERSION, STABLE_VERSION } from "./version-fixtures.js";

// Oracle: key shapes captured on real hosts (docs/ags30-session-binding-design.md 1.5), not the adapters' code.
const S = "019a-root-session";
const A = "019a-child-a";
const B = "019a-child-b";
const root = (host: string, session = S) => hostActorId(host, session);
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function ownedDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "caller-ingress-"));
  directories.push(directory);
  return directory;
}
function rejection(run: () => unknown): { code: string; reasonCode: unknown; ingressReason?: unknown } {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(WorkflowContractError);
    const failure = error as WorkflowContractError;
    return { code: failure.code, reasonCode: failure.details?.reasonCode, ingressReason: failure.details?.ingressReason };
  }
  throw new Error("expected a rejection");
}
function observed(result: IngressResult): ObservedCaller {
  expect(result.provenance).toBe("host-observed");
  return (result as Extract<IngressResult, { provenance: "host-observed" }>).caller;
}

function codexMeta(thread: string, extra: Record<string, unknown> = {}, session = S): Record<string, unknown> {
  return {
    callId: `call-${thread}`, itemId: "item", progressToken: 1, sessionId: session, threadId: thread, windowId: "w",
    "x-codex-turn-metadata": { session_id: session, thread_id: thread, turn_id: "turn-1", model: "gpt-6-astra",
      reasoning_effort: "high", thread_source: "user", codex_version: "0.166.0", ...extra },
  };
}
const codexChild = (thread: string, parent: string) => codexMeta(thread, { parent_thread_id: parent, forked_from_thread_id: parent,
  subagent_kind: "thread_spawn", thread_source: "subagent" });
const agyMeta = (conversation: string, rootConversation = S, parent?: string) => ({
  "antigravity.google/artifacts_dir": "/tmp/a", "antigravity.google/conversation_id": conversation,
  "antigravity.google/root_conversation_id": rootConversation, progressToken: 2,
  ...(parent === undefined ? {} : { "antigravity.google/parent_conversation_id": parent }),
});

describe("core caller invariants (admitCaller)", () => {
  const base = (overrides: Partial<ObservedCaller> = {}): IngressResult => ({ provenance: "host-observed", caller: {
    host: "codex", sessionId: S, callId: "c", actor: { id: root("codex"), role: "root" }, parentChain: [], parentChainComplete: true,
    execution: { unavailable: "X" }, ...overrides } });
  const child = (chain: string[], overrides: Partial<ObservedCaller> = {}) => base({
    actor: { id: hostActorId("codex", S, "leaf"), role: "child" }, parentChain: chain, parentChainComplete: false, ...overrides });

  it("never presumes a root when the host observed nothing", () => {
    expect(rejection(() => admitCaller({ provenance: "unavailable", reason: "CODEX_CALL_META_MISSING" }, hostActorId)))
      .toEqual({ code: "BINDING_REQUIRED", reasonCode: "CALLER_PROVENANCE_UNAVAILABLE", ingressReason: "CODEX_CALL_META_MISSING" });
  });

  it.each([
    ["root with a parent chain", base({ parentChain: [root("codex")] })],
    ["root with an incomplete chain flag", base({ parentChainComplete: false })],
    ["root whose actor is another session", base({ actor: { id: root("codex", "other"), role: "root" } })],
    ["child without a chain", child([])],
    ["child whose chain does not start at its root", child([root("codex", "other")])],
  ])("rejects %s as inconsistent", (_name, result) => {
    expect(rejection(() => admitCaller(result, hostActorId))).toMatchObject({ code: "BINDING_INVALID", reasonCode: "CALLER_CHAIN_INCONSISTENT" });
  });

  it("bounds the chain depth at the limit", () => {
    const chain = (length: number) => [root("codex"), ...Array.from({ length: length - 1 }, (_, i) => hostActorId("codex", S, `p${i}`))];
    expect(admitCaller(child(chain(MAX_PARENT_CHAIN)), hostActorId).parentChain).toHaveLength(MAX_PARENT_CHAIN);
    expect(rejection(() => admitCaller(child(chain(MAX_PARENT_CHAIN + 1)), hostActorId))).toMatchObject({ reasonCode: "CALLER_CHAIN_TOO_DEEP" });
  });

  it.each([
    ["a repeated ancestor", [root("codex"), hostActorId("codex", S, "p"), hostActorId("codex", S, "p")]],
    ["the actor itself as an ancestor", [root("codex"), hostActorId("codex", S, "leaf")]],
  ])("rejects %s as a cycle", (_name, chain) => {
    expect(rejection(() => admitCaller(child(chain), hostActorId))).toMatchObject({ code: "BINDING_INVALID", reasonCode: "CALLER_CHAIN_CYCLE" });
  });

  it("admits a two-level child with its chain copied", () => {
    const chain = [root("codex"), hostActorId("codex", S, "mid")];
    const admitted = admitCaller(child(chain), hostActorId);
    expect(admitted).toMatchObject({ provenance: "host-observed", actor: { role: "child" }, parentChain: chain });
    expect(admitted.parentChain).not.toBe(chain);
  });
});

describe("Codex _meta ingress (captured 0.166.0 shapes)", () => {
  const ingress = codexMetaIngress();

  it.each([
    ["main call", codexMeta(S)],
    ["call after exec resume (same session)", codexMeta(S)],
    ["call after exec fork (new root, forked_from_thread_id only)", codexMeta("019a-fork", { forked_from_thread_id: S }, "019a-fork")],
  ])("observes the %s as a root with its execution", (_name, meta) => {
    const session = meta.sessionId as string;
    expect(observed(ingress("plan_workflow", meta))).toEqual({
      host: "codex", sessionId: session, callId: meta.callId, actor: { id: root("codex", session), role: "root" },
      parentChain: [], parentChainComplete: true,
      execution: { model: "gpt-6-astra", effort: "high", turnId: "turn-1", provenance: "codex:mcp-meta" },
    });
  });

  it("observes a ThreadSpawn child of the root with a complete chain", () => {
    expect(observed(ingress("t", codexChild(A, S)))).toMatchObject({
      sessionId: S, actor: { id: hostActorId("codex", S, A), role: "child" }, parentChain: [root("codex")], parentChainComplete: true,
    });
  });

  it("observes a grandchild with root and direct parent, marked incomplete", () => {
    expect(observed(ingress("t", codexChild(B, A)))).toMatchObject({
      sessionId: S, actor: { id: hostActorId("codex", S, B), role: "child" },
      parentChain: [root("codex"), hostActorId("codex", S, A)], parentChainComplete: false,
    });
  });

  it.each([
    ["no _meta", undefined],
    ["no call ID", { ...codexMeta(S), callId: undefined }],
    ["no turn metadata", { ...codexMeta(S), "x-codex-turn-metadata": undefined }],
    ["turn metadata as a string", { ...codexMeta(S), "x-codex-turn-metadata": JSON.stringify(codexMeta(S)["x-codex-turn-metadata"]) }],
  ])("reports %s as unavailable, not as a root", (_name, meta) => {
    expect(ingress("t", meta)).toEqual({ provenance: "unavailable", reason: "CODEX_CALL_META_MISSING" });
  });

  it.each([
    ["a turn session that differs from sessionId", codexMeta(S, { session_id: "other" }), "CODEX_CALL_META_INVALID"],
    ["a subagent kind without a parent", codexMeta(S, { subagent_kind: "review" }), "CODEX_CALL_META_INVALID"],
    ["a non-root thread without a parent", codexMeta(A), "CODEX_ROOT_THREAD_MISMATCH"],
    ["a parent on the root thread", codexMeta(S, { parent_thread_id: S }), "CODEX_CALL_META_INVALID"],
    ["a thread that names itself as parent", codexChild(A, A), "CODEX_CALL_META_INVALID"],
    ["an empty parent", codexChild(A, ""), "CODEX_CALL_META_INVALID"],
  ])("rejects %s", (_name, meta, reasonCode) => {
    expect(rejection(() => ingress("t", meta))).toMatchObject({ code: "BINDING_INVALID", reasonCode });
  });

  it("keeps identity when the model or effort is absent and reports execution as unavailable", () => {
    expect(observed(ingress("t", codexMeta(S, { reasoning_effort: undefined }))).execution).toEqual({ unavailable: "CODEX_EXECUTION_META_MISSING" });
  });

  it("is not influenced by identity-looking tool arguments", () => {
    // Arguments never reach the ingress; only host-written _meta does.
    expect(ingress.length).toBe(2);
    expect(observed(ingress("t", codexMeta(S))).actor.role).toBe("root");
  });
});

describe("agy _meta ingress (captured 1.4.12 shapes)", () => {
  const ingress = antigravityMetaIngress();

  it("observes the root conversation with no call ID and no execution", () => {
    expect(observed(ingress("t", agyMeta(S)))).toEqual({
      host: "antigravity", sessionId: S, callId: null, actor: { id: root("antigravity"), role: "root" }, parentChain: [],
      parentChainComplete: true, execution: { unavailable: "ANTIGRAVITY_EXECUTION_UNOBSERVED" },
    });
  });

  it.each([
    ["child", agyMeta(A, S, S), A, [root("antigravity")], true],
    ["grandchild", agyMeta(B, S, A), B, [root("antigravity"), hostActorId("antigravity", S, A)], false],
  ] as const)("observes a %s by its parent conversation", (_name, meta, self, chain, complete) => {
    expect(observed(ingress("t", meta))).toMatchObject({
      sessionId: S, actor: { id: hostActorId("antigravity", S, self), role: "child" }, parentChain: chain, parentChainComplete: complete,
    });
  });

  it("reports missing conversation IDs as unavailable", () => {
    expect(ingress("t", { progressToken: 1 })).toEqual({ provenance: "unavailable", reason: "ANTIGRAVITY_CALL_META_MISSING" });
  });

  it.each([
    ["a non-root conversation without a parent", agyMeta(A, S), "ANTIGRAVITY_ROOT_CONVERSATION_MISMATCH"],
    ["the root conversation with a parent", agyMeta(S, S, A), "ANTIGRAVITY_CALL_META_INVALID"],
    ["an empty parent", agyMeta(A, S, ""), "ANTIGRAVITY_CALL_META_INVALID"],
  ])("rejects %s", (_name, meta, reasonCode) => {
    expect(rejection(() => ingress("t", meta))).toMatchObject({ code: "BINDING_INVALID", reasonCode });
  });
});

describe("Claude admission (governance hook → SQLite → server claim)", () => {
  function fixture() {
    const directory = ownedDirectory();
    const environment = { ...process.env, AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflows.sqlite3"),
      AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3") };
    const hook = (toolUseId: string, extra: Record<string, unknown> = {}, tool = "list_session_status") => runGovernanceHook("claude-code", JSON.stringify({
      hook_event_name: "PreToolUse", session_id: S, cwd: directory, transcript_path: path.join(directory, "absent.jsonl"),
      tool_use_id: toolUseId, tool_name: `mcp__plugin_agent-governance-suite_agent-governance-suite__${tool}`,
      tool_input: { schemaVersion: "1.0.0" }, effort: { level: "high" }, ...extra,
    }), environment);
    const store = new SqliteWorkflowStore(environment.AGENT_GOVERNANCE_DB_PATH);
    return { hook, store, ingress: claudeAdmissionIngress(store), meta: (id: string) => ({ "claudecode/toolUseId": id, progressToken: 1 }) };
  }

  it("admits a root call once and prints nothing, so the host's own approval flow is unchanged", async () => {
    const { hook, store, ingress, meta } = fixture();
    try {
      expect(await hook("toolu_root")).toEqual({ ok: true, output: "" });
      expect(observed(ingress("list_session_status", meta("toolu_root")))).toMatchObject({
        host: "claude-code", sessionId: S, callId: "toolu_root", actor: { id: root("claude-code"), role: "root" }, parentChain: [],
      });
      expect(ingress("list_session_status", meta("toolu_root"))).toEqual({ provenance: "unavailable", reason: "CALL_ADMISSION_MISSING" });
    } finally { store.close(); }
  });

  it("admits a subagent call as a child whose chain stops at the root", async () => {
    const { hook, store, ingress, meta } = fixture();
    try {
      expect(await hook("toolu_child", { agent_id: "agent-a", agent_type: "general-purpose" })).toEqual({ ok: true, output: "" });
      expect(observed(ingress("list_session_status", meta("toolu_child")))).toMatchObject({
        actor: { id: hostActorId("claude-code", S, "agent-a"), role: "child" }, parentChain: [root("claude-code")], parentChainComplete: false,
      });
    } finally { store.close(); }
  });

  it.each([[""], [" "], [42], [null]])("records no row for a malformed agent_id %j and denies with exit 2", async agentId => {
    const { hook, store, ingress, meta } = fixture();
    try {
      const outcome = await hook("toolu_bad_agent", { agent_id: agentId });
      expect(outcome.ok).toBe(false);
      expect(JSON.parse(outcome.output)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "HOOK_AGENT_ID_INVALID" } });
      expect(ingress("list_session_status", meta("toolu_bad_agent"))).toEqual({ provenance: "unavailable", reason: "CALL_ADMISSION_MISSING" });
    } finally { store.close(); }
  });

  it("rejects a row claimed for a different tool and consumes it", async () => {
    const { hook, store, ingress, meta } = fixture();
    try {
      await hook("toolu_other");
      expect(rejection(() => ingress("update_session_status", meta("toolu_other")))).toMatchObject({ code: "BINDING_INVALID", reasonCode: "CALL_ADMISSION_TOOL_MISMATCH" });
      expect(ingress("list_session_status", meta("toolu_other")).provenance).toBe("unavailable");
    } finally { store.close(); }
  });

  it("reports a call without the host tool-use ID as unavailable", () => {
    const { store, ingress } = fixture();
    try {
      expect(ingress("list_session_status", { progressToken: 1 })).toEqual({ provenance: "unavailable", reason: "CLAUDE_TOOL_USE_ID_MISSING" });
    } finally { store.close(); }
  });

  it("keeps 20 parallel calls apart by their tool-use IDs", async () => {
    const { hook, store, ingress, meta } = fixture();
    try {
      const ids = Array.from({ length: 20 }, (_, i) => `toolu_parallel_${i}`);
      await Promise.all(ids.map(id => hook(id)));
      for (const id of ids) expect(observed(ingress("list_session_status", meta(id))).callId).toBe(id);
      for (const id of ids) expect(ingress("list_session_status", meta(id)).provenance).toBe("unavailable");
    } finally { store.close(); }
  });
});

describe("execution observation from the caller", () => {
  const caller = (execution: ObservedCaller["execution"], callId: string | null = "call-1") => admitCaller({ provenance: "host-observed", caller: {
    host: "codex", sessionId: S, callId, actor: { id: hostActorId("codex", S, A), role: "child" }, parentChain: [root("codex")],
    parentChainComplete: true, execution } }, hostActorId);
  const binding = { phase: "bootstrap" as const, taskId: "task-1", runId: null, stageId: null, revision: null };
  const provider = new HostAttestationProvider(codexExecutionAdapter, () => new Date("2026-11-01T00:00:00.000Z"));

  it("qualifies the observed model and records the calling actor, one observation per host call", () => {
    const observedCaller = caller({ model: "gpt-6-astra", effort: "high", turnId: "t", provenance: "codex:mcp-meta" });
    const first = provider.run("plan_workflow", observedCaller, () => provider.observe(binding));
    const again = provider.run("plan_workflow", observedCaller, () => provider.observe(binding));
    expect(first).toMatchObject({ model: "gpt-6-astra", reasoningEffort: "high", actorId: hostActorId("codex", S, A), taskId: "task-1", source: "runtime" });
    expect(again?.observationId).toBe(first?.observationId);
    const other = provider.run("plan_workflow", caller({ model: "gpt-6-astra", effort: "high", turnId: "t", provenance: "codex:mcp-meta" }, "call-2"), () => provider.observe(binding));
    expect(other?.observationId).not.toBe(first?.observationId);
  });

  it.each([
    ["unobserved execution", caller({ unavailable: "CODEX_EXECUTION_META_MISSING" }), "CODEX_EXECUTION_META_MISSING"],
    ["a host without call IDs", caller({ model: "gpt-6-astra", effort: "high", turnId: null, provenance: "codex:mcp-meta" }, null), "HOST_CALL_ID_UNAVAILABLE"],
  ])("observes nothing for %s and says why", (_name, observedCaller, reasonCode) => {
    expect(provider.run("plan_workflow", observedCaller, () => provider.observe(binding))).toBeNull();
    expect(provider.run("plan_workflow", observedCaller, () => provider.diagnose())).toMatchObject({ reasonCode });
  });

  it("rejects an unknown effort instead of qualifying it", () => {
    const observedCaller = caller({ model: "gpt-6-astra", effort: "turbo", turnId: null, provenance: "codex:mcp-meta" });
    expect(rejection(() => provider.run("plan_workflow", observedCaller, () => provider.observe(binding)))).toMatchObject({ code: "BINDING_INVALID", reasonCode: "REASONING_EFFORT_INVALID" });
  });

  it("observes nothing outside a run or for tools without execution floors", () => {
    expect(provider.observe(binding)).toBeNull();
    const observedCaller = caller({ model: "gpt-6-astra", effort: "high", turnId: null, provenance: "codex:mcp-meta" });
    expect(provider.run("list_session_status", observedCaller, () => provider.observe(binding))).toBeNull();
  });
});

describe("server ingress boundary", () => {
  const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
  async function serverFixture(ingress: CallerIngress | null) {
    const store = new InMemoryWorkflowStore();
    const validator = new ContractValidator();
    const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store);
    const updateStore = new InMemoryPluginUpdateStore();
    updateStore.putPluginUpdateState({
      targetId: "agent-governance-suite", currentVersion: CURRENT_VERSION, latestVersion: STABLE_VERSION,
      latestTag: `v${STABLE_VERSION}`, latestCommit: "a".repeat(40), etag: "caller-ingress", comparison: "up-to-date",
      lastAttemptAt: "2026-11-01T00:00:00.000Z", lastSuccessfulCheckAt: "2026-11-01T00:00:00.000Z",
      nextCheckAt: "2099-01-01T00:00:00.000Z", lastNotifiedVersion: null, lastNotifiedAt: null, lastErrorCode: null,
    });
    const trustStore = new TrustStore(":memory:");
    const trust = new TrustService(trustStore);
    const server = createMcpServer(service, new PluginUpdateService(updateStore), new UnavailableContinuityService(), undefined,
      new UnavailableKoreanProseGlossary(), validator, "default", null, null, new SessionMessageService(path.join(ownedDirectory(), "messaging")),
      trust, null, ingress);
    const client = new Client({ name: "caller-ingress-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      client, trust,
      async call(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) {
        const response = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
        const text = (response.content as Array<{ type: string; text?: string }>).find(item => item.type === "text")?.text;
        return JSON.parse(text!) as { ok: boolean; data: Record<string, unknown> | null; error: { code: string; details: Record<string, unknown> | null } | null };
      },
      async close() { try { await client.close(); } finally { try { await server.close(); } finally { trustStore.close(); } } },
    };
  }
  const decision = { schemaVersion: "1.2.0", sourceOriginKind: "unknown", sourceReceiptId: null, authorityEffect: "none",
    userDirective: "unspecified", auditSeparationRequired: false, route: "direct",
    netBenefitCriteria: { independentlyCompletable: true, parallelBottleneckReduced: true, limitedContextSufficient: true,
      singleWriterOwnership: true, netBenefitAfterOverhead: true } };

  it("advertises no caller identity field in any tool schema", async () => {
    const fixture = await serverFixture(codexMetaIngress());
    try {
      const { tools } = await fixture.client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) for (const key of RESERVED_CALLER_KEYS) expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain(`"${key}"`);
    } finally { await fixture.close(); }
  });

  it.each(RESERVED_CALLER_KEYS)("refuses caller-supplied %s before reading host metadata", async key => {
    const ingress = vi.fn(codexMetaIngress());
    const fixture = await serverFixture(ingress);
    try {
      expect(await fixture.call("get_trust_capabilities", { [key]: "forged" }, codexMeta(S)))
        .toMatchObject({ ok: false, error: { code: "INVALID_INPUT", details: { reasonCode: "RESERVED_CALLER_FIELD", field: key } } });
      expect(ingress).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it("refuses every call when no ingress is installed", async () => {
    const fixture = await serverFixture(null);
    try {
      expect(await fixture.call("get_trust_capabilities", {}, codexMeta(S)))
        .toMatchObject({ ok: false, error: { code: "BINDING_REQUIRED", details: { reasonCode: "HOST_INGRESS_UNAVAILABLE" } } });
    } finally { await fixture.close(); }
  });

  it("identifies Codex calls from _meta: root and child succeed, a call without metadata is refused", async () => {
    const fixture = await serverFixture(codexMetaIngress());
    try {
      expect(await fixture.call("get_trust_capabilities", {}, codexMeta(S))).toMatchObject({ ok: true });
      expect(await fixture.call("get_trust_capabilities", {}, codexChild(B, A))).toMatchObject({ ok: true });
      expect(await fixture.call("get_trust_capabilities", {}))
        .toMatchObject({ ok: false, error: { code: "BINDING_REQUIRED", details: { reasonCode: "CALLER_PROVENANCE_UNAVAILABLE", ingressReason: "CODEX_CALL_META_MISSING" } } });
    } finally { await fixture.close(); }
  });

  it("reports the observed actor kind to collaboration validation", async () => {
    const fixture = await serverFixture(codexMetaIngress());
    try {
      const main = await fixture.call("validate_collaboration_decision", { decision }, codexMeta(S));
      const sub = await fixture.call("validate_collaboration_decision", { decision: { ...decision, sourceOriginKind: "user-turn" } }, codexChild(A, S));
      expect(main.data?.callerObservation).toMatchObject({ host: "codex", sessionId: S, actorKind: "main" });
      expect(sub.data).toMatchObject({ callerObservation: { sessionId: S, actorKind: "subagent" }, sourceClaimMatch: false });
    } finally { await fixture.close(); }
  });
});
