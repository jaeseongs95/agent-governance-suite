import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { ContinuityStoreError, continuityUnavailableReason, SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

// D0057: the public code stays CONTINUITY_UNAVAILABLE, but a SQLite CORRUPT (11 and its extended codes) or NOTADB (26)
// failure keeps the detail reason CORRUPT_DATABASE, also when it is raised inside a store write transaction.
const stores: SqliteContinuityStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function sqliteError(errcode: number): Error {
  return Object.assign(new Error("synthetic driver failure"), { code: "ERR_SQLITE_ERROR", errcode });
}

function setup() {
  const store = new SqliteContinuityStore(":memory:");
  stores.push(store);
  const service = new ContinuityService(store, new ContractValidator(), new InMemoryWorkflowStore(), () => new Date("2026-11-01T01:00:00.000Z"));
  const database = (store as unknown as { database: DatabaseSync }).database;
  const prepare = database.prepare.bind(database);
  /** From now on every statement fails (`always`) or only those inside a write transaction. */
  const fail = (error: Error, scope: "always" | "transaction") => vi.spyOn(database, "prepare").mockImplementation((sql: string) => {
    if (scope === "always" || database.isTransaction) throw error;
    return prepare(sql);
  });
  const bound = <T extends Record<string, unknown>>(tool: string, input: T) => ({ ...input, _continuityBinding: service.issueToolBinding("s-1", tool, input) });
  const checkpointInput = (expectedRevision: number) => ({
    schemaVersion: "1.0.0", requestId: `checkpoint-${expectedRevision}`, expectedRevision, status: "active",
    core: { objective: "o", completionCriteria: ["c"], constraints: [], decisions: [], progress: [], blockers: [], nextActions: [] },
    evidenceRefs: [{ artifactId: "t", locator: "tests", digest: convergenceDigest("t"), verified: true }],
  });
  return { service, fail, bound, checkpointInput };
}

describe("D0057 continuity store failure reasons", () => {
  it.each([
    [11, "CORRUPT_DATABASE"], [26, "CORRUPT_DATABASE"], [267, "CORRUPT_DATABASE"], [779, "CORRUPT_DATABASE"],
    [5, "STORE_UNAVAILABLE"], [10, "STORE_UNAVAILABLE"], [27, "STORE_UNAVAILABLE"],
  ] as const)("a write transaction failing with errcode %i keeps the reason %s", (errcode, reason) => {
    const { service, fail, bound, checkpointInput } = setup();
    expect(service.checkpointContext(checkpointInput(0), caller).error).toBeNull();
    const request = bound("checkpoint_context", checkpointInput(1));
    fail(sqliteError(errcode), "transaction");
    const result = service.checkpointContext(request);
    expect(result.error).toMatchObject({ code: "CONTINUITY_UNAVAILABLE", details: { reason } });
    expect(JSON.stringify(result)).not.toContain("synthetic driver failure");
  });

  it("inspect and load keep CORRUPT_DATABASE for 11 and 26 and STORE_UNAVAILABLE for other failures", () => {
    for (const [error, reason] of [[sqliteError(11), "CORRUPT_DATABASE"], [sqliteError(26), "CORRUPT_DATABASE"],
      [sqliteError(5), "STORE_UNAVAILABLE"], [new Error("not a driver error"), "STORE_UNAVAILABLE"]] as const) {
      const { service, fail, bound, checkpointInput } = setup();
      const saved = service.checkpointContext(checkpointInput(0), caller).data!;
      const candidate = service.inspectContext({ schemaVersion: "1.0.0" }, caller).data!;
      expect(candidate.restoreToken).toEqual(expect.any(String));
      const inspectRequest = bound("inspect_context", { schemaVersion: "1.0.0" });
      const loadRequest = bound("load_context", { schemaVersion: "1.0.0", candidateToken: candidate.restoreToken!, epoch: saved.epoch,
        revision: saved.revision, digest: saved.snapshotDigest });
      fail(error, "always");
      expect(service.inspectContext(inspectRequest).error, reason).toMatchObject({ code: "CONTINUITY_UNAVAILABLE", details: { reason } });
      expect(service.loadContext(loadRequest).error, reason).toMatchObject({ code: "CONTINUITY_UNAVAILABLE", details: { reason } });
    }
  });

  it("opening a file that is not a database reports CORRUPT_DATABASE", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ags-d0057-"));
    directories.push(directory);
    const file = join(directory, "continuity.sqlite3");
    await writeFile(file, "this is not a sqlite database, only text padding the header ".repeat(16), "utf8");
    let caught: unknown;
    try { stores.push(new SqliteContinuityStore(file)); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ContinuityStoreError);
    expect(continuityUnavailableReason(caught)).toBe("CORRUPT_DATABASE");
  });

  it("an opaque or proxied failure is STORE_UNAVAILABLE without running its traps", () => {
    const trap = vi.fn(() => { throw new Error("trap ran"); });
    const proxy = new Proxy({}, { has: trap, get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    expect(continuityUnavailableReason(proxy)).toBe("STORE_UNAVAILABLE");
    expect(trap).not.toHaveBeenCalled();
    const masquerade = new Proxy(new ContinuityStoreError("m", undefined, "CORRUPT_DATABASE"), {});
    expect(continuityUnavailableReason(masquerade)).toBe("STORE_UNAVAILABLE");
    for (const value of [null, undefined, "errcode 11", 11, { errcode: "11" }, Object.create({ errcode: 11 })]) {
      expect(continuityUnavailableReason(value), String(value)).toBe("STORE_UNAVAILABLE");
    }
    expect(continuityUnavailableReason(new ContinuityStoreError("m", undefined, "UNSUPPORTED_SCHEMA"))).toBe("UNSUPPORTED_SCHEMA");
  });
});
