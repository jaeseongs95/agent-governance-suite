import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkSkillContextOptimization } from "../../scripts/check-skill-context-optimization.mjs";
import { checkSkillLoadingContract } from "../../scripts/check-skill-loading-contract.mjs";

describe("skill context optimization", () => {
  it("preserves every optimized skill while reducing its initial load", () => {
    const report = checkSkillContextOptimization();
    expect(report).toMatchObject({
      candidateRevision: "b3c232f5113d956b6d3aeebdf26a19ed36ef49d1",
      pass: true,
      errors: [],
      totals: {
        skillCount: 20,
        baselineBytes: 115679,
        candidateBytes: 45853,
        reducedBytes: 69826,
        reductionPercent: 60.361863
      }
    });
    expect(report.skills).toHaveLength(20);
    expect(report.skills.every((skill) => skill.reducedBytes > 0)).toBe(true);
  });

  it("keeps the current initial skill context within the reviewed loading contract", () => {
    expect(checkSkillLoadingContract()).toMatchObject({ pass: true, errors: [], skillCount: 21 });
  });

  it("rejects a grown SKILL.md, a changed frontmatter and leaked catalog data", () => {
    const root = mkdtempSync(path.join(tmpdir(), "skill-loading-"));
    try {
      const source = new URL("../../", import.meta.url);
      for (const directory of ["release", "skills"]) cpSync(new URL(directory, source), path.join(root, directory), { recursive: true });
      const skill = path.join(root, "skills", "coordinate-subagents", "SKILL.md");
      const text = readFileSync(skill, "utf8");
      writeFileSync(skill, text.replace("license: MIT", "license: Apache-2.0").concat("\nSee references/model-catalog/models/openai.json.\n"));
      const report = checkSkillLoadingContract(root);
      expect(report.pass).toBe(false);
      expect(report.errors).toEqual(expect.arrayContaining([
        expect.stringContaining("initial context grew"),
        expect.stringContaining("frontmatter differs"),
        expect.stringContaining("model catalog data"),
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
