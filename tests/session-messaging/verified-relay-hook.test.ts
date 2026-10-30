import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ now: 100, request: vi.fn(), token: vi.fn(), spawn: vi.fn(), observeSpawn: vi.fn() }));
vi.mock("node:perf_hooks", () => ({ performance: { now: () => f.now } }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: f.spawn }));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));
vi.mock("../../mcp-server/src/process-identity.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/process-identity.js")>(), processStartToken: f.token,
}));
vi.mock("../../mcp-server/src/relay-wake-observation.js", () => ({ createRelaySpawnObservation: f.observeSpawn }));
import { handleSessionMessageHook, runSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { adaptHostInput, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { dispatchSessionMessageBrokerOperation } from "../../mcp-server/src/session-message-broker.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";

import type { ActorObservation } from "../../mcp-server/src/input-observation.js";

// Mocked broker/process core regression fixture only, not native capture or R7 evidence.
const syntheticHost = "synthetic-verified-relay";
const syntheticRoot: ActorObservation = {role: "root", basis: "observed", reasonCode: "SYNTHETIC_VERIFIED_RELAY_ROOT"};
registerHookHostAdapter(syntheticHost, {
  adaptInput: (payload, host) => {
    const mapped = adaptHostInput(payload, "codex");
    return {...mapped, observation: {...mapped.observation, host, callId: "synthetic-relay-call", actor: payload.syntheticActor as ActorObservation}};
  },
  deliveryProfile: () => ({transport: "gemini-queue", capabilities: {supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message"}, blocksEmptyWakePrompt: false}),
  processPid: (pid, observation) => observation ? pid : undefined,
});
const input = { hook_event_name: "SessionStart", session_id: "verified-hook-fixture", syntheticActor: syntheticRoot };
// Fixed SHA-256 fixture for [syntheticHost, session_id, 424242, "T1"].
const digest = "e4280a4d84e594985e4a4e596d9149ed3159a0459f4ee328f0ddd9962486a353";
const instanceId = "host-process-v1:" + digest;
const relayId = "verified-relay-v1:11111111-1111-4111-8111-111111111111:" + digest;
const grant = () => ({ spawn: true, relayId, instanceId });
const options = () => ({ ensureRelay: true, hostProcess: { pid: 424242, startToken: "T1" },
  executionBudget: { deadlineMonotonicMs: 1000, postClaimReserveMs: 200 } });

beforeEach(() => {
  f.now = 100; f.request.mockReset(); f.token.mockReset(); f.spawn.mockReset();
  f.observeSpawn.mockReset();
  f.request.mockResolvedValue(grant()); f.token.mockReturnValue("T1");
  f.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
  vi.stubEnv("AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE", "1");
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
});
afterEach(() => vi.unstubAllEnvs());

it("uses a single non-replayed ensure grant without emitting claim observations", async () => {
  const onClaimState = vi.fn();
  const prevCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  await handleSessionMessageHook(input, syntheticHost, 424242, {
    ...options(),
    onClaimState,
    relayEnv: { ANTIGRAVITY_CSRF_TOKEN: "isolated-relay-token" },
  });
  expect(process.env.ANTIGRAVITY_CSRF_TOKEN).toBe(prevCsrf);
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.request.mock.calls[0]![0]).toBe("ensure-relay");
  expect(f.request.mock.calls[0]![1]).toMatchObject({ parentPid: 424242, parentStartToken: "T1", transport: "gemini-queue" });
  expect(f.request.mock.calls[0]![3]).toMatchObject({ noOperationReplay: true, deadlineMonotonicMs: 1000 });
  expect(onClaimState).not.toHaveBeenCalled();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  const args = f.spawn.mock.calls[0]![1] as string[];
  for (const [flag, value] of [["--parent-pid", "424242"], ["--parent-start-token", "T1"], ["--instance-id", instanceId], ["--relay-id", relayId]] as const) {
    expect(args[args.indexOf(flag) + 1]).toBe(value);
  }
  expect(f.spawn.mock.calls[0]![2]).toMatchObject({
    windowsHide: true,
    detached: true,
    stdio: "ignore",
    env: expect.objectContaining({ ANTIGRAVITY_CSRF_TOKEN: "isolated-relay-token" }),
  });
});

it("어댑터가 소유한 시작 자식의 참조와 살아 있는 훅 계보를 유지한다", async () => {
  const relayOwner = vi.fn();
  await handleSessionMessageHook(input, syntheticHost, 424242, { ...options(), relayOwner });
  const child = f.spawn.mock.results[0]!.value;
  expect(f.spawn.mock.calls[0]![2]).toMatchObject({ detached: false, stdio: "ignore" });
  expect(relayOwner).toHaveBeenCalledTimes(1);
  expect(relayOwner).toHaveBeenCalledWith(child);
  expect(child.unref).not.toHaveBeenCalled();
  // 시작 요청은 예산 안에 끝나고 이후 자식 종료 대기는 어댑터가 맡는다.
  expect(f.request).toHaveBeenCalledTimes(1);
});

it.each([true, false])("진단 기록 전에 오류 처리와 자식 소유권을 확정한다: 소유자=%s", async (owned) => {
  const relayOwner = vi.fn();
  let state: {errorListeners: number; ownerCalls: number; unrefCalls: number} | undefined;
  const returned = vi.fn(() => {
    const child = f.spawn.mock.results[0]!.value;
    state = {errorListeners: child.listenerCount("error"), ownerCalls: relayOwner.mock.calls.length,
      unrefCalls: child.unref.mock.calls.length};
  });
  f.observeSpawn.mockReturnValue({ returned, spawned: vi.fn(), failed: vi.fn(), threw: vi.fn() });
  await handleSessionMessageHook(input, syntheticHost, 424242, {
    ...options(), ...(owned ? {relayOwner} : {}),
  });
  expect(returned).toHaveBeenCalledTimes(1);
  expect(state).toEqual({errorListeners: 1, ownerCalls: owned ? 1 : 0, unrefCalls: owned ? 0 : 1});
});

it("진단 준비로 기존 예산이 소진되면 자식을 생성하지 않는다", async () => {
  f.observeSpawn.mockImplementation(() => {f.now = 1001;});
  await handleSessionMessageHook(input, syntheticHost, 424242, options());
  expect(f.spawn).not.toHaveBeenCalled();
});

it("관측한 호스트 결속과 중개기 규약을 보존하며 기존 Claude 시작 relay를 소유한다", async () => {
  f.request.mockResolvedValue({});
  const relayOwner = vi.fn();
  await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: input.session_id }, "claude-code", undefined, { relayOwner });
  const child = f.spawn.mock.results[0]!.value;
  const args = f.spawn.mock.calls[0]![1] as string[];
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["presence-start"]);
  expect(args[args.indexOf("--parent-pid") + 1]).toBe(String(process.ppid));
  expect(args[args.indexOf("--parent-start-token") + 1]).toBe("T1");
  expect(args).not.toContain("--relay-id");
  expect(f.spawn.mock.calls[0]![2]).toMatchObject({ detached: false });
  expect(relayOwner).toHaveBeenCalledTimes(1);
  expect(relayOwner).toHaveBeenCalledWith(child);
  expect(child.unref).not.toHaveBeenCalled();
});

it("어댑터가 소유권을 받지 못하면 새 자식만 종료하고 시작을 반복하지 않는다", async () => {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() });
  f.spawn.mockReturnValue(child);
  await handleSessionMessageHook(input, syntheticHost, 424242, {
    ...options(), relayOwner: () => { throw new Error("synthetic owner failed"); },
  });
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(child.unref).not.toHaveBeenCalled();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.request).toHaveBeenCalledTimes(1);
});

it.each([
  { ...grant(), spawn: false },
  { ...grant(), relayId: "invalid" },
  { ...grant(), relayId: relayId.slice(0, -64) + "a".repeat(64) },
  { ...grant(), instanceId: "host-process-v1:" + "b".repeat(64) },
])("does not spawn or fall back after a cached or invalid grant: %j", async (result) => {
  f.request.mockResolvedValue(result);
  await handleSessionMessageHook(input, syntheticHost, 424242, options());
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.request.mock.calls[0]![0]).toBe("ensure-relay");
});

it("keeps an unknown broker result fail closed with no legacy startup fallback", async () => {
  f.request.mockRejectedValue(new Error("synthetic broker response unknown"));
  await handleSessionMessageHook(input, syntheticHost, 424242, options());
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.spawn).not.toHaveBeenCalled();
});

it.each(["T2", null])("revalidates T1 after the ensure await: %s", async (token) => {
  f.request.mockImplementation(async () => { f.token.mockReturnValue(token); return grant(); });
  await handleSessionMessageHook(input, syntheticHost, 424242, options());
  expect(f.token).toHaveBeenCalledTimes(2);
  expect(f.spawn).not.toHaveBeenCalled();
});

it("does not spawn after the caller deadline expires while awaiting the grant", async () => {
  f.request.mockImplementation(async () => { f.now = 1000; return grant(); });
  await handleSessionMessageHook(input, syntheticHost, 424242, options());
  expect(f.spawn).not.toHaveBeenCalled();
});

it("requires a budget and complete observation before any ensure effects", async () => {
  await expect(handleSessionMessageHook(input, syntheticHost, 424242,
    { ensureRelay: true, hostProcess: options().hostProcess })).rejects.toThrow();
  await expect(handleSessionMessageHook(input, syntheticHost, 424242,
    { ...options(), executionBudget: { deadlineMonotonicMs: 100, postClaimReserveMs: 0 } })).rejects.toThrow();
  await handleSessionMessageHook(input, syntheticHost, 424243, options());
  await handleSessionMessageHook({ ...input, syntheticActor: {role: "child", basis: "observed", reasonCode: "SYNTHETIC_RELAY_CHILD"} }, syntheticHost, 424242, options());
  expect(f.request).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
});

it("absorbs asynchronous spawn failure without retrying an uncertain reservation", async () => {
  await handleSessionMessageHook(input, syntheticHost, 424242, options());
  const child = f.spawn.mock.results[0]!.value as EventEmitter;
  expect(child.listenerCount("error")).toBe(1);
  expect(() => child.emit("error", new Error("synthetic spawn failure"))).not.toThrow();
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.spawn).toHaveBeenCalledTimes(1);
});

it.each(["codex", "claude-code"] as const)("preserves %s observed-PID mismatch rejection when ensure is false", async (host) => {
  const pid = process.ppid + 1;
  await handleSessionMessageHook(host === "claude-code" ? { hook_event_name: "SessionStart", session_id: input.session_id } : input, host, undefined, { ensureRelay: false, hostProcess: { pid, startToken: "T1" } });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
});

it.each(["codex", "claude-code"] as const)("uses only an admitted %s startup observation without ensure options", async (host) => {
  f.request.mockResolvedValue({});
  await handleSessionMessageHook(host === "claude-code" ? { hook_event_name: "SessionStart", session_id: input.session_id } : input, host, 424242);
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.request.mock.calls[0]![0]).toBe("presence-start");
  expect(f.spawn).toHaveBeenCalledTimes(1);
  const args = f.spawn.mock.calls[0]![1] as string[];
  expect(args).not.toContain("--relay-id");
  // Codex passes the observed host PID through; Claude uses the hook parent.
  expect(args[args.indexOf("--parent-pid") + 1]).toBe(host === "codex" ? "424242" : String(process.ppid));
});

const post = { ...input, hook_event_name: "PostToolUse", tool_name: "read_file", tool_input: {} };
const recover = (resolveHostProcess: () => { pid: number; startToken: string } | null) => ({
  recoverExistingSession: true, resolveHostProcess, executionBudget: options().executionBudget,
});
const livePresence = { host: syntheticHost, sessionId: input.session_id, instanceId, state: "online", transport: "gemini-queue", autoWake: { state: "available" } };

it.each(["available", "latched"])("keeps an online relay while binding the claiming event's own generation: %s", async (state) => {
  const resolver = vi.fn(() => options().hostProcess);
  f.request.mockImplementation(async (operation, _payload, _directory, requestOptions) => {
    if (operation === "list-presence") return { sessions: [{ ...livePresence, autoWake: { state } }] };
    requestOptions?.onOperationWrite?.();
    return { messages: [] };
  });
  await handleSessionMessageHook(post, syntheticHost, undefined, recover(resolver));
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["list-presence", "claim-deferred"]);
  expect(resolver).toHaveBeenCalledTimes(1);
  expect(f.token).toHaveBeenCalledTimes(1);
  expect(f.request.mock.calls[1]![1]).toMatchObject({ instanceId });
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.request.mock.calls[0]![1]).toEqual({ targets: [{ host: syntheticHost, sessionId: input.session_id }] });
});

it("does not adopt a replacement generation observed while checking relay liveness", async () => {
  const store = new SessionMessageStore(":memory:");
  const target = { host: syntheticHost, sessionId: input.session_id };
  const hostProcess = { ...options().hostProcess };
  const currentInstance = "host-process-v1:" + "b".repeat(64);
  const at = Date.now();
  store.startPresence({ ...target, instanceId: currentInstance, transport: "gemini-queue",
    wakeVisibility: "user-message", canWakeSilently: false }, at);
  store.send({ sender: { host: "synthetic-peer", sessionId: "sender" }, target, body: "replacement body" }, at + 1);
  const snapshot = () => ["messages", "input_observations", "session_activity", "session_presence"]
    .map(table => store.database.prepare(`SELECT * FROM ${table}`).all());
  const before = snapshot();
  f.request.mockImplementation(async (operation, payload) => {
    if (operation === "list-presence") {
      hostProcess.startToken = "T2";
      return { sessions: [{ ...livePresence, instanceId: currentInstance }] };
    }
    return dispatchSessionMessageBrokerOperation(store, operation, payload);
  });
  try {
    await expect(handleSessionMessageHook(post, syntheticHost, undefined, recover(() => hostProcess)))
      .rejects.toThrow("current host process generation");
    expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["list-presence", "claim-deferred"]);
    expect(f.request.mock.calls[1]![1]).toMatchObject({ instanceId });
    expect(snapshot()).toEqual(before);
    expect(f.spawn).not.toHaveBeenCalled();
  } finally { store.close(); }
});

it("does not query or claim when the adapter cannot observe the event's process generation", async () => {
  await expect(handleSessionMessageHook(post, syntheticHost, undefined, recover(() => null)))
    .rejects.toThrow("generation is unavailable");
  expect(f.request).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
});

it("recovers a missing relay through the same non-replayed verified grant, then claims once", async () => {
  const resolver = vi.fn(() => options().hostProcess);
  const onClaimState = vi.fn();
  f.request.mockImplementation(async (operation, _payload, _directory, requestOptions) => {
    if (operation === "list-presence") return { sessions: [{ ...livePresence, autoWake: { state: "no-live-relay" } }] };
    if (operation === "ensure-relay") return grant();
    requestOptions?.onOperationWrite?.();
    return { messages: [] };
  });
  await handleSessionMessageHook(post, syntheticHost, undefined, { ...recover(resolver), onClaimState });
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["list-presence", "ensure-relay", "claim-deferred"]);
  expect(resolver).toHaveBeenCalledTimes(1);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  const args = f.spawn.mock.calls[0]![1] as string[];
  expect(args[args.indexOf("--relay-id") + 1]).toBe(relayId);
  expect(f.request.mock.calls[1]![3]).toMatchObject({ noOperationReplay: true, deadlineMonotonicMs: 1000 });
  expect(f.request.mock.calls[2]![3]).toMatchObject({ noOperationReplay: true, deadlineMonotonicMs: 800 });
  expect(onClaimState.mock.calls.map(([state]) => state.phase)).toEqual(["request-attempted", "response-received"]);
});

it("동기 복구 자식을 비동기 수명 소유자에게 넘기지 않는다", async () => {
  const relayOwner = vi.fn();
  f.request.mockImplementation(async (operation) => {
    if (operation === "list-presence") return { sessions: [] };
    if (operation === "ensure-relay") return grant();
    return { messages: [] };
  });
  await handleSessionMessageHook(post, syntheticHost, undefined,
    { ...recover(() => options().hostProcess), relayOwner });
  const child = f.spawn.mock.results[0]!.value;
  expect(f.spawn.mock.calls[0]![2]).toMatchObject({ detached: true });
  expect(child.unref).toHaveBeenCalledTimes(1);
  expect(relayOwner).not.toHaveBeenCalled();
});

it.each(["unknown-result", "invalid-grant", "pid-reused"])("never falls back to legacy startup during recovery: %s", async (failure) => {
  f.request.mockImplementation(async (operation) => {
    if (operation === "list-presence") return { sessions: [] };
    if (operation === "ensure-relay") {
      if (failure === "unknown-result") throw new Error("response unknown");
      return { ...grant(), relayId: "invalid" };
    }
    return { messages: [] };
  });
  if (failure === "pid-reused") f.token.mockReturnValue("T2");
  const handling = handleSessionMessageHook(post, syntheticHost, undefined, recover(() => options().hostProcess));
  if (failure === "pid-reused") {
    await expect(handling).rejects.toThrow("generation did not verify");
    expect(f.request).not.toHaveBeenCalled();
  } else {
    await handling;
  }
  expect(f.request.mock.calls.filter(([operation]) => operation === "ensure-relay")).toHaveLength(failure === "pid-reused" ? 0 : 1);
  expect(f.request.mock.calls.some(([operation]) => operation === "presence-start")).toBe(false);
  expect(f.spawn).not.toHaveBeenCalled();
});

it.each([
  {role: "root", basis: "unavailable", reasonCode: "SYNTHETIC_RELAY_ROOT_UNAVAILABLE"},
  {role: "indeterminate", basis: "unavailable", reasonCode: "SYNTHETIC_RELAY_INDETERMINATE"},
  {role: "child", basis: "observed", reasonCode: "SYNTHETIC_RELAY_CHILD"},
])("does not create a recovery relay for a non-authorizing synthetic $role/$basis actor", async (actor) => {
  const resolver = vi.fn(() => options().hostProcess);
  f.request.mockResolvedValue({ messages: [] });
  await handleSessionMessageHook({ ...post, syntheticActor: actor }, syntheticHost, undefined, recover(resolver));
  expect(f.request.mock.calls.some(([operation]) => operation === "list-presence" || operation === "ensure-relay")).toBe(false);
  expect(resolver).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
});

it("does not recover or claim after the caller deadline expires in the lazy resolver", async () => {
  f.request.mockResolvedValue({ sessions: [] });
  const resolver = vi.fn(() => { f.now = 1000; return options().hostProcess; });
  await expect(handleSessionMessageHook(post, syntheticHost, undefined, recover(resolver))).rejects.toThrow("budget expired");
  expect(f.request).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
});

it("accepts an opaque new host with an adapter delivery contract using unchanged verified startup", async () => {
  const syntheticDigest = "da4b99aac7c154200f7b737c408680a7f16017f59de7fd08608952901f88fe6d";
  const syntheticInstance = "host-process-v1:" + syntheticDigest;
  const syntheticRelay = "verified-relay-v1:11111111-1111-4111-8111-111111111111:" + syntheticDigest;
  registerHookHostAdapter("synthetic-host", {
    adaptInput: (input, selectedHost) => {
      const adapted = adaptHostInput(input, "codex");
      return {...adapted, observation: {...adapted.observation, host: selectedHost,
        actor: {role: "root", basis: "observed", reasonCode: "SYNTHETIC_OPAQUE_RELAY_ROOT"}}};
    },
    deliveryProfile: () => ({ transport: "gemini-queue", capabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" }, blocksEmptyWakePrompt: false }),
    processPid: (pid) => pid,
  });
  f.request.mockResolvedValue({ spawn: true, instanceId: syntheticInstance, relayId: syntheticRelay });
  await handleSessionMessageHook(input, "synthetic-host", 424242, options());
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.request.mock.calls[0]![1].target).toEqual({ host: "synthetic-host", sessionId: input.session_id });
  expect(f.spawn).toHaveBeenCalledTimes(1);
  const args = f.spawn.mock.calls[0]![1] as string[];
  expect(args[args.indexOf("--host") + 1]).toBe("synthetic-host");
  expect(args[args.indexOf("--relay-id") + 1]).toBe(syntheticRelay);
});

it("does not silently map an opaque host without delivery capabilities to Codex", async () => {
  await expect(handleSessionMessageHook(input, "unregistered-host", 424242, options())).rejects.toThrow("host delivery adapter is required");
  expect(f.request).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled();
});

it("keeps ordinary no-op quiet but reports malformed input without copying its body", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await runSessionMessageHook(syntheticHost, "{}", undefined)).toBe("");
    expect(stderr).not.toHaveBeenCalled();
    expect(await runSessionMessageHook(syntheticHost, "{secret-canary-token", undefined)).toBe("");
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0]![0]).toContain('"phase":"input"');
    expect(stderr.mock.calls[0]![0]).toContain('"reason":"INVALID_JSON"');
    expect(stderr.mock.calls[0]![0]).not.toContain("secret-canary-token");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  } finally { stderr.mockRestore(); }
});

it.each(["null", "[]", "1"])("rejects invalid hook input shape with a fixed diagnostic: %s", async (raw) => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await runSessionMessageHook(syntheticHost, raw)).toBe("");
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"reason":"INVALID_HOOK_INPUT"'));
    expect(f.request).not.toHaveBeenCalled();
  } finally { stderr.mockRestore(); }
});

it("does not spawn a legacy relay after presence registration fails", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const failure = Object.assign(new Error("secret-canary config path and token"), { code: "ECONNREFUSED" });
  f.request.mockRejectedValue(failure);
  try {
    expect(await handleSessionMessageHook(input, syntheticHost, 424242, { ...options(), ensureRelay: false })).toEqual({});
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]![0]).toBe("presence-start");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(stderr.mock.calls[0]![0]).toContain('"phase":"presence-start"');
    expect(stderr.mock.calls[0]![0]).toContain('"reason":"ECONNREFUSED"');
    expect(stderr.mock.calls[0]![0]).not.toContain("secret-canary");
  } finally { stderr.mockRestore(); }
});

it.each(["codex", "claude-code", "gemini", "antigravity", syntheticHost])("keeps a late %s SessionEnd from mutating current input, delivery or activity", async (host) => {
  const store = new SessionMessageStore(":memory:");
  const target = { host, sessionId: input.session_id };
  const sender = { host: "synthetic-peer", sessionId: "sender" };
  const now = Date.now() - 1000;
  f.request.mockImplementation(async (operation, payload) => dispatchSessionMessageBrokerOperation(store, operation, payload));
  try {
    const presence = { ...target, transport: "synthetic-transport", wakeVisibility: "none" as const, canWakeSilently: false };
    store.startPresence({ ...presence, instanceId: "old-generation" }, now - 2);
    store.startPresence({ ...presence, instanceId: "new-generation" }, now - 1);
    expect(store.acquireRelay({ ...target, transport: presence.transport, relayId: "new-relay", pid: 200, parentPid: 100 }, now)).toBe(true);
    expect(store.presence(target, now).instanceId).toBe("new-generation");
    store.send({ messageId: "late-end-acked", sender, target, body: "acked" }, now);
    expect(store.reserveWake(target, "late-end-wake-abcdefghijklmnop", now + 1)).toBe(true);
    const ackedClaim = store.claim(target, now + 2);
    expect(ackedClaim.map(message => message.messageId)).toEqual(["late-end-acked"]);
    expect(store.acknowledge(target, ["late-end-acked"], now + 3, ackedClaim.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
    store.send({ messageId: "late-end-claimed", sender, target, body: "claimed" }, now + 4);
    const priorClaim = store.claim(target, now + 5);
    expect(priorClaim.map(message => message.messageId)).toEqual(["late-end-claimed"]);
    store.send({ messageId: "late-end-queued", sender, target, body: "queued" }, now + 6);
    store.observeNativeInput(target, now + 7);
    const snapshot = () => Object.fromEntries([
      "input_observations", "messages", "wake_nonces", "session_activity", "session_presence", "relay_leases",
    ].map(table => [table, store.database.prepare(`SELECT * FROM ${table}`).all()]));
    const before = snapshot();
    expect(await handleSessionMessageHook({ ...input, hook_event_name: "SessionEnd" }, host)).toEqual({});
    expect(snapshot()).toEqual(before);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(store.claimDeferred(target, now + 8)).toEqual([]);
    const queuedClaim = store.claimDeferred(target, now + 9);
    expect(queuedClaim.map(message => message.messageId)).toEqual(["late-end-queued"]);
    expect(store.acknowledge(target, ["late-end-claimed", "late-end-queued"], now + 10, [...priorClaim, ...queuedClaim].map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(2);
  } finally { store.close(); }
});

it("reports remaining turn-end cleanup failure without blocking or manufacturing a relay", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  f.request.mockRejectedValue(Object.assign(new Error("secret-canary"), { code: "ETIMEDOUT" }));
  try {
    expect(await runSessionMessageHook(syntheticHost, JSON.stringify({ ...input, hook_event_name: "Stop" }))).toBe("");
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]![0]).toBe("clear-deferred");
    expect(stderr.mock.calls[0]![0]).toContain('"phase":"handle"');
    expect(stderr.mock.calls[0]![0]).toContain('"reason":"ETIMEDOUT"');
    expect(stderr.mock.calls[0]![0]).not.toContain("secret-canary");
    expect(f.spawn).not.toHaveBeenCalled();
  } finally { stderr.mockRestore(); }
});

it("does not retry an uncertain startup result and never logs its raw cause", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  f.request.mockRejectedValue(Object.assign(new Error("secret-canary"), { code: "ECONNRESET", cause: { token: "secret-canary" } }));
  try {
    await handleSessionMessageHook(input, syntheticHost, 424242, options());
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(stderr.mock.calls[0]![0]).toContain('"phase":"ensure-relay"');
    expect(stderr.mock.calls[0]![0]).not.toContain("secret-canary");
  } finally { stderr.mockRestore(); }
});

it("does not trust arbitrary diagnostic codes or throw when stderr itself fails", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const failure = Object.assign(new Error("secret-canary"), { code: "SECRET_CANARY" });
  f.request.mockRejectedValue(failure);
  try {
    await handleSessionMessageHook(input, syntheticHost, 424242, options());
    expect(stderr.mock.calls[0]![0]).toContain('"reason":"UNEXPECTED_FAILURE"');
    expect(stderr.mock.calls[0]![0]).not.toContain("SECRET_CANARY");
    stderr.mockImplementation(() => { throw new Error("secret-canary sink"); });
    expect(await runSessionMessageHook(syntheticHost, "{")).toBe("");
  } finally { stderr.mockRestore(); }
});
