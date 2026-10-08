import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { InactiveUnifiedAuthority, createProviderAdapter, fixtureDigest } from "../../runtime/unified-state/authority.mjs";
import { scopeA, scopeB, workflowRef, workflowRow, nextWorkflowRow, records, reference, snapshot } from "./fixtures.mjs";

const directories = [];
const authorities = [];
const workerPath = path.join(import.meta.dirname, "worker.mjs");
function directory() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "ags-unified-state-")); directories.push(value); return value; }
function authority(dir, options = {}) { const result = new InactiveUnifiedAuthority({ directory: dir, mode: "fixture-only", ...options }); authorities.push(result); return result; }
function close(value) { value.close(); authorities.splice(authorities.indexOf(value), 1); }
function importAll(provider, snapshotJson = snapshot(), intentId = "import-once", batchSize = 100) { return provider.importFixture({ snapshotJson, sourceDigest: fixtureDigest(snapshotJson), intentId, batchSize }); }
function assertCode(action, expectedCode) { try { action(); } catch (error) { expect(error.code).toBe(expectedCode); return; } throw new Error(`Expected ${expectedCode}; protected operation incorrectly succeeded.`); }
function child(mode, dir, parameter) { return spawnSync(process.execPath, [workerPath, mode, dir, parameter], { encoding: "utf8", timeout: 10000, env: {} }); }
function report(label, value) { console.log(`B-RAW ${label} ${JSON.stringify(value)}`); }
afterEach(() => {
  for (const value of authorities.splice(0)) value.close();
  for (const dir of directories.splice(0)) {
    // These exact directories were created by this test; never recursively remove a computed external target.
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(dir)).toMatch(/^ags-unified-state-/u);
    fs.rmSync(dir, { recursive: true });
  }
});

describe("비활성 단일 SQLite authority/provider 후보", () => {
  it("B-CASE-01: five modules use one actual database and preserve original rows/IDs/epoch/trust/UNKNOWN", () => {
    const dir = directory(); const value = authority(dir); const provider = createProviderAdapter(value, scopeA);
    expect(importAll(provider)).toEqual({ state: "COMPLETE", nextIndex: 7, inserted: 7 });
    for (const entry of records()) {
      const actual = provider.read(reference(entry));
      expect(actual.row).toEqual(entry.row);
      expect(actual.trustVerification).toBe("NOT_VERIFIED_BY_THIS_CANDIDATE");
    }
    expect(provider.read(reference(records()[2])).revision).toBe(7);
    expect(provider.read(reference(records()[2])).epoch).toBe(2);
    expect(provider.read(reference(records()[3])).row.result_json).toBe('{"state":"UNKNOWN","revision":7}');
    expect(createProviderAdapter(value, scopeB).databasePath).toBe(provider.databasePath);
    const inspection = value.inspect();
    expect(inspection.databases.filter((db) => db.name !== "temp").map((db) => db.file)).toEqual([value.databasePath]);
    expect(inspection.userVersion).toBe(1);
    expect(inspection.modules).toHaveLength(5);
    expect(inspection.counts.records).toBe(7); expect(inspection.counts.record_history).toBe(7); expect(inspection.counts.import_journal).toBe(7);
    expect(inspection.integrity[0].integrity_check).toBe("ok"); expect(inspection.foreignKeyViolations).toEqual([]);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".sqlite3"))).toEqual(["ags-state.sqlite3"]);
    report("single-db", inspection);
  });
  it("B-CASE-02: cross-scope denial and same raw IDs in distinct task scopes do not merge", () => {
    const value = authority(directory()); const left = createProviderAdapter(value, scopeA); const right = createProviderAdapter(value, scopeB);
    importAll(left); expect(right.read(workflowRef)).toBeNull();
    assertCode(() => right.read({ ...workflowRef, scope: scopeA }), "SCOPE_DENIED");
    assertCode(() => right.history({ ...workflowRef, scope: scopeA }), "SCOPE_DENIED");
    assertCode(() => importAll(right, snapshot()), "SCOPE_DENIED");
    importAll(right, snapshot(scopeB));
    expect(left.read(workflowRef).row.run_id).toBe("original-run-id");
    expect(right.read(workflowRef).row.run_id).toBe("original-run-id");
    expect(value.inspect().counts.records).toBe(14);
  });
  it("B-CASE-03: same original ID with different payload commits a conflict ledger without partial import/overwrite", () => {
    const value = authority(directory()); const provider = createProviderAdapter(value, scopeA);
    const entries = [records()[0], { ...records()[0], row: { ...workflowRow, state: "failed" } }];
    const source = snapshot(scopeA, entries);
    expect(importAll(provider, source).state).toBe("CONFLICT");
    expect(importAll(provider, source).state).toBe("CONFLICT");
    const counts = value.inspect().counts;
    expect(counts.records).toBe(0); expect(counts.record_history).toBe(0); expect(counts.import_journal).toBe(0); expect(counts.conflicts).toBe(1);
    report("conflict-no-overwrite", counts);
  });
  it("B-CASE-04: chunk close/reopen and identical-source new intent resume without duplicate effects; changed source conflicts", () => {
    const dir = directory(); let value = authority(dir); let provider = createProviderAdapter(value, scopeA);
    expect(importAll(provider, snapshot(), "import-once", 2)).toEqual({ state: "PENDING", nextIndex: 2, inserted: 2 });
    close(value); value = authority(dir); provider = createProviderAdapter(value, scopeA);
    expect(importAll(provider)).toEqual({ state: "COMPLETE", nextIndex: 7, inserted: 5 });
    expect(importAll(provider)).toEqual({ state: "COMPLETE", nextIndex: 7, inserted: 0 });
    expect(importAll(provider, snapshot(), "second-intent")).toEqual({ state: "COMPLETE", nextIndex: 7, inserted: 0 });
    const changed = records(); changed[0].row.state = "failed";
    expect(importAll(provider, snapshot(scopeA, changed), "changed-intent").reason).toBe("SOURCE_CHANGED");
    expect(importAll(provider, snapshot(scopeA, changed), "import-once").reason).toBe("INTENT_SOURCE_CHANGED");
    expect(importAll(provider)).toEqual({ state: "COMPLETE", nextIndex: 7, inserted: 0 });
    expect(provider.read(workflowRef).row).toEqual(workflowRow);
    expect(value.inspect().counts.records).toBe(7); expect(value.inspect().counts.record_history).toBe(7);
    report("resume-source-pins", value.inspect());
  });
  it.each(["after-row-before-journal", "after-marker-before-commit"])("B-CASE-05: process interruption %s rolls back both data and progress", (phase) => {
    const dir = directory(); fs.writeFileSync(path.join(dir, "source-fixture.json"), snapshot(), "utf8");
    const result = child("crash-import", dir, phase);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(71);
    const value = authority(dir); const counts = value.inspect().counts;
    expect(counts.records).toBe(0); expect(counts.import_journal).toBe(0); expect(counts.import_intents).toBe(0); expect(counts.import_sources).toBe(0); expect(counts.record_history).toBe(0);
    expect(importAll(createProviderAdapter(value, scopeA)).inserted).toBe(7);
    report(`crash-import-${phase}`, { childExit: result.status, recoveredCounts: counts, resumedCounts: value.inspect().counts });
  });
  it("B-CASE-06: two independent processes racing for the same generation have exactly one claim winner", async () => {
    const dir = directory(); const value = authority(dir); importAll(createProviderAdapter(value, scopeA)); close(value);
    const children = ["worker-one", "worker-two"].map((owner) => fork(workerPath, ["claim", dir, owner], { stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: [], env: {} }));
    const results = await Promise.all(children.map((worker) => new Promise((resolve, reject) => {
      let outcome; let stderr = "";
      worker.stderr.on("data", (data) => { stderr += data.toString(); });
      worker.on("error", reject);
      worker.on("message", (message) => {
        if (message.type === "ready") {
          worker.readyForClaim = true;
          if (children.every((current) => current.readyForClaim)) children.forEach((current) => current.send({ type: "go" }));
        } else outcome = message.lease;
      });
      worker.on("exit", (code) => { if (code !== 0 || outcome === undefined) reject(new Error(`Fixture race worker failed: ${code}; ${stderr}`)); else resolve(outcome); });
    })));
    expect(results.filter(Boolean)).toHaveLength(1); expect(results.filter(Boolean)[0].generation).toBe(1);
    report("independent-process-claim", { winnerCount: results.filter(Boolean).length, results });
  }, 15000);
  it("B-CASE-07: stale revision/generation and expiry boundary are rejected; a backwards clock cannot revive expiry", () => {
    let now = 1000; const value = authority(directory(), { clock: () => now }); const provider = createProviderAdapter(value, scopeA); importAll(provider);
    const first = provider.claim(workflowRef, { expectedRevision: 4, owner: "same-owner", ttlMs: 100 });
    now = 1100;
    assertCode(() => provider.commit(workflowRef, { expectedRevision: 4, lease: first, row: nextWorkflowRow(), intentId: "expired", receiptId: "expired-receipt" }), "STALE_REVISION_OR_LEASE");
    now = 900;
    assertCode(() => provider.commit(workflowRef, { expectedRevision: 4, lease: first, row: nextWorkflowRow(), intentId: "clock-back", receiptId: "clock-back-receipt" }), "STALE_REVISION_OR_LEASE");
    now = 1200;
    const second = provider.claim(workflowRef, { expectedRevision: 4, owner: "same-owner", ttlMs: 1000 });
    expect(second.generation).toBe(2);
    assertCode(() => provider.commit(workflowRef, { expectedRevision: 4, lease: first, row: nextWorkflowRow(), intentId: "stale-generation", receiptId: "stale-receipt" }), "STALE_REVISION_OR_LEASE");
    expect(provider.commit(workflowRef, { expectedRevision: 4, lease: second, row: nextWorkflowRow(), intentId: "valid", receiptId: "valid-receipt" }).applied).toBe(true);
    assertCode(() => provider.claim(workflowRef, { expectedRevision: 4, owner: "stale-revision", ttlMs: 100 }), "STALE_REVISION");
    expect(provider.history(workflowRef).map((row) => row.revision)).toEqual([4, 5]);
    expect(provider.receipt("stale-generation")).toBeNull();
  });
  it("B-CASE-08: write/receipt interruption is atomic; committed response loss remains UNKNOWN and replay has one effect", () => {
    for (const phase of ["after-effect-before-receipt-commit", "after-commit-before-response"]) {
      const dir = directory(); let value = authority(dir); importAll(createProviderAdapter(value, scopeA)); close(value);
      const result = child("crash-write", dir, phase);
      expect(result.error).toBeUndefined(); expect(result.status).toBe(phase === "after-commit-before-response" ? 72 : 71);
      value = authority(dir, { clock: () => 1500 }); const provider = createProviderAdapter(value, scopeA);
      const committed = phase === "after-commit-before-response";
      expect(provider.read(workflowRef).revision).toBe(committed ? 5 : 4);
      expect(provider.receipt("effect-once")?.responseState ?? null).toBe(committed ? "UNKNOWN" : null);
      const command = { expectedRevision: 4, lease: { generation: 1, owner: "fixture-owner", expiresMs: 2000 }, row: nextWorkflowRow(), intentId: "effect-once", receiptId: "effect-receipt-original" };
      expect(provider.commit(workflowRef, command).applied).toBe(!committed);
      expect(provider.commit(workflowRef, command).applied).toBe(false);
      assertCode(() => provider.commit(workflowRef, { ...command, row: { ...nextWorkflowRow(), state: "failed" } }), "INTENT_CONFLICT");
      expect(provider.read(workflowRef).revision).toBe(5); expect(provider.history(workflowRef)).toHaveLength(2); expect(value.inspect().counts.write_intents).toBe(1);
      expect(provider.receipt("effect-once").responseState).toBe("UNKNOWN");
      expect(provider.acknowledge("effect-once", "wrong-receipt")).toBe(false);
      expect(provider.acknowledge("effect-once", "effect-receipt-original")).toBe(true);
      expect(provider.receipt("effect-once").responseState).toBe("ACKED");
      report(`write-boundary-${phase}`, { childExit: result.status, inspection: value.inspect(), receipt: provider.receipt("effect-once") });
    }
  });
  it("B-CASE-09: malformed/schema/secret/key drift and unsupported mutation paths do not write records", () => {
    const value = authority(directory()); const provider = createProviderAdapter(value, scopeA);
    assertCode(() => provider.importFixture({ snapshotJson: snapshot(), sourceDigest: "wrong", intentId: "wrong-digest" }), "SOURCE_DIGEST_MISMATCH");
    assertCode(() => importAll(provider, snapshot(scopeA, records(), { workflow: 6 })), "UNSUPPORTED_SCHEMA");
    const secret = [records()[0]]; secret[0].row.receipt_json = '{"signingSecret":"synthetic-must-be-rejected"}';
    assertCode(() => importAll(provider, snapshot(scopeA, secret)), "SECRET_IMPORT_UNSUPPORTED");
    assertCode(() => importAll(provider, snapshot(scopeA, [{ module: "continuity", table: "continuity_metadata", scope: scopeA, row: { key: "secret", value: "synthetic" } }])), "UNSUPPORTED_TABLE");
    expect(() => provider.importFixture({ snapshotJson: "{", sourceDigest: fixtureDigest("{"), intentId: "partial-json" })).toThrow();
    expect(value.inspect().counts.records).toBe(0); expect(value.inspect().counts.import_intents).toBe(0);
    importAll(provider);
    const lease = provider.claim(workflowRef, { expectedRevision: 4, owner: "key-drift", ttlMs: 1000 });
    assertCode(() => provider.commit(workflowRef, { expectedRevision: 4, lease, row: { ...nextWorkflowRow(), run_id: "changed-original-id" }, intentId: "key-drift", receiptId: "key-drift-receipt" }), "INVALID_INPUT");
    assertCode(() => provider.commit(reference(records()[1]), { expectedRevision: 0, lease, row: records()[1].row, intentId: "correlation-rebind", receiptId: "rebind-receipt" }), "MUTATION_UNSUPPORTED");
    expect(provider.read(workflowRef).revision).toBe(4);
  });
  it("B-CASE-10: existing unrelated/newer database and mode fail closed without changing its schema", () => {
    const dir = directory(); const databasePath = path.join(dir, "ags-state.sqlite3"); const unrelated = new DatabaseSync(databasePath);
    unrelated.exec("CREATE TABLE untouched(id TEXT PRIMARY KEY); INSERT INTO untouched VALUES ('original'); PRAGMA user_version=99;"); unrelated.close();
    assertCode(() => new InactiveUnifiedAuthority({ directory: dir, mode: "fixture-only" }), "FOREIGN_OR_NEWER_DATABASE");
    const reader = new DatabaseSync(databasePath, { readOnly: true }); expect(reader.prepare("SELECT id FROM untouched").get().id).toBe("original"); expect(reader.prepare("PRAGMA user_version").get().user_version).toBe(99); reader.close();
    assertCode(() => new InactiveUnifiedAuthority({ directory: dir, mode: "live" }), "INACTIVE_MODE_REQUIRED");
  });
  it("B-CASE-11: persisted module schema drift is rejected without silently replacing metadata", () => {
    const dir = directory(); const value = authority(dir); const filename = value.databasePath; close(value);
    const fixtureEditor = new DatabaseSync(filename);
    fixtureEditor.prepare("UPDATE module_schema SET source_versions_json='[99]' WHERE module='workflow'").run(); fixtureEditor.close();
    assertCode(() => new InactiveUnifiedAuthority({ directory: dir, mode: "fixture-only" }), "CANDIDATE_SCHEMA_DRIFT");
    const reader = new DatabaseSync(filename, { readOnly: true });
    expect(reader.prepare("SELECT source_versions_json FROM module_schema WHERE module='workflow'").get().source_versions_json).toBe("[99]"); reader.close();
  });
  it.each(["stale-revision", "expiry-overflow"])("B-CASE-12: rejected domain %s persists valid time across connections and cannot revive expiry", (reason) => {
    let now = 100;
    const dir = directory(); const first = authority(dir, { clock: () => now }); const firstProvider = createProviderAdapter(first, scopeA); importAll(firstProvider);
    const lease = firstProvider.claim(workflowRef, { expectedRevision: 4, owner: "original-clock-owner", ttlMs: 10 });
    expect(lease.expiresMs).toBe(110);
    const rejecting = authority(dir, { clock: () => 200 }); const rejectingProvider = createProviderAdapter(rejecting, scopeA);
    assertCode(() => rejectingProvider.claim(workflowRef, { expectedRevision: reason === "stale-revision" ? 99 : 4, owner: "clock-other", ttlMs: reason === "expiry-overflow" ? Number.MAX_SAFE_INTEGER : 10 }), reason === "stale-revision" ? "STALE_REVISION" : "INVALID_INPUT");
    close(rejecting); now = 105;
    assertCode(() => firstProvider.commit(workflowRef, { expectedRevision: 4, lease, row: nextWorkflowRow(), intentId: "rejected-clock-late", receiptId: "rejected-clock-receipt" }), "STALE_REVISION_OR_LEASE");
    close(first);
    const reopened = authority(dir, { clock: () => 105 }); const provider = createProviderAdapter(reopened, scopeA);
    assertCode(() => provider.commit(workflowRef, { expectedRevision: 4, lease, row: nextWorkflowRow(), intentId: "restart-clock-late", receiptId: "restart-clock-receipt" }), "STALE_REVISION_OR_LEASE");
    expect(provider.read(workflowRef).revision).toBe(4); expect(provider.history(workflowRef)).toHaveLength(1); expect(provider.receipt("rejected-clock-late")).toBeNull();
    expect(reopened.inspect().counts.write_intents).toBe(0);
    report(`clock-domain-rejection-${reason}`, { observedTimes: [100, 200, 105], lease, counts: reopened.inspect().counts });
  });
  it("B-CASE-13: another process rejected claim persists time for an old lease on a reopened connection", () => {
    const dir = directory(); const initial = authority(dir, { clock: () => 100 }); const initialProvider = createProviderAdapter(initial, scopeA); importAll(initialProvider);
    const lease = initialProvider.claim(workflowRef, { expectedRevision: 4, owner: "original-process-owner", ttlMs: 10 }); close(initial);
    const result = child("clock-rejection", dir, "unused"); expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const actual = JSON.parse(result.stdout.trim()); expect(actual).toEqual({ rejection: "STALE_REVISION", observedTimes: [200], revision: 4 });
    const value = authority(dir, { clock: () => 105 }); const provider = createProviderAdapter(value, scopeA);
    assertCode(() => provider.commit(workflowRef, { expectedRevision: 4, lease, row: nextWorkflowRow(), intentId: "cross-process-late", receiptId: "cross-process-receipt" }), "STALE_REVISION_OR_LEASE");
    expect(provider.read(workflowRef).revision).toBe(4); expect(provider.receipt("cross-process-late")).toBeNull();
    report("clock-rejected-other-process", { childExit: result.status, actual, expiredWriteRejected: true });
  });
  it("B-CASE-14: malformed/scope-denied requests observe no time and invalid clock never persists", () => {
    let now = 100; const observed = []; const value = authority(directory(), { clock: () => { observed.push(now); return now; } }); const provider = createProviderAdapter(value, scopeA); importAll(provider);
    const lease = provider.claim(workflowRef, { expectedRevision: 4, owner: "valid-clock-owner", ttlMs: 10 });
    now = 200;
    assertCode(() => provider.claim(workflowRef, { expectedRevision: "99", owner: "invalid", ttlMs: 10 }), "INVALID_INPUT");
    assertCode(() => provider.claim({ ...workflowRef, scope: scopeB }, { expectedRevision: 4, owner: "denied", ttlMs: 10 }), "SCOPE_DENIED");
    assertCode(() => provider.commit({ ...workflowRef, scope: scopeB }, { expectedRevision: 4, lease, row: nextWorkflowRow(), intentId: "scope-denied", receiptId: "scope-denied-receipt" }), "SCOPE_DENIED");
    expect(observed).toEqual([100]);
    now = Number.NaN;
    assertCode(() => provider.claim(workflowRef, { expectedRevision: 4, owner: "invalid-clock", ttlMs: 10 }), "INVALID_INPUT");
    now = 105;
    const command = { expectedRevision: 4, lease, row: nextWorkflowRow(), intentId: "valid-after-rejections", receiptId: "valid-after-rejections-receipt" };
    expect(provider.commit(workflowRef, command).applied).toBe(true); expect(provider.commit(workflowRef, command).applied).toBe(false);
    expect(provider.receipt(command.intentId).responseState).toBe("UNKNOWN");
    expect(provider.history(workflowRef).map((row) => row.revision)).toEqual([4, 5]); expect(observed).toEqual([100, Number.NaN, 105, 105]);
  });
  it("B-CASE-15: concurrent rejected high/low clock observations leave the maximum durable time", async () => {
    const dir = directory(); const initial = authority(dir, { clock: () => 100 }); const initialProvider = createProviderAdapter(initial, scopeA); importAll(initialProvider);
    const lease = initialProvider.claim(workflowRef, { expectedRevision: 4, owner: "concurrent-clock-owner", ttlMs: 10 }); close(initial);
    const results = await Promise.all(["105", "200"].map((clockValue) => new Promise((resolve, reject) => {
      const worker = spawn(process.execPath, [workerPath, "clock-rejection", dir, clockValue], { stdio: ["ignore", "pipe", "pipe"], env: {} });
      let stdout = ""; let stderr = "";
      worker.stdout.on("data", (data) => { stdout += data.toString(); }); worker.stderr.on("data", (data) => { stderr += data.toString(); });
      worker.on("error", reject);
      worker.on("close", (code) => {
        if (code !== 0) reject(new Error(`Fixture clock worker failed: ${code}; ${stderr}`));
        else { try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); } }
      });
    })));
    expect(results.map((result) => result.observedTimes[0]).sort((left, right) => left - right)).toEqual([105, 200]);
    expect(results.every((result) => result.rejection === "STALE_REVISION" && result.revision === 4)).toBe(true);
    const value = authority(dir, { clock: () => 105 }); const provider = createProviderAdapter(value, scopeA);
    assertCode(() => provider.commit(workflowRef, { expectedRevision: 4, lease, row: nextWorkflowRow(), intentId: "concurrent-clock-late", receiptId: "concurrent-clock-receipt" }), "STALE_REVISION_OR_LEASE");
    expect(provider.read(workflowRef).revision).toBe(4); expect(provider.receipt("concurrent-clock-late")).toBeNull();
    report("concurrent-clock-rejections", { results, expiredWriteRejected: true });
  }, 15000);
  it("B-CASE-16: recoverable domain write failure rolls back effect/history/receipt while retaining valid time", () => {
    let now = 100; let rejectDomain = false;
    const value = authority(directory(), { clock: () => now, fault: (point) => { if (rejectDomain && point === "after-effect-before-receipt-commit") throw new Error("fixture-domain-write-failure"); } });
    const provider = createProviderAdapter(value, scopeA); const entries = records();
    const extra = { ...entries[0], row: { ...workflowRow, run_id: "clock-second-run", receipt_json: '{"runId":"clock-second-run","revision":4,"state":"ready"}' } }; entries.push(extra);
    importAll(provider, snapshot(scopeA, entries)); const longRef = reference(extra);
    const expired = provider.claim(workflowRef, { expectedRevision: 4, owner: "short-clock-owner", ttlMs: 10 });
    const longer = provider.claim(longRef, { expectedRevision: 4, owner: "long-clock-owner", ttlMs: 400 });
    now = 200; rejectDomain = true;
    expect(() => provider.commit(longRef, { expectedRevision: 4, lease: longer, row: { ...nextWorkflowRow(), run_id: "clock-second-run", receipt_json: '{"runId":"clock-second-run","revision":5,"state":"running"}' }, intentId: "domain-rejected-write", receiptId: "domain-rejected-receipt" })).toThrow("fixture-domain-write-failure");
    rejectDomain = false;
    expect(provider.read(longRef).revision).toBe(4); expect(provider.history(longRef)).toHaveLength(1); expect(provider.receipt("domain-rejected-write")).toBeNull();
    now = 105;
    assertCode(() => provider.commit(workflowRef, { expectedRevision: 4, lease: expired, row: nextWorkflowRow(), intentId: "domain-clock-late", receiptId: "domain-clock-late-receipt" }), "STALE_REVISION_OR_LEASE");
    expect(value.inspect().counts.record_history).toBe(8); expect(value.inspect().counts.write_intents).toBe(0);
    report("clock-domain-write-rollback", { effectRevision: provider.read(longRef).revision, receipt: provider.receipt("domain-rejected-write"), expiredWriteRejected: true });
  });
});
