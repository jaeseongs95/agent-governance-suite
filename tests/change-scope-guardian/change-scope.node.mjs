import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { canonicalJson, captureBaseline, compareScope, resolveRepository, sha256, validateBaseline, validateReport } from "../../skills/change-scope-guardian/scripts/lib.mjs";

const roots = [];

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "scope-guardian-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.com");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "src", "app.js"), "export const value = 1;\n");
  writeFileSync(join(root, "docs", "note.md"), "baseline\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  return root;
}

function envelope(included = ["src/**"], excluded = ["docs/**"]) {
  return {
    schemaVersion: "1.0.0",
    taskId: "task-1",
    objective: "Update source",
    scope: { included, excluded },
    acceptanceCriteria: ["Source is updated"],
    riskLevel: "low",
    workUnits: [{ id: "unit-1", objective: "Edit source", dependencies: [], writeTargets: included }],
    requiredCapabilities: [],
    constraints: [],
    authorization: { allowedActions: ["edit"], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false },
    orchestration: { requested: false, mcpAvailable: false }
  };
}

function baselineFor(root, comparisonTarget = "working-tree", options = {}, now) {
  return captureBaseline({ schemaVersion: "1.0.0", mode: "capture", repositoryRoot: root, comparisonTarget, taskEnvelope: options.taskEnvelope ?? envelope(), ...options }, now);
}

function verificationFor(root, baseline, taskEnvelope = envelope(), options = {}) {
  return {
    schemaVersion: "1.0.0",
    mode: "verify",
    repositoryRoot: root,
    comparisonTarget: "working-tree",
    taskEnvelope,
    ...(baseline ? { baseline, baselineArtifactDigest: baseline.manifestSha256 } : {}),
    ...options
  };
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("uses Git worktree membership for repository subdirectories", () => {
  const root = repository();
  const fromRoot = resolveRepository(root);
  const fromNestedDirectory = resolveRepository(join(root, "src"));
  assert.deepEqual(fromNestedDirectory, fromRoot);
});

test("captures a deterministic manifest without changing Git state", () => {
  const root = repository();
  const before = git(root, "status", "--porcelain=v1");
  const first = baselineFor(root, "working-tree", {}, new Date("2026-01-01T00:00:00Z"));
  const second = baselineFor(root, "working-tree", {}, new Date("2026-01-01T00:00:00Z"));
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.equal(first.entries.length, 2);
  assert.equal(git(root, "status", "--porcelain=v1"), before);
});

test("classifies an allowed source change as in-scope", () => {
  const root = repository();
  const baseline = baselineFor(root);
  writeFileSync(join(root, "src", "app.js"), "export const value = 2;\n");
  const report = compareScope(verificationFor(root, baseline));
  assert.equal(report.verdict, "PASS");
  assert.equal(report.changes[0].matchedRule, "src/**");
  assert.deepEqual(report.changes.map(({ path, classification }) => ({ path, classification })), [{ path: "src/app.js", classification: "in-scope" }]);
});

test("blocks explicit excluded changes", () => {
  const root = repository();
  const baseline = baselineFor(root);
  writeFileSync(join(root, "docs", "note.md"), "changed\n");
  const report = compareScope(verificationFor(root, baseline));
  assert.equal(report.verdict, "BLOCKED");
  assert.equal(report.changes[0].classification, "excluded");
});

test("requires approval for an unplanned path", () => {
  const root = repository();
  const baseline = baselineFor(root);
  writeFileSync(join(root, "other.txt"), "new\n");
  const report = compareScope(verificationFor(root, baseline));
  assert.equal(report.verdict, "NEEDS_APPROVAL");
  assert.equal(report.changes[0].classification, "unplanned");
});

test("preserves untouched preexisting changes and detects overlap", () => {
  const root = repository();
  writeFileSync(join(root, "src", "app.js"), "export const value = 2;\n");
  const baseline = baselineFor(root);
  const untouched = compareScope(verificationFor(root, baseline));
  assert.equal(untouched.changes[0].classification, "preexisting-untouched");
  assert.equal(untouched.verdict, "PASS");

  writeFileSync(join(root, "src", "app.js"), "export const value = 3;\n");
  const overlap = compareScope(verificationFor(root, baseline));
  assert.equal(overlap.changes[0].classification, "preexisting-overlap");
  assert.equal(overlap.verdict, "NEEDS_APPROVAL");
});

test("requires both rename paths to be in scope", () => {
  const root = repository();
  const scopedEnvelope = envelope(["src/renamed.js"], []);
  const baseline = baselineFor(root, "working-tree", { taskEnvelope: scopedEnvelope });
  git(root, "mv", "src/app.js", "src/renamed.js");
  const report = compareScope(verificationFor(root, baseline, scopedEnvelope));
  assert.equal(report.verdict, "NEEDS_APPROVAL");
  assert.ok(report.changes.some((item) => item.classification === "unplanned"));
});

test("rejects a baseline from another repository", () => {
  const first = repository();
  const second = repository();
  const baseline = baselineFor(first);
  assert.throws(() => compareScope(verificationFor(second, baseline)), /identity does not match/);
});

test("returns INCONCLUSIVE instead of guessing ownership without a baseline", () => {
  const root = repository();
  writeFileSync(join(root, "src", "app.js"), "export const value = 2;\n");
  const report = compareScope(verificationFor(root));
  assert.equal(report.verdict, "INCONCLUSIVE");
  assert.equal(report.changes[0].classification, "ownership-unknown");
});

test("index comparison ignores unstaged content and sees staged content", () => {
  const root = repository();
  const baseline = baselineFor(root, "index");
  writeFileSync(join(root, "src", "app.js"), "export const value = 2;\n");
  const unstaged = compareScope(verificationFor(root, baseline, envelope(), { comparisonTarget: "index" }));
  assert.equal(unstaged.changes.length, 0);
  assert.equal(unstaged.verdict, "PASS");

  git(root, "add", "src/app.js");
  const staged = compareScope(verificationFor(root, baseline, envelope(), { comparisonTarget: "index" }));
  assert.equal(staged.changes[0].classification, "in-scope");
});

test("compares two fixed commits without reading working-tree content", () => {
  const root = repository();
  const first = git(root, "rev-parse", "HEAD");
  const baseline = baselineFor(root, "commit", { commit: first });
  writeFileSync(join(root, "src", "app.js"), "export const value = 2;\n");
  git(root, "add", "src/app.js");
  git(root, "commit", "-qm", "second");
  const second = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "src", "app.js"), "working tree differs\n");
  const report = compareScope(verificationFor(root, baseline, envelope(), { comparisonTarget: "commit", commit: second }));
  assert.equal(report.verdict, "PASS");
  assert.equal(report.changes[0].classification, "in-scope");
});

test("checks a deletion by its pre-deletion path", () => {
  const root = repository();
  const baseline = baselineFor(root);
  rmSync(join(root, "src", "app.js"));
  const report = compareScope(verificationFor(root, baseline));
  assert.equal(report.verdict, "PASS");
  assert.equal(report.changes.find((item) => item.path === "src/app.js")?.classification, "in-scope");
});

test("preserves Unicode and spaces in repository-relative paths", () => {
  const root = repository();
  const baseline = baselineFor(root);
  writeFileSync(join(root, "src", "한 글.js"), "export default true;\n");
  const report = compareScope(verificationFor(root, baseline));
  assert.equal(report.verdict, "PASS");
  assert.equal(report.changes[0].path, "src/한 글.js");
});

test("captures a repository with no commits", () => {
  const root = mkdtempSync(join(tmpdir(), "scope-empty-"));
  roots.push(root);
  git(root, "init", "-q");
  const baseline = baselineFor(root);
  assert.equal(baseline.head, null);
  assert.deepEqual(baseline.entries, []);
});

test("rejects tampered baseline and inconsistent report verdicts", () => {
  const root = repository();
  const baseline = baselineFor(root);
  assert.equal(validateBaseline(baseline), baseline);
  const tampered = { ...baseline, manifestSha256: "0".repeat(64) };
  assert.throws(() => validateBaseline(tampered), /checksum/);
  assert.throws(() => compareScope(verificationFor(root, tampered)), /checksum|frozen digest/);

  writeFileSync(join(root, "src", "app.js"), "export const value = 2;\n");
  const report = compareScope(verificationFor(root, baseline));
  assert.equal(validateReport(report, report.reportSha256), report);
  assert.throws(() => validateReport({ ...report, verdict: "BLOCKED" }, report.reportSha256), /does not match|checksum|frozen digest/);
  assert.throws(() => validateReport({ ...report, changes: report.changes.map((item) => ({ ...item, matchedRule: true })) }, report.reportSha256), /schema validation|matchedRule/);
});

test("rejects a baseline captured for a different frozen task envelope", () => {
  const root = repository();
  const baseline = baselineFor(root);
  const changedTask = { ...envelope(), objective: "Different objective" };
  assert.throws(() => compareScope(verificationFor(root, baseline, changedTask)), /taskEnvelope digest/);
});

test("rejects unsafe scope rules instead of silently ignoring them", () => {
  const root = repository();
  for (const rule of ["../docs/**", "C:docs/**", "~/docs/**", "~user/docs/**", "docs/./**", "."]) {
    const unsafe = envelope(["**"], [rule]);
    assert.throws(() => baselineFor(root, "working-tree", { taskEnvelope: unsafe }), /scope rule is unsafe/, rule);
  }
});

test("matches Windows scope rules without path-case bypass", { skip: process.platform !== "win32" }, () => {
  const root = repository();
  const task = envelope(["**"], ["DOCS/**"]);
  const baseline = baselineFor(root, "working-tree", { taskEnvelope: task });
  writeFileSync(join(root, "docs", "note.md"), "changed\n");
  const report = compareScope(verificationFor(root, baseline, task));
  assert.equal(report.verdict, "BLOCKED");
  assert.equal(report.changes[0].classification, "excluded");
});

test("requires an externally frozen baseline digest even when a forged checksum is self-consistent", () => {
  const root = repository();
  writeFileSync(join(root, "src", "app.js"), "export const value = 2;\n");
  const baseline = baselineFor(root);
  const frozenDigest = baseline.manifestSha256;
  writeFileSync(join(root, "src", "app.js"), "export const value = 3;\n");
  const current = baselineFor(root);
  const forged = JSON.parse(JSON.stringify(baseline));
  forged.entries = current.entries;
  forged.manifestSha256 = sha256(canonicalJson({
    repositoryIdentity: forged.repository.identity,
    head: forged.head,
    comparisonTarget: forged.comparisonTarget,
    targetRef: forged.targetRef,
    taskEnvelopeDigest: forged.taskEnvelopeDigest,
    entries: forged.entries,
    capturedAt: forged.capturedAt
  }));
  assert.throws(() => compareScope(verificationFor(root, forged, envelope(), { baselineArtifactDigest: frozenDigest })), /frozen digest/);
});

test("rejects schema-invalid baselines and reports plus self-consistent report rewrites", () => {
  const root = repository();
  const baseline = baselineFor(root);
  const invalidBaseline = { ...baseline, capturedAt: "not-a-date" };
  invalidBaseline.manifestSha256 = sha256(canonicalJson({
    repositoryIdentity: invalidBaseline.repository.identity,
    head: invalidBaseline.head,
    comparisonTarget: invalidBaseline.comparisonTarget,
    targetRef: invalidBaseline.targetRef,
    taskEnvelopeDigest: invalidBaseline.taskEnvelopeDigest,
    entries: invalidBaseline.entries,
    capturedAt: invalidBaseline.capturedAt
  }));
  assert.throws(() => validateBaseline(invalidBaseline), /schema validation/);

  writeFileSync(join(root, "src", "app.js"), "export const value = 2;\n");
  const report = compareScope(verificationFor(root, baseline));
  const forgedUnsigned = {
    ...report,
    changes: [],
    summary: { "in-scope": 0, excluded: 0, unplanned: 0, "preexisting-untouched": 0, "preexisting-overlap": 0, "ownership-unknown": 0 },
    findings: [],
    verdict: "PASS"
  };
  delete forgedUnsigned.reportSha256;
  const forged = { ...forgedUnsigned, reportSha256: sha256(canonicalJson(forgedUnsigned)) };
  assert.throws(() => validateReport(forged, report.reportSha256), /frozen digest/);

  const invalidDateUnsigned = { ...report, observedAt: "not-a-date" };
  delete invalidDateUnsigned.reportSha256;
  const invalidDate = { ...invalidDateUnsigned, reportSha256: sha256(canonicalJson(invalidDateUnsigned)) };
  assert.throws(() => validateReport(invalidDate, invalidDate.reportSha256), /schema validation/);
});

test("treats a repeatedly dirty submodule as overlap instead of claiming it was untouched", () => {
  const child = repository();
  const root = repository();
  git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "sub");
  git(root, "commit", "-qm", "add submodule");
  writeFileSync(join(root, "sub", "src", "app.js"), "export const value = 2;\n");
  const task = envelope(["sub"], []);
  const baseline = baselineFor(root, "working-tree", { taskEnvelope: task });
  writeFileSync(join(root, "sub", "src", "app.js"), "export const value = 3;\n");
  const report = compareScope(verificationFor(root, baseline, task));
  assert.equal(report.verdict, "NEEDS_APPROVAL");
  assert.equal(report.changes.find((item) => item.path === "sub")?.classification, "preexisting-overlap");
});
