import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const directory = path.dirname(fileURLToPath(import.meta.url));

describe("evaluation-validity-auditor imported core", () => {
  it("passes the suite's normal, boundary, failure, and security regression cases", () => {
    const result = spawnSync(process.execPath, ["--test", path.join(directory, "evaluation-validity.node.mjs")], {
      encoding: "utf8",
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
