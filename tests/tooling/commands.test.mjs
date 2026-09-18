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
  await writeFile(path.join(directory, "skills", "registry.json"), '{"schemaVersion":"2.0.0","skills":[]}\n');
  await writeFile(path.join(directory, "skills", "source-lock.json"), '{"schemaVersion":"2.0.0","sources":[]}\n');
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
    const pnpmArguments = [
"validate:skill", "--name", "orchestrator"
    ];
    const javascriptEntrypoint = /\.(?:cjs|mjs|js)$/iu.test(pnpmEntrypoint);
    const result = spawnSync(
      javascriptEntrypoint ? process.execPath : pnpmEntrypoint,
      javascriptEntrypoint ? [pnpmEntrypoint, ...pnpmArguments] : pnpmArguments,
      {
      cwd: root,
      encoding: "utf8"
    },
    );

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
    expect(registry.skills[0]).toMatchObject({
      skillId: "evidence-normalizer",
      providers: [{ phase: "validation", capabilities: ["evidence-normalization"] }]
    });
    const sourceLock = JSON.parse(await readFile(path.join(suiteRoot, "skills", "source-lock.json"), "utf8"));
    expect(sourceLock.sources).toEqual([]);
  });

  it("rejects a duplicate capability before creating files", async () => {
    const suiteRoot = await createSuiteRoot();
    await writeFile(path.join(suiteRoot, "skills", "registry.json"), JSON.stringify({
      schemaVersion: "2.0.0",
      skills: [{
        schemaVersion: "2.0.0",
        skillId: "existing-provider",
        version: "0.1.0",
        path: "./existing-provider",
        enabled: true,
        priority: 50,
        providers: [{ capabilities: ["shared-capability"] }]
      }]
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
    expect(lock.sources[0]).toMatchObject({
      skillId: "ref-locked-skill",
      version: "0.2.0",
      versionSource: "skill-metadata",
      ref: { kind: "commit", value: commit, commit },
      updatePolicy: "notify-only",
      downstreamModifications: [],
    });
    expect(lock.sources[0].integratedChecksum).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("refuses a replacement that does not contain the required ancestor commit", async () => {
    const suiteRoot = await createSuiteRoot();
    const { source, commits } = await createVersionedSource(["0.2.0", "0.2.1", "0.2.2"]);
    const importAt = (ref, extra = []) => runScript("import-skill.mjs", [
      "--source", source, "--ref", ref, "--skill-path", ".",
      "--phase", "validation", "--capability", "ref-validation", ...extra,
    ], suiteRoot);
    expect(importAt(commits[1]).status).toBe(0);

    const older = importAt(commits[0], ["--replace", "true", "--descendant-of", commits[1]]);
    expect(older.status).not.toBe(0);
    expect(older.stderr).toContain("refusing to replace");
    const lock = JSON.parse(await readFile(path.join(suiteRoot, "skills", "source-lock.json"), "utf8"));
    expect(lock.sources[0].ref.commit).toBe(commits[1]);
    expect(await readFile(path.join(suiteRoot, "skills", "versioned-skill", "SKILL.md"), "utf8")).toContain("version: 0.2.1");

    expect(importAt(commits[2], ["--replace", "true", "--descendant-of", "not-a-sha"]).status).not.toBe(0);
    const newer = importAt(commits[2], ["--replace", "true", "--descendant-of", commits[1]]);
    expect(newer.status, newer.stderr).toBe(0);
    expect(await readFile(path.join(suiteRoot, "skills", "versioned-skill", "SKILL.md"), "utf8")).toContain("version: 0.2.2");
  });

  it("keeps the registered routing when a replaced skill ships no integration descriptor", async () => {
    const suiteRoot = await createSuiteRoot();
    const { source, commits } = await createVersionedSource(["0.2.0", "0.2.1"]);
    const base = ["--source", source, "--skill-path", "."];
    // A new skill without a descriptor still needs an explicit phase and capability.
    expect(runScript("import-skill.mjs", [...base, "--ref", "v0.2.0"], suiteRoot).status).not.toBe(0);
    expect(runScript("import-skill.mjs", [...base, "--ref", "v0.2.0", "--phase", "validation", "--capability", "ref-validation"], suiteRoot).status).toBe(0);

    const registryPath = path.join(suiteRoot, "skills", "registry.json");
    const lockPath = path.join(suiteRoot, "skills", "source-lock.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    registry.skills[0].priority = 70;
    registry.skills[0].providers[0].capabilities.push("ref-auditing");
    registry.skills[0].providers[0].phaseOrder = 20;
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.sources[0].updatePolicy = "auto-pr";
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    // An auto-pr skill is only replaced from a stable tag; a commit ref is refused before anything is written.
    const fromCommit = runScript("import-skill.mjs", [...base, "--ref", commits[1], "--replace", "true", "--descendant-of", commits[0]], suiteRoot);
    expect(fromCommit.status).not.toBe(0);
    expect(fromCommit.stderr).toContain("must be imported from a stable vX.Y.Z tag");
    expect(JSON.parse(await readFile(lockPath, "utf8")).sources[0].ref).toEqual({ kind: "tag", value: "v0.2.0", commit: commits[0] });

    const result = runScript("import-skill.mjs", [...base, "--ref", "v0.2.1", "--replace", "true", "--descendant-of", commits[0]], suiteRoot);
    expect(result.status, result.stderr).toBe(0);
    const updated = JSON.parse(await readFile(registryPath, "utf8")).skills;
    expect(updated).toHaveLength(1);
    expect(updated[0]).toEqual({ ...registry.skills[0], version: "0.2.1" });
    expect(JSON.parse(await readFile(lockPath, "utf8")).sources[0]).toMatchObject({
      version: "0.2.1",
      ref: { kind: "tag", value: "v0.2.1", commit: commits[1] },
      updatePolicy: "auto-pr",
    });
  });

  it("rejects a lock whose auto-pr source is pinned to a commit", async () => {
    const suiteRoot = await createSuiteRoot();
    const { source, commits } = await createVersionedSource(["0.2.0"]);
    expect(runScript("import-skill.mjs", [
      "--source", source, "--ref", commits[0], "--skill-path", ".", "--phase", "validation", "--capability", "ref-validation",
    ], suiteRoot).status).toBe(0);
    const pinMessage = "auto-pr source must be pinned to a stable tag for versioned-skill";
    const notifyOnly = runScript("check-source-lock.mjs", [], suiteRoot);
    expect(`${notifyOnly.stdout}${notifyOnly.stderr}`).not.toContain(pinMessage);

    const lockPath = path.join(suiteRoot, "skills", "source-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    lock.sources[0].updatePolicy = "auto-pr";
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}
`);
    const autoPr = runScript("check-source-lock.mjs", [], suiteRoot);
    expect(autoPr.status).not.toBe(0);
    expect(`${autoPr.stdout}${autoPr.stderr}`).toContain(pinMessage);
  });
});

async function createVersionedSource(versions) {
  const source = await mkdtemp(path.join(tmpdir(), "agent-governance-source-"));
  temporaryDirectories.push(source);
  execFileSync("git", ["init", "-b", "main"], { cwd: source });
  const commits = [];
  for (const version of versions) {
    await writeFile(path.join(source, "SKILL.md"), `---\nname: versioned-skill\ndescription: Carries a version that changes between commits.\nmetadata:\n  version: ${version}\n---\n\n# Versioned skill\n`);
    execFileSync("git", ["-c", "core.autocrlf=false", "add", "."], { cwd: source });
    execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", `version ${version}`], { cwd: source });
    commits.push(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim());
    execFileSync("git", ["-c", "tag.gpgSign=false", "tag", `v${version}`], { cwd: source });
  }
  return { source, commits };
}
