import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { checkSkillContextOptimization, matchesNode24ReadmeUpdate, matchesOrchestratorIntakeUpdate, reconstructOptimizedSkill } from "../../scripts/check-skill-context-optimization.mjs";

describe("skill context optimization", () => {
  it("allows the runtime minimum update while rejecting other README changes", () => {
    const baseline = "# skill\nNode.js 22 이상\nexisting contract\n";
    const updated = "# skill\nNode.js 24.0.0 이상\nexisting contract\n";
    expect(matchesNode24ReadmeUpdate("task-contract", baseline, updated)).toBe(true);
    expect(matchesNode24ReadmeUpdate("task-contract", baseline, `${updated}extra change\n`)).toBe(false);
    expect(matchesNode24ReadmeUpdate("task-contract", `${baseline}Node.js 22 이상\n`, updated)).toBe(false);
  });

  it("pins the intake revision and rejects a one-byte policy or reference change", () => {
    const candidate = readFileSync(new URL("../../skills/orchestrator/SKILL.md", import.meta.url));
    const inputs = {
      reconstructed: reconstructOptimizedSkill("orchestrator"),
      frontmatter: candidate.subarray(0, candidate.indexOf(Buffer.from("\n---\n"), 4) + 5),
      mcpExecution: readFileSync(new URL("../../skills/orchestrator/references/mcp-execution.md", import.meta.url)),
    };
    for (const [kind, bytes] of Object.entries(inputs)) {
      expect(matchesOrchestratorIntakeUpdate(kind, bytes), kind).toBe(true);
      const altered = Buffer.from(bytes);
      altered[altered.length - 1] ^= 1;
      expect(matchesOrchestratorIntakeUpdate(kind, altered), kind).toBe(false);
    }
    expect(matchesOrchestratorIntakeUpdate("unknown", candidate)).toBe(false);
  });

  it("preserves the reviewed skill revisions while reducing their initial load", () => {
    const report = checkSkillContextOptimization();
    expect(report).toMatchObject({
      pass: true,
      errors: [],
      totals: {
        skillCount: 20,
        baselineBytes: 115679,
        candidateBytes: 45203,
        reducedBytes: 70476,
        reductionPercent: 60.923763
      }
    });
    expect(report.skills).toHaveLength(20);
    expect(report.skills.every((skill) => skill.reducedBytes > 0)).toBe(true);
    expect(report.policyBaselineUpdates).toMatchObject([{ skillId: "orchestrator", initialMaxBytes: 4585 }]);
  });
});
