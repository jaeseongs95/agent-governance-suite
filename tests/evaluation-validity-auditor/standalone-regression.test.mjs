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
  }, 15_000);

  it("distinguishes operational I/O read failures from INVALID_INPUT in the CLI", () => {
    const cliPath = path.resolve(directory, "../../skills/evaluation-validity-auditor/scripts/cli.mjs");
    const ioRun = spawnSync(
      process.execPath,
      [cliPath, "--input", directory, "--artifact-root", directory],
      { encoding: "utf8", windowsHide: true },
    );
    expect(ioRun.status).toBe(2);
    expect(JSON.parse(ioRun.stdout)).toMatchObject({
      schemaVersion: "1.0.0",
      ok: false,
      error: {
        code: "EISDIR",
        details: { causeCategory: "io", causeCode: "EISDIR" },
      },
    });

    const koIoRun = spawnSync(
      process.execPath,
      [cliPath, "--format", "human-ko", "--input", directory, "--artifact-root", directory],
      { encoding: "utf8", windowsHide: true },
    );
    expect(koIoRun.status).toBe(2);
    expect(koIoRun.stdout).toContain("결론: 입출력 오류 (EISDIR).");

    const invalidInputRun = spawnSync(
      process.execPath,
      [cliPath, "--artifact-root", directory],
      { encoding: "utf8", input: "{not-json", windowsHide: true },
    );
    expect(invalidInputRun.status).toBe(2);
    expect(JSON.parse(invalidInputRun.stdout)).toMatchObject({
      schemaVersion: "1.0.0",
      ok: false,
      error: {
        code: "INVALID_INPUT",
        details: null,
      },
    });
  });
});
