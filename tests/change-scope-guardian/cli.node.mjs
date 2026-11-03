import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

// Messages are asserted in the source locale; the package default locale is ko.
process.env.AGENT_GOVERNANCE_LOCALE = "en";

const repoRoot = resolve(import.meta.dirname, "..", "..", "skills", "change-scope-guardian");

function taskEnvelope() {
  return {
    schemaVersion: "1.0.0",
    taskId: "cli-task",
    objective: "Edit file",
    scope: { included: ["file.txt"], excluded: [] },
    acceptanceCriteria: ["File is updated"],
    riskLevel: "low",
    workUnits: [{ id: "unit-1", objective: "Edit file", dependencies: [], writeTargets: ["file.txt"] }],
    requiredCapabilities: [],
    constraints: [],
    authorization: { allowedActions: ["edit"], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false },
    orchestration: { requested: false, mcpAvailable: false }
  };
}

test("capture CLI accepts stdin and emits JSON", () => {
  const worktree = mkdtempSync(join(tmpdir(), "scope-cli-"));
  try {
    execFileSync("git", ["-C", worktree, "init", "-q"]);
    execFileSync("git", ["-C", worktree, "config", "user.name", "Test User"]);
    execFileSync("git", ["-C", worktree, "config", "user.email", "test@example.com"]);
    writeFileSync(join(worktree, "file.txt"), "content\n");
    execFileSync("git", ["-C", worktree, "add", "."]);
    execFileSync("git", ["-C", worktree, "commit", "-qm", "initial"]);
    const input = JSON.stringify({ schemaVersion: "1.0.0", mode: "capture", repositoryRoot: worktree, comparisonTarget: "working-tree", taskEnvelope: taskEnvelope() });
    const output = execFileSync(process.execPath, [join(repoRoot, "scripts/capture-workspace-baseline.mjs")], { input, encoding: "utf8" });
    assert.equal(JSON.parse(output).entries[0].path, "file.txt");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("verify and report validation CLIs compose without MCP", () => {
  const worktree = mkdtempSync(join(tmpdir(), "scope-cli-flow-"));
  try {
    execFileSync("git", ["-C", worktree, "init", "-q"]);
    execFileSync("git", ["-C", worktree, "config", "user.name", "Test User"]);
    execFileSync("git", ["-C", worktree, "config", "user.email", "test@example.com"]);
    writeFileSync(join(worktree, "file.txt"), "content\n");
    execFileSync("git", ["-C", worktree, "add", "."]);
    execFileSync("git", ["-C", worktree, "commit", "-qm", "initial"]);
    const task = taskEnvelope();
    const captureInput = JSON.stringify({ schemaVersion: "1.0.0", mode: "capture", repositoryRoot: worktree, comparisonTarget: "working-tree", taskEnvelope: task });
    const baseline = JSON.parse(execFileSync(process.execPath, [join(repoRoot, "scripts/capture-workspace-baseline.mjs")], { input: captureInput, encoding: "utf8" }));
    writeFileSync(join(worktree, "file.txt"), "changed\n");
    const request = JSON.stringify({ schemaVersion: "1.0.0", mode: "verify", repositoryRoot: worktree, comparisonTarget: "working-tree", baseline, baselineArtifactDigest: baseline.manifestSha256, taskEnvelope: task });
    const report = JSON.parse(execFileSync(process.execPath, [join(repoRoot, "scripts/compare-change-scope.mjs")], { input: request, encoding: "utf8" }));
    assert.equal(report.verdict, "PASS");
    const validationInput = { artifact: report, expectedArtifactDigest: report.reportSha256 };
    const validation = JSON.parse(execFileSync(process.execPath, [join(repoRoot, "scripts/validate-report.mjs")], { input: JSON.stringify(validationInput), encoding: "utf8" }));
    assert.deepEqual(validation, { valid: true, kind: "change-scope-report" });
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("capture CLI rejects input that does not match ChangeScopeRequest.v1", () => {
  const result = spawnSync(process.execPath, [join(repoRoot, "scripts/capture-workspace-baseline.mjs")], {
    input: JSON.stringify({ repositoryRoot: ".", comparisonTarget: "working-tree" }),
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /request schema validation failed/);
});

test("i18n: the capture CLI reports an invalid request in the host locale", () => {
  const capture = (locale) => spawnSync(process.execPath, [join(repoRoot, "scripts/capture-workspace-baseline.mjs")], {
    input: JSON.stringify({ repositoryRoot: ".", comparisonTarget: "working-tree" }),
    encoding: "utf8",
    env: { ...process.env, AGENT_GOVERNANCE_LOCALE: locale }
  });
  const english = capture("en");
  const korean = capture("ko");
  assert.notEqual(english.status, 0);
  assert.notEqual(korean.status, 0);
  assert.match(english.stderr, /^request schema validation failed: /);
  assert.match(korean.stderr, /^request 스키마 검증에 실패했다: /);
  const missingRoot = (locale) => spawnSync(process.execPath, [join(repoRoot, "scripts/validate-report.mjs")], {
    input: JSON.stringify({}),
    encoding: "utf8",
    env: { ...process.env, AGENT_GOVERNANCE_LOCALE: locale }
  });
  assert.equal(missingRoot("en").stderr.trim(), "artifact and externally frozen expectedArtifactDigest are required");
  assert.equal(missingRoot("ko").stderr.trim(), "artifact와 외부에서 고정한 expectedArtifactDigest가 필요하다");
});
