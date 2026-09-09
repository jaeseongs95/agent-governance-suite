import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const skillRoot = path.resolve(testsRoot, "..", "..", "skills", "task-contract");
const fixturePath = path.join(testsRoot, "fixtures", "normal", "simple-read.json");

function execute(input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(skillRoot, "scripts", "validate-task-contract.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("CLI validates JSON stdin without modifying its source fixture", async () => {
  const before = (await stat(fixturePath)).mtimeMs;
  const input = JSON.parse(await readFile(fixturePath, "utf8"));
  const result = await execute(input);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).output.verdict, "PASS");
  assert.equal((await stat(fixturePath)).mtimeMs, before);
});

test("CLI returns structured INVALID_INPUT", async () => {
  const result = await execute({ schemaVersion: "1.0.0" });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "INVALID_INPUT");
});
