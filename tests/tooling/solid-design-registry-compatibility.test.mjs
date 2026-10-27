import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkRegistryContextCompatibility } from "../../scripts/check-skill-context-optimization.mjs";

const readRegistry = () => JSON.parse(readFileSync(new URL("../../skills/registry.json", import.meta.url), "utf8"));

describe("additive SOLID registry compatibility", () => {
  it("accepts the exact addition while retaining the full 3.0 registry contract", () => {
    const registry = readRegistry();
    const descriptor = registry.skills.find((skill) => skill.skillId === "solid-design");
    const direct = JSON.parse(readFileSync(new URL("../../skills/solid-design/integration/skill-descriptor.json", import.meta.url), "utf8"));
    expect(descriptor).toEqual(direct);
    expect(descriptor.providers).toHaveLength(1);
    expect(descriptor.providers[0]).toMatchObject({executionClass: "bootstrap", phaseOrder: 26, gate: {kind: "none", policy: "none", validator: null}});
    expect(checkRegistryContextCompatibility(registry)).toEqual([]);
  });

  it.each(["missing", "duplicate", "authority-change"])("rejects an invalid addition: %s", (change) => {
    const registry = readRegistry();
    const descriptor = registry.skills.find((skill) => skill.skillId === "solid-design");
    if (change === "missing") registry.skills = registry.skills.filter((skill) => skill !== descriptor);
    if (change === "duplicate") registry.skills.push(structuredClone(descriptor));
    if (change === "authority-change") descriptor.providers[0].gate = { kind: "completion", policy: "mandatory", validator: null };
    expect(checkRegistryContextCompatibility(registry)).toContain("registry differs from the 3.0 contract");
  });

  it.each([
    ["task-contract", "registry differs from the 3.0 contract"],
    ["code-review", "registry differs from the 3.0 contract"],
  ])("keeps the pre-existing descriptor pin for %s", (skillId, expected) => {
    const registry = readRegistry();
    registry.skills.find((skill) => skill.skillId === skillId).priority += 1;
    expect(checkRegistryContextCompatibility(registry)).toContain(expected);
  });

  it("does not exclude an arbitrary new skill from the 3.0 contract", () => {
    const registry = readRegistry();
    registry.skills.push({ ...structuredClone(registry.skills.at(-1)), skillId: "unexpected-specialist", path: "./unexpected-specialist" });
    expect(checkRegistryContextCompatibility(registry)).toContain("registry differs from the 3.0 contract");
  });
  it.each(["gate", "capabilities", "input-binding", "result-schema"])("rejects contract drift in %s", (field) => {
    const registry = readRegistry();
    const provider = registry.skills.find((skill) => skill.skillId === "solid-design").providers[0];
    if (field === "gate") provider.gate.kind = "completion";
    if (field === "capabilities") provider.capabilities.push("unexpected-authority");
    if (field === "input-binding") provider.inputBindings[0].operation = "replace";
    if (field === "result-schema") provider.resultSchema = "untrusted.json";
    expect(checkRegistryContextCompatibility(registry)).toContain("registry differs from the 3.0 contract");
  });
  it.each(["authority-source", "existing-gate", "existing-schema", "existing-duplicate"])("retains existing trust and contract protection: %s", (change) => {
    const registry = readRegistry();
    const skill = registry.skills.find((item) => item.skillId === "independent-deliberation-panel");
    if (change === "authority-source") skill.providers[0].inputBindings[2].sources.push("untrusted-authority");
    if (change === "existing-gate") skill.providers[0].gate.kind = "completion";
    if (change === "existing-schema") skill.providers[0].resultSchema = "untrusted.json";
    if (change === "existing-duplicate") registry.skills.push(structuredClone(skill));
    expect(checkRegistryContextCompatibility(registry)).toContain("registry differs from the 3.0 contract");
  });
});
