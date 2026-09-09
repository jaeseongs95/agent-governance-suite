import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "instruction-scope-resolver");

function execute(input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", "resolve-instruction-files.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("CLI accepts JSON stdin and returns JSON stdout without stderr", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "scope-cli-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, "src"));
  await writeFile(path.join(workspace, "AGENTS.md"), "rule\n");
  const result = await execute({
    schemaVersion: "1.0.0",
    workspaceRoot: workspace,
    instructionRoots: [{ path: workspace, precedence: 1, authorized: true }],
    targets: [{ path: "src", mayNotExist: false }],
    externalPolicyRefs: [],
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.output.verdict, "ANALYSIS_REQUIRED");
  assert.equal(parsed.output.analysisStatus, "required");
});

test("CLI returns a structured error for invalid input", async () => {
  const result = await execute({ schemaVersion: "1.0.0" });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "INVALID_INPUT");
});
