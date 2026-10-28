import path from "node:path";
import {createHash} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const f = vi.hoisted(() => ({
  fd: 0, offset: 0, content: Buffer.alloc(0), readFailure: undefined as unknown, closeFailure: undefined as unknown,
  openFailure: undefined as unknown, reportedSize: undefined as number | undefined, chunkSize: 7, regular: true,
  stat: vi.fn(), open: vi.fn(), fstat: vi.fn(), read: vi.fn(), close: vi.fn(),
}));
vi.mock("node:fs", async original => ({
  ...await original<typeof import("node:fs")>(), statSync: f.stat, openSync: f.open, fstatSync: f.fstat, readSync: f.read, closeSync: (descriptor: number) => {
    f.close(descriptor);
    if (f.closeFailure !== undefined) throw f.closeFailure;
  },
}));
import "../../mcp-server/src/builtin-hook-host-adapters.js";
import {hostDeliveryProfile, registerHookHostAdapter} from "../../mcp-server/src/host-input-adapter.js";
import {runSessionMessageHook, sessionMessageTransport} from "../../mcp-server/src/session-message-hook.js";
import {hookFailureContext, hookFailureReason} from "../../mcp-server/src/hook-error-diagnostics.js";
import {producerFailure} from "../../mcp-server/src/failure-diagnostics.js";

const directory = path.resolve("PRIVATE_QUEUE_DIRECTORY");
const fileEnvironment = {PLUGIN_DATA: directory};
const automaticEnvironment = {...fileEnvironment, ANTIGRAVITY_AGENT: "1"};
const settings = (codex: boolean, gemini = codex) => Buffer.from(JSON.stringify({schemaVersion: "1.0.0", codex: {queueWake: codex}, gemini: {queueWake: gemini}}));
const ioError = (code: string) => Object.assign(new Error("PRIVATE_IO_MESSAGE"), {code});
function diagnosticRecord(spy: ReturnType<typeof vi.spyOn>) {
  expect(spy).toHaveBeenCalledTimes(1);
  const line = spy.mock.calls[0]![0] as string;
  expect(line).not.toContain("PRIVATE_"); expect(line).not.toContain(directory);
  return JSON.parse(line.slice(line.indexOf("{")));
}
function resetWitnesses() {
  f.offset = 0;
  for (const mock of [f.stat, f.open, f.fstat, f.read, f.close]) mock.mockClear();
}
beforeEach(() => {
  f.fd = 0; f.offset = 0; f.content = settings(true); f.readFailure = undefined; f.closeFailure = undefined;
  f.openFailure = undefined; f.reportedSize = undefined; f.chunkSize = 7; f.regular = true;
  for (const mock of [f.stat, f.open, f.fstat, f.read, f.close]) mock.mockReset();
  f.stat.mockReturnValue({isDirectory: () => true});
  f.open.mockImplementation(() => {if (f.openFailure !== undefined) throw f.openFailure; return f.fd;});
  f.fstat.mockImplementation(() => ({isFile: () => f.regular, size: f.reportedSize ?? f.content.length}));
  f.read.mockImplementation((descriptor: number, buffer: Buffer, offset: number, length: number) => {
    expect(descriptor).toBe(f.fd);
    if (f.readFailure !== undefined) throw f.readFailure;
    const count = Math.min(length, f.chunkSize, f.content.length - f.offset);
    f.content.copy(buffer, offset, f.offset, f.offset + count); f.offset += count; return count;
  });
  // Vitest mock internals inspect a thrown value; throw from the ordinary FS fixture boundary instead.
  f.close.mockImplementation((descriptor: number) => { expect(descriptor).toBe(f.fd); });
});
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllEnvs();});

describe("0188 actual bounded queue reader and diagnostic consumer", () => {
  it.each([
    ["codex", "AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "codex-queue", "codex-deferred"],
    ["gemini", "AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE", "gemini-queue", "gemini-deferred"],
  ] as const)("preserves %s explicit precedence and selected boolean with fd zero", (host, key, enabled, deferred) => {
    const observer = vi.fn();
    for (const [value, transport] of [["1", enabled], ["0", deferred], ["invalid", deferred]]) {
      observer.mockClear();
      expect(hostDeliveryProfile(host, {...automaticEnvironment, [key]: value}, observer, true).transport).toBe(transport);
      if (value === "invalid") expect(observer).toHaveBeenCalledExactlyOnceWith("invalid-environment");
      else expect(observer).not.toHaveBeenCalled();
    }
    expect(f.open).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
    for (const value of [false, true]) {
      resetWitnesses(); observer.mockClear(); f.content = settings(value);
      expect(hostDeliveryProfile(host, automaticEnvironment, observer, true).transport).toBe(value ? enabled : deferred);
      expect(observer).not.toHaveBeenCalled(); expect(f.open).toHaveBeenCalledTimes(1);
      expect(f.close).toHaveBeenCalledExactlyOnceWith(0); expect(f.read.mock.calls.length).toBeGreaterThan(1);
    }
    expect(automaticEnvironment).toEqual({PLUGIN_DATA: directory, ANTIGRAVITY_AGENT: "1"});
  });
  it("keeps absence/default and Claude decisions without closing an unacquired descriptor", () => {
    const observer = vi.fn();
    expect(hostDeliveryProfile("gemini", {}, observer, true).transport).toBe("gemini-queue");
    expect(hostDeliveryProfile("codex", {}, observer, true).transport).toBe("codex-deferred");
    expect(hostDeliveryProfile("claude-code", automaticEnvironment, observer, true).transport).toBe("claude-inbox");
    expect(f.open).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
    f.openFailure = ioError("ENOENT");
    expect(hostDeliveryProfile("gemini", automaticEnvironment, observer, true).transport).toBe("gemini-queue");
    expect(observer).not.toHaveBeenCalled(); expect(f.open).toHaveBeenCalledTimes(1); expect(f.close).not.toHaveBeenCalled();
  });
  it.each(["EIO", "ENOENT"] as const)("disables successful true settings after close %s and reports unknown cleanup", code => {
    f.closeFailure = ioError(code);
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(hostDeliveryProfile("gemini", automaticEnvironment, undefined, true).transport).toBe("gemini-deferred");
    expect(diagnosticRecord(sink)).toMatchObject({phase: "close", reason: "QUEUE_SETTINGS_CLOSE_FAILED", cleanup: "unknown",
      context: {producerReason: "QUEUE_SETTINGS_CLOSE_FAILED", producerCause: {type: "error"}}});
    expect(sink.mock.calls[0]![0]).toContain("queue settings: close-failed.");
    expect(f.open).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledExactlyOnceWith(0);
  });
  it.each(["EIO", "ENOENT"] as const)("keeps actual read %s primary and close secondary without retry or default promotion", code => {
    f.readFailure = ioError(code); f.closeFailure = ioError("EACCES");
    const observer = vi.fn();
    expect(hostDeliveryProfile("gemini", automaticEnvironment, observer, true).transport).toBe("gemini-deferred");
    expect(observer).toHaveBeenCalledTimes(1); expect(observer.mock.calls[0]![0]).toBe("read-failed");
    const observation = observer.mock.calls[0]![1];
    expect(observation).toMatchObject({phase: "read", cleanup: "unknown"});
    expect(Object.isFrozen(observation)).toBe(true);
    const failure = observation.failure;
    expect(hookFailureReason(failure)).toBe("QUEUE_SETTINGS_READ_FAILED");
    expect(hookFailureContext(failure)).toMatchObject({producerCause: {type: "error"}, secondary: [{
      producerReason: "QUEUE_SETTINGS_CLOSE_FAILED", producerCause: {type: "error"},
    }]});
    expect(JSON.stringify(hookFailureContext(failure))).not.toContain("PRIVATE_");
    expect(f.open).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("keeps a single read failure visible with normally completed close", () => {
    f.readFailure = ioError("EIO");
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(hostDeliveryProfile("gemini", automaticEnvironment, undefined, true).transport).toBe("gemini-deferred");
    expect(diagnosticRecord(sink)).toMatchObject({phase: "read", reason: "QUEUE_SETTINGS_READ_FAILED", cleanup: "closed",
      context: {producerCause: {code: {prefixSha256: createHash("sha256").update(Buffer.from("EIO", "utf16le")).digest("hex")}}}});
    expect(f.open).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("keeps actual read and close causes distinct through the default sink cleanup branch", () => {
    f.readFailure = ioError("EIO"); f.closeFailure = ioError("EACCES");
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(hostDeliveryProfile("gemini", automaticEnvironment, undefined, true).transport).toBe("gemini-deferred");
    const record = diagnosticRecord(sink);
    const codeHash = (code: string) => createHash("sha256").update(Buffer.from(code, "utf16le")).digest("hex");
    expect(record).toMatchObject({phase: "read", reason: "QUEUE_SETTINGS_READ_FAILED", cleanup: "unknown", context: {
      producerCause: {code: {prefixSha256: codeHash("EIO")}}, secondary: [{producerReason: "QUEUE_SETTINGS_CLOSE_FAILED",
        producerCause: {code: {prefixSha256: codeHash("EACCES")}}}],
    }});
    expect(f.open).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("preserves legacy read ENOENT/default only after a normally completed close", () => {
    f.readFailure = ioError("ENOENT");
    const observer = vi.fn();
    expect(hostDeliveryProfile("gemini", automaticEnvironment, observer, true).transport).toBe("gemini-queue");
    expect(observer).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("reports actual open failure without inventing read, close or acquired cleanup", () => {
    f.openFailure = ioError("EACCES");
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(hostDeliveryProfile("gemini", automaticEnvironment, undefined, true).transport).toBe("gemini-deferred");
    expect(diagnosticRecord(sink)).toMatchObject({phase: "open", reason: "QUEUE_SETTINGS_OPEN_FAILED", cleanup: "not-acquired"});
    expect(f.close).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["invalid-settings", "too-large", "invalid-file-type"] as const)("keeps %s as one issue when close also fails", issue => {
    if (issue === "invalid-settings") f.content = Buffer.from("PRIVATE_MALFORMED_SETTINGS");
    if (issue === "too-large") f.reportedSize = 4097;
    if (issue === "invalid-file-type") f.regular = false;
    f.closeFailure = ioError("EIO");
    const observer = vi.fn();
    expect(hostDeliveryProfile("gemini", automaticEnvironment, observer, true).transport).toBe("gemini-deferred");
    expect(observer).toHaveBeenCalledTimes(1); expect(observer.mock.calls[0]![0]).toBe(issue);
    expect(observer.mock.calls[0]![1]).toMatchObject({phase: "close", cleanup: "unknown"});
    expect(hookFailureReason(observer.mock.calls[0]![1].failure)).toBe("QUEUE_SETTINGS_CLOSE_FAILED");
    expect(f.close).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("keeps inclusive byte limit, detects growth, and never bypasses close on short reads", () => {
    const normal = settings(true);
    f.content = Buffer.concat([normal, Buffer.alloc(4096 - normal.length, 32)]);
    const observer = vi.fn();
    expect(hostDeliveryProfile("gemini", automaticEnvironment, observer, true).transport).toBe("gemini-queue");
    expect(observer).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(0);
    resetWitnesses(); f.reportedSize = 0; f.content = Buffer.concat([f.content, Buffer.from(" ")]);
    expect(hostDeliveryProfile("gemini", automaticEnvironment, observer, true).transport).toBe("gemini-deferred");
    expect(observer).toHaveBeenCalledExactlyOnceWith("too-large"); expect(f.close).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("keeps a Proxy close cause opaque and never retries or invokes its traps", () => {
    const trap = vi.fn(() => {throw new Error("PRIVATE_PROXY");});
    f.closeFailure = new Proxy({}, {getPrototypeOf: trap, getOwnPropertyDescriptor: trap});
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(hostDeliveryProfile("gemini", automaticEnvironment, undefined, true).transport).toBe("gemini-deferred");
    expect(diagnosticRecord(sink)).toMatchObject({phase: "close", cleanup: "unknown", context: {producerCause: {opaque: "proxy"}}});
    expect(trap).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("uses actual hook entry, shared reader and existing safe sink without broker I/O", async () => {
    f.closeFailure = ioError("ENOENT");
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(sessionMessageTransport("gemini", automaticEnvironment, true)).toBe("gemini-deferred");
    resetWitnesses(); sink.mockClear();
    vi.stubEnv("PLUGIN_DATA", directory); vi.stubEnv("ANTIGRAVITY_AGENT", "1"); vi.stubEnv("AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE", undefined);
    const input = JSON.stringify({hook_event_name: "PreToolUse", session_id: "PRIVATE_SYNTHETIC_SESSION", agent_id: "", tool_name: "read_file", tool_input: {}});
    expect(await runSessionMessageHook("gemini", input, undefined, {defaultQueueWake: true})).toBe("");
    expect(diagnosticRecord(sink)).toMatchObject({phase: "close", reason: "QUEUE_SETTINGS_CLOSE_FAILED", cleanup: "unknown"});
    expect(f.open).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("does not tag a validation observer exception as an I/O producer failure", () => {
    f.stat.mockReturnValueOnce({isDirectory: () => false});
    const external = new Error("PRIVATE_OBSERVER");
    const observer = vi.fn(() => {throw external;});
    let failure: unknown;
    try {hostDeliveryProfile("gemini", automaticEnvironment, observer, true);} catch (error) {failure = error;}
    expect(failure).toBe(external); expect(hookFailureReason(failure)).toBeNull();
    expect(observer).toHaveBeenCalledExactlyOnceWith("invalid-plugin-data");
    expect(f.open).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });
  it("accepts another adapter producer phase without builtin reason names or state inference", () => {
    registerHookHostAdapter("0188-other-producer", {deliveryProfile: (_environment, diagnose) => {
      diagnose("unavailable", {phase: "adapter-probe", cleanup: "unknown",
        failure: producerFailure("ADAPTER_SETTINGS_UNAVAILABLE", "Fixed adapter failure.")});
      return {transport: "claude-inbox", capabilities: {supportedInjection: [], idleWake: "none"}, blocksEmptyWakePrompt: false};
    }, processPid: () => undefined});
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(hostDeliveryProfile("0188-other-producer", {}).transport).toBe("claude-inbox");
    expect(diagnosticRecord(sink)).toMatchObject({phase: "adapter-probe", cleanup: "unknown", reason: "ADAPTER_SETTINGS_UNAVAILABLE"});
    expect(f.open).not.toHaveBeenCalled();
  });
  it("distinguishes directory stat failure from open without an acquired descriptor", () => {
    f.stat.mockImplementationOnce(() => {throw new TypeError("PRIVATE_STAT_FAILURE");});
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(hostDeliveryProfile("gemini", automaticEnvironment, undefined, true).transport).toBe("gemini-deferred");
    expect(diagnosticRecord(sink)).toMatchObject({phase: "directory-stat", cleanup: "not-acquired", reason: "QUEUE_SETTINGS_DIRECTORY_STAT_FAILED"});
    expect(f.open).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  });
  it.each(["getter", "proxy", "revoked"])("does not reflect on %s observation carriers in the default sink", mode => {
    const trap = vi.fn(() => {throw new Error("PRIVATE_OBSERVATION_TRAP");});
    let observation: unknown;
    if (mode === "getter") observation = Object.defineProperty({cleanup: "unknown", failure: producerFailure("OWNED_CARRIER", "Fixed failure.")}, "phase", {get: trap});
    else if (mode === "proxy") observation = new Proxy({}, {getPrototypeOf: trap, getOwnPropertyDescriptor: trap});
    else {const revoked = Proxy.revocable({}, {}); revoked.revoke(); observation = revoked.proxy;}
    const host = "0188-opaque-" + mode;
    registerHookHostAdapter(host, {deliveryProfile: (_environment, diagnose) => {
      diagnose("unavailable", observation);
      return {transport: "claude-inbox", capabilities: {supportedInjection: [], idleWake: "none"}, blocksEmptyWakePrompt: false};
    }, processPid: () => undefined});
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    hostDeliveryProfile(host, {});
    expect(sink).toHaveBeenCalledExactlyOnceWith("[agent-governance-suite] " + host + " queue settings: unavailable.");
    expect(trap).not.toHaveBeenCalled();
  });
  it("does not infer a producer phase from a forged public code in the actual diagnostic sink", () => {
    const trap = vi.fn(() => {throw new Error("PRIVATE_FAKE_TRAP");});
    const fake = Object.defineProperty({code: "QUEUE_SETTINGS_CLOSE_FAILED"}, "cause", {get: trap});
    registerHookHostAdapter("0188-counterfeit", {deliveryProfile: (_environment, diagnose) => {
      diagnose("close-failed", {phase: "close", cleanup: "unknown", failure: fake});
      return {transport: "claude-inbox", capabilities: {supportedInjection: [], idleWake: "none"}, blocksEmptyWakePrompt: false};
    }, processPid: () => undefined});
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(hostDeliveryProfile("0188-counterfeit", {}, undefined).transport).toBe("claude-inbox");
    expect(sink).toHaveBeenCalledExactlyOnceWith("[agent-governance-suite] 0188-counterfeit queue settings: close-failed.");
    expect(trap).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });
});
