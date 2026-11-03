import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { types } from "node:util";

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
import type { ForkHostParentRead, ForkOriginRead, LineageRead } from "./host-input-adapter.js";
import type { VerifiedCaller } from "./caller-identity.js";
import { failureReason } from "./failure-diagnostics.js";

const CANDIDATE_TOKEN_TTL_SECONDS = 3600;

/** A fork child's selected parent: the exact anchored revision, never "latest". */
interface ForkParent { c: string; e: number; r: number; d: string }

/** The continuity scope of one verified tool call, computed by the server from the caller. */
interface ToolBindingPayload {
  c: string;
  e: number;
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
const FORK_HOST_PARENT_EVENT = "fork-host-parent:";
/** The host defers its host-process read from the fork start to the fork's first tool boundary (Windows). */
const FORK_HOST_DEFERRED_EVENT = "fork-host-deferred";
/** Pinned fork parents followed upward when deciding whether one candidate descends from another. */
const FORK_ANCESTRY_LIMIT = 32;
const LINEAGE_ANCHOR_COUNT = 16;
/** Phase check (design ags30-phase-check 3.2-3.3): a file edit, and the turn-end check that covers it. */
const PHASE_EDIT_EVENT = "phase-edit";
const PHASE_CHECK_EVENT = "phase-check";
/**
 * Workflow enforcement (design ags30-phase-check 7). A window is every observation after the later of the last phase
 * check and the last workflow start. Each distinct product file edited in a window without an active workflow is one
 * phase-file row (turn_hash: the HMAC of the normalized path); each refused edit is one phase-deny row, and a
 * phase-deny after the last workflow start locks edits across phase checks until a workflow starts.
 */
const PHASE_FILE_EVENT = "phase-file";
const PHASE_DENY_EVENT = "phase-deny";
/** success = 1 when a refused edit preceded the start (the "start after deny" rate). */
const PHASE_START_EVENT = "phase-workflow-start";
/** AGS infrastructure failures: the window passes and the next Stop names the cause code once. */
const START_FAILED_PREFIX = "workflow-start-failed:";
const GATE_UNAVAILABLE_PREFIX = "phase-gate-unavailable:";
/**
 * Starting value, not a measured threshold: without an active workflow, the edit that makes this many distinct product
 * files in one window is refused. Tune it from the phase-deny and phase-workflow-start rows.
 */
export const WORKFLOW_FILE_LIMIT = 3;
/** The fixed minimal start every refusal names. */
export const MINIMAL_WORKFLOW_START_EXAMPLE = 'start_workflow {"goal":"<목표>","stages":["minimal-implementation","test-sensitivity-review"],"acceptanceCriteria":["<수용 기준>"]}';
const RUN_TERMINAL_STATES = new Set(["passed", "failed", "blocked"]);

type WorkflowActivity = "active" | "none" | { unavailable: string };

/** A failure's stable code: a workflow contract error keeps its own code and reason, never a generic one. */
export function workflowFailureCode(cause: unknown): string {
  if (cause instanceof WorkflowContractError && !types.isProxy(cause)) {
    const reason = cause.details?.reasonCode ?? cause.details?.reason;
    return typeof reason === "string" && /^[A-Za-z0-9_.:-]{1,80}$/u.test(reason) ? `${cause.code}:${reason}` : cause.code;
  }
  return failureReason(cause).reason ?? "UNEXPECTED_FAILURE";
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
  /** Out-of-scope items are part of the frozen task as much as the included ones (D0054). */
  excludedScope: string[];
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
  /** Evidence references beyond the bounded list, so a cut list never reads as the whole evidence (D0054). */
  evidenceRefsOmitted: number;
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
  checkpointContext(value: unknown, caller: VerifiedCaller): ApiResultV1<ContinuitySnapshotV1>;
  inspectContext(value: unknown, caller: VerifiedCaller): ApiResultV1<ContinuityCandidateV1>;
  loadContext(value: unknown, caller: VerifiedCaller): ApiResultV1<ContinuitySnapshotV1 | WorkflowContinuityCardV1>;
  suppressContextRestore(value: unknown, caller: VerifiedCaller): ApiResultV1<{ schemaVersion: "1.0.0"; suppressed: true; epoch: number }>;
  purgeDirectContext(value: unknown, caller: VerifiedCaller): ApiResultV1<ContinuityPurgeResultV1>;
  bindOpenedRoot(caller: VerifiedCaller, rootId: string): boolean;
  /** Called only with the session identity verified by the MCP ingress. */
  prepareWorkflowStart(rawSessionId: string, rootId: string): void;
  /**
   * Distinct product files edited without a workflow that a start now adopts (design ags30-phase-check 7.5): the current
   * window, or while locked the window that ended in the refusal, which a later phase check does not clear.
   */
  editWindowFileCount(rawSessionId: string): number;
  /** Records an AGS infrastructure failure of a workflow start so the session's current window is not refused. */
  recordWorkflowStartFailure(rawSessionId: string, cause: unknown): void;
  /** Moves a session bound to a finished workflow to a new epoch, as a new prompt would, so a new start can bind. */
  settleFinishedWorkflow(rawSessionId: string): void;
}

function ok<T>(data: T): ApiResultV1<T> {
  return { schemaVersion: "1.0.0", ok: true, data, error: null };
}

function failure(code: ErrorCode, message: string, details: Record<string, unknown> | null = null): ApiResultV1<never> {
  return { schemaVersion: "1.0.0", ok: false, data: null, error: { code, message, details } };
}

/** A stored purge result: the body-free "purged" receipt shape, never a checkpoint or scrubbed request. */
function purgeReceipt(value: unknown): ContinuityPurgeResultV1 | null {
  const receipt = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  return receipt && receipt.purged === true && isBodyFreeRequestReceipt(receipt) ? receipt as unknown as ContinuityPurgeResultV1 : null;
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

const WORKFLOW_CARD_EVIDENCE_LIMIT = 6;

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
    /** Why the hook could not open the workflow store, when it could not; the gate names this code instead of a generic one. */
    private readonly workflowStoreFailure: string | null = null,
  ) {
    this.secret = store.getOrCreateSecret(() => randomBytes(32).toString("base64url"));
  }

  correlateSession(rawSessionId: string): string {
    return `hmac-sha256:${this.hmac(`session\0${rawSessionId}`)}`;
  }

  hashOpaque(kind: "request" | "turn" | "file", value: string): string {
    return `hmac-sha256:${this.hmac(`${kind}\0${value}`)}`;
  }

  ensureSession(rawSessionId: string): ContinuityTaskRecord {
    const now = this.now().toISOString();
    const task = this.store.ensureTask(this.correlateSession(rawSessionId), now);
    const rootId = task.rootId;
    const workflowStore = this.workflowStore;
    if (!rootId || !workflowStore) return task;
    // A workflow store failure inside the continuity transaction stays the workflow's own failure (MCP_UNAVAILABLE with
    // its SQLite code), never a continuity STORE_UNAVAILABLE: a corrupt workflow DB is not a missing continuity store.
    const workflowFailure: { failed: boolean; error?: unknown } = { failed: false };
    const fromWorkflow = <T>(read: () => T): T => {
      try { return read(); } catch (error) { Object.assign(workflowFailure, { failed: true, error }); throw error; }
    };
    try {
      return this.rotateBoundEpoch(task, now, rootId, workflowStore, fromWorkflow);
    } catch (error) {
      throw workflowFailure.failed ? workflowFailure.error : error;
    }
  }

  private rotateBoundEpoch(task: ContinuityTaskRecord, now: string, rootId: string, workflowStore: WorkflowStore,
    fromWorkflow: <T>(read: () => T) => T): ContinuityTaskRecord {
    // Keep workflow writers excluded until the separate continuity CAS commits.
    return workflowStore.withWorkflowTransaction(() => this.store.rotateEpoch(task.taskCorrelation, now, {
      epoch: task.currentEpoch,
      rootId,
      isTerminal: () => {
        const snapshot = fromWorkflow(() => workflowStore.getConvergenceSnapshot(rootId));
        if (!snapshot || snapshot.root.rootId !== rootId || !CONVERGENCE_ROOT_STATE.includes(snapshot.root.state)) return false;
        const terminalRoot = snapshot.root.state === "completed" || snapshot.root.state === "abandoned";
        if (!terminalRoot && snapshot.workflowRunIds.length === 0) return false;
        // A finished run may leave its root open or awaiting review. Every linked
        // run and every consumed lease, including older epochs, must be settled.
        if (!snapshot.workflowRunIds.every(runId => {
          const receipt = fromWorkflow(() => workflowStore.getRun(runId));
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

  /** Continuity scope of a verified call; a child caller works in its root session's task. */
  private toolBinding(caller: VerifiedCaller, toolName: string): ToolBindingPayload {
    const task = this.ensureSession(caller.sessionId);
    const readLineage = toolName === "checkpoint_context" || toolName === "inspect_context" ? caller.readLineage : undefined;
    let read: LineageRead | undefined;
    const lineage = readLineage && (() => read ??= readLineage()); // one transcript read per call
    // A fork's first save is a final pin boundary too, so its own anchors carry a recorded descent (D1 grandchild).
    if (toolName === "checkpoint_context" && lineage) this.pinTaskForkParent(task, lineage, true);
    return {
      c: task.taskCorrelation,
      e: task.currentEpoch,
      ...(toolName === "checkpoint_context" && lineage ? this.anchorsFor(task, lineage) : {}),
      ...(toolName === "inspect_context" ? this.pinnedForkParent(task, lineage) : {}),
    };
  }

  /**
   * The host's SessionStart source=fork is the only relation authority; lineage later picks which parent. A host that
   * records the parent itself (`readForkOrigin`) names it directly, so the parent is pinned here and lineage is unused.
   */
  startFork(rawSessionId: string, readForkOrigin?: () => ForkOriginRead, readForkHostParent?: () => ForkHostParentRead): void {
    const task = this.ensureSession(rawSessionId);
    this.store.recordObservation(task.taskCorrelation, task.currentEpoch, FORK_START_EVENT, null, true, this.now().toISOString());
    // Recorded with the fork start, before the model runs, or deferred to the first tool boundary.
    if (readForkHostParent) this.recordForkHostParent(task, readForkHostParent);
    if (!readForkOrigin || task.rootId || task.suppressed || this.summary(task)
      || this.store.firstObservationEvent(task.taskCorrelation, task.currentEpoch, FORK_PARENT_EVENT)) return;
    const origin = readForkOrigin();
    const selection = "reason" in origin ? { q: origin.reason } : this.originForkParent(origin);
    this.store.recordObservation(task.taskCorrelation, task.currentEpoch, FORK_PARENT_EVENT + JSON.stringify(selection), null, "p" in selection, this.now().toISOString());
  }

  /**
   * The parent's state at the host's fork instant. This start may come well after the fork (Codex fires it at the
   * child's first prompt), so a parent save after that instant is not the fork-time state and is never chosen
   * (review 902e F1b); it is reported as advanced. The comparison reads both times on one machine: the save time was
   * written by the server into the continuity store this hook opens, and the fork instant by the local host. A server
   * that does not share this store leaves no parent save in it, so the pin closes as FORK_PARENT_NOT_FOUND and a remote
   * clock never enters the comparison (review 902e, local/remote deployment).
   */
  private originForkParent(origin: { parentSessionId: string; at: number }): { p: ForkParent } | { q: string } {
    const parent = this.store.getTask(this.correlateSession(origin.parentSessionId));
    if (!parent) return { q: "FORK_PARENT_NOT_FOUND" };
    if (parent.suppressed) return { q: "FORK_PARENT_SUPPRESSED" };
    const summary = this.summary(parent);
    if (!summary || summary.source !== "direct") return { q: "FORK_PARENT_NOT_FOUND" };
    if (!(Date.parse(summary.updatedAt) <= origin.at)) return { q: "FORK_PARENT_ADVANCED" };
    return { p: { c: parent.taskCorrelation, e: parent.currentEpoch, r: summary.revision, d: summary.snapshotDigest } };
  }

  /**
   * Several anchors: the very newest entry may not be among those a fork copies. A fork anchors only entries the host
   * wrote at or after its own fork record; everything older was copied, including the parent's entries written after
   * the parent's last save, which no parent anchor covers (review 902e T1). An entry without a time counts as copied.
   * This does not depend on when the fork's file first becomes readable (M1), only on the entries' own write times.
   */
  private anchorsFor(task: ContinuityTaskRecord, readLineage: () => LineageRead): Pick<ToolBindingPayload, "a"> {
    const read = readLineage();
    if (!("ids" in read)) return {};
    const forkAt = this.store.firstObservation(task.taskCorrelation, task.currentEpoch, FORK_START_EVENT)?.at;
    const since = forkAt === undefined ? null : Date.parse(forkAt);
    const own = since === null ? read.ids : read.ids.filter((_id, index) => read.at[index]! >= since);
    return { a: own.slice(-LINEAGE_ANCHOR_COUNT).map(id => this.lineageAnchor(id)) };
  }

  /**
   * Decides a fork child's parent once, before the model can change its own file: at the first user prompt when the
   * parent is already found there, otherwise (`final`) at the first write-capable or AGS tool boundary, before that
   * tool runs (review 902e r04; the host may not have written the child's transcript yet at the first prompt).
   * Only a recorded fork with no own state is considered; startup, resume and clear never are. A pin is never replaced.
   */
  /**
   * The deferred host-process read of a fork (Windows: no PowerShell at SessionStart, auditor 5970 W-2), made at the
   * fork's first write-capable or AGS tool boundary before that tool runs and before the parent is pinned. The fork
   * fact stays the SessionStart source=fork record; only the read moves. The parent epoch is the one at this read, so
   * a parent cleared in between has no pre-fork save in it and closes as FORK_HOST_PARENT_NOT_FOUND.
   */
  readDeferredForkHostParent(rawSessionId: string, read: () => ForkHostParentRead): void {
    // Every tool boundary of the host passes here; only an open deferral reads the task (and so its receiver state).
    const correlation = this.correlateSession(rawSessionId);
    if (!this.store.hasOpenCurrentEpochEvent(correlation, FORK_HOST_DEFERRED_EVENT, [FORK_HOST_PARENT_EVENT, FORK_PARENT_EVENT])) return;
    const task = this.store.getTask(correlation);
    if (task) this.recordForkHostParent(task, read);
  }

  /** Once per fork epoch with no own state and no pin: a parent as (c, e), a reason (lineage decides), or a deferral. */
  private recordForkHostParent(task: ContinuityTaskRecord, read: () => ForkHostParentRead): void {
    const { taskCorrelation: c, currentEpoch: e } = task;
    if (task.rootId || task.suppressed || this.summary(task) || this.store.firstObservationEvent(c, e, FORK_HOST_PARENT_EVENT)
      || this.store.firstObservationEvent(c, e, FORK_PARENT_EVENT)) return;
    const host = read();
    // Two first boundaries of one fork can run at once (parallel tool calls), each with its own read. Every reader
    // takes the first record by id and never replaces it, so a second row cannot change the parent; checking again
    // after the read keeps the usual case to one row (auditor 5970 F2).
    if (this.store.firstObservationEvent(c, e, FORK_HOST_PARENT_EVENT) || this.store.firstObservationEvent(c, e, FORK_PARENT_EVENT)) return;
    const at = this.now().toISOString();
    if ("deferred" in host) {
      if (!this.store.hasObservation(c, e, FORK_HOST_DEFERRED_EVENT)) this.store.recordObservation(c, e, FORK_HOST_DEFERRED_EVENT, null, false, at);
      return;
    }
    const value = "reason" in host ? { u: host.reason } : { c: this.correlateSession(host.parentSessionId),
      e: this.store.getTask(this.correlateSession(host.parentSessionId))?.currentEpoch ?? null, ...(host.signer ? { s: host.signer } : {}) };
    this.store.recordObservation(c, e, FORK_HOST_PARENT_EVENT + JSON.stringify(value), null, "c" in value, at);
  }

  pinForkParent(rawSessionId: string, readLineage: () => LineageRead, final = true): void {
    const task = this.store.getTask(this.correlateSession(rawSessionId));
    if (task) this.pinTaskForkParent(task, readLineage, final);
  }

  private pinTaskForkParent(task: ContinuityTaskRecord, readLineage: () => LineageRead, final: boolean): void {
    if (task.rootId || task.suppressed || this.summary(task)
      || !this.store.hasObservation(task.taskCorrelation, task.currentEpoch, FORK_START_EVENT)
      || this.store.firstObservationEvent(task.taskCorrelation, task.currentEpoch, FORK_PARENT_EVENT)) return;
    if (this.store.hasObservation(task.taskCorrelation, task.currentEpoch, FORK_HOST_DEFERRED_EVENT)
      && !this.store.firstObservationEvent(task.taskCorrelation, task.currentEpoch, FORK_HOST_PARENT_EVENT)) {
      // A deferred host read not made yet: lineage alone must not pin before it. At a final boundary that offered no
      // read the reason is recorded and lineage decides, as for any other host-read reason.
      if (!final) return;
      this.store.recordObservation(task.taskCorrelation, task.currentEpoch,
        FORK_HOST_PARENT_EVENT + JSON.stringify({ u: "FORK_HOST_PARENT_NOT_READ" }), null, false, this.now().toISOString());
    }
    const selection = this.selectForkParent(task, readLineage);
    if (!final && !("p" in selection)) return;
    this.store.recordObservation(task.taskCorrelation, task.currentEpoch, FORK_PARENT_EVENT + JSON.stringify(selection), null, "p" in selection, this.now().toISOString());
  }

  /**
   * Only anchors saved before the child's fork record count, so a parent (or sibling) save after the fork cannot be
   * chosen. An entry belongs to the first session that anchored it: a fork's own save repeats the entries it copied,
   * and those copies never count for it (review 902e: a sibling holding 15 copied anchors outscored the parent's 14).
   * The (parent, revision) with the most and then the fewest absent of its anchors is chosen, then the later revision
   * of the same parent; a tie between different parents is ambiguous. D1 (grandchild): a candidate whose recorded fork
   * pins descend from the chosen one and whose own anchor appears later in the child's file is the nearer parent.
   * Without that recorded descent a later anchor never wins (review 902e N1x: an unrelated session that wrote another
   * session's entries into its own file and saved them would otherwise take the fork).
   * When the host process named the parent at the fork start (D0352 N1z), only that parent's saves are candidates and
   * lineage picks only which of its pre-fork revisions the child holds; no other session's anchors count, so entries
   * any session wrote into any file can no longer move the fork elsewhere (review 902e 617f9c95). That revision is the
   * one whose anchor appears latest in the child's file, then the later revision: a parent revision may anchor entries
   * another session wrote into the parent's file, which the child never copied, so absent anchors do not rank it
   * (tester c613 k2argv1-r04: rank by matched count chose rev 1 and inspect then saw the parent advanced).
   */
  private selectForkParent(task: ContinuityTaskRecord, readLineage: () => LineageRead): { p: ForkParent } | { q: string } {
    const read = readLineage();
    if (!("ids" in read)) return { q: read.reason };
    const forkAt = this.store.firstObservation(task.taskCorrelation, task.currentEpoch, FORK_START_EVENT)?.id;
    if (forkAt === undefined) return { q: "FORK_PARENT_NOT_FOUND" };
    const named = this.forkHostParent(task);
    const positions = new Map<string, number>();
    read.ids.forEach((id, index) => positions.set(this.lineageAnchor(id), index));
    const scores = new Map<string, { parent: ForkParent; matched: number; absent: number; last: number }>();
    const owners = new Map<string, string>();
    for (const { anchor, parent } of this.store.lineageAnchorRows(task.taskCorrelation, forkAt)) {
      const owner = JSON.stringify([parent.c, parent.e]);
      if (named ? parent.c !== named.c || parent.e !== named.e : (owners.get(anchor) ?? owner) !== owner) continue;
      owners.set(anchor, owner);
      const key = JSON.stringify([parent.c, parent.e, parent.r, parent.d]);
      const score = scores.get(key) ?? { parent, matched: 0, absent: 0, last: -1 };
      const position = positions.get(anchor);
      if (position === undefined) score.absent += 1;
      else { score.matched += 1; score.last = Math.max(score.last, position); }
      scores.set(key, score);
    }
    const ranked = [...scores.values()].filter(score => score.matched > 0).sort(named
      ? (left, right) => right.last - left.last || right.parent.r - left.parent.r
      : (left, right) => right.matched - left.matched
        || left.absent - right.absent
        || (left.parent.c === right.parent.c && left.parent.e === right.parent.e ? right.parent.r - left.parent.r : 0));
    const [best, next] = ranked;
    // A named parent with no pre-fork save in this lineage (including one that had no task at the fork, e = null).
    if (!best) return { q: named ? "FORK_HOST_PARENT_NOT_FOUND" : "FORK_PARENT_NOT_FOUND" };
    if (named) return { p: best.parent };
    if (next && next.matched === best.matched && next.absent === best.absent
      && (next.parent.c !== best.parent.c || next.parent.e !== best.parent.e)) {
      return { q: "FORK_PARENT_AMBIGUOUS" };
    }
    let chosen = best;
    for (;;) {
      const above = JSON.stringify([chosen.parent.c, chosen.parent.e]);
      const nearer = ranked.filter(score => score.last > chosen.last && this.pinnedAncestors(score.parent.c, score.parent.e).has(above))
        .sort((left, right) => right.last - left.last)[0];
      if (!nearer) return { p: chosen.parent };
      chosen = nearer;
    }
  }

  /** The parent the host process named at this fork's start, or null when it named none (lineage alone decides). */
  private forkHostParent(task: ContinuityTaskRecord): { c: string; e: number | null } | null {
    const event = this.store.firstObservationEvent(task.taskCorrelation, task.currentEpoch, FORK_HOST_PARENT_EVENT);
    if (!event) return null;
    let value: { c?: unknown; e?: unknown };
    try { value = JSON.parse(event.slice(FORK_HOST_PARENT_EVENT.length)) as typeof value; } catch { return null; }
    if (typeof value?.c !== "string") return null;
    return { c: value.c, e: Number.isInteger(value.e) ? value.e as number : null };
  }

  /** The (c, e) of every recorded fork pin above this task epoch, following each pinned parent upward. */
  private pinnedAncestors(c: string, e: number): Set<string> {
    const seen = new Set<string>();
    for (let depth = 0; depth < FORK_ANCESTRY_LIMIT; depth += 1) {
      const event = this.store.firstObservationEvent(c, e, FORK_PARENT_EVENT);
      if (!event) break;
      let parent: Partial<ForkParent> | undefined;
      try { parent = (JSON.parse(event.slice(FORK_PARENT_EVENT.length)) as { p?: Partial<ForkParent> }).p; } catch { break; }
      if (!parent || typeof parent.c !== "string" || !Number.isInteger(parent.e)) break;
      const key = JSON.stringify([parent.c, parent.e]);
      if (seen.has(key)) break;
      seen.add(key);
      c = parent.c;
      e = parent.e!;
    }
    return seen;
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
    const anchors = this.anchorsFor(task, readLineage).a;
    if (anchors?.length) this.store.reanchorSnapshot(task.taskCorrelation, task.currentEpoch, snapshot.revision, snapshot.snapshotDigest, anchors, this.now().toISOString());
  }

  private lineageAnchor(entryId: string): string {
    return `hmac-sha256:${this.hmac(`lineage\0${entryId}`)}`;
  }

  checkpointContext(value: unknown, caller: VerifiedCaller): ApiResultV1<ContinuitySnapshotV1> {
    return this.guard(() => {
      const request = this.validator!.checkpointContextRequest(value);
      const binding = this.toolBinding(caller, "checkpoint_context");
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
      const commandDigest = convergenceDigest(request as unknown as Record<string, unknown>);
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

  inspectContext(value: unknown, caller: VerifiedCaller): ApiResultV1<ContinuityCandidateV1> {
    return this.guard(() => {
      this.validator!.inspectContextRequest(value);
      const binding = this.toolBinding(caller, "inspect_context");
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

  loadContext(value: unknown, caller: VerifiedCaller): ApiResultV1<ContinuitySnapshotV1 | WorkflowContinuityCardV1> {
    return this.guard<ContinuitySnapshotV1 | WorkflowContinuityCardV1>(() => {
      const request = this.validator!.loadContextRequest(value);
      const binding = this.toolBinding(caller, "load_context");
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

  suppressContextRestore(value: unknown, caller: VerifiedCaller): ApiResultV1<{ schemaVersion: "1.0.0"; suppressed: true; epoch: number }> {
    return this.guard(() => {
      const request = this.validator!.suppressContextRestoreRequest(value);
      const binding = this.toolBinding(caller, "suppress_context_restore");
      if (request.expectedEpoch !== binding.e) throw new WorkflowContractError("STALE_REVISION", "The continuity epoch changed.", { actualEpoch: binding.e });
      if (!this.store.setSuppressed(binding.c, binding.e, this.now().toISOString())) throw new WorkflowContractError("STALE_REVISION", "The continuity epoch changed.");
      return ok({ schemaVersion: "1.0.0", suppressed: true, epoch: binding.e });
    });
  }

  purgeDirectContext(value: unknown, caller: VerifiedCaller): ApiResultV1<ContinuityPurgeResultV1> {
    return this.guard(() => {
      const request = this.validator!.purgeDirectContextRequest(value);
      const binding = this.toolBinding(caller, "purge_direct_context");
      this.currentTask(binding);
      const current = this.store.getSnapshot(binding.c, request.expectedEpoch);
      if (current && current.revision !== request.expectedRevision) {
        return failure("STALE_REVISION", "The direct checkpoint revision changed.", {
          expectedRevision: request.expectedRevision,
          actualRevision: current.revision,
        });
      }
      const requestHash = this.hashOpaque("request", request.requestId);
      const commandDigest = convergenceDigest(request as unknown as Record<string, unknown>);
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

  bindOpenedRoot(caller: VerifiedCaller, rootId: string): boolean {
    try {
      const binding = this.toolBinding(caller, "open_convergence_root");
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
    const { taskCorrelation: c, currentEpoch: e } = task;
    // A start ends the window and its lock; success marks a start that followed a refused edit.
    this.store.recordObservation(c, e, PHASE_START_EVENT, null, this.locked(c, e), now);
  }

  editWindowFileCount(rawSessionId: string): number {
    const task = this.store.getTask(this.correlateSession(rawSessionId));
    if (!task) return 0;
    const { taskCorrelation: c, currentEpoch: e } = task;
    let from = this.windowStart(c, e);
    if (this.locked(c, e)) {
      // The lock began at the first refusal after the last start; nothing was counted after it.
      const lastStart = this.store.lastObservationId(c, e, PHASE_START_EVENT) ?? 0;
      const firstDeny = this.store.firstObservationIdAfter(c, e, PHASE_DENY_EVENT, lastStart) ?? 0;
      from = Math.max(this.store.lastObservationId(c, e, PHASE_CHECK_EVENT, firstDeny) ?? 0, lastStart);
    }
    return new Set(this.store.observationHashesAfter(c, e, PHASE_FILE_EVENT, from)).size;
  }

  recordWorkflowStartFailure(rawSessionId: string, cause: unknown): void {
    const now = this.now().toISOString();
    const { taskCorrelation: c, currentEpoch: e } = this.store.ensureTask(this.correlateSession(rawSessionId), now);
    this.store.recordObservation(c, e, START_FAILED_PREFIX + workflowFailureCode(cause), null, false, now);
  }

  settleFinishedWorkflow(rawSessionId: string): void {
    this.ensureSession(rawSessionId);
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

  /** Ask while the model still has the correction; metadata alone cannot manufacture a checkpoint. */
  checkpointCueForSession(rawSessionId: string, missingOnly = false): string | null {
    return this.checkpointCue(this.ensureSession(rawSessionId), missingOnly);
  }

  private checkpointCue(task: ContinuityTaskRecord, missingOnly = false): string | null {
    const selected = this.store.readCurrentState(task.taskCorrelation, task.currentEpoch, "direct", (current) => {
      if (this.store.getTombstone(current.taskCorrelation, current.currentEpoch)) return null;
      const snapshot = this.store.getSnapshot(current.taskCorrelation, current.currentEpoch);
      if (missingOnly && snapshot) return null;
      return [
        "[Task continuity checkpoint check]",
        missingOnly ? "사전 저장본 없음: 이 알림은 압축으로 유실된 내용을 복원하지 않는다." : `현재 작업의 저장본: ${snapshot ? "있음" : "없음"}.`,
        "현재 요청의 교정·제약·결정·남은 작업을 잃으면 다음 행동이 달라지는지 확인하라. 달라진 상태가 아직 저장되지 않았다면 그 판단·작업을 이어가기 전에 context-continuity 스킬과 기존 checkpoint_context로 필요한 상태와 근거 참조만 저장하라.",
        "재개·fork·인계는 inspect_context와 정확한 후보의 load_context를 먼저 수행하고 최신 요청과 대조하라. 없는 이전 정보는 추측하지 말고 현재 실제 전달된 문맥만 사용하라. workflow 원장을 직접 스냅샷으로 복제하지 마라.",
        "이 알림은 저장·복원 성공이 아니다. 실제 응답을 확인하고 실패·미저장 상태를 구분하라. 보존할 변경이 없으면 추가 저장하지 말고 작업을 계속하라.",
      ].join("\n");
    });
    return selected.kind === "available" ? selected.value : null;
  }

  compactContext(rawSessionId: string): string | null {
    const task = this.ensureSession(rawSessionId);
    if (task.suppressed) return null;
    const summary = this.summary(task);
    if (!summary) return this.checkpointCue(task, true);
    if (task.pendingConsumed || task.pendingRevision !== summary.revision || task.pendingDigest !== summary.snapshotDigest || task.pendingSource !== summary.source) return null;
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

  /** A file edit since the last phase check; one row covers every edit until the next check. */
  recordEditForSession(rawSessionId: string): void {
    const now = this.now().toISOString();
    // ensureTask, not ensureSession: an edit boundary never rotates a bound epoch.
    const { taskCorrelation: c, currentEpoch: e } = this.store.ensureTask(this.correlateSession(rawSessionId), now);
    this.recordEdit(c, e, now);
  }

  private recordEdit(c: string, e: number, now: string): void {
    const edit = this.store.lastObservationId(c, e, PHASE_EDIT_EVENT);
    if (edit !== null && edit > (this.store.lastObservationId(c, e, PHASE_CHECK_EVENT) ?? 0)) return;
    this.store.recordObservation(c, e, PHASE_EDIT_EVENT, null, true, now);
  }

  private windowStart(c: string, e: number): number {
    return Math.max(this.store.lastObservationId(c, e, PHASE_CHECK_EVENT) ?? 0, this.store.lastObservationId(c, e, PHASE_START_EVENT) ?? 0);
  }

  /** A refusal after the last workflow start: a phase check does not lift it, a workflow start does. */
  private locked(c: string, e: number): boolean {
    return (this.store.lastObservationId(c, e, PHASE_DENY_EVENT) ?? 0) > (this.store.lastObservationId(c, e, PHASE_START_EVENT) ?? 0);
  }

  /**
   * Before a product file edit (design ags30-phase-check 7.2): `targets` are the normalized, non-exempt paths the tool
   * will change. Returns the refusal reason, or null to let the edit run. Without an active workflow the edit that makes
   * WORKFLOW_FILE_LIMIT distinct files in the window is refused and locks the window; files already counted stay
   * editable until then. An AGS infrastructure failure never refuses: it is recorded and named once at the next Stop.
   */
  gateEditForSession(rawSessionId: string, targets: readonly string[], shown: readonly string[] = targets): string | null {
    const now = this.now().toISOString();
    const task = this.store.ensureTask(this.correlateSession(rawSessionId), now);
    const { taskCorrelation: c, currentEpoch: e } = task;
    this.recordEdit(c, e, now);
    const activity = this.workflowActivity(task);
    if (activity === "active") return null;
    const windowStart = this.windowStart(c, e);
    if (activity !== "none") {
      const event = GATE_UNAVAILABLE_PREFIX + activity.unavailable;
      if (this.store.observationEventsAfter(c, e, event, windowStart).length === 0) this.store.recordObservation(c, e, event, null, false, now);
      return null;
    }
    if (this.store.observationEventsAfter(c, e, START_FAILED_PREFIX, windowStart).length > 0) return null;
    const counted = new Set(this.store.observationHashesAfter(c, e, PHASE_FILE_EVENT, windowStart));
    const fresh = [...new Set(targets.map(target => this.hashOpaque("file", target)))].filter(hash => !counted.has(hash));
    if (!this.locked(c, e) && (fresh.length === 0 || counted.size + fresh.length < WORKFLOW_FILE_LIMIT)) {
      for (const hash of fresh) this.store.recordObservation(c, e, PHASE_FILE_EVENT, hash, true, now);
      return null;
    }
    this.store.recordObservation(c, e, PHASE_DENY_EVENT, null, false, now);
    const earlier = counted.size > 0 ? ` (앞서 바꾼 제품 파일 ${counted.size}개 포함)` : "";
    return `[AGS] workflow 없이 제품 파일 ${WORKFLOW_FILE_LIMIT}개째 변경: ${shown.join(", ")}${earlier}. `
      + `먼저 workflow를 시작하라(최소 시작 호출 예: ${MINIMAL_WORKFLOW_START_EXAMPLE}).`;
  }

  /** Active workflow: the bound root is open, has a run, and that run is not terminal. */
  private workflowActivity(task: ContinuityTaskRecord): WorkflowActivity {
    if (!task.rootId) return "none";
    if (!this.workflowStore) return { unavailable: this.workflowStoreFailure ?? "WORKFLOW_STORE_UNAVAILABLE" };
    try {
      const snapshot = this.workflowStore.getConvergenceSnapshot(task.rootId);
      if (!snapshot || snapshot.root.state === "completed" || snapshot.root.state === "abandoned") return "none";
      const runId = snapshot.workflowRunIds.at(-1);
      const receipt = runId ? this.workflowStore.getRun(runId) : null;
      return receipt && !RUN_TERMINAL_STATES.has(receipt.state) ? "active" : "none";
    } catch (cause) {
      return { unavailable: workflowFailureCode(cause) };
    }
  }

  /**
   * At turn end, once per edit run (design ags30-phase-check 7.4): the stages of the active run that have not passed,
   * and the AGS infrastructure failures that let this window pass. A window with no active run and no failure gives
   * no output. `quiet` records the check without output (a turn the host already continued).
   */
  phaseCheckForSession(rawSessionId: string, quiet = false): string | null {
    const task = this.store.getTask(this.correlateSession(rawSessionId));
    if (!task) return null;
    const { taskCorrelation: c, currentEpoch: e } = task;
    const lastCheck = this.store.lastObservationId(c, e, PHASE_CHECK_EVENT) ?? 0;
    const edit = this.store.lastObservationId(c, e, PHASE_EDIT_EVENT);
    const failures = [START_FAILED_PREFIX, GATE_UNAVAILABLE_PREFIX]
      .flatMap(prefix => this.store.observationEventsAfter(c, e, prefix, lastCheck));
    if ((edit === null || edit < lastCheck) && failures.length === 0) return null;
    const activity = this.workflowActivity(task);
    if (typeof activity === "object") failures.push(GATE_UNAVAILABLE_PREFIX + activity.unavailable);
    const pending = activity === "active" ? this.pendingStages(task) : { stages: [], goal: "" };
    this.store.recordObservation(c, e, PHASE_CHECK_EVENT, null, pending.stages.length === 0 && failures.length === 0, this.now().toISOString());
    const lines: string[] = [];
    if (failures.length > 0) {
      lines.push(`[AGS] workflow 상태를 확인하지 못해 이번 구간의 제품 파일 변경을 막지 않았다. 원인 코드: ${[...new Set(failures)].join(", ")}.`);
    }
    if (pending.stages.length > 0) {
      // Codex and agy continue the turn with this text as its only instruction (continuity-hook stopOutput, agy runner).
      // It names the workflow's goal: told only "the user's remaining work", Codex took its last request (one file of two)
      // as the whole task and stopped (3.1.1 real-host run).
      lines.push(`[AGS 단계 확인] 진행 중인 workflow에 아직 passed가 아닌 단계가 있다: ${pending.stages.join(", ")}.`,
        `workflow 목표: ${pending.goal}`,
        "이 목표가 아직 이뤄지지 않았으면 멈추지 말고 남은 작업을 이어서 하라. 방금 받은 요청을 끝냈어도 목표가 남았으면 이어서 한다. 단계 결과는 그 단계의 작업과 검증을 실제로 마친 뒤에만 기록하고, 기록만 하고 끝내지 마라.",
        "사용자의 답이나 승인이 있어야 진행할 수 있으면 무엇을 기다리는지 한 줄로 쓰고 끝내라. 필요 없는 단계는 계획을 고쳐 뺀다.");
    }
    return quiet || lines.length === 0 ? null : lines.join("\n");
  }

  private pendingStages(task: ContinuityTaskRecord): { stages: string[]; goal: string } {
    const snapshot = task.rootId ? this.workflowStore?.getConvergenceSnapshot(task.rootId) : null;
    const runId = snapshot?.workflowRunIds.at(-1);
    const receipt = runId ? this.workflowStore?.getRun(runId) : null;
    if (!snapshot || !receipt) return { stages: [], goal: "" };
    // Same pass test as the finalize gate (workflow-service finalize).
    const stages = receipt.plan.stages
      .filter(stage => receipt.stageResults.find(result => result.stageId === stage.stageId)?.state !== "passed")
      .map(stage => stage.stageId);
    return { stages, goal: boundedText(snapshot.root.taskEnvelope.objective.replace(/\s+/gu, " ").trim(), 300) };
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
    // The card's verified flag is what the server itself hashed, never the provider's declaration.
    const evidence = (receipt?.stageResults ?? []).flatMap((result) => result.output.artifacts.map((artifact) => ({
      ...artifact,
      verified: (result.artifactChecks ?? []).some((check) => check.source === "artifact" && check.check === "sha256-matched"
        && check.artifactId === artifact.artifactId && check.locator === artifact.locator),
    })));
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
      excludedScope: boundedStrings(snapshot.root.taskEnvelope.scope.excluded, 4, 120),
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
      evidenceRefs: evidence.slice(0, WORKFLOW_CARD_EVIDENCE_LIMIT).map((item) => ({
        artifactId: boundedText(item.artifactId, 80),
        locator: boundedText(item.locator, 160),
        digest: item.digest,
        verified: item.verified,
      })),
      evidenceRefsOmitted: Math.max(0, evidence.length - WORKFLOW_CARD_EVIDENCE_LIMIT),
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
      // The public code stays CONTINUITY_UNAVAILABLE; the detail keeps the store's stable reason (D0057).
      const reason = continuityUnavailableReason(error);
      if (error instanceof ContinuityStoreError && !types.isProxy(error)) return failure("CONTINUITY_UNAVAILABLE", error.message, { reason });
      return failure("CONTINUITY_UNAVAILABLE", "Continuity operation failed.", { reason });
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
  editWindowFileCount(): number { return 0; }
  recordWorkflowStartFailure(): void {}
  settleFinishedWorkflow(): void {}
}
