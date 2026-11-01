import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ entry: "" }));
// The operation table names the relay entry installed beside it; the fixture points that entry at a temp file.
vi.mock("../../mcp-server/src/relay-code-identity.js", async original => {
  const actual = await original<typeof import("../../mcp-server/src/relay-code-identity.js")>();
  return {...actual, readRelayCodeDigest: (entry: URL) => {
    expect(entry.pathname.endsWith("/session-message-relay.mjs")).toBe(true);
    return actual.readRelayCodeDigest(pathToFileURL(f.entry));
  }};
});
import { readRelayCodeDigest } from "../../mcp-server/src/relay-code-identity.js";
import { dispatchSessionMessageOperation } from "../../mcp-server/src/session-message-operations.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";

// D0348 (docs/ags30-broker-redesign.md 3.6): a relay granted to other installed code is replaced once at a boundary,
// and the replaced relay is fenced by its relay_id. Time advances only through the injected clock.
const RELAY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const target = {host: "portable", sessionId: "relay-code-replacement"};
const transport = "codex-queue";
let directory: string | undefined;
let store: SessionMessageStore | undefined;
afterEach(() => { store?.close(); store = undefined; if (directory) rmSync(directory, {recursive: true, force: true}); directory = undefined; });

function fixture() {
  directory = mkdtempSync(path.join(os.tmpdir(), "ags-code-replacement-"));
  f.entry = path.join(directory, "relay.mjs");
  const clock = {now: Date.UTC(2026, 0, 1)};
  const opened = new SessionMessageStore(path.join(directory, "session-messages.sqlite3"), {clock: () => clock.now});
  store = opened;
  const op = <T>(operation: string, payload: Record<string, unknown>) => dispatchSessionMessageOperation(opened, operation, payload) as T;
  const installed = (bytes: string) => { writeFileSync(f.entry, bytes); return readRelayCodeDigest(new URL("file:///session-message-relay.mjs"))!; };
  const tick = (relayId: string, hostStart?: string) => op<{alive: boolean; count: number; hostBound: boolean}>("relay-tick",
    {target, transport, relayId, instanceId: "I1", includePending: false, ...(hostStart ? {hostStart} : {})});
  const relayCode = () => op<{sessions: Array<{relayCode: {status: string; runningDigest: string | null; expectedDigest: string | null}}>}>(
    "list-presence", {targets: [target]}).sessions[0]!.relayCode;
  return {clock, op, installed, tick, relayCode};
}

it("replaces a live relay of other installed code once at a boundary and fences the old relay", () => {
  const {clock, op, installed, tick, relayCode} = fixture();
  const old = installed("old");
  const started = op<{relayId: string}>("presence-start", {target, instanceId: "I1", transport, hostPid: 4242, codeDigest: old,
    wakeVisibility: "user-message", canWakeSilently: false, supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message"});
  expect(started.relayId).toMatch(RELAY_ID);
  const first = started.relayId;
  expect(tick(first, "4242-start")).toEqual({alive: true, count: 0, hostBound: true});
  expect(relayCode()).toEqual({status: "current", runningDigest: old, expectedDigest: old});

  const fresh = installed("new");
  expect(relayCode()).toEqual({status: "outdated", runningDigest: old, expectedDigest: fresh});
  // A boundary hook of the new installation learns that its generation runs other code; only the reported host is named.
  clock.now += 1000;
  expect(op<{relayRecovery?: unknown}>("claim-deferred", {target, codeDigest: fresh}).relayRecovery)
    .toEqual({instanceId: "I1", hostPid: 4242, replace: true});
  // Inside the start grace of the current grant the replacement is refused: at most one replacement per grace.
  expect(op("grant-relay", {target, transport, instanceId: "I1", hostPid: 4242})).toEqual({relayId: null, reason: "RELAY_ALIVE"});
  for (const step of [10_000, 10_000, 11_000]) { clock.now += step; expect(tick(first).alive).toBe(true); }

  const replaced = op<{relayId: string}>("grant-relay", {target, transport, instanceId: "I1", hostPid: 4242});
  expect(replaced.relayId).toMatch(RELAY_ID);
  expect(replaced.relayId).not.toBe(first);
  // The replaced relay's next tick is fenced; the new relay renews and keeps the bound host birth.
  expect(tick(first)).toEqual({alive: false, count: 0, hostBound: false});
  expect(tick(replaced.relayId, "4242-start")).toEqual({alive: true, count: 0, hostBound: true});
  expect(relayCode()).toEqual({status: "current", runningDigest: fresh, expectedDigest: fresh});
  expect(op("grant-relay", {target, transport, instanceId: "I1", hostPid: 4242})).toEqual({relayId: null, reason: "RELAY_ALIVE"});
  expect(op<{relayRecovery?: unknown}>("claim-deferred", {target, codeDigest: fresh}).relayRecovery).toBeUndefined();
  // The old relay's late release removes nothing of the replacement and does not end the generation.
  expect(op("release-relay", {target, transport, relayId: first, instanceId: "I1", reason: "relay-ended"})).toEqual({released: false});
  expect(op<{presence: {state: string; instanceId: string}}>("presence", {target}).presence).toMatchObject({state: "online", instanceId: "I1"});
  expect(tick(replaced.relayId).alive).toBe(true);
});

it("rejects a malformed code digest without changing the lease", () => {
  const {op, installed, relayCode} = fixture();
  const code = installed("code");
  const started = op<{relayId: string}>("presence-start", {target, instanceId: "I1", transport, hostPid: 4242, codeDigest: code,
    wakeVisibility: "user-message", canWakeSilently: false, supportedInjection: ["peer-wake"], idleWake: "user-message"});
  const before = store!.liveRelay(target, transport);
  expect(before).toMatchObject({relayId: started.relayId, instanceId: "I1", codeDigest: code});
  expect(() => op("grant-relay", {target, transport, instanceId: "I1", hostPid: 4242, codeDigest: "bad"})).toThrow("Invalid relay code digest");
  expect(() => op("claim-deferred", {target, codeDigest: "bad"})).toThrow("Invalid relay code digest");
  expect(store!.liveRelay(target, transport)).toEqual(before);
  expect(relayCode().status).toBe("current");
});
