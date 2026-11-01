import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { producerFailureReason } from "../../mcp-server/src/failure-diagnostics.js";
import { hostAliveAtBound, linuxStartTicks, watchHostProcess, windowsWatchScript, type HostWatch } from "../../mcp-server/src/host-process-watch.js";
import { closeSessionMessaging, runSessionMessageOperation, sessionMessageRequest, wakeMessage } from "../../mcp-server/src/session-message-client.js";
import { runSessionMessageRelay } from "../../mcp-server/src/session-message-relay.js";
import type { WakeDispatchPort } from "../../mcp-server/src/session-message-wake-port.js";

// docs/ags30-broker-redesign.md 3.4 and 7 (techniques 5 and 6): the relay's only process-identity need is "has the host
// ended". Every oracle here is an event (bound/exited settle), never a duration.

const children: ChildProcess[] = [];
const watches: HostWatch[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const watch of watches.splice(0)) watch.close();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const directory of directories.splice(0)) {
    closeSessionMessaging(directory);
    rmSync(directory, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

async function idleChild(): Promise<ChildProcess & { pid: number }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  children.push(child);
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  return child as ChildProcess & { pid: number };
}

const exitOf = (child: ChildProcess) => new Promise<void>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve());
});

const watch = (pid: number, aliveAt: string | undefined) => {
  const watcher = watchHostProcess(pid, aliveAt, { pollMs: 10 });
  watches.push(watcher);
  return watcher;
};

const rejection = async (promise: Promise<unknown>) => producerFailureReason(await promise.then(() => null, (error: unknown) => error));

describe("linuxStartTicks", () => {
  it("reads field 22 after the last ')' even when the command name contains spaces and parentheses", () => {
    const rest = ["S", ...Array.from({ length: 18 }, (_, index) => String(index + 4)), "987654", "0"];
    expect(linuxStartTicks(`4242 (we) ird name) ${rest.join(" ")}\n`)).toBe("987654");
    expect(linuxStartTicks("4242 (short) S 1 2")).toBeNull();
  });
});

describe("watchHostProcess input", () => {
  it.each([0, -1, 1.5, Number.NaN])("refuses host pid %s before observing anything", (pid) => {
    let error: unknown;
    try { watchHostProcess(pid, undefined, { platform: "linux" }); } catch (caught) { error = caught; }
    expect(producerFailureReason(error)).toBe("HOST_PID_INVALID");
  });
});

describe.runIf(process.platform === "linux")("Linux /proc starttime watch (real child process)", () => {
  const startOf = (pid: number) => linuxStartTicks(readFileSync(`/proc/${pid}/stat`, "utf8"));

  it("binds the child's /proc starttime, then reports HOST_PROCESS_ENDED once it is killed", async () => {
    const child = await idleChild();
    const start = startOf(child.pid);
    expect(start).toMatch(/^[0-9]+$/u);
    const watcher = watch(child.pid, start!); // a bound equal to the birth is not "born after"
    await expect(watcher.bound).resolves.toBe(start);
    const exited = exitOf(child);
    child.kill("SIGKILL");
    await exited;
    await expect(watcher.exited).resolves.toBe("HOST_PROCESS_ENDED");
  });

  it("binds without a bound as well", async () => {
    const child = await idleChild();
    const watcher = watch(child.pid, undefined);
    await expect(watcher.bound).resolves.toBe(startOf(child.pid));
  });

  it.each([
    ["one tick before the child's birth", (start: string) => String(Number(start) - 1)],
    ["this test process's own start (hostAliveAtBound), which precedes the child", () => hostAliveAtBound("linux")],
  ])("refuses a process born after the bound: %s -> HOST_BORN_AFTER_BOUND", async (_name, bound) => {
    const child = await idleChild();
    const start = startOf(child.pid)!;
    const aliveAt = bound(start);
    expect(Number(aliveAt)).toBeLessThan(Number(start));
    const watcher = watch(child.pid, aliveAt);
    expect(await rejection(watcher.bound)).toBe("HOST_BORN_AFTER_BOUND");
    await expect(watcher.exited).resolves.toBe("HOST_BORN_AFTER_BOUND");
  });

  it("reports HOST_PROCESS_GONE for a pid that names no process", async () => {
    // pid_max itself is never assigned (pids are below it), so no process can hold it.
    const pid = Number(readFileSync("/proc/sys/kernel/pid_max", "utf8").trim());
    const watcher = watch(pid, undefined);
    expect(await rejection(watcher.bound)).toBe("HOST_PROCESS_GONE");
    await expect(watcher.exited).resolves.toBe("HOST_PROCESS_GONE");
  });

  it("close() settles exited as HOST_WATCH_CLOSED and stops observing", async () => {
    const child = await idleChild();
    const watcher = watch(child.pid, undefined);
    await watcher.bound;
    watcher.close();
    await expect(watcher.exited).resolves.toBe("HOST_WATCH_CLOSED");
  });
});

describe("windowsWatchScript", () => {
  const script = windowsWatchScript(4321, 1_790_000_000_123, 987);
  const at = (needle: string) => {
    const index = script.indexOf(needle);
    expect(index, needle).toBeGreaterThanOrEqual(0);
    return index;
  };

  it("opens the host handle before it reads StartTime, so the birth it reads belongs to the held process", () => {
    expect(at("GetProcessById(4321)")).toBeLessThan(at("$p.Handle"));
    expect(at("$p.Handle")).toBeLessThan(at("$p.StartTime"));
    // A missing process and an access failure are distinct fixed answers, both before any StartTime read.
    expect(at("'GONE'")).toBeLessThan(at("$p.StartTime"));
    expect(at("'DENIED'")).toBeLessThan(at("$p.StartTime"));
  });

  it("checks the bound after StartTime and before it reports the bound token", () => {
    const check = at("-gt 1790000000123");
    expect(check).toBeGreaterThan(at("$p.StartTime"));
    expect(at("'LATE'")).toBeGreaterThan(check);
    expect(check).toBeLessThan(at("'OK '"));
    expect(at("'OK '")).toBeLessThan(at("WaitForExit("));
  });

  it("omits the bound check when there is no numeric bound", () => {
    const unbounded = windowsWatchScript(4321, null, 987);
    expect(unbounded).not.toContain("LATE");
    expect(unbounded).not.toContain("-gt");
    expect(unbounded).toContain("'OK '");
  });

  it("ends itself (exit 3) when the owning relay is gone, so the watcher is never left behind", () => {
    const loop = script.slice(at("WaitForExit("));
    expect(loop).toContain("Get-Process -Id 987");
    expect(loop).toContain("exit 3");
    expect(script.indexOf("'EXIT'")).toBeGreaterThan(at("WaitForExit("));
  });
});

describe.runIf(process.platform === "win32")("Windows handle watch (real child process)", () => {
  it("binds the child through its handle, then reports HOST_PROCESS_ENDED once it is killed", async () => {
    const child = await idleChild();
    const watcher = watchHostProcess(child.pid, undefined);
    watches.push(watcher);
    await expect(watcher.bound).resolves.toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/u);
    const exited = exitOf(child);
    child.kill();
    await exited;
    await expect(watcher.exited).resolves.toBe("HOST_PROCESS_ENDED");
  });

  it("refuses a child born after this process's own start (hostAliveAtBound) -> HOST_BORN_AFTER_BOUND", async () => {
    const child = await idleChild();
    const watcher = watchHostProcess(child.pid, hostAliveAtBound("win32"));
    watches.push(watcher);
    expect(await rejection(watcher.bound)).toBe("HOST_BORN_AFTER_BOUND");
    await expect(watcher.exited).resolves.toBe("HOST_BORN_AFTER_BOUND");
  });
});

// Technique 5: the relay runs in this process against a temp state directory; the scheduler (delay), the host watcher
// and the wake port are injected, and every step is driven explicitly.
describe("runSessionMessageRelay end to end (in-process store, injected watch/delay/port)", () => {
  const target = { host: "codex", sessionId: "relay-e2e" };
  const transport = "codex-queue";
  const sender = { host: "claude-code", sessionId: "relay-e2e-sender" };

  function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  function harness(instanceId: string) {
    const directory = mkdtempSync(path.join(tmpdir(), "ags-relay-e2e-"));
    directories.push(directory);
    vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", directory);
    vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", path.join(directory, "trust.sqlite3"));
    const run = <T>(operation: string, payload: Record<string, unknown>) => runSessionMessageOperation<T>(operation, payload, directory);
    const calls: Array<{ operation: string; payload: Record<string, unknown>; result: unknown }> = [];
    const request = (async (operation: string, payload: Record<string, unknown>) => {
      const result = run(operation, payload);
      calls.push({ operation, payload, result });
      return result;
    }) as typeof sessionMessageRequest;
    const started = run<{ relayId: string | null }>("presence-start", { target, instanceId, transport, hostPid: 4242,
      wakeVisibility: "user-message", canWakeSilently: false, supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" });
    expect(started.relayId).toMatch(/^[0-9a-f-]{36}$/u);
    // Scheduler: each loop wait parks until the test releases it (or the relay stops).
    const waits: Array<{ release: () => void }> = [];
    let arrived = deferred();
    const delay = (milliseconds: number, stop: Promise<void>) => {
      expect(milliseconds).toBe(5000);
      return new Promise<void>((resolve) => {
        waits.push({ release: resolve });
        void stop.then(resolve);
        arrived.resolve();
      });
    };
    const nextWait = async () => { await arrived.promise; arrived = deferred(); };
    const release = async () => { waits.at(-1)!.release(); await nextWait(); };
    /** Releases the parked wait without expecting another one (the next tick ends the relay). */
    const releaseLast = () => { waits.at(-1)!.release(); };
    const bound = deferred<string>(), exited = deferred<string>();
    const fakeWatch = vi.fn((): HostWatch => ({ bound: bound.promise, exited: exited.promise, close: vi.fn() }));
    return { directory, run, calls, request, relayId: started.relayId!, delay, nextWait, release, releaseLast, bound, exited, fakeWatch };
  }

  const ticks = (calls: ReturnType<typeof harness>["calls"]) => calls.filter((call) => call.operation === "relay-tick");

  it("binds the host once, dispatches a pending message once through the port, and releases with host-process-ended on exit", async () => {
    const h = harness("e2e-I1");
    const prepared = h.run<{ messageId: string }>("prepare", { sender, target, body: "hello" });
    h.run("send", { sender, messageId: prepared.messageId });
    const dispatched = deferred<string>();
    const port: WakeDispatchPort = { capabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" }, resendBaseMs: 60_000,
      dispatch: vi.fn(async (_target, message: string) => { dispatched.resolve(message); return { result: "handed-off" as const }; }) };

    const relay = runSessionMessageRelay({ ...target, instanceId: "e2e-I1", transport, parentPid: 4242, relayId: h.relayId, hostAliveAt: "100" },
      port, { request: h.request, watch: h.fakeWatch, delay: h.delay });
    expect(h.fakeWatch).toHaveBeenCalledWith(4242, "100");
    await h.nextWait();
    // Tick 1: the watcher has not bound the host, so the birth is unbound and nothing rings.
    expect(ticks(h.calls)).toHaveLength(1);
    expect(ticks(h.calls)[0]!.payload).not.toHaveProperty("hostStart");
    expect(ticks(h.calls)[0]!.result).toEqual({ alive: true, count: 1, hostBound: false });
    expect(port.dispatch).not.toHaveBeenCalled();

    h.bound.resolve("start-token-1");
    await h.release();
    // Tick 2 carries the bound birth once; the store binds it and the pending message is dispatched.
    expect(ticks(h.calls)[1]!.payload).toMatchObject({ hostStart: "start-token-1" });
    expect(ticks(h.calls)[1]!.result).toEqual({ alive: true, count: 1, hostBound: true });
    const message = await dispatched.promise;
    const reserved = h.calls.find((call) => call.operation === "reserve-wake")!;
    expect(message).toBe(wakeMessage((reserved.result as { attempt: { nonce: string } }).attempt.nonce));

    await h.release();
    await h.release();
    expect(ticks(h.calls).filter((call) => Object.hasOwn(call.payload, "hostStart"))).toHaveLength(1);
    expect(ticks(h.calls).every((call) => (call.result as { alive: boolean }).alive)).toBe(true);

    h.exited.resolve("HOST_PROCESS_ENDED");
    await relay;
    expect(port.dispatch).toHaveBeenCalledTimes(1);
    expect(h.calls.filter((call) => call.operation === "start-wake" && (call.result as { dispatch: boolean }).dispatch)).toHaveLength(1);
    // Later cycles saw the same pending message but the active attempt (I5) kept them from reserving another.
    expect(h.calls.filter((call) => call.operation === "reserve-wake").slice(1).every((call) => !(call.result as { dispatch: boolean }).dispatch)).toBe(true);
    const releases = h.calls.filter((call) => call.operation === "release-relay");
    expect(releases).toEqual([expect.objectContaining({ payload: expect.objectContaining({ relayId: h.relayId, instanceId: "e2e-I1", reason: "host-process-ended" }),
      result: { released: true } })]);
    const presence = h.run<{ presence: { state: string; endReason: string | null; instanceId: string } }>("presence", { target }).presence;
    expect(presence).toMatchObject({ state: "ended", endReason: "host-process-ended", instanceId: "e2e-I1" });
    expect(h.calls.filter((call) => call.operation === "record-wake-outcome")).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ outcome: { result: "handed-off" } }), result: { recorded: true } })]);
  });

  it("ends on a fenced lease (a newer generation), and its release removes nothing of the replacement", async () => {
    const h = harness("e2e-F1");
    const port: WakeDispatchPort = { capabilities: { supportedInjection: ["peer-wake"], idleWake: "user-message" }, resendBaseMs: 60_000, dispatch: vi.fn() };
    const relay = runSessionMessageRelay({ ...target, instanceId: "e2e-F1", transport, parentPid: 4242, relayId: h.relayId },
      port, { request: h.request, watch: h.fakeWatch, delay: h.delay });
    await h.nextWait();
    h.bound.resolve("start-token-1");
    await h.release();
    expect(ticks(h.calls).at(-1)!.result).toMatchObject({ alive: true, hostBound: true });

    const replacement = h.run<{ relayId: string | null }>("presence-start", { target, instanceId: "e2e-F2", transport, hostPid: 4243,
      wakeVisibility: "user-message", canWakeSilently: false, supportedInjection: ["peer-wake"], idleWake: "user-message" });
    expect(replacement.relayId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(replacement.relayId).not.toBe(h.relayId);
    h.releaseLast();
    await relay;
    expect(ticks(h.calls).at(-1)!.result).toEqual({ alive: false, count: 0, hostBound: false });
    expect(h.calls.filter((call) => call.operation === "release-relay")).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ relayId: h.relayId, reason: "relay-ended" }), result: { released: false } })]);
    expect(port.dispatch).not.toHaveBeenCalled();
    const presence = h.run<{ presence: { state: string; instanceId: string } }>("presence", { target }).presence;
    expect(presence).toMatchObject({ state: "online", instanceId: "e2e-F2" });
  });
});
