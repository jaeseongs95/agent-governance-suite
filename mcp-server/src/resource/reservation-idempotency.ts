import { createHash } from "node:crypto";

import { WorkflowContractError } from "../../../contracts/types.js";
import { canonicalJson } from "../convergence-logic.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

export type ReservationIdentityV1 = {
  taskId: string;
  runId: string;
  slotId: string;
  attemptId: string;
  planRevision: number;
  requestDigest: string;
};

/** Stable domain-separated key for one admission attempt and its exact request body. */
export function reservationIdempotencyKeyV1(identity: ReservationIdentityV1): string {
  if (!identity || typeof identity !== "object"
    || [identity.taskId, identity.runId, identity.slotId, identity.attemptId]
      .some(value => typeof value !== "string" || !idPattern.test(value))
    || !Number.isSafeInteger(identity.planRevision) || identity.planRevision < 0
    || typeof identity.requestDigest !== "string" || !digestPattern.test(identity.requestDigest)) {
    throw new WorkflowContractError("INVALID_INPUT", "Invalid reservation idempotency identity.");
  }
  const payload = canonicalJson({ domain: "resource-reservation-idempotency-v1",
    taskId: identity.taskId, runId: identity.runId, slotId: identity.slotId,
    attemptId: identity.attemptId, planRevision: identity.planRevision,
    requestDigest: identity.requestDigest });
  return `reservation-v1:sha256:${createHash("sha256").update(payload).digest("hex")}`;
}
