import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

// SOURCE only: execute later against the integrated candidate using regular Vitest discovery.
const root = path.resolve(import.meta.dirname, "../..");
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-d0114-"));
  directories.push(directory);
  const write = (relative, bytes) => {
    const file = path.join(directory, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes, "utf8");
  };
  const copy = relative => {
    mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
    copyFileSync(path.join(root, relative), path.join(directory, relative));
  };
  return { directory, write, copy };
}

function launch(f, entry, fault) {
  const args = [];
  if (fault) {
    // Fault only the selected native I/O boundary. No product source substitution.
    f.write("fault.mjs", `import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const operation = ${JSON.stringify(fault.operation)};
const target = ${JSON.stringify(path.join(f.directory, fault.file))};
const original = fs[operation];
const cause = new Error("D0114 original I/O cause");
const failure = Object.assign(new Error(${JSON.stringify(`${fault.code}: D0114 controlled I/O failure`)}, { cause }), {
  code: ${JSON.stringify(fault.code)}, path: target, syscall: operation
});
fs[operation] = async (file, ...rest) => {
  if (path.resolve(String(file)) === target) throw failure;
  return original(file, ...rest);
};
syncBuiltinESMExports();
`);
    args.push("--import", pathToFileURL(path.join(f.directory, "fault.mjs")).href);
  }
  return spawnSync(process.execPath, [...args, path.join(f.directory, entry)], {
    cwd: f.directory, encoding: "utf8", timeout: 10_000, windowsHide: true,
    env: { ...process.env, AGENT_GOVERNANCE_ROOT: f.directory },
  });
}

it.each(["EACCES", "EPERM", "EIO", "ENOTDIR"])("D0114 VERSION reader preserves original error identity/code/cause (%s)", async code => {
  const cause = new Error("original cause");
  const failure = Object.assign(new Error("original read error", { cause }), { code });
  const actual = await vi.importActual("node:fs/promises");
  vi.doMock("node:fs/promises", () => ({ ...actual, readFile: async file => {
    if (path.basename(String(file)) === "SKILL.md") return "---\nname: versioned-skill\n---\n";
    throw failure;
  } }));
  vi.resetModules();
  const { readSkillVersion } = await import("../../scripts/source-lock.mjs");
  await expect(readSkillVersion("versioned-skill")).rejects.toBe(failure);
  await expect(readSkillVersion("versioned-skill")).rejects.toMatchObject({ code, cause });
});

it("D0114 VERSION ENOENT retains the missing-version diagnosis and original cause", async () => {
  const failure = Object.assign(new Error("missing VERSION"), { code: "ENOENT" });
  const actual = await vi.importActual("node:fs/promises");
  vi.doMock("node:fs/promises", () => ({ ...actual, readFile: async file => {
    if (path.basename(String(file)) === "SKILL.md") return "---\nname: versioned-skill\n---\n";
    throw failure;
  } }));
  vi.resetModules();
  const { readSkillVersion } = await import("../../scripts/source-lock.mjs");
  await expect(readSkillVersion("versioned-skill")).rejects.toMatchObject({
    message: expect.stringContaining("has neither metadata.version nor VERSION"), cause: failure,
  });
});

function sourceLockFixture() {
  const f = fixture();
  for (const file of ["scripts/source-lock.mjs", "scripts/lib.mjs", "scripts/check-source-lock.mjs"]) f.copy(file);
  const skill = "---\nname: versioned-skill\n---\n";
  const version = "1.0.0\n";
  f.write("skills/versioned-skill/SKILL.md", skill);
  f.write("skills/versioned-skill/VERSION", version);
  // Known two-file checksum, with byte-length-framed paths and normalized bytes.
  const digest = createHash("sha256").update(`8:SKILL.md${Buffer.byteLength(skill)}:`).update(skill)
    .update("7:VERSION6:").update(version).digest("hex");
  f.write("skills/registry.json", JSON.stringify({ skills: [{ skillId: "versioned-skill", version: "1.0.0" }] }));
  f.write("skills/source-lock.json", JSON.stringify({ schemaVersion: "3.0.0", sources: [{
    skillId: "versioned-skill", path: "skills/versioned-skill", version: "1.0.0", versionSource: "version-file",
    updatePolicy: "internal", integratedChecksum: `sha256:${digest}`,
  }] }));
  return f;
}

it("D0114 source:check CLI still accepts readable VERSION and absent optional direct descriptor", () => {
  const result = launch(sourceLockFixture(), "scripts/check-source-lock.mjs");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("source lock is consistent");
});

it.each(["EACCES", "EPERM", "EIO", "ENOTDIR"])("D0114 source:check CLI exposes VERSION read failure instead of missing metadata (%s)", code => {
  const result = launch(sourceLockFixture(), "scripts/check-source-lock.mjs", {
    operation: "readFile", file: "skills/versioned-skill/VERSION", code,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`cannot verify source versioned-skill: ${code}: D0114 controlled I/O failure`);
  expect(result.stderr).not.toContain("has neither metadata.version nor VERSION");
});

it("D0114 source:check CLI keeps genuine VERSION ENOENT as missing metadata", () => {
  const result = launch(sourceLockFixture(), "scripts/check-source-lock.mjs", {
    operation: "readFile", file: "skills/versioned-skill/VERSION", code: "ENOENT",
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("has neither metadata.version nor VERSION");
  expect(result.stderr).not.toContain("VERSION is unreadable");
});

const profilerEntry = "skills/workspace-convention-profiler/scripts/validate-skill.mjs";
const profilerPrefix = "skills/workspace-convention-profiler/";
function profilerFixture() {
  const f = fixture();
  f.copy(profilerEntry);
  const write = (relative, bytes) => f.write(profilerPrefix + relative, bytes);
  write("SKILL.md", "---\nname: workspace-convention-profiler\nmetadata:\n  version: 1.0.0\n---\n[local](README.md)\n");
  write("README.md", "fixture\n");
  write("agents/openai.yaml", "fixture: true\n");
  write("package.json", '{"version":"1.0.0"}\n');
  write("integration/skill-descriptor.json", '{"providers":[{"version":"1.0.0"}]}\n');
  for (const file of ["contracts/workspace-profile-request.v1.schema.json", "contracts/workspace-convention-profile.v1.schema.json", "integration/provider-result.v1.schema.json"]) write(file, "{}\n");
  return f;
}

it("D0114 profiler CLI accepts readable required files, links and JSON", () => {
  const result = launch(profilerFixture(), profilerEntry);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ valid: true, errors: [] });
});

for (const [operation, file, misleading] of [
  ["access", "agents/openai.yaml", "missing agents/openai.yaml"],
  ["access", "README.md", "broken link README.md"],
  ["readFile", "contracts/workspace-profile-request.v1.schema.json", "invalid JSON contracts/workspace-profile-request.v1.schema.json"],
  ["readFile", "integration/provider-result.v1.schema.json", "invalid JSON integration/provider-result.v1.schema.json"],
]) {
  it.each(["EACCES", "EPERM", "EIO", "ENOTDIR"])(`D0114 profiler CLI preserves ${file} native error and cause (%s)`, code => {
    const result = launch(profilerFixture(), profilerEntry, { operation, file: profilerPrefix + file, code });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${code}: D0114 controlled I/O failure`);
    expect(result.stderr).toContain(`code: '${code}'`);
    expect(result.stderr).toContain("D0114 original I/O cause");
    expect(result.stdout).not.toContain(misleading);
  });
}

it.each([
  ["agents/openai.yaml", "missing agents/openai.yaml"],
  ["README.md", "broken link README.md"],
])("D0114 profiler CLI keeps genuine ENOENT diagnosis for %s", (file, diagnosis) => {
  const result = launch(profilerFixture(), profilerEntry, { operation: "access", file: profilerPrefix + file, code: "ENOENT" });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({ valid: false, errors: [diagnosis] });
});

it.each(["contracts/workspace-profile-request.v1.schema.json", "integration/provider-result.v1.schema.json"])("D0114 profiler CLI keeps actual JSON syntax diagnostics for %s", file => {
  const f = profilerFixture();
  f.write(profilerPrefix + file, "{broken-json\n");
  const result = launch(f, profilerEntry);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({ valid: false, errors: [`invalid JSON ${file}`] });
});

it.each(["contracts/workspace-profile-request.v1.schema.json", "integration/provider-result.v1.schema.json"])("D0114 profiler JSON read ENOENT remains a native missing-file failure for %s", file => {
  const result = launch(profilerFixture(), profilerEntry, { operation: "readFile", file: profilerPrefix + file, code: "ENOENT" });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("code: 'ENOENT'");
  expect(result.stderr).toContain("D0114 original I/O cause");
  expect(result.stdout).not.toContain(`invalid JSON ${file}`);
});
