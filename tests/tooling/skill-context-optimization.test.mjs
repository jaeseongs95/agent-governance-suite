import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import { checkSkillContextOptimization, checkRegistryContextCompatibility, readHistoricalSource, matchesEngineeringReferenceUpdate, matchesNode24ReadmeUpdate, matchesOrchestratorIntakeUpdate, matchesSkillPolicyWordingSuccessorBytes, reconstructOptimizedSkill } from "../../scripts/check-skill-context-optimization.mjs";
import { matchesClassificationUpdate, matchesReviewedImplementationUpdate, matchesCurrentImplementationPin, beforeSpecialistBehaviorSuccessor } from "../../scripts/check-skill-context-optimization.mjs";

// The checker prefetches history with `ls-tree` + `cat-file --batch`; a path left out of the listing is read by
// `git show`, so a test that intercepts `git show` for a path also drops it from the listing.
const unlisted = (listing, relative) => Buffer.from(listing.toString("utf8").split("\0").filter(entry => !entry.endsWith(`\t${relative}`)).join("\0"));

// engineering-test-plan — user-requested purpose change, 2026-11-07.
// Entry points: checkSkillContextOptimization / readHistoricalSource; existing Vitest component suite.
// Preconditions: integrate the approved analyzer removal, pre-dispatch advisor sources and live registry first.
// Inputs / procedure / expected result / pass-fail oracle:
// PC-01: exact integrated sources -> public checker -> pass, frozen 20-skill totals unchanged; compare fixed literals.
// PC-02: all 12 analyzer paths -> absence + history reads -> exact absence, nine non-executable historical pins.
// PC-03: restore retired sources or an indexed path -> public checker -> fail naming each present/indexed source.
// PC-04: alter the pinned retirement history -> public checker -> throw; never substitute current bytes.
// PC-05: approved purpose-change bytes -> historical read -> exact predecessor projection, separate live report.
// PC-06: one-byte drift or a missing approved live source -> public checker -> fail; no arbitrary historical fallback.
// PC-07: restore the analyzer descriptor or alter advisor bindings/gate -> registry compatibility -> fail.
// Scope: source integrity and historical replay, not native model selection, dispatch or semantic evaluation.
// Actual results: NOT_RUN here; local product tests are prohibited. Coordinator runs TEST/Actions on integrated SHA.

describe("skill context optimization", () => {
  const removedAnalyzerSources = [
    "skills/codex-token-usage-analyzer/LICENSE",
    "skills/codex-token-usage-analyzer/SKILL.md",
    "skills/codex-token-usage-analyzer/agents/openai.yaml",
    "skills/codex-token-usage-analyzer/classification.json",
    "skills/codex-token-usage-analyzer/contracts/token-usage-report-request.v1.schema.json",
    "skills/codex-token-usage-analyzer/contracts/token-usage-report.v1.schema.json",
    "skills/codex-token-usage-analyzer/integration/provider-result.v1.schema.json",
    "skills/codex-token-usage-analyzer/integration/skill-descriptor.json",
    "skills/codex-token-usage-analyzer/references/entry-details.md",
    "skills/codex-token-usage-analyzer/scripts/cli.mjs",
    "skills/codex-token-usage-analyzer/scripts/core.mjs",
    "skills/codex-token-usage-analyzer/scripts/schema-validation.mjs",
  ];
  it("PC-02: validates the exact analyzer removal while preserving its non-executable historical context", () => {
    const report = checkSkillContextOptimization();
    expect(report).toMatchObject({ pass: true, errors: [] });
    const retirement = report.retiredSkills.find(entry => entry.skillIds.includes("codex-token-usage-analyzer"));
    expect(retirement.revision).toBe("14549a2e83fd9143cf8184bd71979db23fd43172");
    expect([...Object.keys(retirement.hashes), ...retirement.removedExecutables].toSorted()).toEqual(removedAnalyzerSources.toSorted());
    expect(Object.keys(retirement.hashes)).toHaveLength(9);
    for (const relative of removedAnalyzerSources) expect(existsSync(new URL(`../../${relative}`, import.meta.url)), relative).toBe(false);
    for (const [relative, expected] of Object.entries(retirement.hashes)) {
      const previous = execFileSync("git", ["show", `${retirement.revision}:${relative}`], { cwd: fileURLToPath(new URL("../../", import.meta.url)) });
      expect(createHash("sha256").update(previous).digest("hex"), relative).toBe(expected);
      expect(readHistoricalSource(relative).length, relative).toBeGreaterThan(0);
    }
    expect(() => readHistoricalSource("skills/codex-token-usage-analyzer/unapproved.md")).toThrow();
  });
  it("PC-03: rejects every restored analyzer path, including executable sources", async () => {
    const retirement = checkSkillContextOptimization().retiredSkills.find(entry => entry.skillIds.includes("codex-token-usage-analyzer"));
    const history = new Map(Object.keys(retirement.hashes).map(relative => [relative,
      execFileSync("git", ["show", `${retirement.revision}:${relative}`], { cwd: fileURLToPath(new URL("../../", import.meta.url)) }),
    ]));
    vi.doMock("node:fs", () => ({ readdirSync, readFileSync: (file, ...args) => {
      const relative = removedAnalyzerSources.find(relative => String(file).replaceAll("\\", "/").endsWith(`/${relative}`));
      if (relative) return Buffer.from(history.get(relative) ?? "restored executable\n");
      return readFileSync(file, ...args);
    } }));
    try {
      vi.resetModules(); const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      const report = checker.checkSkillContextOptimization();
      expect(report.pass).toBe(false);
      for (const relative of removedAnalyzerSources) expect(report.errors).toContain(`retired skill source present: ${relative}`);
    } finally { vi.doUnmock("node:fs"); vi.resetModules(); }
  });
  it("PC-03: rejects an analyzer path that remains indexed after its working-tree deletion", async () => {
    const relative = "skills/codex-token-usage-analyzer/scripts/cli.mjs";
    vi.doMock("node:child_process", () => ({ execFileSync: (file, args, options) => {
      if (file === "git" && args.includes("ls-files") && !args.includes("--others") && args.at(-1) === "skills/codex-token-usage-analyzer") return Buffer.from(`${relative}\n`);
      return execFileSync(file, args, options);
    } }));
    try {
      vi.resetModules(); const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      const report = checker.checkSkillContextOptimization();
      expect(report.pass).toBe(false);
      expect(report.errors).toContain(`retired skill paths still tracked: ${relative}`);
    } finally { vi.doUnmock("node:child_process"); vi.resetModules(); }
  });
  it("PC-04: rejects changed analyzer retirement history instead of treating absence as a pass", async () => {
    const relative = "skills/codex-token-usage-analyzer/classification.json";
    vi.doMock("node:child_process", () => ({ execFileSync: (file, args, options) => {
      const output = execFileSync(file, args, options);
      if (file === "git" && args.includes("ls-tree")) return unlisted(output, relative);
      if (file === "git" && args.at(-2) === "show" && args.at(-1) === `14549a2e83fd9143cf8184bd71979db23fd43172:${relative}`) {
        const altered = Buffer.from(output); altered[altered.length - 1] ^= 1; return altered;
      }
      return output;
    } }));
    try {
      vi.resetModules(); const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      expect(() => checker.checkSkillContextOptimization()).toThrow(`Retired skill history differs: ${relative}`);
    } finally { vi.doUnmock("node:child_process"); vi.resetModules(); }
  });
  it("PC-01/05: labels the changed purpose separately and keeps the original optimization oracle", () => {
    const report = checkSkillContextOptimization();
    expect(report.currentPurposeChange).toMatchObject({
      pass: true, errors: [], changeKind: "user-requested-purpose-change", historicalEvaluationScope: "predecessor-only",
      validationScope: "exact-live-context-and-separate-historical-replay", modelBehaviorValidated: false, authorityEffect: "none",
    });
    expect(Object.keys(report.currentPurposeChange.hashes).toSorted()).toEqual([
      "skills/coordinate-subagents/SKILL.md",
      "skills/coordinate-subagents/classification.json",
      "skills/coordinate-subagents/references/entry-details.md",
      "skills/coordinate-subagents/references/model-routing.md",
      "skills/model-effort-advisor/SKILL.md",
      "skills/model-effort-advisor/agents/openai.yaml",
      "skills/model-effort-advisor/classification.json",
      "skills/model-effort-advisor/references/entry-details.md",
      "skills/orchestrator/references/entry-details.md",
    ]);
    expect(Object.keys(report.currentPurposeChange.additions).toSorted()).toEqual([
      "skills/model-effort-advisor/contracts/subagent-model-advice.v1.schema.json",
      "skills/model-effort-advisor/contracts/subagent-model-request.v1.schema.json",
      "skills/model-effort-advisor/scripts/advise.d.mts",
    ]);
    expect(report.totals).toMatchObject({ skillCount: 20, baselineBytes: 115679, candidateBytes: 47606, reducedBytes: 68073 });
    for (const [relative, [before, after]] of Object.entries(report.currentPurposeChange.hashes)) {
      const current = readFileSync(new URL(`../../${relative}`, import.meta.url));
      const predecessor = execFileSync("git", ["show", `${report.currentPurposeChange.baselineRevision}:${relative}`], { cwd: fileURLToPath(new URL("../../", import.meta.url)) });
      expect(createHash("sha256").update(predecessor).digest("hex"), relative).toBe(before);
      expect(createHash("sha256").update(current).digest("hex"), relative).toBe(after);
      expect(readHistoricalSource(relative).equals(current), relative).toBe(false);
    }
  });
  it("PC-06: rejects one-byte drift in each changed or added live purpose source", async () => {
    const transition = checkSkillContextOptimization().currentPurposeChange;
    const relatives = [...Object.keys(transition.hashes), ...Object.keys(transition.additions)];
    vi.doMock("node:fs", () => ({ readdirSync, readFileSync: (file, ...args) => {
      const bytes = readFileSync(file, ...args);
      if (relatives.some(relative => String(file).replaceAll("\\", "/").endsWith(`/${relative}`))) {
        const altered = Buffer.from(bytes); altered[altered.length - 1] ^= 1; return altered;
      }
      return bytes;
    } }));
    try {
      vi.resetModules(); const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      const report = checker.checkPurposeChangeSources();
      expect(report.pass).toBe(false);
      for (const relative of relatives) expect(report.errors).toContain(`purpose change source bytes differ: ${relative}`);
    } finally { vi.doUnmock("node:fs"); vi.resetModules(); }
  });
  it("PC-06: never replaces a missing live advisor entry with the old-purpose source", async () => {
    const relative = "skills/model-effort-advisor/SKILL.md";
    vi.doMock("node:fs", () => ({ readdirSync, readFileSync: (file, ...args) => {
      if (String(file).replaceAll("\\", "/").endsWith(`/${relative}`)) {
        const error = new Error(`SYNTHETIC_LIVE_SOURCE_MISSING: ${relative}`); error.code = "ENOENT"; throw error;
      }
      return readFileSync(file, ...args);
    } }));
    try {
      vi.resetModules(); const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      expect(() => checker.readHistoricalSource(relative)).toThrow("SYNTHETIC_LIVE_SOURCE_MISSING");
      expect(() => checker.checkSkillContextOptimization()).toThrow("SYNTHETIC_LIVE_SOURCE_MISSING");
    } finally { vi.doUnmock("node:fs"); vi.resetModules(); }
  });
  it("PC-07: rejects analyzer registration and altered advisor bindings or authority", () => {
    const registry = JSON.parse(readFileSync(new URL("../../skills/registry.json", import.meta.url), "utf8"));
    expect(checkRegistryContextCompatibility(registry)).toEqual([]);
    const restored = structuredClone(registry);
    const historical = JSON.parse(readFileSync(new URL("../../scripts/fixtures/registry-contract.3.0.json", import.meta.url), "utf8"));
    restored.skills.push(historical.skills.find(skill => skill.skillId === "codex-token-usage-analyzer"));
    expect(checkRegistryContextCompatibility(restored)).toContain("retired skill registry descriptor present: codex-token-usage-analyzer");
    for (const field of ["gate", "inputBindings"]) {
      const altered = structuredClone(registry);
      const provider = altered.skills.find(skill => skill.skillId === "model-effort-advisor").providers[0];
      provider[field] = field === "gate" ? { kind: "completion", policy: "mandatory", validator: null } : [];
      expect(checkRegistryContextCompatibility(altered), field).toContain("purpose change registry descriptor differs: model-effort-advisor");
    }
  });

  it("resolves context provenance in a single-branch clone without worker refs or borrowed objects", () => {
    const source = fileURLToPath(new URL("../../", import.meta.url));
    const temporary = mkdtempSync(path.join(tmpdir(), "ags-context-release-clone-"));
    const clone = path.join(temporary, "release");
    const env = { ...process.env };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
    const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", timeout: 120_000 });
    try {
      const tip = git(source, "rev-parse", "HEAD").trim();
      const copied = spawnSync("git", ["clone", "--single-branch", "--no-tags", "--no-local", source, clone], {
        env, encoding: "utf8", windowsHide: true, timeout: 120_000,
      });
      expect(copied.status, `${copied.stdout}\n${copied.stderr}`).toBe(0);
      expect(git(clone, "rev-parse", "HEAD").trim()).toBe(tip);
      expect(git(clone, "rev-parse", "--is-shallow-repository").trim()).toBe("false");
      expect(existsSync(path.join(clone, ".git/objects/info/alternates"))).toBe(false);
      const refs = git(clone, "for-each-ref", "--format=%(objectname)").trim().split(/\r?\n/u).filter(Boolean);
      expect(refs.length).toBeLessThanOrEqual(3); // Detached HEAD has none; a branch has local, remote, and remote HEAD.
      expect(refs.every(sha => sha === tip)).toBe(true);
      git(clone, "merge-base", "--is-ancestor", "c4121acbf1528a44ead7fd34f617afd7a25df814", "HEAD");
      const checked = spawnSync(process.execPath, [path.join(clone, "scripts/check-skill-context-optimization.mjs")], {
        cwd: clone, env, encoding: "utf8", windowsHide: true, timeout: 120_000,
      });
      expect(checked.status, `${checked.stdout}\n${checked.stderr}`).toBe(0);
      expect(JSON.parse(checked.stdout)).toMatchObject({ pass: true, errors: [], scope: "skill-context-only" });
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }, 180_000);

  it("pins context and contract bytes without executable fingerprints", () => {
    const report = checkSkillContextOptimization();
    expect(report.contextContractPins).toHaveLength(1);
    expect(report.contextContractPins[0].authorityEffect).toBe("none");
    expect(Object.keys(report.contextContractPins[0].hashes)).toHaveLength(21);
    expect(Object.keys(report.contextContractPins[0].hashes).toSorted()).toEqual([
      "contracts/model-policy.v1.schema.json",
      "runtime/collaboration-decision.d.mts",
      "runtime/provider-acceptance-semantics.d.mts",
      "runtime/session-board-store.d.mts",
      "skills/acceptance-evidence-validator/contracts/acceptance-evidence-input.v1.schema.json",
      "skills/acceptance-evidence-validator/contracts/acceptance-evidence-report.v1.schema.json",
      "skills/acceptance-evidence-validator/scripts/core.d.mts",
      "skills/coordinate-subagents/references/model-routing-policy.schema.json",
      "skills/coordinate-subagents/references/model-routing-presets.json",
      "skills/coordinate-subagents/references/model-routing.md",
      "skills/coordinate-subagents/scripts/model-catalog-adapter.d.mts",
      "skills/coordinate-subagents/scripts/model-routing-policy.d.mts",
      "skills/coordinate-subagents/scripts/model-routing.d.mts",
      "skills/independent-deliberation-panel/evals/fixtures/valid/ad01_specialist_cap.json",
      "skills/instruction-scope-resolver/references/gemini-instructions.md",
      "skills/iteration-frame-auditor/integration/skill-descriptor.json",
      "skills/korean-prose-editor/contracts/protected-manifest.schema.json",
      "skills/korean-prose-editor/contracts/receipt.schema.json",
      "skills/model-effort-advisor/contracts/model-effort-advice.v1.schema.json",
      "skills/model-effort-advisor/scripts/support-guard.d.mts",
      "skills/mutation-risk-preflight/references/recovery-requirements.md",
    ]);
    expect(readHistoricalSource("skills/coordinate-subagents/references/model-routing-policy.schema.json"))
      .toEqual(readHistoricalSource("contracts/model-policy.v1.schema.json"));
    for (const relative of Object.keys(report.contextContractPins[0].hashes)) {
      const bytes = readHistoricalSource(relative);
      expect(matchesCurrentImplementationPin(relative, bytes), relative).toBe(true);
      const altered = Buffer.from(bytes); altered[altered.length - 1] ^= 1;
      expect(matchesCurrentImplementationPin(relative, altered), relative).toBe(false);
      expect(matchesCurrentImplementationPin(relative + ".unlisted", bytes)).toBe(false);
    }
    expect(report.baselineRevision).toBe("7bc7753012227938be2a46f68bf3e29d29d5ef34");
    expect(report.totals).toMatchObject({ skillCount: 20, baselineBytes: 115679, candidateBytes: 47606 });
  });
  // D0006/D0007/D0020/D0029: exact integrated sources preserve the existing reconstruction;
  // one extra byte must not project onto a trusted predecessor or change that historical oracle.
  it.each([
    "skills/acceptance-evidence-validator/classification.json",
    "skills/session-board/classification.json",
    "skills/acceptance-evidence-validator/scripts/core.d.mts",
    "skills/session-board/scripts/board-store.d.mts",
    "skills/orchestrator/scripts/collaboration-decision.d.mts",
    "skills/acceptance-evidence-validator/README.md",
    "skills/acceptance-evidence-validator/references/entry-details.md",
    "skills/acceptance-evidence-validator/references/evidence-protocol.md",
    "skills/iteration-frame-auditor/references/review-protocol.md",
    "skills/session-board/references/entry-details.md",
  ])("rejects drift beyond the reviewed AGS38 source successor: %s", async relative => {
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
      expect(report.errors.some(error => error.includes(relative))).toBe(true);
    } finally { vi.doUnmock("node:fs"); vi.resetModules(); }
  });
  it.each([
    "skills/blocker-diagnostician/references/entry-details.md",
    "skills/blocker-diagnostician/references/diagnosis-protocol.md",
    "skills/blocker-diagnostician/classification.json",
  ])("역사 기준을 바꾸지 않고 현재 호스트 지침의 한 바이트 변경을 거부한다: %s", async relative => {
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
      expect(report.errors).toContain(`live host guidance successor bytes differ: ${relative}`);
    } finally { vi.doUnmock("node:fs"); vi.resetModules(); }
  });

  // context-continuity is retired: continuity is the MCP tools and hooks. Its sources are gone from the tree and every
  // pinned check reads them at the retirement revision, so a source that comes back or altered history fails.
  const retiredSources = [
    "skills/context-continuity/SKILL.md",
    "skills/context-continuity/agents/openai.yaml",
    "skills/context-continuity/classification.json",
    "skills/context-continuity/references/entry-details.md",
  ];
  const retirementBytes = relative => execFileSync("git", ["show", `e6e313864a4fe1be15ac2b199fb56284dbc327a9:${relative}`], { cwd: fileURLToPath(new URL("../../", import.meta.url)) });
  it("keeps the retired context-continuity sources out of the tree and reads them at their exact retirement bytes", () => {
    const report = checkSkillContextOptimization();
    expect(report).toMatchObject({ pass: true, errors: [] });
    expect(report.retiredSkills).toMatchObject([
      { revision: "e6e313864a4fe1be15ac2b199fb56284dbc327a9", skillIds: ["context-continuity"] },
      { revision: "14549a2e83fd9143cf8184bd71979db23fd43172", skillIds: ["codex-token-usage-analyzer"] },
    ]);
    expect(Object.keys(report.retiredSkills[0].hashes).toSorted()).toEqual(retiredSources);
    for (const relative of retiredSources) {
      expect(() => readFileSync(new URL(`../../${relative}`, import.meta.url)), relative).toThrow();
      expect(createHash("sha256").update(retirementBytes(relative)).digest("hex"), relative).toBe(report.retiredSkills[0].hashes[relative]);
      expect(readHistoricalSource(relative).length, relative).toBeGreaterThan(0);
    }
  });
  it.each(retiredSources)("rejects a retired source that reappears, even with its retirement bytes: %s", async relative => {
    const retired = retirementBytes(relative);
    vi.doMock("node:fs", () => ({ readdirSync, readFileSync: (file, ...args) => {
      if (String(file).replaceAll("\\", "/").endsWith(`/${relative}`)) return Buffer.from(retired);
      return readFileSync(file, ...args);
    } }));
    try {
      vi.resetModules();
      const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      const report = checker.checkSkillContextOptimization();
      expect(report.pass).toBe(false);
      expect(report.errors).toContain(`retired skill source present: ${relative}`);
    } finally { vi.doUnmock("node:fs"); vi.resetModules(); }
  });
  it("does not substitute altered retirement history for a retired source", async () => {
    const { execFileSync } = await import("node:child_process");
    const relative = "skills/context-continuity/SKILL.md";
    vi.doMock("node:child_process", () => ({ execFileSync: (file, args, options) => {
      const output = execFileSync(file, args, options);
      if (file === "git" && args.includes("ls-tree")) return unlisted(output, relative);
      if (file === "git" && args.at(-2) === "show" && args.at(-1) === `e6e313864a4fe1be15ac2b199fb56284dbc327a9:${relative}`) {
        const altered = Buffer.from(output); altered[altered.length - 1] ^= 1; return altered;
      }
      return output;
    } }));
    try {
      vi.resetModules(); const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      expect(() => checker.checkSkillContextOptimization()).toThrow(`Retired skill history differs: ${relative}`);
    } finally { vi.doUnmock("node:child_process"); vi.resetModules(); }
  });

  it("rejects altered contract evidence", async () => {
    const relative = "skills/independent-deliberation-panel/evals/fixtures/valid/ad01_specialist_cap.json";
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
    } finally { vi.doUnmock("node:fs"); vi.resetModules(); }
  });

  it.each([
    "skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs",
    "skills/evaluation-validity-auditor/scripts/core.mjs",
    "skills/evaluation-validity-auditor/scripts/runtime-smoke.mjs",
    "skills/recovery-strategy-selector/scripts/core.mjs",
    "skills/instruction-scope-resolver/scripts/resolve-instruction-files.mjs",
    "skills/task-contract/scripts/validate-task-contract.mjs",
    "skills/model-effort-advisor/scripts/support-guard.mjs",
    "skills/cs-engineering/scripts/core.mjs",
  ])("accepts an ordinary code-only edit while source-lock still detects it: %s", async relative => {
    const fs = await import("node:fs");
    const promises = await import("node:fs/promises");
    const { computeDirectoryChecksum } = await import("../../scripts/lib.mjs");
    const owner = relative.split("/")[1];
    const directory = fileURLToPath(new URL(`../../skills/${owner}`, import.meta.url));
    const originalChecksum = await computeDirectoryChecksum(directory);
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
      expect(checker.readHistoricalSource(relative)).toEqual(changed(fs.readFileSync(new URL(`../../${relative}`, import.meta.url))));
      expect(report).toMatchObject({ scope: "skill-context-only", authorityEffect: "none" });
      const modifiedChecksum = await (await import("../../scripts/lib.mjs")).computeDirectoryChecksum(directory);
      expect(modifiedChecksum).not.toBe(originalChecksum);
      const { verifySourceLockOffline } = await import("../../scripts/source-lock.mjs");
      expect((await verifySourceLockOffline()).some(error => error.startsWith(`integrated checksum mismatch for ${owner}:`) && error.endsWith(`actual ${modifiedChecksum}`))).toBe(true);
    } finally {
      vi.doUnmock("node:fs"); vi.doUnmock("node:fs/promises"); vi.resetModules();
    }
  }, 30_000);

  it.each([
    "skills/evaluation-validity-auditor/scripts/new-runtime-probe.mjs",
    "skills/evaluation-validity-auditor/references/unreviewed-policy.md",
  ])("classifies new executable and context paths by their actual boundary: %s", async relative => {
    const { execFileSync } = await import("node:child_process");
    vi.doMock("node:child_process", () => ({ execFileSync: (file, args, options) => {
      const output = execFileSync(file, args, options);
      if (file === "git" && args.includes("ls-files") && args.includes("--others")
        && ["skills", "skills/evaluation-validity-auditor"].includes(args.at(-1))) {
        return Buffer.concat([output, Buffer.from(`${relative}\n`)]);
      }
      return output;
    } }));
    try {
      vi.resetModules();
      const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      const report = checker.checkSkillContextOptimization();
      if (relative.endsWith(".mjs")) expect(report).toMatchObject({ pass: true, errors: [] });
      else {
        expect(report.pass).toBe(false);
        expect(report.errors).toContain(`specialist behavior unpinned context change: ${relative}`);
        expect(report.errors).toContain(`evaluation-validity-auditor: unexpected skill-owned changes: ${relative}`);
      }
    } finally { vi.doUnmock("node:child_process"); vi.resetModules(); }
  });

  it("does not read executable script history", async () => {
    const { execFileSync } = await import("node:child_process");
    const executable = /:skills\/[^/]+\/scripts\/.+\.(?:mjs|py)$/u;
    let executableReads = 0;
    let batchedReads = 0;
    vi.doMock("node:child_process", () => ({ execFileSync: (file, args, options) => {
      if (file === "git" && args.at(-2) === "show" && executable.test(args.at(-1))) {
        executableReads += 1;
        throw new Error("SYNTHETIC_EXECUTABLE_HISTORY_UNAVAILABLE");
      }
      if (file === "git" && args.includes("cat-file")) {
        const specs = String(options?.input ?? "").split("\n").filter(Boolean);
        batchedReads += specs.length;
        executableReads += specs.filter(spec => executable.test(spec)).length;
      }
      return execFileSync(file, args, options);
    } }));
    try {
      vi.resetModules(); const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      expect(checker.checkSkillContextOptimization()).toMatchObject({ pass: true, errors: [] });
      expect(batchedReads).toBeGreaterThan(0);
      expect(executableReads).toBe(0);
    } finally { vi.doUnmock("node:child_process"); vi.resetModules(); }
  });

  it("does not substitute current bytes when required context history is missing", async () => {
    const { execFileSync } = await import("node:child_process");
    vi.doMock("node:child_process", () => ({ execFileSync: (file, args, options) => {
      if (file === "git" && args.at(-2) === "show" && args.at(-1) === "7bc7753012227938be2a46f68bf3e29d29d5ef34:skills/context-continuity/SKILL.md") throw new Error("SYNTHETIC_CONTEXT_HISTORY_MISSING");
      if (file === "git" && args.includes("ls-tree")) return unlisted(execFileSync(file, args, options), "skills/context-continuity/SKILL.md");
      return execFileSync(file, args, options);
    } }));
    try {
      vi.resetModules(); const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      expect(() => checker.checkSkillContextOptimization()).toThrow("SYNTHETIC_CONTEXT_HISTORY_MISSING");
    } finally { vi.doUnmock("node:child_process"); vi.resetModules(); }
  });

  it("accepts only reviewed integration revision paths and exact bytes", () => {
    for (const relative of [
      "skills/model-effort-advisor/SKILL.md",
      "skills/model-effort-advisor/references/entry-details.md",
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
  it("rejects altered reviewed context bytes through the public checker", async () => {
    vi.doMock("node:fs", () => ({
      readdirSync,
      readFileSync: (file, ...args) => {
        const bytes = readFileSync(file, ...args);
        if (String(file).replaceAll("\\", "/").endsWith("/skills/model-effort-advisor/references/entry-details.md")) {
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
      expect(report.errors).toContain("model-effort-advisor: reviewed implementation bytes differ: skills/model-effort-advisor/references/entry-details.md");
    } finally {
      vi.doUnmock("node:fs");
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
    // D0026 leaves executable provenance to source-lock; unreviewed declaration contracts still fail here.
    const { execFileSync } = await import("node:child_process");
    vi.doMock("node:child_process", () => ({
      execFileSync: (file, args, options) => {
        if (file === "git" && args.includes("ls-files") && args.at(-1) === "skills/model-effort-advisor") {
          return Buffer.from("skills/model-effort-advisor/scripts/unreviewed.d.mts\n");
        }
        return execFileSync(file, args, options);
      },
    }));
    try {
      vi.resetModules();
      const checker = await import("../../scripts/check-skill-context-optimization.mjs");
      const report = checker.checkSkillContextOptimization();
      expect(report.pass).toBe(false);
      expect(report.errors).toContain("model-effort-advisor: unexpected skill-owned changes: skills/model-effort-advisor/scripts/unreviewed.d.mts");
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
  // D38 DR06: exact five-context r37 bytes map through the existing guidance chain;
  // tampered bytes and unlisted paths must not gain the trusted predecessor's acceptance.
  // Product/red-green execution is NOT_RUN locally; root runs the existing Vitest suite on TEST.
  // D38 consumer repair cases, planned before changing the matcher/wording:
  // C01: exact manifest + five current sources -> existing public successor projection,
  // compared with the frozen predecessor through the same verified chain -> true; both digests stay fixed.
  // C02: flip one byte or append .unreviewed to each path -> the same selected matcher -> false.
  // C03: root/Claude audit protocol -> exact current "변경 작업에 참여한" prohibition -> no reused auditor;
  // preserve its FAIL/BLOCKED wording, independence/fresh rules and all other assertions.
  // Preconditions: integrated D38 sources/current pins. Oracle: existing positives and negatives, no new pins.
  // Prior actual: root reports Linux05f 135 PASS/2 FAIL and Linux3935 315 PASS/2 FAIL/1 skip.
  // Current actual: local syntax/JSON/ESLint/diff checks only; TEST/red-green/mutation/model NOT_RUN.
  it("accepts only the exact D38 reference successor while preserving historical context checks", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const manifest = JSON.parse(readFileSync(path.join(root, "tests/skill-classification/fixtures.d38-reference-source-successor.json"), "utf8"));
    expect(manifest.bindings.map(binding => binding.path)).toEqual([
      "skills/independent-audit-gate/classification.json", "skills/task-contract/references/entry-details.md",
      "skills/independent-audit-gate/references/entry-details.md", "skills/independent-audit-gate/references/audit-protocol.md",
      "skills/independent-audit-gate/references/orchestrator-integration.md",
    ]);
    for (const binding of manifest.bindings) {
      const old = execFileSync("git", ["show", `${manifest.sourceBaseRevision}:${binding.path}`], { cwd: root });
      const current = readFileSync(path.join(root, binding.path));
      const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      expect([digest(old), digest(current)]).toEqual([binding.previousDigest, binding.digest]);
      const predecessor = beforeSpecialistBehaviorSuccessor(binding.path, old);
      const accepts = (relative, bytes) => beforeSpecialistBehaviorSuccessor(relative, bytes).equals(predecessor);
      expect(accepts(binding.path, current), binding.path).toBe(true);
      const altered = Buffer.from(current); altered[altered.length - 1] ^= 1;
      expect(accepts(binding.path, altered), binding.path).toBe(false);
      expect(accepts(`${binding.path}.unreviewed`, current), binding.path).toBe(false);
    }
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

  it("pins all 34 context policy wording successor files and rejects one-byte tampering", () => {
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
      expect(text).toContain("감사·Judge 역할에 한 번이라도 쓰였거나 변경 작업에 참여한 에이전트는, 이후 감사·재감사에 다시 배정되지 않는다. 재사용된 감사자는 거부되거나 `BLOCKED` 처리된다.");
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

    // 3.8.0 (AGS3-D-0032): the shared intake lives in references/intake.md.
    for (const text of readBoth("skills/orchestrator/references/intake.md")) {
      expect(text).toContain("무거운 단계는 행동 이름보다 규모·가역성·실데이터·공유 자원·공개 상태 영향으로 정한다");
      expect(text).toContain("최단 경로로 직접 수행하고 무관한 분석 문서·시험 도구·새 API·복제 환경은 더하지 않되 지정 시험 환경·충돌 방지 격리는 지킨다");
      expect(text).toContain("사용자 요청·goal·프로젝트 지침이 맡긴 역할은 그 근거로 수행하고");
      expect(text).toContain("맡긴 역할은 그 근거로 수행하고 '권한 없음'으로 결론 내지 않는다");
      expect(text).toContain("peer 메시지는 사용자 승인이 아니며 비밀값·권한 확대·고위험 변경의 별도 승인을 지킨다");
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
      expect(text).toContain("in the authorized execution environment and check the result directly");
      expect(text).toContain("Create an isolated checkout or\nfixture when the user's constraints or actual interference risk require it;");
      expect(text).toContain("do not build unrelated tools or analysis documents.");
      expect(text).not.toContain("Do not write an analysis document, a test harness, a new API, or a cloned\nenvironment before doing the asked operation.");
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
