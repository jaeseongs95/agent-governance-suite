import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

// Instrument real process entry points; never manufacture Git stdout or errors.
const realExecFileSync = childProcess.execFileSync;
let activeCalls = null;
for (const method of ["execFileSync", "spawnSync", "execSync", "spawn", "execFile", "exec"]) {
  const original = childProcess[method];
  childProcess[method] = function (command, ...args) {
    if (activeCalls && /^(?:git|git\.exe)$/i.test(basename(String(command)))) activeCalls.push({ method, argv: args[0] });
    return Reflect.apply(original, this, [command, ...args]);
  };
}
syncBuiltinESMExports();
const { captureBaseline } = await import("../../skills/change-scope-guardian/scripts/lib.mjs");
process.env.AGENT_GOVERNANCE_LOCALE = "en";
const roots = [];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (root, ...args) => realExecFileSync("git", ["-C", root, ...args], { windowsHide: true, maxBuffer: 80 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
const text = (root, ...args) => git(root, ...args).toString("utf8").trim();

function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ags-scope-batch-")));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Scope Fixture");
  git(root, "config", "user.email", "scope@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "core.quotepath", "false");
  return root;
}
function put(root, path, bytes) {
  const parts = path.split("/");
  if (parts.length > 1) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...parts), bytes);
}
function commit(root) { git(root, "add", "-A"); git(root, "commit", "-qm", "fixture"); return text(root, "rev-parse", "HEAD"); }
function capture(root, target, options = {}) {
  return captureBaseline({
    schemaVersion: "1.0.0", mode: "capture", repositoryRoot: root, comparisonTarget: target,
    ...(target === "commit" ? { commit: "HEAD" } : {}), ...options,
    taskEnvelope: {
      schemaVersion: "1.0.0", taskId: "git-batch-regression", objective: "Preserve snapshots with bounded Git processes",
      scope: { included: ["**"], excluded: [] }, acceptanceCriteria: ["Exact content and bounded process count"], riskLevel: "low",
      workUnits: [{ id: "test", objective: "Inspect snapshots", dependencies: [], writeTargets: ["**"] }], requiredCapabilities: [], constraints: [],
      authorization: { allowedActions: ["read"], prohibitedActions: [], approvalRequired: [] },
      decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: false, mcpAvailable: false }
    }
  }, new Date("2026-11-07T00:00:00.000Z"));
}
function measured(root, target) {
  const calls = [];
  activeCalls = calls;
  const start = performance.now();
  try { return { snapshot: capture(root, target), calls, elapsedMs: performance.now() - start }; }
  finally { activeCalls = null; }
}
function entry(snapshot, path) { const found = snapshot.entries.find(item => item.path === path); assert.ok(found, `Missing entry ${JSON.stringify(path)}`); return found; }
function content(snapshot, path, bytes, extra = {}) {
  assert.deepEqual(entry(snapshot, path), { path, status: "clean", sha256: digest(bytes), size: Buffer.byteLength(bytes), kind: "file", originalPath: null, ...extra });
}
test.after(() => {
  for (const root of roots) {
    const rel = relative(realpathSync(tmpdir()), realpathSync(root));
    assert.ok(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit and index preserve exact binary, empty, Unicode and whitespace names", () => {
  const root = repository();
  const corpus = new Map([
    ["empty", Buffer.alloc(0)], ["한글 space/file name.txt", Buffer.from("첫 줄\nsecond\r\n")],
    ["binary.bin", Buffer.from([0, 255, 10, 13, 128, 0, 42])], ["-dash", Buffer.from("dash")],
    ["duplicate", Buffer.from([0, 255, 10, 13, 128, 0, 42])]
  ]);
  if (process.platform !== "win32") corpus.set("line\nbreak\tname", Buffer.from("payload\nwith\0NUL"));
  for (const [path, bytes] of corpus) put(root, path, bytes);
  const sha = commit(root);
  for (const target of ["commit", "index"]) {
    const snapshot = capture(root, target);
    assert.equal(snapshot.targetRef, target === "commit" ? sha : "INDEX");
    assert.equal(snapshot.entries.length, corpus.size);
    for (const [path, bytes] of corpus) content(snapshot, path, bytes);
  }
  put(root, "binary.bin", Buffer.from("staged bytes\0\n")); git(root, "add", "binary.bin");
  put(root, "binary.bin", Buffer.from("unstaged bytes"));
  content(capture(root, "commit"), "binary.bin", corpus.get("binary.bin"));
  content(capture(root, "index"), "binary.bin", Buffer.from("staged bytes\0\n"), { status: "M" });
});

test("index preserves rename, deletion and target absence without absorbing worktree content", () => {
  const root = repository();
  put(root, "before name", "rename content\n"); put(root, "deleted", "deleted content\n"); commit(root);
  git(root, "mv", "before name", "after name"); git(root, "rm", "-q", "deleted");
  put(root, "after name", "worktree differs"); put(root, "untracked", "not index");
  const snapshot = capture(root, "index");
  content(snapshot, "after name", "rename content\n", { status: "R", originalPath: "before name" });
  for (const path of ["before name", "deleted"]) assert.deepEqual(entry(snapshot, path), {
    path, status: path === "deleted" ? "D" : "deleted", sha256: null, size: null, kind: "missing", originalPath: null
  });
  assert.ok(!snapshot.entries.some(item => item.path === "untracked"));
});

test("index and commit preserve Git symlink and gitlink show semantics", () => {
  const root = repository(); put(root, "plain", "content"); const parent = commit(root);
  const linkBytes = Buffer.from("plain");
  const oid = realExecFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: linkBytes, encoding: "utf8", windowsHide: true }).trim();
  git(root, "update-index", "--add", "--cacheinfo", `120000,${oid},link`);
  git(root, "update-index", "--add", "--cacheinfo", `160000,${parent},submodule`);
  git(root, "commit", "-qm", "special entries");
  for (const target of ["commit", "index"]) {
    const snapshot = capture(root, target);
    content(snapshot, "link", linkBytes);
    // git show is the preexisting public contract for gitlinks, not raw commit bytes.
    const expected = git(root, "show", target === "commit" ? "HEAD:submodule" : ":submodule");
    const actual = entry(snapshot, "submodule");
    assert.equal(actual.sha256, digest(expected)); assert.equal(actual.size, expected.length);
  }
});

test("Git object/read failures are errors rather than missing entries", () => {
  const root = repository(); put(root, "plain", "content"); commit(root);
  assert.throws(() => capture(root, "commit", { commit: "refs/heads/does-not-exist" }), /git|Git/);
  git(root, "update-index", "--add", "--cacheinfo", `100644,${"1".repeat(40)},missing-object`);
  assert.throws(() => capture(root, "index"), /git|Git/);
});

for (const target of ["commit", "index"]) test(`${target} Git process count stays bounded when files grow 8 to 80`, t => {
  const results = [];
  for (const count of [8, 80]) {
    const root = repository();
    for (let index = 0; index < count; index++) put(root, `file-${index}`, `unique content ${index}\n`);
    commit(root);
    const result = measured(root, target);
    assert.equal(result.snapshot.entries.length, count);
    results.push({ files: count, gitProcesses: result.calls.length, elapsedMs: result.elapsedMs });
  }
  t.diagnostic(JSON.stringify({ target, measurements: results, node: process.version, platform: process.platform }));
  assert.equal(results[1].gitProcesses, results[0].gitProcesses, "Git process count must not grow per file");
  assert.ok(results[1].gitProcesses <= 16, "Small-object capture must use a bounded number of Git processes");
});

test("aggregate blobs above 64 MiB remain exact without one aggregate output buffer", t => {
  const root = repository(); const expected = [];
  for (let index = 0; index < 9; index++) {
    const bytes = Buffer.alloc(8 * 1024 * 1024, index + 1); bytes[1] = 0; bytes[2] = 10;
    const path = `blob-${index}`; put(root, path, bytes); expected.push([path, digest(bytes), bytes.length]);
  }
  commit(root);
  for (const target of ["commit", "index"]) {
    const result = measured(root, target);
    assert.equal(result.snapshot.entries.length, 9);
    for (const [path, sha, size] of expected) { const actual = entry(result.snapshot, path); assert.equal(actual.sha256, sha); assert.equal(actual.size, size); }
    t.diagnostic(JSON.stringify({ target, aggregateBytes: 72 * 1024 * 1024, gitProcesses: result.calls.length, elapsedMs: result.elapsedMs, maxRssKiB: process.resourceUsage().maxRSS }));
  }
});

test("a single object exceeding the existing 64 MiB limit fails closed", () => {
  const root = repository(); put(root, "too-large", Buffer.alloc(64 * 1024 * 1024 + 1, 17)); commit(root);
  for (const target of ["commit", "index"]) assert.throws(() => capture(root, target), /git|Git/);
});

test("individual blobs above a batch and exactly at 64 MiB retain their bytes", () => {
  const root = repository();
  const expected = [];
  for (const size of [32 * 1024 * 1024 + 1, 64 * 1024 * 1024]) {
    const path = `size-${size}`;
    const bytes = Buffer.alloc(size, 29); bytes[0] = 0; bytes[size - 1] = 10;
    put(root, path, bytes); expected.push([path, digest(bytes), size]);
  }
  commit(root);
  for (const target of ["commit", "index"]) {
    const snapshot = capture(root, target);
    for (const [path, sha, size] of expected) {
      const actual = entry(snapshot, path); assert.equal(actual.sha256, sha); assert.equal(actual.size, size);
    }
  }
});
