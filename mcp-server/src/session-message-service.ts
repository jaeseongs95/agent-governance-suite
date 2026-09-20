import type { ApiResultV1, ErrorCode, SessionBindingV1 } from "../../contracts/types.js";
import { randomUUID } from "node:crypto";
import { sessionMessageRequest } from "./session-message-client.js";
import type { SessionPresence } from "./session-message-store.js";

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

  async send(args: Record<string, unknown>): Promise<ApiResultV1<unknown>> {
    const sender = binding(args._sessionBinding);
    if (!sender) return failure("BINDING_REQUIRED", "The session message hook did not bind the sending session.");
    try {
      const data = await sessionMessageRequest("send", {
        sender,
        target: { host: args.targetHost, sessionId: args.targetSessionId },
        body: args.body,
        ...(args.ttlSeconds === undefined ? {} : { ttlSeconds: args.ttlSeconds }),
        messageId: args.messageId ?? randomUUID(),
      }, this.stateDirectory);
      return ok(data);
    } catch (error) {
      return failure("MCP_UNAVAILABLE", error instanceof Error ? error.message : "The session message broker is unavailable.");
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
      return ok(data);
    } catch (error) {
      return failure("MCP_UNAVAILABLE", error instanceof Error ? error.message : "Session presence is unavailable.");
    }
  }
}
