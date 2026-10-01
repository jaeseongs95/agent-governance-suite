import type { ApiResultV1, ErrorCode, SessionBindingV1, SessionTaskRequestV1,
  SessionTaskTerminalOutcomeV1 } from "../../contracts/types.js";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ContractValidator } from "./schema-validator.js";
import { BrokerRequestRejected, SESSION_MESSAGE_REQUEST_TIMEOUT_MS, sessionMessageRequest } from "./session-message-client.js";
import type { SessionActivityState, SessionPresence, SessionPresenceView } from "./session-message-store.js";
import { isBoundedIdentity, SESSION_MESSAGE_BODY_MAX_BYTES, SESSION_PRESENCE_BATCH_LIMIT,
  SESSION_PRESENCE_TARGET_LIMIT } from "./session-message-protocol.js";

export interface SessionPresenceList {
  sessions: SessionPresenceView[];
  unanswered?: SessionBindingV1[];
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
  private presenceValidator?: ContractValidator;

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

  async prepareTaskRequest(args: Record<string, unknown>): Promise<ApiResultV1<unknown>> {
    const sender = binding(args._sessionBinding);
    if (!sender) return failure("BINDING_REQUIRED", "The session message hook did not bind the sending session.");
    const request = args.request as SessionTaskRequestV1 | undefined;
    if (!request || request.sender?.host !== sender.host || request.sender.sessionId !== sender.sessionId) {
      return failure("INVALID_INPUT", "Task request sender must be the bound session.");
    }
    try {
      return ok(await sessionMessageRequest("prepare-task-request", {
        request, body: args.body, ...(args.ttlSeconds === undefined ? {} : { ttlSeconds: args.ttlSeconds }),
      }, this.stateDirectory));
    } catch (error) {
      return failure("MCP_UNAVAILABLE", error instanceof Error ? error.message : "Task request preparation is unavailable.");
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
    const reconcileToken = args.reconcileToken;
    if (typeof reconcileToken !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(reconcileToken)) {
      return failure("INVALID_INPUT", "A 256-bit reconciliation token is required.");
    }
    try {
      const payload = { request, body: args.body,
        ...(args.ttlSeconds === undefined ? {} : { ttlSeconds: args.ttlSeconds }), reconcileToken };
      const receipt = await sessionMessageRequest<Record<string, unknown>>(
        "receipt-task-request", payload, this.stateDirectory);
      if (receipt.state === "duplicate") return ok(receipt);
      const { activity } = await sessionMessageRequest<{ activity: SessionActivityState }>(
        "session-activity", { target }, this.stateDirectory);
      if (!activity.actor || activity.activity === "unknown" || !activity.turnId) {
        return ok({ state: "held", reason: "activity-unknown", messageId: null });
      }
      const data = await sessionMessageRequest<Record<string, unknown>>("register-contact-task-request", {
        ...payload,
        expectedActor: activity.actor, expectedTurnId: activity.turnId, expectedRevision: activity.revision,
      }, this.stateDirectory);
      return ok(data);
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

  async listPresence(targets: Array<{ host: string; sessionId: string }>): Promise<ApiResultV1<SessionPresenceList>> {
    if (!Array.isArray(targets) || targets.length > SESSION_PRESENCE_TARGET_LIMIT) {
      return failure("INVALID_INPUT", `Presence lookup requires at most ${SESSION_PRESENCE_TARGET_LIMIT} targets.`);
    }
    const sessions: SessionPresenceView[] = [];
    const unanswered: Array<{ host: string; sessionId: string }> = [];
    const asked: Array<{ host: string; sessionId: string }> = [];
    for (const { host, sessionId } of targets) (isBoundedIdentity({ host, sessionId }) ? asked : unanswered).push({ host, sessionId });
    // Monotonic, like the client: a wall-clock step during the lookup must not stretch or cut its deadline.
    const deadline = performance.now() + SESSION_MESSAGE_REQUEST_TIMEOUT_MS;
    for (let index = 0; index < asked.length; index += SESSION_PRESENCE_BATCH_LIMIT) {
      const batch = asked.slice(index, index + SESSION_PRESENCE_BATCH_LIMIT);
      const remaining = deadline - performance.now();
      try {
        // Each batch may use only what is left; past the deadline the client gives up like any unanswered request.
        if (remaining <= 0) throw new Error("The board presence lookup reached its deadline.");
        const data = await sessionMessageRequest<SessionPresenceList>("list-presence", { targets: batch }, this.stateDirectory,
          { totalTimeoutMs: remaining });
        if (!data || !Array.isArray(data.sessions) || data.sessions.length !== batch.length
          || data.sessions.some((session, offset) => !session || session.host !== batch[offset]!.host
            || session.sessionId !== batch[offset]!.sessionId
            || !["online", "unreachable", "ended", "unknown"].includes(session.state)
            || !session.deliveryCapabilities || !Array.isArray(session.deliveryCapabilities.supportedInjection)
            || !["silent", "user-message", "none"].includes(session.deliveryCapabilities.idleWake))) {
          throw new Error("The broker returned invalid presence data.");
        }
        for (const session of data.sessions) if (session.autoWake != null) {
          (this.presenceValidator ??= new ContractValidator()).sessionAutoWakeOutlook(session.autoWake);
        }
        sessions.push(...data.sessions);
      } catch (error) {
        // A refusal answers this batch only. Any other failure means the broker is not answering: asking the rest would
        // wait one client deadline per batch, so stop and leave this and every later batch unanswered.
        if (!(error instanceof BrokerRequestRejected)) { unanswered.push(...asked.slice(index)); break; }
        unanswered.push(...batch);
      }
    }
    return ok({ sessions, unanswered });
  }
}
