import { randomBytes } from "node:crypto";

import {
  type AttemptLeaseV1,
  type AttemptOutcomeV1,
  type AttemptProposalV1,
  type ConvergenceReviewV1,
  type ConvergenceRootV1,
  type WorkflowReceiptV1,
  WorkflowContractError,
} from "../../contracts/types.js";
import { convergenceDigest, rootsOverlap } from "./convergence-logic.js";

export const PLAN_SIGNING_KEY = "plan-signing-key";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface ConvergenceSnapshot {
  root: ConvergenceRootV1;
  proposals: AttemptProposalV1[];
  leases: AttemptLeaseV1[];
  outcomes: AttemptOutcomeV1[];
  reviews: ConvergenceReviewV1[];
  workflowRunIds: string[];
}

export interface GuardedRunBinding {
  root: ConvergenceRootV1;
  proposal: AttemptProposalV1;
  lease: AttemptLeaseV1;
  outcome: AttemptOutcomeV1 | null;
}

export interface WorkflowStore {
  getOrCreateSecret(name: string, create: () => string): string;
  nextRunSequence(): number;
  insertRun(receipt: WorkflowReceiptV1): void;
  getRun(runId: string): WorkflowReceiptV1 | null;
  updateRun(
    receipt: WorkflowReceiptV1,
    expectedRevision: number,
    convergence?: { root: ConvergenceRootV1; expectedRootRevision: number; outcome: AttemptOutcomeV1 },
  ): boolean;
  insertConvergenceRoot(root: ConvergenceRootV1): ConvergenceRootV1 | null;
  getConvergenceSnapshot(rootId: string): ConvergenceSnapshot | null;
  updateConvergenceRoot(
    root: ConvergenceRootV1,
    expectedRevision: number,
    review?: ConvergenceReviewV1,
  ): boolean;
  insertAttemptLease(
    root: ConvergenceRootV1,
    expectedRevision: number,
    proposal: AttemptProposalV1,
    lease: AttemptLeaseV1,
  ): boolean;
  expireAttemptLease(leaseId: string): boolean;
  getAttemptLease(leaseId: string): Omit<GuardedRunBinding, "outcome"> | null;
  insertGuardedRun(
    receipt: WorkflowReceiptV1,
    leaseId: string,
    expectedRootRevision: number,
    consumedAt: string,
  ): GuardedRunBinding | null;
  getGuardedRunBinding(runId: string): GuardedRunBinding | null;
}

export class InMemoryWorkflowStore implements WorkflowStore {
  private readonly runs = new Map<string, WorkflowReceiptV1>();
  private readonly secrets = new Map<string, string>();
  private readonly convergence = new Map<string, ConvergenceSnapshot>();
  private readonly guardedRuns = new Map<string, { rootId: string; leaseId: string }>();
  private runSequence = 0;

  getOrCreateSecret(name: string, create: () => string): string {
    const existing = this.secrets.get(name);
    if (existing) return existing;
    const value = create();
    this.secrets.set(name, value);
    return value;
  }

  nextRunSequence(): number {
    this.runSequence += 1;
    return this.runSequence;
  }

  insertRun(receipt: WorkflowReceiptV1): void {
    if (this.runs.has(receipt.runId)) {
      throw new WorkflowContractError("INVALID_INPUT", "Workflow run already exists.", { runId: receipt.runId });
    }
    this.runs.set(receipt.runId, clone(receipt));
  }

  getRun(runId: string): WorkflowReceiptV1 | null {
    const receipt = this.runs.get(runId);
    return receipt ? clone(receipt) : null;
  }

  updateRun(
    receipt: WorkflowReceiptV1,
    expectedRevision: number,
    convergence?: { root: ConvergenceRootV1; expectedRootRevision: number; outcome: AttemptOutcomeV1 },
  ): boolean {
    const current = this.runs.get(receipt.runId);
    if (!current || current.revision !== expectedRevision) return false;
    if (convergence) {
      const snapshot = this.convergence.get(convergence.root.rootId);
      if (!snapshot || snapshot.root.revision !== convergence.expectedRootRevision) return false;
      if (snapshot.outcomes.some((item) => item.workflowRunId === receipt.runId)) return false;
      snapshot.root = clone(convergence.root);
      snapshot.outcomes.push(clone(convergence.outcome));
    }
    this.runs.set(receipt.runId, clone(receipt));
    return true;
  }

  insertConvergenceRoot(root: ConvergenceRootV1): ConvergenceRootV1 | null {
    if (this.convergence.has(root.rootId)) {
      throw new WorkflowContractError("INVALID_INPUT", "Convergence root already exists.", { rootId: root.rootId });
    }
    for (const snapshot of this.convergence.values()) {
      if (["completed", "abandoned"].includes(snapshot.root.state)) continue;
      if (root.parentRootId === snapshot.root.rootId) continue;
      if (rootsOverlap(root, snapshot.root)) return clone(snapshot.root);
    }
    if (root.parentRootId) {
      const parent = this.convergence.get(root.parentRootId);
      if (!parent) throw new WorkflowContractError("INVALID_INPUT", "Parent convergence root was not found.", { rootId: root.parentRootId });
      parent.root.state = "abandoned";
      parent.root.revision += 1;
      parent.root.updatedAt = root.createdAt;
    }
    this.convergence.set(root.rootId, {
      root: clone(root),
      proposals: [],
      leases: [],
      outcomes: [],
      reviews: [],
      workflowRunIds: [],
    });
    return null;
  }

  getConvergenceSnapshot(rootId: string): ConvergenceSnapshot | null {
    const snapshot = this.convergence.get(rootId);
    return snapshot ? clone(snapshot) : null;
  }

  updateConvergenceRoot(root: ConvergenceRootV1, expectedRevision: number, review?: ConvergenceReviewV1): boolean {
    const snapshot = this.convergence.get(root.rootId);
    if (!snapshot || snapshot.root.revision !== expectedRevision) return false;
    snapshot.root = clone(root);
    if (review) snapshot.reviews.push(clone(review));
    return true;
  }

  insertAttemptLease(
    root: ConvergenceRootV1,
    expectedRevision: number,
    proposal: AttemptProposalV1,
    lease: AttemptLeaseV1,
  ): boolean {
    const snapshot = this.convergence.get(root.rootId);
    if (!snapshot || snapshot.root.revision !== expectedRevision) return false;
    if (snapshot.leases.some((item) => item.state === "issued")) return false;
    if (snapshot.leases.some((item) => item.leaseId === lease.leaseId)) return false;
    snapshot.root = clone(root);
    snapshot.proposals.push(clone(proposal));
    snapshot.leases.push(clone(lease));
    return true;
  }

  expireAttemptLease(leaseId: string): boolean {
    for (const snapshot of this.convergence.values()) {
      const lease = snapshot.leases.find((item) => item.leaseId === leaseId);
      if (!lease || lease.state !== "issued") continue;
      lease.state = "expired";
      return true;
    }
    return false;
  }

  getAttemptLease(leaseId: string): Omit<GuardedRunBinding, "outcome"> | null {
    for (const snapshot of this.convergence.values()) {
      const lease = snapshot.leases.find((item) => item.leaseId === leaseId);
      const proposal = snapshot.proposals.find((item) => convergenceDigest(item) === lease?.proposalDigest);
      if (lease && proposal) return { root: clone(snapshot.root), proposal: clone(proposal), lease: clone(lease) };
    }
    return null;
  }

  insertGuardedRun(
    receipt: WorkflowReceiptV1,
    leaseId: string,
    expectedRootRevision: number,
    consumedAt: string,
  ): GuardedRunBinding | null {
    if (this.runs.has(receipt.runId)) return null;
    for (const snapshot of this.convergence.values()) {
      const lease = snapshot.leases.find((item) => item.leaseId === leaseId);
      if (!lease || lease.state !== "issued" || snapshot.root.revision !== expectedRootRevision) continue;
      if (Date.parse(lease.expiresAt) <= Date.parse(consumedAt)) return null;
      const proposal = snapshot.proposals.find((item) => convergenceDigest(item) === lease.proposalDigest);
      if (!proposal) return null;
      lease.state = "consumed";
      snapshot.root.revision += 1;
      snapshot.root.updatedAt = consumedAt;
      snapshot.workflowRunIds.push(receipt.runId);
      this.runs.set(receipt.runId, clone(receipt));
      this.guardedRuns.set(receipt.runId, { rootId: snapshot.root.rootId, leaseId });
      return { root: clone(snapshot.root), proposal: clone(proposal), lease: clone(lease), outcome: null };
    }
    return null;
  }

  getGuardedRunBinding(runId: string): GuardedRunBinding | null {
    const binding = this.guardedRuns.get(runId);
    if (!binding) return null;
    const snapshot = this.convergence.get(binding.rootId);
    if (!snapshot) return null;
    const lease = snapshot.leases.find((item) => item.leaseId === binding.leaseId);
    const proposal = snapshot.proposals.find((item) => convergenceDigest(item) === lease?.proposalDigest);
    if (!lease || !proposal) return null;
    return {
      root: clone(snapshot.root),
      proposal: clone(proposal),
      lease: clone(lease),
      outcome: clone(snapshot.outcomes.find((item) => item.workflowRunId === runId) ?? null),
    };
  }
}

export function createPlanSigningKey(): string {
  return randomBytes(32).toString("base64url");
}
