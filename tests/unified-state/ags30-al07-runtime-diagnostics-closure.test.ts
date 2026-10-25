import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { failureContext } from "../../mcp-server/src/failure-diagnostics.js";
import { retainCleanupFailure } from "../../runtime/unified-state/shared-connection.mjs";

describe("AL07 packaged diagnostics closure", () => {
  it("keeps the original cleanup error and the same diagnostic provenance across source/runtime imports", () => {
    const primary = new Error("primary"); const secondary = new Error("secondary");
    expect(retainCleanupFailure(primary, "SHARED_DATABASE_CLOSE_FAILED", () => { throw secondary; })).toBe(false);
    expect(failureContext(primary)).toMatchObject({ secondary: [{ producerReason: "SHARED_DATABASE_CLOSE_FAILED" }] });
    expect(primary.message).toBe("primary");
    expect(retainCleanupFailure(primary, "SHARED_DATABASE_CLOSE_FAILED", () => {})).toBe(true);
  });
  it("imports the raw shared runtime from a package without mcp-server/src", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ags30-al07-runtime-"));
    try {
      mkdirSync(path.join(directory, "runtime", "unified-state"), { recursive: true });
      for (const file of ["runtime/failure-diagnostics.mjs", "runtime/unified-state/shared-connection.mjs"]) {
        copyFileSync(new URL(`../../${file}`, import.meta.url), path.join(directory, file));
      }
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
        import assert from "node:assert/strict";
        import { retainCleanupFailure } from "./runtime/unified-state/shared-connection.mjs";
        import { failureContext } from "./runtime/failure-diagnostics.mjs";
        const primary = new Error("primary");
        assert.equal(retainCleanupFailure(primary, "SAVEPOINT_ROLLBACK_FAILED", () => { throw new Error("secondary"); }), false);
        assert.equal(failureContext(primary).secondary[0].producerReason, "SAVEPOINT_ROLLBACK_FAILED");
      `], { cwd: directory, encoding: "utf8", timeout: 10_000 });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
    } finally { rmSync(directory, { recursive: true }); }
  });
});
