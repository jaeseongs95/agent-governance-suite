import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

const read = (relative) => JSON.parse(readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8"));

// Independent review points: these literal security contracts do not come from
// registry-contract.3.0.json. Expand them only with separately reviewed policy.
function assertAuthority(registry) {
  const ids = registry.skills.map((skill) => skill.skillId);
  assert.equal(new Set(ids).size, ids.length, "duplicate skill ID");
  const one = (id) => {
    const matches = registry.skills.filter((skill) => skill.skillId === id);
    assert.equal(matches.length, 1, `${id}: missing or duplicate`);
    assert.equal(matches[0].providers.length, 1, `${id}: provider count`);
    return matches[0].providers[0];
  };
  const solid = one("solid-design");
  assert.equal(solid.executionClass, "bootstrap");
  assert.equal(solid.phase, "solid-design-assessment");
  assert.equal(solid.phaseOrder, 26);
  assert.deepEqual(solid.capabilities, ["solid-design-assessment"]);
  assert.deepEqual(solid.gate, {kind: "none", policy: "none", validator: null});
  assert.deepEqual(solid.inputBindings, [{targetArtifact: "solid-design-request", sources: ["task:solid-design-request"], operation: "require-external"}]);
  assert.equal(solid.outputSchema, "skills/solid-design/contracts/solid-design-report.v1.schema.json");
  assert.equal(solid.resultSchema, "contracts/provider-result.v1.schema.json");
  assert.equal(registry.skills.flatMap((skill) => skill.providers).filter((provider) => provider.capabilities.includes("solid-design-assessment")).length, 1, "ambiguous SOLID capability");
  const panel = one("independent-deliberation-panel");
  assert.equal(panel.executionClass, "workflow");
  assert.equal(panel.phase, "decision-analysis");
  assert.deepEqual(panel.gate, {kind: "none", policy: "none", validator: "skills/independent-deliberation-panel/contracts/decision-record.v1.schema.json"});
  assert.deepEqual(panel.inputBindings.find((binding) => binding.targetArtifact === "constraints"), {
    targetArtifact: "constraints", sources: ["task-envelope:constraints", "task-envelope:authorization"], operation: "combine",
  });
  const audit = one("independent-audit-gate");
  assert.equal(audit.executionClass, "workflow");
  assert.equal(audit.phase, "completion-gate");
  assert.deepEqual(audit.gate, {kind: "completion", policy: "mandatory", validator: "independent-audit"});
  assert(audit.producedArtifacts.includes("gate-verdict"), "audit verdict missing");
  assert.deepEqual(audit.inputBindings.find((binding) => binding.targetArtifact === "rollback-or-recovery-evidence"), {
    targetArtifact: "rollback-or-recovery-evidence", sources: ["recovery-evidence", "workflow:rollback-evidence"], operation: "require-external",
  });
  const preflight = one("mutation-risk-preflight");
  assert.deepEqual(preflight.gate, {kind: "precondition", policy: "conditional", validator: "skills/mutation-risk-preflight/contracts/mutation-preflight-report.v1.schema.json"});
  assert.deepEqual(preflight.inputBindings.find((binding) => binding.targetArtifact === "authorization-boundary"), {
    targetArtifact: "authorization-boundary", sources: ["bootstrap:task-envelope.authorization", "mutation-intent.authorizationRef"], operation: "combine",
  });
}

describe("independent registry authority invariants", () => {
  it("checks both the current registry and the reviewed comparison fixture", () => {
    assertAuthority(read("skills/registry.json"));
    assertAuthority(read("scripts/fixtures/registry-contract.3.0.json"));
  });
  it.each(["solid-role", "solid-gate", "solid-source", "solid-schema", "audit-gate", "audit-recovery", "preflight-authority", "panel-authority", "panel-gate", "duplicate-id", "ambiguous-capability"])(
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
      if (change === "duplicate-id") registry.skills.push(structuredClone(skill("solid-design")));
      if (change === "ambiguous-capability") skill("task-contract").providers[0].capabilities.push("solid-design-assessment");
      const pairedFixture = structuredClone(registry);
      expect(registry).toEqual(pairedFixture); // Existing pairwise equality alone accepts this mutation.
      expect(() => assertAuthority(registry)).toThrow();
      expect(() => assertAuthority(pairedFixture)).toThrow();
    },
  );
});
