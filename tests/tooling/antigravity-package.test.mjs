import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../scripts/lib.mjs";

const { paths, exclude } = JSON.parse(readFileSync(path.join(ROOT, "release", "antigravity-package.json"), "utf8"));
const inPackage = (relative) =>
  paths.some((entry) => relative === entry || relative.startsWith(`${entry}/`))
  && !exclude.some((pattern) => path.matchesGlob(relative, pattern));
const toRelative = (absolute) => path.relative(ROOT, absolute).split(path.sep).join("/");

// Files agy starts from: the hook runner named in hooks.json and the server bundle named in
// mcp_config.json. Their relative file literals are what they load at run time.
function referencedFiles() {
  const hooks = readFileSync(path.join(ROOT, "hooks.json"), "utf8");
  const mcp = JSON.parse(readFileSync(path.join(ROOT, "mcp_config.json"), "utf8"));
  const entries = new Set([".gemini-plugin/plugin.json"]);
  for (const match of hooks.matchAll(/\.\/([A-Za-z0-9_./-]+\.mjs)/gu)) entries.add(match[1]);
  for (const server of Object.values(mcp.mcpServers)) {
    for (const argument of server.args) if (/\.m?js$/u.test(argument)) entries.add(argument);
  }
  const loaders = [...entries].filter((entry) => entry.endsWith(".mjs"));
  for (const file of readdirSync(path.join(ROOT, "mcp-server", "dist"))) {
    if (file.endsWith(".mjs")) loaders.push(`mcp-server/dist/${file}`);
  }
  for (const loader of loaders) {
    const source = readFileSync(path.join(ROOT, loader), "utf8");
    // Parent-relative literals of any type, and sibling module imports. Sibling JSON
    // literals are schema $ref values, resolved against the schema, not the bundle.
    for (const match of source.matchAll(/["']((?:\.\.\/)+[A-Za-z0-9_./-]+\.[a-z0-9]+|\.\/[A-Za-z0-9_./-]+\.mjs)["']/gu)) {
      entries.add(toRelative(path.resolve(ROOT, path.dirname(loader), match[1])));
    }
  }
  // The engineering-practices CLI (`self-check`) reads every file its content lock names.
  const lock = JSON.parse(readFileSync(path.join(ROOT, "runtime", "engineering-practices", "CONTENT_LOCK.json"), "utf8"));
  for (const file of lock.files) entries.add(file.path);
  return [...entries].sort();
}

describe("Antigravity install package (release/antigravity-package.json)", () => {
  it("contains every file agy and the AGS server load", () => {
    const files = referencedFiles();
    expect(files).toContain("antigravity-connector/hooks/antigravity-hook-runner.mjs");
    expect(files).toContain("mcp-server/dist/server.mjs");
    for (const file of files) {
      expect(existsSync(path.join(ROOT, file)), `${file} is referenced but missing`).toBe(true);
      expect(inPackage(file), `${file} is referenced but left out of the package`).toBe(true);
    }
  });

  it("contains the directories the server resolves from the plugin root", () => {
    for (const directory of ["skills", "contracts", "runtime"]) {
      expect(inPackage(`${directory}/x`), `${directory}/ is left out of the package`).toBe(true);
    }
  });

  it("leaves out what agy does not read", () => {
    for (const relative of ["claude-plugin/x", "tests/x", "docs/x", ".git/x", "claude-overlay/adaptations/ponytail.json",
      "antigravity-connector/hooks/antigravity-hook-runner.test.mjs", "antigravity-connector/x.test.mjs"]) {
      expect(inPackage(relative), `${relative} should not be packaged`).toBe(false);
    }
  });
});
