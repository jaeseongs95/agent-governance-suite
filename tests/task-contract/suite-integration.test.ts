import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const testsRoot = resolve(import.meta.dirname);
const nodeTests = readdirSync(testsRoot)
  .filter((entry) => entry.endsWith(".node.mjs"))
  .sort()
  .map((entry) => resolve(testsRoot, entry));

test("task-contract Node tests pass in an isolated process", () => {
  const result = spawnSync(process.execPath, ["--test", ...nodeTests], {
    encoding: "utf8",
    windowsHide: true
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});
