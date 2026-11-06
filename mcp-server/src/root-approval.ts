import { WorkflowContractError } from "../../contracts/types.js";
import type { MessageRef } from "./i18n.js";

export type RootApprovalAction = "replace-root" | "release-root";

/** Existing user decision, interpreted by trusted host/composition code, never by tool arguments. */
export interface UserRootApproval {
  reference: string;
  source: "user";
  decision: "approve";
  actions: RootApprovalAction[];
  rootIds: string[];
  actorIds: string[];
  /** Only an expiry actually stated in the existing approval; absence means no added time limit. */
  expiresAt?: string;
  revoked?: boolean;
}

/** Resolves existing decisions; does not issue authority or require another approval ceremony. */
export type ResolveUserRootApproval = (reference: string) => UserRootApproval | null;

/** The resolver is an embedding trust boundary. A ref, JSON claim or provenance receipt alone is not a decision. */
export function assertRootUserApproval(
  references: string[],
  binding: { action: RootApprovalAction; rootId: string; actorId: string | null },
  resolve: ResolveUserRootApproval | undefined,
  requirement: MessageRef,
  now: number,
): void {
  const reject = (reason: string): never => {
    throw new WorkflowContractError("BINDING_INVALID", requirement, {
      reason, field: "userApprovalRefs", rootId: binding.rootId, action: binding.action,
    });
  };
  if (references.length === 0) reject("USER_APPROVAL_REQUIRED");
  if (references.some(reference => typeof reference !== "string" || !reference.trim())
    || new Set(references).size !== references.length) reject("USER_APPROVAL_REFERENCE_INVALID");
  if (!resolve) reject("USER_APPROVAL_UNVERIFIABLE");
  if (!binding.actorId) reject("USER_APPROVAL_ACTOR_UNAVAILABLE");
  if (!Number.isFinite(now)) reject("USER_APPROVAL_CLOCK_UNAVAILABLE");

  // At least one complete existing decision must authorize this operation. Extra unrelated refs confer no authority.
  for (const reference of references) {
    const approval = resolve!(reference);
    if (!approval || approval.reference !== reference || approval.source !== "user" || approval.decision !== "approve"
      || approval.revoked === true || !Array.isArray(approval.actions) || !Array.isArray(approval.rootIds)
      || !Array.isArray(approval.actorIds) || !approval.actions.includes(binding.action)
      || !approval.rootIds.includes(binding.rootId) || !approval.actorIds.includes(binding.actorId!)) continue;
    if (approval.expiresAt !== undefined) {
      const expiresAt = Date.parse(approval.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
    }
    return;
  }
  reject("USER_APPROVAL_NOT_BOUND");
}
