import { randomBytes } from "node:crypto";

import { type WorkflowReceiptV1, WorkflowContractError } from "../../contracts/types.js";

export const PLAN_SIGNING_KEY = "plan-signing-key";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface WorkflowStore {
  getOrCreateSecret(name: string, create: () => string): string;
  nextRunSequence(): number;
  insertRun(receipt: WorkflowReceiptV1): void;
  getRun(runId: string): WorkflowReceiptV1 | null;
  updateRun(receipt: WorkflowReceiptV1, expectedRevision: number): boolean;
}

export class InMemoryWorkflowStore implements WorkflowStore {
  private readonly runs = new Map<string, WorkflowReceiptV1>();
  private readonly secrets = new Map<string, string>();
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

  updateRun(receipt: WorkflowReceiptV1, expectedRevision: number): boolean {
    const current = this.runs.get(receipt.runId);
    if (!current || current.revision !== expectedRevision) return false;
    this.runs.set(receipt.runId, clone(receipt));
    return true;
  }
}

export function createPlanSigningKey(): string {
  return randomBytes(32).toString("base64url");
}
