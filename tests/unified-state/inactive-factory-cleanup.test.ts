import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInactiveSharedStores } from "../../mcp-server/src/inactive-shared-stores.js";
import { InactiveSharedConnection } from "../../runtime/unified-state/shared-connection.mjs";
import { failureContext } from "../../mcp-server/src/failure-diagnostics.js";

const directories: string[] = [];
const keys = { workflow: Buffer.alloc(32, 1).toString("base64url"), continuity: Buffer.alloc(32, 2).toString("base64url"), trust: Buffer.alloc(32, 3).toString("base64url") };
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(directory)).toMatch(/^ags-d0064-cleanup-/u);
    fs.rmSync(directory, { recursive: true });
  }
});

describe("inactive factory cleanup failure", () => {
  it("D-0064: owner.close failure after an initialization failure keeps the primary error and records a secondary", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ags-d0064-cleanup-")); directories.push(directory);
    const input = { directory, mode: "fixture-only" as const, clock: () => 100, syntheticKeys: keys };
    const first = createInactiveSharedStores(input); first.owner.close();
    const originalClose = InactiveSharedConnection.prototype.close;
    const closeFault = new Error("synthetic-close-fault");
    const spy = vi.spyOn(InactiveSharedConnection.prototype, "close").mockImplementation(function (this: InactiveSharedConnection) {
      originalClose.call(this);
      throw closeFault;
    });
    let rejected: unknown;
    try {
      createInactiveSharedStores({ ...input, syntheticKeys: { ...keys, trust: Buffer.alloc(32, 4).toString("base64url") } });
    } catch (error) { rejected = error; }
    finally { spy.mockRestore(); }
    expect(rejected).not.toBe(closeFault);
    expect(rejected).toMatchObject({ code: "REQUEST_CONFLICT", message: expect.stringMatching(/stored trust key differs/u) });
    const context = failureContext(rejected);
    expect(context.secondary).toEqual([expect.objectContaining({ type: "error", producerReason: "SHARED_OWNER_CLOSE_FAILED" })]);
    expect(JSON.stringify(context)).not.toContain("synthetic-close-fault");
    const reopen = createInactiveSharedStores(input);
    try { expect(reopen.owner.inspect().modules).toHaveLength(5); } finally { reopen.owner.close(); }
  });
});
