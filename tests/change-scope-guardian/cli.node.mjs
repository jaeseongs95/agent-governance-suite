import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

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
