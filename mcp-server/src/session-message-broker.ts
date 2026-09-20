import { createHash, createPublicKey, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { SESSION_MESSAGE_MAX_REQUEST_BYTES, SESSION_MESSAGE_PROTOCOL } from "./session-message-protocol.js";
import { SessionMessageStore, type SessionIdentity } from "./session-message-store.js";
import { createSelfSignedCertificate } from "./self-signed-certificate.js";

const IDLE_EXIT_MS = 60_000;

interface BrokerRequest {
  protocolVersion: string;
  token: string;
  operation: string;
  payload: Record<string, unknown>;
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function identity(value: unknown): SessionIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session identity is required.");
  const record = value as Record<string, unknown>;
  if (typeof record.host !== "string" || typeof record.sessionId !== "string") throw new Error("Session identity is invalid.");
  return { host: record.host, sessionId: record.sessionId };
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

function optionalInteger(record: Record<string, unknown>, name: string): number | undefined {
  return Object.hasOwn(record, name) ? integer(record[name], name) : undefined;
}

function optionalString(record: Record<string, unknown>, name: string): string | undefined {
  return Object.hasOwn(record, name) ? string(record[name], name) : undefined;
}

function tokenMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireProcessLock(lockPath: string): number | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      return descriptor;
    } catch {
      try {
        const owner = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
        if (Number.isInteger(owner) && alive(owner)) return null;
        rmSync(lockPath, { force: true });
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function credentials(stateDirectory: string): Promise<{ key: string; certificate: string; token: string; fingerprint256: string }> {
  const keyPath = path.join(stateDirectory, "broker-key.pem");
  const certificatePath = path.join(stateDirectory, "broker-cert.pem");
  const tokenPath = path.join(stateDirectory, "broker.token");
  let key = "";
  let certificate = "";
  let regenerate = true;
  if (existsSync(keyPath) && existsSync(certificatePath)) {
    try {
      [key, certificate] = await Promise.all([readFile(keyPath, "utf8"), readFile(certificatePath, "utf8")]);
      const parsed = new X509Certificate(certificate);
      const privatePublic = createPublicKey(key).export({ type: "spki", format: "der" });
      const certificatePublic = parsed.publicKey.export({ type: "spki", format: "der" });
      regenerate = Date.parse(parsed.validTo) <= Date.now() + 24 * 3600_000 || !privatePublic.equals(certificatePublic);
    } catch {
      regenerate = true;
    }
  }
  if (regenerate) {
    const generated = createSelfSignedCertificate();
    key = generated.privateKeyPem;
    certificate = generated.certificatePem;
    if (existsSync(keyPath) || existsSync(certificatePath)) {
      await Promise.all([
        writeFile(keyPath, key, { encoding: "utf8", mode: 0o600 }),
        writeFile(certificatePath, certificate, { encoding: "utf8", mode: 0o600 }),
      ]);
    } else {
      const suffix = `${process.pid}.${Date.now()}.tmp`;
      const temporaryKey = `${keyPath}.${suffix}`;
      const temporaryCertificate = `${certificatePath}.${suffix}`;
      await Promise.all([
        writeFile(temporaryKey, key, { encoding: "utf8", mode: 0o600 }),
        writeFile(temporaryCertificate, certificate, { encoding: "utf8", mode: 0o600 }),
      ]);
      renameSync(temporaryKey, keyPath);
      renameSync(temporaryCertificate, certificatePath);
    }
  }
  let token: string;
  if (existsSync(tokenPath)) token = (await readFile(tokenPath, "utf8")).trim();
  else token = "";
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    token = randomBytes(32).toString("base64url");
    await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  }
  for (const target of [keyPath, certificatePath, tokenPath]) {
    try { await chmod(target, 0o600); } catch { /* Best effort on Windows. */ }
  }
  return { key, certificate, token, fingerprint256: new X509Certificate(certificate).fingerprint256 };
}

function dispatch(store: SessionMessageStore, operation: string, payload: Record<string, unknown>): unknown {
  switch (operation) {
    case "ping": return { protocolVersion: SESSION_MESSAGE_PROTOCOL };
    case "send": {
      const messageId = optionalString(payload, "messageId");
      const ttlSeconds = optionalInteger(payload, "ttlSeconds");
      return store.send({
        ...(messageId === undefined ? {} : { messageId }),
        sender: identity(payload.sender),
        target: identity(payload.target),
        body: string(payload.body, "body"),
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      });
    }
    case "claim": {
      const maxMessages = optionalInteger(payload, "maxMessages");
      const maxBodyChars = optionalInteger(payload, "maxBodyChars");
      return { messages: store.claim(identity(payload.target), Date.now(), {
        ...(maxMessages === undefined ? {} : { maxMessages }),
        ...(maxBodyChars === undefined ? {} : { maxBodyChars }),
      }) };
    }
    case "acknowledge": return { acknowledged: store.acknowledge(identity(payload.target), Array.isArray(payload.messageIds) ? payload.messageIds.map((value) => string(value, "messageId")) : []) };
    case "status": return { status: store.status(identity(payload.sender), string(payload.messageId, "messageId")) };
    case "pending": return { count: store.pendingCount(identity(payload.target)) };
    case "acquire-relay": {
      const target = identity(payload.target);
      return { acquired: store.acquireRelay({
        ...target,
        transport: string(payload.transport, "transport"),
        relayId: string(payload.relayId, "relayId"),
        pid: integer(payload.pid, "pid"),
        parentPid: integer(payload.parentPid, "parentPid"),
      }) };
    }
    case "heartbeat-relay": {
      const target = identity(payload.target);
      return { alive: store.heartbeatRelay({ ...target, transport: string(payload.transport, "transport"), relayId: string(payload.relayId, "relayId") }) };
    }
    case "reserve-wake": return { dispatch: store.reserveWake(identity(payload.target), string(payload.nonce, "nonce")) };
    case "release-wake": return { released: store.releaseWake(identity(payload.target), string(payload.nonce, "nonce")) };
    case "consume-wake": return { consumed: store.consumeWake(identity(payload.target), string(payload.nonce, "nonce")) };
    default: throw new Error("Unknown broker operation.");
  }
}

export async function startSessionMessageBroker(stateDirectory: string): Promise<"started" | "already-running"> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  try { await chmod(stateDirectory, 0o700); } catch { /* Windows ACLs remain governed by the user profile. */ }
  const lockPath = path.join(stateDirectory, "broker.lock");
  const lockDescriptor = acquireProcessLock(lockPath);
  if (lockDescriptor === null) return "already-running";
  const endpointPath = path.join(stateDirectory, "endpoint.json");
  const databasePath = path.join(stateDirectory, "session-messages.sqlite3");
  const { key, certificate, token, fingerprint256 } = await credentials(stateDirectory);
  const store = new SessionMessageStore(databasePath);
  let lastActivity = Date.now();
  const server = tls.createServer({ key, cert: certificate, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, (socket) => {
    lastActivity = Date.now();
    let buffer = "";
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > SESSION_MESSAGE_MAX_REQUEST_BYTES) {
        socket.end(`${JSON.stringify({ ok: false, error: "Request exceeds the broker limit." })}\n`);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      try {
        const request = JSON.parse(line) as BrokerRequest;
        if (request.protocolVersion !== SESSION_MESSAGE_PROTOCOL || !tokenMatches(request.token ?? "", token)) throw new Error("Broker authentication failed.");
        const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload) ? request.payload : {};
        const data = dispatch(store, request.operation, payload);
        socket.end(`${JSON.stringify({ ok: true, data })}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Broker request failed." })}\n`);
      }
    });
  });
  const cleanup = () => {
    try { server.close(); } catch { /* Already closed. */ }
    try { store.close(); } catch { /* Already closed. */ }
    try { rmSync(endpointPath, { force: true }); } catch { /* Best effort. */ }
    try { closeSync(lockDescriptor); } catch { /* Best effort. */ }
    try { rmSync(lockPath, { force: true }); } catch { /* Best effort. */ }
  };
  process.once("exit", cleanup);
  process.once("SIGTERM", () => { cleanup(); process.exit(0); });
  process.once("SIGINT", () => { cleanup(); process.exit(0); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The broker did not receive a TCP port.");
  const endpoint = {
    protocolVersion: SESSION_MESSAGE_PROTOCOL,
    address: "127.0.0.1",
    port: address.port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    certificateFingerprint256: fingerprint256,
  };
  const temporary = `${endpointPath}.${process.pid}.${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 8)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(endpoint)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, endpointPath);
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity < IDLE_EXIT_MS) return;
    cleanup();
    process.exit(0);
  }, 5000);
  idleTimer.unref();
  return "started";
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const stateDirectory = argument("--state-directory");
  if (!stateDirectory) process.exitCode = 2;
  else void startSessionMessageBroker(path.resolve(stateDirectory)).then((result) => {
    if (result === "already-running") process.exit(0);
  }).catch(() => { process.exitCode = 1; });
}
