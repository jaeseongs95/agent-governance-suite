import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ now: 100, request: vi.fn(), spawn: vi.fn() }));
vi.mock("node:perf_hooks", () => ({ performance: { now: () => boundary.now, timeOrigin: 0 } }));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawn: boundary.spawn,
}));
vi.mock("../../mcp-server/src/session-message-client.js", async original => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: boundary.request,
}));
import { adaptHostInput, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { dispatchSessionMessageOperation } from "../../mcp-server/src/session-message-operations.js";
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import type { ActorObservation } from "../../mcp-server/src/input-observation.js";

// The real hook, operation table and store are connected; only child spawn is injected. The hook queries no process
// identity: the adapter-observed birth (hostProcess) is the generation, and ensure-relay fences stale births.
const host = "synthetic-session-start-generation-fence";
const actor: ActorObservation = { role: "root", basis: "observed", reasonCode: "SYNTHETIC_SESSION_START_ROOT" };
const input = { hook_event_name: "SessionStart", session_id: "session-start-generation-fence", syntheticActor: actor };
const turnEnd = { hook_event_name: "Stop", session_id: input.session_id, syntheticActor: actor };
const target = { host, sessionId: input.session_id };
const transport = "antigravity-queue";
const tables = ["messages", "prepared_messages", "input_observations", "wake_paths", "wake_nonces", "session_presence", "relay_leases"];
const stores: SessionMessageStore[] = [];
const directories: string[] = [];
const now = Date.UTC(2026, 9, 30);
type Grant = { spawn: boolean; relayId: string | null; instanceId: string; reason?: string };

registerHookHostAdapter(host, {
  adaptInput: (payload, observedHost) => {
    const mapped = adaptHostInput(payload, "codex");
    return { ...mapped, observation: { ...mapped.observation, host: observedHost, actor: payload.syntheticActor as ActorObservation } };
  },
  deliveryProfile: () => ({
    transport, capabilities: { supportedInjection: ["peer-wake", "turn-end"], idleWake: "user-message" }, blocksEmptyWakePrompt: false,
  }),
  processPid: (pid, observation) => observation ? pid : undefined,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const clock = { value: now };
  const store = new SessionMessageStore(":memory:", { clock: () => clock.value });
  stores.push(store);
  const state = mkdtempSync(path.join(tmpdir(), "ags-session-start-fence-"));
  directories.push(state);
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", state);
  const tokens = new Map([[101, "parent-A"], [102, "parent-B"], [103, "parent-C"]]);
  boundary.now = 100;
  boundary.request.mockReset(); boundary.spawn.mockReset();
  boundary.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("AGENT_GOVERNANCE_ANTIGRAVITY_QUEUE_WAKE", "1");
  const birth = (pid: number) => "host-process-v1:" + createHash("sha256")
    .update(JSON.stringify([target.host, target.sessionId, pid, tokens.get(pid)])).digest("hex");
  const payload = (pid: number) => ({ target, transport, parentPid: pid, parentStartToken: tokens.get(pid)!,
    wakeVisibility: "user-message", idleWake: "user-message", canWakeSilently: false, supportedInjection: ["peer-wake", "turn-end"] });
  const dispatch = (pid: number, extra: Record<string, unknown> = {}) =>
    dispatchSessionMessageOperation(store, "ensure-relay", { ...payload(pid), ...extra }) as Grant;
  const grants: Grant[] = [];
  /** Called inside the hook's ensure-relay request, before the store runs it (a concurrent writer). */
  const beforeEnsure: { run: ((data: Record<string, unknown>) => void) | undefined } = { run: undefined };
  const afterEnsure: { snapshot?: ReturnType<typeof snapshot> } = {};
  boundary.request.mockImplementation(async (operation: string, data: Record<string, unknown>) => {
    if (operation === "ensure-relay") beforeEnsure.run?.(data);
    const result = dispatchSessionMessageOperation(store, operation, data);
    if (operation === "ensure-relay") { grants.push(result as Grant); afterEnsure.snapshot = snapshot(); }
    return result;
  });
  const budget = { executionBudget: { deadlineMonotonicMs: 1000, postClaimReserveMs: 200 } };
  const hook = (pid: number) => handleSessionMessageHook(input, host, pid, {
    ensureRelay: true, hostProcess: { pid, startToken: tokens.get(pid)! }, ...budget,
  });
  /** A boundary hook of host pid that finds no live relay and recovers its own verified birth. */
  const recover = (pid: number) => handleSessionMessageHook(turnEnd, host, pid, {
    recoverExistingSession: true, hostProcess: { pid, startToken: tokens.get(pid)! }, ...budget,
  });
  const relay = () => store.liveRelay(target, transport)!;
  /** The relay's first tick binds the watcher's birth; release is its normal end (host process ended). */
  const serve = (pid: number) => {
    expect(store.relayTick({ ...target, transport, relayId: relay().relayId, instanceId: birth(pid), includePending: false,
      hostStart: tokens.get(pid)! })).toMatchObject({ alive: true, hostBound: true });
  };
  const release = (pid: number) => {
    expect(store.releaseRelay({ ...target, transport, instanceId: birth(pid), relayId: relay().relayId, reason: "host-process-ended" })).toBe(true);
    expect(store.liveRelay(target, transport)).toBeNull();
    expect(store.presence(target)).toMatchObject({ instanceId: birth(pid), endedAt: expect.any(String) });
  };
  const protectReceipt = (pid: number) => {
    const sender = { host: "synthetic-peer", sessionId: "protected-session-start-receipt" };
    const prepared = store.prepare({ sender, target, body: "늦은 이전 세대 예약이 바꾸면 안 되는 본문" });
    store.submitPrepared(sender, prepared.messageId);
    expect(store.reserveManagedWake({ ...target, transport, instanceId: birth(pid), relayId: relay().relayId,
      nonce: "protected-session-start-wake-abcdefghijklmnop" }).dispatch).toBe(true);
    const claimed = store.claimTurnEnd(target, now, { instanceId: birth(pid) });
    expect(claimed).toMatchObject([{ messageId: prepared.messageId, claimReceipt: expect.any(String) }]);
    store.observeNativeInput(target, now, birth(pid));
    return claimed[0]!;
  };
  const snapshot = () => Object.fromEntries(tables.map(table =>
    [table, store.database.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()]));
  return { store, clock, tokens, birth, dispatch, hook, recover, serve, release, protectReceipt, snapshot, grants, beforeEnsure, afterEnsure };
}

// CONC-FENCE-002 / DIST-ORDER-004: a normal end and a new birth are told apart, and an old birth is never revived.
it("a real SessionStart grants and spawns B after A ended normally, and refuses re-registering A after B", async () => {
  const f = fixture();
  await f.hook(101);
  expect(f.grants[0]).toMatchObject({ spawn: true, instanceId: f.birth(101), relayId: expect.any(String) });
  f.serve(101);
  f.release(101);
  await f.hook(102);
  expect(f.grants[1]).toMatchObject({ spawn: true, instanceId: f.birth(102), relayId: expect.any(String) });
  expect(f.store.presence(target)).toMatchObject({ instanceId: f.birth(102), state: "online", endedAt: null });
  expect(f.store.liveRelay(target, transport)).toMatchObject({ instanceId: f.birth(102), relayId: f.grants[1]!.relayId });
  expect(boundary.spawn).toHaveBeenCalledTimes(2);
  for (const index of [0, 1]) {
    const request = boundary.request.mock.calls[index]!;
    expect(request[0]).toBe("ensure-relay");
    expect(Object.hasOwn(request[1], "expectedPresenceInstanceId")).toBe(false);
    expect(request[3]).toMatchObject({ noOperationReplay: true, deadlineMonotonicMs: 1000 });
    const args = boundary.spawn.mock.calls[index]![1] as string[];
    const pid = 101 + index;
    expect(args[args.indexOf("--instance-id") + 1]).toBe(f.birth(pid));
    expect(args[args.indexOf("--parent-pid") + 1]).toBe(String(pid));
    expect(args[args.indexOf("--parent-start-token") + 1]).toBe(f.tokens.get(pid));
    expect(args[args.indexOf("--relay-id") + 1]).toBe(f.grants[index]!.relayId);
    expect(boundary.spawn.mock.calls[index]![2]).toMatchObject({ detached: true, windowsHide: true, stdio: "ignore" });
  }
  const before = f.snapshot();
  await f.hook(101);
  expect(f.grants[2]).toEqual({ spawn: false, relayId: null, instanceId: f.birth(101), reason: "GENERATION_SUPERSEDED" });
  expect(boundary.spawn).toHaveBeenCalledTimes(2);
  expect(f.snapshot()).toEqual(before);
});

it("a late recovery of B is refused by the A it observed when C registered and ended in between", async () => {
  const f = fixture();
  await f.hook(101);
  f.serve(101);
  const receipt = f.protectReceipt(101);
  f.release(101);
  boundary.spawn.mockClear();
  f.beforeEnsure.run = (data) => {
    // The hook read A from list-presence; C registers and ends before B's ensure runs. The owner is empty again.
    expect(data.expectedPresenceInstanceId).toBe(f.birth(101));
    f.beforeEnsure.run = undefined;
    expect(f.dispatch(103)).toMatchObject({ spawn: true, instanceId: f.birth(103) });
    f.serve(103); f.release(103);
    expect(f.store.liveRelay(target, transport)).toBeNull();
  };
  // The refused B is not the current generation, so its boundary claim is refused too (nothing is claimed for it).
  await expect(f.recover(102)).rejects.toThrow("does not belong to the current host process generation");
  const bGrant = f.grants.at(-1)!;
  expect(bGrant).toEqual({ spawn: false, instanceId: f.birth(102), relayId: null, reason: "GENERATION_CHANGED" });
  expect(boundary.spawn).not.toHaveBeenCalled();
  expect(f.store.presence(target).instanceId).toBe(f.birth(103));
  expect(f.store.database.prepare("SELECT instance_id FROM session_presence WHERE instance_id=?").get(f.birth(102))).toBeUndefined();
  expect(f.store.database.prepare("SELECT claim_receipt FROM messages WHERE message_id=?").get(receipt.messageId))
    .toMatchObject({ claim_receipt: receipt.claimReceipt });
});

it("a relay whose watcher binds another birth than the ensured one is fenced and changes nothing", async () => {
  const f = fixture();
  await f.hook(101);
  const before = f.snapshot();
  expect(f.store.relayTick({ ...target, transport, relayId: f.grants[0]!.relayId!, instanceId: f.birth(101), includePending: false,
    hostStart: "different-parent-birth" })).toEqual({ alive: false, count: 0, hostBound: false });
  expect(f.snapshot()).toEqual(before);
});

it.each([null, "explicit-other-generation"])("an explicit expectedPresence=%s is not replaced by the current A and is refused", async expected => {
  const f = fixture();
  await f.hook(101);
  f.serve(101); f.protectReceipt(101); f.release(101);
  const before = f.snapshot();
  expect(f.dispatch(102, { expectedPresenceInstanceId: expected }))
    .toEqual({ spawn: false, relayId: null, instanceId: f.birth(102), reason: "GENERATION_CHANGED" });
  expect(f.snapshot()).toEqual(before);
  expect(boundary.spawn).toHaveBeenCalledTimes(1);
});

it("a mismatched hook PID and an invalid PID do not change the existing birth", async () => {
  const f = fixture();
  await f.hook(101);
  f.serve(101); f.release(101);
  const before = f.snapshot();
  await handleSessionMessageHook(input, host, 103, { ensureRelay: true,
    hostProcess: { pid: 102, startToken: "parent-B" }, executionBudget: { deadlineMonotonicMs: 1000, postClaimReserveMs: 200 } });
  expect(boundary.request).toHaveBeenCalledTimes(1);
  expect(() => f.dispatch(102, { parentPid: 0 })).toThrow("parentPid is invalid.");
  expect(() => f.dispatch(102, { parentStartToken: " " })).toThrow("Invalid relay host observation.");
  expect(boundary.spawn).toHaveBeenCalledTimes(1);
  expect(f.snapshot()).toEqual(before);
});
