#!/usr/bin/env node

// mcp-server/src/session-message-cli.ts
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path3 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// mcp-server/src/session-message-client.ts
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path2 from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

// mcp-server/src/runtime-config.ts
import { homedir } from "node:os";
import path from "node:path";
function userStateDirectory(environment, platform, homeDirectory) {
  let stateRoot;
  if (platform === "win32") {
    stateRoot = environment.LOCALAPPDATA?.trim() || path.join(homeDirectory, "AppData", "Local");
  } else if (platform === "darwin") {
    stateRoot = path.join(homeDirectory, "Library", "Application Support");
  } else {
    stateRoot = environment.XDG_STATE_HOME?.trim() || path.join(homeDirectory, ".local", "state");
  }
  return path.resolve(stateRoot, "agent-governance-suite");
}
function resolveSessionMessageStateDirectory(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  const configured = environment.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR?.trim();
  if (configured) return path.resolve(currentWorkingDirectory, configured);
  return path.join(userStateDirectory(environment, platform, homeDirectory), "session-messaging");
}

// mcp-server/src/session-message-protocol.ts
var SESSION_MESSAGE_PROTOCOL = "1.0.0";
var SESSION_MESSAGE_MAX_REQUEST_BYTES = 32 * 1024;
var SESSION_MESSAGE_MAX_RESPONSE_BYTES = 32 * 1024;

// mcp-server/src/session-message-client.ts
var BrokerRequestRejected = class extends Error {
};
function statePaths(stateDirectory = resolveSessionMessageStateDirectory()) {
  return {
    stateDirectory,
    endpoint: path2.join(stateDirectory, "endpoint.json"),
    token: path2.join(stateDirectory, "broker.token"),
    certificate: path2.join(stateDirectory, "broker-cert.pem")
  };
}
function sessionMessageBrokerEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  delete sanitized.CLAUDE_CODE_MESSAGING_SOCKET;
  delete sanitized.CLAUDE_CODE_MESSAGING_TOKEN;
  return sanitized;
}
async function readEndpoint(stateDirectory) {
  const paths = statePaths(stateDirectory);
  const [rawEndpoint, rawToken, certificate] = await Promise.all([
    readFile(paths.endpoint, "utf8"),
    readFile(paths.token, "utf8"),
    readFile(paths.certificate, "utf8")
  ]);
  const endpoint = JSON.parse(rawEndpoint);
  if (endpoint.protocolVersion !== SESSION_MESSAGE_PROTOCOL || endpoint.address !== "127.0.0.1" || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(endpoint.certificateFingerprint256) || !/^[A-Za-z0-9_-]{43}$/u.test(rawToken.trim())) {
    throw new Error("The session message broker endpoint is invalid.");
  }
  return { endpoint, token: rawToken.trim(), certificate };
}
async function requestSessionMessageOnce(operation, payload, stateDirectory) {
  const { endpoint, token, certificate } = await readEndpoint(stateDirectory);
  return new Promise((resolve, reject) => {
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
      checkServerIdentity: (_host, certificate2) => certificate2.fingerprint256 === endpoint.certificateFingerprint256 ? void 0 : new Error("The session message broker certificate pin did not match.")
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(2500, () => finish(new Error("The session message broker timed out.")));
    socket.once("secureConnect", () => {
      const peer = socket.getPeerCertificate();
      if (!peer.fingerprint256 || peer.fingerprint256 !== endpoint.certificateFingerprint256) {
        finish(new Error("The session message broker certificate pin did not match."));
        return;
      }
      socket.write(`${JSON.stringify({ protocolVersion: SESSION_MESSAGE_PROTOCOL, token, operation, payload })}
`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > SESSION_MESSAGE_MAX_RESPONSE_BYTES) return finish(new Error("The broker response exceeded its limit."));
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response.ok) finish(new BrokerRequestRejected(response.error || "The broker rejected the request."));
        else finish(void 0, response.data);
      } catch {
        finish(new Error("The broker returned invalid JSON."));
      }
    });
    socket.once("error", (error) => finish(error));
  });
}
async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function ensureSessionMessageBroker(stateDirectory = resolveSessionMessageStateDirectory()) {
  try {
    await requestSessionMessageOnce("ping", {}, stateDirectory);
    return;
  } catch {
    await mkdir(stateDirectory, { recursive: true, mode: 448 });
    try {
      await chmod(stateDirectory, 448);
    } catch {
    }
    const adjacentBroker = fileURLToPath(new URL("./session-message-broker.mjs", import.meta.url));
    const brokerPath = existsSync(adjacentBroker) ? adjacentBroker : fileURLToPath(new URL("../dist/session-message-broker.mjs", import.meta.url));
    const child = spawn(process.execPath, [brokerPath, "--state-directory", stateDirectory], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: sessionMessageBrokerEnvironment()
    });
    child.unref();
  }
  let lastError;
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
async function sessionMessageRequest(operation, payload, stateDirectory = resolveSessionMessageStateDirectory()) {
  try {
    return await requestSessionMessageOnce(operation, payload, stateDirectory);
  } catch (error) {
    if (error instanceof BrokerRequestRejected) throw error;
    await ensureSessionMessageBroker(stateDirectory);
    return requestSessionMessageOnce(operation, payload, stateDirectory);
  }
}

// mcp-server/src/session-message-cli.ts
var OPERATIONS = /* @__PURE__ */ new Set(["send", "claim", "acknowledge", "status", "pending"]);
async function runSessionMessageCli(raw, stateDirectory) {
  const request = JSON.parse(raw);
  if (typeof request.operation !== "string" || !OPERATIONS.has(request.operation)) throw new Error("Unsupported session message operation.");
  if (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)) throw new Error("payload must be an object.");
  const payload = request.payload;
  const normalizedPayload = request.operation === "send" && payload.messageId === void 0 ? { ...payload, messageId: randomUUID() } : payload;
  const data = await sessionMessageRequest(request.operation, normalizedPayload, stateDirectory);
  return { protocolVersion: "1.0.0", ok: true, data };
}
if (path3.resolve(process.argv[1] ?? "") === fileURLToPath2(import.meta.url)) {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
  }
  void runSessionMessageCli(raw).then(
    (output) => process.stdout.write(`${JSON.stringify(output)}
`),
    (error) => {
      process.stdout.write(`${JSON.stringify({ protocolVersion: "1.0.0", ok: false, error: error instanceof Error ? error.message : "Session message request failed." })}
`);
      process.exitCode = 1;
    }
  );
}
export {
  runSessionMessageCli
};
