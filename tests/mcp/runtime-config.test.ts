import { tmpdir } from "node:os";
import { basename, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveRegistryPath } from "../../mcp-server/src/runtime-config.js";

describe("resolveRegistryPath", () => {
  it("uses SKILL_REGISTRY_PATH when supplied", () => {
    expect(resolveRegistryPath({ SKILL_REGISTRY_PATH: "/tmp/custom/registry.json" })).toBe("/tmp/custom/registry.json");
  });

  it("locates skills/registry.json relative to the bundled entry point by default", () => {
    const entrypoint = pathToFileURL(
      join(tmpdir(), "agent-governance-suite", "mcp-server", "dist", "server.mjs")
    ).href;
    const path = normalize(resolveRegistryPath({}, entrypoint));

    expect(basename(path)).toBe("registry.json");
    expect(path).toContain(normalize("skills/registry.json"));
  });
});
