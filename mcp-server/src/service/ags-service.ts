import { lstatSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { failureReason, producerFailure, retainFailureCause } from "../failure-diagnostics.js";
import { compareRunningVersions, isInstalledVersion } from "../plugin-version.js";
import { HANDSHAKE_TIMEOUT_MS, isNonce, isPipeAddress, MIN_CLIENT_PROTOCOL, newEndpointKey, newNonce, prepareUserDirectory,
  proofMatches, clientProof, removeEndpointIfOwned, serviceListenAddress, serviceProof, serviceStateDirectory, SERVICE_PROTOCOL,
  writeEndpoint, type EndpointRecord } from "./ipc-endpoint.js";
import { encodeLine, LineDecoder, parseMessage } from "./ipc-framing.js";

/**
 * The per-user state service (docs/ags31-dbms-service-design.md 4.2, 4.3; commit 1-2). It owns the state directory
 * through an OS file lock, never through a PID. Stores are attached in commit 1-3; this process serves the protocol,
 * the request queue, idle exit, version handover and service.status.
 */
export interface ServiceOptions {
  stateDirectory: string;
  version: string;
  build: string | null;
  /** No open connection for this long ends the service (4.2 유휴 종료). */
  idleMs?: number;
  /** server.maxConnections (4.3 backpressure). */
  maxConnections?: number;
  /** Waiting DB jobs beyond this are refused at once with SERVICE_BUSY. */
  queueLimit?: number;
  /** Upper bound of one job's wait in the queue, within its deadline. */
  queueWaitMaxMs?: number;
  /** In-flight work allowed to finish after a handover or signal. */
  drainMs?: number;
  handshakeTimeoutMs?: number;
  /** The address to listen on; called again for the Windows retry. Default: serviceListenAddress. */
  address?: () => string;
  onEvent?: (event: ServiceEvent) => void;
}

export type ServiceEvent = Readonly<{ event: string; reason?: string } & Record<string, unknown>>;
export type ServiceExitReason = "idle" | "handover" | "signal";

export interface RunningService {
  readonly address: string;
  readonly endpoint: EndpointRecord;
  /** Resolves after the listener, connections and owner lock are released. */
  readonly closed: Promise<{ reason: ServiceExitReason }>;
  shutdown(reason: ServiceExitReason): Promise<{ reason: ServiceExitReason }>;
  status(): ServiceStatus;
}

export const DEFAULT_IDLE_MS = 10 * 60_000;
export const DEFAULT_MAX_CONNECTIONS = 256;
export const DEFAULT_QUEUE_LIMIT = 64;
export const DEFAULT_QUEUE_WAIT_MAX_MS = 1_000;
export const DEFAULT_DRAIN_MS = 2_000;
/** A request without deadlineMs (an MCP tool call) gets the service default (4.5 table). */
const DEFAULT_REQUEST_DEADLINE_MS = 30_000;
const MAX_REQUEST_DEADLINE_MS = 10 * 60_000;
const ECHO_MAX_DELAY_MS = 2_000;
const JSON_RPC_SERVER_ERROR = -32001;

type Effect = "none" | "unknown";
type RequestFailure = Error & { effect?: Effect; retryable?: boolean; details?: unknown };

function requestFailure(reason: string, message: string, effect: Effect = "none", retryable = false, details?: unknown): RequestFailure {
  return Object.assign(producerFailure(reason, message), { effect, retryable }, details === undefined ? {} : { details });
}

/** The last 1024 values; percentiles of what the service saw recently. */
class Samples {
  private readonly values: number[] = [];
  private next = 0;

  add(value: number): void {
    if (this.values.length < 1024) this.values.push(value);
    else this.values[this.next] = value;
    this.next = (this.next + 1) % 1024;
  }

  summary(): { p50: number | null; p99: number | null } {
    if (this.values.length === 0) return { p50: null, p99: null };
    const sorted = [...this.values].sort((left, right) => left - right);
    const at = (percent: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(percent / 100 * sorted.length) - 1)]! * 100) / 100;
    return { p50: at(50), p99: at(99) };
  }
}

export interface ServiceStatus {
  service: { version: string; build: string | null; pid: number; startedAt: string; uptimeMs: number;
    protocol: number; minClientProtocol: number; closing: boolean };
  backend: "none";
  schema: Record<string, number>;
  connections: { open: number; handshake: number; rpc: number; max: number };
  queue: { waiting: number; running: boolean; limit: number; waitMs: { p50: number | null; p99: number | null };
    busyRejections: number };
  requests: { received: number; executed: number; deadlineExpired: number;
    /** From the line arriving to the response being written (8.1 M4: the queue alone hides a blocked loop). */
    durationMs: { p50: number | null; p99: number | null } };
  eventLoopDelayMs: { p50: number; p99: number; max: number };
  buildDiffers: number;
}

/**
 * D2 step 1: `locking_mode = EXCLUSIVE` keeps the lock after COMMIT until the connection closes or the process ends;
 * the OS releases it then (POSIX fcntl, Windows LockFileEx). busy_timeout 0: a held lock answers at once.
 */
function acquireOwnerLock(directory: string): DatabaseSync {
  let database: DatabaseSync;
  try { database = new DatabaseSync(path.join(directory, "owner.lock")); }
  catch (cause) { throw retainFailureCause(producerFailure("SERVICE_LOCK_FAILED", "Cannot open the service owner lock."), cause); }
  try {
    database.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
    return database;
  } catch (cause) {
    try { database.close(); } catch { /* The lock outcome below is the reported one. */ }
    const errcode = (cause as { errcode?: unknown }).errcode;
    const primary = typeof errcode === "number" ? errcode & 0xff : null;
    if (primary === 5 || primary === 6) {
      throw retainFailureCause(producerFailure("SERVICE_ALREADY_RUNNING", "Another service holds the owner lock."), cause);
    }
    throw retainFailureCause(producerFailure("SERVICE_LOCK_FAILED", "Cannot take the service owner lock."), cause);
  }
}

function probe(address: string): Promise<"listening" | "absent" | Error> {
  return new Promise(resolve => {
    const socket = net.connect(address);
    const timer = setTimeout(() => { socket.destroy(); resolve(new Error("probe timeout")); }, 500);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve("listening"); });
    socket.once("error", error => {
      clearTimeout(timer);
      const code = (error as { code?: unknown }).code;
      resolve(code === "ECONNREFUSED" || code === "ENOENT" ? "absent" : error);
    });
  });
}

function endpointInUse(cause?: unknown): Error {
  const failure = producerFailure("SERVICE_ENDPOINT_IN_USE", "The service address is in use although this service holds the owner lock.");
  return cause === undefined ? failure : retainFailureCause(failure, cause);
}

/**
 * D2 step 2, only while holding the owner lock. A socket file nobody listens on is what a killed service leaves, so it
 * is removed. Something that still listens there, or a file that is not a socket, is reported, not taken over.
 */
async function prepareSocketPath(address: string): Promise<void> {
  prepareUserDirectory(path.dirname(address));
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(address); }
  catch (cause) {
    if ((cause as { code?: unknown }).code === "ENOENT") return;
    throw endpointInUse(cause);
  }
  if (!info.isSocket()) throw endpointInUse();
  const state = await probe(address);
  if (state === "listening") throw endpointInUse();
  if (state instanceof Error) throw endpointInUse(state);
  rmSync(address, { force: true });
}

function listen(server: net.Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.removeListener("listening", onListening); reject(error); };
    const onListening = () => { server.removeListener("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(address);
  });
}

interface Client { kind: string; version: string; build: string | null }

class Connection {
  state: "challenge" | "hello" | "rpc" = "challenge";
  serviceNonce = "";
  client: Client | null = null;
  readonly decoder = new LineDecoder();
  readonly lines: string[] = [];
  processing = false;
  handshakeTimer: NodeJS.Timeout | null = null;

  constructor(readonly socket: net.Socket) {}

  send(message: unknown): void {
    if (!this.socket.destroyed) this.socket.write(encodeLine(message));
  }

  refuse(reason: string): void {
    if (!this.socket.destroyed) this.socket.end(encodeLine({ ags: "refuse", reason }));
  }
}

function isClient(value: unknown): value is Client {
  const client = value as Partial<Client> | null;
  return !!client && typeof client === "object" && typeof client.kind === "string" && client.kind.length <= 64
    && typeof client.version === "string" && isInstalledVersion(client.version)
    && (client.build === null || (typeof client.build === "string" && client.build.length <= 128));
}

interface Job {
  work: () => Promise<unknown>;
  deadline: number;
  enqueuedAt: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export async function startService(options: ServiceOptions): Promise<RunningService> {
  const stateDirectory = path.resolve(options.stateDirectory);
  const directory = serviceStateDirectory(stateDirectory);
  prepareUserDirectory(directory);
  const lock = acquireOwnerLock(directory);
  const service = new AgsService(options, stateDirectory, lock);
  try { await service.listen(); }
  catch (error) {
    service.releaseLock();
    throw error;
  }
  return service;
}

class AgsService implements RunningService {
  address = "";
  endpoint!: EndpointRecord;
  readonly closed: Promise<{ reason: ServiceExitReason }>;
  private resolveClosed!: (value: { reason: ServiceExitReason }) => void;
  private readonly server: net.Server;
  private readonly connections = new Set<Connection>();
  private readonly waiting: Job[] = [];
  private running = false;
  private closing = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly startedAt = new Date();
  private readonly startedMonotonic = performance.now();
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 10 });
  private readonly queueWait = new Samples();
  private readonly durations = new Samples();
  private readonly counters = { received: 0, executed: 0, deadlineExpired: 0, busyRejections: 0, buildDiffers: 0 };
  private readonly idleMs: number;
  private readonly maxConnections: number;
  private readonly queueLimit: number;
  private readonly queueWaitMaxMs: number;
  private readonly drainMs: number;
  private readonly handshakeTimeoutMs: number;

  constructor(private readonly options: ServiceOptions, private readonly stateDirectory: string, private lock: DatabaseSync | null) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
    this.queueWaitMaxMs = options.queueWaitMaxMs ?? DEFAULT_QUEUE_WAIT_MAX_MS;
    this.drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.server = net.createServer(socket => this.accept(socket));
    // Node closes a connection over this count before reading it; the client reports SERVICE_CONNECTIONS_FULL.
    this.server.maxConnections = this.maxConnections;
    this.server.on("drop", () => this.emit({ event: "connection_dropped", reason: "SERVICE_CONNECTIONS_FULL" }));
    this.loopDelay.enable();
  }

  private emit(event: ServiceEvent): void {
    try { this.options.onEvent?.(event); } catch { /* Diagnostics cannot change service behavior. */ }
  }

  async listen(): Promise<void> {
    const nextAddress = this.options.address ?? (() => serviceListenAddress(this.stateDirectory));
    // A Windows pipe name is new per start, so a name someone else created first is skipped once (4.3).
    const attempts = process.platform === "win32" ? 2 : 1;
    for (let attempt = 1; ; attempt += 1) {
      const address = nextAddress();
      try {
        if (!isPipeAddress(address)) await prepareSocketPath(address);
        await listen(this.server, address);
        this.address = address;
        break;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === "EADDRINUSE" || code === "SERVICE_ENDPOINT_IN_USE") {
          this.emit({ event: "listen_failed", reason: "SERVICE_ENDPOINT_IN_USE", attempt });
          if (attempt < attempts) continue;
          throw code === "EADDRINUSE" ? endpointInUse(error) : error;
        }
        throw retainFailureCause(producerFailure("SERVICE_LISTEN_FAILED", "The service could not listen."), error);
      }
    }
    this.endpoint = { address: this.address, key: newEndpointKey(), pid: process.pid, version: this.options.version,
      startedAt: this.startedAt.toISOString() };
    try { writeEndpoint(this.stateDirectory, this.endpoint); }
    catch (error) {
      this.server.close();
      throw error;
    }
    this.scheduleIdle();
  }

  releaseLock(): void {
    this.loopDelay.disable();
    try { this.lock?.close(); }
    catch (error) { this.emit({ event: "lock_release_failed", reason: failureReason(error).reason ?? "SERVICE_LOCK_FAILED" }); }
    this.lock = null;
  }

  private scheduleIdle(): void {
    if (this.closing || this.connections.size > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => { this.idleTimer = null; void this.shutdown("idle"); }, this.idleMs);
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private accept(socket: net.Socket): void {
    if (this.closing) { socket.destroy(); return; }
    const connection = new Connection(socket);
    this.connections.add(connection);
    this.cancelIdle();
    // A connection that only holds a slot is closed (4.3: hello within 1 s).
    connection.handshakeTimer = setTimeout(() => {
      if (connection.state !== "rpc") socket.destroy();
    }, this.handshakeTimeoutMs);
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      try { connection.lines.push(...connection.decoder.push(chunk)); }
      catch (error) {
        connection.send({ jsonrpc: "2.0", id: null, error: this.errorObject(error) });
        socket.destroy();
        return;
      }
      this.pump(connection);
    });
    socket.on("close", () => {
      if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer);
      this.connections.delete(connection);
      this.scheduleIdle();
    });
  }

  /** One rpc request per connection at a time: the socket is paused while one runs (4.3). */
  private pump(connection: Connection): void {
    while (!connection.processing && connection.lines.length > 0 && !connection.socket.destroyed) {
      const line = connection.lines.shift()!;
      if (connection.state !== "rpc") { this.handshake(connection, line); continue; }
      connection.processing = true;
      connection.socket.pause();
      void this.handleRequest(connection, line).finally(() => {
        connection.processing = false;
        if (!connection.socket.destroyed) connection.socket.resume();
        this.pump(connection);
      });
    }
  }

  private handshake(connection: Connection, line: string): void {
    let message: Record<string, unknown>;
    try { message = parseMessage(line); } catch { connection.socket.destroy(); return; }
    if (connection.state === "challenge") {
      if (message.ags !== "challenge" || !isNonce(message.nonce)) { connection.socket.destroy(); return; }
      connection.serviceNonce = newNonce();
      connection.send({ ags: "challenge-reply", serviceNonce: connection.serviceNonce,
        proof: serviceProof(this.endpoint.key, message.nonce, connection.serviceNonce) });
      connection.state = "hello";
      return;
    }
    if (message.ags !== "hello" || !Number.isSafeInteger(message.protocol) || (message.role !== "rpc" && message.role !== "mcp")
      || !isClient(message.client) || (message.profile !== undefined && (!message.profile || typeof message.profile !== "object"))) {
      connection.refuse("SERVICE_HELLO_INVALID");
      return;
    }
    if (!proofMatches(clientProof(this.endpoint.key, connection.serviceNonce), message.proof)) {
      this.emit({ event: "client_refused", reason: "SERVICE_CLIENT_UNVERIFIED" });
      connection.refuse("SERVICE_CLIENT_UNVERIFIED");
      return;
    }
    if ((message.protocol as number) < MIN_CLIENT_PROTOCOL) {
      connection.refuse("SERVICE_PROTOCOL_UNSUPPORTED");
      return;
    }
    if (this.closing) { connection.refuse("SERVICE_SHUTTING_DOWN"); return; }
    // Stores and the MCP server per connection arrive in commit 1-3.
    if (message.role === "mcp") { connection.refuse("SERVICE_ROLE_UNAVAILABLE"); return; }
    const client = message.client;
    if (client.version === this.options.version && client.build !== null && this.options.build !== null
      && client.build !== this.options.build) {
      // D3: the same version with another build is served and recorded, never replaced.
      this.counters.buildDiffers += 1;
      this.emit({ event: "build_differs", reason: "SERVICE_BUILD_DIFFERS", clientKind: client.kind });
    }
    connection.client = client;
    connection.state = "rpc";
    if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer);
    connection.handshakeTimer = null;
    connection.send({ ags: "welcome", protocol: SERVICE_PROTOCOL,
      service: { version: this.options.version, build: this.options.build, minClientProtocol: MIN_CLIENT_PROTOCOL }, schema: {} });
  }

  private errorObject(error: unknown): Record<string, unknown> {
    const failure = error as RequestFailure;
    const reason = failureReason(error).reason;
    if (reason && failure.effect !== undefined) {
      return { code: JSON_RPC_SERVER_ERROR, message: failure.message,
        data: { reason, retryable: failure.retryable === true, effect: failure.effect, ...(failure.details === undefined ? {} : { details: failure.details }) } };
    }
    if (reason === "SERVICE_LINE_TOO_LONG" || reason === "SERVICE_PROTOCOL_ERROR") {
      return { code: -32600, message: "The request is not a valid IPC line.", data: { reason, retryable: false, effect: "none" } };
    }
    // The original message stays private (5.8); the work may have run part way.
    return { code: JSON_RPC_SERVER_ERROR, message: "The service could not complete the request.",
      data: { reason: reason ?? "SERVICE_INTERNAL_FAILURE", retryable: false, effect: "unknown" } };
  }

  private async handleRequest(connection: Connection, line: string): Promise<void> {
    const receivedAt = performance.now();
    this.counters.received += 1;
    let id: unknown = null;
    try {
      let message: Record<string, unknown>;
      try { message = parseMessage(line); }
      catch (error) { connection.send({ jsonrpc: "2.0", id: null, error: this.errorObject(error) }); return; }
      id = message.id;
      const params = message.params === undefined ? {} : message.params;
      if (message.jsonrpc !== "2.0" || typeof message.method !== "string" || !(typeof id === "number" || typeof id === "string")
        || !params || typeof params !== "object" || Array.isArray(params)) {
        throw requestFailure("SERVICE_PROTOCOL_ERROR", "The request is not a JSON-RPC 2.0 request.");
      }
      const record = params as Record<string, unknown>;
      const deadlineMs = record.deadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS;
      if (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs) || deadlineMs < 0 || deadlineMs > MAX_REQUEST_DEADLINE_MS) {
        throw requestFailure("SERVICE_REQUEST_INVALID", "deadlineMs must be a number of milliseconds.");
      }
      const deadline = receivedAt + deadlineMs;
      const result = await this.dispatch(connection, message.method, record, deadline);
      connection.send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      connection.send({ jsonrpc: "2.0", id, error: this.errorObject(error) });
    } finally {
      this.durations.add(performance.now() - receivedAt);
    }
  }

  private expired(): RequestFailure {
    this.counters.deadlineExpired += 1;
    return requestFailure("SERVICE_DEADLINE_EXPIRED", "The request deadline expired before it ran.");
  }

  private async dispatch(connection: Connection, method: string, params: Record<string, unknown>, deadline: number): Promise<unknown> {
    if (method === "service.status") return this.status();
    if (this.closing) throw requestFailure("SERVICE_SHUTTING_DOWN", "The service is shutting down.", "none", true);
    if (!(deadline - performance.now() >= 1)) throw this.expired();
    if (method === "service.handover") {
      // D3: only a newer client replaces the service, so two installations never replace each other in turn.
      if (compareRunningVersions(connection.client!.version, this.options.version) <= 0) {
        throw requestFailure("SERVICE_HANDOVER_REFUSED", "Only a newer client may replace the service.");
      }
      this.emit({ event: "handover", fromVersion: this.options.version, toVersion: connection.client!.version });
      setImmediate(() => { void this.shutdown("handover", connection); });
      return { accepted: true };
    }
    if (method === "service.echo") {
      const delay = params.delayMs;
      if (delay !== undefined && (typeof delay !== "number" || !(delay >= 0) || delay > ECHO_MAX_DELAY_MS)) {
        throw requestFailure("SERVICE_REQUEST_INVALID", "delayMs must be between 0 and 2000.");
      }
      // A store job stand-in: it takes the queue slot for delayMs.
      return this.enqueue(deadline, async () => {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        return { value: params.value ?? null };
      });
    }
    throw requestFailure("SERVICE_METHOD_UNKNOWN", "The service has no such method.");
  }

  /** The DB job queue (4.3): one job at a time, a length limit, and a wait bounded by the deadline and 1 s. */
  private enqueue(deadline: number, work: () => Promise<unknown>): Promise<unknown> {
    if (this.waiting.length >= this.queueLimit) {
      this.counters.busyRejections += 1;
      throw requestFailure("SERVICE_BUSY", "The service queue is full.", "none", true,
        { queueLength: this.waiting.length, queueLimit: this.queueLimit });
    }
    return new Promise((resolve, reject) => {
      const enqueuedAt = performance.now();
      // Which bound ends the wait is decided here; a timer may fire a fraction early by performance.now().
      const deadlineBound = deadline - enqueuedAt <= this.queueWaitMaxMs;
      const waitMs = Math.max(0, Math.min(this.queueWaitMaxMs, deadline - enqueuedAt));
      const job: Job = { work, deadline, enqueuedAt, resolve, reject, timer: setTimeout(() => {
        const index = this.waiting.indexOf(job);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        this.queueWait.add(performance.now() - enqueuedAt);
        if (deadlineBound) { reject(this.expired()); return; }
        this.counters.busyRejections += 1;
        reject(requestFailure("SERVICE_BUSY", "The request waited too long in the service queue.", "none", true,
          { queueLength: this.waiting.length, queueLimit: this.queueLimit }));
      }, waitMs) };
      this.waiting.push(job);
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    if (this.running) return;
    const job = this.waiting.shift();
    if (!job) return;
    clearTimeout(job.timer);
    this.queueWait.add(performance.now() - job.enqueuedAt);
    if (!(job.deadline - performance.now() >= 1)) {
      job.reject(this.expired());
      this.drainQueue();
      return;
    }
    this.running = true;
    this.counters.executed += 1;
    void job.work().then(job.resolve, job.reject).finally(() => {
      this.running = false;
      this.drainQueue();
    });
  }

  status(): ServiceStatus {
    const nanos = (value: number) => Math.round(value / 1e4) / 100;
    let handshake = 0;
    let rpc = 0;
    for (const connection of this.connections) {
      if (connection.state === "rpc") rpc += 1;
      else handshake += 1;
    }
    return {
      service: { version: this.options.version, build: this.options.build, pid: process.pid, startedAt: this.startedAt.toISOString(),
        uptimeMs: Math.round(performance.now() - this.startedMonotonic), protocol: SERVICE_PROTOCOL, minClientProtocol: MIN_CLIENT_PROTOCOL,
        closing: this.closing },
      backend: "none",
      schema: {},
      connections: { open: this.connections.size, handshake, rpc, max: this.maxConnections },
      queue: { waiting: this.waiting.length, running: this.running, limit: this.queueLimit, waitMs: this.queueWait.summary(),
        busyRejections: this.counters.busyRejections },
      requests: { received: this.counters.received, executed: this.counters.executed, deadlineExpired: this.counters.deadlineExpired,
        durationMs: this.durations.summary() },
      eventLoopDelayMs: { p50: nanos(this.loopDelay.percentile(50)), p99: nanos(this.loopDelay.percentile(99)), max: nanos(this.loopDelay.max) },
      buildDiffers: this.counters.buildDiffers,
    };
  }

  /**
   * Stops listening, lets in-flight work finish for up to drainMs, closes the other connections, removes the endpoint
   * file and releases the owner lock. The connection that asked for a handover is ended last, so its client sees the
   * close only after the lock is free and can start its own service.
   */
  shutdown(reason: ServiceExitReason, requester?: Connection): Promise<{ reason: ServiceExitReason }> {
    if (this.closing) return this.closed;
    this.closing = true;
    this.cancelIdle();
    this.emit({ event: "shutdown_start", reason });
    this.server.close();
    void (async () => {
      const until = performance.now() + this.drainMs;
      while ((this.running || this.waiting.length > 0 || [...this.connections].some(connection => connection.processing && connection !== requester))
        && performance.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      for (const job of this.waiting.splice(0)) {
        clearTimeout(job.timer);
        job.reject(requestFailure("SERVICE_SHUTTING_DOWN", "The service is shutting down.", "none", true));
      }
      for (const connection of this.connections) if (connection !== requester) connection.socket.destroy();
      try { removeEndpointIfOwned(this.stateDirectory, this.endpoint.key); }
      catch (error) { this.emit({ event: "endpoint_remove_failed", reason: failureReason(error).reason ?? "SERVICE_ENDPOINT_WRITE_FAILED" }); }
      this.releaseLock();
      requester?.socket.end();
      this.emit({ event: "shutdown_end", reason });
      this.resolveClosed({ reason });
    })();
    return this.closed;
  }
}
