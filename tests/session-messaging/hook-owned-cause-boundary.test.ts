import {EventEmitter} from "node:events";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const f = vi.hoisted(() => ({
  now: 100, mode: "normal", code: "EPIPE", endpointReads: 0, connections: 0,
  frames: [] as Array<{operation: string}>, sockets: [] as Array<{destroy: ReturnType<typeof vi.fn>}>,
  read: vi.fn(), mkdir: vi.fn(), chmod: vi.fn(), connect: vi.fn(), spawn: vi.fn(),
  sqlExec: vi.fn(), sqlGet: vi.fn(), sqlRun: vi.fn(), sqlClose: vi.fn(),
  closeFailure: null as {value: unknown} | null, rollbackFailure: null as {value: unknown} | null,
}));
vi.mock("node:perf_hooks", () => ({performance: {now: () => f.now}}));
vi.mock("node:tls", () => ({default: {connect: f.connect}}));
vi.mock("node:child_process", async original => ({...await original<typeof import("node:child_process")>(), spawn: f.spawn}));
vi.mock("node:fs", async original => ({...await original<typeof import("node:fs")>(), existsSync: () => true, mkdirSync: vi.fn(), chmodSync: vi.fn()}));
vi.mock("node:fs/promises", async original => ({...await original<typeof import("node:fs/promises")>(), readFile: f.read, mkdir: f.mkdir, chmod: f.chmod}));
vi.mock("node:sqlite", () => ({DatabaseSync: class {
  exec(...args: unknown[]) {
    const result = f.sqlExec(...args);
    if (args[0] === "ROLLBACK;" && f.rollbackFailure) throw f.rollbackFailure.value;
    return result;
  }
  prepare(sql: string) {return {get: (...args: unknown[]) => f.sqlGet(sql, ...args), run: (...args: unknown[]) => f.sqlRun(sql, ...args)};}
  // Throw outside vi.fn: its TypeError probe traverses a thrown Proxy prototype.
  close() {f.sqlClose(); if (f.closeFailure) throw f.closeFailure.value;}
}}));

import {runSessionMessageHook} from "../../mcp-server/src/session-message-hook.js";
import {registerHookHostAdapter, type AdaptedHostInput} from "../../mcp-server/src/host-input-adapter.js";
import {BrokerRequestRejected, requestSessionMessageOnce, sessionMessageRequest} from "../../mcp-server/src/session-message-client.js";
import {hookFailureContext, hookFailureReason, retainHookFailureCause, retainHookFailureSecondary, tagHookFailure} from "../../mcp-server/src/hook-error-diagnostics.js";
import {SESSION_MESSAGE_MAX_RESPONSE_BYTES, SESSION_MESSAGE_PROTOCOL} from "../../mcp-server/src/session-message-protocol.js";

// Explicit synthetic core adapter; no native actor capture is represented.
const host = "owned-cause-fixture";
function fixtureInput(_input: Record<string, unknown>, selectedHost: string): AdaptedHostInput {
  return { lifecycle: "none", outputEventName: "PostToolUse", observation: {
    host: selectedHost, sessionId: "PRIVATE_SESSION", kind: "tool-boundary", boundaryPhase: "after",
    actor: {role: "root", basis: "observed", reasonCode: "SYNTHETIC_OWNED_CAUSE_ROOT"}, toolName: "read_file", toolInput: {},
  } };
}
registerHookHostAdapter(host, {adaptInput: fixtureInput, deliveryProfile: () => ({
  transport: "claude-inbox", capabilities: {supportedInjection: ["tool-boundary"], idleWake: "none"}, blocksEmptyWakePrompt: false,
}), processPid: () => undefined});
const fingerprint = Array(32).fill("AA").join(":");
const key = Buffer.alloc(32, 1).toString("base64url");
const message = {messageId: "owned-fixture-message", sender: {host, sessionId: "sender"},
  recipient: {host, sessionId: "PRIVATE_SESSION"}, body: "PRIVATE_BODY", createdAt: "2026-10-25T00:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z", deliveryAttempt: 1, firstDeliveredAt: null};
const input = JSON.stringify({hook_event_name: "PostToolUse", session_id: "PRIVATE_SESSION", agent_id: "", tool_name: "read_file"});
const options = {executionBudget: {deadlineMonotonicMs: 1000, postClaimReserveMs: 200}};
function diagnosticValue(spy: ReturnType<typeof vi.spyOn>) {
  const line = spy.mock.calls.map((args: unknown[]) => args[0]).find((value: unknown): value is string => typeof value === "string" && value.includes("peer-hook-failure "));
  if (typeof line !== "string") throw new Error("Expected hook failure diagnostic");
  expect(line).toBeDefined();
  for (const marker of ["PRIVATE_", "broker.token", "certificateFingerprint256", key]) expect(line).not.toContain(marker);
  return JSON.parse(line.slice(line.indexOf("{")));
}
beforeEach(() => {
  vi.stubGlobal("performance", {now: () => f.now});
  f.now = 100; f.mode = "normal"; f.code = "EPIPE"; f.endpointReads = 0; f.connections = 0; f.frames = []; f.sockets = [];
  for (const mock of [f.read, f.mkdir, f.chmod, f.connect, f.spawn, f.sqlExec, f.sqlGet, f.sqlRun, f.sqlClose]) mock.mockReset();
  f.closeFailure = null; f.rollbackFailure = null;
  f.mkdir.mockResolvedValue(undefined); f.chmod.mockResolvedValue(undefined);
  f.read.mockImplementation(async (file: string) => {
    if (String(file).endsWith("endpoint.json")) {
      f.endpointReads++;
      if (f.mode === "endpoint" && f.endpointReads > 1) return JSON.stringify({address: "PRIVATE_ENDPOINT"});
      return JSON.stringify({protocolVersion: SESSION_MESSAGE_PROTOCOL, address: "127.0.0.1", port: 443, pid: 123, startedAt: "fixture", certificateFingerprint256: fingerprint});
    }
    return String(file).endsWith("broker.token") ? "A".repeat(43) : "PRIVATE_CERTIFICATE";
  });
  f.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {exitCode: ["spawn-error", "probe-history"].includes(f.mode) ? null : 1, signalCode: null, stdio: [null, null, null, null], unref: vi.fn()});
    if (f.mode === "spawn-error") queueMicrotask(() => child.emit("error", Object.assign(new Error("PRIVATE_SPAWN"), {code: f.code})));
    return child;
  });
  f.sqlGet.mockImplementation((sql: string) => sql.includes("PRAGMA user_version") ? {user_version: f.mode === "schema" ? 2 : 0}
    : sql.includes("SELECT value FROM trust_metadata") ? {value: f.mode.startsWith("key") ? "bad-key" : key}
    : f.mode === "conflict" && sql.includes("SELECT receipt_json") ? {receipt_json: JSON.stringify({contentDigest: "different", originKind: "peer", authorityEffect: "none", attestation: {}})} : undefined);
  f.connect.mockImplementation((tlsOptions: {checkServerIdentity: (host: string, certificate: {fingerprint256: string}) => Error | undefined}) => {
    const number = ++f.connections;
    const socket = Object.assign(new EventEmitter(), {
      destroy: vi.fn(), getPeerCertificate: () => {
        if (f.mode === "prepare") throw "PRIVATE_PREPARATION";
        return {fingerprint256: (f.mode === "pin" || f.mode === "probe-history") && number > 1 ? "PRIVATE_PIN" : fingerprint};
      },
      write: vi.fn((frame: string) => {
        const request = JSON.parse(frame) as {operation: string};
        f.frames.push(request);
        if (request.operation === "ping") {
          queueMicrotask(() => {
            if (["broker-exit", "spawn-error", "probe-history"].includes(f.mode)) socket.emit("error", new Error("PRIVATE_CONNECT_FAILURE"));
            else socket.emit("data", Buffer.from(JSON.stringify({ok: true, data: {}}) + "\n"));
          });
          return true;
        }
        if (f.mode === "write") throw new Error("PRIVATE_WRITE_FAILURE");
        queueMicrotask(() => {
          if (f.mode === "deadline") return;
          if (f.mode === "cap") socket.emit("data", Buffer.alloc(SESSION_MESSAGE_MAX_RESPONSE_BYTES + 1, 120));
          else if (f.mode === "json") socket.emit("data", Buffer.from("PRIVATE_INVALID_JSON\n"));
          else if (f.mode === "close") {socket.emit("end"); socket.emit("close");}
          else if (f.mode === "rejected") socket.emit("data", Buffer.from(JSON.stringify({ok: false, error: "PRIVATE_REJECTION", details: {scope: "sender", earliestReleaseAt: null}}) + "\n"));
          else if (f.mode === "transport") socket.emit("error", Object.assign(new Error("PRIVATE_TRANSPORT"), {code: f.code}));
          else if (request.operation === "acknowledge") socket.emit("data", Buffer.from(JSON.stringify({ok: true, data: {acknowledged: 1}}) + "\n"));
          else if (request.operation === "claim-deferred") socket.emit("data", Buffer.from(JSON.stringify({ok: true, data: {messages: f.mode.startsWith("key") || f.mode.startsWith("record") || ["schema", "conflict"].includes(f.mode) ? [message] : []}}) + "\n"));
          else throw new Error("UNEXPECTED_FIXTURE_OPERATION");
        });
        return true;
      }),
    });
    f.sockets.push(socket);
    queueMicrotask(() => {
      if (f.mode === "pin-callback" && number > 1) socket.emit("error", tlsOptions.checkServerIdentity("localhost", {fingerprint256: "PRIVATE_PIN"}));
      else socket.emit("secureConnect");
    });
    return socket;
  });
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", "/PRIVATE_STATE");
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", "/PRIVATE_TRUST");
});
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.unstubAllGlobals();});

describe("0024 actual client producer through actual hook and safe report", () => {
  it.each([
    ["endpoint", "BROKER_ENDPOINT_INVALID"], ["pin", "BROKER_CERTIFICATE_PIN_MISMATCH"],
    ["pin-callback", "BROKER_CERTIFICATE_PIN_MISMATCH"], ["write", "BROKER_WRITE_FAILED"],
    ["cap", "BROKER_RESPONSE_TOO_LARGE"], ["json", "BROKER_RESPONSE_INVALID_JSON"],
    ["close", "BROKER_RESPONSE_INCOMPLETE"], ["rejected", "BROKER_REQUEST_REJECTED"],
    ["transport", "BROKER_TRANSPORT_FAILED"],
  ] as const)("preserves %s producer reason without replay or raw output", async (mode, reason) => {
    f.mode = mode;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSessionMessageHook(host, input, undefined, options)).toBe("");
    const observedReason = mode === "transport" ? "EPIPE" : mode === "json" ? "INVALID_JSON" : reason;
    expect(diagnosticValue(spy)).toMatchObject({phase: "handle", reason: observedReason, producerReason: reason,
      reasonBasis: observedReason === reason ? "producer" : "unverified-observation", context: {producerReason: reason}});
    expect(f.frames.filter(frame => frame.operation === "claim-deferred").length).toBeLessThanOrEqual(1);
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.sqlGet).not.toHaveBeenCalled();
    for (const socket of f.sockets) expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
  it("reports the actual request deadline and destroys the target socket once", async () => {
    vi.useFakeTimers(); vi.stubGlobal("performance", {now: () => f.now}); f.mode = "deadline";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = runSessionMessageHook(host, input, undefined, options);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe("");
    expect(diagnosticValue(spy)).toMatchObject({reason: "BROKER_DEADLINE_EXPIRED", reasonBasis: "producer"});
    expect(f.frames.map(frame => frame.operation)).toEqual(["ping", "claim-deferred"]);
    for (const socket of f.sockets) expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
  it("keeps failed readiness transport as a secondary cause of actual broker early exit", async () => {
    f.mode = "broker-exit";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSessionMessageHook(host, input, undefined, options)).toBe("");
    expect(diagnosticValue(spy)).toMatchObject({reason: "BROKER_EXITED_BEFORE_READY",
      context: {secondary: [{producerReason: "BROKER_TRANSPORT_FAILED"}]}});
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.frames.map(frame => frame.operation)).toEqual(["ping"]);
  });
  it("preserves normal empty hook response and a single ACK target operation", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSessionMessageHook(host, input, undefined, options)).toBe("");
    expect(spy).not.toHaveBeenCalled();
    expect(f.frames.map(frame => frame.operation)).toEqual(["ping", "claim-deferred"]);
    f.frames = [];
    expect(await sessionMessageRequest("acknowledge", {target: {host, sessionId: "PRIVATE_SESSION"}, messageIds: ["synthetic"]}, "/PRIVATE_STATE", {noOperationReplay: true, totalTimeoutMs: 100})).toEqual({acknowledged: 1});
    expect(f.frames.map(frame => frame.operation)).toEqual(["ping", "acknowledge"]);
    expect(f.frames[1]).toMatchObject({protocolVersion: SESSION_MESSAGE_PROTOCOL, operation: "acknowledge", payload: {target: {host, sessionId: "PRIVATE_SESSION"}, messageIds: ["synthetic"]}});
    expect(f.sqlGet).not.toHaveBeenCalled();
  });
  it("does not promote a forged public code or an owned nested cause in the actual hook", async () => {
    const nested = tagHookFailure(new Error("PRIVATE_NESTED"), "OWNED_NESTED");
    const external = Object.assign(new Error("PRIVATE_EXTERNAL", {cause: nested}), {code: "BROKER_ENDPOINT_INVALID"});
    registerHookHostAdapter("owned-cause-counterfeit", {adaptInput: fixtureInput, deliveryProfile: () => {throw external;}, processPid: () => undefined});
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSessionMessageHook("owned-cause-counterfeit", input, undefined, options)).toBe("");
    expect(diagnosticValue(spy)).toMatchObject({reason: "UNEXPECTED_FAILURE", reasonBasis: "unknown", context: {cause: {producerReason: "OWNED_NESTED"}}});
    expect(f.connect).not.toHaveBeenCalled();
  });
  it("keeps the actual endpoint SyntaxError and external abort reason identity", async () => {
    f.read.mockImplementationOnce(async () => "{");
    const parseFailure = await requestSessionMessageOnce("claim-deferred", {}, "/PRIVATE_STATE", 100).catch(error => error);
    expect(parseFailure).toBeInstanceOf(SyntaxError); expect(hookFailureReason(parseFailure)).toBe("BROKER_ENDPOINT_INVALID");
    const controller = new AbortController(), external = new Error("PRIVATE_ABORT");
    controller.abort(external);
    const aborted = await requestSessionMessageOnce("claim-deferred", {}, "/PRIVATE_STATE", 100, controller.signal).catch(error => error);
    expect(aborted).toBe(external); expect(hookFailureReason(aborted)).toBeNull();
  });
  it.each(["EPIPE", "ECONNRESET", "ECONNREFUSED"])("keeps readable %s together with actual transport producer stage", async code => {
    f.mode = "transport"; f.code = code;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSessionMessageHook(host, input, undefined, options)).toBe("");
    expect(diagnosticValue(spy)).toMatchObject({reason: code, reasonBasis: "unverified-observation", producerReason: "BROKER_TRANSPORT_FAILED"});
  });
  it.each(["ENOENT", "EACCES"])("keeps readable spawn %s and producer stage", async code => {
    f.mode = "spawn-error"; f.code = code;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSessionMessageHook(host, input, undefined, options)).toBe("");
    expect(diagnosticValue(spy)).toMatchObject({reason: code, reasonBasis: "unverified-observation", producerReason: "BROKER_START_FAILED"});
    // A spawn error arriving during the existing delay is observed on the next loop after one readiness ping.
    expect(f.frames.map(frame => frame.operation)).toEqual(["ping", "ping"]);
    expect(f.connections).toBe(2);
  });
  it("keeps last observed repeated readiness pin failure on the inherited request-budget deadline", async () => {
    vi.useFakeTimers(); vi.stubGlobal("performance", {now: () => f.now}); f.mode = "probe-history";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = runSessionMessageHook(host, input, undefined, options);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe("");
    expect(diagnosticValue(spy)).toMatchObject({reason: "BROKER_DEADLINE_EXPIRED", producerReason: "BROKER_DEADLINE_EXPIRED"});
    expect(diagnosticValue(spy).context.secondary).toEqual(expect.arrayContaining([{type: "error", producerReason: "BROKER_CERTIFICATE_PIN_MISMATCH"}, {type: "error", producerReason: "BROKER_TRANSPORT_FAILED"}]));
    expect(f.connections).toBeGreaterThan(2); expect(f.frames.every(frame => frame.operation === "ping")).toBe(true);
  });
  it.each([["schema", "TRUST_SCHEMA_UNSUPPORTED"], ["conflict", "TRUST_SOURCE_EVENT_CONFLICT"]] as const)("keeps actual trust %s contract error visible through the hook", async (mode, reason) => {
    f.mode = mode;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSessionMessageHook(host, input, undefined, options)).toBe("");
    expect(diagnosticValue(spy)).toMatchObject({reason, reasonBasis: "producer", producerReason: reason});
    expect(f.sqlClose).toHaveBeenCalledTimes(1);
  });
  it("distinguishes actual encoding and preparation failures from write before a wire attempt", async () => {
    const circular: Record<string, unknown> = {}; circular.self = circular;
    const encoded = await requestSessionMessageOnce("claim-deferred", circular, "/PRIVATE_STATE", 100, undefined, {enforceDeadline: true}).catch(error => error);
    expect(encoded).toBeInstanceOf(TypeError); expect(hookFailureReason(encoded)).toBe("BROKER_REQUEST_ENCODING_FAILED");
    expect(f.frames).toHaveLength(0);
    f.mode = "prepare";
    const prepared = await requestSessionMessageOnce("claim-deferred", {}, "/PRIVATE_STATE", 100, undefined, {enforceDeadline: true}).catch(error => error);
    expect(hookFailureReason(prepared)).toBe("BROKER_REQUEST_PREPARATION_FAILED");
    expect(JSON.stringify(hookFailureContext(prepared))).not.toContain("PRIVATE_");
    expect(f.frames).toHaveLength(0);
  });
  it("retains rejection class and bounded capacity details", async () => {
    f.mode = "rejected";
    const failure = await requestSessionMessageOnce("claim-deferred", {}, "/PRIVATE_STATE", 100, undefined, {enforceDeadline: true}).catch(error => error);
    expect(failure).toBeInstanceOf(BrokerRequestRejected);
    if (!(failure instanceof BrokerRequestRejected)) throw new Error("Expected broker rejection");
    expect(failure.details).toEqual({scope: "sender", earliestReleaseAt: null});
    expect(hookFailureReason(failure)).toBe("BROKER_REQUEST_REJECTED");
  });
  it.each(["key", "key-close", "key-proxy-close"] as const)("keeps actual invalid signing key through storage wrapper and %s cleanup", async mode => {
    f.mode = mode;
    const trap = vi.fn(() => {throw new Error("PRIVATE_PROXY_TRAP");});
    const proxy = new Proxy({}, {getPrototypeOf: trap, getOwnPropertyDescriptor: trap});
    if (mode === "key-close" || mode === "key-proxy-close") f.closeFailure = {value: mode === "key-proxy-close" ? proxy : new Error("PRIVATE_CLOSE")};
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSessionMessageHook(host, input, undefined, options)).toBe("");
    expect(diagnosticValue(spy)).toMatchObject({reason: "TRUST_STORAGE_FAILED", reasonBasis: "producer",
      context: {producerCause: {producerReason: "TRUST_SIGNING_KEY_INVALID"}}});
    if (mode === "key-close") expect(diagnosticValue(spy).context.secondary).toMatchObject([{producerReason: "TRUST_CLOSE_FAILED"}]);
    if (mode === "key-proxy-close") expect(diagnosticValue(spy).context.secondary).toMatchObject([{opaque: "proxy"}]);
    expect(trap).not.toHaveBeenCalled();
    expect(f.sqlClose).toHaveBeenCalledTimes(1);
    expect(f.frames.filter(frame => frame.operation === "claim-deferred")).toHaveLength(1);
  });
  it.each(["record-close", "record-proxy-close", "record-rollback"] as const)("preserves the actual record primary with %s secondary", async mode => {
    f.mode = mode;
    const primary = Object.assign(new Error("PRIVATE_SQL"), {code: "ERR_SQLITE_ERROR", errcode: 8});
    const trap = vi.fn(() => {throw new Error("PRIVATE_PROXY_TRAP");});
    const proxy = new Proxy({}, {getPrototypeOf: trap, getOwnPropertyDescriptor: trap});
    f.sqlRun.mockImplementation(() => {throw primary;});
    if (mode === "record-rollback") f.rollbackFailure = {value: proxy};
    else f.closeFailure = {value: mode === "record-proxy-close" ? proxy : new Error("PRIVATE_CLOSE")};
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSessionMessageHook(host, input, undefined, options)).toBe("");
    const observed = diagnosticValue(spy);
    expect(observed).toMatchObject({reason: "TRUST_STORAGE_FAILED", context: {producerCause: {sqlite: {errcode: 8, primaryCode: 8}}}});
    if (mode === "record-proxy-close") expect(observed.context.secondary).toMatchObject([{opaque: "proxy"}]);
    if (mode === "record-close") expect(observed.context.secondary).toMatchObject([{producerReason: "TRUST_CLOSE_FAILED"}]);
    if (mode === "record-rollback") expect(observed.context.producerCause.secondary).toMatchObject([{opaque: "proxy"}]);
    expect(trap).not.toHaveBeenCalled(); expect(f.sqlClose).toHaveBeenCalledTimes(1);
  });
});

describe("0024 private diagnostic identity and bounded links", () => {
  it("keeps public identity, code, details and first producer reason unchanged", () => {
    const error = Object.assign(new TypeError("PRIVATE_MESSAGE"), {code: "PRIVATE_CODE", details: {marker: "PRIVATE_DETAILS"}});
    expect(tagHookFailure(error, "OWNED_FIRST")).toBe(error);
    expect(tagHookFailure(error, "OWNED_SECOND")).toBe(error);
    expect(error).toBeInstanceOf(TypeError); expect(error.code).toBe("PRIVATE_CODE");
    expect(error.details).toEqual({marker: "PRIVATE_DETAILS"}); expect(hookFailureReason(error)).toBe("OWNED_FIRST");
    const forged = {code: "OWNED_FIRST", message: "PRIVATE_MESSAGE", cause: error};
    expect(hookFailureReason(forged)).toBeNull();
    expect(hookFailureReason(structuredClone(error))).toBeNull();
    expect(hookFailureReason(Object.assign(new Error(), error))).toBeNull();
  });
  it("retains bounded actual primary/secondary links without getters, raw text or provenance promotion", () => {
    const getter = vi.fn(() => {throw new Error("PRIVATE_GETTER");});
    const opaque = Object.defineProperty({}, "code", {get: getter});
    const root = tagHookFailure(new Error("PRIVATE_ROOT"), "OWNED_ROOT");
    retainHookFailureCause(root, opaque);
    retainHookFailureSecondary(root, root);
    for (let i = 0; i < 10; i++) retainHookFailureSecondary(root, new Error("PRIVATE_SECONDARY"));
    const context = hookFailureContext(root);
    expect(context).toMatchObject({producerReason: "OWNED_ROOT", producerCause: {code: {type: "accessor", observed: false}}});
    expect(context.secondary).toHaveLength(2); expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(context)).not.toContain("PRIVATE_");
    const unowned = new Error("PRIVATE_OUTER", {cause: root});
    expect(hookFailureReason(unowned)).toBeNull();
    expect(hookFailureContext(unowned)).toMatchObject({cause: {producerReason: "OWNED_ROOT"}});
    retainHookFailureCause(root, new Error("PRIVATE_REPLACEMENT"));
    expect(hookFailureContext(root)).toMatchObject({producerCause: {code: {type: "accessor", observed: false}}});
    const cycle = new Error("PRIVATE_CYCLE"); retainHookFailureCause(cycle, cycle);
    expect(hookFailureContext(cycle)).toMatchObject({producerCause: {cycle: true}});
    const alias = new Error("PRIVATE_ALIAS"), shared = new Error("PRIVATE_SHARED");
    retainHookFailureCause(alias, shared); retainHookFailureSecondary(alias, shared);
    expect(hookFailureContext(alias)).toMatchObject({producerCause: {type: "error"}, secondary: [{type: "error"}]});
    expect(hookFailureContext(alias).secondary).not.toEqual([{type: "object", cycle: true}]);
  });
  it("does not share private reason identity with another module instance", async () => {
    const error = tagHookFailure(new Error("PRIVATE_MODULE"), "OWNED_INSTANCE");
    vi.resetModules();
    const other = await import("../../mcp-server/src/hook-error-diagnostics.js");
    expect(other.hookFailureReason(error)).toBeNull();
  });
});
