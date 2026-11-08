import { access, cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { SKILL_RUNTIME_ENTRYPOINTS } from "../../scripts/runtime-entrypoints.mjs";
import { runRuntimeSmokeCheck } from "../../scripts/runtime-smoke.mjs";

const root = path.resolve(import.meta.dirname, "../..");

function documentedCliPaths(contents, documentPath, skillName) {
  const documented = new Set();
  const withoutScriptLinks = contents.replace(/\[[^\]]*\]\(([^)\s]*scripts\/[A-Za-z0-9_.-]+\.mjs)(?:#[^)\s]*)?\)/gu, (_link, target) => {
    const script = fileURLToPath(new URL(target, pathToFileURL(documentPath)));
    documented.add(path.relative(root, script).split(path.sep).join("/"));
    return "";
  });
  // Bare CLI examples use the skill directory; Markdown links use their containing document's URL.
  for (const match of withoutScriptLinks.matchAll(/scripts\/([A-Za-z0-9_.-]+\.mjs)/gu)) {
    documented.add(`skills/${skillName}/scripts/${match[1]}`);
  }
  return documented;
}

async function removeModelRuntimeFixture(cleanRoot) {
  if (path.dirname(cleanRoot) !== path.resolve(tmpdir()) || !path.basename(cleanRoot).startsWith("ags-model-effort-runtime-")) {
    throw new Error("Unexpected runtime fixture cleanup path");
  }
  await rm(cleanRoot, { recursive: true, force: true });
}

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
  it("runs the model-effort support guard with observed and unobserved fixtures without node_modules", async () => {
    const cleanRoot = await mkdtemp(path.join(tmpdir(), "ags-model-effort-runtime-"));
    try {
      await mkdir(path.join(cleanRoot, "runtime"), { recursive: true });
      await cp(path.join(root, "runtime/schema-validation.mjs"), path.join(cleanRoot, "runtime/schema-validation.mjs"));
      await cp(path.join(root, "runtime/i18n.mjs"), path.join(cleanRoot, "runtime/i18n.mjs"));
      await cp(path.join(root, "runtime/model-policy.mjs"), path.join(cleanRoot, "runtime/model-policy.mjs"));
      await mkdir(path.join(cleanRoot, "contracts"), { recursive: true });
      await cp(path.join(root, "contracts/model-policy.v1.schema.json"), path.join(cleanRoot, "contracts/model-policy.v1.schema.json"));
      await mkdir(path.join(cleanRoot, "skills"), { recursive: true });
      await cp(path.join(root, "skills/model-effort-advisor"), path.join(cleanRoot, "skills/model-effort-advisor"), { recursive: true });
      await expect(access(path.join(cleanRoot, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
      const fixture = JSON.parse(await readFile(path.join(root, "tests/skill-quality/model-effort-support-cases.json"), "utf8"));
      const environment = { ...process.env };
      delete environment.NODE_OPTIONS;
      delete environment.NODE_PATH;
      for (const id of ["trusted-provider-q", "missing-current"]) {
        const item = fixture.cases.find((value) => value.id === id);
        expect(item, id).toBeDefined();
        const result = spawnSync(process.execPath, [path.join(cleanRoot, "skills/model-effort-advisor/scripts/support-guard.mjs")], {
          cwd: cleanRoot, env: environment, input: JSON.stringify({ advice: item.advice, context: item.context }),
          encoding: "utf8", timeout: 10_000, windowsHide: true,
        });
        expect(result.error, id).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.advice.verdict, id).toBe(item.expected.verdict);
        expect(output.supportStatus, id).toBe(item.expected.supportStatus);
        expect(output.advice.userNotice, id).toBeNull();
        if (id === "missing-current") expect(output.advice.observation.model).toBeNull();
      }
    } finally {
      await removeModelRuntimeFixture(cleanRoot);
    }
  }, 10_000);
  it.each(["22.13.0", "23.11.0"])("rejects unsupported Node %s before runtime smoke execution", (version) => {
    const result = spawnSync(process.execPath, [
      "--import", pathToFileURL(path.join(root, "tests/runtime/fixtures/node-version.mjs")).href,
      path.join(root, "scripts/check-runtime.mjs"),
    ], {
      env: { ...process.env, AGS_TEST_NODE_VERSION: version },
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Node.js 24.0.0 or newer is required; found ${version}.`);
    expect(result.stdout).not.toContain("runtime: ready");
  });

  it("runs every documented Node CLI without node_modules", async () => {
    const results = await runRuntimeSmokeCheck(root);
    expect(results.map((result) => result.path)).toEqual(SKILL_RUNTIME_ENTRYPOINTS.map((entry) => entry.path));
  }, 30_000);

  it.each([
    { document: "SKILL.md", contents: "[local CLI](scripts/advise.mjs)", expected: "skills/model-effort-advisor/scripts/advise.mjs" },
    { document: "references/entry-details.md", contents: "[local CLI](../scripts/advise.mjs)", expected: "skills/model-effort-advisor/scripts/advise.mjs" },
    { document: "references/entry-details.md", contents: "[shared CLI](../../coordinate-subagents/scripts/model-routing.mjs)", expected: "skills/coordinate-subagents/scripts/model-routing.mjs" },
    { document: "references/entry-details.md", contents: "node <SKILL_DIR>/scripts/advise.mjs", expected: "skills/model-effort-advisor/scripts/advise.mjs" },
    { document: "references/entry-details.md", contents: "node scripts/advise.mjs", expected: "skills/model-effort-advisor/scripts/advise.mjs" },
  ])("resolves documented CLI paths for $contents", ({ document, contents, expected }) => {
    const documentPath = path.join(root, "skills/model-effort-advisor", document);
    expect([...documentedCliPaths(contents, documentPath, "model-effort-advisor")]).toEqual([expected]);
  });

  it("accounts for every CLI documented by SKILL.md or README.md", async () => {
    const skillRoot = path.join(root, "skills");
    const skills = (await readdir(skillRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    const documented = new Set();
    for (const skill of skills) {
      for (const document of ["SKILL.md", "README.md", "references/entry-details.md"]) {
        const documentPath = path.join(skillRoot, skill.name, document);
        const contents = await readFile(documentPath, "utf8").catch(() => "");
        for (const script of documentedCliPaths(contents, documentPath, skill.name)) documented.add(script);
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
    const test = workflow.indexOf("run: node scripts/run-tests.mjs");
    expect(bundleCheck).toBeGreaterThan(-1);
    expect(bundleCheck).toBeLessThan(build);
    expect(bundleCheck).toBeLessThan(test);
  });
});
