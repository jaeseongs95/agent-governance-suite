import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { resolveSessionMessageStateDirectory } from "./runtime-config.js";
import { SESSION_MESSAGE_MAX_RESPONSE_BYTES, SESSION_MESSAGE_PROTOCOL } from "./session-message-protocol.js";

export { SESSION_MESSAGE_PROTOCOL } from "./session-message-protocol.js";
export const WAKE_PREFIX = "[agent-governance-suite:wake:";

export interface BrokerEndpoint {
  protocolVersion: string;
  address: "127.0.0.1";
  port: number;
  pid: number;
  startedAt: string;
  certificateFingerprint256: string;
}

class BrokerRequestRejected extends Error {}

const BROKER_STARTUP_TIMEOUT_MS = 15_000;
const SESSION_MESSAGE_REQUEST_TIMEOUT_MS = 20_000;
const BROKER_REQUEST_TIMEOUT_MS = 2_500;

function statePaths(stateDirectory = resolveSessionMessageStateDirectory()) {
  return {
    stateDirectory,
    endpoint: path.join(stateDirectory, "endpoint.json"),
    token: path.join(stateDirectory, "broker.token"),
    certificate: path.join(stateDirectory, "broker-cert.pem"),
  };
}

export function sessionMessageBrokerEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  delete sanitized.CLAUDE_CODE_MESSAGING_SOCKET;
  delete sanitized.CLAUDE_CODE_MESSAGING_TOKEN;
  return sanitized;
}

async function readEndpoint(stateDirectory?: string): Promise<{ endpoint: BrokerEndpoint; token: string; certificate: string }> {
  const paths = statePaths(stateDirectory);
  const [rawEndpoint, rawToken, certificate] = await Promise.all([
    readFile(paths.endpoint, "utf8"),
    readFile(paths.token, "utf8"),
    readFile(paths.certificate, "utf8"),
  ]);
  const endpoint = JSON.parse(rawEndpoint) as BrokerEndpoint;
  if (endpoint.protocolVersion !== SESSION_MESSAGE_PROTOCOL
    || endpoint.address !== "127.0.0.1"
    || !Number.isInteger(endpoint.port)
    || endpoint.port < 1
    || endpoint.port > 65535
    || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(endpoint.certificateFingerprint256)
    || !/^[A-Za-z0-9_-]{43}$/u.test(rawToken.trim())) {
    throw new Error("The session message broker endpoint is invalid.");
  }
  return { endpoint, token: rawToken.trim(), certificate };
}

export async function requestSessionMessageOnce<T>(
  operation: string,
  payload: Record<string, unknown>,
  stateDirectory?: string,
  timeoutMs = BROKER_REQUEST_TIMEOUT_MS,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("The session message request deadline expired.");
  const { endpoint, token, certificate } = await readEndpoint(stateDirectory);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = tls.connect({
      host: endpoint.address,
      port: endpoint.port,
      ca: certificate,
      servername: "localhost",
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      rejectUnauthorized: true,
      checkServerIdentity: (_host, certificate) => certificate.fingerprint256 === endpoint.certificateFingerprint256
        ? undefined
        : new Error("The session message broker certificate pin did not match."),
    });
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value as T);
    };
    socket.setTimeout(Math.min(BROKER_REQUEST_TIMEOUT_MS, timeoutMs), () => finish(new Error("The session message broker timed out.")));
    socket.once("secureConnect", () => {
      const peer = socket.getPeerCertificate();
      if (!peer.fingerprint256 || peer.fingerprint256 !== endpoint.certificateFingerprint256) {
        finish(new Error("The session message broker certificate pin did not match."));
        return;
      }
      socket.write(`${JSON.stringify({ protocolVersion: SESSION_MESSAGE_PROTOCOL, token, operation, payload })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > SESSION_MESSAGE_MAX_RESPONSE_BYTES) return finish(new Error("The broker response exceeded its limit."));
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as { ok: boolean; data?: T; error?: string };
        if (!response.ok) finish(new BrokerRequestRejected(response.error || "The broker rejected the request."));
        else finish(undefined, response.data);
      } catch {
        finish(new Error("The broker returned invalid JSON."));
      }
    });
    socket.once("error", (error) => finish(error));
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForSessionMessageBrokerReady(
  stateDirectory: string,
  child: ChildProcess,
  timeoutMs = BROKER_STARTUP_TIMEOUT_MS,
): Promise<void> {
  let spawnError: Error | null = null;
  const onError = (error: Error) => { spawnError = error; };
  child.once("error", onError);
  try {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if ((child.exitCode !== null && child.exitCode !== 0) || child.signalCode !== null) {
        throw new Error(
          `The session message broker exited before it was ready (code ${String(child.exitCode)}, signal ${String(child.signalCode)}).`,
        );
      }
      await delay(100);
      try {
        await requestSessionMessageOnce("ping", {}, stateDirectory, Math.max(1, deadline - Date.now()));
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error("The session message broker did not become ready before the startup deadline.", { cause: lastError });
  } finally {
    child.off("error", onError);
  }
}

export async function ensureSessionMessageBroker(
  stateDirectory = resolveSessionMessageStateDirectory(),
  timeoutMs = BROKER_STARTUP_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + Math.min(BROKER_STARTUP_TIMEOUT_MS, timeoutMs);
  try {
    await requestSessionMessageOnce("ping", {}, stateDirectory, Math.max(1, deadline - Date.now()));
    return;
  } catch {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    try { await chmod(stateDirectory, 0o700); } catch { /* Windows ACLs remain governed by the user profile. */ }
    const adjacentBroker = fileURLToPath(new URL("./session-message-broker.mjs", import.meta.url));
    const brokerPath = existsSync(adjacentBroker)
      ? adjacentBroker
      : fileURLToPath(new URL("../dist/session-message-broker.mjs", import.meta.url));
    const child = spawn(process.execPath, [brokerPath, "--state-directory", stateDirectory], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: sessionMessageBrokerEnvironment(),
    });
    child.unref();
    await waitForSessionMessageBrokerReady(stateDirectory, child, Math.max(1, deadline - Date.now()));
    return;
  }
}

export async function sessionMessageRequest<T>(
  operation: string,
  payload: Record<string, unknown>,
  stateDirectory = resolveSessionMessageStateDirectory(),
  options: { totalTimeoutMs?: number } = {},
): Promise<T> {
  const totalTimeoutMs = options.totalTimeoutMs ?? SESSION_MESSAGE_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs < 1) throw new Error("The session message request timeout must be positive.");
  const deadline = Date.now() + totalTimeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    return await requestSessionMessageOnce<T>(operation, payload, stateDirectory, remaining());
  } catch (error) {
    if (error instanceof BrokerRequestRejected) throw error;
    await ensureSessionMessageBroker(stateDirectory, remaining());
    return requestSessionMessageOnce<T>(operation, payload, stateDirectory, remaining());
  }
}

export function wakeMessage(nonce: string): string {
  return `${WAKE_PREFIX}${nonce}]`;
}

export function parseWakeMessages(value: unknown): { nonces: string[]; wakeOnly: boolean } {
  if (typeof value !== "string") return { nonces: [], wakeOnly: false };
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const nonces: string[] = [];
  let wakeOnly = lines.length > 0;
  for (const line of lines) {
    if (!line.startsWith(WAKE_PREFIX) || !line.endsWith("]")) {
      wakeOnly = false;
      continue;
    }
    const nonce = line.slice(WAKE_PREFIX.length, -1);
    if (!/^[A-Za-z0-9_-]{22,128}$/u.test(nonce)) {
      wakeOnly = false;
      continue;
    }
    nonces.push(nonce);
  }
  return { nonces: [...new Set(nonces)], wakeOnly };
}

export function newWakeNonce(): string {
  return randomBytes(24).toString("base64url");
}
