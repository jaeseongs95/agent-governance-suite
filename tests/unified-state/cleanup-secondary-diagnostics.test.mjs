import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInactiveSharedStores } from "../../mcp-server/src/inactive-shared-stores.ts";
import { failureContext } from "../../mcp-server/src/failure-diagnostics.ts";
import { InactiveUnifiedAuthority, createProviderAdapter, fixtureDigest } from "../../runtime/unified-state/authority.mjs";
import { scopeA, snapshot } from "./fixtures.mjs";

const directories = [];
const keys = { workflow: Buffer.alloc(32, 1).toString("base64url"), continuity: Buffer.alloc(32, 2).toString("base64url"), trust: Buffer.alloc(32, 3).toString("base64url") };
const FOREIGN_APP = 19088743;
function directory() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "ags-d0064-secondary-")); directories.push(value); return value; }
function foreignDatabase(dir) {
  const filename = path.join(dir, "ags-state.sqlite3");
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE preserved(id TEXT PRIMARY KEY); INSERT INTO preserved VALUES('original'); PRAGMA application_id=${FOREIGN_APP}; PRAGMA user_version=99;`);
  db.close();
  return filename;
}
function capture(action) { try { action(); } catch (error) { return error; } throw new Error("Expected the protected operation to fail."); }
function failingNativeClose(fault) {
  const original = DatabaseSync.prototype.close;
  return vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function () { original.call(this); throw fault; });
}
function expectUnchangedForeign(filename) {
  const read = new DatabaseSync(filename, { readOnly: true });
  try {
    expect(read.prepare("PRAGMA application_id").get()).toMatchObject({ application_id: FOREIGN_APP });
    expect(read.prepare("SELECT id FROM preserved").get()).toMatchObject({ id: "original" });
  } finally { read.close(); }
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) {
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(dir)).toMatch(/^ags-d0064-secondary-/u);
    fs.rmSync(dir, { recursive: true });
  }
});

describe("D-0064: cleanup failures never replace the primary unified-state error", () => {
  it("shared factory: native close failure on a foreign DB keeps FOREIGN_OR_NEWER_DATABASE", () => {
    const dir = directory(); const filename = foreignDatabase(dir);
    const closeFault = new Error("synthetic-native-close-fault");
    const spy = failingNativeClose(closeFault);
    let rejected;
    try { rejected = capture(() => createInactiveSharedStores({ directory: dir, mode: "fixture-only", clock: () => 100, syntheticKeys: keys })); }
    finally { spy.mockRestore(); }
    expect(rejected).not.toBe(closeFault);
    expect(rejected).toMatchObject({ code: "FOREIGN_OR_NEWER_DATABASE" });
    const context = failureContext(rejected);
    expect(context.secondary).toEqual([expect.objectContaining({ type: "error", producerReason: "SHARED_DATABASE_CLOSE_FAILED" })]);
    expect(JSON.stringify(context)).not.toContain("synthetic-native-close-fault");
    expect(JSON.stringify(context)).not.toContain(dir);
    expectUnchangedForeign(filename);
  });
  it("authority: native close failure on a foreign DB keeps FOREIGN_OR_NEWER_DATABASE", () => {
    const dir = directory(); const filename = foreignDatabase(dir);
    const closeFault = new Error("synthetic-authority-close-fault");
    const spy = failingNativeClose(closeFault);
    let rejected;
    try { rejected = capture(() => new InactiveUnifiedAuthority({ directory: dir, mode: "fixture-only", clock: () => 100 })); }
    finally { spy.mockRestore(); }
    expect(rejected).not.toBe(closeFault);
    expect(rejected).toMatchObject({ code: "FOREIGN_OR_NEWER_DATABASE" });
    const context = failureContext(rejected);
    expect(context.secondary).toEqual([expect.objectContaining({ type: "error", producerReason: "AUTHORITY_DATABASE_CLOSE_FAILED" })]);
    expect(JSON.stringify(context)).not.toContain("synthetic-authority-close-fault");
    expectUnchangedForeign(filename);
  });
  it("shared transaction: savepoint and transaction ROLLBACK failures are retained as secondaries", () => {
    const value = createInactiveSharedStores({ directory: directory(), mode: "fixture-only", clock: () => 100, syntheticKeys: keys });
    const primary = new Error("synthetic-domain-fault");
    const rejected = capture(() => value.owner.transaction(() => { value.owner.close(); throw primary; }));
    expect(rejected).toBe(primary);
    expect(failureContext(rejected).secondary).toEqual([
      expect.objectContaining({ type: "error", producerReason: "SAVEPOINT_ROLLBACK_FAILED" }),
      expect.objectContaining({ type: "error", producerReason: "TRANSACTION_ROLLBACK_FAILED" }),
    ]);
  });
  it("authority transaction: ROLLBACK failure is retained as a secondary of the primary error", () => {
    const primary = new Error("synthetic-import-fault");
    let closer = () => {};
    const authority = new InactiveUnifiedAuthority({ directory: directory(), mode: "fixture-only", fault: (point) => { if (point === "after-row-before-journal") { closer(); throw primary; } } });
    closer = () => authority.close();
    const json = snapshot();
    const rejected = capture(() => createProviderAdapter(authority, scopeA).importFixture({ snapshotJson: json, sourceDigest: fixtureDigest(json), intentId: "rollback-secondary" }));
    expect(rejected).toBe(primary);
    expect(failureContext(rejected).secondary).toEqual([expect.objectContaining({ type: "error", producerReason: "TRANSACTION_ROLLBACK_FAILED" })]);
  });
});
