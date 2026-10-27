import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { RegistryAuthorityViolation, assertRegistryAuthority, checkRegistryContextCompatibility } from "../../scripts/check-skill-context-optimization.mjs";

const read = (relative) => JSON.parse(readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8"));

function expectViolation(registry, expectedCode) {
  let caught;
  try { assertRegistryAuthority(registry); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(RegistryAuthorityViolation);
  expect(caught.constructor.name).toBe("RegistryAuthorityViolation");
  expect(caught.code).toBe(expectedCode);
}

describe("independent registry authority invariants", () => {
  it("checks both the current registry and the reviewed comparison fixture", () => {
    assertRegistryAuthority(read("skills/registry.json"));
    assertRegistryAuthority(read("scripts/fixtures/registry-contract.3.0.json"));
  });
  it("reports a fixed item code without exposing untrusted actual or expected values", () => {
    const registry = read("skills/registry.json");
    const audit = registry.skills.find((item) => item.skillId === "independent-audit-gate").providers[0];
    audit.inputBindings[2].sources = ["PRIVATE_SECRET_VALUE"];
    const errors = checkRegistryContextCompatibility(registry);
    expect(errors).toContain("registry authority violation: AUDIT_BINDINGS");
    expect(JSON.stringify(errors)).not.toContain("PRIVATE_SECRET_VALUE");
    expect(JSON.stringify(errors)).not.toContain("verified-evidence-index:locators");
    expect(JSON.stringify(errors)).not.toContain("actual");
    expect(JSON.stringify(errors)).not.toContain("expected");
  });
  it("propagates an unexpected programming error instead of reporting an invariant violation", () => {
    const registry = read("skills/registry.json");
    const fault = new Error("SYNTHETIC_PROGRAMMING_ERROR");
    registry.skills = new Proxy(registry.skills, {get(target, key, receiver) {
      if (key === "map") throw fault;
      return Reflect.get(target, key, receiver);
    }});
    expect(() => checkRegistryContextCompatibility(registry)).toThrow(fault);
  });
  it("preserves the identity of unexpected TypeError inside a protected rule", () => {
    const registry = read("skills/registry.json");
    const audit = registry.skills.find((item) => item.skillId === "independent-audit-gate").providers[0];
    const fault = new TypeError("SYNTHETIC_UNEXPECTED_TYPE_ERROR");
    Object.defineProperty(audit, "gate", {get() { throw fault; }});
    let caught;
    try { assertRegistryAuthority(registry); } catch (error) { caught = error; }
    expect(caught).toBe(fault);
    expect(caught).toBeInstanceOf(TypeError);
    caught = undefined;
    try { checkRegistryContextCompatibility(registry); } catch (error) { caught = error; }
    expect(caught).toBe(fault);
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
      const code = id === "independent-deliberation-panel" ? "PANEL_BINDINGS" : id === "independent-audit-gate" ? "AUDIT_BINDINGS" : "PREFLIGHT_BINDINGS";
      expectViolation(registry, code);
      expectViolation(pairedFixture, code);
    }
  });
  it.each(["solid-role", "solid-gate", "solid-source", "solid-schema", "audit-gate", "audit-recovery", "preflight-authority", "panel-authority", "panel-gate", "audit-disabled", "audit-capability", "audit-outranked", "audit-raw-duplicate", "audit-result-schema", "audit-output-schema", "audit-required-raw", "audit-state-map", "duplicate-id", "ambiguous-capability"])(
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
      if (change === "audit-raw-duplicate") audit.inputBindings.push({targetArtifact: "raw-verification-results", sources: ["task:untrusted"], operation: "collect"});
      if (change === "audit-result-schema") audit.resultSchema = "untrusted.json";
      if (change === "audit-output-schema") audit.outputSchema = "untrusted.json";
      if (change === "audit-required-raw") audit.requiredInputArtifacts = audit.requiredInputArtifacts.filter((item) => item !== "raw-verification-results");
      if (change === "audit-state-map") audit.stateMapping.values.FAIL.state = "passed";
      if (change === "audit-disabled") skill("independent-audit-gate").enabled = false;
      if (change === "audit-capability") audit.capabilities = ["not-independent-audit"];
      if (change === "audit-outranked") {skill("task-contract").priority = 100; skill("task-contract").providers[0].capabilities.push("independent-audit");}
      if (change === "duplicate-id") registry.skills.push(structuredClone(skill("solid-design")));
      if (change === "ambiguous-capability") skill("task-contract").providers[0].capabilities.push("solid-design-assessment");
      const pairedFixture = structuredClone(registry);
      expect(registry).toEqual(pairedFixture); // Existing pairwise equality alone accepts this mutation.
      expect(() => assertRegistryAuthority(registry)).toThrow();
      expect(() => assertRegistryAuthority(pairedFixture)).toThrow();
      const codes = {
        "solid-role": "SOLID_EXECUTION", "solid-gate": "SOLID_GATE", "solid-source": "SOLID_BINDINGS", "solid-schema": "SOLID_RESULT_SCHEMA",
        "audit-gate": "AUDIT_GATE", "audit-recovery": "AUDIT_BINDINGS", "preflight-authority": "PREFLIGHT_BINDINGS", "panel-authority": "PANEL_BINDINGS", "panel-gate": "PANEL_GATE",
        "audit-disabled": "DESCRIPTOR_ENABLED", "audit-capability": "AUDIT_CAPABILITIES", "audit-outranked": "AUDIT_CAPABILITY_OWNER",
        "audit-raw-duplicate": "AUDIT_BINDINGS", "audit-result-schema": "AUDIT_RESULT_SCHEMA", "audit-output-schema": "AUDIT_OUTPUT_SCHEMA",
        "audit-required-raw": "AUDIT_REQUIRED_INPUTS", "audit-state-map": "AUDIT_STATE_MAPPING", "duplicate-id": "REGISTRY_DUPLICATE_ID", "ambiguous-capability": "SOLID_CAPABILITY_OWNER",
      };
      expectViolation(registry, codes[change]);
      expectViolation(pairedFixture, codes[change]);
    },
  );
});
