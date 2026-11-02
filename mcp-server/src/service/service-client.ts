import net from "node:net";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { producerFailure, retainFailureCause } from "../failure-diagnostics.js";
import { compareRunningVersions, isInstalledVersion } from "../plugin-version.js";
import { launchDetached } from "./detached-launch.js";
import { clientProof, isNonce, newNonce, proofMatches, readEndpoint, serviceProof, SERVICE_PROTOCOL,
  type EndpointRecord } from "./ipc-endpoint.js";
import { encodeLine, LineDecoder, parseMessage } from "./ipc-framing.js";

/**
 * Client side of the service IPC (docs/ags31-dbms-service-design.md 4.2, 4.3): finds or starts the service, checks
 * that it read the same endpoint file, says hello, and sends requests with a remaining-time budget. The handshake and
 * requests run over any connected stream, so a remote transport (4.7) only adds a way to connect.
 */
export type ServiceRole = "mcp" | "rpc";
/** "none": the service did nothing for this request. "unknown": it may have run; a write is never sent again. */
export type ServiceEffect = "none" | "unknown";

export interface ClientIdentity { kind: string; version: string; build: string | null }

export interface Welcome {
  protocol: number;
  service: { version: string; build: string | null; minClientProtocol: number };
  schema: Record<string, unknown>;
}

/** Starts this installation's service; resolves when the start was requested, not when it serves. */
export type ServiceLauncher = (remainingMs: number) => Promise<void>;

export interface EnsureServiceOptions {
  stateDirectory: string;
  role: ServiceRole;
  client: ClientIdentity;
  profile?: Readonly<Record<string, unknown>>;
  /** Budget for reading the endpoint file, starting the service, connecting and the handshake. */
  deadlineMs: number;
  /** false: never start a service (hooks that must not, 4.2). Default: this installation's ags-service.mjs. */
  launch?: false | ServiceLauncher;
  /** false: never ask an older service to hand over (a status query). Default true. */
  handover?: boolean;
}

export type ServiceFailure = Error & { code: string; effect: ServiceEffect; retryable: boolean; details?: unknown };

export function serviceFailure(reason: string, message: string, effect: ServiceEffect = "none", retryable = false,
  details?: unknown): ServiceFailure {
  const failure = Object.assign(producerFailure(reason, message), { effect, retryable },
    details === undefined ? {} : { details }) as ServiceFailure;
  return failure;
}

const REASON = /^[A-Z][A-Z0-9_]{0,63}$/u;
const RETRY_DELAYS_MS = [50, 100, 200, 400, 800];
const MAX_LAUNCHES = 3;
const RELAUNCH_AFTER_MS = 1_000;
const LAUNCHER_TIMEOUT_MS = 10_000;

/** Reads that may be sent once more after a lost connection (4.3). Everything else is a write. */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(["service.status", "service.echo"]);
const IDEMPOTENT_MESSAGING: ReadonlySet<string> = new Set(["status", "pending", "presence", "list-current-presence", "wake-status"]);

export function isIdempotentRequest(method: string, params: Readonly<Record<string, unknown>>): boolean {
  return IDEMPOTENT_METHODS.has(method) || (method === "messaging" && IDEMPOTENT_MESSAGING.has(String(params.operation)));
}

/** The service bundle installed beside the calling bundle (mcp-server/dist). */
export function defaultServiceEntry(): string {
  return fileURLToPath(new URL("./ags-service.mjs", import.meta.url));
}

export function serviceLauncher(stateDirectory: string, entry = defaultServiceEntry(),
  extraArgs: readonly string[] = []): ServiceLauncher {
  return async remainingMs => {
    await launchDetached([entry, "--state-dir", stateDirectory, ...extraArgs], Math.min(remainingMs, LAUNCHER_TIMEOUT_MS));
  };
}

function remainingOf(deadline: number): number {
  return Math.floor(deadline - performance.now());
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function connect(address: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(serviceFailure("SERVICE_CONNECT_TIMEOUT", "Connecting to the service timed out."));
    }, Math.max(1, timeoutMs));
    const onError = (error: Error) => { clearTimeout(timer); reject(error); };
    socket.once("error", onError);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

/** A stream between lines: one waiting reader, closed state, and bytes that arrived after the last line. */
class LineChannel {
  private readonly decoder = new LineDecoder();
  private readonly lines: string[] = [];
  private waiter: ((event: { line: string } | { closed: true } | { failure: Error }) => void) | null = null;
  private failure: Error | null = null;
  closed = false;

  constructor(readonly socket: net.Socket, head?: Buffer) {
    socket.on("data", this.onData);
    socket.on("close", this.onClose);
    // Errors end in close; the close is what callers act on.
    socket.on("error", () => {});
    if (head && head.length > 0) this.onData(head);
  }

  private readonly onData = (chunk: Buffer) => {
    try { this.lines.push(...this.decoder.push(chunk)); }
    catch (error) {
      this.failure = error as Error;
      this.socket.destroy();
    }
    this.wake();
  };

  private readonly onClose = () => {
    this.closed = true;
    this.wake();
  };

  private wake(): void {
    const waiter = this.waiter;
    if (!waiter) return;
    const line = this.lines.shift();
    if (line !== undefined) { this.waiter = null; waiter({ line }); }
    else if (this.failure) { this.waiter = null; waiter({ failure: this.failure }); }
    else if (this.closed) { this.waiter = null; waiter({ closed: true }); }
  }

  /** The next line, or closed, or "timeout" when nothing arrives in time. */
  next(timeoutMs: number): Promise<{ line: string } | { closed: true } | { failure: Error } | { timeout: true }> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.waiter = null; resolve({ timeout: true }); }, Math.max(1, timeoutMs));
      this.waiter = event => { clearTimeout(timer); resolve(event); };
      this.wake();
    });
  }

  write(message: unknown): void {
    this.socket.write(encodeLine(message));
  }

  /** Stops reading and hands the stream and its unread bytes to the caller. */
  detach(): { socket: net.Socket; head: Buffer } {
    this.socket.pause();
    this.socket.removeListener("data", this.onData);
    this.socket.removeListener("close", this.onClose);
    const head = Buffer.concat([Buffer.from(this.lines.map(line => line + "\n").join(""), "utf8"), this.decoder.rest()]);
    this.lines.length = 0;
    return { socket: this.socket, head };
  }
}

function isWelcome(message: Record<string, unknown>): message is Record<string, unknown> & Welcome {
  const service = message.service as Partial<Welcome["service"]> | undefined;
  return message.ags === "welcome" && Number.isSafeInteger(message.protocol) && !!service && typeof service === "object"
    && typeof service.version === "string" && isInstalledVersion(service.version)
    && (service.build === null || typeof service.build === "string") && Number.isSafeInteger(service.minClientProtocol)
    && !!message.schema && typeof message.schema === "object" && !Array.isArray(message.schema);
}

/**
 * Challenge first, hello second (4.3 「접속 정보와 상호 확인」). The profile is sent only after the peer proved it holds
 * the endpoint key, so a process that created the address first learns nothing.
 */
async function handshake(channel: LineChannel, endpoint: EndpointRecord, options: EnsureServiceOptions,
  timeoutMs: number): Promise<Welcome> {
  const deadline = performance.now() + timeoutMs;
  const nonce = newNonce();
  channel.write({ ags: "challenge", nonce });
  const reply = await channel.next(remainingOf(deadline));
  if ("timeout" in reply) throw serviceFailure("SERVICE_HANDSHAKE_TIMEOUT", "The service did not answer the challenge.");
  // Node closes a connection over server.maxConnections before reading anything (4.3 backpressure).
  if ("closed" in reply) throw serviceFailure("SERVICE_CONNECTIONS_FULL", "The service closed the connection before the challenge.", "none", true);
  if ("failure" in reply) throw serviceFailure("SERVICE_IDENTITY_MISMATCH", "The endpoint did not prove the service key.");
  let challenge: Record<string, unknown> | null;
  try { challenge = parseMessage(reply.line); } catch { challenge = null; }
  if (!challenge || challenge.ags !== "challenge-reply" || !isNonce(challenge.serviceNonce)
    || !proofMatches(serviceProof(endpoint.key, nonce, challenge.serviceNonce), challenge.proof)) {
    throw serviceFailure("SERVICE_IDENTITY_MISMATCH", "The endpoint did not prove the service key.");
  }
  channel.write({
    ags: "hello", protocol: SERVICE_PROTOCOL, role: options.role, client: options.client,
    ...(options.profile ? { profile: options.profile } : {}),
    proof: clientProof(endpoint.key, challenge.serviceNonce),
  });
  const answer = await channel.next(remainingOf(deadline));
  if ("timeout" in answer) throw serviceFailure("SERVICE_HANDSHAKE_TIMEOUT", "The service did not answer the hello.");
  if ("closed" in answer) throw serviceFailure("SERVICE_HANDSHAKE_CLOSED", "The service closed the connection during the hello.", "none", true);
  if ("failure" in answer) throw answer.failure;
  const message = parseMessage(answer.line);
  if (message.ags === "refuse") {
    const reason = typeof message.reason === "string" && REASON.test(message.reason) ? message.reason : "SERVICE_REFUSED";
    throw serviceFailure(reason, "The service refused the connection.");
  }
  if (!isWelcome(message)) throw serviceFailure("SERVICE_PROTOCOL_ERROR", "The service sent no welcome.");
  return { protocol: message.protocol, service: message.service, schema: message.schema };
}

type Opened = { channel: LineChannel; welcome: Welcome };

/** Connects to the endpoint; null when nothing listens there (the caller may start the service). */
async function open(endpoint: EndpointRecord, options: EnsureServiceOptions, role: ServiceRole,
  timeoutMs: number): Promise<Opened | null> {
  let socket: net.Socket;
  try { socket = await connect(endpoint.address, timeoutMs); }
  catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return null;
    if (code === "SERVICE_CONNECT_TIMEOUT") throw error;
    throw retainFailureCause(serviceFailure("SERVICE_UNREACHABLE", "The service endpoint could not be reached."), error);
  }
  const channel = new LineChannel(socket);
  try {
    return { channel, welcome: await handshake(channel, endpoint, { ...options, role }, timeoutMs) };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/**
 * Connects to the running service, starting it when nothing listens and the caller may start it (4.2). A client newer
 * than the service asks it to hand over once, then starts its own; an older or equal client never does (D3).
 */
export async function ensureService(options: EnsureServiceOptions): Promise<ServiceSession> {
  if (!isInstalledVersion(options.client.version)) throw serviceFailure("SERVICE_CLIENT_INVALID", "The client version is not a release version.");
  const deadline = performance.now() + options.deadlineMs;
  const launch = options.launch === false ? null : options.launch ?? serviceLauncher(options.stateDirectory);
  let launches = 0;
  let lastLaunchAt = -Infinity;
  let attempt = 0;
  let handedOver = options.handover === false;
  for (;;) {
    const remaining = remainingOf(deadline);
    if (remaining < 1) {
      throw launches > 0 ? serviceFailure("SERVICE_START_TIMEOUT", "The started service did not answer in time.", "none", true)
        : serviceFailure("SERVICE_DEADLINE_EXPIRED", "The service connection deadline expired.");
    }
    const endpoint = readEndpoint(options.stateDirectory);
    const opened = endpoint ? await open(endpoint, options, options.role, remaining) : null;
    if (opened && endpoint) {
      if (!handedOver && compareRunningVersions(options.client.version, opened.welcome.service.version) > 0) {
        handedOver = true;
        await handOver(opened, endpoint, options, remainingOf(deadline));
        continue;
      }
      return new ServiceSession(opened.channel, opened.welcome, options);
    }
    if (!launch) throw serviceFailure("SERVICE_NOT_RUNNING", "The service is not running.");
    // A service that was just told to start may still be starting, or may have lost the lock to one that is ending.
    if (launches < MAX_LAUNCHES && (launches === 0 || performance.now() - lastLaunchAt >= RELAUNCH_AFTER_MS)) {
      launches += 1;
      lastLaunchAt = performance.now();
      await launch(remainingOf(deadline));
    }
    await sleep(Math.max(1, Math.min(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!, remainingOf(deadline))));
    attempt += 1;
  }
}

/** service.handover over an rpc connection, then waits until the old service closed it after releasing its lock. */
async function handOver(opened: Opened, endpoint: EndpointRecord, options: EnsureServiceOptions, remaining: number): Promise<void> {
  const deadline = performance.now() + remaining;
  let rpc = opened;
  if (options.role !== "rpc") {
    opened.channel.socket.destroy();
    const reopened = await open(endpoint, options, "rpc", remainingOf(deadline));
    if (!reopened) return;
    rpc = reopened;
  }
  const session = new ServiceSession(rpc.channel, rpc.welcome, { ...options, role: "rpc", launch: false });
  try {
    await session.request("service.handover", {}, { deadlineMs: remainingOf(deadline), idempotent: false });
    await session.waitClosed(remainingOf(deadline));
  } catch {
    // A refused or lost handover leaves whichever service is running; the caller connects to it as an older client would.
  } finally {
    session.close();
  }
}

export interface RequestOptions {
  /** Remaining time for this request, sent to the service as deadlineMs (4.3 요청 기한). */
  deadlineMs: number;
  /** Defaults to the method table (isIdempotentRequest). */
  idempotent?: boolean;
}

/**
 * One connection after the welcome. Role "rpc": requests one at a time. Role "mcp": detach() hands the stream over.
 * A connection lost before a response is a result-unknown failure; only a read is sent once more (D-0006).
 */
export class ServiceSession {
  private channel: LineChannel;
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(channel: LineChannel, public welcome: Welcome, private readonly options: EnsureServiceOptions) {
    this.channel = channel;
  }

  get closed(): boolean { return this.channel.closed; }

  request<T = unknown>(method: string, params: Readonly<Record<string, unknown>> = {}, options: RequestOptions): Promise<T> {
    const run = this.chain.then(() => this.exchange<T>(method, params, options));
    this.chain = run.catch(() => {});
    return run;
  }

  private async exchange<T>(method: string, params: Readonly<Record<string, unknown>>, options: RequestOptions): Promise<T> {
    const deadline = performance.now() + options.deadlineMs;
    const idempotent = options.idempotent ?? isIdempotentRequest(method, params);
    for (let attempt = 0; ; attempt += 1) {
      const remaining = remainingOf(deadline);
      if (remaining < 1) {
        throw attempt === 0 ? serviceFailure("SERVICE_DEADLINE_EXPIRED", "The request deadline expired before it was sent.")
          : serviceFailure("SERVICE_RESULT_UNKNOWN", "The connection was lost before the response.", "unknown");
      }
      if (this.channel.closed) {
        // Nothing of this request was sent on a new connection yet.
        try { await this.reconnect(remaining); }
        catch (error) {
          if (attempt === 0) throw error;
          throw retainFailureCause(serviceFailure("SERVICE_RESULT_UNKNOWN", "The connection was lost before the response.", "unknown"), error);
        }
      }
      const id = this.nextId++;
      const sentAt = remainingOf(deadline);
      if (sentAt < 1) throw serviceFailure("SERVICE_DEADLINE_EXPIRED", "The request deadline expired before it was sent.");
      this.channel.write({ jsonrpc: "2.0", id, method, params: { ...params, deadlineMs: sentAt } });
      const event = await this.channel.next(sentAt);
      if ("timeout" in event) {
        // A late response would answer the next request; this connection is finished.
        this.channel.socket.destroy();
        throw serviceFailure("SERVICE_DEADLINE_EXPIRED", "The service did not respond within the request deadline.", "unknown");
      }
      if ("failure" in event) throw event.failure;
      if ("closed" in event) {
        if (idempotent && attempt === 0) continue;
        throw serviceFailure("SERVICE_RESULT_UNKNOWN", "The connection was lost before the response.", "unknown");
      }
      const response = parseMessage(event.line);
      if (response.id !== id || response.jsonrpc !== "2.0") {
        this.channel.socket.destroy();
        throw serviceFailure("SERVICE_PROTOCOL_ERROR", "The service answered a different request.", "unknown");
      }
      if ("error" in response) throw responseFailure(response.error);
      return response.result as T;
    }
  }

  private async reconnect(remaining: number): Promise<void> {
    const session = await ensureService({ ...this.options, role: "rpc", deadlineMs: remaining });
    this.channel = session.channel;
    this.welcome = session.welcome;
  }

  /** Resolves when the service closed this connection; false when it did not within the time. */
  async waitClosed(timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (!this.channel.closed) {
      const remaining = remainingOf(deadline);
      if (remaining < 1) return false;
      const event = await this.channel.next(remaining);
      if ("timeout" in event) return false;
    }
    return true;
  }

  /** Role "mcp": the stream and any bytes already read after the welcome. The session no longer reads it. */
  detach(): { socket: net.Socket; head: Buffer } {
    return this.channel.detach();
  }

  close(): void {
    this.channel.socket.destroy();
  }
}

function responseFailure(error: unknown): ServiceFailure {
  const record = error && typeof error === "object" ? error as { message?: unknown; data?: unknown } : {};
  const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
  const reason = typeof data.reason === "string" && REASON.test(data.reason) ? data.reason : "SERVICE_REQUEST_FAILED";
  const message = typeof record.message === "string" && record.message.length <= 300 ? record.message : "The service rejected the request.";
  return serviceFailure(reason, message, data.effect === "none" ? "none" : "unknown", data.retryable === true, data.details);
}
