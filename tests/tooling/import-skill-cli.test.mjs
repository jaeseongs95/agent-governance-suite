import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const directories = [];

afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function listTransactions(root) {
  return (await readdir(root)).filter(entry => entry.startsWith(".agent-governance-import-"));
}

function cliEnvironment(suiteRoot) {
  const temporary = path.join(suiteRoot, "temporary");
  return { ...process.env, NODE_OPTIONS: "", AGENT_GOVERNANCE_ROOT: suiteRoot, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
}

async function setupFixture() {
  const suiteRoot = await mkdtemp(path.join(tmpdir(), "ags-cli-suite-"));
  const sourceRepo = await mkdtemp(path.join(tmpdir(), "ags-cli-source-"));
  directories.push(suiteRoot, sourceRepo);

  // 실제 CLI가 합성 설치 트리와 그 안의 임시 경로만 사용한다.
  await mkdir(path.join(suiteRoot, "temporary"));
  await mkdir(path.join(suiteRoot, "skills"), { recursive: true });
  await mkdir(path.join(suiteRoot, "tests"), { recursive: true });
  const registryInitial = {
    schemaVersion: "2.0.0",
    skills: [],
  };
  const lockInitial = {
    schemaVersion: "3.0.0",
    sources: [],
  };
  await writeFile(
    path.join(suiteRoot, "skills", "registry.json"),
    JSON.stringify(registryInitial, null, 2) + "\n",
    "utf8"
  );
  await writeFile(
    path.join(suiteRoot, "skills", "source-lock.json"),
    JSON.stringify(lockInitial, null, 2) + "\n",
    "utf8"
  );

  // Setup source git repo with sample-skill
  await execFileAsync("git", ["init"], { cwd: sourceRepo });
  await execFileAsync("git", ["config", "user.email", "tester@test.local"], { cwd: sourceRepo });
  await execFileAsync("git", ["config", "user.name", "Tester"], { cwd: sourceRepo });

  const skillDir = path.join(sourceRepo, "sample-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: sample-skill\ndescription: Test skill\n---\n# Sample Skill\n",
    "utf8"
  );
  await writeFile(path.join(skillDir, "VERSION"), "1.0.0\n", "utf8");
  await writeFile(path.join(skillDir, "README.md"), "v1-content", "utf8");

  await execFileAsync("git", ["add", "."], { cwd: sourceRepo });
  await execFileAsync("git", ["commit", "-m", "initial skill commit"], { cwd: sourceRepo });
  await execFileAsync("git", ["tag", "v1.0.0"], { cwd: sourceRepo });

  const commitSha = (
    await execFileAsync("git", ["-C", sourceRepo, "rev-parse", "v1.0.0^{commit}"])
  ).stdout.trim();

  return { suiteRoot, sourceRepo, commitSha };
}

function getCliScript() {
  return path.resolve(import.meta.dirname, "../../scripts/import-skill.mjs");
}

async function faultPreload(suiteRoot, incomplete) {
  const preload = path.join(suiteRoot, "fault-preload.mjs");
  const report = path.join(suiteRoot, "failure.json");
  // 실패한 파일 연산만 대체한다. 실제 CLI의 catch/finally와 기본 예외 종료는 그대로 실행한다.
  await writeFile(preload, `
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
const root = ${JSON.stringify(suiteRoot)}, incomplete = ${JSON.stringify(incomplete)};
const lock = path.join(root, "skills/source-lock.json"), registry = path.join(root, "skills/registry.json");
const destination = path.join(root, "skills/sample-skill"), temporary = path.join(root, "temporary");
const original = { writeFile: fs.writeFile, rename: fs.rename, rm: fs.rm };
const stages = [];
const fault = message => Object.assign(new Error(message), { code: "EIO" });
fs.writeFile = async function(file, data, ...options) {
  if (file === lock && typeof data === "string") { stages.push("install-lock"); throw fault("synthetic-install-lock"); }
  if (file === lock && Buffer.isBuffer(data)) stages.push("restore-lock");
  if (file === registry && Buffer.isBuffer(data)) stages.push("restore-registry");
  return original.writeFile.call(this, file, data, ...options);
};
fs.rename = async function(from, to) {
  if (path.basename(from) === "previous-skill" && to === destination) {
    stages.push("restore-previous-skill");
    if (incomplete) throw fault("synthetic-restore-previous-skill");
  }
  return original.rename.call(this, from, to);
};
fs.rm = async function(file, ...options) {
  if (path.dirname(file) === temporary && path.basename(file).startsWith("agent-governance-import-")) {
    stages.push("cleanup-temporary");
    if (incomplete) throw fault("synthetic-cleanup-temporary");
  }
  if (path.dirname(file) === root && path.basename(file).startsWith(".agent-governance-import-")) stages.push("cleanup-transaction");
  return original.rm.call(this, file, ...options);
};
const encode = error => error && ({ name: error.name, message: error.message, code: error.code, recovery: error.recovery,
  cause: encode(error.cause), errors: error.errors?.map(encode) });
process.on("uncaughtExceptionMonitor", error => {
  writeFileSync(${JSON.stringify(report)}, JSON.stringify({ stages, error: encode(error) }));
});
syncBuiltinESMExports();
`, "utf8");
  return { preload, report };
}

async function importCli(suiteRoot, sourceRepo, ref, replace = false, preload) {
  return execFileAsync(process.execPath, [
    ...(preload ? ["--import", pathToFileURL(preload).href] : []), getCliScript(),
    "--source", sourceRepo, "--ref", ref, "--skill-path", "sample-skill",
    "--phase", "test", "--capability", "cap-test", ...(replace ? ["--replace", "true"] : []),
  ], { env: cliEnvironment(suiteRoot), timeout: 15_000, windowsHide: true });
}

describe("CLI entrypoint end-to-end import & recovery validation", () => {
  it("CLI: pre-commit failure (invalid ref) cleans temporary and transaction directories without residue", async () => {
    const { suiteRoot, sourceRepo } = await setupFixture();

    let threw = false;
    let procError;
    try {
      await importCli(suiteRoot, sourceRepo, "non-existent-tag");
    } catch (err) {
      threw = true;
      procError = err;
    }

    expect(threw).toBe(true);
    expect(procError.code).toBe(1);
    expect(procError.signal).toBeNull();
    expect(procError.killed).toBe(false);

    // Verify ROOT/.agent-governance-import-* directories were completely cleaned up by finally block
    const txs = await listTransactions(suiteRoot);
    expect(txs).toEqual([]);
    expect(await readdir(path.join(suiteRoot, "temporary"))).toEqual([]);
    expect(await exists(path.join(suiteRoot, "skills", "sample-skill"))).toBe(false);
  });

  it("CLI: successful initial import creates skill, cases.json when testsExist=false, and cleans transaction", async () => {
    const { suiteRoot, sourceRepo, commitSha } = await setupFixture();

    const { stdout } = await importCli(suiteRoot, sourceRepo, "v1.0.0");

    expect(stdout).toContain(`imported sample-skill@${commitSha}`);

    // Verify skill files installed
    expect(await exists(path.join(suiteRoot, "skills", "sample-skill", "SKILL.md"))).toBe(true);
    expect(
      await readFile(path.join(suiteRoot, "skills", "sample-skill", "README.md"), "utf8")
    ).toBe("v1-content");

    // Verify testsExist=false branch created default cases.json
    expect(await exists(path.join(suiteRoot, "tests", "sample-skill", "cases.json"))).toBe(true);

    // Verify registry and source-lock updated
    const reg = JSON.parse(await readFile(path.join(suiteRoot, "skills", "registry.json"), "utf8"));
    expect(reg.skills.some((s) => s.skillId === "sample-skill")).toBe(true);
    const lock = JSON.parse(await readFile(path.join(suiteRoot, "skills", "source-lock.json"), "utf8"));
    expect(lock.sources.some((s) => s.skillId === "sample-skill")).toBe(true);

    // Verify transaction directory cleaned up
    const txs = await listTransactions(suiteRoot);
    expect(txs).toEqual([]);
    expect(await readdir(path.join(suiteRoot, "temporary"))).toEqual([]);
  });

  it("CLI: successful update preserves existing tests untouched when testsExist=true", async () => {
    const { suiteRoot, sourceRepo } = await setupFixture();

    // First install
    await importCli(suiteRoot, sourceRepo, "v1.0.0");

    // Add a custom test file in tests/sample-skill
    const customTestPath = path.join(suiteRoot, "tests", "sample-skill", "my-custom.test.mjs");
    await writeFile(customTestPath, "// existing user test", "utf8");

    // Commit v1.0.1 in sourceRepo
    const skillDir = path.join(sourceRepo, "sample-skill");
    await writeFile(path.join(skillDir, "VERSION"), "1.0.1\n", "utf8");
    await writeFile(path.join(skillDir, "README.md"), "v101-content", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: sourceRepo });
    await execFileAsync("git", ["commit", "-m", "update skill to 1.0.1"], { cwd: sourceRepo });
    await execFileAsync("git", ["tag", "v1.0.1"], { cwd: sourceRepo });

    // Update skill with --replace true
    const { stdout } = await importCli(suiteRoot, sourceRepo, "v1.0.1", true);

    expect(stdout).toContain("imported sample-skill@");
    expect(
      await readFile(path.join(suiteRoot, "skills", "sample-skill", "README.md"), "utf8")
    ).toBe("v101-content");

    // Verify existing user test is preserved untouched (testsExist=true branch)
    expect(await exists(customTestPath)).toBe(true);
    expect(await readFile(customTestPath, "utf8")).toBe("// existing user test");

    // Verify transaction directory cleaned up
    const txs = await listTransactions(suiteRoot);
    expect(txs).toEqual([]);
    expect(await readdir(path.join(suiteRoot, "temporary"))).toEqual([]);
  });

  it.each([false, true])("CLI: real catch and cleanup preserve recovery evidence (incomplete=%s)", async incomplete => {
    const { suiteRoot, sourceRepo } = await setupFixture();
    await importCli(suiteRoot, sourceRepo, "v1.0.0");
    const lockPath = path.join(suiteRoot, "skills/source-lock.json"), registryPath = path.join(suiteRoot, "skills/registry.json");
    const oldLock = await readFile(lockPath), oldRegistry = await readFile(registryPath);
    const existingTest = path.join(suiteRoot, "tests/sample-skill/owned.test.mjs");
    await writeFile(existingTest, "// 기존 사용자 시험\n", "utf8");
    await writeFile(path.join(sourceRepo, "sample-skill/VERSION"), "1.0.1\n", "utf8");
    await writeFile(path.join(sourceRepo, "sample-skill/README.md"), "new-content", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: sourceRepo });
    await execFileAsync("git", ["commit", "-m", "update synthetic skill"], { cwd: sourceRepo });
    await execFileAsync("git", ["tag", "v1.0.1"], { cwd: sourceRepo });
    const { preload, report } = await faultPreload(suiteRoot, incomplete);
    let failure;
    try { await importCli(suiteRoot, sourceRepo, "v1.0.1", true, preload); }
    catch (error) { failure = error; }
    expect(failure).toBeDefined();
    expect(failure.code).toBe(1);
    expect(failure.signal).toBeNull();
    expect(failure.killed).toBe(false);
    const observed = JSON.parse(await readFile(report, "utf8"));
    expect(observed.stages).toEqual(["install-lock", "restore-lock", "restore-registry", "restore-previous-skill", "cleanup-temporary",
      ...(!incomplete ? ["cleanup-transaction"] : [])]);
    expect(await readFile(lockPath)).toEqual(oldLock);
    expect(await readFile(registryPath)).toEqual(oldRegistry);
    expect(await readFile(existingTest, "utf8")).toBe("// 기존 사용자 시험\n");
    const error = observed.error;
    const rollback = incomplete ? error.cause : error;
    expect(rollback.name).toBe("AggregateError");
    expect(rollback.cause).toMatchObject({ code: "EIO", message: "synthetic-install-lock" });
    expect(rollback.errors[0]).toEqual(rollback.cause);
    if (incomplete) {
      expect(error.message).toBe("Skill import cleanup incomplete");
      expect(error.errors[0]).toEqual(rollback);
      expect(error.errors[1]).toMatchObject({ message: "Skill import temporary cleanup failed", cause: { code: "EIO", message: "synthetic-cleanup-temporary" } });
      expect(rollback.errors[1]).toMatchObject({ message: "Skill import recovery failed: restore-previous-skill", cause: { code: "EIO", message: "synthetic-restore-previous-skill" } });
      expect(error.recovery).toEqual(rollback.recovery);
      expect(error.recovery).toMatchObject({ state: "incomplete", preserveTransaction: true, failedStages: ["restore-previous-skill"], previousSkill: { state: "retained" } });
      const transactions = await listTransactions(suiteRoot);
      expect(transactions).toHaveLength(1);
      const backup = path.join(suiteRoot, transactions[0]);
      expect(error.recovery.transactionDirectory).toBe(backup);
      expect(await readFile(path.join(backup, "previous-skill/README.md"), "utf8")).toBe("v1-content");
      expect(await readFile(path.join(backup, "registry.original"))).toEqual(oldRegistry);
      expect(await readFile(path.join(backup, "source-lock.original"))).toEqual(oldLock);
      expect(await exists(path.join(suiteRoot, "skills/sample-skill"))).toBe(false);
      expect(await readdir(path.join(suiteRoot, "temporary"))).toHaveLength(1);
      expect(failure.stderr).toContain("Skill import cleanup incomplete");
      expect(failure.stderr).toContain("synthetic-install-lock");
      expect(failure.stderr).toContain("synthetic-restore-previous-skill");
      expect(failure.stderr).toContain("synthetic-cleanup-temporary");
    } else {
      expect(rollback.message).toBe("Skill import failed; rollback completed");
      expect(rollback.errors).toHaveLength(1);
      expect(rollback.recovery).toMatchObject({ state: "completed", preserveTransaction: false, transactionState: "removed",
        transactionDirectory: null, previousSkill: { state: "restored", path: null }, metadataOriginals: null, failedStages: [] });
      expect(await readFile(path.join(suiteRoot, "skills/sample-skill/README.md"), "utf8")).toBe("v1-content");
      expect(await listTransactions(suiteRoot)).toEqual([]);
      expect(await readdir(path.join(suiteRoot, "temporary"))).toEqual([]);
      expect(failure.stderr).toContain("Skill import failed; rollback completed");
    }
  });
});
