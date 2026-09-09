import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories = [];

async function createSuiteRoot() {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-governance-tooling-"));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, "skills"), { recursive: true });
  await mkdir(path.join(directory, "tests"), { recursive: true });
  await writeFile(path.join(directory, "skills", "registry.json"), '{"schemaVersion":"1.0.0","skills":[]}\n');
  await writeFile(path.join(directory, "skills", "source-lock.json"), '{"schemaVersion":"1.0.0","sources":[]}\n');
  return directory;
}

function runScript(script, arguments_, suiteRoot) {
  return spawnSync(process.execPath, [path.join(root, "scripts", script), ...arguments_], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, AGENT_GOVERNANCE_ROOT: suiteRoot }
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("skill maintenance commands", () => {
  it("forwards pnpm script arguments without a standalone separator", () => {
    const pnpmEntrypoint = process.env.npm_execpath;
    expect(pnpmEntrypoint).toBeTruthy();
    const result = spawnSync(process.execPath, [pnpmEntrypoint, "validate:skill", "--name", "orchestrator"], {
      cwd: root,
      encoding: "utf8"
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("orchestrator");
  });

  it("scaffolds a skill, behavior fixtures, and registry descriptor", async () => {
    const suiteRoot = await createSuiteRoot();
    const result = runScript("new-skill.mjs", [
      "--name", "evidence-normalizer",
      "--phase", "validation",
      "--capability", "evidence-normalization"
    ], suiteRoot);

    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(path.join(suiteRoot, "skills", "evidence-normalizer", "SKILL.md"), "utf8"))
      .toContain("name: evidence-normalizer");
    const cases = JSON.parse(await readFile(path.join(suiteRoot, "tests", "evidence-normalizer", "cases.json"), "utf8"));
    expect(Object.keys(cases)).toEqual(["normal", "boundary", "failure"]);
    const registry = JSON.parse(await readFile(path.join(suiteRoot, "skills", "registry.json"), "utf8"));
    expect(registry.skills[0]).toMatchObject({ id: "evidence-normalizer", phase: "validation" });
    const sourceLock = JSON.parse(await readFile(path.join(suiteRoot, "skills", "source-lock.json"), "utf8"));
    expect(sourceLock.sources).toEqual([]);
  });

  it("rejects a duplicate capability before creating files", async () => {
    const suiteRoot = await createSuiteRoot();
    await writeFile(path.join(suiteRoot, "skills", "registry.json"), JSON.stringify({
      schemaVersion: "1.0.0",
      skills: [{ id: "existing-provider", capabilities: ["shared-capability"] }]
    }));

    const result = runScript("new-skill.mjs", [
      "--name", "duplicate-provider",
      "--phase", "validation",
      "--capability", "shared-capability"
    ], suiteRoot);

    expect(result.status).not.toBe(0);
    await expect(readFile(path.join(suiteRoot, "skills", "duplicate-provider", "SKILL.md"), "utf8"))
      .rejects.toThrow();
    const registry = JSON.parse(await readFile(path.join(suiteRoot, "skills", "registry.json"), "utf8"));
    expect(registry.skills).toHaveLength(1);
  });

  it("imports only files committed at the requested Git ref", async () => {
    const suiteRoot = await createSuiteRoot();
    const source = await mkdtemp(path.join(tmpdir(), "agent-governance-source-"));
    temporaryDirectories.push(source);
    await mkdir(path.join(source, "references"));
    await writeFile(path.join(source, "SKILL.md"), "---\nname: ref-locked-skill\ndescription: Operates only on the immutable ref selected by the caller.\nmetadata:\n  version: 0.2.0\n---\n\n# Ref locked skill\n");
    await writeFile(path.join(source, "references", "rules.md"), "# Rules\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: source });
    execFileSync("git", ["-c", "core.autocrlf=false", "add", "."], { cwd: source });
    execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "test fixture"], { cwd: source });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
    await writeFile(path.join(source, "uncommitted.txt"), "must not be imported\n");

    const result = runScript("import-skill.mjs", [
      "--source", source,
      "--ref", commit,
      "--skill-path", ".",
      "--phase", "validation",
      "--capability", "ref-validation"
    ], suiteRoot);

    expect(result.status, result.stderr).toBe(0);
    await expect(readFile(path.join(suiteRoot, "skills", "ref-locked-skill", "uncommitted.txt"), "utf8"))
      .rejects.toThrow();
    const lock = JSON.parse(await readFile(path.join(suiteRoot, "skills", "source-lock.json"), "utf8"));
    expect(lock.sources[0]).toMatchObject({ skillId: "ref-locked-skill", commit });
    expect(lock.sources[0].checksum).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});
