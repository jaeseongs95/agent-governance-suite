import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  CONVERGENCE_ROOT_STATE,
  type ApiResultV1,
  type ContinuityCandidateV1,
  type ContinuitySnapshotV1,
  type ContinuitySummaryV1,
  type ErrorCode,
  type Sha256Digest,
  WorkflowContractError,
} from "../../contracts/types.js";
import { canonicalJson, convergenceDigest } from "./convergence-logic.js";
import type { ContractValidator } from "./schema-validator.js";
import {
  ContinuityStoreError,
  continuityUnavailableReason,
  type ContinuityUnavailableReason,
  type ContinuityTaskRecord,
  type ContinuityCurrentRead,
  isBodyFreeRequestReceipt,
  SqliteContinuityStore,
} from "./continuity-store.js";
import type { WorkflowStore } from "./workflow-store.js";
import type { LineageRead } from "./host-input-adapter.js";

const TOOL_TOKEN_TTL_SECONDS = 300;
const CANDIDATE_TOKEN_TTL_SECONDS = 3600;

/** A fork child's selected parent: the exact anchored revision, never "latest". */
interface ForkParent { c: string; e: number; r: number; d: string }

interface ToolBindingPayload {
  v: 1;
  c: string;
  e: number;
  t: string;
  d: Sha256Digest;
  x: number;
  /** checkpoint_context: anchors of this session's newest host-written entries (at most 16, design r03). */
  a?: string[];
  /** inspect_context of a recorded fork: parent selected from the child's own lineage, or why none. */
  p?: ForkParent;
  q?: string;
}

interface CandidatePayload {
  v: 1;
  c: string;
  e: number;
  s: "direct" | "workflow";
  r: number;
  d: Sha256Digest;
  x: number;
  /** Fork candidate: the child task and epoch that alone may load parent state c/e. */
  f?: string;
  g?: number;
}

const FORK_START_EVENT = "fork-start";
const FORK_PARENT_EVENT = "fork-parent:";
const LINEAGE_ANCHOR_COUNT = 16;

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
  checkpointContext(value: unknown): ApiResultV1<ContinuitySnapshotV1>;
  inspectContext(value: unknown): ApiResultV1<ContinuityCandidateV1>;
  loadContext(value: unknown): ApiResultV1<ContinuitySnapshotV1 | WorkflowContinuityCardV1>;
  suppressContextRestore(value: unknown): ApiResultV1<{ schemaVersion: "1.0.0"; suppressed: true; epoch: number }>;
  purgeDirectContext(value: unknown): ApiResultV1<ContinuityPurgeResultV1>;
  bindOpenedRoot(value: unknown, rootId: string): boolean;
  /** Called only with the session identity verified by the MCP ingress. */
  prepareWorkflowStart(rawSessionId: string, rootId: string): void;
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

/** A stored purge result: the body-free "purged" receipt shape, never a checkpoint or scrubbed request. */
function purgeReceipt(value: unknown): ContinuityPurgeResultV1 | null {
  const receipt = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  return receipt && receipt.purged === true && isBodyFreeRequestReceipt(receipt) ? receipt as unknown as ContinuityPurgeResultV1 : null;
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function boundedStrings(values: string[], maxItems: number, maxLength: number): string[] {
  return values.slice(0, maxItems).map((value, index) => {
    const omitted = values.length > maxItems && index === maxItems - 1 ? ` [+${values.length - maxItems} omitted]` : "";
    return boundedText(value, maxLength - omitted.length) + omitted;
  });
}

function encode(value: unknown): string {
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}

function parseJsonToken<T>(value: string): { payload: T; body: string; signature: Buffer } | null {
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra) return null;
  try {
    const bodyBytes = Buffer.from(body, "base64url");
    const signatureBytes = Buffer.from(signature, "base64url");
    if (bodyBytes.toString("base64url") !== body || signatureBytes.toString("base64url") !== signature) return null;
    return {
      payload: JSON.parse(bodyBytes.toString("utf8")) as T,
      body,
      signature: signatureBytes,
    };
  } catch {
    return null;
  }
}

export class ContinuityService implements ContinuityGateway {
  private readonly secret: string;

  constructor(
    readonly store: SqliteContinuityStore,
    // Lifecycle hooks pass null: they never call the MCP tool methods, and skipping the validator keeps ajv out of the hook bundle.
    private readonly validator: ContractValidator | null,
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
    const now = this.now().toISOString();
    const task = this.store.ensureTask(this.correlateSession(rawSessionId), now);
    const rootId = task.rootId;
    const workflowStore = this.workflowStore;
    if (!rootId || !workflowStore) return task;
    // Keep workflow writers excluded until the separate continuity CAS commits.
    return workflowStore.withWorkflowTransaction(() => this.store.rotateEpoch(task.taskCorrelation, now, {
      epoch: task.currentEpoch,
      rootId,
      isTerminal: () => {
        const snapshot = workflowStore.getConvergenceSnapshot(rootId);
        if (!snapshot || snapshot.root.rootId !== rootId || !CONVERGENCE_ROOT_STATE.includes(snapshot.root.state)) return false;
        const terminalRoot = snapshot.root.state === "completed" || snapshot.root.state === "abandoned";
        if (!terminalRoot && snapshot.workflowRunIds.length === 0) return false;
        // A finished run may leave its root open or awaiting review. Every linked
        // run and every consumed lease, including older epochs, must be settled.
        if (!snapshot.workflowRunIds.every(runId => {
          const receipt = workflowStore.getRun(runId);
          return receipt !== null && ["passed", "failed", "blocked"].includes(receipt.state);
        })) return false;
        const finished = new Map(snapshot.outcomes.map(outcome => [outcome.leaseId, outcome]));
        return snapshot.leases.every(lease => {
          if (lease.state !== "consumed") return true;
          const outcome = finished.get(lease.leaseId);
          return outcome?.rootId === rootId && outcome.epoch === lease.epoch && outcome.ordinal === lease.ordinal;
        });
      },
    }));
  }

  clearSession(rawSessionId: string): ContinuityTaskRecord {
    return this.store.rotateEpoch(this.correlateSession(rawSessionId), this.now().toISOString());
  }

  issueToolBinding(rawSessionId: string, toolName: string, input: Record<string, unknown>, readLineage?: () => LineageRead): string {
    const task = this.ensureSession(rawSessionId);
    const payload: ToolBindingPayload = {
      v: 1,
      c: task.taskCorrelation,
      e: task.currentEpoch,
      t: toolName,
      d: convergenceDigest(withoutBinding(input)),
      x: Math.floor(this.now().getTime() / 1000) + TOOL_TOKEN_TTL_SECONDS,
      ...(toolName === "checkpoint_context" && readLineage ? this.anchorsFor(readLineage) : {}),
      ...(toolName === "inspect_context" ? this.pinnedForkParent(task, readLineage) : {}),
    };
    return this.sign(payload);
  }

  /** The host's SessionStart source=fork is the only relation authority; lineage later picks which parent. */
  startFork(rawSessionId: string): void {
    const task = this.ensureSession(rawSessionId);
    this.store.recordObservation(task.taskCorrelation, task.currentEpoch, FORK_START_EVENT, null, true, this.now().toISOString());
  }

  /** Several anchors: the very newest entry may not be among those a fork copies. */
  private anchorsFor(readLineage: () => LineageRead): Pick<ToolBindingPayload, "a"> {
    const read = readLineage();
    return "ids" in read ? { a: read.ids.slice(-LINEAGE_ANCHOR_COUNT).map(id => this.lineageAnchor(id)) } : {};
  }

  /**
   * Decides a fork child's parent once, before the model can change its own file: at the first user prompt when the
   * parent is already found there, otherwise (`final`) at the first write-capable or AGS tool boundary, before that
   * tool runs (review 902e r04; the host may not have written the child's transcript yet at the first prompt).
   * Only a recorded fork with no own state is considered; startup, resume and clear never are. A pin is never replaced.
   */
  pinForkParent(rawSessionId: string, readLineage: () => LineageRead, final = true): void {
    const task = this.store.getTask(this.correlateSession(rawSessionId));
    if (task) this.pinTaskForkParent(task, readLineage, final);
  }

  private pinTaskForkParent(task: ContinuityTaskRecord, readLineage: () => LineageRead, final: boolean): void {
    if (task.rootId || task.suppressed || this.summary(task)
      || !this.store.hasObservation(task.taskCorrelation, task.currentEpoch, FORK_START_EVENT)
      || this.store.firstObservationEvent(task.taskCorrelation, task.currentEpoch, FORK_PARENT_EVENT)) return;
    const selection = this.selectForkParent(task, readLineage);
    if (!final && !("p" in selection)) return;
    this.store.recordObservation(task.taskCorrelation, task.currentEpoch, FORK_PARENT_EVENT + JSON.stringify(selection), null, "p" in selection, this.now().toISOString());
  }

  /**
   * Only anchors saved before the child's fork record count, so a parent (or sibling) save after the fork cannot be
   * chosen. An entry belongs to the first session that anchored it: a fork's own save repeats the entries it copied,
   * and those copies never count for it (review 902e: a sibling holding 15 copied anchors outscored the parent's 14).
   * D1: the (parent, revision) whose own anchor appears last in the child's file wins, then the most and the fewest
   * absent of its anchors, then the later revision of the same parent. A tie between different parents is ambiguous.
   */
  private selectForkParent(task: ContinuityTaskRecord, readLineage: () => LineageRead): { p: ForkParent } | { q: string } {
    const read = readLineage();
    if (!("ids" in read)) return { q: read.reason };
    const forkAt = this.store.firstObservationId(task.taskCorrelation, task.currentEpoch, FORK_START_EVENT);
    if (forkAt === null) return { q: "FORK_PARENT_NOT_FOUND" };
    const positions = new Map<string, number>();
    read.ids.forEach((id, index) => positions.set(this.lineageAnchor(id), index));
    const scores = new Map<string, { parent: ForkParent; matched: number; absent: number; last: number }>();
    const owners = new Map<string, string>();
    for (const { anchor, parent } of this.store.lineageAnchorRows(task.taskCorrelation, forkAt)) {
      const owner = JSON.stringify([parent.c, parent.e]);
      if ((owners.get(anchor) ?? owner) !== owner) continue;
      owners.set(anchor, owner);
      const key = JSON.stringify([parent.c, parent.e, parent.r, parent.d]);
      const score = scores.get(key) ?? { parent, matched: 0, absent: 0, last: -1 };
      const position = positions.get(anchor);
      if (position === undefined) score.absent += 1;
      else { score.matched += 1; score.last = Math.max(score.last, position); }
      scores.set(key, score);
    }
    const ranked = [...scores.values()].filter(score => score.matched > 0).sort((left, right) => right.last - left.last
      || right.matched - left.matched || left.absent - right.absent
      || (left.parent.c === right.parent.c && left.parent.e === right.parent.e ? right.parent.r - left.parent.r : 0));
    const [best, next] = ranked;
    if (!best) return { q: "FORK_PARENT_NOT_FOUND" };
    if (next && next.matched === best.matched && next.absent === best.absent && next.last === best.last
      && (next.parent.c !== best.parent.c || next.parent.e !== best.parent.e)) {
      return { q: "FORK_PARENT_AMBIGUOUS" };
    }
    return { p: best.parent };
  }

  /**
   * inspect uses the pinned decision. Without one, no write-capable tool has run in this fork yet, so the child's own
   * file is still the host's and inspect pins it now.
   */
  private pinnedForkParent(task: ContinuityTaskRecord, readLineage?: () => LineageRead): Pick<ToolBindingPayload, "p" | "q"> {
    if (task.rootId || !this.store.hasObservation(task.taskCorrelation, task.currentEpoch, FORK_START_EVENT)) return {};
    if (readLineage) this.pinTaskForkParent(task, readLineage, true);
    const event = this.store.firstObservationEvent(task.taskCorrelation, task.currentEpoch, FORK_PARENT_EVENT);
    if (!event) return { q: "FORK_PARENT_NOT_PINNED" };
    let pinned: unknown;
    try { pinned = JSON.parse(event.slice(FORK_PARENT_EVENT.length)); } catch { return { q: "FORK_PARENT_PIN_INVALID" }; }
    const value = pinned as { p?: Partial<ForkParent>; q?: unknown };
    if (value && typeof value.q === "string") return { q: value.q };
    const parent = value?.p;
    if (parent && typeof parent.c === "string" && Number.isInteger(parent.e) && Number.isInteger(parent.r) && typeof parent.d === "string") {
      return { p: { c: parent.c, e: parent.e!, r: parent.r!, d: parent.d } };
    }
    return { q: "FORK_PARENT_PIN_INVALID" };
  }

  /** After compaction a later fork copies only post-boundary entries, so the current revision gets fresh anchors. */
  reanchorAfterCompact(rawSessionId: string, readLineage: () => LineageRead): void {
    const task = this.store.getTask(this.correlateSession(rawSessionId));
    if (!task || task.rootId) return;
    const snapshot = this.store.getSnapshot(task.taskCorrelation, task.currentEpoch);
    if (!snapshot) return;
    const anchors = this.anchorsFor(readLineage).a;
    if (anchors?.length) this.store.reanchorSnapshot(task.taskCorrelation, task.currentEpoch, snapshot.revision, snapshot.snapshotDigest, anchors, this.now().toISOString());
  }

  private lineageAnchor(entryId: string): string {
    return `hmac-sha256:${this.hmac(`lineage\0${entryId}`)}`;
  }

  checkpointContext(value: unknown): ApiResultV1<ContinuitySnapshotV1> {
    return this.guard(() => {
      const request = this.validator!.checkpointContextRequest(value);
      const binding = this.verifyToolBinding("checkpoint_context", request, request._continuityBinding);
      const task = this.currentTask(binding);
      if (task.rootId) throw new WorkflowContractError("SNAPSHOT_CONFLICT", "Direct checkpoints are disabled after a workflow root is bound.", { rootId: task.rootId });
      const now = this.now().toISOString();
      const current = this.currentReadValue(this.store.readCurrentState(binding.c, binding.e, "direct",
        () => this.store.getSnapshot(binding.c, binding.e), true));
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
      const stored = this.store.checkpoint(binding.c, binding.e, request.expectedRevision, requestHash, commandDigest, snapshot, Array.isArray(binding.a) ? binding.a : []);
      if (stored.kind === "epoch-mismatch") return failure("BINDING_INVALID", "Continuity task binding is stale.");
      if (stored.kind === "source-conflict") return failure("SNAPSHOT_CONFLICT", "Direct checkpoints are disabled after a workflow root is bound.");
      if (stored.kind === "replay") {
        const receipt = JSON.parse(stored.request.resultJson) as Partial<CheckpointReplayReceiptV1>;
        const replaySnapshot = this.currentReadValue(this.store.readCurrentState(binding.c, binding.e, "direct",
          () => this.store.getSnapshot(binding.c, binding.e), true));
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
      const request = this.validator!.inspectContextRequest(value);
      const binding = this.verifyToolBinding("inspect_context", request, request._continuityBinding);
      this.currentTask(binding);
      const own = this.candidateFor(binding.c, binding.e);
      if (own.reasonCodes[0] !== "NO_RESTORE_CANDIDATE") return ok(own);
      if (binding.p) return ok(this.forkCandidate(binding, binding.p));
      return ok(binding.q ? { ...own, reasonCodes: [...own.reasonCodes, binding.q] } : own);
    });
  }

  private forkCandidate(binding: ToolBindingPayload, parent: ForkParent): ContinuityCandidateV1 {
    const reject = (reason: string): ContinuityCandidateV1 => ({ schemaVersion: "1.0.0", decision: "REJECT", reasonCodes: ["NO_RESTORE_CANDIDATE", reason], summary: null, restoreToken: null });
    const task = this.store.getTask(parent.c);
    if (!task || task.currentEpoch !== parent.e || task.rootId) return reject("FORK_PARENT_EPOCH_CHANGED");
    if (task.suppressed) return reject("FORK_PARENT_SUPPRESSED");
    const summary = this.summary(task);
    // A parent that saved again after the fork, purged or cleared no longer holds the fork-time state.
    if (!summary || summary.source !== "direct" || summary.revision !== parent.r || summary.snapshotDigest !== parent.d) return reject("FORK_PARENT_ADVANCED");
    const payload: CandidatePayload = {
      v: 1, c: parent.c, e: parent.e, s: "direct", r: parent.r, d: summary.snapshotDigest,
      x: Math.floor(this.now().getTime() / 1000) + CANDIDATE_TOKEN_TTL_SECONDS, f: binding.c, g: binding.e,
    };
    return { schemaVersion: "1.0.0", decision: "DEFER", reasonCodes: ["EXPLICIT_LOAD_REQUIRED", "FORK_PARENT_CANDIDATE"], summary, restoreToken: this.sign(payload) };
  }

  loadContext(value: unknown): ApiResultV1<ContinuitySnapshotV1 | WorkflowContinuityCardV1> {
    return this.guard<ContinuitySnapshotV1 | WorkflowContinuityCardV1>(() => {
      const request = this.validator!.loadContextRequest(value);
      const binding = this.verifyToolBinding("load_context", request, request._continuityBinding);
      const candidate = this.verifyCandidate(request.candidateToken);
      const fork = candidate.f !== undefined;
      if (
        (fork ? candidate.f !== binding.c || candidate.g !== binding.e : candidate.c !== binding.c || candidate.e !== binding.e) ||
        candidate.e !== request.epoch || candidate.r !== request.revision || candidate.d !== request.digest
      ) throw new WorkflowContractError("BINDING_INVALID", "Restore candidate does not match the current task and requested state.");
      const task = this.currentTask(binding);
      if (task.suppressed) throw new WorkflowContractError("SNAPSHOT_NOT_FOUND", "Restore is suppressed for the current epoch.");
      if (fork) return ok<ContinuitySnapshotV1 | WorkflowContinuityCardV1>(this.loadForkParent(candidate, binding));
      if (candidate.s === "direct") {
        const snapshot = this.currentReadValue(this.store.readCurrentState(binding.c, binding.e, "direct",
          () => this.store.getSnapshot(binding.c, binding.e)));
        if (!snapshot || snapshot.revision !== candidate.r || snapshot.snapshotDigest !== candidate.d) {
          throw new WorkflowContractError("STALE_REVISION", "The direct restore candidate is stale.");
        }
        const { snapshotDigest, ...base } = snapshot;
        if (convergenceDigest(base) !== snapshotDigest) throw new WorkflowContractError("INTEGRITY_FAILED", "The direct snapshot digest is invalid.");
        return ok<ContinuitySnapshotV1 | WorkflowContinuityCardV1>(snapshot);
      }
      const card = this.currentReadValue(this.store.readCurrentState(binding.c, binding.e, "workflow",
        (current) => this.workflowProjection(current)));
      if (!card || card.revision !== candidate.r || card.snapshotDigest !== candidate.d) {
        throw new WorkflowContractError("STALE_REVISION", "The workflow restore candidate is stale.");
      }
      return ok<ContinuitySnapshotV1 | WorkflowContinuityCardV1>(card);
    });
  }

  /** Rechecks the parent's exact state, then adopts it into the empty child epoch so the child continues from it. */
  private loadForkParent(candidate: CandidatePayload, binding: ToolBindingPayload): ContinuitySnapshotV1 {
    const snapshot = this.currentReadValue(this.store.readCurrentState(candidate.c, candidate.e, "direct",
      () => this.store.getSnapshot(candidate.c, candidate.e)));
    if (!snapshot || snapshot.revision !== candidate.r || snapshot.snapshotDigest !== candidate.d) {
      throw new WorkflowContractError("STALE_REVISION", "The fork parent restore candidate is stale.");
    }
    const { snapshotDigest, ...base } = snapshot;
    if (convergenceDigest(base) !== snapshotDigest) throw new WorkflowContractError("INTEGRITY_FAILED", "The direct snapshot digest is invalid.");
    const adopted = { ...base, taskCorrelation: binding.c, epoch: binding.e, updatedAt: this.now().toISOString() };
    // Only an empty child epoch adopts; a child that already loaded or saved keeps its own state.
    if (!this.store.adoptSnapshot(binding.c, binding.e, { ...adopted, snapshotDigest: convergenceDigest(adopted) })) {
      throw new WorkflowContractError("STALE_REVISION", "The fork child already has its own continuity state.");
    }
    return snapshot;
  }

  suppressContextRestore(value: unknown): ApiResultV1<{ schemaVersion: "1.0.0"; suppressed: true; epoch: number }> {
    return this.guard(() => {
      const request = this.validator!.suppressContextRestoreRequest(value);
      const binding = this.verifyToolBinding("suppress_context_restore", request, request._continuityBinding);
      if (request.expectedEpoch !== binding.e) throw new WorkflowContractError("STALE_REVISION", "The continuity epoch changed.", { actualEpoch: binding.e });
      if (!this.store.setSuppressed(binding.c, binding.e, this.now().toISOString())) throw new WorkflowContractError("STALE_REVISION", "The continuity epoch changed.");
      return ok({ schemaVersion: "1.0.0", suppressed: true, epoch: binding.e });
    });
  }

  purgeDirectContext(value: unknown): ApiResultV1<ContinuityPurgeResultV1> {
    return this.guard(() => {
      const request = this.validator!.purgeDirectContextRequest(value);
      const binding = this.verifyToolBinding("purge_direct_context", request, request._continuityBinding);
      this.currentTask(binding);
      const current = this.store.getSnapshot(binding.c, request.expectedEpoch);
      if (current && current.revision !== request.expectedRevision) {
        return failure("STALE_REVISION", "The direct checkpoint revision changed.", {
          expectedRevision: request.expectedRevision,
          actualRevision: current.revision,
        });
      }
      const requestHash = this.hashOpaque("request", request.requestId);
      const commandDigest = convergenceDigest(withoutBinding(request as unknown as Record<string, unknown>));
      const tombstoneDigest = convergenceDigest({
        taskCorrelation: binding.c,
        epoch: request.expectedEpoch,
        revision: request.expectedRevision,
        payloadDigest: current?.snapshotDigest ?? null,
        purgeRequestHash: requestHash,
      });
      const now = this.now().toISOString();
      const purged = this.store.purge(binding.c, request.expectedEpoch, request.expectedRevision, requestHash, commandDigest, tombstoneDigest, now, binding.e);
      if (purged.kind === "epoch-mismatch") return failure("BINDING_INVALID", "Continuity task binding is stale.");
      if (purged.kind === "replay") {
        let replay: ContinuityPurgeResultV1 | null = null;
        try { replay = purgeReceipt(JSON.parse(purged.request.resultJson) as unknown); } catch { /* Reject malformed stored state below. */ }
        const tombstone = this.store.getTombstone(binding.c, request.expectedEpoch);
        if (
          !replay || !tombstone || replay.epoch !== request.expectedEpoch ||
          replay.revision !== request.expectedRevision || replay.revision !== tombstone.revision ||
          replay.tombstoneDigest !== tombstone.payloadDigest || replay.purgedAt !== tombstone.purgedAt
        ) {
          return failure("STALE_REVISION", "The idempotent purge result is no longer available.");
        }
        return ok({
          schemaVersion: "1.0.0",
          purged: true,
          epoch: replay.epoch,
          revision: replay.revision,
          tombstoneDigest: replay.tombstoneDigest,
          purgedAt: replay.purgedAt,
        });
      }
      if (purged.kind === "conflict") return failure("REQUEST_CONFLICT", "requestId was already used for a different purge request.");
      if (purged.kind === "stale") return failure("STALE_REVISION", "The direct checkpoint revision changed or no payload exists.", { expectedRevision: request.expectedRevision, actualRevision: purged.actualRevision });
      return ok({ schemaVersion: "1.0.0", purged: true, epoch: request.expectedEpoch, revision: request.expectedRevision, tombstoneDigest, purgedAt: now });
    });
  }

  bindOpenedRoot(value: unknown, rootId: string): boolean {
    try {
      const args = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const token = typeof args._continuityBinding === "string" ? args._continuityBinding : "";
      const binding = this.verifyToolBinding("open_convergence_root", args, token);
      return this.store.bindRoot(binding.c, binding.e, rootId, this.now().toISOString());
    } catch {
      // The committed workflow result is independent; callers must observe missing correlation.
      return false;
    }
  }

  prepareWorkflowStart(rawSessionId: string, rootId: string): void {
    const now = this.now().toISOString();
    const task = this.store.ensureTask(this.correlateSession(rawSessionId), now);
    if ((task.rootId !== null && task.rootId !== rootId)
      || !this.store.bindRoot(task.taskCorrelation, task.currentEpoch, rootId, now, task.rootId)) {
      throw new WorkflowContractError("BINDING_INVALID", "The workflow start conflicts with the current continuity task.");
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
    if (summary.source === "direct") return this.formatCandidate(this.candidateFor(task.taskCorrelation, task.currentEpoch));
    const selected = this.store.readCurrentState(task.taskCorrelation, task.currentEpoch, "workflow",
      (current) => this.workflowProjection(current));
    const card = selected.kind === "available" ? selected.value : null;
    if (!card || task.pendingRootId !== card.rootId) return null;
    if (!this.store.consumeWorkflowMarker(task.taskCorrelation, task.currentEpoch, card.rootId, card.revision, card.snapshotDigest, this.now().toISOString())) return null;
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

  private candidateFor(taskCorrelation: string, expectedEpoch?: number): ContinuityCandidateV1 {
    const task = this.store.getTask(taskCorrelation);
    if (!task || (expectedEpoch !== undefined && task.currentEpoch !== expectedEpoch)) return { schemaVersion: "1.0.0", decision: "REJECT", reasonCodes: ["NO_TASK_BINDING"], summary: null, restoreToken: null };
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
    const selected = this.store.readCurrentState<ContinuitySummaryV1 | null>(
      task.taskCorrelation, task.currentEpoch, "either", (current) => {
        if (current.rootId) {
          const card = this.workflowProjection(current);
          // Projection unavailable never re-authorizes historical direct payload.
          return card ? {
            schemaVersion: "1.0.0", source: "workflow", taskCorrelation: current.taskCorrelation,
            epoch: current.currentEpoch, revision: card.revision, status: card.rootState,
            snapshotDigest: card.snapshotDigest, updatedAt: card.updatedAt,
          } : null;
        }
        const snapshot = this.store.getSnapshot(current.taskCorrelation, current.currentEpoch);
        return snapshot ? {
          schemaVersion: "1.0.0", source: "direct", taskCorrelation: current.taskCorrelation,
          epoch: current.currentEpoch, revision: snapshot.revision, status: snapshot.status,
          snapshotDigest: snapshot.snapshotDigest, updatedAt: snapshot.updatedAt,
        } : null;
      });
    return selected.kind === "available" ? selected.value : null;
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

  private currentReadValue<T>(result: ContinuityCurrentRead<T>): T {
    if (result.kind === "epoch-mismatch") throw new WorkflowContractError("BINDING_INVALID", "Continuity task binding is stale.");
    if (result.kind === "source-conflict") throw new WorkflowContractError("SNAPSHOT_CONFLICT", "The continuity source changed.");
    if (result.kind === "suppressed") throw new WorkflowContractError("SNAPSHOT_NOT_FOUND", "Restore is suppressed for the current epoch.");
    return result.value;
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
      if (error instanceof ContinuityStoreError) return failure("CONTINUITY_UNAVAILABLE", error.message, { reason: error.reason });
      return failure("CONTINUITY_UNAVAILABLE", "Continuity operation failed.", { reason: continuityUnavailableReason(error) });
    }
  }
}

export class UnavailableContinuityService implements ContinuityGateway {
  constructor(private readonly reason: ContinuityUnavailableReason = "STORE_UNAVAILABLE") {}

  private unavailable<T>(): ApiResultV1<T> {
    return failure("CONTINUITY_UNAVAILABLE", "The optional continuity store is unavailable.", { reason: this.reason });
  }
  checkpointContext(): ApiResultV1<ContinuitySnapshotV1> { return this.unavailable(); }
  inspectContext(): ApiResultV1<ContinuityCandidateV1> { return this.unavailable(); }
  loadContext(): ApiResultV1<ContinuitySnapshotV1 | WorkflowContinuityCardV1> { return this.unavailable(); }
  suppressContextRestore(): ApiResultV1<{ schemaVersion: "1.0.0"; suppressed: true; epoch: number }> { return this.unavailable(); }
  purgeDirectContext(): ApiResultV1<ContinuityPurgeResultV1> { return this.unavailable(); }
  bindOpenedRoot(): boolean { return false; }
  // Direct checkpoint access is unavailable too; preserve optional continuity.
  prepareWorkflowStart(): void {}
}
