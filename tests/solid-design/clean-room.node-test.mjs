import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../../", import.meta.url));

test("the shipped CLI runs without node_modules in an isolated install tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ags-solid-clean-room-"));
  try {
    await mkdir(path.join(root, "skills"));
    await mkdir(path.join(root, "runtime"));
    await cp(path.join(repository, "skills/solid-design"), path.join(root, "skills/solid-design"), { recursive: true });
    await cp(path.join(repository, "runtime/schema-validation.mjs"), path.join(root, "runtime/schema-validation.mjs"));
    await cp(path.join(repository, "tests/solid-design/fixtures"), path.join(root, "fixtures"), { recursive: true });
    assert.equal(existsSync(path.join(root, "node_modules")), false);
    const cli = ["skills/solid-design/scripts/check-report.mjs", "--request", "fixtures/request.json", "--report", "fixtures/report.json"];
    const options = { cwd: root, env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" }, encoding: "utf8", timeout: 20_000 };
    const result = spawnSync(process.execPath, cli, options);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { valid: true, errors: [], validationScope: "schema-and-binding-only" });

    const missing = spawnSync(process.execPath, [cli[0], "--request", "missing.json", "--report", "fixtures/report.json"], options);
    assert.equal(missing.status, 1);
    assert.ok(missing.stderr.includes("ENOENT"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
