import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

test("CS Node regressions run in an isolated process with the AGS Ajv runtime", () => {
  const files = readdirSync(import.meta.dirname).filter((name) => name.endsWith(".node.mjs")).sort();
  const result = spawnSync(process.execPath, ["--test", ...files.map((name) => path.join(import.meta.dirname, name))], {
    encoding:"utf8", windowsHide:true, timeout:90_000, maxBuffer:8 * 1024 * 1024,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 100_000);
