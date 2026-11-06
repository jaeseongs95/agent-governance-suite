import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../scripts/lib.mjs";

// The public plugin manifest, not a legacy discovery fallback, supplies the MCP namespace identity.
describe("AGS3-D-0028 Antigravity package identity", () => {
  it("includes the official root plugin manifest in the install package", () => {
    const selection = JSON.parse(readFileSync(path.join(ROOT, "release/antigravity-package.json"), "utf8"));
    expect(selection.paths).toContain("plugin.json");
    expect(selection.exclude).not.toContain("plugin.json");
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "plugin.json"), "utf8"));
    const release = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(manifest.name).toBe("agent-governance-suite");
    expect(manifest.version).toBe(release.version);
  });
});

