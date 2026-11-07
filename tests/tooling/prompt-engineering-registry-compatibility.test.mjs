// engineering-test-plan HC-02 — preserve the independent 22-descriptor historical oracle.
// Input/precondition: exact advisor successor, approved analyzer removal and pinned retirement history.
// Procedure: validate the live transition, restore only its predecessor descriptors/order, then apply the old additive projection.
// Expected/pass criterion: original count/digest unchanged; restored analyzer, changed/rolled-back advisor and all unrelated drift fail.
// RED: Linux 1aed triage case 7 (21 vs 22). TEST: pnpm exec vitest run tests/tooling/prompt-engineering-registry-compatibility.test.mjs
// Actual: NOT_RUN locally; only static checks are authorized.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { checkRegistryContextCompatibility, checkSkillContextOptimization } from "../../scripts/check-skill-context-optimization.mjs";

const readRegistry = () => JSON.parse(readFileSync(new URL("../../skills/registry.json", import.meta.url), "utf8"));
// Independently frozen from c53ad5947bc5cc6a4e076eb9931e454e300d5c3b:skills/registry.json.
// The current registry-contract fixture is deliberately not the oracle for old descriptors.
const BASELINE_DIGEST = "4b470ad0e10d748d59b359aaa96e1c81653e748e4a272cc3bf96ab107133e9c5";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const approvedHistory = checkSkillContextOptimization();
const purpose = approvedHistory.currentPurposeChange;
const retirement = approvedHistory.retiredSkills.find(entry => entry.skillIds.includes("codex-token-usage-analyzer"));
const previous = JSON.parse(execFileSync("git", ["show", `${retirement.revision}:skills/registry.json`], {
  cwd: new URL("../../", import.meta.url), encoding: "utf8",
}));
// Restore only the approved removal/purpose predecessors, then the preflight version successor.
// Every unrelated descriptor, field and ordering change still affects the original 22-descriptor hash.
// Later additive specialists are excluded explicitly without rewriting that oracle.
const historicalRegistry = (registry) => {
  expect(registry.skills.filter(entry => retirement.skillIds.includes(entry.skillId))).toHaveLength(0);
  const advisors = registry.skills.filter(entry => entry.skillId === "model-effort-advisor");
  expect(advisors).toHaveLength(1);
  expect(digest(advisors[0])).toBe(purpose.registryDescriptorSha256);
  const skills = registry.skills.map(entry => entry.skillId === "model-effort-advisor"
    ? previous.skills.find(source => source.skillId === entry.skillId) : entry);
  const retiredIndex = previous.skills.findIndex(entry => retirement.skillIds.includes(entry.skillId));
  expect(retiredIndex).toBeGreaterThanOrEqual(0);
  skills.splice(retiredIndex, 0, previous.skills[retiredIndex]);
  return {
    ...registry,
    skills: skills.filter((entry) => !["prompt-engineering", "ui-ux-design"].includes(entry.skillId)).map((entry) =>
      entry.skillId === "mutation-risk-preflight" && entry.version === "1.0.3"
        ? { ...entry, version: "1.0.1" } : entry),
  };
};

describe("additive prompt-engineering registry integration", () => {
  it("preserves all 22 original descriptors and registry-level fields", () => {
    const registry = readRegistry();
    const withoutAddition = historicalRegistry(registry);
    expect(withoutAddition.skills).toHaveLength(22);
    expect(digest(withoutAddition)).toBe(BASELINE_DIGEST);
    expect(registry.skills.filter((entry) => entry.skillId === "prompt-engineering")).toHaveLength(1);
  });

  it.each(["version", "priority", "gate", "bindings"])("rejects unrelated preflight descriptor drift: %s", (change) => {
    const registry = readRegistry();
    const descriptor = registry.skills.find((entry) => entry.skillId === "mutation-risk-preflight");
    if (change === "version") descriptor.version = "1.0.4";
    if (change === "priority") descriptor.priority += 1;
    if (change === "gate") descriptor.providers[0].gate.policy = "none";
    if (change === "bindings") descriptor.providers[0].inputBindings[0].sources = ["untrusted:approval"];
    expect(digest(historicalRegistry(registry))).not.toBe(BASELINE_DIGEST);
    expect(checkRegistryContextCompatibility(registry)).toContain("registry differs from the 3.0 contract");
  });

  it.each(["retired-analyzer", "advisor-rollback", "advisor-drift"])("rejects an unapproved live transition before historical projection: %s", change => {
    const registry = readRegistry();
    const advisorIndex = registry.skills.findIndex(entry => entry.skillId === "model-effort-advisor");
    if (change === "retired-analyzer") registry.skills.push(previous.skills.find(entry => entry.skillId === "codex-token-usage-analyzer"));
    if (change === "advisor-rollback") registry.skills[advisorIndex] = previous.skills.find(entry => entry.skillId === "model-effort-advisor");
    if (change === "advisor-drift") registry.skills[advisorIndex].priority += 1;
    expect(() => historicalRegistry(registry)).toThrow();
    expect(checkRegistryContextCompatibility(registry)).not.toEqual([]);
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
    const withoutAddition = historicalRegistry(registry);
    expect(digest(withoutAddition)).not.toBe(BASELINE_DIGEST);
  });
});
