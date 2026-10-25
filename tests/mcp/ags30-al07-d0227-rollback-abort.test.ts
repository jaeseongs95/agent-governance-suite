import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
// @ts-expect-error Existing fixture-only JavaScript authority has no declaration file.
import { InactiveUnifiedAuthority, createProviderAdapter, fixtureDigest } from "../../runtime/unified-state/authority.mjs";
// @ts-expect-error Existing JavaScript fixtures have no declaration file.
import { scopeA, workflowRef, nextWorkflowRow, snapshot } from "../unified-state/fixtures.mjs";

it("AGS-D-0227: authority commit aborts the outer transaction when savepoint rollback fails", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ags30-al07-d0227-"));
  const original = new Error("synthetic-domain-commit-fault");
  const rollbackFailure = new Error("synthetic-savepoint-rollback-fault");
  const commands: string[] = [];
  let injectDomainFailure = false;
  const authority = new InactiveUnifiedAuthority({
    directory, mode: "fixture-only", clock: () => 100,
    fault(point: string) { if (injectDomainFailure && point === "after-effect-before-receipt-commit") throw original; },
  });
  try {
    const provider = createProviderAdapter(authority, scopeA);
    const json = snapshot();
    expect(provider.importFixture({ snapshotJson: json, sourceDigest: fixtureDigest(json), intentId: "seed-before-fault" }).state).toBe("COMPLETE");
    const lease = provider.claim(workflowRef, { expectedRevision: 4, owner: "synthetic-owner", ttlMs: 1000 });
    const before = authority.inspect().counts;
    const exec = DatabaseSync.prototype.exec;
    const intercept = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      commands.push(sql);
      if (sql === "ROLLBACK TO domain_operation") throw rollbackFailure;
      return exec.call(this, sql);
    });
    injectDomainFailure = true;
    let failure: unknown;
    try {
      provider.commit(workflowRef, { expectedRevision: 4, lease, row: nextWorkflowRow(), intentId: "rejected-write", receiptId: "rejected-receipt" });
    } catch (error) { failure = error; }
    finally { intercept.mockRestore(); }
    expect(failure).toBe(original);
    expect(commands).toEqual(["BEGIN IMMEDIATE", "SAVEPOINT domain_operation", "ROLLBACK TO domain_operation", "ROLLBACK"]);
    expect(commands).not.toContain("RELEASE domain_operation"); expect(commands).not.toContain("COMMIT");
    expect(provider.read(workflowRef).revision).toBe(4);
    expect(provider.history(workflowRef)).toHaveLength(1);
    expect(provider.receipt("rejected-write")).toBeNull();
    expect(authority.inspect().counts).toEqual(before);
  } finally {
    vi.restoreAllMocks();
    try { authority.close(); }
    finally {
      if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("ags30-al07-d0227-")) throw new Error("Cleanup escaped the owned fixture root.");
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
