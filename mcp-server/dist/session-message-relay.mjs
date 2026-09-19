#!/usr/bin/env node

// mcp-server/src/session-message-relay.ts
import { execFile } from "node:child_process";
import net from "node:net";
import path3 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { randomUUID } from "node:crypto";

// mcp-server/src/session-message-client.ts
import { randomBytes } from "node:crypto";
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

// mcp-server/src/session-message-client.ts
var SESSION_MESSAGE_PROTOCOL = "1.0.0";
var WAKE_PREFIX = "[agent-governance-suite:wake:";
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
      if (Buffer.byteLength(buffer, "utf8") > 32 * 1024) return finish(new Error("The broker response exceeded its limit."));
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
function wakeMessage(nonce) {
  return `${WAKE_PREFIX}${nonce}]`;
}
function newWakeNonce() {
  return randomBytes(24).toString("base64url");
}

// mcp-server/src/process-identity.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
function processStartToken(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    if (platform === "win32") {
      return execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString('o')`
      ], { encoding: "utf8", windowsHide: true, timeout: 3e3, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    }
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
      return fields[19] ?? null;
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 3e3, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
function processStillMatches(pid, expectedStartToken) {
  if (!expectedStartToken) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return processStartToken(pid) === expectedStartToken;
}

// mcp-server/src/session-message-relay.ts
function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
async function ringCodex(sessionId, message) {
  await new Promise((resolve, reject) => {
    execFile("codex", ["queue", "--thread", sessionId, "--message", message], { windowsHide: true, timeout: 1e4 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
async function ringClaude(message) {
  const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  if (!socketPath || !token) throw new Error("Claude inbox transport is unavailable.");
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setTimeout(5e3, () => socket.destroy(new Error("Claude inbox timed out.")));
    socket.once("connect", () => {
      socket.end(`${JSON.stringify({ type: "auth", token })}
${JSON.stringify({ type: "user", message: { role: "user", content: message }, priority: "now" })}
`);
    });
    socket.once("close", (hadError) => {
      if (!hadError) resolve();
    });
    socket.once("error", reject);
  });
}
async function delay2(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function runSessionMessageRelay(options) {
  const target = { host: options.host, sessionId: options.sessionId };
  const relayId = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 6 && processStillMatches(options.parentPid, options.parentStartToken); attempt += 1) {
    try {
      const result = await sessionMessageRequest("acquire-relay", {
        target,
        transport: options.transport,
        relayId,
        pid: process.pid,
        parentPid: options.parentPid
      });
      acquired = result.acquired;
      if (acquired) break;
    } catch {
    }
    await delay2(3e3);
  }
  if (!acquired) return;
  let lastPending = 0;
  let lastRingAt = 0;
  let nextIdentityCheck = 0;
  while (true) {
    if (Date.now() >= nextIdentityCheck) {
      if (!processStillMatches(options.parentPid, options.parentStartToken)) return;
      nextIdentityCheck = Date.now() + 6e4;
    }
    try {
      const heartbeat = await sessionMessageRequest("heartbeat-relay", { target, transport: options.transport, relayId });
      if (!heartbeat.alive) return;
      const pending = await sessionMessageRequest("pending", { target });
      if (pending.count > 0 && (lastPending === 0 || Date.now() - lastRingAt >= 3e4)) {
        const nonce = newWakeNonce();
        await sessionMessageRequest("issue-wake", { target, nonce });
        const bell = wakeMessage(nonce);
        if (options.transport === "codex-queue") await ringCodex(options.sessionId, bell);
        else await ringClaude(bell);
        lastRingAt = Date.now();
      }
      lastPending = pending.count;
    } catch {
    }
    await delay2(5e3);
  }
}
if (path3.resolve(process.argv[1] ?? "") === fileURLToPath2(import.meta.url)) {
  const host = argument("--host");
  const sessionId = argument("--session-id");
  const transport = argument("--transport");
  const parentPid = Number.parseInt(argument("--parent-pid") ?? "", 10);
  const parentStartToken = argument("--parent-start-token");
  if (!host || !sessionId || transport !== "codex-queue" && transport !== "claude-inbox" || !Number.isInteger(parentPid) || !parentStartToken) process.exitCode = 2;
  else void runSessionMessageRelay({ host, sessionId, transport, parentPid, parentStartToken }).catch(() => {
    process.exitCode = 1;
  });
}
export {
  runSessionMessageRelay
};
