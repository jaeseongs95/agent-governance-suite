import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SKILL_RUNTIME_ENTRYPOINTS } from "../../scripts/runtime-entrypoints.mjs";
import { runRuntimeSmokeCheck } from "../../scripts/runtime-smoke.mjs";

const root = path.resolve(import.meta.dirname, "../..");

async function scriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return scriptFiles(target);
    return entry.isFile() && entry.name.endsWith(".mjs") ? [target] : [];
  }));
  return nested.flat();
}

describe("installed skill runtime", () => {
  it("runs every documented Node CLI without node_modules", async () => {
    const results = await runRuntimeSmokeCheck(root);
    expect(results.map((result) => result.path)).toEqual(SKILL_RUNTIME_ENTRYPOINTS.map((entry) => entry.path));
  }, 30_000);

  it("accounts for every CLI documented by SKILL.md or README.md", async () => {
    const skillRoot = path.join(root, "skills");
    const skills = (await readdir(skillRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    const documented = new Set();
    for (const skill of skills) {
      for (const document of ["SKILL.md", "README.md"]) {
        const contents = await readFile(path.join(skillRoot, skill.name, document), "utf8").catch(() => "");
        for (const match of contents.matchAll(/scripts\/([A-Za-z0-9_.-]+\.mjs)/gu)) {
          documented.add(`skills/${skill.name}/scripts/${match[1]}`);
        }
      }
    }
    expect(SKILL_RUNTIME_ENTRYPOINTS.map((entry) => entry.path).sort()).toEqual([...documented].sort());
  });

  it("does not leave npm package imports in installed skill scripts", async () => {
    const files = await scriptFiles(path.join(root, "skills"));
    const violations = [];
    const packageImport = /(?:from\s+|import\s*\()\s*["'](?!node:|\.{1,2}\/|\/)([^"']+)["']/gu;
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      for (const match of contents.matchAll(packageImport)) {
        violations.push(`${path.relative(root, file)}: ${match[1]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("checks committed bundles in CI before commands that rebuild them", async () => {
    const workflow = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
    const bundleCheck = workflow.indexOf("run: pnpm bundle:check");
    const build = workflow.indexOf("run: pnpm build");
    const test = workflow.indexOf("run: pnpm test");
    expect(bundleCheck).toBeGreaterThan(-1);
    expect(bundleCheck).toBeLessThan(build);
    expect(bundleCheck).toBeLessThan(test);
  });
});
