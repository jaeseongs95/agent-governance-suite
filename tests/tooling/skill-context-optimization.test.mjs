import { describe, expect, it } from "vitest";
import { checkSkillContextOptimization } from "../../scripts/check-skill-context-optimization.mjs";

describe("skill context optimization", () => {
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
