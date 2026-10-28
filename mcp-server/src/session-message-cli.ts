import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { setTimeout as delay } from "node:timers/promises";
import type { PeerWaitDecision } from "./peer-wait-policy.js";
import { sessionMessageRequest } from "./session-message-client.js";

const OPERATIONS = new Set(["prepare", "send", "claim", "acknowledge", "status", "pending", "wait", "reconcile-wake-observation"]);

/** Vendor-neutral stdin/stdout adapter. Secrets and message bodies never appear in process arguments. */
export async function runSessionMessageCli(raw: string, stateDirectory?: string): Promise<Record<string, unknown>> {
  const request = JSON.parse(raw) as { operation?: unknown; payload?: unknown };
  if (typeof request.operation !== "string" || !OPERATIONS.has(request.operation)) throw new Error("Unsupported session message operation.");
  if (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)) throw new Error("payload must be an object.");
  const payload = request.payload as Record<string, unknown>;
  if (request.operation === "wait") {
    const timeoutMs = payload.timeoutMs === undefined ? 0 : payload.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 3_600_000) throw new Error("timeoutMs is out of range.");
    const decision = await sessionMessageRequest<PeerWaitDecision>("peer-wait", { sender: payload.sender, targets: payload.targets, timeoutMs }, stateDirectory);
    // This adapter owns its delay boundary. Unknown resume permits one short wait,
    // never a background poller or an instruction to stop permanently.
    const waitedMs = decision.action === "bounded" ? Math.min(timeoutMs, 1000) : 0;
    let snapshot = decision;
    if (waitedMs > 0) {
      await delay(waitedMs);
      snapshot = await sessionMessageRequest<PeerWaitDecision>("peer-wait", { sender: payload.sender, targets: payload.targets, timeoutMs: 0 }, stateDirectory);
    }
    return { protocolVersion: "1.0.0", ok: true, data: { decision, snapshot, waitedMs, next: decision.resume === "observed" ? "peer-resume" : "bounded-query-or-next-user-turn" } };
  }
  const data = await sessionMessageRequest<unknown>(request.operation, payload, stateDirectory);
  return { protocolVersion: "1.0.0", ok: true, data };
}

export function formatSessionMessageStdinReadError(error: unknown): {
  protocolVersion: "1.0.0";
  ok: false;
  errorCode: string;
  error: string;
} {
  const rawCode = (error as { code?: unknown } | null)?.code;
  const errorCode = typeof rawCode === "string" && /^[A-Z0-9_]{1,32}$/u.test(rawCode) ? rawCode : "STDIN_READ_ERROR";
  const reason = error instanceof Error && error.message.length > 0 ? error.message : "stdin read failed";
  return {
    protocolVersion: "1.0.0",
    ok: false,
    errorCode,
    error: `Failed to read session message request from stdin (${errorCode}): ${reason}`,
  };
}

export async function executeSessionMessageCliFromStdin(
  readStdin: () => string = () => readFileSync(0, "utf8"),
  stateDirectory?: string,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = readStdin();
  } catch (error: unknown) {
    return formatSessionMessageStdinReadError(error);
  }
  return runSessionMessageCli(raw, stateDirectory);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  void executeSessionMessageCliFromStdin().then(
    (output) => {
      process.stdout.write(`${JSON.stringify(output)}\n`);
      if (output.ok === false) process.exitCode = 1;
    },
    (error: unknown) => {
      process.stdout.write(`${JSON.stringify({ protocolVersion: "1.0.0", ok: false, error: error instanceof Error ? error.message : "Session message request failed." })}\n`);
      process.exitCode = 1;
    },
  );
}
