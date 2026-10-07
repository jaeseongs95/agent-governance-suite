import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEngineeringSourceLock, renderClaudePlugin, projectEngineeringContentLock } from "../../scripts/build-claude-plugin.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const lockPath = "runtime/engineering-practices/CONTENT_LOCK.json";
const directories = [];
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const environment = { ...process.env };
delete environment.NODE_TEST_CONTEXT;
delete environment.NODE_OPTIONS;
delete environment.NODE_PATH;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot() {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-engineering-practices-"));
  directories.push(directory);
  return directory;
}

function run(directory, args) {
  return spawnSync(process.execPath, args, { cwd: directory, env: environment, encoding: "utf8", timeout: 20_000, windowsHide: true });
}

describe("Engineering Practices source integration", () => {
  it("runs the original core and public CLI regression suites with the native AGS schema runtime", () => {
    const result = run(root, ["--test", "--test-reporter=tap", "tests/engineering-practices/core.node.mjs", "tests/engineering-practices/paths-runner-cli.node.mjs", "tests/engineering-practices/stage-bundle.node.mjs"]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toMatch(/# fail 0/u);
    expect(result.stdout).toMatch(/# skipped 0/u);
  });

  it("checks every source byte before rendering and rejects missing inventory or source tampering", async () => {
    const lock = JSON.parse(await readFile(path.join(root, lockPath), "utf8"));
    const tracked = [...lock.files.map((file) => file.path), lockPath];
    const directory = await temporaryRoot();
    for (const file of [...lock.files, { path: lockPath }]) {
      const destination = path.join(directory, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(root, file.path), destination);
    }
    expect(await readEngineeringSourceLock(directory, tracked)).toEqual(lock);
    await expect(readEngineeringSourceLock(directory, tracked.slice(1))).rejects.toThrow(/exact source inventory/u);
    await writeFile(path.join(directory, lock.files[0].path), "tampered\n");
    await expect(readEngineeringSourceLock(directory, tracked)).rejects.toThrow(/source lock mismatch/u);
  });

  it("runs both installed host layouts without node_modules and binds Claude's exact adapted bytes", async () => {
    const sourceLock = JSON.parse(await readFile(path.join(root, lockPath), "utf8"));
    const rendered = await renderClaudePlugin(root);
    const hostLock = JSON.parse(rendered.get(lockPath).toString("utf8"));
    const omitted = sourceLock.files.filter((file) => !hostLock.files.some((shipped) => shipped.path === file.path)).map((file) => file.path);
    expect(omitted).toEqual([
      "claude-overlay/adaptations/code-review.json", "claude-overlay/adaptations/test-engineering.json",
      "skills/code-review/agents/openai.yaml", "skills/test-engineering/agents/openai.yaml",
    ]);
    expect(hostLock.files).toHaveLength(sourceLock.files.length - omitted.length);
    for (const file of hostLock.files) expect(file.digest, file.path).toBe(sha256(rendered.get(file.path)));
    const incomplete = new Map(rendered);
    incomplete.delete("runtime/engineering-practices/core.mjs");
    expect(() => projectEngineeringContentLock(incomplete, sourceLock)).toThrow(/shipped file is missing/u);
    for (const host of ["source", "claude"]) {
      const directory = await temporaryRoot();
      if (host === "source") {
        await Promise.all(["skills", "runtime", "contracts", "claude-overlay"].map((name) => cp(path.join(root, name), path.join(directory, name), { recursive: true })));
      } else {
        for (const [relative, bytes] of rendered) {
          await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
          await writeFile(path.join(directory, relative), bytes);
        }
      }
      for (const skill of ["test-engineering", "code-review"]) {
        const result = run(directory, [`skills/${skill}/scripts/run.mjs`, "self-check"]);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ status: "CONTENT_CONSISTENT", schemaEngine: "ags-ajv2020", lockedFiles: host === "source" ? sourceLock.files.length : hostLock.files.length });
      }
      await writeFile(path.join(directory, "runtime/engineering-practices/core.mjs"), `${await readFile(path.join(directory, "runtime/engineering-practices/core.mjs"), "utf8")}\n`);
      const altered = run(directory, ["skills/test-engineering/scripts/run.mjs", "self-check"]);
      expect(altered.status).toBe(2);
      expect(JSON.parse(altered.stderr)).toMatchObject({ status: "ERROR", code: "INTEGRITY_FAILED" });
    }
  });
});
