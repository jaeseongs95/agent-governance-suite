import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isPathWithin } from "../../skills/instruction-scope-resolver/scripts/resolve-instruction-files.mjs";

test("D0136 POSIX root contains an absolute child outside the controlled cwd", () => {
  const previousCwd = process.cwd();
  const directory = mkdtempSync(path.join(tmpdir(), "ags-d0136-cwd-"));
  try {
    process.chdir(directory);
    // This absolute POSIX path cannot be below the unique temporary cwd:
    // its only component differs from the temporary directory's last component.
    // A filesystem root contains it regardless of the host drive or cwd.
    assert.equal(isPathWithin("/", "/d0136-absolute-root-child", path.posix), true);
  } finally {
    process.chdir(previousCwd);
    rmSync(directory, { recursive: true, force: true });
  }
});
