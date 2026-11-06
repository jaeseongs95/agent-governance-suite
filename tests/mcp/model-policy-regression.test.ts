import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { REASONING_EFFORT } from "../../contracts/types.js";
import { createCatalogExecutionAdapters, codexExecutionAdapter, claudeCodeExecutionAdapter, geminiExecutionAdapter } from "../../mcp-server/src/host-execution-adapters.js";
import { resolveAdapterModelCapability } from "../../mcp-server/src/host-attestation.js";
import { resolveCatalogModel } from "../../skills/coordinate-subagents/scripts/model-catalog-adapter.mjs";
import { resolveModelSelection } from "../../skills/coordinate-subagents/scripts/model-routing.mjs";
import { guardModelSupport } from "../../skills/model-effort-advisor/scripts/support-guard.mjs";
import presets from "../../skills/coordinate-subagents/references/model-routing-presets.json" with { type: "json" };

const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const readJson = (relative: string) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
const advice = readJson("../model-effort-advisor/behavior-cases.json").cases.find((entry: { output: { verdict: string } }) => entry.output.verdict === "ADEQUATE").output;

function options(effort: string, highRisk = false, modelClass: string | null = "general") {
  return { provider: "opaque-provider", role: "general-implementation", highRisk,
    user: { model: "opaque-model", effort },
    supported: [{ model: "opaque-model", modelClass, efforts }],
  };
}

describe("AGS3-D-0009/0017/0018 shared model policy", () => {
  it.each([
    ["openai-codex", codexExecutionAdapter, "gpt-999-sol"],
    ["anthropic-claude-code", claudeCodeExecutionAdapter, "claude-sonnet-999"],
    ["google-gemini", geminiExecutionAdapter, "gemini-999-pro"],
  ] as const)("does not infer an unregistered release for %s", (provider, adapter, model) => {
    expect(resolveAdapterModelCapability(adapter, model)).toBeNull();
    for (const inheritOnly of [false, true]) {
      expect(resolveModelSelection({ provider, role: "general-implementation", highRisk: true,
        user: { model, effort: "high" }, inherited: { model, effort: "high" }, inheritOnly,
        supported: [{ model, modelClass: "frontier", efforts: ["high"] }],
      }).delivery).toBe("blocked");
    }
  });

  it("resolves arbitrary providers through exact catalog and explicit alias evidence", () => {
    const catalog = { matching: "exact-only" as const,
      models: { "opaque-model": { model_class: "general" as const, supported_efforts: ["high" as const] } },
      aliases: { "opaque-alias": "opaque-model" } };
    expect(resolveCatalogModel(catalog, "opaque-alias")).toBe("opaque-model");
    expect(resolveCatalogModel(catalog, "opaque-model-next")).toBeNull();
    const suite = createCatalogExecutionAdapters({ schema_version: 1, policy_revision: "opaque-r1",
      model_class_order: ["lightweight", "general", "deep", "frontier"], effort_order: ["high"],
      providers: { "opaque-provider": { host: "opaque-host", catalog } } });
    expect(resolveAdapterModelCapability(suite.adapters.get("opaque-host")!, "opaque-alias")).toMatchObject({ modelClass: "general", resolvedModel: "opaque-model" });
  });

  it.each(efforts)("retains %s across contracts, routing and advisor", (effort) => {
    expect(REASONING_EFFORT).toEqual(efforts);
    expect(presets.effort_order).toEqual(efforts);
    expect(resolveModelSelection(options(effort)).selection).toEqual({ model: "opaque-model", effort });
    const ajv = new Ajv2020({ strict: false });
    (addFormats as unknown as (ajv: Ajv2020) => void)(ajv);
    const validate = ajv.compile(readJson("../../contracts/execution-context.v1.schema.json"));
    expect(validate({ schemaVersion: "1.0.0", model: "opaque-model", modelClass: "general", reasoningEffort: effort, source: "runtime", observedAt: "2026-11-07T00:00:00Z" }), JSON.stringify(validate.errors)).toBe(true);
    const result = guardModelSupport(advice, { currentSelection: { source: "runtime", provider: "opaque-provider", model: "opaque-model", reasoningEffort: effort },
      supportEvidence: { kind: "host-runtime", provider: "opaque-provider", locator: "fixture:observed", models: [{ id: "opaque-model", modelClass: "general", reasoningEfforts: efforts }] } });
    expect(result.supportStatus).toBe("SUPPORTED");
    expect(result.advice.observation.reasoningEffort).toBe(effort);
  });

  it.each([["general", "high", "explicit"], ["lightweight", "high", "blocked"], ["general", "medium", "blocked"], [null, "high", "blocked"]])("keeps risk floor for %s/%s", (modelClass, effort, delivery) => {
    const input = options(effort!, true, modelClass);
    expect(resolveModelSelection(input).delivery).toBe(delivery);
    expect(resolveModelSelection({ ...input, inheritOnly: true, inherited: input.user }).delivery).toBe(delivery === "explicit" ? "inherited" : "blocked");
    const weakened = structuredClone(presets);
    weakened.invariants.high_risk_minimum_model_class = "lightweight";
    weakened.invariants.high_risk_minimum_effort = "low";
    expect(resolveModelSelection(input, weakened).delivery).toBe(delivery);
  });

  it("makes execution floors consume the routing policy rather than another literal", () => {
    const source = readFileSync(fileURLToPath(new URL("../../mcp-server/src/workflow-service.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/minimumModelClass:\s*highRisk\s*\?\s*"general"/u);
    expect(source).not.toMatch(/minimumReasoningEffort:\s*highRisk\s*\?\s*"high"/u);
  });
});
