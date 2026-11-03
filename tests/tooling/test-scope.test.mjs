import { describe, expect, it } from "vitest";

import { serverOnlyTests } from "../../scripts/test-scope.mjs";

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
    expect(server.has("tests/tooling/test-scope.test.mjs")).toBe(false);
  });
});
