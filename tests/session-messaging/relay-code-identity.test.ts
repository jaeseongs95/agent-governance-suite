import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import { readRelayCodeDigest } from "../../mcp-server/src/relay-code-identity.js";

const A = "sha256:" + "a".repeat(64), B = "sha256:" + "b".repeat(64);
const now = Date.UTC(2026, 0, 1);
const stores: SessionMessageStore[] = [];
const directories: string[] = [];
const directory = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "ags-relay-code-")); directories.push(dir); return dir; };
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, {recursive: true, force: true}); });

// Code identity belongs to the grant (docs/archive/ags30-broker-redesign.md 3.6): the board compares the current holder's
// grant digest with the installed relay entry. Times are explicit fixture times.
function fixture(database = ":memory:") {
  const store = new SessionMessageStore(database); stores.push(store);
  const input = { host: "portable", sessionId: "code-fixture", instanceId: "I1", transport: "portable-queue",
    wakeVisibility: "user-message" as const, canWakeSilently: false,
    deliveryCapabilities: { supportedInjection: ["peer-wake" as const], idleWake: "user-message" as const }, hostPid: 100 };
  store.startPresence(input, now);
  const grant = (codeDigest: string | null, at = now + 1, instanceId = input.instanceId) =>
    store.grantRelay({ host: input.host, sessionId: input.sessionId, transport: input.transport, instanceId, codeDigest, hostPid: 100 }, at);
  const tick = (relayId: string, at: number, instanceId = input.instanceId) =>
    store.relayTick({ host: input.host, sessionId: input.sessionId, transport: input.transport, relayId, instanceId, includePending: false }, at);
  const view = (expected: string | null, at = now + 4) => store.listPresence(at, [input], expected)[0]!;
  return {store, input, grant, tick, view};
}

it("marks a live old relay outdated without replacing or renewing it inside its start grace", () => {
  const f = fixture(); const granted = f.grant(A); expect(granted.relayId).toEqual(expect.any(String));
  expect(f.tick(granted.relayId!, now + 2).alive).toBe(true);
  expect(f.view(A).relayCode).toEqual({status: "current", runningDigest: A, expectedDigest: A});
  const presence = f.store.presence(f.input, now + 4), lease = f.store.liveRelay(f.input, f.input.transport, now + 4);
  expect(f.view(B).relayCode).toEqual({status: "outdated", runningDigest: A, expectedDigest: B});
  // A grant for other code inside the start grace is refused and changes nothing.
  expect(f.grant(B, now + 5)).toEqual({relayId: null, reason: "RELAY_ALIVE"});
  expect(f.store.presence(f.input, now + 4)).toEqual(presence);
  expect(f.store.liveRelay(f.input, f.input.transport, now + 4)).toEqual(lease);
  // Same code never replaces a live lease, even after the grace.
  expect(f.tick(granted.relayId!, now + 12_000).alive).toBe(true);
  expect(f.tick(granted.relayId!, now + 24_000).alive).toBe(true);
  expect(f.tick(granted.relayId!, now + 31_000).alive).toBe(true);
  expect(f.grant(A, now + 31_001)).toEqual({relayId: null, reason: "RELAY_ALIVE"});
  // Other code after the grace replaces it once; the old holder is fenced.
  const replaced = f.grant(B, now + 31_002);
  expect(replaced.relayId).toEqual(expect.any(String));
  expect(replaced.relayId).not.toBe(granted.relayId);
  expect(f.tick(granted.relayId!, now + 31_003).alive).toBe(false);
  expect(f.view(B, now + 31_004).relayCode).toEqual({status: "current", runningDigest: B, expectedDigest: B});
  expect(f.grant(B, now + 31_005)).toEqual({relayId: null, reason: "RELAY_ALIVE"});
});

it("does not infer current code from a grant without a digest or without an expected digest", () => {
  const f = fixture(); const granted = f.grant(null);
  expect(f.tick(granted.relayId!, now + 2).alive).toBe(true);
  expect(f.view(B).relayCode).toEqual({status: "unknown", runningDigest: null, expectedDigest: B});
  const coded = fixture(); coded.grant(A);
  expect(coded.view(null).relayCode).toEqual({status: "unknown", runningDigest: A, expectedDigest: null});
});

it("does not attribute the old generation's lease code to a new generation", () => {
  const f = fixture(); const old = f.grant(A); f.tick(old.relayId!, now + 2);
  f.store.startPresence({...f.input, instanceId: "I2"}, now + 5);
  // The live lease still names I1: the board reports no running code for I2, and I1's relay is fenced.
  expect(f.store.listPresence(now + 6, [f.input], A)[0]!.relayCode).toEqual({status: "unknown", runningDigest: null, expectedDigest: A});
  expect(f.tick(old.relayId!, now + 6).alive).toBe(false);
  const newer = f.grant(B, now + 7, "I2");
  expect(newer.relayId).toEqual(expect.any(String));
  expect(f.store.listPresence(now + 8, [f.input], B)[0]!.relayCode).toEqual({status: "current", runningDigest: B, expectedDigest: B});
});

it("keeps the grant's digest when another connection lists the same file", () => {
  const dbPath = path.join(directory(), "code.sqlite3");
  const f = fixture(dbPath); f.grant(A);
  const second = new SessionMessageStore(dbPath); stores.push(second);
  expect(second.listPresence(now + 4, [f.input], A)[0]!.relayCode).toEqual({status: "current", runningDigest: A, expectedDigest: A});
  expect(second.liveRelay(f.input, f.input.transport, now + 4)?.codeDigest).toBe(A);
});

it("observes entry bytes rather than a version label and preserves an earlier snapshot after overwrite", () => {
  const entry = path.join(directory(), "relay.mjs"), url = pathToFileURL(entry);
  expect(readRelayCodeDigest(url)).toBeNull();
  writeFileSync(entry, "old-code"); const startup = readRelayCodeDigest(url);
  writeFileSync(entry, "new-code"); const expected = readRelayCodeDigest(url);
  expect(startup).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(expected).not.toBe(startup);
  expect(readFileSync(entry, "utf8")).toBe("new-code");
});
