import { describe, expect, it } from "vitest";
import {
  failureCode, failureContext, failureReason, retainCleanupFailure, tagProducerFailure,
} from "../../runtime/failure-diagnostics.mjs";
import { retainCleanupFailure as legacyRetainCleanupFailure } from "../../runtime/unified-state/shared-connection.mjs";

// AGS 3.0 error model P4: one shared cause classification instead of per-hook copies.
const withCode = (code, extra = {}) => Object.assign(new Error("private /secret/path token=SECRET"), { code, ...extra });

describe("failureCode", () => {
  it("returns only a bounded own code data property", () => {
    expect(failureCode(withCode("EACCES"))).toBe("EACCES");
    expect(failureCode(withCode("ERR_SQLITE_ERROR"))).toBe("ERR_SQLITE_ERROR");
    expect(failureCode(withCode("lowercase"))).toBeNull();
    expect(failureCode(withCode("A".repeat(65)))).toBeNull();
    expect(failureCode(withCode(5))).toBeNull();
    expect(failureCode(new Proxy(withCode("EACCES"), {}))).toBeNull();
    const accessor = new Error("x");
    Object.defineProperty(accessor, "code", { get() { throw new Error("must not run"); } });
    expect(failureCode(accessor)).toBeNull();
    expect(failureCode(null)).toBeNull();
    expect(failureCode("EACCES")).toBeNull();
  });
});

describe("failureReason", () => {
  it("classifies observed OS, SQLite and JSON causes with a fixed vocabulary", () => {
    expect(failureReason(withCode("EACCES"))).toEqual({ reason: "EACCES", basis: "unverified-observation" });
    expect(failureReason(withCode("EISDIR"))).toEqual({ reason: "EISDIR", basis: "unverified-observation" });
    expect(failureReason(withCode("ERR_SQLITE_ERROR", { errcode: 5 }))).toEqual({ reason: "STORE_BUSY", basis: "unverified-observation" });
    expect(failureReason(withCode("ERR_SQLITE_ERROR", { errcode: 11 | (1 << 8) })).reason).toBe("STORE_CORRUPT");
    expect(failureReason(withCode("ERR_SQLITE_ERROR", { errcode: 1 })).reason).toBe("STORE_ERROR");
    let syntax;
    try { JSON.parse("{"); } catch (error) { syntax = error; }
    expect(failureReason(syntax)).toEqual({ reason: "INVALID_JSON", basis: "unverified-observation" });
  });

  it("falls back to the producer reason, then to unknown, never to message text", () => {
    expect(failureReason(tagProducerFailure(new Error("x"), "TRUST_STORAGE_FAILED"))).toEqual({ reason: "TRUST_STORAGE_FAILED", basis: "producer" });
    expect(failureReason(withCode("NOT_AN_OS_CODE"))).toEqual({ reason: null, basis: "unknown" });
    expect(failureReason(new Error("EACCES"))).toEqual({ reason: null, basis: "unknown" });
    expect(failureReason(new Proxy(withCode("EACCES"), {}))).toEqual({ reason: null, basis: "unknown" });
  });
});

describe("retainCleanupFailure", () => {
  it("keeps the primary and attaches the cleanup failure as a tagged secondary", () => {
    const primary = withCode("EIO");
    const cleanup = new Error("rollback failed");
    expect(retainCleanupFailure(primary, "TRANSACTION_ROLLBACK_FAILED", () => { throw cleanup; })).toBe(false);
    expect(retainCleanupFailure(primary, "UNUSED", () => {})).toBe(true);
    expect(failureContext(primary).secondary).toEqual([expect.objectContaining({ producerReason: "TRANSACTION_ROLLBACK_FAILED" })]);
    expect(legacyRetainCleanupFailure).toBe(retainCleanupFailure);
  });
});
