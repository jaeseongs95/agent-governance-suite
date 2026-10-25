import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-cg04-"));
  directories.push(directory);
  const write = (relative, value) => {
    const file = path.join(directory, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, value, "utf8");
  };
  return { directory, write };
}

// Only the filesystem operation is faulted. The copied entry script retains its
// original bytes; no chmod/root/Windows ACL assumptions are needed.
function launch(f, relative, fault) {
  const args = [];
  if (fault) {
    f.write("fault.mjs", `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
const operation = ${JSON.stringify(fault.operation)};
const target = ${JSON.stringify(path.join(f.directory, fault.file))};
const original = fs[operation];
fs[operation] = async (file, ...args) => {
  if (path.resolve(String(file)) === target) {
    throw Object.assign(new Error("CG04 controlled filesystem failure"), {
      code: ${JSON.stringify(fault.code)}, path: target, syscall: operation
    });
  }
  return original(file, ...args);
};
syncBuiltinESMExports();
`);
    args.push("--import", pathToFileURL(path.join(f.directory, "fault.mjs")).href);
  }
  return spawnSync(process.execPath, [...args, path.join(f.directory, relative)], {
    cwd: f.directory, encoding: "utf8", timeout: 10_000, windowsHide: true
  });
}

function repositoryFixture(skill) {
  const f = fixture();
  const source = readFileSync(path.join(root, "skills", skill, "scripts/check-repository.mjs"), "utf8");
  const required = source.match(/const required = \[([\s\S]*?)\];/u);
  expect(required).not.toBeNull();
  for (const [, relative] of required[1].matchAll(/"([^"]+)"/gu)) f.write(relative, "{}\n");
  f.write("SKILL.md", `---\nname: ${skill}\nversion: 1.0.0\n---\n`);
  f.write("README.md", "Filesystem validation fixture.\n");
  f.write("package.json", JSON.stringify({ name: skill, version: "1.0.0" }));
  f.write("integration/skill-descriptor.json", JSON.stringify({ providers: [{
    skillId: skill, version: "1.0.0", capabilities: ["evaluation-validity-audit"],
    phase: "evaluation-validity", phaseOrder: 68, receiptPolicy: { mode: "reference-only" }
  }] }));
  const snapshot = "{}\n";
  f.write("contracts/upstream/task-envelope.v1.schema.json", snapshot);
  f.write("contracts/upstream/lock.json", JSON.stringify({ files: [{
    sha256: `sha256:${createHash("sha256").update(snapshot).digest("hex")}`
  }] }));
  f.write("runtime/schema-validation.mjs", "export {};\n");
  f.write("runtime/lock.json", JSON.stringify({
    bundleDigest: `sha256:${createHash("sha256").update("export {};\n").digest("hex")}`
  }));
  for (const name of ["core.mjs", "cli.mjs", "cluster-failures.mjs", "digest-request.mjs", "validate-report.mjs"]) {
    f.write(`scripts/${name}`, "export {};\n");
  }
  // Schema compilation is unrelated to these I/O regressions and is isolated.
  f.write("scripts/schema-validation.mjs", "export function compileAllSchemas() {}\n");
  f.write("scripts/check-repository.mjs", source);
  return f;
}

for (const skill of ["acceptance-evidence-validator", "blocker-diagnostician", "evaluation-validity-auditor"]) {
  const evaluation = skill === "evaluation-validity-auditor";
  const file = evaluation ? "agents/openai.yaml" : "README.md";
  const operation = evaluation ? "readFile" : "access";
  it(`AGS-D-0120: ${skill} accepts a readable repository fixture`, () => {
    const result = launch(repositoryFixture(skill), "scripts/check-repository.mjs");
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
  it.each(["EACCES", "EPERM", "EIO"])(`AGS-D-0120: ${skill} preserves %s instead of reporting missing`, code => {
    const result = launch(repositoryFixture(skill), "scripts/check-repository.mjs", { file, operation, code });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(evaluation ? `cannot read required file: ${file}` : `cannot access ${file}`);
    expect(result.stderr).toContain(code);
    expect(result.stderr).not.toContain(evaluation ? `missing required file: ${file}` : `missing ${file}`);
  });
  it(`AGS-D-0120: ${skill} still identifies ENOENT as missing`, () => {
    const result = launch(repositoryFixture(skill), "scripts/check-repository.mjs", { file, operation, code: "ENOENT" });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(evaluation ? `missing required file: ${file}` : `missing ${file}`);
  });
}

it.each(["EACCES", "EPERM", "EIO", "ENOENT"])("AGS-D-0121: recursive coupling scan fails on an unreadable file (%s)", code => {
  const result = launch(repositoryFixture("evaluation-validity-auditor"), "scripts/check-repository.mjs", {
    file: "README.md", operation: "readFile", code
  });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`cannot read README.md: ${code}`);
});

function pythonFixture() {
  const f = fixture();
  f.write("scripts/lib.mjs", `export const ROOT = ${JSON.stringify(f.directory)};\n`);
  f.write("scripts/python-runner.mjs", 'export function findPython() { return {}; }\nexport function runPython() { console.log("validator-ran"); }\n');
  f.write("tests/example/validate_skill.py", "# fixture; Python is never invoked\n");
  copyFileSync(path.join(root, "scripts/run-python-validations.mjs"), path.join(f.directory, "scripts/run-python-validations.mjs"));
  return f;
}

it("AGS-D-0121: a readable validator reaches the runner", () => {
  const result = launch(pythonFixture(), "scripts/run-python-validations.mjs");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("validator-ran");
});

it.each(["ENOENT", "EACCES", "EPERM", "EIO"])("AGS-D-0121: optional validator access distinguishes %s", code => {
  const result = launch(pythonFixture(), "scripts/run-python-validations.mjs", {
    file: "tests/example/validate_skill.py", operation: "access", code
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(code === "ENOENT" ? 0 : 1);
  expect(result.stdout).not.toContain("validator-ran");
  if (code !== "ENOENT") {
    expect(result.stderr).toContain(code);
    expect(result.stderr).toContain("validate_skill.py");
  }
});

// The tracked-file loop belongs to an existing test closure, with no callable
// public export. Exercise its unchanged loop text with the read boundary faulted;
// Git discovery and the unrelated generated-plugin assertions are excluded.
function trackedScan() {
  const source = readFileSync(path.join(root, "tests/tooling/claude-plugin.test.mjs"), "utf8");
  const start = source.indexOf("    for (const file of files) {");
  const end = source.indexOf("\n  });", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction("files", "readFile", "path", "root", "sentences", "expect", source.slice(start, end));
}

it.each(["ENOENT", "EACCES", "EPERM", "EIO"])("AGS-D-0159: tracked-file read rejection is preserved (%s)", async code => {
  const fault = Object.assign(new Error("controlled tracked-file read failure"), { code, path: "tracked.md" });
  await expect(trackedScan()(["tracked.md"], async () => { throw fault; }, path, root, ["duplicated intake"], expect)).rejects.toBe(fault);
});

it("AGS-D-0159: readable tracked files still reject duplicate intake", async () => {
  const scan = trackedScan();
  await expect(scan(["tracked.md"], async () => "ordinary text", path, root, ["duplicated intake"], expect)).resolves.toBeUndefined();
  await expect(scan(["tracked.md"], async () => "duplicated intake", path, root, ["duplicated intake"], expect)).rejects.toThrow();
});
