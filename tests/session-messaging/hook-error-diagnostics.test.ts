import { createHash } from "node:crypto";
import { runSessionMessageHook, sessionMessageEnvelope, type RecordedSessionMessage, type SessionMessageHookOptions } from "../../mcp-server/src/session-message-hook.js";
import { describe, expect, it, vi } from "vitest";
import { hookFailureContext, hookFailure, hookFailureReason } from "../../mcp-server/src/hook-error-diagnostics.js";
import { hostDeliveryProfile, registerHookHostAdapter, resolveHookHost } from "../../mcp-server/src/host-input-adapter.js";

const digest = (value: string) => createHash("sha256").update(Buffer.from(value, "utf16le")).digest("hex");
const adapter = { deliveryProfile: () => ({ transport: "claude-inbox" as const,
  capabilities: { supportedInjection: [], idleWake: "none" as const }, blocksEmptyWakePrompt: false }), processPid: () => undefined };
function failure(action: () => unknown): unknown { try { action(); } catch (cause) { return cause; } throw new Error("expected producer failure"); }

describe("L3 hook producer and bounded cause diagnostics", () => {
  it("distinguishes explicit host selection, invalid adapter and duplicate registration", () => {
    expect(resolveHookHost([], "existing-default")).toBe("existing-default");
    expect(resolveHookHost(["--host=opaque-new-host"], "existing-default")).toBe("opaque-new-host");
    for (const args of [["--host="], ["--host=../private-selection-marker"], ["--host=a", "--host=b"]]) {
      const error = failure(() => resolveHookHost(args, "existing-default"));
      expect(hookFailureReason(error)).toBe("INVALID_HOOK_HOST_SELECTION");
      expect(JSON.stringify(hookFailureContext(error))).not.toContain("private-selection-marker");
    }
    expect(hookFailureReason(failure(() => registerHookHostAdapter("../bad", adapter)))).toBe("INVALID_HOOK_HOST_ADAPTER");
    expect(hookFailureReason(failure(() => registerHookHostAdapter("invalid-shape-host", {} as typeof adapter)))).toBe("INVALID_HOOK_HOST_ADAPTER");
    const host = "L3-registered-once";
    registerHookHostAdapter(host, adapter);
    expect(hookFailureReason(failure(() => registerHookHostAdapter(host, adapter)))).toBe("HOOK_HOST_ADAPTER_DUPLICATE");
    expect(hostDeliveryProfile(host, {}).transport).toBe("claude-inbox");
    expect(hookFailureReason(failure(() => hostDeliveryProfile("L3-missing-adapter", {})))).toBe("HOST_ADAPTER_UNAVAILABLE");
  });

  it("keeps an unregistered code fingerprint and bounded cause chain without exposing native strings", () => {
    const root = Object.assign(new Error("private-message-marker"), { code: "unregistered-private-code-marker" });
    const outer = new Error("private-outer-marker", { cause: root });
    const context = hookFailureContext(outer);
    expect(context).toMatchObject({ type: "error", cause: { type: "error", code: {
      type: "string", length: 32, prefixSha256: digest("unregistered-private-code-marker"), truncated: false, encoding: "utf16le",
    } } });
    const text = JSON.stringify(context);
    expect(text).not.toContain("private-message-marker"); expect(text).not.toContain("private-outer-marker");
    expect(text).not.toContain("unregistered-private-code-marker");
    expect(hookFailureReason(root)).toBeNull();
  });

  it("does not invoke code, cause, message or stack accessors and bounds long codes and nested causes", () => {
    const accessed = vi.fn(() => { throw new Error("private-getter-marker"); });
    const error = {};
    for (const key of ["code", "cause", "message", "stack"]) Object.defineProperty(error, key, { get: accessed });
    expect(hookFailureContext(error)).toEqual({ type: "object", code: { type: "accessor", observed: false }, cause: { type: "accessor", observed: false } });
    expect(accessed).not.toHaveBeenCalled();
    const long = "private-prefix-".repeat(1000);
    const context = hookFailureContext(Object.assign(new Error("hidden"), { code: long }));
    expect(context.code).toEqual({ type: "string", length: long.length, prefixCodeUnits: 256, truncated: true, encoding: "utf16le", prefixSha256: digest(long.slice(0, 256)) });
    expect(JSON.stringify(context).length).toBeLessThan(400);
    const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
    expect(hookFailureContext(cycle)).toEqual({ type: "object", cause: { type: "object", cycle: true } });
    const deep = new Error("0", { cause: new Error("1", { cause: new Error("2", { cause: new Error("3") }) }) });
    expect(hookFailureContext(deep)).toMatchObject({ cause: { cause: { cause: { truncated: true } } } });
  });

  it("does not disguise small numeric or boolean codes as confidential hashes", () => {
    for (const value of [123, 456, true, false]) {
      expect(hookFailureContext(Object.assign(new Error("hidden"), { code: value })).code)
        .toEqual({ type: typeof value, observed: false });
    }
    expect(hookFailureReason({ code: "INVALID_HOOK_HOST_SELECTION" })).toBeNull();
    const error = hookFailure("OWN_TEST_FAILURE", "never emitted");
    expect(Object.getOwnPropertyDescriptor(error, "code")).toMatchObject({ writable: false, configurable: false });
    expect(hookFailureReason(error)).toBe("OWN_TEST_FAILURE");
    expect(hookFailureContext(new TypeError("hidden"))).toEqual({ type: "type-error" });
  });

  it("does not treat an arbitrary adapter code as an owned host producer reason in the actual caller", async () => {
    const error = Object.assign(new Error("private-adapter-message"), { code: "HOST_ADAPTER_UNAVAILABLE" });
    registerHookHostAdapter("L3-caller-counterfeit", { ...adapter, deliveryProfile: () => { throw error; } });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runSessionMessageHook("L3-caller-counterfeit", JSON.stringify({ hook_event_name: "PreToolUse",
        session_id: "private-caller-session", tool_name: "read_file", tool_input: { marker: "private-input-marker" } }))).toBe("");
      expect(diagnostic).toHaveBeenCalledTimes(1);
      const line = diagnostic.mock.calls[0]![0] as string;
      expect(line).toContain('"phase":"handle","reason":"UNEXPECTED_FAILURE"');
      expect(line).toContain(digest("HOST_ADAPTER_UNAVAILABLE"));
      for (const marker of ["private-adapter-message", "private-caller-session", "private-input-marker"])
        expect(line).not.toContain(marker);
    } finally { diagnostic.mockRestore(); }
  });

  it("keeps lone surrogate code units distinct, including a cutoff inside a pair", () => {
    const context = (code: string) => hookFailureContext(Object.assign(new Error("hidden"), { code })).code;
    const left = context("ab\uD83D");
    const right = context("ab\uD83E");
    const replacement = context("ab\uFFFD");
    expect(left).not.toEqual(right); expect(left).not.toEqual(replacement);
    expect(left).toMatchObject({ encoding: "utf16le", prefixCodeUnits: 3, truncated: false });
    expect(context("a".repeat(255) + "\uD83D\uDE00")).not.toEqual(context("a".repeat(255) + "\uD83E\uDE00"));
  });

  it.each([
    [8, "STORE_READONLY", 8], [13, "STORE_FULL", 13], [14, "STORE_CANTOPEN", 14],
    [10, "STORE_IO", 10], [266, "STORE_IO", 10], [1555, "STORE_CONSTRAINT", 19],
    [5, "STORE_BUSY", 5], [26, "STORE_CORRUPT", 26],
  ] as const)("preserves SQLite errcode %i in the actual hook diagnostic", async (errcode, reason, primaryCode) => {
    const error = Object.assign(new Error("private SQL and path"), { code: "ERR_SQLITE_ERROR", errcode });
    const host = "L3-sqlite-" + errcode;
    registerHookHostAdapter(host, { ...adapter, deliveryProfile: () => { throw error; } });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runSessionMessageHook(host, JSON.stringify({ hook_event_name: "PreToolUse", session_id: "hidden-session" }))).toBe("");
      expect(diagnostic).toHaveBeenCalledTimes(1);
      const line = diagnostic.mock.calls[0]![0] as string;
      const value = JSON.parse(line.slice(line.indexOf("{")));
      expect(value).toMatchObject({ phase: "handle", reason, context: { sqlite: { errcode, primaryCode } } });
      expect(line).not.toContain("private SQL and path"); expect(line).not.toContain("hidden-session");
    } finally { diagnostic.mockRestore(); }
  });

  it("does not invoke or expose unvalidated SQLite detail properties", () => {
    const accessed = vi.fn(() => { throw new Error("hidden"); });
    const error = { code: "ERR_SQLITE_ERROR" };
    Object.defineProperty(error, "errcode", { get: accessed });
    expect(hookFailureContext(error).sqlite).toEqual({ type: "accessor", observed: false });
    expect(accessed).not.toHaveBeenCalled();
    for (const errcode of ["8", 8.5, NaN, Infinity, -1, 65536, 256]) {
      expect(hookFailureContext({ code: "ERR_SQLITE_ERROR", errcode }).sqlite).toEqual({ observed: false });
    }
    expect(hookFailureContext({ code: "other", errcode: 8 })).not.toHaveProperty("sqlite");
  });

  it.each([
    [{ executionBudget: { deadlineMonotonicMs: NaN, postClaimReserveMs: 0 } }, "INVALID_HOOK_BUDGET"],
    [{ onClaimState: () => {} }, "CLAIM_OBSERVER_BUDGET_REQUIRED"],
    [{ defaultQueueWake: 1 }, "INVALID_QUEUE_DEFAULT"],
    [{ ensureRelay: "yes" }, "INVALID_RELAY_ENSURE_OPTION"],
    [{ recoverExistingSession: "yes" }, "INVALID_RELAY_RECOVERY_OPTION"],
    [{ resolveHostProcess: true }, "INVALID_HOST_PROCESS_RESOLVER"],
    [{ recoverExistingSession: true }, "RELAY_RECOVERY_CONTEXT_REQUIRED"],
    [{ ensureRelay: true }, "RELAY_ENSURE_CONTEXT_REQUIRED"],
  ] as const)("retains the fixed option producer reason %j", async (options, reason) => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runSessionMessageHook("codex", "{}", undefined, options as unknown as SessionMessageHookOptions)).toBe("");
      expect(diagnostic).toHaveBeenCalledTimes(1);
      expect(diagnostic.mock.calls[0]![0]).toContain('"phase":"options","reason":"' + reason + '"');
    } finally { diagnostic.mockRestore(); }
  });

  it("distinguishes an oversized envelope failure without retaining the peer body", () => {
    const message = { messageId: "synthetic", sender: { host: "synthetic", sessionId: "sender" },
      recipient: { host: "synthetic", sessionId: "receiver" }, body: "private-body-".repeat(100_000),
      createdAt: "2026-10-24T00:00:00.000Z", expiresAt: "2026-10-24T01:00:00.000Z",
      deliveryAttempt: 1, firstDeliveredAt: null, sourceReceiptId: "synthetic", contentDigest: "sha256:synthetic" } as RecordedSessionMessage;
    const error = failure(() => sessionMessageEnvelope([message]));
    expect(hookFailureReason(error)).toBe("PEER_ENVELOPE_TOO_LARGE");
    expect(JSON.stringify(hookFailureContext(error))).not.toContain("private-body-");
  });


  it("treats Proxy and revoked Proxy errors as opaque without invoking traps", () => {
    const trapped = vi.fn(() => {
      if (trapped.mock.calls.length > 3) throw new Error("bounded regression sentinel");
      return proxy;
    });
    const proxy: object = new Proxy({}, { getPrototypeOf: trapped, getOwnPropertyDescriptor: () => { trapped(); return undefined; } });
    expect(hookFailureContext(proxy)).toEqual({ type: "object", opaque: "proxy" });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    expect(hookFailureContext(revoked.proxy)).toEqual({ type: "object", opaque: "proxy" });
    expect(hookFailureContext(Object.create(proxy))).toEqual({ type: "object" });
    expect(hookFailureContext(new Error("hidden", { cause: proxy }))).toMatchObject({ cause: { opaque: "proxy" } });
    expect(hookFailureReason(proxy)).toBeNull();
    expect(trapped).not.toHaveBeenCalled();
  });

  it("does not reflect on a Proxy thrown by the adapter in the actual hook caller", async () => {
    const trapped = vi.fn(() => { throw new Error("private-proxy-trap"); });
    const error = new Proxy({}, { getPrototypeOf: trapped, getOwnPropertyDescriptor: trapped });
    registerHookHostAdapter("L3-proxy-caller", { ...adapter, deliveryProfile: () => { throw error; } });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runSessionMessageHook("L3-proxy-caller", JSON.stringify({ hook_event_name: "PreToolUse", session_id: "hidden" }))).toBe("");
      expect(trapped).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalledTimes(1);
      expect(diagnostic.mock.calls[0]![0]).toContain('"context":{"type":"object","opaque":"proxy"}');
      expect(diagnostic.mock.calls[0]![0]).not.toContain("private-proxy-trap");
    } finally { diagnostic.mockRestore(); }
  });

});
