import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  type ApiResultV1,
  type ContinuityCandidateV1,
  type ContinuitySnapshotV1,
  type ContinuitySummaryV1,
  type ErrorCode,
  type Sha256Digest,
  WorkflowContractError,
} from "../../contracts/types.js";
import { canonicalJson, convergenceDigest } from "./convergence-logic.js";
import { ContractValidator } from "./schema-validator.js";
import {
  ContinuityStoreError,
  type ContinuityTaskRecord,
  SqliteContinuityStore,
} from "./continuity-store.js";
import type { WorkflowStore } from "./workflow-store.js";

const TOOL_TOKEN_TTL_SECONDS = 300;
const CANDIDATE_TOKEN_TTL_SECONDS = 3600;

interface ToolBindingPayload {
  v: 1;
  c: string;
  e: number;
  t: string;
  d: Sha256Digest;
  x: number;
}

interface CandidatePayload {
  v: 1;
  c: string;
  e: number;
  s: "direct" | "workflow";
  r: number;
  d: Sha256Digest;
  x: number;
}

export interface WorkflowContinuityCardV1 {
  schemaVersion: "1.0.0";
  source: "workflow";
  taskCorrelation: string;
  epoch: number;
  revision: number;
  rootId: string;
  rootState: string;
  taskId: string;
  objective: string;
  includedScope: string[];
  acceptanceCriteria: string[];
  constraints: string[];
  authorization: {
    allowedActions: string[];
    prohibitedActions: string[];
    approvalRequired: string[];
  };
  workflowState: string | null;
  currentStageId: string | null;
  nextStageId: string | null;
  blockers: string[];
  unresolved: string[];
  evidenceRefs: Array<{ artifactId: string; locator: string; digest: string; verified: boolean }>;
  updatedAt: string;
  snapshotDigest: Sha256Digest;
}

export interface ContinuityPurgeResultV1 {
  schemaVersion: "1.0.0";
  purged: true;
  epoch: number;
  revision: number;
  tombstoneDigest: Sha256Digest;
  purgedAt: string;
}

interface CheckpointReplayReceiptV1 {
  schemaVersion: "1.0.0";
  kind: "checkpoint";
  epoch: number;
  revision: number;
  snapshotDigest: Sha256Digest;
}

export interface ContinuityGateway {
  readonly available: boolean;
  checkpointContext(value: unknown): ApiResultV1<ContinuitySnapshotV1>;
  inspectContext(value: unknown): ApiResultV1<ContinuityCandidateV1>;
  loadContext(value: unknown): ApiResultV1<ContinuitySnapshotV1 | WorkflowContinuityCardV1>;
  suppressContextRestore(value: unknown): ApiResultV1<{ schemaVersion: "1.0.0"; suppressed: true; epoch: number }>;
  purgeDirectContext(value: unknown): ApiResultV1<ContinuityPurgeResultV1>;
  bindOpenedRoot(value: unknown, rootId: string): void;
}

function ok<T>(data: T): ApiResultV1<T> {
  return { schemaVersion: "1.0.0", ok: true, data, error: null };
}

function failure(code: ErrorCode, message: string, details: Record<string, unknown> | null = null): ApiResultV1<never> {
  return { schemaVersion: "1.0.0", ok: false, data: null, error: { code, message, details } };
}

function withoutBinding(value: Record<string, unknown>): Record<string, unknown> {
  const result = { ...value };
  delete result._continuityBinding;
  return result;
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function boundedStrings(values: string[], maxItems: number, maxLength: number): string[] {
  return values.slice(0, maxItems).map((value) => boundedText(value, maxLength));
}

function encode(value: unknown): string {
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}

function parseJsonToken<T>(value: string): { payload: T; body: string; signature: Buffer } | null {
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra) return null;
  try {
    return {
      payload: JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T,
      body,
      signature: Buffer.from(signature, "base64url"),
    };
  } catch {
    return null;
  }
}

export class ContinuityService implements ContinuityGateway {
  readonly available = true;
  private readonly secret: string;

  constructor(
    readonly store: SqliteContinuityStore,
    private readonly validator: ContractValidator,
    private readonly workflowStore: WorkflowStore | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.secret = store.getOrCreateSecret(() => randomBytes(32).toString("base64url"));
  }

  correlateSession(rawSessionId: string): string {
    return `hmac-sha256:${this.hmac(`session\0${rawSessionId}`)}`;
  }

  hashOpaque(kind: "request" | "turn", value: string): string {
    return `hmac-sha256:${this.hmac(`${kind}\0${value}`)}`;
  }

  ensureSession(rawSessionId: string): ContinuityTaskRecord {
    return this.store.ensureTask(this.correlateSession(rawSessionId), this.now().toISOString());
  }

  clearSession(rawSessionId: string): ContinuityTaskRecord {
    return this.store.rotateEpoch(this.correlateSession(rawSessionId), this.now().toISOString());
  }

  issueToolBinding(rawSessionId: string, toolName: string, input: Record<string, unknown>): string {
    const task = this.ensureSession(rawSessionId);
    const payload: ToolBindingPayload = {
      v: 1,
      c: task.taskCorrelation,
      e: task.currentEpoch,
      t: toolName,
      d: convergenceDigest(withoutBinding(input)),
      x: Math.floor(this.now().getTime() / 1000) + TOOL_TOKEN_TTL_SECONDS,
    };
    return this.sign(payload);
  }

  checkpointContext(value: unknown): ApiResultV1<ContinuitySnapshotV1> {
    return this.guard(() => {
      const request = this.validator.checkpointContextRequest(value);
      const binding = this.verifyToolBinding("checkpoint_context", request, request._continuityBinding);
      const task = this.currentTask(binding);
      if (task.rootId) throw new WorkflowContractError("SNAPSHOT_CONFLICT", "Direct checkpoints are disabled after a workflow root is bound.", { rootId: task.rootId });
      const now = this.now().toISOString();
      const current = this.store.getSnapshot(binding.c, binding.e);
      const base = {
        schemaVersion: "1.0.0" as const,
        source: "direct" as const,
        taskCorrelation: binding.c,
        epoch: binding.e,
        revision: request.expectedRevision + 1,
        status: request.status,
        core: request.core,
        evidenceRefs: request.evidenceRefs,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      const snapshot: ContinuitySnapshotV1 = { ...base, snapshotDigest: convergenceDigest(base) };
      const requestHash = this.hashOpaque("request", request.requestId);
      const commandDigest = convergenceDigest(withoutBinding(request as unknown as Record<string, unknown>));
      const stored = this.store.checkpoint(binding.c, binding.e, request.expectedRevision, requestHash, commandDigest, snapshot);
      if (stored.kind === "replay") {
        const receipt = JSON.parse(stored.request.resultJson) as Partial<CheckpointReplayReceiptV1>;
        const replaySnapshot = this.store.getSnapshot(binding.c, binding.e);
        if (
          receipt.kind !== "checkpoint" || receipt.epoch !== binding.e ||
          !replaySnapshot || replaySnapshot.revision !== receipt.revision ||
          replaySnapshot.snapshotDigest !== receipt.snapshotDigest
        ) {
          return failure("STALE_REVISION", "The idempotent checkpoint result is no longer available after replacement or purge.");
        }
        return ok(replaySnapshot);
      }
      if (stored.kind === "conflict") return failure("REQUEST_CONFLICT", "requestId was already used for different checkpoint content.");
      if (stored.kind === "stale") return failure("STALE_REVISION", "The direct checkpoint revision changed.", { expectedRevision: request.expectedRevision, actualRevision: stored.actualRevision });
      return ok(snapshot);
    });
  }

  inspectContext(value: unknown): ApiResultV1<ContinuityCandidateV1> {
    return this.guard(() => {
      const request = this.validator.inspectContextRequest(value);
      const binding = this.verifyToolBinding("inspect_context", request, request._continuityBinding);
      return ok(this.candidateFor(binding.c));
    });
  }

  loadContext(value: unknown): ApiResultV1<ContinuitySnapshotV1 | WorkflowContinuityCardV1> {
    return this.guard<ContinuitySnapshotV1 | WorkflowContinuityCardV1>(() => {
      const request = this.validator.loadContextRequest(value);
      const binding = this.verifyToolBinding("load_context", request, request._continuityBinding);
      const candidate = this.verifyCandidate(request.candidateToken);
      if (
        candidate.c !== binding.c || candidate.e !== binding.e ||
        candidate.e !== request.epoch || candidate.r !== request.revision || candidate.d !== request.digest
      ) throw new WorkflowContractError("BINDING_INVALID", "Restore candidate does not match the current task and requested state.");
      const task = this.currentTask(binding);
      if (task.suppressed) throw new WorkflowContractError("SNAPSHOT_NOT_FOUND", "Restore is suppressed for the current epoch.");
      if (candidate.s === "direct") {
        const snapshot = this.store.getSnapshot(binding.c, binding.e);
        if (!snapshot || snapshot.revision !== candidate.r || snapshot.snapshotDigest !== candidate.d) {
          throw new WorkflowContractError("STALE_REVISION", "The direct restore candidate is stale.");
        }
        const { snapshotDigest, ...base } = snapshot;
        if (convergenceDigest(base) !== snapshotDigest) throw new WorkflowContractError("INTEGRITY_FAILED", "The direct snapshot digest is invalid.");
        return ok<ContinuitySnapshotV1 | WorkflowContinuityCardV1>(snapshot);
      }
      const card = this.workflowProjection(task);
      if (!card || card.revision !== candidate.r || card.snapshotDigest !== candidate.d) {
        throw new WorkflowContractError("STALE_REVISION", "The workflow restore candidate is stale.");
      }
      return ok<ContinuitySnapshotV1 | WorkflowContinuityCardV1>(card);
    });
  }

  suppressContextRestore(value: unknown): ApiResultV1<{ schemaVersion: "1.0.0"; suppressed: true; epoch: number }> {
    return this.guard(() => {
      const request = this.validator.suppressContextRestoreRequest(value);
      const binding = this.verifyToolBinding("suppress_context_restore", request, request._continuityBinding);
      if (request.expectedEpoch !== binding.e) throw new WorkflowContractError("STALE_REVISION", "The continuity epoch changed.", { actualEpoch: binding.e });
      if (!this.store.setSuppressed(binding.c, binding.e, this.now().toISOString())) throw new WorkflowContractError("STALE_REVISION", "The continuity epoch changed.");
      return ok({ schemaVersion: "1.0.0", suppressed: true, epoch: binding.e });
    });
  }

  purgeDirectContext(value: unknown): ApiResultV1<ContinuityPurgeResultV1> {
    return this.guard(() => {
      const request = this.validator.purgeDirectContextRequest(value);
      const binding = this.verifyToolBinding("purge_direct_context", request, request._continuityBinding);
      this.currentTask(binding);
      const current = this.store.getSnapshot(binding.c, request.expectedEpoch);
      const requestHash = this.hashOpaque("request", request.requestId);
      const commandDigest = convergenceDigest(withoutBinding(request as unknown as Record<string, unknown>));
      const tombstoneDigest = convergenceDigest({ taskCorrelation: binding.c, epoch: request.expectedEpoch, revision: request.expectedRevision, payloadDigest: current?.snapshotDigest ?? null });
      const now = this.now().toISOString();
      const purged = this.store.purge(binding.c, request.expectedEpoch, request.expectedRevision, requestHash, commandDigest, tombstoneDigest, now);
      if (purged.kind === "replay") {
        const replay = JSON.parse(purged.request.resultJson) as Partial<ContinuityPurgeResultV1>;
        if (
          replay.schemaVersion !== "1.0.0" || replay.purged !== true ||
          replay.epoch !== request.expectedEpoch || replay.revision !== request.expectedRevision ||
          typeof replay.tombstoneDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(replay.tombstoneDigest) ||
          typeof replay.purgedAt !== "string"
        ) {
          return failure("STALE_REVISION", "The idempotent purge result is no longer available.");
        }
        return ok(replay as ContinuityPurgeResultV1);
      }
      if (purged.kind === "conflict") return failure("REQUEST_CONFLICT", "requestId was already used for a different purge request.");
      if (purged.kind === "stale") return failure("STALE_REVISION", "The direct checkpoint revision changed or no payload exists.", { expectedRevision: request.expectedRevision, actualRevision: purged.actualRevision });
      return ok({ schemaVersion: "1.0.0", purged: true, epoch: request.expectedEpoch, revision: request.expectedRevision, tombstoneDigest, purgedAt: now });
    });
  }

  bindOpenedRoot(value: unknown, rootId: string): void {
    try {
      const args = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const token = typeof args._continuityBinding === "string" ? args._continuityBinding : "";
      const binding = this.verifyToolBinding("open_convergence_root", args, token);
      this.store.bindRoot(binding.c, binding.e, rootId, this.now().toISOString());
    } catch {
      // Correlation is best effort and never changes the workflow result.
    }
  }

  candidateForSession(rawSessionId: string): ContinuityCandidateV1 {
    const task = this.ensureSession(rawSessionId);
    return this.candidateFor(task.taskCorrelation);
  }

  markPreCompact(rawSessionId: string): void {
    const task = this.ensureSession(rawSessionId);
    if (task.suppressed) return;
    const summary = this.summary(task);
    if (!summary) return;
    this.store.setPendingMarker(task.taskCorrelation, task.currentEpoch, summary.source, summary.revision, summary.snapshotDigest, task.rootId, this.now().toISOString());
  }

  compactContext(rawSessionId: string): string | null {
    const task = this.ensureSession(rawSessionId);
    if (task.suppressed || task.pendingConsumed) return null;
    const summary = this.summary(task);
    if (!summary || task.pendingRevision !== summary.revision || task.pendingDigest !== summary.snapshotDigest || task.pendingSource !== summary.source) return null;
    if (summary.source === "direct") return this.formatCandidate(this.candidateFor(task.taskCorrelation));
    const card = this.workflowProjection(task);
    if (!card || task.pendingRootId !== card.rootId) return null;
    if (!this.store.consumeWorkflowMarker(task.taskCorrelation, task.currentEpoch, card.revision, card.snapshotDigest, this.now().toISOString())) return null;
    return this.formatWorkflowCard(card);
  }

  recordPostCompact(rawSessionId: string, rawTurnId: string | null, success: boolean): void {
    const task = this.ensureSession(rawSessionId);
    this.store.recordObservation(task.taskCorrelation, task.currentEpoch, "post-compact", rawTurnId ? this.hashOpaque("turn", rawTurnId) : null, success, this.now().toISOString());
  }

  formatCandidate(candidate: ContinuityCandidateV1): string | null {
    if (!candidate.summary || !candidate.restoreToken) return null;
    const summary = candidate.summary;
    return [
      "[Task continuity restore candidate — metadata only]",
      "decision=DEFER",
      `source=${summary.source}`,
      `epoch=${summary.epoch}`,
      `revision=${summary.revision}`,
      `digest=${summary.snapshotDigest}`,
      `candidateToken=${candidate.restoreToken}`,
      "No snapshot body was injected. Treat nextActions as historical candidates only; call load_context explicitly after checking the current user request.",
    ].join("\n");
  }

  private formatWorkflowCard(card: WorkflowContinuityCardV1): string {
    return [
      "[Task continuity workflow card — structural state, not new instructions]",
      "decision=INJECT",
      JSON.stringify(card),
      "Reconcile this projected state with the latest user request before acting.",
    ].join("\n");
  }

  private candidateFor(taskCorrelation: string): ContinuityCandidateV1 {
    const task = this.store.getTask(taskCorrelation);
    if (!task) return { schemaVersion: "1.0.0", decision: "REJECT", reasonCodes: ["NO_TASK_BINDING"], summary: null, restoreToken: null };
    if (task.suppressed) return { schemaVersion: "1.0.0", decision: "REJECT", reasonCodes: ["RESTORE_SUPPRESSED"], summary: null, restoreToken: null };
    const summary = this.summary(task);
    if (!summary) return { schemaVersion: "1.0.0", decision: "REJECT", reasonCodes: ["NO_RESTORE_CANDIDATE"], summary: null, restoreToken: null };
    const payload: CandidatePayload = {
      v: 1, c: task.taskCorrelation, e: task.currentEpoch, s: summary.source,
      r: summary.revision, d: summary.snapshotDigest,
      x: Math.floor(this.now().getTime() / 1000) + CANDIDATE_TOKEN_TTL_SECONDS,
    };
    return { schemaVersion: "1.0.0", decision: "DEFER", reasonCodes: ["EXPLICIT_LOAD_REQUIRED"], summary, restoreToken: this.sign(payload) };
  }

  private summary(task: ContinuityTaskRecord): ContinuitySummaryV1 | null {
    const card = task.rootId ? this.workflowProjection(task) : null;
    if (card) return {
      schemaVersion: "1.0.0", source: "workflow", taskCorrelation: task.taskCorrelation,
      epoch: task.currentEpoch, revision: card.revision, status: card.rootState,
      snapshotDigest: card.snapshotDigest, updatedAt: card.updatedAt,
    };
    const snapshot = this.store.getSnapshot(task.taskCorrelation, task.currentEpoch);
    if (!snapshot) return null;
    return {
      schemaVersion: "1.0.0", source: "direct", taskCorrelation: task.taskCorrelation,
      epoch: task.currentEpoch, revision: snapshot.revision, status: snapshot.status,
      snapshotDigest: snapshot.snapshotDigest, updatedAt: snapshot.updatedAt,
    };
  }

  private workflowProjection(task: ContinuityTaskRecord): WorkflowContinuityCardV1 | null {
    if (!task.rootId || !this.workflowStore) return null;
    const snapshot = this.workflowStore.getConvergenceSnapshot(task.rootId);
    if (!snapshot) return null;
    const latestRunId = snapshot.workflowRunIds.at(-1);
    const receipt = latestRunId ? this.workflowStore.getRun(latestRunId) : null;
    const base = {
      schemaVersion: "1.0.0" as const,
      source: "workflow" as const,
      taskCorrelation: task.taskCorrelation,
      epoch: task.currentEpoch,
      revision: snapshot.root.revision,
      rootId: boundedText(snapshot.root.rootId, 160),
      rootState: snapshot.root.state,
      taskId: boundedText(snapshot.root.taskEnvelope.taskId, 160),
      objective: boundedText(snapshot.root.taskEnvelope.objective, 800),
      includedScope: boundedStrings(snapshot.root.taskEnvelope.scope.included, 4, 120),
      acceptanceCriteria: boundedStrings(snapshot.root.taskEnvelope.acceptanceCriteria, 4, 240),
      constraints: boundedStrings(snapshot.root.taskEnvelope.constraints, 4, 240),
      authorization: {
        allowedActions: boundedStrings(snapshot.root.taskEnvelope.authorization.allowedActions, 4, 120),
        prohibitedActions: boundedStrings(snapshot.root.taskEnvelope.authorization.prohibitedActions, 4, 120),
        approvalRequired: boundedStrings(snapshot.root.taskEnvelope.authorization.approvalRequired, 4, 120),
      },
      workflowState: receipt?.state ?? null,
      currentStageId: receipt?.plan.currentStageId ?? null,
      nextStageId: receipt?.plan.nextStageId ?? null,
      blockers: boundedStrings(receipt?.blockers ?? [], 4, 200),
      unresolved: boundedStrings(receipt?.unresolved ?? [], 4, 200),
      evidenceRefs: (receipt?.stageResults ?? []).flatMap((result) => result.output.artifacts.map((item) => ({
        artifactId: boundedText(item.artifactId, 80),
        locator: boundedText(item.locator, 160),
        digest: item.digest,
        verified: item.verified,
      }))).slice(0, 6),
      updatedAt: snapshot.root.updatedAt,
    };
    return { ...base, snapshotDigest: convergenceDigest(base) };
  }

  private currentTask(binding: ToolBindingPayload): ContinuityTaskRecord {
    const task = this.store.getTask(binding.c);
    if (!task || task.currentEpoch !== binding.e) throw new WorkflowContractError("BINDING_INVALID", "Continuity task binding is stale.");
    return task;
  }

  private verifyToolBinding(toolName: string, value: object, token: string): ToolBindingPayload {
    if (!token) throw new WorkflowContractError("BINDING_REQUIRED", "A current continuity binding token is required.");
    const payload = this.verifySigned<ToolBindingPayload>(token);
    const now = Math.floor(this.now().getTime() / 1000);
    if (payload.v !== 1 || payload.t !== toolName || payload.x < now || payload.d !== convergenceDigest(withoutBinding(value as Record<string, unknown>))) {
      throw new WorkflowContractError("BINDING_INVALID", "Continuity binding token is invalid, expired, or bound to different input.");
    }
    return payload;
  }

  private verifyCandidate(token: string): CandidatePayload {
    const payload = this.verifySigned<CandidatePayload>(token);
    if (payload.v !== 1 || payload.x < Math.floor(this.now().getTime() / 1000) || !["direct", "workflow"].includes(payload.s)) {
      throw new WorkflowContractError("BINDING_INVALID", "Restore candidate token is invalid or expired.");
    }
    return payload;
  }

  private sign(value: unknown): string {
    const body = encode(value);
    const signature = createHmac("sha256", this.secret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  private verifySigned<T>(token: string): T {
    const parsed = parseJsonToken<T>(token);
    if (!parsed) throw new WorkflowContractError("BINDING_INVALID", "Signed continuity token is malformed.");
    const expected = createHmac("sha256", this.secret).update(parsed.body).digest();
    if (expected.length !== parsed.signature.length || !timingSafeEqual(expected, parsed.signature)) {
      throw new WorkflowContractError("BINDING_INVALID", "Signed continuity token failed verification.");
    }
    return parsed.payload;
  }

  private hmac(value: string): string {
    return createHmac("sha256", this.secret).update(value, "utf8").digest("hex");
  }

  private guard<T>(action: () => ApiResultV1<T>): ApiResultV1<T> {
    try {
      return action();
    } catch (error) {
      if (error instanceof WorkflowContractError) return failure(error.code, error.message, error.details);
      if (error instanceof ContinuityStoreError) return failure("CONTINUITY_UNAVAILABLE", error.message);
      return failure("CONTINUITY_UNAVAILABLE", "Continuity operation failed.", { cause: error instanceof Error ? error.message : String(error) });
    }
  }
}

export class UnavailableContinuityService implements ContinuityGateway {
  readonly available = false;
  private unavailable<T>(): ApiResultV1<T> {
    return failure("CONTINUITY_UNAVAILABLE", "The optional continuity store is unavailable.");
  }
  checkpointContext(): ApiResultV1<ContinuitySnapshotV1> { return this.unavailable(); }
  inspectContext(): ApiResultV1<ContinuityCandidateV1> { return this.unavailable(); }
  loadContext(): ApiResultV1<ContinuitySnapshotV1 | WorkflowContinuityCardV1> { return this.unavailable(); }
  suppressContextRestore(): ApiResultV1<{ schemaVersion: "1.0.0"; suppressed: true; epoch: number }> { return this.unavailable(); }
  purgeDirectContext(): ApiResultV1<ContinuityPurgeResultV1> { return this.unavailable(); }
  bindOpenedRoot(): void { /* Fail open. */ }
}
