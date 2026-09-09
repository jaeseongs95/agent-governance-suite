import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

describe("instruction-scope-resolver standalone regression", () => {
  test("runs every node:test case", () => {
    const files = readdirSync(testDirectory)
      .filter((name) => name.endsWith(".node.mjs"))
      .sort()
      .map((name) => path.join(testDirectory, name));

    expect(files.length).toBeGreaterThan(0);

    const result = spawnSync(process.execPath, ["--test", ...files], {
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
