// engineering-test-plan HC-03 — preserve the independent 23-descriptor historical oracle.
// Input/precondition: exact advisor successor, approved analyzer removal and pinned retirement history.
// Procedure: validate the live transition, restore only its predecessor descriptors/order, then remove the UI/UX addition.
// Expected/pass criterion: original count/digest unchanged; restored analyzer, changed/rolled-back advisor and all unrelated drift fail.
// RED: Linux 1aed triage case 28 (22 vs 23). TEST: pnpm exec vitest run tests/tooling/ui-ux-design-registry-compatibility.test.mjs
// Actual: NOT_RUN locally; only static checks are authorized.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import { checkRegistryContextCompatibility, checkSkillContextOptimization } from "../../scripts/check-skill-context-optimization.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const readRegistry = () => JSON.parse(readFileSync(new URL("../../skills/registry.json", import.meta.url), "utf8"));
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Independently frozen from c6f76414cbd07cd3ffe213bb1049a2779cf877c4:skills/registry.json.
// Never derive this oracle from the current comparison fixture or a new descriptor.
const BASELINE_DIGEST = "af305760e575a0774ba6c45edd0391d73405dcb90ee4ba5c0fca1e53c7278965";
const approvedHistory = checkSkillContextOptimization();
const purpose = approvedHistory.currentPurposeChange;
const retirement = approvedHistory.retiredSkills.find(entry => entry.skillIds.includes("codex-token-usage-analyzer"));
const previous = JSON.parse(execFileSync("git", ["show", `${retirement.revision}:skills/registry.json`], {
  cwd: root, encoding: "utf8",
}));
// AGS3-D-0007 (3.9.0): the CS review provider declares the stage validator core runs. That one approved field is
// removed before the historical digest, exactly as checkRegistryContextCompatibility adds it to the 3.0 contract;
// any other change to the descriptor still changes the digest.
const withoutStageValidator = (entry) => entry.skillId !== "cs-engineering" ? entry : {
  ...entry,
  providers: entry.providers.map((provider) => {
    if (!provider.capabilities.includes("cs-implementation-review")) return provider;
    expect(provider.stageValidator).toBe("skills/cs-engineering/scripts/validate.mjs");
    const rest = { ...provider };
    delete rest.stageValidator;
    return rest;
  }),
};
const withoutAddition = (registry) => {
  expect(registry.skills.filter(entry => retirement.skillIds.includes(entry.skillId))).toHaveLength(0);
  const advisors = registry.skills.filter(entry => entry.skillId === "model-effort-advisor");
  expect(advisors).toHaveLength(1);
  expect(digest(advisors[0])).toBe(purpose.registryDescriptorSha256);
  const skills = registry.skills.map(entry => entry.skillId === "model-effort-advisor"
    ? previous.skills.find(source => source.skillId === entry.skillId) : entry);
  const retiredIndex = previous.skills.findIndex(entry => retirement.skillIds.includes(entry.skillId));
  expect(retiredIndex).toBeGreaterThanOrEqual(0);
  skills.splice(retiredIndex, 0, previous.skills[retiredIndex]);
  return { ...registry, skills: skills.filter((entry) => entry.skillId !== "ui-ux-design").map(withoutStageValidator) };
};

describe("additive UI/UX specialist integration", () => {
  it("preserves all 23 main descriptors and registry-level fields", () => {
    const registry = readRegistry();
    expect(withoutAddition(registry).skills).toHaveLength(23);
    expect(digest(withoutAddition(registry))).toBe(BASELINE_DIGEST);
    expect(registry.skills.filter((entry) => entry.skillId === "ui-ux-design")).toHaveLength(1);
    expect(checkRegistryContextCompatibility(registry)).toEqual([]);
  });

  it.each(["retired-analyzer", "advisor-rollback", "advisor-drift"])("rejects an unapproved live transition before historical projection: %s", change => {
    const registry = readRegistry();
    const advisorIndex = registry.skills.findIndex(entry => entry.skillId === "model-effort-advisor");
    if (change === "retired-analyzer") registry.skills.push(previous.skills.find(entry => entry.skillId === "codex-token-usage-analyzer"));
    if (change === "advisor-rollback") registry.skills[advisorIndex] = previous.skills.find(entry => entry.skillId === "model-effort-advisor");
    if (change === "advisor-drift") registry.skills[advisorIndex].priority += 1;
    expect(() => withoutAddition(registry)).toThrow();
    expect(checkRegistryContextCompatibility(registry)).not.toEqual([]);
  });

  it("exposes one optional design provider with an external request and matching direct contract", () => {
    const registry = readRegistry();
    const descriptor = registry.skills.find((entry) => entry.skillId === "ui-ux-design");
    const direct = JSON.parse(readFileSync(new URL("../../skills/ui-ux-design/integration/skill-descriptor.json", import.meta.url), "utf8"));
    expect(descriptor).toEqual(direct);
    expect(descriptor).toMatchObject({ schemaVersion: "2.0.0", version: "0.1.0", path: "./ui-ux-design", enabled: true, priority: 67 });
    expect(descriptor.providers).toHaveLength(1);
    expect(descriptor.providers[0]).toMatchObject({
      capabilities: ["ui-ux-design"], executionClass: "workflow", phase: "ui-ux-design", phaseOrder: 40,
      requiredInputArtifacts: ["ui-ux-design-request"],
      inputBindings: [{ targetArtifact: "ui-ux-design-request", sources: ["task:ui-ux-design-request"], operation: "require-external" }],
      producedArtifacts: ["ui-ux-design-report"],
      outputSchema: "skills/ui-ux-design/contracts/ui-ux-design-report.v1.schema.json",
      resultSchema: "contracts/provider-result.v1.schema.json", gate: { kind: "none", policy: "none", validator: null },
    });
    expect(registry.skills.flatMap((entry) => entry.providers).filter((provider) => provider.capabilities.includes("ui-ux-design"))).toHaveLength(1);
  });

  it("keeps missing input blocked and completion limited to this specialist stage", () => {
    const provider = readRegistry().skills.find((entry) => entry.skillId === "ui-ux-design").providers[0];
    expect(provider.stateMapping).toEqual({
      selector: "/output/status",
      values: {
        ANALYZED: { state: "passed", errorRequired: false },
        NOT_APPLICABLE: { state: "passed", errorRequired: false },
        NEEDS_INPUT: { state: "blocked", errorRequired: true, allowedErrorCodes: ["MISSING_EVIDENCE"] },
      },
      default: "reject", adapterErrors: ["INVALID_INPUT", "MISSING_EVIDENCE", "INTEGRITY_FAILED"],
    });
    expect(provider.gate).toEqual({ kind: "none", policy: "none", validator: null });
  });

  it("loads the new classification from current evidence outside the historical snapshot", async () => {
    const inventory = await loadSkillInventory({ root });
    expect(inventory.issues).toEqual([]);
    const skill = inventory.skills.find((entry) => entry.skillId === "ui-ux-design");
    expect(skill).toMatchObject({ version: "0.1.0", enabled: true, capabilities: ["ui-ux-design"] });
    const relative = "skills/ui-ux-design/SKILL.md";
    const bytes = readFileSync(path.join(root, relative));
    const instructions = bytes.toString("utf8");
    const commonBehavior = "../independent-audit-gate/references/specialist-behavior.md";
    const navigation = `이 스킬을 적용할 때 [공통 행동 기준](${commonBehavior})을 먼저 읽고 따르라.`;
    expect(instructions.split(navigation)).toHaveLength(2);
    const links = [...instructions.matchAll(/\[[^\]]*\]\(([^)\s]*specialist-behavior\.md)\)/gu)];
    expect(links.map((match) => match[1])).toEqual([commonBehavior]);
    const sourceDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const metadata = JSON.parse(readFileSync(path.join(root, "skills/ui-ux-design/classification.json"), "utf8"));
    for (const group of ["applicability", "exclusions"]) {
      expect(metadata[group].length).toBeGreaterThan(0);
      for (const span of metadata[group]) {
        expect(span.path).toBe(relative);
        expect(span.digest).toBe(sourceDigest);
        const selected = instructions.split(/\r?\n/u).slice(span.startLine - 1, span.endLine).join("\n").trim();
        expect(selected.length).toBeGreaterThan(0);
        expect(skill[group]).toContain(selected);
      }
    }
    expect(skill.sourceRefs).toContainEqual({ path: relative, digest: sourceDigest });
    expect(skill.applicability.filter((text) => skill.exclusions.includes(text))).toEqual([]);
  });

  it("does not exempt an arbitrary new directory from the historical source inventory", async () => {
    const unexpected = "unexpected-specialist";
    vi.doMock("node:fs", () => ({
      readFileSync: (file, ...args) => {
        if (String(file).replaceAll("\\", "/").endsWith(`/skills/${unexpected}/SKILL.md`)) return Buffer.from("unreviewed specialist\n");
        return readFileSync(file, ...args);
      },
      readdirSync: (directory, options) => {
        const entries = readdirSync(directory, options);
        return path.resolve(String(directory)) === path.join(root, "skills")
          ? [...entries, { name: unexpected, isDirectory: () => true }] : entries;
      },
    }));
    try {
      vi.resetModules();
      const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      const report = checker.checkSpecialistBehaviorSources();
      expect(report.pass).toBe(false);
      expect(report.errors).toContain("specialist behavior entry inventory differs from the 26 pinned skills");
    } finally { vi.doUnmock("node:fs"); vi.resetModules(); }
  });

  it.each(["missing", "duplicate", "gate", "capability", "binding", "result-schema", "missing-input-pass"])("rejects unreviewed UI/UX contract drift: %s", (change) => {
    const registry = readRegistry();
    const descriptor = registry.skills.find((entry) => entry.skillId === "ui-ux-design");
    const provider = descriptor.providers[0];
    if (change === "missing") registry.skills = registry.skills.filter((entry) => entry !== descriptor);
    if (change === "duplicate") registry.skills.push(structuredClone(descriptor));
    if (change === "gate") provider.gate = { kind: "completion", policy: "mandatory", validator: null };
    if (change === "capability") provider.capabilities.push("release-gate");
    if (change === "binding") provider.inputBindings[0].sources = ["untrusted:approval"];
    if (change === "result-schema") provider.resultSchema = "contracts/freeform-output.v1.schema.json";
    if (change === "missing-input-pass") provider.stateMapping.values.NEEDS_INPUT = { state: "passed", errorRequired: false };
    expect(checkRegistryContextCompatibility(registry)).toContain("registry differs from the 3.0 contract");
  });

  it.each(["task-contract", "mutation-risk-preflight", "prompt-engineering", "independent-audit-gate"])("retains the independent main oracle for %s", (skillId) => {
    const registry = readRegistry();
    registry.skills.find((entry) => entry.skillId === skillId).priority += 1;
    expect(digest(withoutAddition(registry))).not.toBe(BASELINE_DIGEST);
    expect(checkRegistryContextCompatibility(registry)).toContain("registry differs from the 3.0 contract");
  });
});
