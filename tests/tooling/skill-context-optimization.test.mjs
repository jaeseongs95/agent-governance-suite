import { describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkSkillContextOptimization, matchesEngineeringReferenceUpdate, matchesNode24ReadmeUpdate, matchesOrchestratorIntakeUpdate, reconstructOptimizedSkill } from "../../scripts/check-skill-context-optimization.mjs";

describe("skill context optimization", () => {
  it("accepts only the frozen engineering reference paths and bytes", () => {
    const directory = new URL("../../skills/orchestrator/references/engineering-practices/", import.meta.url);
    for (const name of readdirSync(directory)) {
      const bytes = readFileSync(new URL(name, directory));
      expect(matchesEngineeringReferenceUpdate(name, bytes), name).toBe(true);
      const altered = Buffer.from(bytes);
      altered[altered.length - 1] ^= 1;
      expect(matchesEngineeringReferenceUpdate(name, altered), name).toBe(false);
    }
    expect(matchesEngineeringReferenceUpdate("unreviewed.md", Buffer.from("extra"))).toBe(false);
  });
  it("rejects a changed engineering bridge and still rejects changes to the preceding CS bridge", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const directory = mkdtempSync(path.join(tmpdir(), "ags-engineering-bridge-"));
    try {
      for (const relative of ["skills/orchestrator/SKILL.md", "skills/orchestrator/references/entry-details.md", "scripts/fixtures/cs-engineering-handoff.2.8.0.md", "scripts/fixtures/engineering-practices-handoff.2.8.1.md"]) {
        mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
        cpSync(path.join(root, relative), path.join(directory, relative));
      }
      expect(reconstructOptimizedSkill("orchestrator", directory)).toEqual(reconstructOptimizedSkill("orchestrator"));
      const relative = "skills/orchestrator/references/entry-details.md";
      const original = readFileSync(path.join(directory, relative));
      writeFileSync(path.join(directory, relative), Buffer.concat([original, Buffer.from("extra\n")]));
      expect(() => reconstructOptimizedSkill("orchestrator", directory)).toThrow(/2.8.1 Engineering Practices/u);
      const changed = original.toString("utf8").replace("cs-constraint-derivation", "cs-constraint-derivatioX");
      expect(changed).not.toBe(original.toString("utf8"));
      writeFileSync(path.join(directory, relative), changed);
      expect(() => reconstructOptimizedSkill("orchestrator", directory)).toThrow(/2.8.0 CS handoff/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
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
        candidateBytes: 45851,
        reducedBytes: 69828,
        reductionPercent: 60.363592
      }
    });
    expect(report.skills).toHaveLength(20);
    expect(report.skills.every((skill) => skill.reducedBytes > 0)).toBe(true);
    expect(report.policyBaselineUpdates).toMatchObject([{ skillId: "orchestrator", initialMaxBytes: 4585 }]);
  });
});
