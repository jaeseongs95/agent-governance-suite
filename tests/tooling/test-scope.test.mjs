import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { listNodeTestFiles } from "../../scripts/run-tests.mjs";
import { serverOnlyTests, testFiles } from "../../scripts/test-scope.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const relative = file => path.relative(root, file).split(path.sep).join("/");

describe("CI and test-server split", () => {
  const server = new Set(serverOnlyTests());

  it("sends a test that starts real processes to the test servers", () => {
    expect(server.has("tests/runtime/runtime-smoke.test.mjs")).toBe(true);
  });

  it("follows a local helper that starts a stdio MCP server", () => {
    // This file starts the server only through tests/helpers/stdio-server.ts.
    expect(server.has("tests/mcp/ags30-al09-d0087-entrypoint.test.ts")).toBe(true);
  });

  it("keeps in-process tests in CI", () => {
    expect(server.has("tests/mcp/korean-prose-execution-provenance.test.ts")).toBe(false);
  });

  it("classifies a test outside tests/ that starts a process", () => {
    expect(server.has("antigravity-connector/hooks/antigravity-hook-runner.test.mjs")).toBe(true);
  });

  // Every file Vitest collects and every node:test suite run-tests.mjs collects must be classified, or a test would
  // run in neither scope (or a new location would silently fall outside both).
  it("classifies exactly the files the two runners collect", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ags-test-scope-"));
    try {
      const output = path.join(directory, "list.json");
      const env = { ...process.env };
      delete env.AGS_TEST_SCOPE;
      const listed = spawnSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "list", "--filesOnly", `--json=${output}`],
        { cwd: root, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      expect(listed.status, listed.stderr).toBe(0);
      const vitest = JSON.parse(readFileSync(output, "utf8")).map(entry => relative(entry.file));
      const node = listNodeTestFiles().map(relative);
      expect([...new Set([...vitest, ...node])].sort()).toEqual(testFiles());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
