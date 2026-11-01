import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostWatch } from "../../mcp-server/src/host-process-watch.js";
import type { sessionMessageRequest } from "../../mcp-server/src/session-message-client.js";
import { dispatchSessionMessageOperation } from "../../mcp-server/src/session-message-operations.js";
import { runSessionMessageRelay } from "../../mcp-server/src/session-message-relay.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import type { WakeDispatchPort } from "../../mcp-server/src/session-message-wake-port.js";
import { codexLaunchPrerequisite, codexQueueWakePort } from "../../mcp-server/src/wake-transport-codex.js";

// Real-host matrix (27d29452, Linux, no codex on PATH): send reported autoWake available (relay-live) and only the
// first dispatch failed with CODEX_EXECUTABLE_MISSING. The relay now tells the missing launcher before any wake.
const directories: string[] = [];
const stores: SessionMessageStore[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const store of stores.splice(0)) if (store.database.isOpen) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory(): string {
  const value = mkdtempSync(path.join(tmpdir(), "ags-codex-prerequisite-"));
  directories.push(value);
  return value;
}

describe("codexLaunchPrerequisite", () => {
  it("reports CODEX_EXECUTABLE_MISSING when no PATH entry holds codex, and nothing once one does", () => {
    const empty = directory(), installed = directory();
    // execFile resolves codex.com/codex.exe on Windows (never a .cmd shim) and an executable `codex` elsewhere.
    const executable = path.join(installed, process.platform === "win32" ? "codex.exe" : "codex");
    writeFileSync(executable, "");
    if (process.platform !== "win32") chmodSync(executable, 0o755);
    const pathOf = (...entries: string[]) => ({ PATH: entries.join(path.delimiter) });
    expect(codexLaunchPrerequisite(pathOf(empty))).toBe("CODEX_EXECUTABLE_MISSING");
    expect(codexLaunchPrerequisite(pathOf(empty, installed))).toBeNull();
    expect(codexQueueWakePort.prerequisite?.(pathOf(empty))).toBe("CODEX_EXECUTABLE_MISSING");
    // Without PATH the system default search applies; nothing is claimed missing.
    expect(codexLaunchPrerequisite({})).toBeNull();
  });

  it.runIf(process.platform === "win32")("does not count a codex.cmd shim, which execFile cannot start", () => {
    const shim = directory();
    writeFileSync(path.join(shim, "codex.cmd"), "");
    writeFileSync(path.join(shim, "codex"), "");
    expect(codexLaunchPrerequisite({ PATH: shim })).toBe("CODEX_EXECUTABLE_MISSING");
  });

  it.runIf(process.platform !== "win32")("does not count a codex file without execute permission", () => {
    const plain = directory();
    writeFileSync(path.join(plain, "codex"), "");
    chmodSync(path.join(plain, "codex"), 0o644);
    expect(codexLaunchPrerequisite({ PATH: plain })).toBe("CODEX_EXECUTABLE_MISSING");
  });
});

describe("a relay whose port knows a missing prerequisite", () => {
  const T0 = Date.parse("2026-11-02T00:00:00.000Z");
  const target = { host: "portable", sessionId: "prerequisite-recipient" };
  const sender = { host: "portable", sessionId: "prerequisite-sender" };
  const transport = "portable";
  const capabilities = { supportedInjection: ["peer-wake" as const], idleWake: "silent" as const };

  it("records it on the birth at its first tick, so send reports a degraded wake and the birth is never rung", async () => {
    const store = new SessionMessageStore(path.join(directory(), "session-messages.sqlite3"), { clock: () => T0 });
    stores.push(store);
    store.startPresence({ ...target, instanceId: "birth-1", transport, wakeVisibility: "silent", canWakeSilently: true, deliveryCapabilities: capabilities, hostPid: 4242 });
    const relayId = store.grantRelay({ ...target, transport, instanceId: "birth-1", codeDigest: null, hostPid: 4242 }).relayId!;
    // Before the fix a granted relay reads as available (relay-live).
    expect(store.autoWakeOutlook(target)).toMatchObject({ state: "available", reason: "relay-live" });
    const payloads: Array<[string, Record<string, unknown>]> = [];
    const request = (async (operation: string, payload: Record<string, unknown>) => {
      payloads.push([operation, payload]);
      return dispatchSessionMessageOperation(store, operation, payload);
    }) as typeof sessionMessageRequest;
    const delays: Array<() => void> = [];
    const delay = (_milliseconds: number, stop: Promise<void>) => Promise.race([new Promise<void>(resolve => { delays.push(resolve); }), stop]);
    let exit!: (reason: string) => void;
    const watch = (): HostWatch => ({ bound: Promise.resolve("prerequisite-host-start"), exited: new Promise<string>(resolve => { exit = resolve; }), close: () => {} });
    const dispatch = vi.fn();
    const port: WakeDispatchPort = { capabilities, resendBaseMs: 600_000, dispatch, prerequisite: () => "CODEX_EXECUTABLE_MISSING" };
    const settle = () => new Promise<void>(resolve => setImmediate(resolve));
    const relay = runSessionMessageRelay({ ...target, instanceId: "birth-1", transport, parentPid: 4242, relayId }, port, { request, watch, delay });
    try {
      await settle();
      expect(payloads[0]).toEqual(["relay-tick", expect.objectContaining({ prerequisiteMissing: "CODEX_EXECUTABLE_MISSING" })]);
      store.send({ sender, target, messageId: "prerequisite-body", body: "body" });
      // The send receipt's autoWake is this outlook (submitPrepared).
      expect(store.autoWakeOutlook(target)).toMatchObject({ state: "degraded", reason: "wake-prerequisite-missing", basisAt: new Date(T0).toISOString() });
      // The next tick sees a pending body and a bound host; the path refuses the reservation, so nothing is dispatched.
      delays.shift()?.(); await settle();
      expect(payloads.filter(([operation]) => operation === "relay-tick")).toHaveLength(2);
      expect(payloads[1]![1]).not.toHaveProperty("prerequisiteMissing");
      expect(payloads.map(([operation]) => operation)).toEqual(["relay-tick", "relay-tick", "reserve-wake"]);
      expect(dispatch).not.toHaveBeenCalled();
      expect(store.reserveManagedWake({ ...target, nonce: "prerequisite-nonce-abcdefghijklmnop", instanceId: "birth-1", relayId, transport, resume: true }).dispatch).toBe(false);
    } finally {
      exit?.("HOST_PROCESS_ENDED");
      await relay;
    }
  });

  it("refuses a prerequisite that is not a reason code", () => {
    const store = new SessionMessageStore(path.join(directory(), "session-messages.sqlite3"), { clock: () => T0 });
    stores.push(store);
    store.startPresence({ ...target, instanceId: "birth-1", transport, wakeVisibility: "silent", canWakeSilently: true, deliveryCapabilities: capabilities, hostPid: 4242 });
    const relayId = store.grantRelay({ ...target, transport, instanceId: "birth-1", codeDigest: null, hostPid: 4242 }).relayId!;
    expect(() => dispatchSessionMessageOperation(store, "relay-tick", { target, transport, relayId, instanceId: "birth-1", includePending: false,
      prerequisiteMissing: "spawn codex ENOENT /home/user/.local/bin" })).toThrow("Invalid relay tick identity or includePending.");
    expect(store.autoWakeOutlook(target)).toMatchObject({ state: "available" });
  });
});
