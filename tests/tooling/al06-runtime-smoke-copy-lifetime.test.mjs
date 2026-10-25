import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  access: vi.fn(), cp: vi.fn(), mkdir: vi.fn(), mkdtemp: vi.fn(), rm: vi.fn(), writeFile: vi.fn(), spawnSync: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  access: boundary.access, cp: boundary.cp, mkdir: boundary.mkdir, mkdtemp: boundary.mkdtemp, rm: boundary.rm, writeFile: boundary.writeFile,
}));
vi.mock("node:child_process", () => ({ spawnSync: boundary.spawnSync }));

import { failureContext } from "../../runtime/failure-diagnostics.mjs";
import { runRuntimeSmokeCheck } from "../../scripts/runtime-smoke.mjs";

const cleanRoot = path.join(tmpdir(), "agent-governance-runtime-mocked-copy-fixture");
const sourceRoot = "fixture-source";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  boundary.mkdtemp.mockResolvedValue(cleanRoot);
  boundary.mkdir.mockResolvedValue(undefined);
  boundary.cp.mockResolvedValue(undefined);
  boundary.rm.mockResolvedValue(undefined);
  boundary.spawnSync.mockImplementation(() => { throw new Error("A child cannot start after a failed copy."); });
});

describe("AL06 runtime clean-room owned copy lifetime", () => {
  it("settles every started copy before cleanup and preserves the missing bundle error", async () => {
    const primary = Object.assign(new Error("Missing messaging bundle."), { code: "ENOENT" });
    const delayed = deferred();
    let delayedCopySettled = false;
    boundary.cp.mockImplementation(source => {
      if (path.basename(source) === "contracts") {
        return delayed.promise.then(() => { delayedCopySettled = true; });
      }
      if (path.basename(source) === "session-message-broker.mjs") return Promise.reject(primary);
      return Promise.resolve();
    });
    const outcome = runRuntimeSmokeCheck(sourceRoot).catch(error => error);
    let failure;
    try {
      await nextTurn();
      expect(boundary.cp).toHaveBeenCalled();
      expect(delayedCopySettled).toBe(false);
      expect(boundary.rm).not.toHaveBeenCalled();
      expect(boundary.spawnSync).not.toHaveBeenCalled();
    } finally {
      delayed.resolve();
      failure = await outcome;
    }
    expect(failure).toBe(primary);
    expect(delayedCopySettled).toBe(true);
    expect(boundary.rm).toHaveBeenCalledExactlyOnceWith(cleanRoot, { recursive: true, force: true });
    expect(boundary.spawnSync).not.toHaveBeenCalled();
  });

  it("keeps the primary identity and retains a secondary cleanup failure through the existing diagnostics helper", async () => {
    const primary = Object.freeze(Object.assign(new Error("Missing messaging bundle."), { code: "ENOENT" }));
    const secondary = Object.assign(new Error("Cleanup could not remove the directory."), { code: "ENOTEMPTY" });
    boundary.cp.mockImplementation(source => path.basename(source) === "session-message-broker.mjs"
      ? Promise.reject(primary) : Promise.resolve());
    boundary.rm.mockRejectedValue(secondary);

    await expect(runRuntimeSmokeCheck(sourceRoot)).rejects.toBe(primary);
    expect(primary.code).toBe("ENOENT");
    expect(failureContext(primary).secondary).toEqual([failureContext(secondary)]);
    expect(boundary.rm).toHaveBeenCalledExactlyOnceWith(cleanRoot, { recursive: true, force: true });
    expect(boundary.spawnSync).not.toHaveBeenCalled();
  });
});
