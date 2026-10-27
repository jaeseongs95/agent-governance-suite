import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { assertRegistryAuthority } from "../../scripts/check-skill-context-optimization.mjs";

const read = (relative) => JSON.parse(readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8"));

describe("independent registry authority invariants", () => {
  it("checks both the current registry and the reviewed comparison fixture", () => {
    assertRegistryAuthority(read("skills/registry.json"));
    assertRegistryAuthority(read("scripts/fixtures/registry-contract.3.0.json"));
  });
  it("rejects a paired audit-gate mutation through the public standalone checker", async () => {
    const registry = read("skills/registry.json");
    registry.skills.find((item) => item.skillId === "independent-audit-gate").providers[0].gate.policy = "none";
    const fs = await import("node:fs");
    vi.doMock("node:fs", () => ({...fs, readFileSync: (file, ...args) => String(file).replaceAll("\\", "/").endsWith("/scripts/fixtures/registry-contract.3.0.json") ? JSON.stringify(registry) : fs.readFileSync(file, ...args)}));
    try {
      vi.resetModules();
      const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      expect(checker.checkRegistryContextCompatibility(registry)).toContain("registry violates independent authority invariants");
    } finally { vi.doUnmock("node:fs"); vi.resetModules(); }
  });
  it.each([
    ["independent-deliberation-panel", "constraints"],
    ["independent-audit-gate", "rollback-or-recovery-evidence"],
    ["mutation-risk-preflight", "authorization-boundary"],
  ])("rejects duplicate protected binding on %s for %s", (id, target) => {
    for (const variation of ["same", "different-source", "different-operation"]) {
      const registry = read("skills/registry.json");
      const provider = registry.skills.find((skill) => skill.skillId === id).providers[0];
      const copy = structuredClone(provider.inputBindings.find((binding) => binding.targetArtifact === target));
      if (variation === "different-source") copy.sources = ["task:untrusted-authority"];
      if (variation === "different-operation") copy.operation = "select";
      provider.inputBindings.push(copy);
      const pairedFixture = structuredClone(registry);
      expect(registry).toEqual(pairedFixture);
      expect(() => assertRegistryAuthority(registry), variation).toThrow();
      expect(() => assertRegistryAuthority(pairedFixture), variation).toThrow();
    }
  });
  it.each(["solid-role", "solid-gate", "solid-source", "solid-schema", "audit-gate", "audit-recovery", "preflight-authority", "panel-authority", "panel-gate", "audit-disabled", "audit-capability", "audit-outranked", "duplicate-id", "ambiguous-capability"])(
    "rejects the same invalid change to registry and fixture: %s", (change) => {
      const registry = read("skills/registry.json");
      const skill = (id) => registry.skills.find((item) => item.skillId === id);
      const solid = skill("solid-design").providers[0], audit = skill("independent-audit-gate").providers[0];
      if (change === "solid-role") solid.executionClass = "workflow";
      if (change === "solid-gate") solid.gate.kind = "completion";
      if (change === "solid-source") solid.inputBindings[0].sources = ["untrusted:request"];
      if (change === "solid-schema") solid.resultSchema = "untrusted.json";
      if (change === "audit-gate") audit.gate.policy = "none";
      if (change === "audit-recovery") audit.inputBindings.find((item) => item.targetArtifact === "rollback-or-recovery-evidence").operation = "select";
      if (change === "preflight-authority") skill("mutation-risk-preflight").providers[0].inputBindings.find((item) => item.targetArtifact === "authorization-boundary").sources.push("untrusted:approval");
      if (change === "panel-authority") skill("independent-deliberation-panel").providers[0].inputBindings.find((item) => item.targetArtifact === "constraints").sources[1] = "task:untrusted-authority";
      if (change === "panel-gate") skill("independent-deliberation-panel").providers[0].gate.policy = "conditional";
      if (change === "audit-disabled") skill("independent-audit-gate").enabled = false;
      if (change === "audit-capability") audit.capabilities = ["not-independent-audit"];
      if (change === "audit-outranked") {skill("task-contract").priority = 100; skill("task-contract").providers[0].capabilities.push("independent-audit");}
      if (change === "duplicate-id") registry.skills.push(structuredClone(skill("solid-design")));
      if (change === "ambiguous-capability") skill("task-contract").providers[0].capabilities.push("solid-design-assessment");
      const pairedFixture = structuredClone(registry);
      expect(registry).toEqual(pairedFixture); // Existing pairwise equality alone accepts this mutation.
      expect(() => assertRegistryAuthority(registry)).toThrow();
      expect(() => assertRegistryAuthority(pairedFixture)).toThrow();
    },
  );
});
