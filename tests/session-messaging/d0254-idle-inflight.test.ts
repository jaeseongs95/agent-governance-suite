import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import tls from "node:tls";
import { afterEach, expect, it } from "vitest";
import { requestSessionMessageOnce, SESSION_MESSAGE_PROTOCOL } from "../../mcp-server/src/session-message-client.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";

interface BrokerEvent {
  type: string;
  id?: number;
  pid?: number;
  nativePid?: number;
  status?: string;
}

const resources: Array<{ root: string; child: ChildProcess }> = [];
const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };

async function waitForExit(child: ChildProcess, label: string) {
  if (running(child)) await once(child, "close");
  expect(running(child), label).toBe(false);
}

afterEach(async () => {
  for (const { root, child } of resources.splice(0)) {
    for (const pid of [424242, 424243]) {
      const directory = path.join(root, String(pid));
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "release-query"), "1");
      if (child.connected) child.send({ type: "release", pid });
    }
    if (running(child)) { const closed = once(child, "close"); child.kill(); await closed; }
    for (const pid of [424242, 424243]) {
      const marker = path.join(root, String(pid), "native-query-pid");
      if (existsSync(marker)) expect(alive(Number(readFileSync(marker, "utf8"))), "Owned native child drained").toBe(false);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function start(protectedBirth = false) {
  const root = mkdtempSync(path.join(tmpdir(), "ags-d254-idle-")), state = path.join(root, "state");
  if (protectedBirth) {
    const seed = new SessionMessageStore(path.join(state, "session-messages.sqlite3"));
    const target = { host: "portable", sessionId: "d354-cancelled-protection" }, parentPid = 424243, parentStartToken = "protected-parent-birth";
    try {
      seed.prepareVerifiedRelay({ ...target, transport: "portable", parentPid, verifiedParentStartToken: parentStartToken,
        instanceId: "host-process-v1:" + createHash("sha256").update(JSON.stringify([target.host,target.sessionId,parentPid,parentStartToken])).digest("hex"),
        expectedOwner: null, wakeVisibility: "none", canWakeSilently: false });
    } finally { seed.close(); }
  }
  const child = spawn(process.execPath, ["--import", "tsx", "--import", new URL("./fixtures/d0254-idle-control.mjs", import.meta.url).href,
    fileURLToPath(new URL("../../mcp-server/src/session-message-broker.ts", import.meta.url)), "--state-directory", state, "--startup-diagnostic"], {
    windowsHide: true, stdio: ["ignore", "ignore", "pipe", "pipe", "ipc"], env: { ...process.env, AGENT_GOVERNANCE_D254_IDLE_FIXTURE: root },
  });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
  const events: BrokerEvent[] = [];
  const waiters = new Set<(event: BrokerEvent) => void>();
  child.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const event = raw as BrokerEvent;
    events.push(event);
    for (const waiter of [...waiters]) waiter(event);
  });
  const waitEvent = (predicate: (event: BrokerEvent) => boolean) => {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (!running(child)) return Promise.resolve(undefined);
    return new Promise<BrokerEvent | undefined>(resolve => {
      const check = (event: BrokerEvent) => {
        if (!predicate(event)) return;
        cleanup();
        resolve(event);
      };
      const onExit = () => { cleanup(); resolve(undefined); };
      const cleanup = () => {
        waiters.delete(check);
        child.off("close", onExit);
      };
      waiters.add(check);
      child.once("close", onExit);
    });
  };
  resources.push({ root, child });
  const diagnosticPipe = child.stdio[3] as Readable;
  diagnosticPipe.resume();
  await Promise.race([once(diagnosticPipe, "close"), once(child, "close")]);
  await waitEvent(event => event.type === "idle-interval");
  expect(existsSync(path.join(root, "idle-interval")), "Original idle interval installed").toBe(true);
  expect(readFileSync(path.join(root, "idle-interval"), "utf8")).toBe("5000");
  let sequence = 0;
  return { root, state, child, stderr: () => stderr,
    async control(command: { advanceMs?: number; tick?: boolean; signal?: boolean }) {
      const id = ++sequence;
      writeFileSync(path.join(root, "command.json"), JSON.stringify({ id, ...command }));
      const acked = waitEvent(event => event.type === "control-ack" && event.id === id);
      child.send({ type: "control", id, ...command });
      await acked;
      expect(!running(child) || (existsSync(path.join(root, "command-ack")) && readFileSync(path.join(root, "command-ack"), "utf8") === String(id)), "Control processed").toBe(true);
    },
    async queryStarted(pid = 424242) {
      await waitEvent(event => event.type === "query-started" && event.pid === pid);
      expect(existsSync(path.join(root, String(pid), "native-query-pid")), "Actual native query started").toBe(true);
      return Number(readFileSync(path.join(root, String(pid), "native-query-pid"), "utf8"));
    },
    async queryFinished(pid = 424242, label = "Native query finished") {
      await waitEvent(event => event.type === "query-finished" && event.pid === pid);
      expect(existsSync(path.join(root, String(pid), "finished")), label).toBe(true);
    },
    release(pid = 424242) {
      writeFileSync(path.join(root, String(pid), "release-query"), "1");
      if (child.connected) child.send({ type: "release", pid });
    },
  };
}
function payload(pid = 424242) {
  const target = { host: "portable", sessionId: "d254-idle-" + pid }, parentStartToken = "fixture-parent-birth";
  return { target, transport: "portable", parentPid: pid, parentStartToken, pid: process.pid,
    relayId: "verified-relay-v1:00000000-0000-4000-8000-000000000000:" + "a".repeat(64), instanceId: "host-process-v1:" + createHash("sha256").update(JSON.stringify([target.host, target.sessionId, pid, parentStartToken])).digest("hex"),
    identityTimeoutMs: 2000, wakeVisibility: "user-message", idleWake: "user-message", canWakeSilently: false, supportedInjection: ["peer-wake"] };
}
const test = it.runIf(process.platform === "win32");
test.each(["ensure-relay", "acquire-relay"])("%s survives an idle tick while its actual native query is held, then activity and drain remain bounded", async operation => {
  const b = await start();
  const result = requestSessionMessageOnce(operation, payload(), b.state).catch(error => error);
  await b.queryStarted();
  await b.control({ advanceMs: 60_001, tick: true });
  expect(running(b.child), b.stderr()).toBe(true);
  await expect(requestSessionMessageOnce("ping", {}, b.state)).resolves.toHaveProperty("protocolVersion");
  expect(existsSync(path.join(b.root, "424242", "finished"))).toBe(false);
  b.release();
  const reply = await result;
  expect(reply).not.toBeInstanceOf(Error);
  expect(reply).toHaveProperty(operation === "ensure-relay" ? "spawn" : "acquired");
  await b.control({ tick: true });
  expect(running(b.child)).toBe(true);
  await b.control({ advanceMs: 60_001, tick: true });
  await waitForExit(b.child, "Completed request no longer holds broker");
  expect(b.child.exitCode).toBe(0);
  expect(existsSync(path.join(b.state, "endpoint.json"))).toBe(false);
});
test("two concurrent requests retain idle protection until the final query drains", async () => {
  const b = await start();
  const first = requestSessionMessageOnce("ensure-relay", payload(), b.state).catch(error => error);
  const second = requestSessionMessageOnce("ensure-relay", payload(424243), b.state).catch(error => error);
  await Promise.all([b.queryStarted(), b.queryStarted(424243)]);
  b.release(); expect(await first).not.toBeInstanceOf(Error);
  await b.control({ advanceMs: 60_001, tick: true });
  expect(running(b.child), b.stderr()).toBe(true);
  expect(existsSync(path.join(b.root, "424243", "finished"))).toBe(false);
  b.release(424243); expect(await second).not.toBeInstanceOf(Error);
  await b.control({ advanceMs: 60_001, tick: true });
  await waitForExit(b.child, "Both queries drained");
});
test("ping and relay maintenance never reset idle activity", async () => {
  const b = await start(), p = payload();
  await b.control({ advanceMs: 59_000 });
  for (const [operation, value] of [["ping", {}], ["relay-tick", { ...p, includePending: false }], ["heartbeat-relay", p], ["presence-heartbeat", p]] as const) {
    await expect(requestSessionMessageOnce(operation, value, b.state)).resolves.toBeDefined();
  }
  await b.control({ advanceMs: 1001, tick: true });
  await waitForExit(b.child, "Maintenance does not hold broker");
  expect(b.child.exitCode).toBe(0);
});
test("authenticated validation errors do not leak an in-flight count or renew idle activity", async () => {
  const b = await start();
  await expect(requestSessionMessageOnce("unknown-operation", {}, b.state)).rejects.toThrow("Unknown broker operation");
  await expect(requestSessionMessageOnce("ensure-relay", {}, b.state)).rejects.toThrow();
  await b.control({ advanceMs: 60_001, tick: true });
  await waitForExit(b.child, "Throwing dispatch drained");
  expect(b.child.exitCode).toBe(0);
});
test("a native query timeout releases idle protection without fabricating user activity", async () => {
  const b = await start();
  const result = requestSessionMessageOnce("ensure-relay", { ...payload(), identityTimeoutMs: 800 }, b.state).catch(error => error);
  await b.queryStarted();
  await b.control({ advanceMs: 60_001, tick: true });
  expect(running(b.child)).toBe(true);
  expect(await result).toBeInstanceOf(Error);
  await b.queryFinished(424242, "Native query timed out");
  expect(readFileSync(path.join(b.root, "424242", "finished"), "utf8")).toBe("error");
  await b.control({ tick: true });
  await waitForExit(b.child, "Timed out request drained");
  expect(b.child.exitCode).toBe(0);
});
test("a disconnected authenticated client cannot leave permanent idle protection", async () => {
  const b = await start(), endpoint = JSON.parse(readFileSync(path.join(b.state, "endpoint.json"), "utf8")) as { port: number };
  const socket = tls.connect({ host: "127.0.0.1", port: endpoint.port, servername: "localhost", ca: readFileSync(path.join(b.state, "broker-cert.pem")), rejectUnauthorized: true });
  socket.on("error", () => {});
  try {
    await once(socket, "secureConnect");
    socket.write(JSON.stringify({ protocolVersion: SESSION_MESSAGE_PROTOCOL, token: readFileSync(path.join(b.state, "broker.token"), "utf8").trim(), operation: "ensure-relay", payload: { ...payload(), identityTimeoutMs: 800 } }) + "\n");
    await b.queryStarted(); socket.destroy();
    await b.control({ advanceMs: 60_001, tick: true });
    expect(running(b.child)).toBe(true);
    await b.queryFinished(424242, "Disconnected query reaches native timeout");
    await b.control({ tick: true });
    await waitForExit(b.child, "Disconnected request drained");
    expect(b.child.exitCode).toBe(0);
  } finally { socket.destroy(); }
});
test("explicit shutdown still aborts an actual held native child and removes the endpoint", async () => {
  const b = await start(true);
  const protectedRows = () => {
    const reader = new DatabaseSync(path.join(b.state, "session-messages.sqlite3"), { readOnly: true });
    try { return reader.prepare("SELECT * FROM session_presence ORDER BY rowid").all(); }
    finally { reader.close(); }
  };
  const before = protectedRows();
  expect(before).toMatchObject([{ verified_parent_token: "protected-parent-birth" }]);
  const result = requestSessionMessageOnce("ensure-relay", payload(), b.state).catch(error => error);
  const nativePid = await b.queryStarted();
  await b.control({ signal: true });
  await waitForExit(b.child, "Graceful shutdown completes");
  expect(alive(nativePid), "Native child aborted on shutdown").toBe(false);
  expect(b.child.exitCode).toBe(0);
  expect(existsSync(path.join(b.state, "endpoint.json"))).toBe(false);
  expect(existsSync(path.join(b.root, "424242", "release-query"))).toBe(false);
  await result;
  expect(protectedRows()).toEqual(before);
});
