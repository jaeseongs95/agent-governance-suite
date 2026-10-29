import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import { checkSkillContextOptimization, readHistoricalSource, matchesEngineeringReferenceUpdate, matchesNode24ReadmeUpdate, matchesOrchestratorIntakeUpdate, matchesSkillPolicyWordingSuccessorBytes, reconstructOptimizedSkill } from "../../scripts/check-skill-context-optimization.mjs";
import { matchesClassificationUpdate, matchesReviewedImplementationUpdate, matchesCurrentImplementationPin } from "../../scripts/check-skill-context-optimization.mjs";

describe("skill context optimization", () => {
  it("pins recorded implementation bytes separately from current context", () => {
    const report = checkSkillContextOptimization();
    expect(report.currentImplementationPins).toHaveLength(1);
    expect(report.currentImplementationPins[0].authorityEffect).toBe("none");
    expect(Object.keys(report.currentImplementationPins[0].hashes)).toHaveLength(36);
    expect(Object.keys(report.currentImplementationPins[0].hashes).toSorted()).toEqual([
      "skills/acceptance-evidence-validator/scripts/check-repository.mjs",
      "skills/acceptance-evidence-validator/scripts/core.d.mts",
      "skills/acceptance-evidence-validator/scripts/core.mjs",
      "skills/acceptance-evidence-validator/scripts/schema-validation.mjs",
      "skills/blocker-diagnostician/scripts/check-repository.mjs",
      "skills/change-scope-guardian/scripts/lib.mjs",
      "skills/change-scope-guardian/scripts/schema-validator.mjs",
      "skills/codex-token-usage-analyzer/scripts/core.mjs",
      "skills/codex-token-usage-analyzer/scripts/schema-validation.mjs",
      "skills/coordinate-subagents/references/model-routing-presets.json",
      "skills/coordinate-subagents/references/model-routing.md",
      "skills/coordinate-subagents/scripts/model-catalog-adapter.d.mts",
      "skills/coordinate-subagents/scripts/model-catalog-adapter.mjs",
      "skills/coordinate-subagents/scripts/model-routing.d.mts",
      "skills/coordinate-subagents/scripts/model-routing.mjs",
      "skills/evaluation-validity-auditor/scripts/check-repository.mjs",
      "skills/independent-deliberation-panel/evals/fixtures/valid/ad01_specialist_cap.json",
      "skills/independent-deliberation-panel/scripts/run_evals.py",
      "skills/independent-deliberation-panel/scripts/validate_decision_record.py",
      "skills/instruction-scope-resolver/references/gemini-instructions.md",
      "skills/instruction-scope-resolver/scripts/resolve-instruction-files.mjs",
      "skills/iteration-frame-auditor/integration/skill-descriptor.json",
      "skills/iteration-frame-auditor/scripts/core.mjs",
      "skills/korean-prose-editor/contracts/protected-manifest.schema.json",
      "skills/korean-prose-editor/contracts/receipt.schema.json",
      "skills/korean-prose-editor/scripts/finalizer-core.mjs",
      "skills/korean-prose-editor/scripts/protected-spans.mjs",
      "skills/mutation-risk-preflight/references/recovery-requirements.md",
      "skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs",
      "skills/mutation-risk-preflight/scripts/schema-validation.mjs",
      "skills/mutation-risk-preflight/scripts/validate-skill.mjs",
      "skills/recovery-strategy-selector/scripts/schema-validation.mjs",
      "skills/task-contract/scripts/validate-task-contract.mjs",
      "skills/workspace-convention-profiler/scripts/profile-workspace.mjs",
      "skills/workspace-convention-profiler/scripts/schema-validation.mjs",
      "skills/workspace-convention-profiler/scripts/validate-skill.mjs",
    ]);
    for (const relative of Object.keys(report.currentImplementationPins[0].hashes)) {
      const bytes = readHistoricalSource(relative);
      expect(matchesCurrentImplementationPin(relative, bytes), relative).toBe(true);
      const altered = Buffer.from(bytes); altered[altered.length - 1] ^= 1;
      expect(matchesCurrentImplementationPin(relative, altered), relative).toBe(false);
      expect(matchesCurrentImplementationPin(relative + ".unlisted", bytes)).toBe(false);
    }
    expect(report.baselineRevision).toBe("7bc7753012227938be2a46f68bf3e29d29d5ef34");
    expect(report.totals).toMatchObject({ skillCount: 20, baselineBytes: 115679, candidateBytes: 47606 });
  });
  it.each([
    "skills/instruction-scope-resolver/scripts/resolve-instruction-files.mjs",
    "skills/independent-deliberation-panel/evals/fixtures/valid/ad01_specialist_cap.json",
  ])("rejects altered recorded implementation or contract evidence: %s", async (relative) => {
    const { execFileSync } = await import("node:child_process");
    vi.doMock("node:child_process", () => ({ execFileSync: (file, args, options) => {
      const bytes = execFileSync(file, args, options);
      if (file === "git" && args[0] === "show" && args[1] === `2b59559cb8e2c50a1be5fb3f1473b6b9adcd1aa8:${relative}`) {
        const altered = Buffer.from(bytes); altered[altered.length - 1] ^= 1; return altered;
      }
      return bytes;
    } }));
    vi.doMock("node:fs", () => ({ readdirSync, readFileSync: (file, ...args) => {
      const bytes = readFileSync(file, ...args);
      if (String(file).replaceAll("\\", "/").endsWith(`/${relative}`)) {
        const altered = Buffer.from(bytes); altered[altered.length - 1] ^= 1; return altered;
      }
      return bytes;
    } }));
    try {
      vi.resetModules();
      const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      const report = checker.checkSkillContextOptimization();
      expect(report.pass).toBe(false);
      expect(report.errors).toContain(`current implementation bytes differ: ${relative}`);
    } finally { vi.doUnmock("node:fs"); vi.doUnmock("node:child_process"); vi.resetModules(); }
  });

  it.each([
    "skills/task-contract/scripts/validate-task-contract.mjs",
    "skills/model-effort-advisor/scripts/support-guard.mjs",
    "skills/cs-engineering/scripts/core.mjs",
  ])("accepts an ordinary code-only edit while source-lock still detects it: %s", async relative => {
    const fs = await import("node:fs");
    const promises = await import("node:fs/promises");
    const changed = value => typeof value === "string" ? `${value}\n// D0358: 코드 동작과 문맥을 바꾸지 않는 주석\n` : Buffer.concat([value, Buffer.from("\n// D0358: 코드 동작과 문맥을 바꾸지 않는 주석\n")]);
    const matches = file => String(file).replaceAll("\\", "/").endsWith(`/${relative}`);
    vi.doMock("node:fs", () => ({ ...fs, readFileSync: (file, ...args) => {
      const value = fs.readFileSync(file, ...args); return matches(file) ? changed(value) : value;
    } }));
    vi.doMock("node:fs/promises", () => ({ ...promises, readFile: async (file, ...args) => {
      const value = await promises.readFile(file, ...args); return matches(file) ? changed(value) : value;
    } }));
    try {
      vi.resetModules();
      const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      const report = checker.checkSkillContextOptimization();
      expect(report).toMatchObject({ pass: true, errors: [] });
      expect(report.implementationEvidence).toMatchObject({ revision: "2b59559cb8e2c50a1be5fb3f1473b6b9adcd1aa8", authorityEffect: "none", currentSourceIntegrity: "source-lock" });
      const { verifySourceLockOffline } = await import("../../scripts/source-lock.mjs");
      const owner = relative.split("/")[1];
      expect((await verifySourceLockOffline()).some(error => error.startsWith(`integrated checksum mismatch for ${owner}:`))).toBe(true);
    } finally {
      vi.doUnmock("node:fs"); vi.doUnmock("node:fs/promises"); vi.resetModules();
    }
  }, 30_000);

  it("does not substitute current bytes when recorded implementation evidence is missing", async () => {
    const { execFileSync } = await import("node:child_process");
    vi.doMock("node:child_process", () => ({ execFileSync: (file, args, options) => {
      if (file === "git" && args[0] === "show" && args[1] === "2b59559cb8e2c50a1be5fb3f1473b6b9adcd1aa8:skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs") throw new Error("SYNTHETIC_ARCHIVE_MISSING");
      return execFileSync(file, args, options);
    } }));
    try {
      vi.resetModules(); const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      expect(() => checker.checkSkillContextOptimization()).toThrow("SYNTHETIC_ARCHIVE_MISSING");
    } finally { vi.doUnmock("node:child_process"); vi.resetModules(); }
  });

  it("accepts only reviewed integration revision paths and exact bytes", () => {
    for (const relative of [
      "skills/model-effort-advisor/SKILL.md",
      "skills/model-effort-advisor/references/entry-details.md",
      "skills/model-effort-advisor/scripts/support-guard.mjs",
      "skills/orchestrator/references/engineering-practices/cli.md",
    ]) {
      const bytes = readHistoricalSource(relative);
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
    const { execFileSync } = await import("node:child_process");
    vi.doMock("node:child_process", () => ({ execFileSync: (file, args, options) => {
      const bytes = execFileSync(file, args, options);
      if (file === "git" && args[0] === "show" && args[1] === "2b59559cb8e2c50a1be5fb3f1473b6b9adcd1aa8:skills/model-effort-advisor/scripts/support-guard.mjs") {
        const altered = Buffer.from(bytes); altered[altered.length - 1] ^= 1; return altered;
      }
      return bytes;
    } }));
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
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
  it("rejects altered reviewed resolver output-contract bytes through the public checker", async () => {
    vi.doMock("node:fs", () => ({
      readdirSync,
      readFileSync: (file, ...args) => {
        const bytes = readFileSync(file, ...args);
        if (String(file).replaceAll("\\", "/").endsWith("/skills/instruction-scope-resolver/references/entry-details.md")) {
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
      expect(report.errors).toContain("instruction-scope-resolver: reviewed output-contract bytes differ: skills/instruction-scope-resolver/references/entry-details.md");
      expect(report.errors).toContain("instruction-scope-resolver: reconstructed reviewed output contract differs");
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
  it("rejects one altered byte inside the reviewed resolver N insertion through the public checker", async () => {
    vi.doMock("node:fs", () => ({
      readdirSync,
      readFileSync: (file, ...args) => {
        const bytes = readFileSync(file, ...args);
        if (String(file).replaceAll("\\", "/").endsWith("/skills/instruction-scope-resolver/references/entry-details.md")) {
          const altered = Buffer.from(bytes);
          altered[872] ^= 1; // first byte of the N r8.3 insertion
          return altered;
        }
        return bytes;
      },
    }));
    try {
      vi.resetModules();
      const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      const report = checker.checkSkillContextOptimization();
      expect(report.activeReviewedOutputContractUpdates).toMatchObject([{ revision: "2.9.1-instruction-scope-resolver-n-desc-rule-r8.3", authorityEffect: "none" }]);
      expect(report.pass).toBe(false);
      expect(report.errors).toContain("instruction-scope-resolver: reviewed output-contract bytes differ: skills/instruction-scope-resolver/references/entry-details.md");
      expect(report.errors).toContain("instruction-scope-resolver: reconstructed reviewed output contract differs");
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
      const bytes = readHistoricalSource(`skills/orchestrator/references/engineering-practices/${name}`);
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
      const bytes = readHistoricalSource(relative);
      expect(matchesClassificationUpdate(relative, bytes), relative).toBe(true);
      const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
      expect(matchesClassificationUpdate(relative, changed), relative).toBe(false);
    }
    expect(matchesClassificationUpdate("skills/orchestrator/classification-extra.json", readHistoricalSource("skills/orchestrator/classification.json"))).toBe(false);
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
    const directory = mkdtempSync(path.join(tmpdir(), "ags-engineering-bridge-"));
    try {
      for (const relative of ["skills/orchestrator/SKILL.md", "skills/orchestrator/references/entry-details.md", "scripts/fixtures/cs-engineering-handoff.2.8.0.md", "scripts/fixtures/engineering-practices-handoff.2.8.1.md", "scripts/fixtures/skill-classification-intake.2.9.1.md"]) {
        mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
        writeFileSync(path.join(directory, relative), readHistoricalSource(relative));
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
    const candidate = readHistoricalSource("skills/orchestrator/SKILL.md");
    const inputs = {
      reconstructed: reconstructOptimizedSkill("orchestrator"),
      frontmatter: candidate.subarray(0, candidate.indexOf(Buffer.from("\n---\n"), 4) + 5),
      mcpExecution: readHistoricalSource("skills/orchestrator/references/mcp-execution.md"),
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
        candidateBytes: 47606,
        reducedBytes: 68073,
        reductionPercent: 58.846463
      }
    });
    expect(report.skills).toHaveLength(20);
    expect(report.skills.every((skill) => skill.reducedBytes > 0)).toBe(true);
    expect(report.policyBaselineUpdates).toMatchObject([{ skillId: "orchestrator", initialMaxBytes: 4585 }]);
  });
});

describe("skill policy wording regressions (AGS-D-0093, AGS-D-0306..0310)", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const successorPaths = [
    "skills/acceptance-evidence-validator/SKILL.md",
    "skills/acceptance-evidence-validator/classification.json",
    "skills/blocker-diagnostician/classification.json",
    "skills/blocker-diagnostician/references/entry-details.md",
    "skills/coordinate-subagents/SKILL.md",
    "skills/coordinate-subagents/classification.json",
    "skills/coordinate-subagents/references/delegation-playbook.md",
    "skills/coordinate-subagents/references/entry-details.md",
    "skills/cs-engineering/SKILL.md",
    "skills/cs-engineering/classification.json",
    "skills/independent-audit-gate/SKILL.md",
    "skills/independent-audit-gate/classification.json",
    "skills/independent-audit-gate/references/audit-protocol.md",
    "skills/independent-audit-gate/references/entry-details.md",
    "skills/independent-audit-gate/references/orchestrator-integration.md",
    "skills/independent-audit-gate/scripts/validate_skill.py",
    "skills/independent-deliberation-panel/SKILL.md",
    "skills/independent-deliberation-panel/classification.json",
    "skills/independent-deliberation-panel/references/evidence-and-verdict-schema.md",
    "skills/mutation-risk-preflight/SKILL.md",
    "skills/mutation-risk-preflight/classification.json",
    "skills/mutation-risk-preflight/references/approval-and-authority.md",
    "skills/mutation-risk-preflight/references/entry-details.md",
    "skills/mutation-risk-preflight/references/risk-matrix.md",
    "skills/orchestrator/SKILL.md",
    "skills/orchestrator/classification.json",
    "skills/orchestrator/references/engineering-practices/catalog.json",
    "skills/orchestrator/references/engineering-practices/implementation.md",
    "skills/orchestrator/references/entry-details.md",
    "skills/orchestrator/references/mcp-execution.md",
    "skills/ponytail/SKILL.md",
    "skills/ponytail/classification.json",
    "skills/task-contract/SKILL.md",
    "skills/task-contract/classification.json",
    "skills/task-contract/references/risk-and-authorization-rubric.md",
  ];

  it("pins all 35 policy wording successor files and rejects one-byte tampering", () => {
    for (const relative of successorPaths) {
      const current = readFileSync(path.join(root, relative));
      const historical = readHistoricalSource(relative);
      expect(matchesSkillPolicyWordingSuccessorBytes(relative, current), relative).toBe(true);
      expect(current.equals(historical), relative).toBe(false);
      const tampered = Buffer.from(current);
      tampered[tampered.length - 1] ^= 1;
      expect(matchesSkillPolicyWordingSuccessorBytes(relative, tampered), relative).toBe(false);
    }
    expect(matchesSkillPolicyWordingSuccessorBytes("skills/orchestrator/unlisted.md", Buffer.from("x"))).toBe(false);
  });

  it("enforces risk-proportional gates, direct approval prompts, operational ponytail rules, and vendor-neutral wording across root and claude-plugin", async () => {
    const readBoth = (relative) => [
      readFileSync(path.join(root, relative), "utf8"),
      readFileSync(path.join(root, "claude-plugin", relative), "utf8"),
    ];

    for (const text of readBoth("skills/acceptance-evidence-validator/SKILL.md")) {
      expect(text).toContain("수용 기준이 여럿인 계약 작업이나 고위험 작업을 마친 뒤 완료 선언에 필요한 근거를 점검할 때 사용한다. 작은 단일 작업은 이 스킬 없이 실제로 실행한 검사와 결과를 보고에 바로 적는다.");
      expect(text).not.toContain("구현이나 산출물이 끝난 뒤 완료 선언에 필요한 근거를 점검할 때 사용한다.");
    }

    const coordRoot = readFileSync(path.join(root, "skills/coordinate-subagents/SKILL.md"), "utf8");
    expect(coordRoot).toContain("Coordinate subagents on the current host by delegating only when the user requests it");
    expect(coordRoot).not.toContain("Coordinate subagents in Codex and Claude Code");

    for (const text of readBoth("skills/cs-engineering/SKILL.md")) {
      expect(text).toContain("파일 이동·장부 반영 같은 운영 작업과 자원·성능에 영향이 없는\n  작은 수정에는 쓰지 않는다.");
      expect(text).toContain("동시성·DB·메시징·알고리즘·자원 수명·성능이 실제 변경의 정확성이나 자원·성능 결과를 바꿀 때 적용하라.");
      expect(text).toContain("버퍼 크기·I/O·flush 주기처럼 자원·성능을 바꾸는 설정 판단도 적용 범위다.");
      expect(text).toContain("카드 의무는 그 카드의 적용 조건이 현재 변경에 실제로 있을 때만 붙여라.");
    }

    for (const text of readBoth("skills/independent-audit-gate/SKILL.md")) {
      expect(text).toContain("되돌리기 어려운 영구 삭제나 실데이터 대량 수정, 개인정보, 백업·복원 또는 운영 데이터 정합성");
      expect(text).toContain("같은 디스크 안 이동처럼 되돌릴 수 있는 운영 작업");
      expect(text).toContain("불확실하다는 이유만으로 고위험으로 올리지 않는다.");
    }
    for (const text of readBoth("skills/independent-audit-gate/references/audit-protocol.md")) {
      expect(text).toContain("파일 이동·복사·이름 변경은 삭제가 아니다.");
      expect(text).toContain("승인 근거는 요청자와 다른 사용자 본인의 결정이어야 하며, 요청한 에이전트가 승인자 도구나 저장된 사용자 로그인으로 승인을 직접 실행한 `approve` 호출은 승인 근거가 아니다.");
      expect(text).toContain("자가 승인이 확인되면 `FAIL`로 판정한다");
      expect(text).toContain("감사·Judge 역할에 한 번이라도 쓰였거나 구현에 참여한 에이전트는, 이후 감사·재감사에 다시 배정되지 않는다. 재사용된 감사자는 거부되거나 `BLOCKED` 처리된다.");
    }
    for (const text of readBoth("skills/independent-audit-gate/references/entry-details.md")) {
      expect(text).toContain("파일 이동·복사·이름 변경은 삭제가 아니며 이 경계의 승인 대상이 아니다.");
      expect(text).toContain("확인할 수 없으면 고위험으로 올리지 말고 그 점을 사용자에게 묻는다.");
      expect(text).toContain("자가 승인 시 열린 `blocking` 위반으로 보아 `FAIL`로 판정한다");
      expect(text).toContain("에이전트가 승인자 도구나 저장된 사용자 로그인으로 직접 실행한 `approve` 호출로 대체하지 않았다.");
      expect(text).toContain("[references/audit-protocol.md](audit-protocol.md)의 `2. 감사자 독립성`");
    }
    for (const text of readBoth("skills/independent-audit-gate/references/orchestrator-integration.md")) {
      expect(text).toContain("`FAIL`은 확인된 차단성 결함을 수정한 뒤 [audit-protocol.md](audit-protocol.md)의 `2. 감사자 독립성`에 따라 영향 범위를 다시 확인해야 한다.");
      expect(text).not.toContain("같은 감사자가 영향 범위를 다시 확인해야 한다.");
    }
    for (const text of readBoth("skills/coordinate-subagents/references/entry-details.md")) {
      expect(text).toContain("For auditor and Judge eligibility or reuse, follow `independent-audit-gate` (`references/audit-protocol.md`, `2. 감사자 독립성`).");
      expect(text).toContain("Follow `independent-audit-gate` (`references/audit-protocol.md`, `2. 감사자 독립성`) for auditor and Judge eligibility and non-reuse.");
      expect(text).toContain("Follow `independent-audit-gate` (`references/audit-protocol.md`, `2. 감사자 독립성`) when assigning the re-audit.");
    }
    for (const text of readBoth("skills/coordinate-subagents/references/delegation-playbook.md")) {
      expect(text).toContain("For auditor and Judge eligibility or reuse, follow `independent-audit-gate` (`references/audit-protocol.md`, `2. 감사자 독립성`).");
      expect(text).toContain("If a fix changes an audited area, re-audit the affected result under `independent-audit-gate` (`references/audit-protocol.md`, `2. 감사자 독립성`).");
      expect(text).not.toContain("send the affected result back for re-audit");
    }
    const auditBehaviorCases = JSON.parse(readFileSync(path.join(root, "tests/independent-audit-gate/behavior-cases.json"), "utf8")).cases;
    for (const behaviorCase of auditBehaviorCases.filter((entry) => entry.sourceRule)) {
      const targetText = readFileSync(path.join(root, "skills/independent-audit-gate", behaviorCase.file), "utf8");
      expect(targetText, behaviorCase.id).toContain(behaviorCase.required);
      expect(targetText, behaviorCase.id).not.toContain(behaviorCase.regression);
    }

    for (const text of readBoth("skills/independent-deliberation-panel/SKILL.md")) {
      expect(text).toContain("정책·설계 선택지가 갈리면 사용자에게 묻기 전에 이 패널로 정하고, 그래도 결론이 나지 않을 때 사용자에게 묻는다.");
      expect(text).toContain("직접 확인할 수 있는 사실은 패널 없이 직접 확인한다. 사용자만 줄 수 있는 승인이나 답 하나로 풀리는 문제에는 패널을 열지 말고 사용자에게 바로 묻는다.");
    }
    for (const text of readBoth("skills/independent-deliberation-panel/references/evidence-and-verdict-schema.md")) {
      expect(text).toContain("구체 모델·추론 조합은 orchestration-policy의 capability 우선 규칙에 따라 현재 호스트 adapter에서 capability·격리·도구 접근을 만족하는 실제 지원 구성으로 고른다.");
      expect(text).not.toContain("Terra");
      expect(text).not.toContain("Sol");
      expect(text).not.toContain("Astra");
    }

    for (const text of readBoth("skills/mutation-risk-preflight/SKILL.md")) {
      expect(text).toContain("행동 이름이 아니라 규모, 되돌릴 수 있는지, 실데이터·공유 자원·외부 공개에 닿는지로 판단한다.");
      expect(text).toContain("같은 디스크 안 이동·이름 변경, 원본이나 백업이 남는 복사, git이나 백업으로 되돌릴 수 있는 로컬 편집, 작업 브랜치 commit·push, 시험·CI 실행");
      expect(text).toContain("우회 작업을 만들지 말고 대상·영향·실행할 명령·복구 방법을 담아 사용자에게 바로 묻는다.");
    }
    for (const text of readBoth("skills/mutation-risk-preflight/references/approval-and-authority.md")) {
      expect(text).toContain("승인 근거는 요청자와 다른 사용자 본인의 결정이어야 하며, 요청한 에이전트가 승인자 도구나 저장된 사용자 로그인으로 승인을 직접 실행한 `approve` 호출은 승인 근거가 아니다.");
      expect(text).toContain("에이전트가 승인자 도구나 저장된 사용자 로그인으로 직접 실행한 자가 승인(`approve` 호출)만 있으면 미승인으로 보고 `NEEDS_APPROVAL`로 판정한다.");
      expect(text).toContain("승인이 없으면 분석 문서·대체 구현·복제 환경 시험으로 대신하지 않는다.");
    }
    for (const text of readBoth("skills/mutation-risk-preflight/references/entry-details.md")) {
      expect(text).toContain("요청한 에이전트가 승인자 도구나 저장된 사용자 로그인으로 승인을 직접 실행한 `approve` 호출은 승인 근거로 인정하지 않고 `NEEDS_APPROVAL`로 판정한다.");
    }
    for (const text of readBoth("skills/mutation-risk-preflight/references/risk-matrix.md")) {
      expect(text).toContain("영구 삭제·덮어쓰기·되돌리기 어려운 이동");
      expect(text).toContain("같은 디스크 안 이동·이름 변경과 되돌릴 수 있는 로컬 편집은 이 표의 대상이 아니다.");
    }

    for (const text of readBoth("skills/orchestrator/SKILL.md")) {
      expect(text).toContain("행동 이름이 아니라 실제 위험으로");
      expect(text).toContain("가장 짧은 경로로 직접 한다");
      expect(text).toContain("맡긴 역할 범위의 일은 그 근거로");
    }
    for (const text of readBoth("skills/orchestrator/references/entry-details.md")) {
      expect(text).toContain("MCP 계획에 실제 상태 변경에 필요한 stage가 없으면 그 stage를 넣은 새 계획으로 진행하고, 승인이 없으면 대상·영향·실행할 명령을 담아 사용자에게 바로 묻는다. 요청받은 변경을 남은 작업으로 돌려 놓은 채 완료로 보고하지 않는다.");
    }
    for (const text of readBoth("skills/orchestrator/references/mcp-execution.md")) {
      expect(text).toContain("사용자 입력이나 승인이 필요하면 그 stage에서 멈추고 대상·영향·실행할 명령을 담아 사용자에게 바로 한 번 묻는다. 답을 기다리는 동안 우회 구현이나 대체 산출물을 만들지 않는다.");
    }
    for (const text of readBoth("skills/orchestrator/references/engineering-practices/implementation.md")) {
      expect(text).toContain("현재 변경에 실제로 해당하는 cs-engineering 필수 불변조건은 단순화 대상이 아니라 만족할 조건이다. 해당하지 않는 카드 의무나 권고는 붙이지 않는다.");
    }

    for (const text of readBoth("skills/ponytail/SKILL.md")) {
      expect(text).toContain("## Operational work");
      expect(text).toContain("Do not write an analysis document, a test harness, a new API, or a cloned\nenvironment before doing the asked operation.");
    }

    expect(readFileSync(path.join(root, "skills/task-contract/SKILL.md"), "utf8"))
      .toContain("해석이 갈리거나 실패 영향이 큰 요청을 목표·범위·수용 기준·작업 단위·위험도·권한·검증 근거가 추적되는 TaskEnvelope.v1으로 정리한다.");
    for (const text of readBoth("skills/task-contract/SKILL.md")) {
      expect(text).toContain("계약은 해석이 갈리거나 실패 영향이 큰 작업에만 만들고, 계약이 없다는 이유로 배정받은 일을 미루지 않는다.");
      expect(text).toContain("필요한 질문을 한 번에 모아 사용자에게 바로 묻는다.");
    }
    for (const text of readBoth("skills/task-contract/references/risk-and-authorization-rubric.md")) {
      expect(text).toContain("모호하다는 이유만으로 등급을 올리지 않는다.");
      expect(text).toContain("사용자가 맡긴 역할이나 goal, 적용을 확인한 프로젝트 지침이 맡긴 일은 그 근거로 `allowedActions`에 넣고 '권한 없음'으로 결론 내지 않는다.");
    }

    const canonicalInventory = await loadSkillInventory({ root });
    const claudeInventory = await loadSkillInventory({ root: path.join(root, "claude-plugin") });
    expect(canonicalInventory.issues).toEqual([]);
    expect(claudeInventory.issues).toEqual([]);
    expect(canonicalInventory.skills.length).toBe(claudeInventory.skills.length);
  });
});
