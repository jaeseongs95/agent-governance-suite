import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { resolveSessionMessageStateDirectory } from "./runtime-config.js";

export const SESSION_MESSAGE_PROTOCOL = "1.0.0";
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

function statePaths(stateDirectory = resolveSessionMessageStateDirectory()) {
  return {
    stateDirectory,
    endpoint: path.join(stateDirectory, "endpoint.json"),
    token: path.join(stateDirectory, "broker.token"),
    certificate: path.join(stateDirectory, "broker-cert.pem"),
  };
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

export async function requestSessionMessageOnce<T>(operation: string, payload: Record<string, unknown>, stateDirectory?: string): Promise<T> {
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
    socket.setTimeout(2500, () => finish(new Error("The session message broker timed out.")));
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
      if (Buffer.byteLength(buffer, "utf8") > 32 * 1024) return finish(new Error("The broker response exceeded its limit."));
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

export async function ensureSessionMessageBroker(stateDirectory = resolveSessionMessageStateDirectory()): Promise<void> {
  try {
    await requestSessionMessageOnce("ping", {}, stateDirectory);
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
    });
    child.unref();
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(100);
    try {
      await requestSessionMessageOnce("ping", {}, stateDirectory);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The session message broker did not start.");
}

export async function sessionMessageRequest<T>(operation: string, payload: Record<string, unknown>, stateDirectory = resolveSessionMessageStateDirectory()): Promise<T> {
  try {
    return await requestSessionMessageOnce<T>(operation, payload, stateDirectory);
  } catch (error) {
    if (error instanceof BrokerRequestRejected) throw error;
    await ensureSessionMessageBroker(stateDirectory);
    return requestSessionMessageOnce<T>(operation, payload, stateDirectory);
  }
}

export function wakeMessage(nonce: string): string {
  return `${WAKE_PREFIX}${nonce}]`;
}

export function parseWakeMessage(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(WAKE_PREFIX) || !value.endsWith("]")) return null;
  const nonce = value.slice(WAKE_PREFIX.length, -1);
  return /^[A-Za-z0-9_-]{22,128}$/u.test(nonce) ? nonce : null;
}

export function newWakeNonce(): string {
  return randomBytes(24).toString("base64url");
}
