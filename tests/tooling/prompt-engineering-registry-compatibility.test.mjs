import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkRegistryContextCompatibility } from "../../scripts/check-skill-context-optimization.mjs";

const readRegistry = () => JSON.parse(readFileSync(new URL("../../skills/registry.json", import.meta.url), "utf8"));
// Independently frozen from c53ad5947bc5cc6a4e076eb9931e454e300d5c3b:skills/registry.json.
// The current registry-contract fixture is deliberately not the oracle for old descriptors.
const BASELINE_DIGEST = "4b470ad0e10d748d59b359aaa96e1c81653e748e4a272cc3bf96ab107133e9c5";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("additive prompt-engineering registry integration", () => {
  it("preserves all 22 original descriptors and registry-level fields", () => {
    const registry = readRegistry();
    const withoutAddition = { ...registry, skills: registry.skills.filter((entry) => entry.skillId !== "prompt-engineering") };
    expect(withoutAddition.skills).toHaveLength(22);
    expect(digest(withoutAddition)).toBe(BASELINE_DIGEST);
    expect(registry.skills.filter((entry) => entry.skillId === "prompt-engineering")).toHaveLength(1);
  });

  it("exposes one optional workflow provider whose direct descriptor matches the registry", () => {
    const registry = readRegistry();
    const descriptor = registry.skills.find((entry) => entry.skillId === "prompt-engineering");
    const direct = JSON.parse(readFileSync(new URL("../../skills/prompt-engineering/integration/skill-descriptor.json", import.meta.url), "utf8"));
    expect(descriptor).toEqual(direct);
    expect(descriptor).toMatchObject({ schemaVersion: "2.0.0", version: "0.1.0", path: "./prompt-engineering", enabled: true, priority: 67 });
    expect(descriptor.providers).toHaveLength(1);
    expect(descriptor.providers[0]).toMatchObject({
      capabilities: ["prompt-engineering"], executionClass: "workflow", phase: "prompt-engineering", phaseOrder: 40,
      requiredInputArtifacts: ["prompt-engineering-request"],
      inputBindings: [{ targetArtifact: "prompt-engineering-request", sources: ["task:prompt-engineering-request"], operation: "require-external" }],
      producedArtifacts: ["prompt-engineering-report"],
      outputSchema: "skills/prompt-engineering/contracts/prompt-engineering-report.v1.schema.json",
      resultSchema: "contracts/provider-result.v1.schema.json", gate: { kind: "none", policy: "none", validator: null },
    });
    expect(registry.skills.flatMap((entry) => entry.providers).filter((provider) => provider.capabilities.includes("prompt-engineering"))).toHaveLength(1);
    expect(checkRegistryContextCompatibility(registry)).toEqual([]);
  });

  it("stage completion mapping cannot create independent audit or quality approval", () => {
    const provider = readRegistry().skills.find((entry) => entry.skillId === "prompt-engineering").providers[0];
    expect(provider.stateMapping).toEqual({
      selector: "/output/status",
      values: {
        ANALYZED: { state: "passed", errorRequired: false },
        NOT_APPLICABLE: { state: "passed", errorRequired: false },
        NEEDS_INPUT: { state: "blocked", errorRequired: true, allowedErrorCodes: ["MISSING_EVIDENCE"] },
      },
      default: "reject", adapterErrors: ["INVALID_INPUT", "MISSING_EVIDENCE", "INTEGRITY_FAILED"],
    });
  });

  it.each(["missing", "duplicate", "gate", "capability", "binding", "result-schema"])("rejects changed prompt provider registration: %s", (change) => {
    const registry = readRegistry();
    const descriptor = registry.skills.find((entry) => entry.skillId === "prompt-engineering");
    const provider = descriptor.providers[0];
    if (change === "missing") registry.skills = registry.skills.filter((entry) => entry !== descriptor);
    if (change === "duplicate") registry.skills.push(structuredClone(descriptor));
    if (change === "gate") provider.gate = { kind: "completion", policy: "mandatory", validator: null };
    if (change === "capability") provider.capabilities.push("release-gate");
    if (change === "binding") provider.inputBindings[0].sources = ["untrusted:approval"];
    if (change === "result-schema") provider.resultSchema = "contracts/freeform-output.v1.schema.json";
    expect(checkRegistryContextCompatibility(registry)).toContain("registry differs from the 3.0 contract");
  });

  it.each(["task-contract", "solid-design", "independent-audit-gate", "evaluation-validity-auditor"])("retains existing provider contracts for %s", (skillId) => {
    const registry = readRegistry();
    registry.skills.find((entry) => entry.skillId === skillId).priority += 1;
    expect(checkRegistryContextCompatibility(registry)).toContain("registry differs from the 3.0 contract");
    const withoutAddition = { ...registry, skills: registry.skills.filter((entry) => entry.skillId !== "prompt-engineering") };
    expect(digest(withoutAddition)).not.toBe(BASELINE_DIGEST);
  });
});
