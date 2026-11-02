import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startService, type RunningService, type ServiceOptions } from "../../mcp-server/src/service/ags-service.js";
import { clientProof, newNonce, readEndpoint, serviceProof, serviceStateDirectory, type EndpointRecord } from "../../mcp-server/src/service/ipc-endpoint.js";
import { encodeLine, LineDecoder } from "../../mcp-server/src/service/ipc-framing.js";
import { ensureService, serviceLauncher, type EnsureServiceOptions, type ServiceSession } from "../../mcp-server/src/service/service-client.js";

// docs/ags31-dbms-service-design.md 4.2, 4.3, 9장 1단계; commit 1-2. In-process services cover the protocol, queue, idle
// exit and handover; the committed bundle (mcp-server/dist/ags-service.mjs) covers the OS lock across processes.

const BUILD = "sha256:" + "a".repeat(64);
const bundle = fileURLToPath(new URL("../../mcp-server/dist/ags-service.mjs", import.meta.url));
let root: string;
let state: string;
const services: RunningService[] = [];
const sessions: ServiceSession[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ags-svc-"));
  state = path.join(root, "s");
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  await Promise.all(services.splice(0).map(service => service.shutdown("signal")));
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited(child); }
  }
  // Windows may hold a killed process's files for a moment.
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function start(options: Partial<ServiceOptions> = {}): Promise<RunningService> {
  const service = await startService({ stateDirectory: state, version: "3.0.2", build: BUILD, idleMs: 60_000, ...options });
  services.push(service);
  return service;
}

async function connect(overrides: Partial<EnsureServiceOptions> = {}): Promise<ServiceSession> {
  const session = await ensureService({ stateDirectory: state, role: "rpc", client: { kind: "test", version: "3.0.2", build: BUILD },
    deadlineMs: 5_000, launch: false, ...overrides });
  sessions.push(session);
  return session;
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A hand-driven connection, for what the client library never sends. */
class Raw {
  readonly socket: net.Socket;
  private readonly decoder = new LineDecoder();
  private readonly lines: string[] = [];
  closed = false;
  readonly closedAt: Promise<number>;

  constructor(address: string) {
    this.socket = net.connect(address);
    this.socket.on("error", () => {});
    this.socket.on("data", (chunk: Buffer) => this.lines.push(...this.decoder.push(chunk)));
    this.closedAt = new Promise(resolve => this.socket.on("close", () => { this.closed = true; resolve(performance.now()); }));
  }

  send(message: unknown): void { this.socket.write(encodeLine(message)); }

  async next(timeoutMs = 3_000): Promise<Record<string, unknown> | null> {
    const until = performance.now() + timeoutMs;
    while (this.lines.length === 0 && !this.closed && performance.now() < until) await pause(5);
    const line = this.lines.shift();
    return line === undefined ? null : JSON.parse(line) as Record<string, unknown>;
  }

  /** Challenge, then hello with the given fields; returns the service's answer to the hello. */
  async hello(endpoint: EndpointRecord, fields: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
    const nonce = newNonce();
    this.send({ ags: "challenge", nonce });
    const reply = await this.next();
    expect(reply).toMatchObject({ ags: "challenge-reply" });
    expect(reply!.proof).toBe(serviceProof(endpoint.key, nonce, reply!.serviceNonce as string));
    this.send({ ags: "hello", protocol: 1, role: "rpc", client: { kind: "raw", version: "3.0.2", build: null },
      proof: clientProof(endpoint.key, reply!.serviceNonce as string), ...fields });
    return this.next();
  }
}

function rawFor(service: RunningService): Raw {
  return new Raw(service.address);
}

describe("protocol", () => {
  it("writes the endpoint file, welcomes a verified client and answers service.status", async () => {
    const service = await start();
    expect(readEndpoint(state)).toEqual(service.endpoint);
    expect(service.endpoint.pid).toBe(process.pid);
    const session = await connect();
    expect(session.welcome).toEqual({ protocol: 1, service: { version: "3.0.2", build: BUILD, minClientProtocol: 1 }, schema: {} });
    const status = await session.request<Record<string, unknown>>("service.status", {}, { deadlineMs: 2_000 });
    expect(status).toMatchObject({ backend: "none", schema: {}, service: { version: "3.0.2", build: BUILD, pid: process.pid, closing: false },
      connections: { open: 1, rpc: 1, max: 256 }, queue: { waiting: 0, running: false, limit: 64 }, buildDiffers: 0 });
    expect(status.eventLoopDelayMs).toEqual({ p50: expect.any(Number), p99: expect.any(Number), max: expect.any(Number) });
    expect(await session.request("service.echo", { value: "x" }, { deadlineMs: 2_000 })).toEqual({ value: "x" });
    await expect(session.request("no.such", {}, { deadlineMs: 2_000 })).rejects.toMatchObject({ code: "SERVICE_METHOD_UNKNOWN", effect: "none" });
    await expect(connect({ role: "mcp" })).rejects.toMatchObject({ code: "SERVICE_ROLE_UNAVAILABLE" });
  });

  it("closes a connection that sends no hello within 1 s", async () => {
    const service = await start();
    const raw = rawFor(service);
    const opened = performance.now();
    const closedAt = await raw.closedAt;
    expect(closedAt - opened).toBeGreaterThanOrEqual(900);
    expect(closedAt - opened).toBeLessThan(3_000);
  });

  it("refuses a client proof made without the key and a protocol below minClientProtocol", async () => {
    const service = await start();
    const wrong = rawFor(service);
    expect(await wrong.hello(service.endpoint, { proof: "A".repeat(43) })).toEqual({ ags: "refuse", reason: "SERVICE_CLIENT_UNVERIFIED" });
    const old = rawFor(service);
    expect(await old.hello(service.endpoint, { protocol: 0 })).toEqual({ ags: "refuse", reason: "SERVICE_PROTOCOL_UNSUPPORTED" });
    const invalid = rawFor(service);
    expect(await invalid.hello(service.endpoint, { client: { kind: "raw", version: "latest", build: null } }))
      .toEqual({ ags: "refuse", reason: "SERVICE_HELLO_INVALID" });
  });

  it("closes a connection whose line exceeds 16 MiB", async () => {
    const service = await start();
    const raw = rawFor(service);
    expect(await raw.hello(service.endpoint)).toMatchObject({ ags: "welcome" });
    raw.socket.write(Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
    expect(await raw.next(5_000)).toMatchObject({ error: { data: { reason: "SERVICE_LINE_TOO_LONG" } } });
    await raw.closedAt;
  });

  it("closes connections over maxConnections, which the client reports as SERVICE_CONNECTIONS_FULL", async () => {
    await start({ maxConnections: 2 });
    const first = await connect();
    await connect();
    await expect(connect()).rejects.toMatchObject({ code: "SERVICE_CONNECTIONS_FULL" });
    first.close();
    await pause(100);
    const again = await connect();
    expect(await again.request("service.status", {}, { deadlineMs: 2_000 })).toMatchObject({ connections: { open: 2 } });
  });
});

describe("queue and deadlines", () => {
  it("refuses a job beyond the queue limit at once with SERVICE_BUSY and nothing done", async () => {
    await start({ queueLimit: 1 });
    const [a, b, c] = await Promise.all([connect(), connect(), connect()]);
    const running = a.request("service.echo", { value: "a", delayMs: 400 }, { deadlineMs: 3_000 });
    await pause(50);
    const waiting = b.request("service.echo", { value: "b" }, { deadlineMs: 3_000 });
    await pause(50);
    const started = performance.now();
    await expect(c!.request("service.echo", { value: "c" }, { deadlineMs: 3_000 })).rejects.toMatchObject({
      code: "SERVICE_BUSY", effect: "none", retryable: true, details: { queueLength: 1, queueLimit: 1 } });
    expect(performance.now() - started).toBeLessThan(300);
    expect(await running).toEqual({ value: "a" });
    expect(await waiting).toEqual({ value: "b" });
    expect(await c!.request("service.status", {}, { deadlineMs: 2_000 })).toMatchObject({
      queue: { busyRejections: 1 }, requests: { executed: 2 } });
  });

  it("bounds the queue wait by queueWaitMaxMs (SERVICE_BUSY) and never runs the job", async () => {
    await start({ queueWaitMaxMs: 100 });
    const [a, b] = await Promise.all([connect(), connect()]);
    const running = a.request("service.echo", { delayMs: 500 }, { deadlineMs: 3_000 });
    await pause(30);
    await expect(b.request("service.echo", {}, { deadlineMs: 3_000 })).rejects.toMatchObject({ code: "SERVICE_BUSY", effect: "none" });
    await running;
    expect(await b.request("service.status", {}, { deadlineMs: 2_000 })).toMatchObject({ requests: { executed: 1 } });
  });

  it("does not run a request whose deadline passed, before or while it waited", async () => {
    const service = await start();
    const holder = await connect();
    const raw = rawFor(service);
    expect(await raw.hello(service.endpoint)).toMatchObject({ ags: "welcome" });
    raw.send({ jsonrpc: "2.0", id: 1, method: "service.echo", params: { deadlineMs: 0 } });
    expect(await raw.next()).toMatchObject({ id: 1, error: { data: { reason: "SERVICE_DEADLINE_EXPIRED", effect: "none" } } });
    const running = holder.request("service.echo", { delayMs: 500 }, { deadlineMs: 3_000 });
    await pause(30);
    raw.send({ jsonrpc: "2.0", id: 2, method: "service.echo", params: { deadlineMs: 150 } });
    expect(await raw.next()).toMatchObject({ id: 2, error: { data: { reason: "SERVICE_DEADLINE_EXPIRED", effect: "none" } } });
    await running;
    expect(service.status().requests).toMatchObject({ executed: 1, deadlineExpired: 2 });
  });

  it("answers one rpc request per connection at a time, in order", async () => {
    const service = await start();
    const raw = rawFor(service);
    expect(await raw.hello(service.endpoint)).toMatchObject({ ags: "welcome" });
    raw.send({ jsonrpc: "2.0", id: 1, method: "service.echo", params: { value: 1, delayMs: 200 } });
    raw.send({ jsonrpc: "2.0", id: 2, method: "service.echo", params: { value: 2 } });
    expect(await raw.next()).toMatchObject({ id: 1, result: { value: 1 } });
    expect(await raw.next()).toMatchObject({ id: 2, result: { value: 2 } });
  });
});

describe("single instance and the listen address", () => {
  it("refuses a second service on the same state directory with SERVICE_ALREADY_RUNNING", async () => {
    await start();
    await expect(startService({ stateDirectory: state, version: "3.0.2", build: BUILD })).rejects.toMatchObject({ code: "SERVICE_ALREADY_RUNNING" });
  });

  it("reports an address someone else listens on as SERVICE_ENDPOINT_IN_USE and releases the lock", async () => {
    const other = net.createServer();
    const address = process.platform === "win32" ? `\\\\.\\pipe\\ags-svc-test-${process.pid}-${Date.now()}` : path.join(root, "busy.sock");
    await new Promise<void>(resolve => other.listen(address, resolve));
    try {
      const factory = vi.fn(() => address);
      await expect(startService({ stateDirectory: state, version: "3.0.2", build: BUILD, address: factory }))
        .rejects.toMatchObject({ code: "SERVICE_ENDPOINT_IN_USE" });
      // Windows draws a new pipe name once more; a Unix socket that answers is never removed.
      expect(factory).toHaveBeenCalledTimes(process.platform === "win32" ? 2 : 1);
      if (process.platform !== "win32") expect(fs.existsSync(address)).toBe(true);
      expect(readEndpoint(state)).toBeNull();
      await start();
    } finally {
      await new Promise(resolve => other.close(resolve));
    }
  });

  it.skipIf(process.platform === "win32")("refuses a non-socket file at the socket path", async () => {
    const address = path.join(root, "file.sock");
    fs.writeFileSync(address, "x");
    await expect(startService({ stateDirectory: state, version: "3.0.2", build: BUILD, address: () => address }))
      .rejects.toMatchObject({ code: "SERVICE_ENDPOINT_IN_USE" });
    expect(fs.readFileSync(address, "utf8")).toBe("x");
  });
});

describe("idle exit", () => {
  it("ends after idleMs without connections, removes the endpoint file and releases the lock", async () => {
    const service = await start({ idleMs: 300 });
    const session = await connect();
    await pause(500);
    expect(service.status().service.closing).toBe(false);
    session.close();
    const ended = await Promise.race([service.closed, pause(3_000).then(() => null)]);
    expect(ended).toEqual({ reason: "idle" });
    expect(readEndpoint(state)).toBeNull();
    await start();
  });
});

describe("version handover (D3)", () => {
  it("hands over only to a newer client, finishing in-flight work first", async () => {
    const old = await start();
    const busy = await connect();
    const inFlight = busy.request("service.echo", { value: "done", delayMs: 300 }, { deadlineMs: 3_000 });
    await pause(30);
    let newer: RunningService | undefined;
    const launch = vi.fn(async () => { newer = await start({ version: "3.0.3" }); });
    const session = await connect({ client: { kind: "test", version: "3.0.3", build: null }, launch });
    expect(await inFlight).toEqual({ value: "done" });
    expect(await old.closed).toEqual({ reason: "handover" });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(session.welcome.service.version).toBe("3.0.3");
    expect(readEndpoint(state)?.key).toBe(newer!.endpoint.key);
  });

  it("refuses service.handover from an equal or older client and records a same-version build difference", async () => {
    const service = await start();
    const older = await connect({ client: { kind: "test", version: "3.0.1", build: null } });
    await expect(older.request("service.handover", {}, { deadlineMs: 2_000 })).rejects.toMatchObject({ code: "SERVICE_HANDOVER_REFUSED", effect: "none" });
    const other = await connect({ client: { kind: "test", version: "3.0.2", build: "sha256:" + "b".repeat(64) } });
    await expect(other.request("service.handover", {}, { deadlineMs: 2_000 })).rejects.toMatchObject({ code: "SERVICE_HANDOVER_REFUSED" });
    expect(service.status()).toMatchObject({ buildDiffers: 1, service: { closing: false } });
  });

  it("replaces the service once when two installed versions connect in turn", async () => {
    const first = await start({ version: "3.0.2" });
    const launch = vi.fn(async () => { await start({ version: "3.0.3" }); });
    for (let round = 0; round < 3; round += 1) {
      for (const version of ["3.0.3", "3.0.2"]) {
        const session = await connect({ client: { kind: "test", version, build: null }, launch });
        expect(session.welcome.service.version).toBe("3.0.3");
        session.close();
      }
    }
    expect(launch).toHaveBeenCalledTimes(1);
    expect(await first.closed).toEqual({ reason: "handover" });
  });
});

function spawnBundle(args: readonly string[]): ChildProcess {
  const child = spawn(process.execPath, [bundle, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  children.push(child);
  return child;
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once("exit", code => resolve(code));
  });
}

async function waitFor<T>(probe: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs = 10_000): Promise<T> {
  const until = performance.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (performance.now() > until) throw new Error("condition not reached");
    await pause(25);
  }
}

function events(): Array<Record<string, unknown>> {
  const file = path.join(serviceStateDirectory(state), "service-events.log");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>) : [];
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("service process (mcp-server/dist/ags-service.mjs)", () => {
  it("lets one process own the state directory; a second ends with code 0 and SERVICE_ALREADY_RUNNING", async () => {
    const first = spawnBundle(["--state-dir", state, "--idle-ms", "20000"]);
    const endpoint = await waitFor(() => readEndpoint(state));
    expect(endpoint.pid).toBe(first.pid);
    const second = spawnBundle(["--state-dir", state]);
    expect(await exited(second)).toBe(0);
    expect(events()).toContainEqual(expect.objectContaining({ pid: second.pid, event: "start_failed", reason: "SERVICE_ALREADY_RUNNING" }));
    const session = await connect();
    expect(await session.request("service.status", {}, { deadlineMs: 2_000 })).toMatchObject({ service: { pid: first.pid } });
  });

  it("starts again after the owner was killed, even with its socket file and endpoint file left behind", async () => {
    const first = spawnBundle(["--state-dir", state, "--idle-ms", "20000"]);
    const endpoint = await waitFor(() => readEndpoint(state));
    first.kill("SIGKILL");
    await exited(first);
    if (process.platform !== "win32") expect(fs.existsSync(endpoint.address)).toBe(true);
    expect(readEndpoint(state)?.pid).toBe(first.pid);
    const next = spawnBundle(["--state-dir", state, "--idle-ms", "20000"]);
    const replaced = await waitFor(() => { const current = readEndpoint(state); return current?.pid === next.pid ? current : null; });
    expect(replaced.key).not.toBe(endpoint.key);
    const session = await connect();
    expect(await session.request("service.status", {}, { deadlineMs: 2_000 })).toMatchObject({ service: { pid: next.pid } });
    // A newer client ends it through the handover path; with launch disabled nothing new starts.
    session.close();
    await expect(connect({ client: { kind: "test", version: "999.0.0", build: null } })).rejects.toMatchObject({ code: "SERVICE_NOT_RUNNING" });
    expect(await exited(next)).toBe(0);
    expect(events()).toContainEqual(expect.objectContaining({ pid: next.pid, event: "stopped", reason: "handover" }));
  });

  it("is started detached by ensureService (CIM on Windows) and reports status through the CLI", async () => {
    const launch = serviceLauncher(state, bundle, ["--idle-ms", "20000"]);
    const session = await connect({ launch, deadlineMs: 15_000 });
    const status = await session.request<{ service: { pid: number; version: string } }>("service.status", {}, { deadlineMs: 2_000 });
    expect(status.service.version).toBe(session.welcome.service.version);
    session.close();
    const cli = spawnBundle(["status", "--state-dir", state]);
    let stdout = "";
    cli.stdout!.on("data", chunk => { stdout += String(chunk); });
    expect(await exited(cli)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ service: { pid: status.service.pid }, backend: "none" });
    await expect(connect({ client: { kind: "test", version: "999.0.0", build: null } })).rejects.toMatchObject({ code: "SERVICE_NOT_RUNNING" });
    await waitFor(() => !alive(status.service.pid));
    const missing = spawnBundle(["status", "--state-dir", state]);
    let stderr = "";
    missing.stderr!.on("data", chunk => { stderr += String(chunk); });
    expect(await exited(missing)).toBe(1);
    expect(stderr).toContain("SERVICE_NOT_RUNNING");
  }, 40_000);
});
