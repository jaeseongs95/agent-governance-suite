import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { producerFailure, retainFailureCause } from "../failure-diagnostics.js";
import { resolveSharedStateDirectory } from "../runtime-config.js";

/**
 * Where the per-user service listens and how both ends prove the same endpoint file
 * (docs/ags31-dbms-service-design.md 4.2, 4.3). The trust boundary is the OS user: whoever can read the endpoint
 * file can use the service.
 */
export const SERVICE_PROTOCOL = 1;
export const MIN_CLIENT_PROTOCOL = 1;
/** From accept to a verified hello; a connection that only holds a slot is closed. */
export const HANDSHAKE_TIMEOUT_MS = 1_000;
const KEY_BYTES = 32;
const NONCE_BYTES = 32;
/** sun_path minus the terminating NUL (Linux 108, macOS 104). */
const SOCKET_PATH_LIMIT: Partial<Record<NodeJS.Platform, number>> = { linux: 107, darwin: 103 };
const PIPE_PREFIX = "\\\\.\\pipe\\agent-governance-suite-";

export function serviceStateDirectory(stateDirectory: string): string {
  return path.join(stateDirectory, "service");
}

/**
 * The address a service started for this state directory listens on. Windows pipes get a new random name per start
 * so another user cannot occupy it in advance (8.1 M3). A Unix socket must not be shared by two state directories,
 * because only the holder of that directory's owner lock may remove a stale socket file: XDG_RUNTIME_DIR is used only
 * for the default state directory.
 */
export function serviceListenAddress(stateDirectory: string, platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env, homeDirectory: string = homedir()): string {
  if (platform === "win32") return PIPE_PREFIX + randomBytes(16).toString("hex");
  const runtime = environment.XDG_RUNTIME_DIR?.trim();
  const isDefault = path.resolve(stateDirectory) === resolveSharedStateDirectory({}, homeDirectory);
  const socketPath = platform === "linux" && runtime && path.isAbsolute(runtime) && isDefault
    ? path.join(runtime, "agent-governance-suite", "service.sock")
    : path.join(path.resolve(stateDirectory), "run", "service.sock");
  const limit = SOCKET_PATH_LIMIT[platform] ?? 103;
  // Shortening or moving the path elsewhere would create a second, unguarded address.
  if (Buffer.byteLength(socketPath, "utf8") > limit) {
    throw producerFailure("SERVICE_SOCKET_PATH_TOO_LONG", "The service socket path exceeds the platform limit.");
  }
  return socketPath;
}

export function isPipeAddress(address: string): boolean {
  return address.startsWith("\\\\.\\pipe\\");
}

/** Creates a user-only directory and refuses one that is a link or owned by another user. */
export function prepareUserDirectory(directory: string): void {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
      throw producerFailure("SERVICE_DIRECTORY_UNSAFE", "The service directory is not a user-owned directory.");
    }
    if (process.platform !== "win32") chmodSync(directory, 0o700);
  } catch (cause) {
    if ((cause as { code?: unknown }).code === "SERVICE_DIRECTORY_UNSAFE") throw cause;
    throw retainFailureCause(producerFailure("SERVICE_DIRECTORY_FAILED", "Cannot prepare the service directory."), cause);
  }
}

export interface EndpointRecord {
  address: string;
  /** base64url of 32 random bytes, new for every service start. */
  key: string;
  pid: number;
  version: string;
  startedAt: string;
}

export function newEndpointKey(): string {
  return randomBytes(KEY_BYTES).toString("base64url");
}

function endpointPath(stateDirectory: string): string {
  return path.join(serviceStateDirectory(stateDirectory), "endpoint.json");
}

function isEndpointRecord(value: unknown): value is EndpointRecord {
  const record = value as Partial<EndpointRecord> | null;
  return !!record && typeof record === "object" && typeof record.address === "string" && record.address.length > 0
    && typeof record.key === "string" && Buffer.from(record.key, "base64url").length === KEY_BYTES
    && Number.isSafeInteger(record.pid) && typeof record.version === "string" && typeof record.startedAt === "string";
}

/** Written once by the lock holder after listen succeeded: a temporary file, then rename. */
export function writeEndpoint(stateDirectory: string, record: EndpointRecord): void {
  const target = endpointPath(stateDirectory);
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    // Windows refuses to replace a file another process has open for a moment (a client reading it).
    for (let attempt = 1; ; attempt += 1) {
      try { renameSync(temporary, target); break; }
      catch (cause) {
        const code = (cause as { code?: unknown }).code;
        if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(String(code))) throw cause;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
      }
    }
  } catch (cause) {
    try { rmSync(temporary, { force: true }); } catch { /* The failure below is the reported one. */ }
    throw retainFailureCause(producerFailure("SERVICE_ENDPOINT_WRITE_FAILED", "Cannot write the service endpoint file."), cause);
  }
}

/** null when there is no usable endpoint file; the caller then treats the service as not running. */
export function readEndpoint(stateDirectory: string): EndpointRecord | null {
  let text: string;
  try { text = readFileSync(endpointPath(stateDirectory), "utf8"); }
  catch (cause) {
    if ((cause as { code?: unknown }).code === "ENOENT") return null;
    throw retainFailureCause(producerFailure("SERVICE_ENDPOINT_READ_FAILED", "Cannot read the service endpoint file."), cause);
  }
  try {
    const value: unknown = JSON.parse(text);
    return isEndpointRecord(value) ? value : null;
  } catch { return null; }
}

/** Removes the endpoint file only while it still names this start; a newer service may have replaced it. */
export function removeEndpointIfOwned(stateDirectory: string, key: string): void {
  const current = readEndpoint(stateDirectory);
  if (current?.key === key) rmSync(endpointPath(stateDirectory), { force: true });
}

/** sha256 of the service entry file: the build a client would start, or the build that is running. null if unreadable. */
export function readBuildDigest(file: string): string | null {
  try { return "sha256:" + createHash("sha256").update(readFileSync(file)).digest("hex"); }
  catch { return null; }
}

export function newNonce(): string {
  return randomBytes(NONCE_BYTES).toString("base64url");
}

export function isNonce(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Buffer.from(value, "base64url").length === NONCE_BYTES;
}

/** HMAC-SHA256(key, "service" ‖ nonce ‖ serviceNonce): the service proves it read this endpoint file. */
export function serviceProof(key: string, nonce: string, serviceNonce: string): string {
  return createHmac("sha256", Buffer.from(key, "base64url")).update("service")
    .update(Buffer.from(nonce, "base64url")).update(Buffer.from(serviceNonce, "base64url")).digest("base64url");
}

/** HMAC-SHA256(key, "client" ‖ serviceNonce): the client proves the same. */
export function clientProof(key: string, serviceNonce: string): string {
  return createHmac("sha256", Buffer.from(key, "base64url")).update("client")
    .update(Buffer.from(serviceNonce, "base64url")).digest("base64url");
}

export function proofMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || actual.length > 64) return false;
  const left = Buffer.from(expected, "base64url");
  const right = Buffer.from(actual, "base64url");
  return left.length === right.length && timingSafeEqual(left, right);
}
