import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolRequest, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

/** AGS identity and evidence, never a host's actor field names or diagnostic labels. */
export interface SessionActorDecision {
  kind: "root" | "child" | "unknown";
  identityId: string | null;
  rootIdentityId: string | null;
  evidence: {
    kind: "observed" | "inferred" | "unavailable";
    reference: string | null;
  };
}

/** Installed by trusted server composition, not selected or supplied by a tool caller.
 * Each invocation must verify this call's actor binding. A transport session ID,
 * request metadata, copied token or historical root observation alone is insufficient.
 */
export interface SessionActorAdapter {
  observeCall(
    request: CallToolRequest,
    context: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ): SessionActorDecision | Promise<SessionActorDecision>;
}

/** The same fail-closed policy applies to every registered host adapter. */
export function isObservedSessionRoot(decision: SessionActorDecision | null | undefined): boolean {
  return decision?.kind === "root"
    && typeof decision.identityId === "string" && decision.identityId.trim().length > 0
    && decision.rootIdentityId === decision.identityId
    && decision.evidence?.kind === "observed"
    && typeof decision.evidence.reference === "string" && decision.evidence.reference.trim().length > 0;
}
