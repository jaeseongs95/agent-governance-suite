import { describe, expect, it } from "vitest";

import "../../mcp-server/src/builtin-hook-host-adapters.js";
import { antigravityMetaIngress } from "../../mcp-server/src/builtin-caller-ingress.js";
import type { CallerExecution } from "../../mcp-server/src/caller-identity.js";
import { HOST_ATTESTATION_TOOLS, HostAttestationProvider, type HostExecutionAdapter } from "../../mcp-server/src/host-attestation.js";
import { adaptHostInput, hookExecutionObserver } from "../../mcp-server/src/host-input-adapter.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { childCaller, rootCaller } from "../helpers/caller.js";

// The catalog describes the models it knows; it never decides whether a model may run (AGS 3.1.1).
const known = "ags311-known-model";
const adapter: HostExecutionAdapter = {
  host: "ags311-host", provider: "ags311-provider", policyRevision: "ags311-r1",
  modelClassForModel: (model) => model === known ? "deep" : null,
  resolveModel: (model) => model === known ? {
    host: "ags311-host", provider: "ags311-provider", rawModel: known, resolvedModel: known, modelClass: "deep",
    minimumReasoningEffort: "high", supportedEfforts: ["high"], aliasUsed: false, policyRevision: "ags311-r1", provenance: "ags311",
  } : null,
};
const bootstrap = { phase: "bootstrap" as const, taskId: "ags311-task", runId: null, stageId: null, revision: null };
function observe(execution: CallerExecution, caller = rootCaller(adapter.host, "ags311-session", { execution })) {
  const provider = new HostAttestationProvider(adapter);
  return provider.run("start_workflow", { ...caller, execution }, () => provider.observe(bootstrap));
}

describe("AGS 3.1.1 a model the catalog does not name still runs", () => {
  it("observes an unknown model with no class and a note", () => {
    expect(observe({ model: "vendor-new-frontier-9", effort: "high", turnId: null, provenance: "ags311" }))
      .toMatchObject({ model: "vendor-new-frontier-9", modelClass: null, reasoningEffort: "high", policyNotes: ["MODEL_NOT_IN_CATALOG"] });
  });

  it("keeps an unknown or missing effort as null instead of refusing", () => {
    expect(observe({ model: known, effort: "hyper", turnId: null, provenance: "ags311" }))
      .toMatchObject({ modelClass: "deep", reasoningEffort: null, policyNotes: ["REASONING_EFFORT_UNRECOGNIZED"] });
    expect(observe({ model: known, effort: null, turnId: null, provenance: "ags311" }))
      .toMatchObject({ reasoningEffort: null, policyNotes: ["HOST_EFFORT_UNREPORTED"] });
  });

  it("records a catalog effort rule as a note, for a child caller too", () => {
    const caller = childCaller(adapter.host, "ags311-session", "ags311-agent");
    expect(observe({ model: known, effort: "low", turnId: null, provenance: "ags311" }, caller))
      .toMatchObject({ modelClass: "deep", reasoningEffort: "low", policyNotes: ["CURRENT_POLICY_EFFORT_UNSUPPORTED"] });
  });

  it("still refuses a descriptor that contradicts the observed model", () => {
    const broken: HostExecutionAdapter = { ...adapter, resolveModel: (model) => ({ ...adapter.resolveModel!(known)!, rawModel: `${model}-other` }) };
    const provider = new HostAttestationProvider(broken);
    expect(() => provider.run("start_workflow", rootCaller(adapter.host, "s", { execution: { model: known, effort: "high", turnId: null, provenance: "x" } }),
      () => provider.observe(bootstrap))).toThrow(expect.objectContaining({ code: "BINDING_INVALID", details: { reasonCode: "QUALIFICATION_CAPABILITY_MISMATCH" } }));
  });

  it("still sees nothing when the host observed nothing", () => {
    expect(observe({ unavailable: "HOST_SILENT" })).toBeNull();
  });
});

describe("AGS 3.1.1 agy call observation", () => {
  const conversation = "agy311-conversation";
  const args = { goal: "목표 한국어", stages: ["a", "b"], nested: { z: 1, a: [true, null] } };
  /** What the governance hook records for one agy PreToolUse (runner canonical input). */
  function hookRecord(store: InMemoryWorkflowStore, model: string, toolInput: unknown = args, sessionId = conversation) {
    const input = { hook_event_name: "PreToolUse", session_id: sessionId, model,
      tool_name: "mcp__agent-governance-suite__start_workflow", tool_input: toolInput };
    const { observation } = adaptHostInput(input, "antigravity");
    const execution = hookExecutionObserver("antigravity")!(input, {});
    store.recordCallAdmission({ host: "antigravity", callId: observation.callId!, tool: "start_workflow", sessionId,
      agentId: null, execution, transcriptPath: null });
  }
  const meta = { "antigravity.google/conversation_id": conversation, "antigravity.google/root_conversation_id": conversation };

  it("splits agy's model name and effort suffix in the hook adapter", () => {
    const observe = hookExecutionObserver("antigravity")!;
    expect(observe({ model: "gemini-4-argon-medium" }, {})).toMatchObject({ model: "gemini-4-argon", effort: "medium" });
    expect(observe({ model: "claude-sonnet-5-5-high" }, {})).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
    expect(observe({ model: "some-new-model" }, {})).toMatchObject({ model: "some-new-model", effort: null });
    expect(observe({}, {})).toEqual({ unavailable: "ANTIGRAVITY_MODEL_NAME_MISSING" });
  });

  it("claims the hook row for the same conversation, tool and arguments once, whatever the key order", () => {
    const store = new InMemoryWorkflowStore();
    hookRecord(store, "gemini-4-argon-medium");
    const ingress = antigravityMetaIngress(store);
    const reordered = { nested: { a: [true, null], z: 1 }, stages: ["a", "b"], goal: "목표 한국어" };
    const first = ingress("start_workflow", meta, reordered);
    expect(first).toMatchObject({ provenance: "host-observed", caller: { actor: { role: "root" },
      execution: { model: "gemini-4-argon", effort: "medium", provenance: "antigravity:hook-model-name" } } });
    expect(first.provenance === "host-observed" && first.caller.callId).toBeTruthy();
    expect(ingress("start_workflow", meta, args)).toMatchObject({ caller: { callId: null, execution: { unavailable: "ANTIGRAVITY_OBSERVATION_MISSING" } } });
  });

  it("takes the newest row and drops older rows the host never sent on", () => {
    const store = new InMemoryWorkflowStore();
    hookRecord(store, "gemini-4-argon-low");
    hookRecord(store, "gemini-4-argon-high");
    const ingress = antigravityMetaIngress(store);
    expect(ingress("start_workflow", meta, args)).toMatchObject({ caller: { execution: { effort: "high" } } });
    expect(ingress("start_workflow", meta, args)).toMatchObject({ caller: { execution: { unavailable: "ANTIGRAVITY_OBSERVATION_MISSING" } } });
  });

  it("never lends a row to another conversation or other arguments", () => {
    const store = new InMemoryWorkflowStore();
    hookRecord(store, "gemini-4-argon-high", args, "agy311-other-conversation");
    hookRecord(store, "gemini-4-argon-high", { goal: "different" });
    const ingress = antigravityMetaIngress(store);
    expect(ingress("start_workflow", meta, args)).toMatchObject({ caller: { callId: null, execution: { unavailable: "ANTIGRAVITY_OBSERVATION_UNMATCHED" } } });
  });

  it("records only the tools the server observes", async () => {
    const runner = await import(new URL("../../antigravity-connector/hooks/antigravity-hook-runner.mjs", import.meta.url).href) as { OBSERVED_AGS_TOOLS: Set<string> };
    expect([...runner.OBSERVED_AGS_TOOLS].sort()).toEqual([...HOST_ATTESTATION_TOOLS].sort());
  });
});
