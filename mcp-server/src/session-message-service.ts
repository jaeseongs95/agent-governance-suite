import type { ApiResultV1, ErrorCode, SessionBindingV1 } from "../../contracts/types.js";
import { BrokerRequestRejected, sessionMessageRequest } from "./session-message-client.js";
import type { SessionPresenceView } from "./session-message-store.js";
import { SESSION_MESSAGE_BODY_MAX_BYTES, SESSION_PRESENCE_LIST_MAX_TARGETS } from "./session-message-protocol.js";

export interface SessionPresenceList {
  sessions: SessionPresenceView[];
}

function ok<T>(data: T): ApiResultV1<T> {
  return { schemaVersion: "1.0.0", ok: true, data, error: null };
}

function failure(code: ErrorCode, message: string, details: Record<string, unknown> | null = null): ApiResultV1<never> {
  return { schemaVersion: "1.0.0", ok: false, data: null, error: { code, message, details } };
}

/** A broker capacity rejection is definite: its transaction rolled back, so nothing was queued or drafted. */
function capacityDetails(error: unknown): { scope: "sender" | "global"; earliestReleaseAt: string | null } | null {
  return error instanceof BrokerRequestRejected ? error.details : null;
}

function capacityRelease(details: { earliestReleaseAt: string | null }): string {
  return details.earliestReleaseAt === null
    ? "A new prepare_session_message may succeed after retained records expire."
    : `The earliest retained record in this scope expires at ${details.earliestReleaseAt}; after that a new prepare_session_message may succeed.`;
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
      const details = capacityDetails(error);
      if (details) return failure("MCP_UNAVAILABLE", `${(error as Error).message} ${capacityRelease(details)}`, { ...details });
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
      const details = capacityDetails(error);
      if (details) return failure("MCP_UNAVAILABLE", `${(error as Error).message} This definite rejection had no effect: the message was not queued and no receipt was issued. The rejected messageId stays prepared until the expiresAt returned by prepare_session_message. If earliestReleaseAt is before that expiresAt, retry that same messageId after earliestReleaseAt; otherwise the draft expires first, so prepare again. Never do both. ${capacityRelease(details)}`, { ...details });
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

  /** Asks only for the given identities, in batches that fit the broker response limit whatever the DB size. */
  async listPresence(targets: Array<{ host: string; sessionId: string }>): Promise<ApiResultV1<SessionPresenceList>> {
    try {
      const sessions: SessionPresenceView[] = [];
      for (let index = 0; index < targets.length; index += SESSION_PRESENCE_LIST_MAX_TARGETS) {
        const batch = targets.slice(index, index + SESSION_PRESENCE_LIST_MAX_TARGETS).map(({ host, sessionId }) => ({ host, sessionId }));
        const data = await sessionMessageRequest<SessionPresenceList>("list-presence", { targets: batch }, this.stateDirectory);
        sessions.push(...data.sessions.map((session) => ({
          ...session,
          deliveryCapabilities: session.deliveryCapabilities ?? { supportedInjection: [], idleWake: "none" },
          autoWake: session.autoWake ?? null,
        })));
      }
      return ok({ sessions });
    } catch (error) {
      return failure("MCP_UNAVAILABLE", error instanceof Error ? error.message : "Session presence is unavailable.");
    }
  }
}
