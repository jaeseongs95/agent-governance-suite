import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientProof, newEndpointKey, newNonce, proofMatches, readEndpoint, removeEndpointIfOwned, serviceListenAddress,
  serviceProof, serviceStateDirectory, writeEndpoint, prepareUserDirectory, type EndpointRecord } from "../../mcp-server/src/service/ipc-endpoint.js";
import { encodeLine, LineDecoder } from "../../mcp-server/src/service/ipc-framing.js";
import { ensureService, type EnsureServiceOptions } from "../../mcp-server/src/service/service-client.js";
import { cimLaunchScript } from "../../mcp-server/src/service/detached-launch.js";

// docs/ags31-dbms-service-design.md 4.3, commit 1-1: framing, address, mutual proof, deadline, result-unknown.
// The peer here is a scripted endpoint, so each misbehaviour (wrong key, squatter, lost connection) is exact.

let root: string;
let state: string;
const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ags-ipc-"));
  state = path.join(root, "s");
  prepareUserDirectory(serviceStateDirectory(state));
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  fs.rmSync(root, { recursive: true, force: true });
});

function testAddress(): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\ags-ipc-test-${randomUUID()}` : path.join(root, `${randomUUID().slice(0, 8)}.sock`);
}

interface Script {
  /** The key the peer proves with; a different one than the endpoint file's key is the wrong-key case. */
  proofKey?: string;
  /** Answer the challenge with this instead of a proof (a squatter that never saw the key). */
  challengeAnswer?: Record<string, unknown>;
  closeOnAccept?: boolean;
  refuse?: string;
  version?: string;
  onRequest?: (message: Record<string, unknown>, socket: net.Socket, count: number) => void;
}

interface Peer { endpoint: EndpointRecord; hellos: Record<string, unknown>[]; requests: Record<string, unknown>[]; connections: number }

async function startPeer(script: Script = {}, write = true): Promise<Peer> {
  const key = newEndpointKey();
  const address = testAddress();
  const peer: Peer = { endpoint: { address, key, pid: process.pid, version: script.version ?? "3.0.2", startedAt: new Date().toISOString() },
    hellos: [], requests: [], connections: 0 };
  const server = net.createServer(socket => {
    peer.connections += 1;
    sockets.add(socket);
    socket.on("error", () => {});
    if (script.closeOnAccept) { socket.destroy(); return; }
    const decoder = new LineDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.ags === "challenge") {
          if (script.challengeAnswer) { socket.write(encodeLine(script.challengeAnswer)); continue; }
          const serviceNonce = newNonce();
          socket.write(encodeLine({ ags: "challenge-reply", serviceNonce,
            proof: serviceProof(script.proofKey ?? key, message.nonce as string, serviceNonce) }));
          (socket as net.Socket & { serviceNonce?: string }).serviceNonce = serviceNonce;
        } else if (message.ags === "hello") {
          peer.hellos.push(message);
          const expected = clientProof(key, (socket as net.Socket & { serviceNonce?: string }).serviceNonce!);
          if (script.refuse || !proofMatches(expected, message.proof)) {
            socket.end(encodeLine({ ags: "refuse", reason: script.refuse ?? "SERVICE_CLIENT_UNVERIFIED" }));
            continue;
          }
          socket.write(encodeLine({ ags: "welcome", protocol: 1,
            service: { version: script.version ?? "3.0.2", build: null, minClientProtocol: 1 }, schema: {} }));
        } else {
          peer.requests.push(message);
          if (script.onRequest) script.onRequest(message, socket, peer.requests.length);
          else socket.write(encodeLine({ jsonrpc: "2.0", id: message.id, result: { method: message.method } }));
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
  if (write) writeEndpoint(state, peer.endpoint);
  return peer;
}

function options(overrides: Partial<EnsureServiceOptions> = {}): EnsureServiceOptions {
  return { stateDirectory: state, role: "rpc", client: { kind: "test", version: "3.0.2", build: null },
    profile: { installRoot: "/x" }, deadlineMs: 5_000, launch: false, ...overrides };
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("line framing", () => {
  it("joins chunks split inside a line and inside a multi-byte character, and accepts CRLF", () => {
    const decoder = new LineDecoder();
    const bytes = Buffer.from("{\"a\":\"한글\"}\r\n{\"b\":1}\n{\"c\"", "utf8");
    const lines: string[] = [];
    for (let index = 0; index < bytes.length; index += 1) lines.push(...decoder.push(bytes.subarray(index, index + 1)));
    expect(lines).toEqual(["{\"a\":\"한글\"}", "{\"b\":1}"]);
    expect(decoder.rest().toString("utf8")).toBe("{\"c\"");
  });

  it("refuses a line over the limit with SERVICE_LINE_TOO_LONG, with or without its newline", () => {
    expect(new LineDecoder(8).push(Buffer.from("12345678\n"))).toEqual(["12345678"]);
    expect(() => new LineDecoder(8).push(Buffer.from("123456789"))).toThrow(expect.objectContaining({ code: "SERVICE_LINE_TOO_LONG" }));
    const split = new LineDecoder(8);
    split.push(Buffer.from("12345"));
    expect(() => split.push(Buffer.from("6789\n"))).toThrow(expect.objectContaining({ code: "SERVICE_LINE_TOO_LONG" }));
    expect(() => encodeLine("x".repeat(20), 8)).toThrow(expect.objectContaining({ code: "SERVICE_LINE_TOO_LONG" }));
  });
});

describe("service address and endpoint file", () => {
  it("gives Windows a new random pipe name per start", () => {
    const first = serviceListenAddress(state, "win32");
    expect(first).toMatch(/^\\\\\.\\pipe\\agent-governance-suite-[0-9a-f]{32}$/u);
    expect(serviceListenAddress(state, "win32")).not.toBe(first);
  });

  // Unix socket paths are resolved with the host path module, so these cases run on the Unix hosts they describe.
  it.skipIf(process.platform === "win32")("uses XDG_RUNTIME_DIR only for the default state directory and fails a socket path over sun_path", () => {
    const home = path.join(path.sep, "home", "u");
    const defaultState = path.join(home, ".agent-governance-suite");
    expect(serviceListenAddress(defaultState, "linux", { XDG_RUNTIME_DIR: "/run/user/1000" }, home))
      .toBe(path.join("/run/user/1000", "agent-governance-suite", "service.sock"));
    expect(serviceListenAddress(path.join(home, "other"), "linux", { XDG_RUNTIME_DIR: "/run/user/1000" }, home))
      .toBe(path.join(home, "other", "run", "service.sock"));
    expect(serviceListenAddress(defaultState, "darwin", { XDG_RUNTIME_DIR: "/run/user/1000" }, home))
      .toBe(path.join(defaultState, "run", "service.sock"));
    const long = path.join(path.sep, "t", "x".repeat(110));
    expect(() => serviceListenAddress(long, "linux", {}, home)).toThrow(expect.objectContaining({ code: "SERVICE_SOCKET_PATH_TOO_LONG" }));
    // macOS has the shorter limit: 103 bytes fit Linux but not macOS.
    const between = path.join(path.sep, "t", "y".repeat(103 - "/t/".length - "/run/service.sock".length + 2));
    expect(Buffer.byteLength(path.join(between, "run", "service.sock"))).toBe(105);
    expect(serviceListenAddress(between, "linux", {}, home)).toBe(path.join(between, "run", "service.sock"));
    expect(() => serviceListenAddress(between, "darwin", {}, home)).toThrow(expect.objectContaining({ code: "SERVICE_SOCKET_PATH_TOO_LONG" }));
  });

  it("writes the endpoint file user-only and removes it only for the start that wrote it", () => {
    const record: EndpointRecord = { address: "a", key: newEndpointKey(), pid: 1, version: "3.0.2", startedAt: "t" };
    writeEndpoint(state, record);
    expect(readEndpoint(state)).toEqual(record);
    const file = path.join(serviceStateDirectory(state), "endpoint.json");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    removeEndpointIfOwned(state, newEndpointKey());
    expect(readEndpoint(state)).toEqual(record);
    removeEndpointIfOwned(state, record.key);
    expect(readEndpoint(state)).toBeNull();
  });

  it("builds the Windows CIM command with every argument quoted for CommandLineToArgvW", () => {
    const script = cimLaunchScript(["C:\\a b\\ags-service.mjs", "--state-dir", "C:\\x\\it's \"q\"\\"]);
    expect(script).toContain("Invoke-CimMethod -ClassName Win32_Process -MethodName Create");
    expect(script).toContain("ShowWindow=[uint16]0");
    expect(script).toContain("\"C:\\a b\\ags-service.mjs\" --state-dir \"C:\\x\\it''s \\\"q\\\"\\\\\"");
  });
});

describe("mutual proof before hello", () => {
  it("connects to a peer that proves the endpoint key and sends the profile only after that", async () => {
    const peer = await startPeer();
    const session = await ensureService(options());
    expect(session.welcome.service.version).toBe("3.0.2");
    expect(peer.hellos).toHaveLength(1);
    expect(peer.hellos[0]).toMatchObject({ ags: "hello", protocol: 1, role: "rpc", profile: { installRoot: "/x" } });
    expect(await session.request("service.echo", { value: 1 }, { deadlineMs: 2_000 })).toEqual({ method: "service.echo" });
    expect(peer.requests[0]).toMatchObject({ jsonrpc: "2.0", method: "service.echo", params: { value: 1, deadlineMs: expect.any(Number) } });
    session.close();
  });

  it("rejects a peer proving a different key as SERVICE_IDENTITY_MISMATCH, sends no hello and starts nothing", async () => {
    const peer = await startPeer({ proofKey: newEndpointKey() });
    const launch = vi.fn(async () => {});
    await expect(ensureService(options({ launch }))).rejects.toMatchObject({ code: "SERVICE_IDENTITY_MISMATCH" });
    expect(peer.hellos).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects a squatter that answers the challenge with a welcome", async () => {
    const peer = await startPeer({ challengeAnswer: { ags: "welcome", protocol: 1, service: { version: "3.0.2", build: null, minClientProtocol: 1 }, schema: {} } });
    await expect(ensureService(options())).rejects.toMatchObject({ code: "SERVICE_IDENTITY_MISMATCH" });
    expect(peer.hellos).toEqual([]);
  });

  it("reports the service's refuse reason", async () => {
    await startPeer({ refuse: "SERVICE_PROTOCOL_UNSUPPORTED" });
    await expect(ensureService(options())).rejects.toMatchObject({ code: "SERVICE_PROTOCOL_UNSUPPORTED", effect: "none" });
  });

  it("reports a connection closed before the challenge answer as SERVICE_CONNECTIONS_FULL", async () => {
    await startPeer({ closeOnAccept: true });
    await expect(ensureService(options())).rejects.toMatchObject({ code: "SERVICE_CONNECTIONS_FULL", effect: "none" });
  });
});

describe("finding or starting the service", () => {
  it("does not start a service when the caller may not", async () => {
    await expect(ensureService(options())).rejects.toMatchObject({ code: "SERVICE_NOT_RUNNING" });
  });

  it("starts the service once when nothing listens at the recorded address, then connects", async () => {
    writeEndpoint(state, { address: testAddress(), key: newEndpointKey(), pid: 1, version: "3.0.2", startedAt: "t" });
    let peer: Peer | undefined;
    const launch = vi.fn(async () => { setTimeout(() => { void startPeer().then(started => { peer = started; }); }, 30); });
    const session = await ensureService(options({ launch }));
    expect(launch).toHaveBeenCalledTimes(1);
    expect(peer?.hellos).toHaveLength(1);
    session.close();
  });

  it("gives up with SERVICE_START_TIMEOUT when the started service never answers", async () => {
    const launch = vi.fn(async () => {});
    await expect(ensureService(options({ launch, deadlineMs: 400 }))).rejects.toMatchObject({ code: "SERVICE_START_TIMEOUT" });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("asks an older service to hand over once, waits for it to close, then starts and uses its own", async () => {
    let handovers = 0;
    const old = await startPeer({ version: "3.0.1", onRequest: (message, socket) => {
      if (message.method !== "service.handover") return;
      handovers += 1;
      socket.write(encodeLine({ jsonrpc: "2.0", id: message.id, result: { accepted: true } }));
      fs.rmSync(path.join(serviceStateDirectory(state), "endpoint.json"));
      setTimeout(() => socket.destroy(), 50);
    } });
    let started: Peer | undefined;
    const launch = vi.fn(async () => { started = await startPeer({ version: "3.0.3" }); });
    const client = { kind: "test", version: "3.0.3", build: null };
    const upgraded = await ensureService(options({ role: "mcp", client, launch }));
    expect(handovers).toBe(1);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(upgraded.welcome.service.version).toBe("3.0.3");
    // role mcp: the handover went over a separate rpc connection after the mcp hello.
    expect(old.hellos.map(hello => hello.role)).toEqual(["mcp", "rpc"]);
    expect(started?.hellos.map(hello => hello.role)).toEqual(["mcp"]);
    upgraded.close();

    // Equal and older clients never ask the service to hand over.
    for (const version of ["3.0.3", "3.0.2"]) {
      const session = await ensureService(options({ client: { kind: "test", version, build: null }, launch }));
      expect(session.welcome.service.version).toBe("3.0.3");
      session.close();
    }
    expect(handovers).toBe(1);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(started?.requests).toEqual([]);
  });
});

describe("request deadline and uncertain results", () => {
  it("sends nothing when the deadline is already over", async () => {
    const peer = await startPeer();
    const session = await ensureService(options());
    await expect(session.request("test.write", {}, { deadlineMs: 0 })).rejects.toMatchObject({ code: "SERVICE_DEADLINE_EXPIRED", effect: "none" });
    await pause(50);
    expect(peer.requests).toEqual([]);
    session.close();
  });

  it("reports a request without a response in time as SERVICE_DEADLINE_EXPIRED with an unknown effect", async () => {
    await startPeer({ onRequest: () => {} });
    const session = await ensureService(options());
    const started = performance.now();
    await expect(session.request("test.write", {}, { deadlineMs: 200 })).rejects.toMatchObject({ code: "SERVICE_DEADLINE_EXPIRED", effect: "unknown" });
    expect(performance.now() - started).toBeLessThan(2_000);
    session.close();
  });

  it("never sends a write again after the connection is lost before the response", async () => {
    const peer = await startPeer({ onRequest: (_message, socket) => socket.destroy() });
    const session = await ensureService(options());
    await expect(session.request("test.write", { n: 1 }, { deadlineMs: 2_000 })).rejects.toMatchObject({ code: "SERVICE_RESULT_UNKNOWN", effect: "unknown" });
    await pause(100);
    expect(peer.requests).toHaveLength(1);
    expect(peer.connections).toBe(1);
  });

  it("sends a read once more on a new connection, and only once", async () => {
    const peer = await startPeer({ onRequest: (message, socket, count) => {
      if (count === 1) socket.destroy();
      else socket.write(encodeLine({ jsonrpc: "2.0", id: message.id, result: { count } }));
    } });
    const session = await ensureService(options());
    expect(await session.request("service.status", {}, { deadlineMs: 3_000 })).toEqual({ count: 2 });
    expect(peer.requests.map(request => request.method)).toEqual(["service.status", "service.status"]);
    expect(peer.connections).toBe(2);
    session.close();

    const lost = await startPeer({ onRequest: (_message, socket) => socket.destroy() });
    const again = await ensureService(options());
    await expect(again.request("service.status", {}, { deadlineMs: 3_000 })).rejects.toMatchObject({ code: "SERVICE_RESULT_UNKNOWN" });
    expect(lost.requests).toHaveLength(2);
  });

  it("carries the service's error reason, effect and details", async () => {
    await startPeer({ onRequest: (message, socket) => socket.write(encodeLine({ jsonrpc: "2.0", id: message.id,
      error: { code: -32001, message: "busy", data: { reason: "SERVICE_BUSY", retryable: true, effect: "none", details: { queueLength: 64 } } } })) });
    const session = await ensureService(options());
    await expect(session.request("test.write", {}, { deadlineMs: 1_000 })).rejects.toMatchObject({
      code: "SERVICE_BUSY", effect: "none", retryable: true, details: { queueLength: 64 } });
    session.close();
  });
});
