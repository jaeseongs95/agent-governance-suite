import { producerFailure } from "./failure-diagnostics.js";
import type { ProcessIdentityBudget } from "./process-identity.js";

/** Same-machine Node/OS monotonic ticks, never process-relative performance.now() origins.
 * This value only limits work; it grants no process identity or actor authority. */
export function encodeIdentityDeadline(deadlineMonotonicMs: number): string {
  const before = process.hrtime.bigint();
  const remaining = Math.floor(deadlineMonotonicMs - performance.now());
  if (!Number.isFinite(remaining) || remaining < 1) throw producerFailure("BROKER_IDENTITY_BUDGET_EXPIRED", "The broker identity budget expired.");
  return String(before + BigInt(remaining) * 1_000_000n);
}

export function decodeIdentityDeadline(value: unknown): ProcessIdentityBudget | undefined {
  if (value === undefined) return undefined; // Legacy producer: do not invent a new budget.
  if (typeof value !== "string" || !/^[1-9][0-9]{0,29}$/u.test(value)) {
    throw producerFailure("BROKER_IDENTITY_BUDGET_INVALID", "The broker identity budget is invalid.");
  }
  const deadline = BigInt(value);
  return () => Number((deadline - process.hrtime.bigint()) / 1_000_000n);
}

export function remainingIdentityBudget(budget?: ProcessIdentityBudget): number | undefined {
  if (!budget) return undefined;
  const remaining = Math.floor(budget());
  if (!Number.isFinite(remaining) || remaining < 1) throw producerFailure("BROKER_IDENTITY_BUDGET_EXPIRED", "The broker identity budget expired.");
  return remaining;
}
