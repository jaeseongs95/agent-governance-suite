import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "../../scripts/validate-repository.mjs");
const roots = [];

async function runAgainst(setup) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ags-validate-repository-"));
  roots.push(root);
  await setup(root);
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, AGENT_GOVERNANCE_ROOT: root },
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("validate-repository access failures", () => {
  it("reports an absent required file as missing", async () => {
    const { status, stderr } = await runAgainst(async () => {});
    expect(status).toBe(1);
    expect(stderr).toContain("missing required file: .codex-plugin/plugin.json");
  });

  it("reports a non-ENOENT access failure as a read failure, not as missing", async () => {
    // A regular file where a directory is expected makes access() fail with ENOTDIR for children.
    const { status, stderr } = await runAgainst(async (root) => {
      await writeFile(path.join(root, ".codex-plugin"), "not a directory");
    });
    expect(status).toBe(1);
    if (process.platform === "win32") {
      // Windows access maps an intermediate non-directory to ENOENT.
      expect(stderr).toContain("missing required file: .codex-plugin/plugin.json");
    } else {
      expect(stderr).toContain("cannot access .codex-plugin/plugin.json (ENOTDIR)");
      expect(stderr).not.toContain("missing required file: .codex-plugin/plugin.json");
    }
    expect(stderr).toContain("missing required file: .mcp.json");
  });
});
