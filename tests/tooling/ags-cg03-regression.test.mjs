import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Source-only CG03 regression. Execution is deliberately deferred to the fixed candidate.
const commit = "a".repeat(40);
const ancestor = "b".repeat(40);
const suiteRoot = path.resolve("cg03-isolated-suite");
const mockedModules = ["node:child_process", "node:fs/promises", "../../scripts/lib.mjs",
  "../../scripts/source-lock.mjs", "../../scripts/skill-import-transaction.mjs"];
const savedArgv = process.argv;

afterEach(() => {
  process.argv = savedArgv;
  for (const module of mockedModules) vi.doUnmock(module);
  vi.restoreAllMocks();
  vi.resetModules();
});

function prepareImport({ ancestorError, versionError, expectedCommit } = {}) {
  const calls = [];
  const committed = vi.fn();
  const copied = vi.fn();
  const versionRead = vi.fn(async () => {
    if (versionError) throw versionError;
    return { version: "0.2.0", source: "skill-metadata" };
  });
  const registry = { schemaVersion: "2.0.0", skills: [] };
  const lock = { schemaVersion: "3.0.0", sources: [] };
  vi.doMock("node:child_process", () => ({ execFileSync: (_file, args) => {
    calls.push(args);
    if (args.includes("rev-parse")) return `${commit}\n`;
    if (args.includes("merge-base") && ancestorError) throw ancestorError;
    return "";
  } }));
  let directoryCount = 0;
  vi.doMock("node:fs/promises", () => ({
    mkdtemp: async () => path.join(suiteRoot, `temporary-${directoryCount++}`),
    stat: async () => ({}), mkdir: vi.fn(), writeFile: vi.fn(),
    readFile: async file => String(file).endsWith("SKILL.md")
      ? "---\nname: cg03-skill\nmetadata:\n  version: 0.2.0\n---\n"
      : Buffer.from("original bytes"),
  }));
  vi.doMock("../../scripts/lib.mjs", () => ({
    ROOT: suiteRoot, NAME_PATTERN: /^[a-z0-9-]+$/u,
    parseArguments: () => ({ source: "upstream", ref: "v0.2.0", "skill-path": ".",
      phase: "validation", capability: "cg03-check", "descendant-of": ancestor,
      ...(expectedCommit === undefined ? {} : { "expected-commit": expectedCommit }) }),
    computeDirectoryChecksum: async () => `sha256:${"c".repeat(64)}`,
    defaultProvider: () => ({ capabilities: ["cg03-check"] }),
    pathExists: async () => false,
    readFrontmatter: () => ({ name: "cg03-skill" }),
    readJson: async file => {
      if (String(file).endsWith("registry.json")) return registry;
      if (String(file).endsWith("source-lock.json")) return lock;
      throw Object.assign(new Error("descriptor missing"), { code: "ENOENT" });
    },
  }));
  vi.doMock("../../scripts/source-lock.mjs", () => ({
    copyAllowlisted: copied, readSkillVersion: versionRead,
  }));
  vi.doMock("../../scripts/skill-import-transaction.mjs", () => ({
    commitSkillImport: committed,
    cleanupSkillImport: async input => { if (input.operationFailed) throw input.failure; },
  }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.resetModules();
  return { calls, committed, copied, versionRead, lock };
}

describe("CG03 import preflight", () => {
  it.each([
    ["git error", { status: 128 }],
    ["spawn failure", { code: "ENOENT", status: null }],
    ["signal", { status: null, signal: "SIGTERM" }],
  ])("preserves %s as an ancestor verification failure", async (_label, details) => {
    const cause = Object.assign(new Error("injected git failure"), details);
    const state = prepareImport({ ancestorError: cause });
    await expect(import("../../scripts/import-skill.mjs")).rejects.toMatchObject({
      message: "Could not verify the required ancestor commit", cause,
    });
    expect(state.calls.some(args => args.includes("checkout"))).toBe(false);
    expect(state.versionRead).not.toHaveBeenCalled();
    expect(state.committed).not.toHaveBeenCalled();
  });

  it("classifies only git exit 1 as a non-ancestor result", async () => {
    const cause = Object.assign(new Error("not ancestor"), { status: 1 });
    const state = prepareImport({ ancestorError: cause });
    await expect(import("../../scripts/import-skill.mjs")).rejects.toMatchObject({
      message: expect.stringContaining("does not contain"), cause,
    });
    expect(state.committed).not.toHaveBeenCalled();
  });

  it("preserves metadata reader failures instead of reporting missing metadata", async () => {
    const cause = Object.assign(new Error("metadata read denied"), { code: "EACCES" });
    const state = prepareImport({ versionError: cause });
    await expect(import("../../scripts/import-skill.mjs")).rejects.toBe(cause);
    expect(state.copied).not.toHaveBeenCalled();
    expect(state.committed).not.toHaveBeenCalled();
  });

  it.each(["", "short-sha", "A".repeat(40)])("rejects invalid expected commit %j", async expectedCommit => {
    const state = prepareImport({ expectedCommit });
    await expect(import("../../scripts/import-skill.mjs")).rejects.toThrow("--expected-commit must be a full commit SHA");
    expect(state.calls.some(args => args.includes("checkout"))).toBe(false);
    expect(state.committed).not.toHaveBeenCalled();
  });

  it("refuses a tag that moved after upstream discovery before checkout or writes", async () => {
    const state = prepareImport({ expectedCommit: "d".repeat(40) });
    await expect(import("../../scripts/import-skill.mjs")).rejects.toThrow("refusing changed upstream content");
    expect(state.calls.some(args => args.includes("checkout"))).toBe(false);
    expect(state.copied).not.toHaveBeenCalled();
    expect(state.committed).not.toHaveBeenCalled();
  });

  it.each([undefined, commit])("imports an unchanged ref with expected commit %s", async expectedCommit => {
    const state = prepareImport({ expectedCommit });
    await import("../../scripts/import-skill.mjs");
    expect(state.committed).toHaveBeenCalledOnce();
    expect(state.lock.sources[0].ref).toEqual({ kind: "tag", value: "v0.2.0", commit });
  });
});

it("passes the discovered commit to the child import as well as the stable tag", async () => {
  const stopped = new Error("stop after child invocation");
  const execute = vi.fn(() => { throw stopped; });
  vi.doMock("node:child_process", () => ({ execFileSync: execute }));
  vi.doMock("../../scripts/lib.mjs", () => ({ ROOT: suiteRoot, readJson: async () => ({
    sources: [{ skillId: "cg03-skill", updatePolicy: "auto-pr", downstreamModifications: [],
      source: "upstream", sourcePath: ".", ref: { commit: ancestor } }],
  }) }));
  vi.doMock("../../scripts/source-lock.mjs", () => ({ discoverUpstreamUpdates: async () => [{
    skillId: "cg03-skill", updateAvailable: true, latestTag: "v0.2.0", latestCommit: commit,
  }] }));
  process.argv = [process.execPath, "apply-upstream-update.mjs", "cg03-skill", "v0.2.0"];
  vi.resetModules();
  await expect(import("../../scripts/apply-upstream-update.mjs")).rejects.toBe(stopped);
  expect(execute).toHaveBeenCalledWith(process.execPath, [
    path.join(suiteRoot, "scripts", "import-skill.mjs"),
    "--source", "upstream", "--ref", "v0.2.0", "--expected-commit", commit,
    "--skill-path", ".", "--replace", "true", "--descendant-of", ancestor,
  ], { cwd: suiteRoot, stdio: "inherit" });
});
