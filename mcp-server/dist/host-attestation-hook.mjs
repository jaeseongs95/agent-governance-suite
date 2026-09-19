#!/usr/bin/env node

// mcp-server/src/host-attestation-hook.ts
import { createHash as createHash2 } from "node:crypto";
import { mkdirSync as mkdirSync2, readFileSync, renameSync, writeFileSync } from "node:fs";
import path4 from "node:path";
import { fileURLToPath } from "node:url";

// mcp-server/src/host-attestation.ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// contracts/types.ts
var REASONING_EFFORT = ["low", "medium", "high", "xhigh", "max", "ultra"];
var WorkflowContractError = class extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "WorkflowContractError";
  }
  code;
  details;
  toBody() {
    return { code: this.code, message: this.message, details: this.details };
  }
};

// mcp-server/src/convergence-logic.ts
import { createHash } from "node:crypto";
import path from "node:path";
function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new WorkflowContractError("INVALID_INPUT", "Convergence input contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record3 = value;
    return `{${Object.keys(record3).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record3[key])}`).join(",")}}`;
  }
  throw new WorkflowContractError("INVALID_INPUT", "Convergence input contains a non-serializable value.");
}
function convergenceDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}
function normalizedScope(value, workspaceLocator) {
  const normalized = path.resolve(workspaceLocator, value).replaceAll("\\", "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function scopeEntryOverlaps(left, leftWorkspace, right, rightWorkspace) {
  const a = normalizedScope(left, leftWorkspace);
  const b = normalizedScope(right, rightWorkspace);
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
function rootsOverlap(left, right) {
  const sameWorkspace = left.frame.workspace.workspaceId === right.frame.workspace.workspaceId || normalizeWorkspaceLocator(left.frame.workspace.locator) === normalizeWorkspaceLocator(right.frame.workspace.locator);
  if (!sameWorkspace) return false;
  return left.taskEnvelope.scope.included.some((leftTarget) => right.taskEnvelope.scope.included.some((rightTarget) => scopeEntryOverlaps(
    leftTarget,
    left.frame.workspace.locator,
    rightTarget,
    right.frame.workspace.locator
  )));
}
function normalizeWorkspaceLocator(locator) {
  const resolved = path.resolve(locator);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// mcp-server/src/host-attestation.ts
var HOST_ATTESTATION_FIELD = "_hostAttestation";
var HOST_ATTESTATION_TOOLS = /* @__PURE__ */ new Set(["plan_workflow", "record_stage_result"]);
var HOST_ATTESTATION_KEY = "host_attestation_key_v1";
var TOKEN_PREFIX = "aghs1";
var TOKEN_TTL_MS = 5 * 60 * 1e3;
var CLAUDE_MODEL_CLASSES = {
  haiku: "lightweight",
  sonnet: "general",
  opus: "deep",
  fable: "frontier"
};
var CLAUDE_MODEL_ID = /^(?:[a-z]{2,6}(?:-[a-z]{2,4})?\.)?(?:anthropic\.)?claude-(?:\d+(?:-\d+)?-)?(haiku|sonnet|opus|fable)(?:[-@:.]|$)/u;
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function nonEmpty(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function modelClassForClaudeModel(model) {
  const family = CLAUDE_MODEL_ID.exec(model)?.[1];
  return family ? CLAUDE_MODEL_CLASSES[family] ?? null : null;
}
function lowerReasoningEffort(left, right) {
  return REASONING_EFFORT.indexOf(left) <= REASONING_EFFORT.indexOf(right) ? left : right;
}
function isReasoningEffort(value) {
  return typeof value === "string" && REASONING_EFFORT.includes(value);
}
function withoutHostAttestation(input) {
  const copy = { ...input };
  delete copy[HOST_ATTESTATION_FIELD];
  return copy;
}
function hostAttestationBinding(tool, input) {
  if (tool === "plan_workflow") {
    const taskId = nonEmpty(record(input.taskEnvelope)?.taskId) ?? nonEmpty(input.taskId);
    return taskId ? { phase: "bootstrap", taskId, runId: null, stageId: null, revision: null } : null;
  }
  if (tool === "record_stage_result") {
    const runId = nonEmpty(input.runId);
    const stageId = nonEmpty(input.stageId);
    const revision = input.expectedRevision;
    if (!runId || !stageId || !Number.isSafeInteger(revision)) return null;
    return { phase: "stage", taskId: null, runId, stageId, revision };
  }
  return null;
}
function signingKey(store) {
  const key = Buffer.from(
    store.getOrCreateSecret(HOST_ATTESTATION_KEY, () => randomBytes(32).toString("base64url")),
    "base64url"
  );
  if (key.length !== 32) throw new WorkflowContractError("INVALID_INPUT", "Stored host attestation key is invalid.");
  return key;
}
function mac(key, body) {
  return createHmac("sha256", key).update(body, "utf8").digest("base64url");
}
function issueHostAttestation(store, observation) {
  if (!HOST_ATTESTATION_TOOLS.has(observation.tool)) return null;
  const input = withoutHostAttestation(observation.input);
  const binding = hostAttestationBinding(observation.tool, input);
  const modelClass = modelClassForClaudeModel(observation.model);
  if (!binding || !modelClass || !isReasoningEffort(observation.reasoningEffort) || !observation.actorId) return null;
  const now = observation.now ?? /* @__PURE__ */ new Date();
  const payload = {
    v: 1,
    host: "claude-code",
    tool: observation.tool,
    inputDigest: convergenceDigest(input),
    ...binding,
    model: observation.model,
    modelClass,
    reasoningEffort: observation.reasoningEffort,
    actorId: observation.actorId,
    observationId: randomBytes(24).toString("base64url"),
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MS).toISOString()
  };
  const body = `${TOKEN_PREFIX}.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  return `${body}.${mac(signingKey(store), body)}`;
}

// mcp-server/src/runtime-config.ts
import { homedir } from "node:os";
import path2 from "node:path";
function resolveWorkflowDatabasePath(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  const configured = environment.AGENT_GOVERNANCE_DB_PATH?.trim();
  if (configured) return path2.resolve(currentWorkingDirectory, configured);
  let stateRoot;
  if (platform === "win32") {
    stateRoot = environment.LOCALAPPDATA?.trim() || path2.join(homeDirectory, "AppData", "Local");
  } else if (platform === "darwin") {
    stateRoot = path2.join(homeDirectory, "Library", "Application Support");
  } else {
    stateRoot = environment.XDG_STATE_HOME?.trim() || path2.join(homeDirectory, ".local", "state");
  }
  return path2.resolve(stateRoot, "agent-governance-suite", "workflows.sqlite3");
}

// mcp-server/src/sqlite-workflow-store.ts
import { chmodSync, mkdirSync } from "node:fs";
import path3 from "node:path";
import { DatabaseSync } from "node:sqlite";

// mcp-server/src/plugin-version.ts
function parseStableVersion(version) {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(version);
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number.parseInt(part, 10));
  return parts.length === 3 && parts.every(Number.isSafeInteger) ? [parts[0], parts[1], parts[2]] : null;
}
function compareStableVersionNumbers(leftVersion, rightVersion) {
  const left = parseStableVersion(leftVersion);
  const right = parseStableVersion(rightVersion);
  if (!left || !right) throw new Error("A plugin version is not strict stable SemVer.");
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

// mcp-server/src/plugin-update-store.ts
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function timestamp(value) {
  if (value === null) return -1;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : -1;
}
function comparison(currentVersion, latestVersion) {
  if (!latestVersion) return "unknown";
  const order = compareStableVersionNumbers(currentVersion, latestVersion);
  return order < 0 ? "update-available" : order > 0 ? "ahead-of-stable" : "up-to-date";
}
function mergePluginUpdateState(existing, incoming) {
  if (!existing) return clone(incoming);
  const incomingSuccessTime = timestamp(incoming.lastSuccessfulCheckAt);
  const existingSuccessTime = timestamp(existing.lastSuccessfulCheckAt);
  const sameTimeVersionIsNotOlder = incoming.latestVersion !== null && (existing.latestVersion === null || compareStableVersionNumbers(incoming.latestVersion, existing.latestVersion) >= 0);
  const incomingSuccessIsNewer = incoming.lastSuccessfulCheckAt !== null && (incomingSuccessTime > existingSuccessTime || incomingSuccessTime === existingSuccessTime && sameTimeVersionIsNotOlder);
  const incomingAttemptIsNewer = timestamp(incoming.lastAttemptAt) >= timestamp(existing.lastAttemptAt);
  const latestVersion = incomingSuccessIsNewer ? incoming.latestVersion : existing.latestVersion;
  return {
    targetId: incoming.targetId,
    currentVersion: incoming.currentVersion,
    latestVersion,
    latestTag: incomingSuccessIsNewer ? incoming.latestTag : existing.latestTag,
    latestCommit: incomingSuccessIsNewer ? incoming.latestCommit : existing.latestCommit,
    etag: incomingSuccessIsNewer ? incoming.etag : existing.etag,
    comparison: comparison(incoming.currentVersion, latestVersion),
    lastAttemptAt: incomingAttemptIsNewer ? incoming.lastAttemptAt : existing.lastAttemptAt,
    lastSuccessfulCheckAt: incomingSuccessIsNewer ? incoming.lastSuccessfulCheckAt : existing.lastSuccessfulCheckAt,
    nextCheckAt: incomingAttemptIsNewer ? incoming.nextCheckAt : existing.nextCheckAt,
    lastNotifiedVersion: existing.lastNotifiedVersion,
    lastNotifiedAt: existing.lastNotifiedAt,
    lastErrorCode: incomingAttemptIsNewer ? incoming.lastErrorCode : existing.lastErrorCode
  };
}

// mcp-server/src/sqlite-workflow-store.ts
var SCHEMA_VERSION = 5;
var SqliteWorkflowStore = class {
  constructor(databasePath) {
    this.databasePath = databasePath;
    if (!databasePath.trim()) {
      throw new WorkflowContractError("INVALID_INPUT", "Workflow database path must not be empty.");
    }
    if (databasePath !== ":memory:") {
      mkdirSync(path3.dirname(path3.resolve(databasePath)), { recursive: true, mode: 448 });
    }
    let openedDatabase = null;
    try {
      openedDatabase = new DatabaseSync(databasePath);
      this.database = openedDatabase;
      this.database.exec("PRAGMA busy_timeout = 5000;");
      this.database.exec("PRAGMA synchronous = FULL;");
      if (databasePath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
      this.initializeSchema();
      if (databasePath !== ":memory:" && process.platform !== "win32") {
        chmodSync(path3.resolve(databasePath), 384);
      }
    } catch (cause) {
      try {
        openedDatabase?.close();
      } catch {
      }
      throw this.storageError("Cannot initialize the workflow database.", cause);
    }
  }
  databasePath;
  database;
  closed = false;
  getOrCreateSecret(name, create) {
    return this.guard("Cannot read or create workflow metadata.", { key: name }, () => this.transaction(() => {
      const existing = this.database.prepare("SELECT value FROM workflow_metadata WHERE key = ?").get(name);
      if (existing) return existing.value;
      const value = create();
      this.database.prepare(`
        INSERT INTO workflow_metadata (key, value, updated_at)
        VALUES (?, ?, ?)
      `).run(name, value, (/* @__PURE__ */ new Date()).toISOString());
      return value;
    }));
  }
  claimExecutionObservation(observationId, expiresAt, consumedAt) {
    return this.guard("Cannot claim the trusted execution observation.", { observationId }, () => this.transaction(() => {
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO execution_observation_claims(observation_id, expires_at, consumed_at)
        VALUES (?, ?, ?)
      `).run(observationId, expiresAt, consumedAt);
      return Number(result.changes) === 1;
    }));
  }
  nextRunSequence() {
    return this.guard("Cannot reserve the next workflow run sequence.", {}, () => this.transaction(() => {
      const row = this.database.prepare("SELECT value FROM workflow_metadata WHERE key = 'run-sequence'").get();
      const valid = !row || /^(0|[1-9][0-9]*)$/.test(row.value);
      const current = row && valid ? Number.parseInt(row.value, 10) : 0;
      if (!valid || !Number.isSafeInteger(current) || current < 0) {
        throw new WorkflowContractError("INVALID_INPUT", "Workflow run sequence is invalid.", { value: row?.value ?? null });
      }
      const next = current + 1;
      if (!Number.isSafeInteger(next)) {
        throw new WorkflowContractError("INVALID_INPUT", "Workflow run sequence is exhausted.", { value: row?.value ?? null });
      }
      this.database.prepare(`
        INSERT INTO workflow_metadata (key, value, updated_at)
        VALUES ('run-sequence', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(String(next), (/* @__PURE__ */ new Date()).toISOString());
      return next;
    }));
  }
  insertRun(receipt) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.guard("Cannot persist the workflow run.", { runId: receipt.runId }, () => this.insertRunRow(receipt, now));
  }
  getRun(runId) {
    return this.guard("Cannot read the workflow run.", { runId }, () => {
      const row = this.database.prepare(`
        SELECT revision, receipt_json
        FROM workflow_runs
        WHERE run_id = ?
      `).get(runId);
      if (!row) return null;
      const receipt = JSON.parse(row.receipt_json);
      if (receipt.runId !== runId || receipt.revision !== row.revision) {
        throw new WorkflowContractError("INVALID_INPUT", "Stored workflow receipt metadata does not match its payload.", {
          runId,
          storedRevision: row.revision,
          receiptRunId: receipt.runId,
          receiptRevision: receipt.revision
        });
      }
      return receipt;
    });
  }
  updateRun(receipt, expectedRevision, convergence) {
    return this.guard("Cannot update the workflow run.", { runId: receipt.runId }, () => this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE workflow_runs
        SET revision = ?, state = ?, receipt_json = ?, updated_at = ?
        WHERE run_id = ? AND revision = ?
      `).run(
        receipt.revision,
        receipt.state,
        JSON.stringify(receipt),
        (/* @__PURE__ */ new Date()).toISOString(),
        receipt.runId,
        expectedRevision
      );
      if (Number(result.changes) !== 1) return false;
      if (!convergence) return true;
      if (!this.casRoot(convergence.root, convergence.expectedRootRevision)) throw new WorkflowContractError("STALE_REVISION", "Convergence root changed while recording the workflow outcome.");
      const attemptUpdate = this.database.prepare(`
        UPDATE convergence_attempts
        SET state = ?, outcome_json = ?, updated_at = ?
        WHERE run_id = ? AND outcome_json IS NULL
      `).run(
        convergence.outcome.state,
        JSON.stringify(convergence.outcome),
        convergence.outcome.recordedAt,
        receipt.runId
      );
      if (Number(attemptUpdate.changes) !== 1) throw new WorkflowContractError("LEASE_CONFLICT", "Guarded attempt outcome was already recorded or is missing.", { runId: receipt.runId });
      return true;
    }));
  }
  insertConvergenceRoot(root) {
    return this.guard("Cannot persist the convergence root.", { rootId: root.rootId }, () => this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT root_json, revision FROM convergence_roots
        WHERE state NOT IN ('completed', 'abandoned')
          AND (workspace_id = ? OR workspace_locator = ?)
      `).all(root.frame.workspace.workspaceId, normalizeWorkspaceLocator(root.frame.workspace.locator));
      for (const row of rows) {
        const existing = JSON.parse(row.root_json);
        if (root.parentRootId === existing.rootId) continue;
        if (rootsOverlap(root, existing)) return existing;
      }
      if (root.parentRootId) {
        const row = this.rootRow(root.parentRootId);
        if (!row) throw new WorkflowContractError("INVALID_INPUT", "Parent convergence root was not found.", { rootId: root.parentRootId });
        const parent = JSON.parse(row.root_json);
        parent.state = "abandoned";
        parent.revision += 1;
        parent.updatedAt = root.createdAt;
        this.casRoot(parent, row.revision);
      }
      this.database.prepare(`
        INSERT INTO convergence_roots (root_id, revision, state, workspace_id, workspace_locator, root_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        root.rootId,
        root.revision,
        root.state,
        root.frame.workspace.workspaceId,
        normalizeWorkspaceLocator(root.frame.workspace.locator),
        JSON.stringify(root),
        root.createdAt,
        root.updatedAt
      );
      this.insertEpoch(root, root.createdAt);
      return null;
    }));
  }
  getConvergenceSnapshot(rootId) {
    return this.guard("Cannot read convergence state.", { rootId }, () => this.transaction(() => {
      const rootRow = this.rootRow(rootId);
      if (!rootRow) return null;
      const leases = this.database.prepare(`SELECT lease_json, proposal_json FROM convergence_leases WHERE root_id = ? ORDER BY epoch, ordinal, issued_at`).all(rootId);
      const outcomes = this.database.prepare(`SELECT outcome_json FROM convergence_attempts WHERE root_id = ? AND outcome_json IS NOT NULL ORDER BY epoch, ordinal`).all(rootId);
      const reviews = this.database.prepare(`SELECT review_json FROM convergence_reviews WHERE root_id = ? ORDER BY reviewed_at, review_id`).all(rootId);
      const links = this.database.prepare(`SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY epoch, ordinal`).all(rootId);
      return {
        root: JSON.parse(rootRow.root_json),
        proposals: leases.map((row) => JSON.parse(row.proposal_json)),
        leases: leases.map((row) => JSON.parse(row.lease_json)),
        outcomes: outcomes.map((row) => JSON.parse(row.outcome_json)),
        reviews: reviews.map((row) => JSON.parse(row.review_json)),
        workflowRunIds: links.map((row) => row.run_id)
      };
    }, "BEGIN;"));
  }
  updateConvergenceRoot(root, expectedRevision, review) {
    return this.guard("Cannot update the convergence root.", { rootId: root.rootId }, () => this.transaction(() => {
      const current = this.rootRow(root.rootId);
      if (!current || current.revision !== expectedRevision) return false;
      const previous = JSON.parse(current.root_json);
      if (!this.casRoot(root, expectedRevision)) return false;
      if (root.currentEpoch !== previous.currentEpoch) this.insertEpoch(root, root.updatedAt);
      if (review) {
        this.database.prepare(`
          INSERT INTO convergence_reviews (review_id, root_id, epoch, review_json, reviewed_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(review.reviewId, review.rootId, review.epoch, JSON.stringify(review), review.reviewedAt);
      }
      return true;
    }));
  }
  insertAttemptLease(root, expectedRevision, proposal, lease) {
    return this.guard("Cannot claim the convergence attempt lease.", { rootId: root.rootId }, () => this.transaction(() => {
      if (!this.casRoot(root, expectedRevision)) return false;
      this.database.prepare(`
        INSERT INTO convergence_leases (
          lease_id, root_id, root_revision, epoch, ordinal, state, lease_json, proposal_json, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        lease.leaseId,
        lease.rootId,
        lease.rootRevision,
        lease.epoch,
        lease.ordinal,
        lease.state,
        JSON.stringify(lease),
        JSON.stringify(proposal),
        lease.issuedAt,
        lease.expiresAt
      );
      return true;
    }), "The convergence database is busy; read status before retrying the lease claim.");
  }
  expireAttemptLease(leaseId) {
    return this.guard("Cannot expire the convergence attempt lease.", { leaseId }, () => this.transaction(() => {
      const row = this.leaseRow(leaseId);
      if (!row) return false;
      const lease = JSON.parse(row.lease_json);
      if (lease.state !== "issued") return false;
      lease.state = "expired";
      const result = this.database.prepare(`
        UPDATE convergence_leases SET state = 'expired', lease_json = ? WHERE lease_id = ? AND state = 'issued'
      `).run(JSON.stringify(lease), leaseId);
      return Number(result.changes) === 1;
    }));
  }
  getAttemptLease(leaseId) {
    return this.guard("Cannot read the convergence attempt lease.", { leaseId }, () => {
      const row = this.leaseRow(leaseId);
      if (!row) return null;
      const lease = JSON.parse(row.lease_json);
      const proposal = JSON.parse(row.proposal_json);
      const rootRow = this.rootRow(lease.rootId);
      if (!rootRow) return null;
      return { root: JSON.parse(rootRow.root_json), proposal, lease };
    });
  }
  insertGuardedRun(receipt, leaseId, expectedRootRevision, consumedAt) {
    return this.guard("Cannot start the guarded workflow run.", { leaseId }, () => this.transaction(() => {
      const leaseRow = this.leaseRow(leaseId);
      if (!leaseRow) return null;
      const lease = JSON.parse(leaseRow.lease_json);
      const proposal = JSON.parse(leaseRow.proposal_json);
      if (lease.state !== "issued" || lease.rootRevision !== expectedRootRevision || Date.parse(lease.expiresAt) <= Date.parse(consumedAt)) return null;
      const rootRow = this.rootRow(lease.rootId);
      if (!rootRow || rootRow.revision !== expectedRootRevision) return null;
      const root = JSON.parse(rootRow.root_json);
      lease.state = "consumed";
      const leaseUpdate = this.database.prepare(`
        UPDATE convergence_leases SET state = 'consumed', lease_json = ?
        WHERE lease_id = ? AND state = 'issued'
      `).run(JSON.stringify(lease), leaseId);
      if (Number(leaseUpdate.changes) !== 1) return null;
      root.revision += 1;
      root.updatedAt = consumedAt;
      if (!this.casRoot(root, expectedRootRevision)) return null;
      this.insertRunRow(receipt, consumedAt);
      this.database.prepare(`
        INSERT INTO convergence_attempts (
          root_id, epoch, ordinal, lease_id, run_id, state, outcome_json, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, ?)
      `).run(root.rootId, lease.epoch, lease.ordinal, lease.leaseId, receipt.runId, consumedAt, consumedAt);
      this.database.prepare(`
        INSERT INTO workflow_attempt_links (run_id, root_id, lease_id, epoch, ordinal)
        VALUES (?, ?, ?, ?, ?)
      `).run(receipt.runId, root.rootId, lease.leaseId, lease.epoch, lease.ordinal);
      return { root, proposal, lease, outcome: null };
    }), "The convergence database is busy or the lease was consumed concurrently.");
  }
  getGuardedRunBinding(runId) {
    return this.guard("Cannot read the guarded workflow binding.", { runId }, () => {
      const link = this.database.prepare(`SELECT root_id, lease_id FROM workflow_attempt_links WHERE run_id = ?`).get(runId);
      if (!link) return null;
      const rootRow = this.rootRow(link.root_id);
      const leaseRow = this.leaseRow(link.lease_id);
      const outcomeRow = this.database.prepare(`SELECT outcome_json FROM convergence_attempts WHERE run_id = ?`).get(runId);
      if (!rootRow || !leaseRow) return null;
      return {
        root: JSON.parse(rootRow.root_json),
        proposal: JSON.parse(leaseRow.proposal_json),
        lease: JSON.parse(leaseRow.lease_json),
        outcome: outcomeRow?.outcome_json ? JSON.parse(outcomeRow.outcome_json) : null
      };
    });
  }
  getPluginUpdateState(targetId) {
    return this.guard("Cannot read plugin update state.", { targetId }, () => this.readPluginUpdateStateRow(targetId));
  }
  putPluginUpdateState(state) {
    this.guard("Cannot persist plugin update state.", { targetId: state.targetId }, () => this.transaction(() => {
      const merged = mergePluginUpdateState(this.readPluginUpdateStateRow(state.targetId), state);
      this.database.prepare(`
      INSERT INTO plugin_update_state (
        target_id, current_version, latest_version, latest_tag, latest_commit, etag,
        comparison, last_attempt_at, last_successful_check_at, next_check_at,
        last_notified_version, last_notified_at, last_error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_id) DO UPDATE SET
        current_version = excluded.current_version,
        latest_version = excluded.latest_version,
        latest_tag = excluded.latest_tag,
        latest_commit = excluded.latest_commit,
        etag = excluded.etag,
        comparison = excluded.comparison,
        last_attempt_at = excluded.last_attempt_at,
        last_successful_check_at = excluded.last_successful_check_at,
        next_check_at = excluded.next_check_at,
        last_notified_version = excluded.last_notified_version,
        last_notified_at = excluded.last_notified_at,
        last_error_code = excluded.last_error_code
      `).run(
        merged.targetId,
        merged.currentVersion,
        merged.latestVersion,
        merged.latestTag,
        merged.latestCommit,
        merged.etag,
        merged.comparison,
        merged.lastAttemptAt,
        merged.lastSuccessfulCheckAt,
        merged.nextCheckAt,
        merged.lastNotifiedVersion,
        merged.lastNotifiedAt,
        merged.lastErrorCode
      );
    }));
  }
  claimPluginUpdateNotice(targetId, latestVersion, notifiedAt) {
    return this.guard("Cannot claim plugin update notice.", { targetId, latestVersion }, () => this.transaction(() => {
      const state = this.readPluginUpdateStateRow(targetId);
      if (!state || state.latestVersion !== latestVersion || state.lastNotifiedVersion !== null && compareStableVersionNumbers(state.lastNotifiedVersion, latestVersion) >= 0) return false;
      const result = this.database.prepare(`
      UPDATE plugin_update_state
      SET last_notified_version = ?, last_notified_at = ?
      WHERE target_id = ?
        AND latest_version = ?
      `).run(latestVersion, notifiedAt, targetId, latestVersion);
      return Number(result.changes) === 1;
    }));
  }
  getSchemaVersion() {
    return this.database.prepare("PRAGMA user_version").get().user_version;
  }
  isConvergenceRootActive(rootId) {
    const row = this.database.prepare(`
      SELECT 1 AS active FROM convergence_roots
      WHERE root_id = ? AND state IN ('open', 'needs-review', 'needs-user')
    `).get(rootId);
    return Boolean(row);
  }
  withInactiveRootGuard(rootIds, operation) {
    return this.transaction(() => {
      const readState = this.database.prepare("SELECT state FROM convergence_roots WHERE root_id = ?");
      for (const rootId of [...new Set(rootIds)].sort()) {
        const row = readState.get(rootId);
        if (row && ["open", "needs-review", "needs-user"].includes(row.state)) {
          throw new WorkflowContractError("STALE_REVISION", "A continuity cleanup root became active after preview.", { rootId });
        }
      }
      return operation();
    });
  }
  previewCleanup(cutoff) {
    const roots = this.database.prepare(`
      SELECT root_id, revision, state, updated_at
      FROM convergence_roots
      WHERE state IN ('completed', 'abandoned') AND updated_at <= ?
      ORDER BY root_id
    `).all(cutoff);
    const linkedRuns = this.database.prepare(`
      SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY run_id
    `);
    const rootCandidates = roots.map((root) => ({
      rootId: root.root_id,
      revision: root.revision,
      state: root.state,
      updatedAt: root.updated_at,
      runIds: linkedRuns.all(root.root_id).map((row) => row.run_id)
    }));
    const runs = this.database.prepare(`
      SELECT run_id, revision, state, updated_at
      FROM workflow_runs
      WHERE state IN ('failed', 'passed', 'blocked')
        AND updated_at <= ?
        AND NOT EXISTS (SELECT 1 FROM workflow_attempt_links links WHERE links.run_id = workflow_runs.run_id)
      ORDER BY run_id
    `).all(cutoff);
    const protectedRow = this.database.prepare(`
      SELECT COUNT(*) AS count FROM convergence_roots
      WHERE state IN ('open', 'needs-review', 'needs-user')
    `).get();
    return {
      roots: rootCandidates,
      standaloneRuns: runs.map((run) => ({
        runId: run.run_id,
        revision: run.revision,
        state: run.state,
        updatedAt: run.updated_at
      })),
      protectedActiveRoots: protectedRow.count
    };
  }
  claimCleanupPlan(planId, planDigest, claimedAt) {
    return this.guard("Cannot claim the state cleanup plan.", { planId }, () => {
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO state_cleanup_claims(plan_id, plan_digest, claimed_at)
        VALUES (?, ?, ?)
      `).run(planId, planDigest, claimedAt);
      return Number(result.changes) === 1;
    });
  }
  backupTo(targetPath) {
    if (this.databasePath === ":memory:") {
      throw new WorkflowContractError("INVALID_INPUT", "An in-memory workflow database cannot be cleaned destructively.");
    }
    this.guard("Cannot create a verified workflow cleanup backup.", { targetPath }, () => {
      this.database.prepare("VACUUM INTO ?").run(targetPath);
      const backup = new DatabaseSync(targetPath, { readOnly: true });
      try {
        const result = backup.prepare("PRAGMA integrity_check").get();
        if (result.integrity_check !== "ok") throw new Error(`integrity_check returned ${result.integrity_check}`);
      } finally {
        backup.close();
      }
    });
  }
  executeCleanup(preview) {
    return this.guard("Cannot execute workflow state cleanup.", {}, () => this.transaction(() => {
      const verifyRoot = this.database.prepare(`
        SELECT state, revision, updated_at FROM convergence_roots WHERE root_id = ?
      `);
      const verifyRun = this.database.prepare(`
        SELECT state, revision, updated_at FROM workflow_runs WHERE run_id = ?
      `);
      for (const root of preview.roots) {
        const row = verifyRoot.get(root.rootId);
        if (!row || row.state !== root.state || row.revision !== root.revision || row.updated_at !== root.updatedAt) {
          throw new WorkflowContractError("STALE_REVISION", "A cleanup root changed after preview.", { rootId: root.rootId });
        }
        const actualRunIds = this.database.prepare(`
          SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY run_id
        `).all(root.rootId).map((item) => item.run_id);
        if (JSON.stringify(actualRunIds) !== JSON.stringify(root.runIds)) {
          throw new WorkflowContractError("STALE_REVISION", "A cleanup root's linked runs changed after preview.", { rootId: root.rootId });
        }
      }
      for (const run of preview.standaloneRuns) {
        const row = verifyRun.get(run.runId);
        if (!row || row.state !== run.state || row.revision !== run.revision || row.updated_at !== run.updatedAt) {
          throw new WorkflowContractError("STALE_REVISION", "A cleanup workflow run changed after preview.", { runId: run.runId });
        }
      }
      const deleteLinks = this.database.prepare("DELETE FROM workflow_attempt_links WHERE root_id = ?");
      const deleteAttempts = this.database.prepare("DELETE FROM convergence_attempts WHERE root_id = ?");
      const deleteReviews = this.database.prepare("DELETE FROM convergence_reviews WHERE root_id = ?");
      const deleteLeases = this.database.prepare("DELETE FROM convergence_leases WHERE root_id = ?");
      const deleteEpochs = this.database.prepare("DELETE FROM convergence_epochs WHERE root_id = ?");
      const deleteRoot = this.database.prepare("DELETE FROM convergence_roots WHERE root_id = ?");
      const deleteRun = this.database.prepare("DELETE FROM workflow_runs WHERE run_id = ?");
      let deletedRuns = 0;
      for (const root of preview.roots) {
        deleteLinks.run(root.rootId);
        deleteAttempts.run(root.rootId);
        deleteReviews.run(root.rootId);
        deleteLeases.run(root.rootId);
        deleteEpochs.run(root.rootId);
        deleteRoot.run(root.rootId);
        for (const runId of root.runIds) {
          deletedRuns += Number(deleteRun.run(runId).changes);
        }
      }
      for (const run of preview.standaloneRuns) deletedRuns += Number(deleteRun.run(run.runId).changes);
      return { roots: preview.roots.length, runs: deletedRuns };
    }));
  }
  close() {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
  initializeSchema() {
    const row = this.database.prepare("PRAGMA user_version").get();
    if (row.user_version > SCHEMA_VERSION) {
      throw new WorkflowContractError("INVALID_INPUT", "Workflow database schema is newer than this server supports.", {
        databasePath: this.databasePath,
        supportedVersion: SCHEMA_VERSION,
        actualVersion: row.user_version
      });
    }
    this.transaction(() => {
      if (row.user_version > 0 && row.user_version < 4) {
        this.database.exec(`
          ALTER TABLE workflow_runs ADD COLUMN state TEXT;
          ALTER TABLE workflow_runs ADD COLUMN created_at TEXT;
          UPDATE workflow_runs
          SET state = COALESCE(json_extract(receipt_json, '$.state'), 'blocked'),
              created_at = updated_at;
        `);
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS workflow_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS workflow_runs (
          run_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          state TEXT NOT NULL CHECK (state IN ('ready', 'running', 'needs-input', 'needs-approval', 'needs-redesign', 'failed', 'passed', 'blocked')),
          receipt_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS workflow_runs_cleanup
          ON workflow_runs(state, updated_at);
        CREATE TABLE IF NOT EXISTS plugin_update_state (
          target_id TEXT PRIMARY KEY,
          current_version TEXT NOT NULL,
          latest_version TEXT,
          latest_tag TEXT,
          latest_commit TEXT,
          etag TEXT,
          comparison TEXT NOT NULL CHECK (comparison IN ('unknown', 'up-to-date', 'update-available', 'ahead-of-stable')),
          last_attempt_at TEXT,
          last_successful_check_at TEXT,
          next_check_at TEXT NOT NULL,
          last_notified_version TEXT,
          last_notified_at TEXT,
          last_error_code TEXT CHECK (
            last_error_code IS NULL
            OR last_error_code IN ('TIMEOUT', 'NETWORK', 'HTTP', 'INVALID_RESPONSE', 'NO_STABLE_TAG')
          )
        ) STRICT;
        CREATE TABLE IF NOT EXISTS convergence_roots (
          root_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          state TEXT NOT NULL CHECK (state IN ('open', 'needs-review', 'needs-user', 'completed', 'abandoned')),
          workspace_id TEXT NOT NULL,
          workspace_locator TEXT NOT NULL,
          root_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS convergence_active_roots_by_workspace
          ON convergence_roots(workspace_id, state);
        CREATE INDEX IF NOT EXISTS convergence_active_roots_by_locator
          ON convergence_roots(workspace_locator, state);
        CREATE TABLE IF NOT EXISTS convergence_epochs (
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          frame_digest TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (root_id, epoch)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS convergence_leases (
          lease_id TEXT PRIMARY KEY,
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          root_revision INTEGER NOT NULL CHECK (root_revision >= 0),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 3),
          state TEXT NOT NULL CHECK (state IN ('issued', 'consumed', 'expired')),
          lease_json TEXT NOT NULL,
          proposal_json TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          UNIQUE (root_id, epoch, ordinal, lease_id)
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS convergence_one_issued_lease
          ON convergence_leases(root_id) WHERE state = 'issued';
        CREATE TABLE IF NOT EXISTS convergence_attempts (
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 3),
          lease_id TEXT NOT NULL UNIQUE REFERENCES convergence_leases(lease_id),
          run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(run_id),
          state TEXT NOT NULL CHECK (state IN ('running', 'passed', 'failed', 'aborted')),
          outcome_json TEXT,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (root_id, epoch, ordinal)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS convergence_reviews (
          review_id TEXT PRIMARY KEY,
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          review_json TEXT NOT NULL,
          reviewed_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS workflow_attempt_links (
          run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id),
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          lease_id TEXT NOT NULL UNIQUE REFERENCES convergence_leases(lease_id),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 3)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS state_cleanup_claims (
          plan_id TEXT PRIMARY KEY,
          plan_digest TEXT NOT NULL,
          claimed_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS execution_observation_claims (
          observation_id TEXT PRIMARY KEY,
          expires_at TEXT NOT NULL,
          consumed_at TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    });
  }
  rootRow(rootId) {
    return this.database.prepare(`SELECT root_json, revision FROM convergence_roots WHERE root_id = ?`).get(rootId);
  }
  leaseRow(leaseId) {
    return this.database.prepare(`SELECT lease_json, proposal_json FROM convergence_leases WHERE lease_id = ?`).get(leaseId);
  }
  /** Writes the root only if it is still at expectedRevision; true when exactly one row changed. */
  casRoot(root, expectedRevision) {
    const result = this.database.prepare(`
      UPDATE convergence_roots SET revision = ?, state = ?, root_json = ?, updated_at = ?
      WHERE root_id = ? AND revision = ?
    `).run(root.revision, root.state, JSON.stringify(root), root.updatedAt, root.rootId, expectedRevision);
    return Number(result.changes) === 1;
  }
  insertEpoch(root, createdAt) {
    this.database.prepare(`
      INSERT INTO convergence_epochs (root_id, epoch, frame_digest, created_at)
      VALUES (?, ?, ?, ?)
    `).run(root.rootId, root.currentEpoch, root.frameDigest, createdAt);
  }
  insertRunRow(receipt, createdAt) {
    this.database.prepare(`
      INSERT INTO workflow_runs (run_id, revision, state, receipt_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(receipt.runId, receipt.revision, receipt.state, JSON.stringify(receipt), createdAt, createdAt);
  }
  readPluginUpdateStateRow(targetId) {
    const row = this.database.prepare(`
      SELECT target_id, current_version, latest_version, latest_tag, latest_commit, etag,
             comparison, last_attempt_at, last_successful_check_at, next_check_at,
             last_notified_version, last_notified_at, last_error_code
      FROM plugin_update_state
      WHERE target_id = ?
    `).get(targetId);
    return row ? {
      targetId: row.target_id,
      currentVersion: row.current_version,
      latestVersion: row.latest_version,
      latestTag: row.latest_tag,
      latestCommit: row.latest_commit,
      etag: row.etag,
      comparison: row.comparison,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessfulCheckAt: row.last_successful_check_at,
      nextCheckAt: row.next_check_at,
      lastNotifiedVersion: row.last_notified_version,
      lastNotifiedAt: row.last_notified_at,
      lastErrorCode: row.last_error_code
    } : null;
  }
  /** Writers take the lock up front with BEGIN IMMEDIATE; snapshot reads pass "BEGIN;". */
  transaction(operation, begin = "BEGIN IMMEDIATE;") {
    this.database.exec(begin);
    try {
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (cause) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
      }
      throw cause;
    }
  }
  /**
   * Keeps contract errors as they are and wraps any other failure as a storage
   * error; with contentionMessage, a busy database or a duplicate issued lease
   * becomes LEASE_CONFLICT instead.
   */
  guard(message, details, operation, contentionMessage) {
    try {
      return operation();
    } catch (cause) {
      if (cause instanceof WorkflowContractError) throw cause;
      if (contentionMessage && this.isLeaseContention(cause)) {
        throw new WorkflowContractError("LEASE_CONFLICT", contentionMessage, details);
      }
      throw this.storageError(message, cause, details);
    }
  }
  isLeaseContention(cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return /database is locked|SQLITE_BUSY|UNIQUE constraint failed: convergence_leases/iu.test(message);
  }
  storageError(message, cause, details = {}) {
    return new WorkflowContractError("INVALID_INPUT", message, {
      ...details,
      databasePath: this.databasePath,
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  }
};

// mcp-server/src/host-attestation-hook.ts
function record2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function text(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function readTextOrNull(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
var digest = (value) => createHash2("sha256").update(value, "utf8").digest("hex").slice(0, 24);
function claudeCodeActorId(sessionId, agentId) {
  return agentId ? `claude-code:session-${digest(sessionId)}:agent-${digest(agentId)}` : `claude-code:session-${digest(sessionId)}`;
}
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
function transcriptCandidates(transcriptPath, sessionId, agentId) {
  const candidates = [transcriptPath];
  if (agentId) {
    candidates.push(path4.join(path4.dirname(transcriptPath), sessionId, "subagents", `agent-${agentId}.jsonl`));
  }
  return [...new Set(candidates)];
}
function findToolUseObservation(transcript, toolUseId, sessionId, agentId) {
  const lines = transcript.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.includes(toolUseId)) continue;
    let entry;
    try {
      entry = record2(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry || entry.type !== "assistant") continue;
    const message = record2(entry.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const issued = content.some((block) => record2(block)?.type === "tool_use" && record2(block)?.id === toolUseId);
    if (!issued) continue;
    if (entry.sessionId !== void 0 && entry.sessionId !== sessionId) return null;
    if (agentId ? entry.agentId !== agentId : entry.isSidechain === true) return null;
    const model = text(message?.model);
    if (!model) return null;
    return { model, effort: text(entry.effort) };
  }
  return null;
}
function findLatestAssistantObservation(transcript, sessionId, agentId, nowMs = Date.now()) {
  const lines = transcript.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.includes('"assistant"')) continue;
    let entry;
    try {
      entry = record2(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry || entry.type !== "assistant") continue;
    if (entry.sessionId !== sessionId) continue;
    if (agentId ? entry.agentId !== agentId : entry.isSidechain === true) continue;
    const at = Date.parse(text(entry.timestamp) ?? "");
    if (Number.isNaN(at) || at > nowMs) continue;
    const model = text(record2(entry.message)?.model);
    if (!model || !modelClassForClaudeModel(model)) continue;
    return { model, at };
  }
  return null;
}
function hasIssuingMessage(transcript, toolUseId) {
  return transcript.split("\n").some((line) => {
    if (!line.includes(toolUseId)) return false;
    try {
      const entry = record2(JSON.parse(line));
      const content = record2(entry?.message)?.content;
      return entry?.type === "assistant" && Array.isArray(content) && content.some((block) => record2(block)?.type === "tool_use" && record2(block)?.id === toolUseId);
    } catch {
      return false;
    }
  });
}
function sessionModelUpdate(input, now = /* @__PURE__ */ new Date()) {
  const sessionId = text(input.session_id);
  if (!sessionId || text(input.agent_id)) return null;
  const source = input.hook_event_name === "SessionStart" ? "session-start" : input.hook_event_name === "PostModelSwitch" ? "model-switch" : null;
  const model = source === "session-start" ? text(input.model) : source === "model-switch" ? text(input.to_model) : null;
  return source && model ? { sessionId, record: { model, source, observedAt: now.toISOString() } } : null;
}
function sessionModelFile(directory, sessionId) {
  return path4.join(directory, `${digest(sessionId)}.json`);
}
function writeSessionModel(directory, sessionId, value) {
  mkdirSync2(directory, { recursive: true });
  const file = sessionModelFile(directory, sessionId);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), "utf8");
  renameSync(temporary, file);
}
function readSessionModel(directory, sessionId) {
  try {
    const value = record2(JSON.parse(readFileSync(sessionModelFile(directory, sessionId), "utf8")));
    const model = text(value?.model);
    const source = value?.source === "session-start" || value?.source === "model-switch" ? value.source : null;
    const observedAt = text(value?.observedAt);
    return model && source && observedAt && !Number.isNaN(Date.parse(observedAt)) ? { model, source, observedAt } : null;
  } catch {
    return null;
  }
}
function attestedToolInput(input) {
  if (input.hook_event_name !== "PreToolUse") return null;
  const canonicalName = text(input.tool_name) ?? "";
  if (!canonicalName.startsWith("mcp__")) return null;
  const tool = canonicalName.split("__").at(-1) ?? "";
  const toolInput = record2(input.tool_input);
  return HOST_ATTESTATION_TOOLS.has(tool) && toolInput ? { tool, toolInput } : null;
}
function withoutCallerAttestation(input) {
  const target = attestedToolInput(input);
  if (!target || !Object.prototype.hasOwnProperty.call(target.toolInput, HOST_ATTESTATION_FIELD)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: withoutHostAttestation(target.toolInput)
    }
  };
}
function observedEffort(hookEffort, messageEffort) {
  const hook = isReasoningEffort(hookEffort) ? hookEffort : null;
  const message = isReasoningEffort(messageEffort) ? messageEffort : null;
  if (hook && message) return lowerReasoningEffort(hook, message);
  return hook ?? message;
}
function handleHostAttestationHook(input, store, options = {}) {
  const target = attestedToolInput(input);
  if (!target) return {};
  const { tool, toolInput } = target;
  const unattested = () => withoutCallerAttestation(input);
  const sessionId = text(input.session_id);
  const toolUseId = text(input.tool_use_id);
  const transcriptPath = text(input.transcript_path);
  if (!sessionId || !toolUseId || !transcriptPath) return unattested();
  const agentId = text(input.agent_id);
  const readText = options.readText ?? readTextOrNull;
  const sleep = options.sleep ?? sleepSync;
  const maxWaitMs = options.maxWaitMs ?? 300;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const candidates = transcriptCandidates(transcriptPath, sessionId, agentId);
  let observation = null;
  for (let waited = 0; ; waited += pollIntervalMs) {
    for (const candidate of candidates) {
      const transcript = readText(candidate);
      observation = transcript ? findToolUseObservation(transcript, toolUseId, sessionId, agentId) : null;
      if (observation) break;
    }
    if (observation || waited >= maxWaitMs) break;
    sleep(pollIntervalMs);
  }
  if (!observation) {
    const transcripts = candidates.map((candidate) => readText(candidate) ?? "");
    if (transcripts.some((transcript) => hasIssuingMessage(transcript, toolUseId))) return unattested();
    const nowMs = (options.now?.() ?? /* @__PURE__ */ new Date()).getTime();
    let latest = null;
    for (const transcript of transcripts) {
      latest = findLatestAssistantObservation(transcript, sessionId, agentId, nowMs);
      if (latest) break;
    }
    const session = agentId ? null : options.readSessionModel?.(sessionId) ?? null;
    const model = session && (!latest || Date.parse(session.observedAt) >= latest.at) ? session.model : latest?.model;
    observation = model ? { model, effort: null } : null;
  }
  if (!observation) return unattested();
  const effort = observedEffort(text(record2(input.effort)?.level), observation.effort);
  if (!effort) return unattested();
  const token = issueHostAttestation(store, {
    tool,
    input: toolInput,
    model: observation.model,
    reasoningEffort: effort,
    actorId: claudeCodeActorId(sessionId, agentId),
    ...options.now ? { now: options.now() } : {}
  });
  if (!token) return unattested();
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...toolInput, [HOST_ATTESTATION_FIELD]: token }
    }
  };
}
async function main() {
  let store = null;
  let input = {};
  let output;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
    const databasePath = resolveWorkflowDatabasePath();
    const modelDirectory = path4.join(path4.dirname(databasePath), "host-models");
    const update = sessionModelUpdate(input);
    if (update) {
      writeSessionModel(modelDirectory, update.sessionId, update.record);
      return;
    }
    store = new SqliteWorkflowStore(databasePath);
    output = handleHostAttestationHook(input, store, { readSessionModel: (sessionId) => readSessionModel(modelDirectory, sessionId) });
  } catch {
    output = withoutCallerAttestation(input);
  } finally {
    try {
      store?.close();
    } catch {
    }
  }
  if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
}
if (path4.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
export {
  claudeCodeActorId,
  findLatestAssistantObservation,
  findToolUseObservation,
  handleHostAttestationHook,
  hasIssuingMessage,
  observedEffort,
  readSessionModel,
  sessionModelUpdate,
  transcriptCandidates,
  withoutCallerAttestation,
  writeSessionModel
};
