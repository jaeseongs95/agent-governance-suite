import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../mcp-server/src/convergence-logic.js";
import { TrustStore } from "../../mcp-server/src/trust-store.js";
import { createInactiveSharedStores } from "../../mcp-server/src/inactive-shared-stores.js";
import { createWakeHookObservationReader } from "../../mcp-server/src/session-message-wake-port.js";
import type { InputSourceReceiptV1 } from "../../contracts/types.js";
import type { InputObservation } from "../../mcp-server/src/input-observation.js";

const target = { host: "synthetic-host", sessionId: "synthetic-session" };
const observation: InputObservation = { ...target, kind: "user-input", wakeOnly: true,
  wakeCandidates: ["synthetic-nonce-abcdefghijklmnop"], actor: { kind: "unknown", assurance: "unknown", observedBy: "synthetic-host:hook-payload" } };
const key = Buffer.alloc(32, 31);
const contentDigest = `sha256:${createHash("sha256").update(JSON.stringify([target.host, target.sessionId,
  "user-input", true, "unknown", "synthetic-host:hook-payload", "unknown", observation.wakeCandidates])).digest("hex")}` as const;
const unsigned = { schemaVersion: "1.0.0" as const, receiptId: "source-synthetic-readonly", originKind: "peer" as const,
  ...target, eventId: "synthetic-event", contentDigest, observedAt: new Date(100).toISOString(), expiresAt: new Date(1000).toISOString(),
  authorityEffect: "none" as const, attestation: { kind: "broker-peer-envelope" as const, adapter: "session-message-wake-hook", capabilityVersion: "1.0.0" } };
const receipt: InputSourceReceiptV1 = { ...unsigned, integrityToken: createHmac("sha256", key).update(canonicalJson(unsigned, "Synthetic receipt")).digest("base64url") };
const directories: string[] = [];
const resources = new Set<{ close(): void }>();
function directory() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "ags-wake-reader-readonly-")); directories.push(value); return value; }
afterEach(() => {
  for (const resource of resources) resource.close(); resources.clear();
  for (const value of directories.splice(0)) {
    expect(path.dirname(path.resolve(value))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(value)).toMatch(/^ags-wake-reader-readonly-/u); fs.rmSync(value, { recursive: true });
  }
});
function writeReceipt(filename: string) {
  const db = new DatabaseSync(filename);
  try { db.prepare(`INSERT INTO input_source_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(receipt.receiptId, target.host, target.sessionId, receipt.eventId, receipt.originKind,
      receipt.authorityEffect, receipt.observedAt, receipt.expiresAt, JSON.stringify(receipt)); } finally { db.close(); }
}
function standalone() {
  const filename = path.join(directory(), "trust.sqlite3"); const trust = new TrustStore(filename, key.toString("base64url"));
  resources.add(trust); writeReceipt(filename); return { filename, trust };
}
function shared() {
  const value = createInactiveSharedStores({ directory: directory(), mode: "fixture-only", clock: () => 100,
    syntheticKeys: { trust: key.toString("base64url"), workflow: Buffer.alloc(32, 32).toString("base64url"), continuity: Buffer.alloc(32, 33).toString("base64url") } });
  resources.add(value.owner); writeReceipt(value.owner.databasePath); return { ...value, filename: value.owner.databasePath };
}
function change(filename: string, sql: string) { const db = new DatabaseSync(filename); try { db.exec(sql); } finally { db.close(); } }
function authority(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { return { keyCount: db.prepare("SELECT count(*) AS n FROM trust_metadata").get()!.n,
    version: db.prepare("PRAGMA user_version").get()!.user_version,
    digest: createHash("sha256").update(JSON.stringify([db.prepare("SELECT * FROM trust_metadata ORDER BY key").all(),
      db.prepare("SELECT * FROM input_source_receipts ORDER BY receipt_id").all(), db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()])).digest("hex") }; }
  finally { db.close(); }
}
const verify = (filename: string, now = 200) => createWakeHookObservationReader(filename).verifyObservation(target, observation, receipt.receiptId, now);

describe("live wake existing-receipt readonly boundary", () => {
  it("R3-READ-01: missing key returns false without creating a replacement signing key", () => {
    const f = standalone(); f.trust.close(); change(f.filename, "DELETE FROM trust_metadata"); const before = authority(f.filename);
    expect(verify(f.filename)).toBe(false); expect(authority(f.filename)).toEqual(before); expect(before.keyCount).toBe(0);
  });
  it("R3-READ-02: newer schema returns false without throwing or migrating", () => {
    const f = standalone(); f.trust.close(); change(f.filename, "PRAGMA user_version=99"); const before = authority(f.filename);
    expect(verify(f.filename)).toBe(false); expect(authority(f.filename)).toEqual(before);
  });
  it.each([false, true])("R3-READ-03: standalone closed=%s preserves valid HMAC and readonly authority", closed => {
    const f = standalone(); if (closed) f.trust.close(); const before = authority(f.filename);
    expect(verify(f.filename)).toBe(true); expect(authority(f.filename)).toEqual(before);
  });
  it.each([false, true])("R3-READ-04: shared committed closed=%s remains readable", closed => {
    const f = shared(); if (closed) f.owner.close(); const before = authority(f.filename);
    expect(verify(f.filename)).toBe(true); expect(authority(f.filename)).toEqual(before);
  });
  it("R3-READ-05: shared provisional receipt is visible only to injected same-connection reader", () => {
    const f = shared(); const provisionalId = "source-synthetic-provisional";
    expect(() => f.owner.transaction(() => {
      const unsignedProvisional = { ...unsigned, receiptId: provisionalId, eventId: "synthetic-provisional" };
      const sealed = { ...unsignedProvisional, integrityToken: createHmac("sha256", key).update(canonicalJson(unsignedProvisional, "Synthetic receipt")).digest("base64url") };
      f.owner.borrow("trust").database.prepare("INSERT INTO input_source_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(provisionalId,
        target.host, target.sessionId, sealed.eventId, sealed.originKind, sealed.authorityEffect, sealed.observedAt, sealed.expiresAt, JSON.stringify(sealed));
      expect(f.wakeReader.verifyObservation(target, observation, provisionalId, 200)).toBe(true);
      expect(createWakeHookObservationReader(f.filename).verifyObservation(target, observation, provisionalId, 200)).toBe(false);
      throw new Error("synthetic rollback");
    })).toThrow("synthetic rollback");
    expect(f.trust.getInputSource(provisionalId)).toBeNull();
  });
  it("R3-READ-06: absent DB returns false without creating a file", () => {
    const filename = path.join(directory(), "missing.sqlite3"); expect(verify(filename)).toBe(false); expect(fs.readdirSync(path.dirname(filename))).toEqual([]);
  });
  it("R3-READ-07: tampered HMAC receipt is rejected without rewriting", () => {
    const f = standalone(); f.trust.close(); change(f.filename, "UPDATE input_source_receipts SET receipt_json=json_set(receipt_json, '$.contentDigest', 'sha256:tampered')");
    const before = authority(f.filename); expect(verify(f.filename)).toBe(false); expect(authority(f.filename)).toEqual(before);
  });
  it("R3-READ-08: injected callback exceptions remain observable", () => {
    const error = new Error("synthetic callback failure"); const reader = createWakeHookObservationReader({ readVerifiedInputSource() { throw error; } });
    expect(() => reader.verifyObservation(target, observation, receipt.receiptId, 200)).toThrow(error);
  });
  it("R3-READ-09: existing target, authority, digest and time predicates stay unchanged", () => {
    const f = standalone(); const reader = createWakeHookObservationReader(f.filename);
    expect(verify(f.filename, 99)).toBe(false); expect(verify(f.filename, 1000)).toBe(false);
    expect(reader.verifyObservation({ ...target, sessionId: "other" }, observation, receipt.receiptId, 200)).toBe(false);
    expect(reader.verifyObservation(target, { ...observation, wakeCandidates: ["synthetic-other-abcdefghijklmnop"] }, receipt.receiptId, 200)).toBe(false);
    const altered = { ...receipt, authorityEffect: "approval" } as unknown as InputSourceReceiptV1;
    expect(createWakeHookObservationReader({ readVerifiedInputSource: () => altered }).verifyObservation(target, observation, receipt.receiptId, 200)).toBe(false);
  });
});
