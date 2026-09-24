import type { ApiResultV1, ErrorCode, SessionBindingV1, SessionTaskRequestV1,
  SessionTaskTerminalOutcomeV1 } from "../../contracts/types.js";
import { randomBytes, randomUUID } from "node:crypto";
import { sessionMessageRequest } from "./session-message-client.js";
import type { SessionActivityState, SessionPresence } from "./session-message-store.js";
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

  async send(args: Record<string, unknown>): Promise<ApiResultV1<unknown>> {
    const sender = binding(args._sessionBinding);
    if (!sender) return failure("BINDING_REQUIRED", "The session message hook did not bind the sending session.");
    if (typeof args.body !== "string" || !args.body.trim() || args.body.includes("\0") || Buffer.byteLength(args.body, "utf8") > SESSION_MESSAGE_BODY_MAX_BYTES) {
      return failure("INVALID_INPUT", `body must contain 1-${SESSION_MESSAGE_BODY_MAX_BYTES} UTF-8 bytes and no NUL characters.`);
    }
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

  async contactState(args: Record<string, unknown>): Promise<ApiResultV1<unknown>> {
    if (!binding(args._sessionBinding)) return failure("BINDING_REQUIRED", "The session message hook did not bind the sending session.");
    const target = binding({ host: args.targetHost, sessionId: args.targetSessionId });
    if (!target) return failure("INVALID_INPUT", "A target host and session are required.");
    try {
      const [presence, activity] = await Promise.all([
        sessionMessageRequest<{ presence: SessionPresence }>("presence", { target }, this.stateDirectory),
        sessionMessageRequest<{ activity: SessionActivityState }>("session-activity", { target }, this.stateDirectory),
      ]);
      return ok({ presence: presence.presence, activity: activity.activity });
    } catch (error) {
      return failure("MCP_UNAVAILABLE", error instanceof Error ? error.message : "Session contact state is unavailable.");
    }
  }

  async contact(args: Record<string, unknown>): Promise<ApiResultV1<unknown>> {
    const sender = binding(args._sessionBinding);
    const target = binding({ host: args.targetHost, sessionId: args.targetSessionId });
    if (!sender) return failure("BINDING_REQUIRED", "The session message hook did not bind the sending session.");
    if (!target || typeof args.body !== "string" || !args.body.trim() || args.body.includes("\0")
      || Buffer.byteLength(args.body, "utf8") > SESSION_MESSAGE_BODY_MAX_BYTES) {
      return failure("INVALID_INPUT", "Target and bounded nonempty body are required.");
    }
    try {
      const { activity } = await sessionMessageRequest<{ activity: SessionActivityState }>(
        "session-activity", { target }, this.stateDirectory);
      if (!activity.actor || activity.activity === "unknown" || !activity.turnId) {
        return ok({ state: "held", reason: "activity-unknown", messageId: null });
      }
      const data = await sessionMessageRequest("contact-session", {
        sender, target, body: args.body, messageId: args.messageId ?? randomUUID(),
        ...(args.ttlSeconds === undefined ? {} : { ttlSeconds: args.ttlSeconds }),
        expectedActor: activity.actor, expectedTurnId: activity.turnId, expectedRevision: activity.revision,
      }, this.stateDirectory);
      return ok(data);
    } catch (error) {
      return failure("MCP_UNAVAILABLE", error instanceof Error ? error.message : "Session contact is unavailable.");
    }
  }

  async registerTaskRequest(args: Record<string, unknown>): Promise<ApiResultV1<unknown>> {
    const sender = binding(args._sessionBinding);
    if (!sender) return failure("BINDING_REQUIRED", "The session message hook did not bind the sending session.");
    const request = args.request as SessionTaskRequestV1 | undefined;
    if (!request || request.sender?.host !== sender.host || request.sender.sessionId !== sender.sessionId) {
      return failure("INVALID_INPUT", "Task request sender must be the bound session.");
    }
    const target = binding(request.recipient);
    if (!target) return failure("INVALID_INPUT", "Task recipient is required.");
    const reconcileToken = args.reconcileToken ?? randomBytes(32).toString("base64url");
    if (typeof reconcileToken !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(reconcileToken)) {
      return failure("INVALID_INPUT", "A 256-bit reconciliation token is required.");
    }
    try {
      const { activity } = await sessionMessageRequest<{ activity: SessionActivityState }>(
        "session-activity", { target }, this.stateDirectory);
      if (!activity.actor || activity.activity === "unknown" || !activity.turnId) {
        return ok({ state: "held", reason: "activity-unknown", messageId: null });
      }
      const data = await sessionMessageRequest<Record<string, unknown>>("register-contact-task-request", {
        request, body: args.body, ...(args.ttlSeconds === undefined ? {} : { ttlSeconds: args.ttlSeconds }),
        expectedActor: activity.actor, expectedTurnId: activity.turnId, expectedRevision: activity.revision,
        reconcileToken,
      }, this.stateDirectory);
      return ok({ ...data, ...(data.state === "queued" ? { reconcileToken } : {}) });
    } catch (error) {
      return failure("MCP_UNAVAILABLE", error instanceof Error ? error.message : "Task request registration is unavailable.");
    }
  }

  async recordTaskOutcome(args: Record<string, unknown>): Promise<ApiResultV1<unknown>> {
    const actor = binding(args._sessionBinding);
    if (!actor) return failure("BINDING_REQUIRED", "The session message hook did not bind the reporting session.");
    const outcome = args.outcome as SessionTaskTerminalOutcomeV1 | undefined;
    if (!outcome || outcome.actor?.host !== actor.host || outcome.actor.sessionId !== actor.sessionId) {
      return failure("INVALID_INPUT", "Task outcome actor must be the bound session.");
    }
    try {
      return ok(await sessionMessageRequest("record-task-outcome", {
        outcome, reporterProof: args.reporterProof,
      }, this.stateDirectory));
    } catch (error) {
      return failure("MCP_UNAVAILABLE", error instanceof Error ? error.message : "Trusted task outcome recording is unavailable.");
    }
  }

  async reconcileTaskRequest(args: Record<string, unknown>): Promise<ApiResultV1<unknown>> {
    const sender = binding(args._sessionBinding);
    if (!sender) return failure("BINDING_REQUIRED", "The session message hook did not bind the sending session.");
    if (typeof args.requestId !== "string" || typeof args.reconcileToken !== "string") {
      return failure("INVALID_INPUT", "requestId and reconciliation token are required.");
    }
    try {
      return ok(await sessionMessageRequest("reconcile-task-request", {
        sender, requestId: args.requestId, reconcileToken: args.reconcileToken,
      }, this.stateDirectory));
    } catch (error) {
      return failure("MCP_UNAVAILABLE", error instanceof Error ? error.message : "Task request reconciliation is unavailable.");
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
