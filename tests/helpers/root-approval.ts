import { expect } from "vitest";

import type { RootApprovalAction } from "../../mcp-server/src/root-approval.js";
import type { RootAccess, WorkflowService } from "../../mcp-server/src/workflow-service.js";

/** Explicit access for direct, unbound service fixtures; this is not host identity or ownership evidence. */
export function fixtureRootApprovalAccess(actorId: string): RootAccess {
  return {
    actorId,
    ownsRoot: () => false,
    ownedByOtherSession: () => false,
    ownerPresence: () => ({ state: "unknown", self: false, ownerBound: false, sessions: [], unavailable: null,
      observedAt: new Date().toISOString() }),
  };
}

let sequence = 0;

/**
 * Trusted unit-composition fixture only: stores the decision for this exact request and actor.
 * It does not observe a host UI or a real user's response. Native production is tested separately.
 * No tool is added and no store row, scope digest or approval ID is manufactured by this helper.
 */
export function storedRootApprovalRefs(service: WorkflowService, action: RootApprovalAction, request: unknown, access: RootAccess): string[] {
  const prepared = service.prepareRootApproval(action, request, access);
  expect(prepared.error, JSON.stringify(prepared.error)).toBeNull();
  expect(prepared.data).not.toBeNull();
  const recorded = service.recordRootApproval(prepared.data!.pending, {
    kind: "mcp-form", connectionId: "trusted-unit-composition", requestId: `unit-decision-${++sequence}`,
  }, access, new AbortController().signal);
  expect(recorded.error, JSON.stringify(recorded.error)).toBeNull();
  expect(recorded.data!.scope).toMatchObject({ action, actorId: access.actorId });
  expect(recorded.data!.approvalId).toMatch(/^approval-/u);
  return [recorded.data!.approvalId];
}
