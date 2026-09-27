import { describe, expect, it } from "vitest";
import { checkSkillContextOptimization, matchesNode24ReadmeUpdate } from "../../scripts/check-skill-context-optimization.mjs";

describe("skill context optimization", () => {
  it("allows the runtime minimum update while rejecting other README changes", () => {
    const baseline = "# skill\nNode.js 22 이상\nexisting contract\n";
    const updated = "# skill\nNode.js 24.0.0 이상\nexisting contract\n";
    expect(matchesNode24ReadmeUpdate("task-contract", baseline, updated)).toBe(true);
    expect(matchesNode24ReadmeUpdate("task-contract", baseline, `${updated}extra change\n`)).toBe(false);
    expect(matchesNode24ReadmeUpdate("task-contract", `${baseline}Node.js 22 이상\n`, updated)).toBe(false);
  });

  it("preserves every optimized skill while reducing its initial load", () => {
    const report = checkSkillContextOptimization();
    expect(report).toMatchObject({
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
});
