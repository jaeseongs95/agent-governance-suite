import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories = [];
const name = "cg01-example";
const registryBytes = '{"schemaVersion":"2.0.0","skills":[]}\n';

async function fixture() {
  const suiteRoot = await mkdtemp(path.join(tmpdir(), "ags-cg01-"));
  temporaryDirectories.push(suiteRoot);
  await mkdir(path.join(suiteRoot, "skills"));
  await mkdir(path.join(suiteRoot, "tests"));
  await writeFile(path.join(suiteRoot, "skills", "registry.json"), registryBytes);
  return suiteRoot;
}

function run(suiteRoot, phase = "validation") {
  return spawnSync(process.execPath, [
    path.join(root, "scripts", "new-skill.mjs"),
    "--name", name, "--phase", phase, "--capability", "cg01-validation"
  ], { cwd: root, encoding: "utf8", env: { ...process.env, AGENT_GOVERNANCE_ROOT: suiteRoot } });
}

async function expectUnchanged(suiteRoot) {
  expect(await readFile(path.join(suiteRoot, "skills", "registry.json"), "utf8")).toBe(registryBytes);
  await expect(lstat(path.join(suiteRoot, "skills", name))).rejects.toMatchObject({ code: "ENOENT" });
}

async function outside(suiteRoot) {
  // Shares the root's text prefix, but is outside its actual filesystem boundary.
  const directory = `${suiteRoot}-outside`;
  temporaryDirectories.push(directory);
  await mkdir(directory);
  return directory;
}

async function linkDirectory(target, link) {
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CG01 skill scaffolder regression", () => {
  it("creates valid generated files and the final provider descriptor", async () => {
    const suiteRoot = await fixture();
    const result = run(suiteRoot);
    expect(result.status, result.error?.message || result.stderr).toBe(0);
    expect(await readFile(path.join(suiteRoot, "skills", name, "SKILL.md"), "utf8")).toContain(`name: ${name}`);
    const cases = JSON.parse(await readFile(path.join(suiteRoot, "tests", name, "cases.json"), "utf8"));
    expect(Object.keys(cases)).toEqual(["normal", "boundary", "failure"]);
    const registry = JSON.parse(await readFile(path.join(suiteRoot, "skills", "registry.json"), "utf8"));
    expect(registry.skills).toHaveLength(1);
    expect(registry.skills[0]).toMatchObject({
      schemaVersion: "2.0.0", skillId: name,
      providers: [{ phase: "validation", capabilities: ["cg01-validation"] }]
    });
  });

  it("AGS-D-0127 preserves an existing cases.json and registry bytes", async () => {
    const suiteRoot = await fixture();
    await mkdir(path.join(suiteRoot, "tests", name));
    const casesPath = path.join(suiteRoot, "tests", name, "cases.json");
    const original = Buffer.from([0, 255, 13, 10, 65]);
    await writeFile(casesPath, original);
    const result = run(suiteRoot);
    expect(result.status, result.error?.message).not.toBe(0);
    expect(await readFile(casesPath)).toEqual(original);
    await expectUnchanged(suiteRoot);
  });

  it("AGS-D-0127 refuses even an existing empty test destination", async () => {
    const suiteRoot = await fixture();
    await mkdir(path.join(suiteRoot, "tests", name));
    expect(run(suiteRoot).status).not.toBe(0);
    expect(await readdir(path.join(suiteRoot, "tests", name))).toEqual([]);
    await expectUnchanged(suiteRoot);
  });

  for (const parent of ["skills", "tests"]) {
    it(`AGS-D-0128 rejects an escaping ${parent} directory link before writes`, async () => {
      const suiteRoot = await fixture();
      const external = await outside(suiteRoot);
      if (parent === "skills") await writeFile(path.join(external, "registry.json"), registryBytes);
      await rm(path.join(suiteRoot, parent), { recursive: true });
      await linkDirectory(external, path.join(suiteRoot, parent));
      const result = run(suiteRoot);
      expect(result.status, result.error?.message).not.toBe(0);
      expect(result.stderr).toContain("path escapes the suite root");
      expect(await readdir(external)).toEqual(parent === "skills" ? ["registry.json"] : []);
      await expectUnchanged(suiteRoot);
    });
  }

  it("AGS-D-0128 rejects a dangling destination link without following it", async () => {
    const suiteRoot = await fixture();
    const external = await outside(suiteRoot);
    await linkDirectory(path.join(external, "missing"), path.join(suiteRoot, "tests", name));
    expect(run(suiteRoot).status).not.toBe(0);
    expect(await readdir(external)).toEqual([]);
    expect((await lstat(path.join(suiteRoot, "tests", name))).isSymbolicLink()).toBe(true);
    await expectUnchanged(suiteRoot);
  });

  it("AGS-D-0128 permits a test parent link that resolves inside the suite", async () => {
    const suiteRoot = await fixture();
    const internal = path.join(suiteRoot, "test-data");
    await mkdir(internal);
    await rm(path.join(suiteRoot, "tests"), { recursive: true });
    await linkDirectory(internal, path.join(suiteRoot, "tests"));
    const result = run(suiteRoot);
    expect(result.status, result.error?.message || result.stderr).toBe(0);
    expect(await readdir(path.join(internal, name))).toEqual(["cases.json"]);
  });

  it.skipIf(process.platform === "win32")("AGS-D-0128 rejects a registry file link outside the suite", async () => {
    const suiteRoot = await fixture();
    const external = await outside(suiteRoot);
    const externalRegistry = path.join(external, "registry.json");
    await writeFile(externalRegistry, registryBytes);
    await rm(path.join(suiteRoot, "skills", "registry.json"));
    await symlink(externalRegistry, path.join(suiteRoot, "skills", "registry.json"));
    expect(run(suiteRoot).status).not.toBe(0);
    expect(await readFile(externalRegistry, "utf8")).toBe(registryBytes);
    await expectUnchanged(suiteRoot);
  });

  it("AGS-D-0129 rejects an invalid final provider phase before creating files or saving registry", async () => {
    const suiteRoot = await fixture();
    const result = run(suiteRoot, "Invalid_Phase");
    expect(result.status, result.error?.message).not.toBe(0);
    expect(result.stderr).toContain("invalid skill descriptor");
    await expectUnchanged(suiteRoot);
    expect(await readdir(path.join(suiteRoot, "tests"))).toEqual([]);
  });
});
