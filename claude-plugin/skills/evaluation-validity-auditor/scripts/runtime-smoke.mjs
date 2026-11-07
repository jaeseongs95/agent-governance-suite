import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceSuite = path.resolve(root, "../..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "evaluation-validity-runtime-"));
const suiteRoot = path.join(temporary, "suite");
const installedSkill = path.join(suiteRoot, "skills", "evaluation-validity-auditor");
const environment = { ...process.env };
delete environment.NODE_PATH;
delete environment.NODE_OPTIONS;
delete environment.AGENT_GOVERNANCE_ROOT;

try {
  await mkdir(path.dirname(installedSkill), { recursive: true });
  await cp(root, installedSkill, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      const first = relative.split(path.sep)[0];
      return first !== ".git" && first !== "node_modules";
    },
  });
  await cp(path.join(sourceSuite, "runtime"), path.join(suiteRoot, "runtime"), { recursive: true });
  // Installed packages ship skills/ and runtime/ but not tests/: there the node:test suite is a source-checkout check.
  const sourceTests = path.join(sourceSuite, "tests", "evaluation-validity-auditor");
  const suiteTests = await access(path.join(sourceTests, "evaluation-validity.node.mjs")).then(
    () => true,
    error => { if (error.code === "ENOENT") return false; throw error; },
  );
  if (suiteTests) {
    const tests = path.join(suiteRoot, "tests", "evaluation-validity-auditor");
    await mkdir(tests, { recursive: true });
    for (const file of ["evaluation-validity.node.mjs", "fixture.mjs"]) {
      await cp(path.join(sourceTests, file), path.join(tests, file));
    }
  }
  // A clean suite retains the actual package-relative imports but has no dependency installation.
  for (const directory of [suiteRoot, installedSkill]) {
    await access(path.join(directory, "node_modules")).then(
      () => { throw new Error(`Clean-room dependency leak: ${directory}`); },
      error => { if (error.code !== "ENOENT") throw error; },
    );
  }
  if (suiteTests) {
    const result = await execute(process.execPath, ["--test", "--test-reporter=tap", "tests/evaluation-validity-auditor/evaluation-validity.node.mjs"], {
      cwd: suiteRoot,
      encoding: "utf8",
      env: environment,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    process.stdout.write(result.stdout);
  } else {
    process.stdout.write(`node:test suite NOT_RUN: ${path.relative(sourceSuite, sourceTests)} is not part of an installed package (source checkout only)\n`);
  }
  await execute(process.execPath, ["--input-type=module", "--eval", "await import('./scripts/core.mjs');"], {
    cwd: installedSkill,
    encoding: "utf8",
    env: environment,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  process.stdout.write(suiteTests
    ? "node_modules-free runtime check passed\n"
    : "node_modules-free import check passed (installed package layout)\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
