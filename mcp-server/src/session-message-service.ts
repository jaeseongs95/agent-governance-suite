import type { ApiResultV1, ErrorCode, SessionBindingV1 } from "../../contracts/types.js";
import { sessionMessageRequest } from "./session-message-client.js";
import type { SessionPresence } from "./session-message-store.js";
import { SESSION_MESSAGE_BODY_MAX_BYTES } from "./session-message-protocol.js";

export interface SessionPresenceList {
  sessions: SessionPresence[];
}

function ok<T>(data: T): ApiResultV1<T> {
  return { schemaVersion: "1.0.0", ok: true, data, error: null };
}

function failure(code: ErrorCode, message: string): ApiResultV1<never> {
  return { schemaVersion: "1.0.0", ok: false, data: null, error: { code, message, details: null } };
}

function binding(value: unknown): SessionBindingV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.host === "string" && record.host && typeof record.sessionId === "string" && record.sessionId
    ? { host: record.host, sessionId: record.sessionId }
    : null;
}

export class SessionMessageService {
  private readonly stateDirectory: string | undefined;

  constructor(stateDirectory?: string) {
    this.stateDirectory = stateDirectory;
  }

  async prepare(args: Record<string, unknown>): Promise<ApiResultV1<unknown>> {
    const sender = binding(args._sessionBinding);
    if (!sender) return failure("BINDING_REQUIRED", "The session message hook did not bind the sending session.");
    if (Object.keys(args).some((key) => !["schemaVersion", "targetHost", "targetSessionId", "body", "ttlSeconds", "_sessionBinding"].includes(key))) return failure("INVALID_INPUT", "Preparation accepts immutable content only; message IDs are system-issued.");
    if (typeof args.body !== "string" || !args.body.trim() || args.body.includes("\0") || Buffer.byteLength(args.body, "utf8") > SESSION_MESSAGE_BODY_MAX_BYTES) {
      return failure("INVALID_INPUT", `body must contain 1-${SESSION_MESSAGE_BODY_MAX_BYTES} UTF-8 bytes and no NUL characters.`);
    }
    try {
      const data = await sessionMessageRequest("prepare", {
        sender,
        target: { host: args.targetHost, sessionId: args.targetSessionId },
        body: args.body,
        ...(args.ttlSeconds === undefined ? {} : { ttlSeconds: args.ttlSeconds }),
      }, this.stateDirectory);
      return ok(data);
    } catch (error) {
      return failure("MCP_UNAVAILABLE", error instanceof Error ? error.message : "The session message broker is unavailable.");
    }
  }

  async send(args: Record<string, unknown>): Promise<ApiResultV1<unknown>> {
    const sender = binding(args._sessionBinding);
    if (!sender) return failure("BINDING_REQUIRED", "The session message hook did not bind the sending session.");
    if (typeof args.messageId !== "string" || Object.keys(args).some((key) => !["schemaVersion", "messageId", "_sessionBinding"].includes(key))) return failure("INVALID_INPUT", "Call prepare_session_message for a new intent, then send_session_message with only the returned messageId. Retry an uncertain send using that same ID or compare saved receipts/status.");
    try {
      return ok(await sessionMessageRequest("send", { sender, messageId: args.messageId }, this.stateDirectory));
    } catch (error) {
      return failure("MCP_UNAVAILABLE", `${error instanceof Error ? error.message : "The session message broker is unavailable."} Retry only the known prepared ID or compare saved receipts/status; do not prepare again for the same uncertain delivery.`);
    }
  }

  async acknowledge(args: Record<string, unknown>): Promise<ApiResultV1<unknown>> {
    const target = binding(args._sessionBinding);
    if (!target) return failure("BINDING_REQUIRED", "The session message hook did not bind the receiving session.");
    try {
      const data = await sessionMessageRequest("acknowledge", { target, messageIds: args.messageIds }, this.stateDirectory);
      return ok(data);
    } catch (error) {
      return failure("MCP_UNAVAILABLE", error instanceof Error ? error.message : "The session message broker is unavailable.");
    }
  }

  async status(args: Record<string, unknown>): Promise<ApiResultV1<unknown>> {
    const sender = binding(args._sessionBinding);
    if (!sender) return failure("BINDING_REQUIRED", "The session message hook did not bind the sending session.");
    try {
      const data = await sessionMessageRequest("status", { sender, messageId: args.messageId }, this.stateDirectory);
      return ok(data);
    } catch (error) {
      return failure("MCP_UNAVAILABLE", error instanceof Error ? error.message : "The session message broker is unavailable.");
    }
  }

  async listPresence(): Promise<ApiResultV1<SessionPresenceList>> {
    try {
      const data = await sessionMessageRequest<SessionPresenceList>("list-presence", {}, this.stateDirectory);
      return ok({ sessions: data.sessions.map((session) => ({
        ...session,
        deliveryCapabilities: session.deliveryCapabilities ?? { supportedInjection: [], idleWake: "none" },
      })) });
    } catch (error) {
      return failure("MCP_UNAVAILABLE", error instanceof Error ? error.message : "Session presence is unavailable.");
    }
  }
}
