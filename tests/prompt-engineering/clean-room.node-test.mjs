import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../../", import.meta.url));

test("shipped CLI validates and rejects invalid artifacts without node_modules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ags-prompt-clean-room-"));
  try {
    await mkdir(path.join(root, "skills"));
    await mkdir(path.join(root, "runtime"));
    await cp(path.join(repository, "skills/prompt-engineering"), path.join(root, "skills/prompt-engineering"), { recursive: true });
    await cp(path.join(repository, "runtime/schema-validation.mjs"), path.join(root, "runtime/schema-validation.mjs"));
    await cp(path.join(repository, "tests/prompt-engineering/fixtures"), path.join(root, "fixtures"), { recursive: true });
    assert.equal(existsSync(path.join(root, "node_modules")), false);
    const cli = "skills/prompt-engineering/scripts/check-report.mjs";
    const args = [cli, "--request", "fixtures/request.json", "--report", "fixtures/report.json"];
    const options = { cwd: root, env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" }, encoding: "utf8", timeout: 20_000 };
    const run = (arguments_) => {
      const result = spawnSync(process.execPath, arguments_, options);
      assert.equal(result.error, undefined);
      return result;
    };
    const valid = run(args);
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout), { valid: true, errors: [], validationScope: "structure-and-binding-only" });

    const invalidReport = JSON.parse(await readFile(path.join(root, "fixtures/report.json"), "utf8"));
    invalidReport.candidates[0].text += "\nUnbound change";
    await writeFile(path.join(root, "fixtures/invalid-report.json"), JSON.stringify(invalidReport));
    const invalid = run([cli, "--request", "fixtures/request.json", "--report", "fixtures/invalid-report.json"]);
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stdout).valid, false);

    const missing = run([cli, "--request", "missing.json", "--report", "fixtures/report.json"]);
    assert.equal(missing.status, 1);
    assert.ok(missing.stderr.includes("ENOENT"));

    await writeFile(path.join(root, "fixtures/malformed.json"), "{");
    const malformedRequest = run([cli, "--request", "fixtures/malformed.json", "--report", "fixtures/report.json"]);
    assert.equal(malformedRequest.status, 1);
    assert.equal(JSON.parse(malformedRequest.stdout).valid, false);
    const malformedReport = run([cli, "--request", "fixtures/request.json", "--report", "fixtures/malformed.json"]);
    assert.equal(malformedReport.status, 1);
    assert.ok(malformedReport.stderr.trim());
    assert.equal(run([cli, "--request", "fixtures/request.json"]).status, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
