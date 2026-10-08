import { describe, expect, it, vi } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkSkillContextOptimization, matchesEngineeringReferenceUpdate, matchesNode24ReadmeUpdate, matchesOrchestratorIntakeUpdate, reconstructOptimizedSkill } from "../../scripts/check-skill-context-optimization.mjs";
import { matchesClassificationUpdate, matchesReviewedImplementationUpdate } from "../../scripts/check-skill-context-optimization.mjs";

describe("skill context optimization", () => {
  it("accepts only reviewed integration revision paths and exact bytes", () => {
    for (const relative of [
      "skills/model-effort-advisor/SKILL.md",
      "skills/model-effort-advisor/references/entry-details.md",
      "skills/model-effort-advisor/scripts/support-guard.mjs",
      "skills/orchestrator/references/engineering-practices/cli.md",
    ]) {
      const bytes = readFileSync(new URL(`../../${relative}`, import.meta.url));
      expect(matchesReviewedImplementationUpdate(relative, bytes), relative).toBe(true);
      const altered = Buffer.from(bytes);
      altered[altered.length - 1] ^= 1;
      expect(matchesReviewedImplementationUpdate(relative, altered), relative).toBe(false);
    }
    const approvedBytes = readFileSync(new URL("../../skills/model-effort-advisor/scripts/support-guard.mjs", import.meta.url));
    expect(matchesReviewedImplementationUpdate("skills/model-effort-advisor/scripts/unreviewed.mjs", approvedBytes)).toBe(false);
    expect(matchesReviewedImplementationUpdate("skills/orchestrator/references/engineering-practices/unreviewed.md", approvedBytes)).toBe(false);
  });
  it("reports reviewed integration as frozen-change validation without issuing authority", () => {
    const report = checkSkillContextOptimization();
    expect(report.baselineRevision).toBe("7bc7753012227938be2a46f68bf3e29d29d5ef34");
    expect(report.reviewedImplementationUpdates).toMatchObject([{
      revision: "2.8.1-implementation-r1-model-support-stage-bundle",
      authorityEffect: "none",
      modelInitialMaxBytes: 2024,
    }]);
    expect(report.totals.skillCount).toBe(20);
    expect(report.reviewedClassificationUpdates).toMatchObject([{
      revision: "2.9.1-skill-classification-metadata-and-entry-bridges", authorityEffect: "none",
      additions: { orchestrator: { bytes: 441 }, ponytail: { bytes: 299 } },
    }]);
  });
  it("rejects altered reviewed integration bytes through the public checker", async () => {
    vi.doMock("node:fs", () => ({
      readdirSync,
      readFileSync: (file, ...args) => {
        const bytes = readFileSync(file, ...args);
        if (String(file).replaceAll("\\", "/").endsWith("/skills/model-effort-advisor/scripts/support-guard.mjs")) {
          const altered = Buffer.from(bytes);
          altered[altered.length - 1] ^= 1;
          return altered;
        }
        return bytes;
      },
    }));
    try {
      vi.resetModules();
      const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      const report = checker.checkSkillContextOptimization();
      expect(report.pass).toBe(false);
      expect(report.errors).toContain("model-effort-advisor: reviewed implementation bytes differ: skills/model-effort-advisor/scripts/support-guard.mjs");
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
  it("rejects an unreviewed integration path reported by Git without modifying the source tree", async () => {
    const { execFileSync } = await import("node:child_process");
    vi.doMock("node:child_process", () => ({
      execFileSync: (file, args, options) => {
        if (file === "git" && args.includes("ls-files") && args.at(-1) === "skills/model-effort-advisor") {
          return Buffer.from("skills/model-effort-advisor/scripts/unreviewed.mjs\n");
        }
        return execFileSync(file, args, options);
      },
    }));
    try {
      vi.resetModules();
      const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      const report = checker.checkSkillContextOptimization();
      expect(report.pass).toBe(false);
      expect(report.errors).toContain("model-effort-advisor: unexpected skill-owned changes: skills/model-effort-advisor/scripts/unreviewed.mjs");
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
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
  it("pins every reviewed classification source and rejects one-byte changes or an unreviewed path", () => {
    const report = checkSkillContextOptimization();
    const sources = Object.keys(report.reviewedClassificationUpdates[0].hashes);
    expect(sources).toHaveLength(27);
    for (const relative of sources) {
      const bytes = readFileSync(new URL(`../../${relative}`, import.meta.url));
      expect(matchesClassificationUpdate(relative, bytes), relative).toBe(true);
      const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
      expect(matchesClassificationUpdate(relative, changed), relative).toBe(false);
    }
    expect(matchesClassificationUpdate("skills/orchestrator/classification-extra.json", readFileSync(new URL("../../skills/orchestrator/classification.json", import.meta.url)))).toBe(false);
  });
  it("reports one-byte metadata corruption through the public checker", async () => {
    const relative = "/skills/orchestrator/classification.json";
    vi.doMock("node:fs", () => ({ readdirSync, readFileSync: (file, ...args) => {
      const bytes = readFileSync(file, ...args);
      if (String(file).replaceAll("\\", "/").endsWith(relative)) { const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; return changed; }
      return bytes;
    } }));
    try {
      vi.resetModules(); const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      const report = checker.checkSkillContextOptimization();
      expect(report.pass).toBe(false);
      expect(report.errors).toContain("classification: reviewed bytes differ: skills/orchestrator/classification.json");
    } finally { vi.doUnmock("node:fs"); vi.resetModules(); }
  });
  it.each(["orchestrator", "ponytail"])("rejects an unreviewed metadata path in %s without source mutations", async (owner) => {
    const { execFileSync } = await import("node:child_process");
    const relative = `skills/${owner}/classification-extra.json`;
    vi.doMock("node:child_process", () => ({ execFileSync: (file, args, options) => {
      if (file === "git" && args.includes("ls-files") && args.at(-1) === `skills/${owner}`) return Buffer.from(`${relative}\n`);
      return execFileSync(file, args, options);
    } }));
    try {
      vi.resetModules(); const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      const report = checker.checkSkillContextOptimization();
      expect(report.pass).toBe(false);
      expect(report.errors.some((error) => error.includes(relative))).toBe(true);
    } finally { vi.doUnmock("node:child_process"); vi.resetModules(); }
  });
  it("rejects a changed engineering bridge and still rejects changes to the preceding CS bridge", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const directory = mkdtempSync(path.join(tmpdir(), "ags-engineering-bridge-"));
    try {
      for (const relative of ["skills/orchestrator/SKILL.md", "skills/orchestrator/references/entry-details.md", "scripts/fixtures/cs-engineering-handoff.2.8.0.md", "scripts/fixtures/engineering-practices-handoff.2.8.1.md", "scripts/fixtures/skill-classification-intake.2.9.1.md"]) {
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
      writeFileSync(path.join(directory, relative), original);
      const additionPath = path.join(directory, "scripts/fixtures/skill-classification-intake.2.9.1.md");
      const addition = readFileSync(additionPath); addition[addition.length - 1] ^= 1; writeFileSync(additionPath, addition);
      expect(() => reconstructOptimizedSkill("orchestrator", directory)).toThrow(/pinned 2.9.1 classification addition/u);
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
        candidateBytes: 46292,
        reducedBytes: 69387,
        reductionPercent: 59.982365
      }
    });
    expect(report.skills).toHaveLength(20);
    expect(report.skills.every((skill) => skill.reducedBytes > 0)).toBe(true);
    expect(report.policyBaselineUpdates).toMatchObject([{ skillId: "orchestrator", initialMaxBytes: 4585 }]);
  });
});
