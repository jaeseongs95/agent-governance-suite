import { describe, expect, it } from "vitest";
import { HostAttestationProvider, type HostExecutionAdapter } from "../../mcp-server/src/host-attestation.js";
import { rootCaller } from "../helpers/caller.js";

const binding = { phase: "bootstrap" as const, taskId: "diagnostics-task", runId: null, stageId: null, revision: null };
const model = "diagnostics-model";
const host = "diagnostics-host";

function fixture() {
  let revision = "diagnostics-r1";
  const adapter: HostExecutionAdapter = {
    host, provider: "diagnostics-provider", modelClassForModel: () => null,
    resolveModel: rawModel => rawModel === model ? {
      host, provider: "diagnostics-provider", rawModel, resolvedModel: model, modelClass: "deep",
      supportedEfforts: ["high"], minimumReasoningEffort: "high", aliasUsed: false,
      policyRevision: revision, provenance: "diagnostics-owned",
    } : null,
  };
  const provider = new HostAttestationProvider(adapter, () => new Date("2026-11-07T00:00:00Z"));
  let sequence = 0;
  const observe = (selectedModel = model) => provider.run("plan_workflow",
    rootCaller(host, "diagnostics-session", { callId: `diagnostics-call-${++sequence}`,
      execution: { model: selectedModel, effort: "high", turnId: null, provenance: "diagnostics-owned" } }),
    () => provider.observe(binding));
  return { provider, observe, setRevision: (value: string) => { revision = value; } };
}

describe("AGS3-D-0021 public call observation without test-only retained capability", () => {
  it("HC01 observes the current call across success, absence, unknown model and recovery", () => {
    const f = fixture();
    expect(f.observe()).toMatchObject({ model, modelClass: "deep", reasoningEffort: "high" });
    expect(f.provider.observe(binding)).toBeNull();
    expect(f.provider.run("plan_workflow", rootCaller(host, "diagnostics-session", {
      callId: "unavailable-call", execution: { unavailable: "FIXTURE_UNAVAILABLE" },
    }), () => f.provider.observe(binding))).toBeNull();
    expect(f.observe("unknown-model")).toMatchObject({ model: "unknown-model", modelClass: null,
      policyNotes: ["MODEL_NOT_IN_CATALOG"] });
    expect(f.observe()).toMatchObject({ model, modelClass: "deep", reasoningEffort: "high" });
    expect("lastObservedCapability" in f.provider).toBe(false);
  });

  it("HC02 preserves a descriptor failure and the next public observation", () => {
    const f = fixture();
    f.setRevision("");
    expect(() => f.observe()).toThrow(expect.objectContaining({ code: "BINDING_INVALID",
      details: { reasonCode: "QUALIFICATION_POLICY_REVISION_MISMATCH" } }));
    f.setRevision("diagnostics-r2");
    expect(f.observe()).toMatchObject({ model, modelClass: "deep" });
  });
});
