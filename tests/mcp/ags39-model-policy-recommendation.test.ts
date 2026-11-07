import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import { defaultModelRoutingPresets } from "../../runtime/model-catalog-adapter.mjs";
import { getPolicyRevision, recordModelApplication, resolveModelSelection } from "../../skills/coordinate-subagents/scripts/model-routing.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const codexSupported = [
  { model: "gpt-5.6-luna", modelClass: "lightweight", efforts: ["low", "medium", "high"] },
  { model: "gpt-5.6-terra", modelClass: "general", efforts: ["medium", "high"] },
];

// AGS3-D-0058: model class and effort order recommendations; they never refuse a host-supported combination.
describe("AGS3-D-0058 routing recommends instead of refusing", () => {
  it("R1 keeps a supported lightweight user choice for high-risk work", () => {
    const plan = resolveModelSelection({ provider: "openai-codex", role: "general-implementation", highRisk: true,
      user: { model: "gpt-5.6-luna", effort: "high" }, supported: codexSupported });
    expect(plan).toMatchObject({ delivery: "explicit", selection: { model: "gpt-5.6-luna", effort: "high" } });
  });

  it("R2 keeps an unregistered model the host supports, with or without a catalog", () => {
    for (const provider of ["openai-codex", "opaque-provider"]) {
      const supported = [{ model: "unregistered-model-next", modelClass: null, efforts: ["low"] }];
      expect(resolveModelSelection({ provider, role: "discovery", highRisk: true,
        user: { model: "unregistered-model-next", effort: "low" }, supported }).selection)
        .toEqual({ model: "unregistered-model-next", effort: "low" });
      expect(resolveModelSelection({ provider, role: "discovery", highRisk: true, inheritOnly: true,
        inherited: { model: "unregistered-model-next", effort: "low" }, supported }))
        .toMatchObject({ delivery: "inherited", selection: { model: "unregistered-model-next", effort: "low" } });
    }
  });

  it("R3 falls back from the high-risk recommendation to the role preset when only a lightweight model exists", () => {
    const options = { provider: "openai-codex", profile: "balanced", role: "discovery", highRisk: true,
      supported: [{ model: "gpt-5.6-luna", modelClass: "lightweight", efforts: ["high"] }] };
    const plan = resolveModelSelection(options);
    expect(plan.delivery).toBe("explicit");
    expect(plan.selection).toEqual({ model: "gpt-5.6-luna", effort: "high" });
    expect(plan.requested?.model).toBe("gpt-5.6-terra");
    expect(plan.fallbackReason).toBeTruthy();
    const recorded = recordModelApplication({ assignmentId: "d0058-r3", selectionReason: "Only a lightweight model is available",
      contextMode: "limited", options, observation: null,
      spawnArguments: { model: "gpt-5.6-luna", reasoning_effort: "high", fork_turns: "none" } });
    expect(recorded.dispatched).toEqual({ model: "gpt-5.6-luna", effort: "high" });
  });

  it("R4 lets high-risk work inherit unobservable settings like any other work", () => {
    expect(resolveModelSelection({ provider: "openai-codex", role: "independent-audit", highRisk: true,
      inheritOnly: true, inheritanceSupported: true, supported: [] })).toMatchObject({ delivery: "inherited", selection: null });
  });

  it("R5 blocks only when the host offers no usable combination", () => {
    expect(resolveModelSelection({ provider: "openai-codex", role: "discovery", highRisk: true, supported: [] }).delivery).toBe("blocked");
  });
});

describe("AGS3-D-0018/0007 one recommendation definition owned by core", () => {
  it("B1 keeps the high-risk recommendation only in the shared policy contract", () => {
    const presets = defaultModelRoutingPresets as { invariants: Record<string, unknown> };
    expect(Object.keys(presets.invariants).filter(key => key.startsWith("high_risk"))).toEqual([]);
  });

  it("B2 serves the routing catalog from runtime, and the skill reads that same file", () => {
    const runtimeCatalog = JSON.parse(readFileSync(path.join(root, "runtime/model-routing-presets.json"), "utf8"));
    expect(defaultModelRoutingPresets).toEqual(runtimeCatalog);
    expect(getPolicyRevision()).toBe(runtimeCatalog.policy_revision);
  });

  it.each(["runtime/model-catalog-adapter.mjs", "mcp-server/src/host-execution-adapters.ts", "mcp-server/src/workflow-service.ts"])(
    "B3 bundles %s with every skills/ file unavailable", async (entry) => {
      const blocked: string[] = [];
      const result = await build({ entryPoints: [path.join(root, entry)], bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
        plugins: [{ name: "no-skill-files", setup(builder) {
          builder.onResolve({ filter: /(^|[\\/])skills[\\/]/u }, args => { blocked.push(args.path); return { errors: [{ text: "skill file unavailable to core" }] }; });
        } }] }).catch((error: { errors?: unknown[] }) => ({ errors: error.errors ?? [error] }));
      expect(blocked).toEqual([]);
      expect(result.errors).toEqual([]);
    });
});
