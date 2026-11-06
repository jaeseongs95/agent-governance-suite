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
  const tests = path.join(suiteRoot, "tests", "evaluation-validity-auditor");
  await mkdir(tests, { recursive: true });
  for (const file of ["evaluation-validity.node.mjs", "fixture.mjs"]) {
    await cp(path.join(sourceSuite, "tests", "evaluation-validity-auditor", file), path.join(tests, file));
  }
  // A clean suite retains the actual package-relative imports but has no dependency installation.
  for (const directory of [suiteRoot, installedSkill]) {
    await access(path.join(directory, "node_modules")).then(
      () => { throw new Error(`Clean-room dependency leak: ${directory}`); },
      error => { if (error.code !== "ENOENT") throw error; },
    );
  }
  const result = await execute(process.execPath, ["--test", "--test-reporter=tap", "tests/evaluation-validity-auditor/evaluation-validity.node.mjs"], {
    cwd: suiteRoot,
    encoding: "utf8",
    env: environment,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  await execute(process.execPath, ["--input-type=module", "--eval", "await import('./scripts/core.mjs');"], {
    cwd: installedSkill,
    encoding: "utf8",
    env: environment,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  process.stdout.write("node_modules-free runtime check passed\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
