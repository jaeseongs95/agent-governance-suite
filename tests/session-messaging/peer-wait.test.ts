import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { nativePeerWait, adaptHostInput } from "../../mcp-server/src/host-input-adapter.js";
import { PeerWaitPolicy } from "../../mcp-server/src/peer-wait-policy.js";
import { dispatchSessionMessageBrokerOperation as dispatch } from "../../mcp-server/src/session-message-broker.js";
import { requestSessionMessageOnce, waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";

const sender = { host: "codex", sessionId: "peer-wait-owner" };
const target = { host: "codex", sessionId: "peer-wait-worker" };
const root = process.env.PEER_WAIT_TEST_PLUGIN_ROOT ?? fileURLToPath(new URL("../../", import.meta.url));
const children: ChildProcess[] = [];
const directories: string[] = [];
const stores: SessionMessageStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill(); await exited;
    }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 10 });
});

function observedWait(overrides: Record<string, unknown> = {}) {
  return adaptHostInput({ hook_event_name: "PreToolUse", session_id: sender.sessionId, agent_id: "",
    tool_name: "mcp__codex_app__wait_threads", tool_input: { targets: [{ threadId: target.sessionId }], timeoutMs: 60_000 }, ...overrides }, "codex").observation;
}
function storeFixture() {
  const store = new SessionMessageStore(":memory:"); stores.push(store);
  store.send({ sender, target, messageId: "outgoing-peer", body: "Synthetic request" });
  dispatch(store, "presence-start", { target: sender, instanceId: "generation-1", transport: "codex-queue", wakeVisibility: "user-message",
    canWakeSilently: false, supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" });
  dispatch(store, "acquire-relay", { target: sender, instanceId: "generation-1", transport: "codex-queue", relayId: "live-relay", pid: process.pid, parentPid: process.pid });
  return store;
}
function proveWake(store: SessionMessageStore) {
  store.send({ sender: target, target: sender, messageId: "incoming-peer", body: "Synthetic reply" });
  dispatch(store, "reserve-wake", { target: sender, nonce: "nonce-peer-wait-fixture" });
  expect(dispatch(store, "claim-wake", { target: sender, nonces: ["nonce-peer-wait-fixture"] })).toMatchObject({ recognized: true });
}
function decision(store: SessionMessageStore, timeoutMs = 60_000, extra: Record<string, unknown> = {}) {
  return dispatch(store, "peer-wait", { sender, targets: [target], timeoutMs, ...extra });
}

describe("peer wait policy boundaries", () => {
  it("recognizes exactly the local native wait surface and arguments", () => {
    expect(nativePeerWait(observedWait())).toMatchObject({ targets: [target], timeoutMs: 60_000 });
    expect(nativePeerWait(observedWait({ tool_input: { targets: [{ threadId: target.sessionId, hostId: "local" }], timeoutMs: 0 } }))).toMatchObject({ timeoutMs: 0 });
    expect(nativePeerWait(observedWait({ tool_input: { targets: [{ threadId: target.sessionId }] } }))).toMatchObject({ timeoutMs: 120_000 });
    for (const tool_name of ["wait_threads", "mcp__other__wait_threads", "clock.sleep", "functions.wait", "exec_command"]) {
      expect(nativePeerWait(observedWait({ tool_name }))).toBeNull();
    }
    for (const tool_input of [{ targets: [] }, { targets: [{ threadId: target.sessionId, hostId: "remote-control:test" }] },
      { targets: [{ threadId: "bad id" }] }, { targets: [{ threadId: target.sessionId }], timeoutMs: -1 }]) {
      expect(nativePeerWait(observedWait({ tool_input }))).toBeNull();
    }
  });

  it("requires a consumed wake in addition to live exact-generation presence", () => {
    const store = storeFixture();
    expect(decision(store)).toMatchObject({ action: "bounded", resume: "unknown" });
    proveWake(store);
    expect(decision(store)).toMatchObject({ action: "deny", reason: "async-resume", resume: "observed" });
  });

  it("allows one snapshot, suppresses unchanged repeats and resets on state change or new user input", () => {
    const store = storeFixture(); proveWake(store);
    expect(decision(store, 0)).toMatchObject({ action: "snapshot" });
    expect(decision(store, 0)).toMatchObject({ action: "deny", reason: "unchanged-peer-state" });
    expect(decision(store, 0, { queryRevision: "new-observed-cursor" })).toMatchObject({ action: "snapshot" });
    store.acknowledge(sender, ["incoming-peer"]);
    expect(decision(store, 0)).toMatchObject({ action: "snapshot" });
    dispatch(store, "observe-native-input", { target: sender });
    expect(decision(store, 0)).toMatchObject({ action: "snapshot" });
  });

  it("does not restrict mixed or unrelated targets even with a working resume path", () => {
    const store = storeFixture(); proveWake(store);
    expect(decision(store, 60_000, { targets: [target, { host: "codex", sessionId: "unrelated" }] })).toMatchObject({ action: "bounded", transmission: "unknown" });
  });

  it.each(["presence-expired", "relay-expired", "wake-expired", "new-generation", "instance-mismatch", "no-idle-wake", "dead-relay"])("does not deny when %s", (reason) => {
    const store = storeFixture(); proveWake(store);
    const now = Date.now();
    if (reason === "presence-expired") store.database.prepare("UPDATE session_presence SET lease_until = ?").run(new Date(now - 1).toISOString());
    if (reason === "relay-expired") store.database.prepare("UPDATE relay_leases SET lease_until = ?").run(new Date(now - 1).toISOString());
    if (reason === "wake-expired") {
      const clock = vi.spyOn(Date, "now");
      for (const offset of [10_000, 20_000, 31_000]) {
        clock.mockReturnValue(now + offset);
        store.heartbeatPresence(sender, "generation-1");
        dispatch(store, "heartbeat-relay", { target: sender, instanceId: "generation-1", transport: "codex-queue", relayId: "live-relay" });
      }
    }
    if (reason === "new-generation") dispatch(store, "presence-start", { target: sender, instanceId: "generation-2", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, supportedInjection: ["peer-wake"], idleWake: "user-message" });
    if (reason === "instance-mismatch") {
      store.database.prepare("DELETE FROM relay_leases").run();
      dispatch(store, "acquire-relay", { target: sender, instanceId: "wrong-generation", transport: "codex-queue", relayId: "replacement", pid: process.pid, parentPid: process.pid });
    }
    if (reason === "no-idle-wake") store.database.prepare("UPDATE session_presence SET idle_wake = 'none'").run();
    if (reason === "dead-relay") store.database.prepare("UPDATE relay_leases SET pid = ?").run(2147483647);
    expect(decision(store)).toMatchObject({ action: "bounded", resume: "unknown" });
  });

  it("does not promote supplied capability, ACK or old relay registration to resume", () => {
    const store = storeFixture();
    store.acknowledge(target, ["outgoing-peer"]);
    expect(decision(store, 60_000, { resumeObserved: true, approved: true, capabilities: { idleWake: "silent" } })).toMatchObject({ action: "bounded", resume: "unknown" });
  });

  it("does not attach an old generation nonce to a replacement instance", () => {
    const store = storeFixture();
    store.send({ sender: target, target: sender, messageId: "old-generation-reply", body: "Synthetic reply" });
    dispatch(store, "reserve-wake", { target: sender, nonce: "nonce-before-generation-change" });
    dispatch(store, "presence-start", { target: sender, instanceId: "generation-2", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, supportedInjection: ["peer-wake"], idleWake: "user-message" });
    dispatch(store, "acquire-relay", { target: sender, instanceId: "generation-2", transport: "codex-queue", relayId: "new-relay", pid: process.pid, parentPid: process.pid });
    expect(dispatch(store, "claim-wake", { target: sender, nonces: ["nonce-before-generation-change"] })).toMatchObject({ recognized: true });
    expect(decision(store)).toMatchObject({ action: "bounded", resume: "unknown" });
  });

  it("requires valid nonces and does not infer resume from ordinary peer delivery", () => {
    const store = storeFixture();
    expect(dispatch(store, "claim-wake", { target: sender, nonces: ["invalid-nonce-peer-wait"] })).toMatchObject({ recognized: false });
    dispatch(store, "claim", { target });
    expect(decision(store)).toMatchObject({ action: "bounded", resume: "unknown" });
  });

  it("expires snapshot records without timers and leaves no restart state", () => {
    const policy = new PeerWaitPolicy();
    const input = { sender, targets: [target], timeoutMs: 0, peersObserved: true, resumeObserved: true, fingerprint: "same" };
    expect(policy.decide(input, 1000).action).toBe("snapshot");
    expect(policy.decide(input, 1001).action).toBe("deny");
    expect(policy.decide(input, 31_000).action).toBe("snapshot");
    expect(new PeerWaitPolicy().decide(input, 1002).action).toBe("snapshot");
  });
});

async function launch(brokerPath = path.join(root, "mcp-server/dist/session-message-broker.mjs")) {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-peer-wait-")); directories.push(directory);
  const child = spawn(process.execPath, ["--import", new URL("./fixtures/peer-wait-request-count.mjs", import.meta.url).href, brokerPath, "--state-directory", directory], { windowsHide: true, stdio: "ignore", env: { ...process.env, AGS_PEER_WAIT_COUNT_PATH: path.join(directory, "peer-wait-count.txt") } }); children.push(child);
  await waitForSessionMessageBrokerReady(directory, child, 5000);
  return { directory, child };
}
function packaged(directory: string, entry: string, input: unknown) {
  const result = spawnSync(process.execPath, [path.join(root, "mcp-server/dist", entry)], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 5000, windowsHide: true,
    env: { ...process.env, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: directory, AGENT_GOVERNANCE_CODEX_QUEUE_WAKE: "1" },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout ? JSON.parse(result.stdout) : {};
}
async function preparePackaged(directory: string) {
  await requestSessionMessageOnce("send", { sender, target, messageId: "packaged-request", body: "Synthetic request" }, directory);
  await requestSessionMessageOnce("presence-start", { target: sender, instanceId: "packaged-instance", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" }, directory);
  await requestSessionMessageOnce("acquire-relay", { target: sender, instanceId: "packaged-instance", transport: "codex-queue", relayId: "packaged-relay", pid: process.pid, parentPid: process.pid }, directory);
  await requestSessionMessageOnce("send", { sender: target, target: sender, messageId: "packaged-reply", body: "Synthetic reply" }, directory);
  await requestSessionMessageOnce("reserve-wake", { target: sender, nonce: "nonce-packaged-peer-wait" }, directory);
  packaged(directory, "session-message-hook.mjs", { hook_event_name: "UserPromptSubmit", session_id: sender.sessionId, agent_id: "", prompt: "[agent-governance-suite:wake:nonce-packaged-peer-wait]" });
}
const hookInput = (timeoutMs: number, extra: Record<string, unknown> = {}) => ({ hook_event_name: "PreToolUse", session_id: sender.sessionId, agent_id: "", tool_name: "mcp__codex_app__wait_threads", tool_input: { targets: [{ threadId: target.sessionId }], timeoutMs }, ...extra });

it("enforces native wait through the public packaged hook and preserves unrelated waits", async () => {
  const { directory } = await launch(); await preparePackaged(directory);
  expect(packaged(directory, "session-message-hook.mjs", hookInput(60_000))).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(packaged(directory, "session-message-hook.mjs", hookInput(0)).hookSpecificOutput.permissionDecision).toBeUndefined();
  expect(packaged(directory, "session-message-hook.mjs", hookInput(0))).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  for (const extra of [{ tool_name: "clock.sleep" }, { tool_name: "exec_command" }, { agent_id: "child" }, { agent_id: undefined },
    { tool_input: { targets: [{ threadId: target.sessionId }, { threadId: "other-chat" }], timeoutMs: 60_000 } }]) {
    expect(packaged(directory, "session-message-hook.mjs", hookInput(60_000, extra)).hookSpecificOutput?.permissionDecision).not.toBe("deny");
  }
  const config = JSON.parse(await readFile(path.join(root, "hooks/hooks.json"), "utf8"));
  expect(config.hooks.PreToolUse.some((entry: { matcher: string }) => new RegExp(entry.matcher).test("mcp__codex_app__wait_threads"))).toBe(true);
}, 20_000);

it("the public CLI consumes the decision before delay and sends no repeated poll when denied", async () => {
  const { directory } = await launch(); await preparePackaged(directory);
  const output = packaged(directory, "session-message-cli.mjs", { operation: "wait", payload: { sender, targets: [target], timeoutMs: 60_000 } });
  expect(output.data).toMatchObject({ decision: { action: "deny" }, waitedMs: 0, next: "peer-resume" });
  expect(output.data.snapshot).toEqual(output.data.decision);
  expect(await readFile(path.join(directory, "peer-wait-count.txt"), "utf8")).toBe("1");
  const endpoint = JSON.parse(await readFile(path.join(directory, "endpoint.json"), "utf8"));
  expect(endpoint.pid).toBe(children.at(-1)!.pid);
}, 15_000);

it("CLI unknown resume uses one bounded wait and does not force permanent stopping", async () => {
  const { directory } = await launch();
  await requestSessionMessageOnce("send", { sender, target, body: "Synthetic request" }, directory);
  const output = packaged(directory, "session-message-cli.mjs", { operation: "wait", payload: { sender, targets: [target], timeoutMs: 60_000, resumeObserved: true } });
  expect(output.data).toMatchObject({ decision: { action: "bounded", resume: "unknown" }, waitedMs: 1000, next: "bounded-query-or-next-user-turn" });
  expect(await readFile(path.join(directory, "peer-wait-count.txt"), "utf8")).toBe("2");
}, 15_000);

it("broker restart preserves messages but drops resume and repeat-suppression evidence", async () => {
  const { directory, child } = await launch(); await preparePackaged(directory);
  const exited = once(child, "exit"); child.kill(); await exited;
  const replacement = spawn(process.execPath, [path.join(root, "mcp-server/dist/session-message-broker.mjs"), "--state-directory", directory], { windowsHide: true, stdio: "ignore" }); children.push(replacement);
  await waitForSessionMessageBrokerReady(directory, replacement, 5000);
  expect(packaged(directory, "session-message-hook.mjs", hookInput(60_000)).hookSpecificOutput?.permissionDecision).not.toBe("deny");
  expect(await requestSessionMessageOnce("status", { sender, messageId: "packaged-request" }, directory)).toMatchObject({ status: { state: "queued" } });
}, 15_000);
