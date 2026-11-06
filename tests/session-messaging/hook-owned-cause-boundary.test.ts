import {existsSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const f = vi.hoisted(() => ({
  now: 100, mode: "normal", spawn: vi.fn(),
  sqlExec: vi.fn(), sqlGet: vi.fn(), sqlRun: vi.fn(), sqlClose: vi.fn(),
  closeFailure: null as {value: unknown} | null, rollbackFailure: null as {value: unknown} | null,
}));
vi.mock("node:perf_hooks", () => ({performance: {now: () => globalThis.performance.now()}}));
vi.mock("node:child_process", async original => ({...await original<typeof import("node:child_process")>(), spawn: f.spawn}));
// Only the trust database is a fixture; session messaging runs the real in-process SQLite store (3.1).
vi.mock("node:sqlite", async original => {
  const real = await original<typeof import("node:sqlite")>();
  class DatabaseSync {
    constructor(location: string, ...rest: unknown[]) {
      if (!String(location).includes("PRIVATE_TRUST")) return new real.DatabaseSync(location, ...(rest as [])) as never;
    }
    exec(...args: unknown[]) {
      const result = f.sqlExec(...args);
      if (args[0] === "ROLLBACK;" && f.rollbackFailure) throw f.rollbackFailure.value;
      return result;
    }
    prepare(sql: string) {return {get: (...args: unknown[]) => f.sqlGet(sql, ...args), run: (...args: unknown[]) => f.sqlRun(sql, ...args)};}
    // Throw outside vi.fn: its TypeError probe traverses a thrown Proxy prototype.
    close() {f.sqlClose(); if (f.closeFailure) throw f.closeFailure.value;}
  }
  return {...real, DatabaseSync};
});

import {DatabaseSync as RealDatabaseSync} from "node:sqlite";
import {runSessionMessageHook} from "../../mcp-server/src/session-message-hook.js";
import {registerHookHostAdapter, type AdaptedHostInput} from "../../mcp-server/src/host-input-adapter.js";
import {BrokerRequestRejected, closeSessionMessaging, runSessionMessageOperation, sessionMessageRequest} from "../../mcp-server/src/session-message-client.js";
import {MESSAGE_SENDER_RECEIPT_LIMIT} from "../../mcp-server/src/session-message-store.js";
import {hookFailureContext, hookFailureReason, retainHookFailureCause, retainHookFailureSecondary, tagHookFailure} from "../../mcp-server/src/hook-error-diagnostics.js";

// Explicit synthetic core adapter; no native actor capture is represented.
const host = "owned-cause-fixture";
const session = {id: "PRIVATE_SESSION"};
function fixtureInput(_input: Record<string, unknown>, selectedHost: string): AdaptedHostInput {
  return { lifecycle: "none", outputEventName: "PostToolUse", observation: {
    host: selectedHost, sessionId: session.id, kind: "tool-boundary", boundaryPhase: "after",
    actor: {role: "root", basis: "observed", reasonCode: "SYNTHETIC_OWNED_CAUSE_ROOT"}, toolName: "read_file", toolInput: {},
  } };
}
registerHookHostAdapter(host, {adaptInput: fixtureInput, deliveryProfile: () => ({
  transport: "claude-inbox", capabilities: {supportedInjection: ["tool-boundary"], idleWake: "none"}, blocksEmptyWakePrompt: false,
}), processPid: () => undefined});
const key = Buffer.alloc(32, 1).toString("base64url");
const target = {host, sessionId: "PRIVATE_SESSION"};
const sender = {host, sessionId: "sender"};
const input = JSON.stringify({hook_event_name: "PostToolUse", session_id: "PRIVATE_SESSION", agent_id: "", tool_name: "read_file"});
const options = {executionBudget: {deadlineMonotonicMs: 1000, postClaimReserveMs: 200}};
let root = "", stateDirectory = "";
function diagnosticValue(spy: ReturnType<typeof vi.spyOn>) {
  const line = spy.mock.calls.map((args: unknown[]) => args[0]).find((value: unknown): value is string => typeof value === "string" && value.startsWith("{") && JSON.parse(value).event === "peer-hook-failure");
  if (typeof line !== "string") throw new Error("Expected hook failure diagnostic");
  for (const marker of ["PRIVATE_", "session-messages.sqlite3", key, root]) expect(line).not.toContain(marker);
  return JSON.parse(line.slice(line.indexOf("{")));
}
/** A peer message really queued in the in-process store, so the claim reaches the trust receipt path. */
function queueMessage(): string {
  const prepared = runSessionMessageOperation<{messageId: string}>("prepare", {sender, target, body: "PRIVATE_BODY"}, stateDirectory);
  runSessionMessageOperation("send", {sender, messageId: prepared.messageId}, stateDirectory);
  return prepared.messageId;
}
const deliveryAttempts = (messageId: string) =>
  (runSessionMessageOperation<{status: {deliveryAttempts: number}}>("status", {sender, messageId}, stateDirectory)).status.deliveryAttempts;
beforeEach(() => {
  vi.stubGlobal("performance", {now: () => f.now});
  f.now = 100; f.mode = "normal"; session.id = "PRIVATE_SESSION";
  for (const mock of [f.spawn, f.sqlExec, f.sqlGet, f.sqlRun, f.sqlClose]) mock.mockReset();
  f.closeFailure = null; f.rollbackFailure = null;
  f.sqlGet.mockImplementation((sql: string) => sql.includes("PRAGMA user_version") ? {user_version: f.mode === "schema" ? 2 : 0}
    : sql.includes("SELECT value FROM trust_metadata") ? {value: f.mode.startsWith("key") ? "bad-key" : key}
    : f.mode === "conflict" && sql.includes("SELECT receipt_json") ? {receipt_json: JSON.stringify({contentDigest: "different", originKind: "peer", authorityEffect: "none", attestation: {}})} : undefined);
  root = mkdtempSync(path.join(tmpdir(), "ags-owned-cause-"));
  stateDirectory = path.join(root, "PRIVATE_STATE");
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", stateDirectory);
  // The fixture trust database is in memory; its file exists so the store's owner-only chmod has a target.
  writeFileSync(path.join(root, "PRIVATE_TRUST.sqlite3"), "");
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", path.join(root, "PRIVATE_TRUST.sqlite3"));
});
afterEach(() => {
  closeSessionMessaging(stateDirectory);
  rmSync(root, {recursive: true, force: true});
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe("0024 actual in-process messaging producer through actual hook and safe report", () => {
  it("reports a state directory that cannot be prepared with its producer reason and no raw path", async () => {
    writeFileSync(path.join(root, "PRIVATE_STATE"), "PRIVATE_STATE_FILE");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSessionMessageHook(host, input, undefined, options)).toBe("");
    expect(diagnosticValue(spy)).toMatchObject({phase: "handle", reason: "MESSAGING_STATE_DIRECTORY_FAILED",
      producerReason: "MESSAGING_STATE_DIRECTORY_FAILED", reasonBasis: "producer", context: {producerReason: "MESSAGING_STATE_DIRECTORY_FAILED"}});
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.sqlGet).not.toHaveBeenCalled();
  });

  it("reports a domain rejection of the claim as BROKER_REQUEST_REJECTED without its message", async () => {
    session.id = "PRIVATE_SESSION with invalid characters";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSessionMessageHook(host, input, undefined, options)).toBe("");
    expect(diagnosticValue(spy)).toMatchObject({phase: "handle", reason: "BROKER_REQUEST_REJECTED",
      producerReason: "BROKER_REQUEST_REJECTED", reasonBasis: "producer", context: {producerReason: "BROKER_REQUEST_REJECTED"}});
    expect(JSON.stringify(spy.mock.calls)).not.toContain("bounded identifier");
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.sqlGet).not.toHaveBeenCalled();
  });

  it("reports another process's writer lock as MESSAGING_BUSY within the claim budget and claims nothing", async () => {
    const messageId = queueMessage();
    const holder = new RealDatabaseSync(path.join(stateDirectory, "session-messages.sqlite3"));
    try {
      holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      // 2 ms of the claim budget remain after the post-claim reserve: that is the whole lock wait.
      expect(await runSessionMessageHook(host, input, undefined, {executionBudget: {deadlineMonotonicMs: 302, postClaimReserveMs: 200}})).toBe("");
      expect(diagnosticValue(spy)).toMatchObject({phase: "handle", reason: "MESSAGING_BUSY", producerReason: "MESSAGING_BUSY", reasonBasis: "producer"});
      holder.exec("COMMIT;");
    } finally { if (holder.isTransaction) holder.exec("ROLLBACK;"); holder.close(); }
    expect(deliveryAttempts(messageId)).toBe(0);
    expect(f.sqlGet).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
  });

  it("reports a writer lock held while this process first opens the store as MESSAGING_BUSY too", async () => {
    // A store file that still needs its schema: the first open must take the writer lock (D0059).
    const file = path.join(stateDirectory, "session-messages.sqlite3");
    runSessionMessageOperation("pending", {target}, stateDirectory);
    closeSessionMessaging(stateDirectory);
    const holder = new RealDatabaseSync(file);
    try {
      holder.exec("PRAGMA user_version = 3; PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await runSessionMessageHook(host, input, undefined, {executionBudget: {deadlineMonotonicMs: 302, postClaimReserveMs: 200}})).toBe("");
      expect(diagnosticValue(spy)).toMatchObject({phase: "handle", reason: "MESSAGING_BUSY", producerReason: "MESSAGING_BUSY", reasonBasis: "producer"});
    } finally { if (holder.isTransaction) holder.exec("ROLLBACK;"); holder.close(); }
  });

  it("preserves normal empty hook response and a single ACK target operation", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSessionMessageHook(host, input, undefined, options)).toBe("");
    expect(spy).not.toHaveBeenCalled();
    expect(await sessionMessageRequest("acknowledge", {target, messageIds: ["synthetic"]}, stateDirectory, {noOperationReplay: true, totalTimeoutMs: 100})).toEqual({acknowledged: 0});
    expect(f.sqlGet).not.toHaveBeenCalled();
  });

  it("does not promote a forged public code or an owned nested cause in the actual hook", async () => {
    const nested = tagHookFailure(new Error("PRIVATE_NESTED"), "OWNED_NESTED");
    const external = Object.assign(new Error("PRIVATE_EXTERNAL", {cause: nested}), {code: "MESSAGING_BUSY"});
    registerHookHostAdapter("owned-cause-counterfeit", {adaptInput: fixtureInput, deliveryProfile: () => {throw external;}, processPid: () => undefined});
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSessionMessageHook("owned-cause-counterfeit", input, undefined, options)).toBe("");
    expect(diagnosticValue(spy)).toMatchObject({reason: "UNEXPECTED_FAILURE", reasonBasis: "unknown", context: {cause: {producerReason: "OWNED_NESTED"}}});
    expect(existsSync(path.join(stateDirectory, "session-messages.sqlite3"))).toBe(false);
  });

  it("retains rejection class and bounded capacity details from the actual store", () => {
    for (let index = 0; index < MESSAGE_SENDER_RECEIPT_LIMIT; index++) queueMessage();
    let failure: unknown;
    try { queueMessage(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(BrokerRequestRejected);
    if (!(failure instanceof BrokerRequestRejected)) throw new Error("Expected messaging rejection");
    expect(failure.details).toEqual({scope: "sender", earliestReleaseAt: expect.any(String)});
    expect(hookFailureReason(failure)).toBe("BROKER_REQUEST_REJECTED");
  });

  it.each([["schema", "TRUST_SCHEMA_UNSUPPORTED"], ["conflict", "TRUST_SOURCE_EVENT_CONFLICT"]] as const)("keeps actual trust %s contract error visible through the hook", async (mode, reason) => {
    f.mode = mode;
    queueMessage();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSessionMessageHook(host, input, undefined, options)).toBe("");
    expect(diagnosticValue(spy)).toMatchObject({reason, reasonBasis: "producer", producerReason: reason});
    expect(f.sqlClose).toHaveBeenCalledTimes(1);
  });
  it.each(["key", "key-close", "key-proxy-close"] as const)("keeps actual invalid signing key through storage wrapper and %s cleanup", async mode => {
    f.mode = mode;
    const messageId = queueMessage();
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
    // One claim, never replayed after the receipt failure.
    expect(deliveryAttempts(messageId)).toBe(1);
  });
  it.each(["record-close", "record-proxy-close", "record-rollback"] as const)("preserves the actual record primary with %s secondary", async mode => {
    f.mode = mode;
    queueMessage();
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
