import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const relativeScript = "skills/evaluation-validity-auditor/scripts/runtime-smoke.mjs";
const temporary = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function suiteCopy() {
  const directory = await mkdtemp(path.join(tmpdir(), "evaluation-smoke-regression-"));
  temporary.push(directory);
  const suite = path.join(directory, "suite");
  await mkdir(path.join(suite, "skills"), { recursive: true });
  await mkdir(path.join(suite, "tests"), { recursive: true });
  await cp(path.join(root, "skills/evaluation-validity-auditor"), path.join(suite, "skills/evaluation-validity-auditor"), { recursive: true });
  await cp(path.join(root, "runtime"), path.join(suite, "runtime"), { recursive: true });
  await cp(path.join(root, "tests/evaluation-validity-auditor"), path.join(suite, "tests/evaluation-validity-auditor"), { recursive: true });
  return { directory, suite };
}

function smoke(suite, cwd) {
  return spawnSync(process.execPath, [path.join(suite, relativeScript)], {
    cwd, encoding: "utf8", windowsHide: true, timeout: 30_000,
    env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", AGENT_GOVERNANCE_LOCALE: "ko" },
  });
}

it("runs the public smoke from the current suite layout without installed dependencies (D0019)", async () => {
  const { suite, directory } = await suiteCopy();
  const result = smoke(suite, directory);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toMatch(/# (?:pass|tests) [1-9][0-9]*/u);
  expect(result.stdout).toContain("node_modules-free runtime check passed");
}, 40_000);

it("does not borrow a missing runtime from the source checkout (D0019)", async () => {
  const { suite, directory } = await suiteCopy();
  await rm(path.join(suite, "runtime/schema-validation.mjs"));
  const result = smoke(suite, directory);
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("schema-validation.mjs");
  expect(result.stdout).not.toContain("node_modules-free runtime check passed");
}, 40_000);
