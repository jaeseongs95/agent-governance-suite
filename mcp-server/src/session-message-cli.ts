import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sessionMessageRequest } from "./session-message-client.js";

const OPERATIONS = new Set(["send", "claim", "acknowledge", "status", "pending"]);

/** Vendor-neutral stdin/stdout adapter. Secrets and message bodies never appear in process arguments. */
export async function runSessionMessageCli(raw: string, stateDirectory?: string): Promise<Record<string, unknown>> {
  const request = JSON.parse(raw) as { operation?: unknown; payload?: unknown };
  if (typeof request.operation !== "string" || !OPERATIONS.has(request.operation)) throw new Error("Unsupported session message operation.");
  if (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)) throw new Error("payload must be an object.");
  const payload = request.payload as Record<string, unknown>;
  const normalizedPayload = request.operation === "send" && payload.messageId === undefined
    ? { ...payload, messageId: randomUUID() }
    : payload;
  const data = await sessionMessageRequest<unknown>(request.operation, normalizedPayload, stateDirectory);
  return { protocolVersion: "1.0.0", ok: true, data };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch { /* Reported as invalid input below. */ }
  void runSessionMessageCli(raw).then(
    (output) => process.stdout.write(`${JSON.stringify(output)}\n`),
    (error: unknown) => {
      process.stdout.write(`${JSON.stringify({ protocolVersion: "1.0.0", ok: false, error: error instanceof Error ? error.message : "Session message request failed." })}\n`);
      process.exitCode = 1;
    },
  );
}
