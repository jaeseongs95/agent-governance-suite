import { contractErrorBody, WorkflowContractError, type ApiResultV1, type ErrorCode, type SessionBindingV1 } from "../../contracts/types.js";
import type { VerifiedCaller } from "./caller-identity.js";
import { failureContext, failureReason } from "./failure-diagnostics.js";
import { msg, type MessageRef } from "./i18n.js";
import { BrokerRequestRejected, sessionMessageRequest } from "./session-message-client.js";
import type { CurrentPresence } from "./session-message-store.js";
import { SESSION_MESSAGE_BODY_MAX_BYTES } from "./session-message-protocol.js";

function ok<T>(data: T): ApiResultV1<T> {
  return { schemaVersion: "1.0.0", ok: true, data, error: null };
}

function failure(code: ErrorCode, message: MessageRef, details: Record<string, unknown> | null = null): ApiResultV1<never> {
  return { schemaVersion: "1.0.0", ok: false, data: null, error: contractErrorBody(code, message, details) };
}

/**
 * Error model R2/R5: a messaging rejection (BrokerRequestRejected) keeps its own domain message; a contract error keeps
 * its code; any other failure (busy writer, storage, deadline, state directory) is reported by its reason and redacted
 * cause under a fixed message, never its raw text. An uncertain send adds the retry guidance to the same sentence; the
 * rejection's own text stays in the root locale there, since a catalog message cannot hold another one.
 */
function unavailable(error: unknown, uncertainSend = false): ApiResultV1<never> {
  if (error instanceof WorkflowContractError || error instanceof BrokerRequestRejected) {
    const code = error instanceof WorkflowContractError ? error.code : "MCP_UNAVAILABLE";
    const details = error instanceof WorkflowContractError ? error.details : null;
    if (uncertainSend) return failure(code, msg("services.sessionMessage.send.retryAfterRejection", { reason: error.message }), details);
    if (error instanceof BrokerRequestRejected) return failure(code, error.ref);
    return { schemaVersion: "1.0.0", ok: false, data: null, error: error.toBody() };
  }
  return failure("MCP_UNAVAILABLE", uncertainSend ? msg("services.sessionMessage.send.retryAfterFailure", {}) : msg("services.sessionMessage.unavailable", {}),
    { reason: failureReason(error).reason ?? "INTERNAL_FAILURE", cause: failureContext(error) });
}

/** A broker capacity rejection is definite: its transaction rolled back, so nothing was queued or drafted. */
function capacityDetails(error: unknown): { scope: "sender" | "global"; earliestReleaseAt: string | null } | null {
  return error instanceof BrokerRequestRejected ? error.details : null;
}

/** The capacity sentence's params: which pool is full and when its earliest retained record expires, if known. */
function capacityParams(details: { scope: "sender" | "global"; earliestReleaseAt: string | null }) {
  return { scope: details.scope, release: details.earliestReleaseAt === null ? "pending" : "scheduled", earliestReleaseAt: details.earliestReleaseAt ?? "" };
}

/** Messages are addressed to the root session; a child caller acts for its root session. */
function address(caller: VerifiedCaller): SessionBindingV1 {
  return { host: caller.host, sessionId: caller.sessionId };
}

export class SessionMessageService {
  private readonly stateDirectory: string | undefined;

  constructor(stateDirectory?: string) {
    this.stateDirectory = stateDirectory;
  }

  async prepare(args: Record<string, unknown>, caller: VerifiedCaller): Promise<ApiResultV1<unknown>> {
    const sender = address(caller);
    if (Object.keys(args).some((key) => !["schemaVersion", "targetHost", "targetSessionId", "body", "ttlSeconds"].includes(key))) return failure("INVALID_INPUT", msg("services.sessionMessage.prepare.contentOnly", {}));
    if (typeof args.body !== "string" || !args.body.trim() || args.body.includes("\0") || Buffer.byteLength(args.body, "utf8") > SESSION_MESSAGE_BODY_MAX_BYTES) {
      return failure("INVALID_INPUT", msg("services.sessionMessage.prepare.bodyInvalid", { maxBytes: SESSION_MESSAGE_BODY_MAX_BYTES }));
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
      if (details) return failure("MCP_UNAVAILABLE", msg("services.sessionMessage.prepare.capacityRejected", capacityParams(details)), { ...details });
      return unavailable(error);
    }
  }

  async send(args: Record<string, unknown>, caller: VerifiedCaller): Promise<ApiResultV1<unknown>> {
    const sender = address(caller);
    if (typeof args.messageId !== "string" || Object.keys(args).some((key) => !["schemaVersion", "messageId"].includes(key))) return failure("INVALID_INPUT", msg("services.sessionMessage.send.messageIdOnly", {}));
    try {
      return ok(await sessionMessageRequest("send", { sender, messageId: args.messageId }, this.stateDirectory));
    } catch (error) {
      const details = capacityDetails(error);
      if (details) return failure("MCP_UNAVAILABLE", msg("services.sessionMessage.send.capacityRejected", capacityParams(details)), { ...details });
      return unavailable(error, true);
    }
  }

  async acknowledge(args: Record<string, unknown>, caller: VerifiedCaller): Promise<ApiResultV1<unknown>> {
    const target = address(caller);
    try {
      const data = await sessionMessageRequest("acknowledge", { target, messageIds: args.messageIds,
        ...(args.receipts === undefined ? {} : { receipts: args.receipts }) }, this.stateDirectory);
      return ok(data);
    } catch (error) {
      return unavailable(error);
    }
  }

  async status(args: Record<string, unknown>, caller: VerifiedCaller): Promise<ApiResultV1<unknown>> {
    const sender = address(caller);
    try {
      const data = await sessionMessageRequest("status", { sender, messageId: args.messageId }, this.stateDirectory);
      return ok(data);
    } catch (error) {
      return unavailable(error);
    }
  }

  /** The session board's liveness view: one broker request whose reply the store keeps inside the response limit. */
  async listCurrentPresence(self: SessionBindingV1): Promise<{ sessions: CurrentPresence[]; truncated: number }> {
    return sessionMessageRequest("list-current-presence", { self }, this.stateDirectory);
  }
}
