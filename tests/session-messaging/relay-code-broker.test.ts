import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ entry: "" }));
vi.mock("../../mcp-server/src/relay-code-identity.js", async original => {
  const actual = await original<typeof import("../../mcp-server/src/relay-code-identity.js")>();
  return {...actual, readRelayCodeDigest: (entry: URL) => {
    expect(entry.pathname.endsWith("/session-message-relay.mjs")).toBe(true);
    return actual.readRelayCodeDigest(pathToFileURL(f.entry));
  }};
});
import { readRelayCodeDigest } from "../../mcp-server/src/relay-code-identity.js";
import { dispatchSessionMessageBrokerOperation } from "../../mcp-server/src/session-message-broker.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";

let directory: string | undefined;
let store: SessionMessageStore | undefined;
afterEach(() => { store?.close(); if (directory) rmSync(directory, {recursive: true, force: true}); });

it("reports a live legacy acquisition against currently installed entry bytes on each board query", () => {
  directory = mkdtempSync(path.join(os.tmpdir(), "ags-code-broker-"));
  f.entry = path.join(directory, "relay.mjs"); writeFileSync(f.entry, "old");
  const old = readRelayCodeDigest(new URL("file:///session-message-relay.mjs"));
  store = new SessionMessageStore(":memory:");
  const target = {host: "portable", sessionId: "broker-code"};
  store.startPresence({...target, instanceId: "legacy-instance", transport: "portable-queue", wakeVisibility: "user-message", canWakeSilently: false});
  const payload = {target, transport: "portable-queue", relayId: "legacy-owner", pid: 200, parentPid: 100, codeDigest: old};
  expect(dispatchSessionMessageBrokerOperation(store, "acquire-relay", payload)).toEqual({acquired: true});
  const listed = () => dispatchSessionMessageBrokerOperation(store!, "list-presence", {targets: [target]}) as {sessions: Array<{relayCode: {status: string; runningDigest: string | null}}>};
  expect(listed().sessions[0]!.relayCode.status).toBe("current");
  const owner = store.relayOwner(target, "portable-queue");
  writeFileSync(f.entry, "new");
  expect(listed().sessions[0]!.relayCode).toMatchObject({status: "outdated", runningDigest: old});
  expect(store.relayOwner(target, "portable-queue")).toEqual(owner);
  expect(() => dispatchSessionMessageBrokerOperation(store!, "acquire-relay", {...payload, codeDigest: "bad"})).toThrow("Invalid relay code digest");
  expect(store.relayOwner(target, "portable-queue")).toEqual(owner);
});
