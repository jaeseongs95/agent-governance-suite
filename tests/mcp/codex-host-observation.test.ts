import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { TaskEnvelopeV1 } from "../../contracts/types.js";
import { CODEX_METADATA_HEAD_BYTES, CODEX_METADATA_TAIL_BYTES, observeCodexHook, readCodexMetadata } from "../../mcp-server/src/codex-host-observation.js";
import { handleCodexHostAttestationHook } from "../../mcp-server/src/host-attestation-hook.js";
import { HOST_ATTESTATION_FIELD, hostActorId, HostAttestationProvider } from "../../mcp-server/src/host-attestation.js";
import { claudeCodeExecutionAdapter, codexExecutionAdapter } from "../../mcp-server/src/host-execution-adapters.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

const hook = {
  hook_event_name: "PreToolUse", session_id: "host-session", turn_id: "current-turn",
  model: "gpt-6-astra", tool_use_id: "current-call", transcript_path: "host-rollout.jsonl",
  tool_name: "mcp__agent_governance_suite__plan_workflow", tool_input: { taskId: "hook-task" },
};
const metadata = (context: Record<string, unknown> = {}, session: Record<string, unknown> = {}) => ({
  head: `${JSON.stringify({ type: "session_meta", payload: { id: hook.session_id, source: "vscode", ...session } })}\n`,
  tail: `${JSON.stringify({ type: "turn_context", payload: { turn_id: hook.turn_id, model: hook.model, effort: "high", ...context } })}\n`,
});

describe("Codex current host observation", () => {
  it("uses exact model IDs and conservative governance policy without inferring suffixes or successors", () => {
    expect(codexExecutionAdapter.modelClassForModel("gpt-6-astra")).toBe("frontier");
    expect(codexExecutionAdapter.modelClassForModel("gpt-6-sol")).toBe("general");
    expect(codexExecutionAdapter.modelClassForModel("gpt-6-luna")).toBe("lightweight");
    expect(codexExecutionAdapter.modelClassForModel("gpt-5.6-sol")).toBe("deep");
    expect(codexExecutionAdapter.modelClassForModel("gpt-6-sol-latest")).toBeNull();
    expect(codexExecutionAdapter.modelClassForModel("gpt-7-astra")).toBeNull();
    expect(codexExecutionAdapter.modelClassForModel("constructor")).toBeNull();
  });
  it("uses the current hook call and exact host-recorded turn effort, ignoring caller wishes", () => {
    const result = observeCodexHook({ ...hook, reasoning_effort: "ultra", effort: { level: "ultra" } }, { readMetadata: () => metadata() });
    expect(result).toMatchObject({ reason: null, observation: {
      model: "gpt-6-astra", reasoningEffort: "high", sessionId: "host-session",
      turnId: "current-turn", toolUseId: "current-call", actorId: hostActorId("codex", "host-session"),
    } });
  });

  it.each([
    { input: { turn_id: "other-turn" }, context: {}, session: {}, reason: "host-turn-mismatch" },
    { input: {}, context: { model: "gpt-5.6-sol" }, session: {}, reason: "host-model-mismatch" },
    { input: {}, context: { effort: null }, session: {}, reason: "host-reasoning-effort-missing-or-unsupported" },
    { input: {}, context: { effort: "turbo" }, session: {}, reason: "host-reasoning-effort-missing-or-unsupported" },
    { input: {}, context: {}, session: { id: "another-session" }, reason: "host-session-mismatch-or-unsupported-metadata" },
    { input: {}, context: {}, session: { session_id: "different-session" }, reason: "host-session-mismatch-or-unsupported-metadata" },
    { input: { agent_id: "child-agent" }, context: {}, session: {}, reason: "subagent-identity-not-supported" },
    { input: {}, context: {}, session: { source: { subagent: { parent_thread_id: "parent" } } }, reason: "subagent-identity-not-supported" },
    { input: { model: "unknown-model" }, context: { model: "unknown-model" }, session: {}, reason: "host-model-policy-unsupported" },
    { input: { model: "constructor" }, context: { model: "constructor" }, session: {}, reason: "host-model-policy-unsupported" },
  ])("rejects $reason", ({ input, context, session, reason }) => {
    expect(observeCodexHook({ ...hook, ...input }, { readMetadata: () => metadata(context, session) }))
      .toEqual({ observation: null, reason });
  });

  it("never searches past a newer turn for an older matching context", () => {
    const window = metadata();
    window.tail += metadata({ turn_id: "newer-turn" }).tail;
    expect(observeCodexHook(hook, { readMetadata: () => window }).reason).toBe("host-turn-mismatch");
  });

  it("reports missing, unreadable and truncated metadata without using configuration defaults", () => {
    expect(observeCodexHook({ ...hook, turn_id: undefined }, { readMetadata: () => metadata() }).observation).toBeNull();
    expect(observeCodexHook(hook, { readMetadata: () => null }).reason).toBe("host-metadata-unreadable");
    expect(observeCodexHook(hook, { readMetadata: () => ({ head: "{", tail: metadata().tail }) }).observation).toBeNull();
    expect(observeCodexHook(hook, { readMetadata: () => ({ head: metadata().head, tail: "" }) }).reason)
      .toBe("current-turn-metadata-outside-bounded-window-or-missing");
  });

  it("replaces caller tokens, binds the input and hashed call scope, and gives actionable missing diagnostics", () => {
    const store = new InMemoryWorkflowStore();
    const input = { ...hook, tool_input: { ...hook.tool_input, [HOST_ATTESTATION_FIELD]: "caller-token" } };
    const output = handleCodexHostAttestationHook(input, store, { readMetadata: () => metadata() });
    const updated = (output.hookSpecificOutput as { updatedInput: Record<string, unknown>; permissionDecision: string });
    expect(updated.permissionDecision).toBe("allow");
    const token = String(updated.updatedInput[HOST_ATTESTATION_FIELD]);
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    expect(payload).toMatchObject({ host: "codex", tool: "plan_workflow", phase: "bootstrap", taskId: "hook-task" });
    expect(payload).toMatchObject({ session: expect.stringMatching(/^[a-f0-9]{24}$/u), turn: expect.stringMatching(/^[a-f0-9]{24}$/u), call: expect.stringMatching(/^[a-f0-9]{24}$/u) });
    expect(JSON.stringify(payload)).not.toContain(hook.session_id);
    const missing = handleCodexHostAttestationHook(input, store, { readMetadata: () => null });
    expect(missing).toMatchObject({ systemMessage: expect.stringContaining("host-metadata-unreadable"),
      hookSpecificOutput: { permissionDecision: "allow", updatedInput: hook.tool_input } });
    expect(handleCodexHostAttestationHook({ ...hook, tool_name: "mcp__another_server__plan_workflow" }, store)).toEqual({});
  });

  it("reads only the bounded metadata windows in a large transcript", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ags-codex-metadata-"));
    try {
      const file = path.join(directory, "large.jsonl");
      const fixture = metadata();
      writeFileSync(file, `${fixture.head}${"x".repeat(CODEX_METADATA_TAIL_BYTES + 4096)}\n${fixture.tail}`, "utf8");
      const window = readCodexMetadata(file)!;
      expect(Buffer.byteLength(window.head)).toBeLessThanOrEqual(CODEX_METADATA_HEAD_BYTES);
      expect(Buffer.byteLength(window.tail)).toBeLessThanOrEqual(CODEX_METADATA_TAIL_BYTES);
      expect(observeCodexHook(hook, { readMetadata: () => window }).observation?.reasoningEffort).toBe("high");
      expect(readCodexMetadata(directory)).toBeNull();
      expect(readCodexMetadata(path.join(directory, "missing"))).toBeNull();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("host-owned hookless provider ingress", () => {
  const task: TaskEnvelopeV1 = {
    schemaVersion: "1.0.0", taskId: "hookless-host", objective: "Exercise host-owned observation ingress",
    scope: { included: ["fixture"], excluded: ["deployment"] }, acceptanceCriteria: ["Plan with an observed bootstrap"],
    riskLevel: "low", workUnits: [{ id: "unit", objective: "Inspect fixture", dependencies: [], writeTargets: [] }],
    requiredCapabilities: ["task-decomposition"], constraints: ["Fixture only"],
    authorization: { allowedActions: ["test"], prohibitedActions: ["deploy"], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
  };

  it.each([
    { adapter: claudeCodeExecutionAdapter, model: "claude-opus-5" },
    { adapter: codexExecutionAdapter, model: "gpt-6-astra" },
  ])("shares the strict bootstrap, missing, policy and replay gates for $adapter.host", ({ adapter, model }) => {
    const store = new InMemoryWorkflowStore();
    const provider = new HostAttestationProvider(store, adapter);
    const validator = new ContractValidator();
    const service = new WorkflowService(new FileSkillRegistry(fileURLToPath(new URL("../../skills/registry.json", import.meta.url)), validator), validator, store, null, provider);
    const input = { schemaVersion: "1.0.0", taskEnvelope: task };
    const context = { model, reasoningEffort: "high", actorId: hostActorId(adapter.host, "host-owned-session"),
      sessionId: "host-owned-session", turnId: "host-owned-turn", toolUseId: "host-owned-call" };
    const planned = provider.runObserved("plan_workflow", input, () => context, (args) => service.planWorkflow(args, true));
    expect(planned.ok).toBe(true);
    expect(planned.data?.bootstrapExecution?.context.model).toBe(model);
    const replay = provider.runObserved("plan_workflow", input, () => context, (args) => service.planWorkflow(args, true));
    expect(replay.error?.code).toBe("BINDING_INVALID");
    const missing = provider.runObserved("plan_workflow", { ...input, [HOST_ATTESTATION_FIELD]: "caller-token" }, () => null,
      (args) => service.planWorkflow(args, true));
    expect(missing.error).toMatchObject({ code: "BINDING_REQUIRED", details: { observation: { host: adapter.host, status: "missing-call-observation" } } });
    const low = provider.runObserved("plan_workflow", input, () => ({ ...context, reasoningEffort: "low" }), (args) => service.planWorkflow(args, true));
    expect(low.error?.code).toBe("BINDING_INVALID");
    const foreignActor = provider.runObserved("plan_workflow", input, () => ({ ...context, actorId: "another-actor", toolUseId: "different-call" }),
      (args) => service.planWorkflow(args, true));
    expect(foreignActor.error?.code).toBe("BINDING_REQUIRED");
    let signed: Record<string, unknown> = {};
    provider.runObserved("plan_workflow", input, () => context, (args) => { signed = args; });
    // The wrapper's callback gets token-free arguments, so it cannot leak a reusable token to a caller.
    expect(signed[HOST_ATTESTATION_FIELD]).toBeUndefined();
    expect(provider.observe({ phase: "bootstrap", taskId: task.taskId, runId: null, stageId: null, revision: null })).toBeNull();
  });
});
