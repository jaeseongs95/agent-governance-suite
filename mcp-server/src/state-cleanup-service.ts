import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import type {
  ApiResultV1,
  Sha256Digest,
  StateCleanupPlanV1,
  StateCleanupPolicyV1,
  StateCleanupReceiptV1,
} from "../../contracts/types.js";
import { WorkflowContractError } from "../../contracts/types.js";
import type { SqliteContinuityStore, ContinuityCleanupPreview } from "./continuity-store.js";
import type { ContractValidator } from "./schema-validator.js";
import type { SqliteWorkflowStore, WorkflowCleanupPreview } from "./sqlite-workflow-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const POLICY: StateCleanupPolicyV1 = {
  workflowRetentionDays: 180,
  continuityPayloadRetentionDays: 30,
  continuityRecordRetentionDays: 180,
};

interface CleanupTokenPayload {
  schemaVersion: "1.0.0";
  planId: string;
  createdAt: string;
  expiresAt: string;
  policy: StateCleanupPolicyV1;
  cutoffs: StateCleanupPlanV1["cutoffs"];
  candidates: StateCleanupPlanV1["candidates"];
  candidateDigest: Sha256Digest;
  databases: {
    workflow: { path: string; schemaVersion: number };
    continuity: { path: string; schemaVersion: number } | null;
  };
}

function digest(value: unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function protection(): StateCleanupPlanV1["protection"] {
  return process.platform === "win32" ? "os-managed-unverified" : "filesystem-mode-0600";
}

function databaseIdentity(databasePath: string): string {
  return databasePath === ":memory:" ? databasePath : path.resolve(databasePath);
}

function apiError(error: unknown): ApiResultV1<never> {
  const normalized = error instanceof WorkflowContractError
    ? error
    : new WorkflowContractError("INVALID_INPUT", error instanceof Error ? error.message : String(error));
  return { schemaVersion: "1.0.0", ok: false, data: null, error: normalized.toBody() };
}

export class StateCleanupService {
  private readonly secret: Buffer;

  constructor(
    private readonly workflowStore: SqliteWorkflowStore,
    private readonly continuityStore: SqliteContinuityStore | null,
    private readonly validator: ContractValidator,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.secret = Buffer.from(workflowStore.getOrCreateSecret(
      "state-cleanup-signing-key",
      () => randomBytes(32).toString("base64url"),
    ), "base64url");
  }

  prepare(value: unknown): ApiResultV1<StateCleanupPlanV1> {
    try {
      this.validator.prepareStateCleanupRequest(value);
      const created = this.clock();
      const createdAt = created.toISOString();
      const cutoffs = {
        workflow: new Date(created.getTime() - POLICY.workflowRetentionDays * DAY_MS).toISOString(),
        continuityPayload: new Date(created.getTime() - POLICY.continuityPayloadRetentionDays * DAY_MS).toISOString(),
        continuityRecord: new Date(created.getTime() - POLICY.continuityRecordRetentionDays * DAY_MS).toISOString(),
      };
      const { workflow, continuity, protectedContinuityTasks } = this.currentCandidates(cutoffs);
      const candidates: StateCleanupPlanV1["candidates"] = {
        workflowRoots: workflow.roots,
        standaloneWorkflowRuns: workflow.standaloneRuns,
        continuitySnapshots: continuity?.snapshots ?? [],
        continuityTasks: continuity?.tasks ?? [],
      };
      const candidateDigest = digest(candidates);
      const payload: CleanupTokenPayload = {
        schemaVersion: "1.0.0",
        planId: randomUUID(),
        createdAt,
        expiresAt: new Date(created.getTime() + TOKEN_TTL_MS).toISOString(),
        policy: POLICY,
        cutoffs,
        candidates,
        candidateDigest,
        databases: {
          workflow: { path: databaseIdentity(this.workflowStore.databasePath), schemaVersion: this.workflowStore.getSchemaVersion() },
          continuity: this.continuityStore
            ? { path: databaseIdentity(this.continuityStore.databasePath), schemaVersion: this.continuityStore.getSchemaVersion() }
            : null,
        },
      };
      const plan: StateCleanupPlanV1 = {
        schemaVersion: "1.0.0",
        planId: payload.planId,
        createdAt,
        expiresAt: payload.expiresAt,
        policy: POLICY,
        cutoffs,
        candidates,
        counts: {
          workflowRoots: workflow.roots.length,
          workflowRuns: workflow.standaloneRuns.length + workflow.roots.reduce((count, root) => count + root.runIds.length, 0),
          continuitySnapshots: continuity?.snapshots.length ?? 0,
          continuityTasks: continuity?.tasks.length ?? 0,
          protectedActiveRoots: workflow.protectedActiveRoots,
          protectedActiveContinuityTasks: protectedContinuityTasks,
        },
        candidateDigest,
        protection: protection(),
        planToken: this.sign(payload),
      };
      this.validator.stateCleanupPlan(plan);
      return { schemaVersion: "1.0.0", ok: true, data: plan, error: null };
    } catch (error) {
      return apiError(error);
    }
  }

  execute(value: unknown): ApiResultV1<StateCleanupReceiptV1> {
    try {
      const request = this.validator.executeStateCleanupRequest(value);
      const payload = this.verify(request.planToken);
      const now = this.clock();
      if (Date.parse(payload.expiresAt) <= now.getTime()) {
        throw new WorkflowContractError("STALE_REVISION", "The state cleanup plan token expired.", { planId: payload.planId });
      }
      this.assertDatabaseIdentity(payload);
      const current = this.currentCandidates(payload.cutoffs);
      const candidates: StateCleanupPlanV1["candidates"] = {
        workflowRoots: current.workflow.roots,
        standaloneWorkflowRuns: current.workflow.standaloneRuns,
        continuitySnapshots: current.continuity?.snapshots ?? [],
        continuityTasks: current.continuity?.tasks ?? [],
      };
      const currentDigest = digest(candidates);
      if (currentDigest !== payload.candidateDigest || JSON.stringify(candidates) !== JSON.stringify(payload.candidates)) {
        throw new WorkflowContractError("STALE_REVISION", "State cleanup candidates changed after preview.", {
          planId: payload.planId,
          expectedDigest: payload.candidateDigest,
          actualDigest: currentDigest,
        });
      }
      if (!this.workflowStore.claimCleanupPlan(payload.planId, payload.candidateDigest, now.toISOString())) {
        throw new WorkflowContractError("STALE_REVISION", "The state cleanup plan token was already used.", { planId: payload.planId });
      }

      const workflowHasCandidates = candidates.workflowRoots.length > 0 || candidates.standaloneWorkflowRuns.length > 0;
      const continuityHasCandidates = candidates.continuitySnapshots.length > 0 || candidates.continuityTasks.length > 0;
      const workflowResult: StateCleanupReceiptV1["databases"]["workflow"] = {
        status: "skipped", backupPath: null, deletedRoots: 0, deletedRuns: 0, error: null,
      };
      const continuityResult: StateCleanupReceiptV1["databases"]["continuity"] = {
        status: this.continuityStore ? "skipped" : "unavailable",
        backupPath: null, deletedSnapshots: 0, deletedTasks: 0, error: null,
      };

      if (workflowHasCandidates) {
        try {
          workflowResult.backupPath = this.backupPath(this.workflowStore.databasePath, "workflows", payload.planId);
          this.workflowStore.backupTo(workflowResult.backupPath);
          this.protectBackup(workflowResult.backupPath);
          const deleted = this.workflowStore.executeCleanup({
            roots: candidates.workflowRoots,
            standaloneRuns: candidates.standaloneWorkflowRuns,
            protectedActiveRoots: current.workflow.protectedActiveRoots,
          });
          workflowResult.status = "completed";
          workflowResult.deletedRoots = deleted.roots;
          workflowResult.deletedRuns = deleted.runs;
        } catch (error) {
          workflowResult.status = "failed";
          workflowResult.error = error instanceof Error ? error.message : String(error);
        }
      }

      if (continuityHasCandidates && this.continuityStore && current.continuity) {
        try {
          continuityResult.backupPath = this.backupPath(this.continuityStore.databasePath, "continuity", payload.planId);
          this.continuityStore.backupTo(continuityResult.backupPath);
          this.protectBackup(continuityResult.backupPath);
          const deleted = this.continuityStore.executeCleanup(current.continuity, now.toISOString());
          continuityResult.status = "completed";
          continuityResult.deletedSnapshots = deleted.snapshots;
          continuityResult.deletedTasks = deleted.tasks;
        } catch (error) {
          continuityResult.status = "failed";
          continuityResult.error = error instanceof Error ? error.message : String(error);
        }
      }

      const failures = workflowResult.status === "failed" || continuityResult.status === "failed";
      const noOp = !workflowHasCandidates && !continuityHasCandidates;
      const receipt: StateCleanupReceiptV1 = {
        schemaVersion: "1.0.0",
        planId: payload.planId,
        status: noOp ? "no-op" : failures ? "partial" : "completed",
        executedAt: now.toISOString(),
        candidateDigest: payload.candidateDigest,
        databases: { workflow: workflowResult, continuity: continuityResult },
        backupRetention: "manual-deletion-only",
        protection: protection(),
      };
      this.validator.stateCleanupReceipt(receipt);
      return { schemaVersion: "1.0.0", ok: true, data: receipt, error: null };
    } catch (error) {
      return apiError(error);
    }
  }

  private currentCandidates(cutoffs: StateCleanupPlanV1["cutoffs"]): {
    workflow: WorkflowCleanupPreview;
    continuity: ContinuityCleanupPreview | null;
    protectedContinuityTasks: number;
  } {
    const workflow = this.workflowStore.previewCleanup(cutoffs.workflow);
    const continuity = this.continuityStore?.previewCleanup(cutoffs.continuityPayload, cutoffs.continuityRecord) ?? null;
    let protectedContinuityTasks = continuity?.protectedActiveTasks ?? 0;
    if (continuity) {
      const allowedTasks = continuity.tasks.filter((task) => {
        const active = task.rootId ? this.workflowStore.isConvergenceRootActive(task.rootId) : false;
        if (active) protectedContinuityTasks += 1;
        return !active;
      });
      continuity.tasks = allowedTasks;
      const allowedIds = new Set(allowedTasks.map((task) => task.taskCorrelation));
      continuity.snapshots = continuity.snapshots.filter((snapshot) => !allowedIds.has(snapshot.taskCorrelation));
    }
    return { workflow, continuity, protectedContinuityTasks };
  }

  private sign(payload: CleanupTokenPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  private verify(token: string): CleanupTokenPayload {
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra) throw new WorkflowContractError("INVALID_INPUT", "The state cleanup plan token is malformed.");
    const expected = createHmac("sha256", this.secret).update(encoded).digest();
    let actual: Buffer;
    try { actual = Buffer.from(signature, "base64url"); } catch { throw new WorkflowContractError("INVALID_INPUT", "The state cleanup plan token is malformed."); }
    if (actual.toString("base64url") !== signature || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new WorkflowContractError("INVALID_INPUT", "The state cleanup plan token signature is invalid.");
    }
    try {
      const payloadBytes = Buffer.from(encoded, "base64url");
      if (payloadBytes.toString("base64url") !== encoded) throw new Error("non-canonical token payload");
      return JSON.parse(payloadBytes.toString("utf8")) as CleanupTokenPayload;
    } catch {
      throw new WorkflowContractError("INVALID_INPUT", "The state cleanup plan token payload is invalid.");
    }
  }

  private assertDatabaseIdentity(payload: CleanupTokenPayload): void {
    const workflow = payload.databases.workflow;
    if (workflow.path !== databaseIdentity(this.workflowStore.databasePath) || workflow.schemaVersion !== this.workflowStore.getSchemaVersion()) {
      throw new WorkflowContractError("STALE_REVISION", "The workflow database identity or schema changed after preview.");
    }
    const continuity = this.continuityStore
      ? { path: databaseIdentity(this.continuityStore.databasePath), schemaVersion: this.continuityStore.getSchemaVersion() }
      : null;
    if (JSON.stringify(continuity) !== JSON.stringify(payload.databases.continuity)) {
      throw new WorkflowContractError("STALE_REVISION", "The continuity database identity or schema changed after preview.");
    }
  }

  private backupPath(databasePath: string, label: string, planId: string): string {
    if (databasePath === ":memory:") throw new WorkflowContractError("INVALID_INPUT", "In-memory databases cannot be cleaned destructively.");
    const directory = path.join(path.dirname(path.resolve(databasePath)), "backups");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return path.join(directory, `${label}-before-cleanup-${planId}.sqlite3`);
  }

  private protectBackup(targetPath: string): void {
    if (process.platform !== "win32") chmodSync(targetPath, 0o600);
  }
}
