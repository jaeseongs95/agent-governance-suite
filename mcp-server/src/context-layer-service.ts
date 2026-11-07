import { randomUUID } from "node:crypto";

import { WorkflowContractError } from "../../contracts/types.js";
import {
  ADMIN_INTENT_TTL_MS,
  type AdminChange,
  type AdminFailure,
  type AdminLogRecord,
  type AdminState,
  adminRecordHash,
  bindingKey,
  bindingTarget,
  buildIntent,
  changeTarget,
  checkChange,
  checkChangeShape,
  foldAdminLog,
  normalizeRoleName,
  parseIntent,
  ROLE_NAME_MAX_LENGTH,
  roleKey,
  verifyRecord,
} from "./admin-log.js";
import { type AdminAssertion, AdminError, intentChallenge } from "./admin-webauthn.js";
import { msg, type MessageRef } from "./i18n.js";
import {
  type AdminProposalRecord,
  type AdminResetRecord,
  bodyDigest,
  ContextLayerStore,
  RETAIN_MS,
  type RoleContextRecord,
} from "./context-layer-store.js";

export { normalizeRoleName, ROLE_NAME_MAX_LENGTH };

/** User decision (2026-11-07): the global context holds 2000 bytes, a role context 1000 (UTF-8 of the body). */
export const GLOBAL_CONTEXT_MAX_BYTES = 2000;
export const ROLE_CONTEXT_MAX_BYTES = 1000;

export interface GlobalContextView {
  body: string;
  /** The hash of the signed record that set it; a proposal names it as its base. */
  stateToken: string;
  revision: number;
  bytes: number;
  maxBytes: number;
  updatedAt: string;
}

export interface RoleContextView {
  body: string;
  stateToken: string;
  digest: string;
  bytes: number;
  maxBytes: number;
  updatedAt: string;
  updatedBy: string;
}

export interface LayerFailureView {
  /** global, keys, roles or binding (this session's). */
  layer: string;
  /** The revision in use, or null when no valid revision exists and the default applies. */
  revision: number | null;
  code: string;
}

export interface SharedContextViewV1 {
  schemaVersion: "1.0.0";
  global: GlobalContextView | null;
  globalMaxBytes: number;
  /** The role the user bound this session to on the admin page, or null. */
  binding: { roleId: string; role: string; boundAt: string } | null;
  role: RoleContextView | null;
  roleMaxBytes: number;
  /** Signed records that failed verification; the layer runs on its last valid revision. */
  failures: LayerFailureView[];
}

export interface ProposalResult {
  pending: true;
  proposalId: string;
  /** Where the user approves it; null when the page is turned off (AGENT_GOVERNANCE_ADMIN_PORT=0). */
  adminUrl: string | null;
}

/** The text a hook adds, as catalog messages (rendered by the hook in the host locale). */
export type ContextLayerText = readonly MessageRef[];

function invalid(ref: MessageRef, reasonCode: string, details: Record<string, unknown> = {}): WorkflowContractError {
  return new WorkflowContractError("INVALID_INPUT", ref, { reasonCode, ...details });
}

function checkedBody(value: unknown, layer: "global" | "role"): string {
  if (typeof value !== "string") throw invalid(msg("continuity.layers.bodyInvalid", {}), "CONTEXT_LAYER_BODY_INVALID");
  const limit = layer === "global" ? GLOBAL_CONTEXT_MAX_BYTES : ROLE_CONTEXT_MAX_BYTES;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > limit) {
    throw invalid(msg("continuity.layers.tooLarge", { layer, bytes, limit }), "CONTEXT_LAYER_TOO_LARGE", { actualBytes: bytes, maxBytes: limit });
  }
  return value;
}

function checkedToken(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 200) {
    throw invalid(msg("continuity.layers.tokenInvalid", {}), "CONTEXT_LAYER_TOKEN_INVALID");
  }
  return value;
}

function stale(actualStateToken: string | null): WorkflowContractError {
  return new WorkflowContractError("STALE_REVISION", msg("continuity.layers.stateChanged", {}), {
    reasonCode: "CONTEXT_LAYER_STATE_STALE", actualStateToken,
  });
}

function roleView(record: RoleContextRecord | null): RoleContextView | null {
  if (!record) return null;
  // A stored body over its limit or off its digest is an integrity failure (another writer or a damaged file).
  if (record.bytes > ROLE_CONTEXT_MAX_BYTES || bodyDigest(record.body) !== record.digest) {
    throw new WorkflowContractError("INTEGRITY_FAILED", msg("continuity.layers.integrity", {}), { reasonCode: "CONTEXT_LAYER_INTEGRITY_FAILED", layer: "role" });
  }
  const { body, stateToken, digest, bytes, updatedAt, updatedBy } = record;
  return { body, stateToken, digest, bytes, maxBytes: ROLE_CONTEXT_MAX_BYTES, updatedAt, updatedBy };
}

function globalView(state: AdminState): GlobalContextView | null {
  const global = state.global;
  if (!global) return null;
  return { body: global.body, stateToken: global.recordHash, revision: global.seq, bytes: Buffer.byteLength(global.body, "utf8"),
    maxBytes: GLOBAL_CONTEXT_MAX_BYTES, updatedAt: global.issuedAt };
}

function failureLayer(target: string): string {
  return target.startsWith("binding:") ? "binding" : target;
}

/** The failures that change what this session receives: the keys, the global context, the roles and its own binding. */
function sessionFailures(state: AdminState, host: string, sessionId: string): LayerFailureView[] {
  const own = new Set(["keys", "global", "roles", bindingTarget(host, sessionId)]);
  const byTarget = new Map<string, AdminFailure>();
  for (const failure of state.failures) if (own.has(failure.target) && !byTarget.has(failure.target)) byTarget.set(failure.target, failure);
  return [...byTarget.values()].map(failure => ({ layer: failureLayer(failure.target), revision: state.heads.get(failure.target)?.seq ?? null, code: failure.code }));
}

export interface AdminPageState {
  keys: Array<{ credentialId: string; label: string; fingerprint: string; addedAt: string; alg: number; lastUsedAt: string | null }>;
  bootstrap: AdminState["bootstrap"];
  resets: AdminResetRecord[];
  global: GlobalContextView | null;
  globalHistory: Array<{ revision: number; body: string; updatedAt: string; credentialId: string; keyLabel: string | null }>;
  roles: Array<{ roleId: string; name: string; createdAt: string; context: RoleContextView | null; contextError: string | null; bindingCount: number }>;
  bindings: Array<{ host: string; sessionId: string; roleId: string; boundAt: string; lastUsedAt: string; lapsed: boolean }>;
  proposals: Array<AdminProposalRecord & { baseChanged: boolean }>;
  failures: Array<AdminFailure & { layer: string; revision: number | null }>;
  lastSeq: number;
}

/**
 * The shared context policy every entry point uses: MCP tools, lifecycle hooks and the local admin page. What the user
 * decides (the global context, the role registry, the bindings, the passkeys) comes only from the signed admin log;
 * an agent can only ask (a proposal the user signs on the page). The role a session may use comes only from its
 * signed binding, never from the session board's self-written role line.
 */
export class ContextLayerService {
  /** Highest valid sequence seen per target by this long-lived process: a shrinking log is reported. */
  private readonly highWater = new Map<string, number>();
  /** The latest reset this process saw; the reset command (another process) archives the log on purpose. */
  private lastResetId: number | null = null;

  constructor(
    /** Opens the shared store; `create: false` returns null when the file does not exist yet. */
    private readonly openStore: (create: boolean) => ContextLayerStore | null,
    private readonly now: () => Date = () => new Date(),
    readonly adminUrl: string | null = null,
  ) {}

  /** The page address for message text; a turned-off page names the setting that turned it off. */
  private get pageText(): string {
    return this.adminUrl ?? "AGENT_GOVERNANCE_ADMIN_PORT=0";
  }

  private with<T>(create: boolean, read: (store: ContextLayerStore) => T, absent: T): T {
    const store = this.openStore(create);
    if (!store) return absent;
    try { return read(store); } finally { store.close(); }
  }

  /** The verified state; a target whose head went back below what this process saw is reported as rolled back. */
  private fold(store: ContextLayerStore): AdminState {
    const records = store.logRecords();
    const resetId = store.latestResetId();
    if (resetId !== this.lastResetId) {
      this.highWater.clear();
      this.lastResetId = resetId;
    }
    const state = foldAdminLog(records);
    for (const [target, seq] of this.highWater) {
      const head = state.heads.get(target)?.seq ?? 0;
      if (head < seq) state.failures.push({ target, seq, code: "ADMIN_LOG_REGRESSED", change: null });
    }
    for (const [target, head] of state.heads) this.highWater.set(target, Math.max(head.seq, this.highWater.get(target) ?? 0));
    return state;
  }

  /**
   * The single role access decision: the binding the user signed for this (root) session, while the session used its
   * context in the last 30 days. A subagent's calls and hooks name its root session, so it inherits that binding.
   */
  private bindingFor(store: ContextLayerStore, state: AdminState, host: string, sessionId: string): { roleId: string; role: string; boundAt: string } | null {
    const binding = state.bindings.get(bindingKey(host, sessionId));
    const role = binding ? state.roles.get(binding.roleId) : undefined;
    if (!binding || !role) return null;
    const lastUsed = Math.max(Date.parse(binding.boundAt), Date.parse(store.sessionSeen(host, sessionId) ?? binding.boundAt));
    if (this.now().getTime() - lastUsed > RETAIN_MS) return null;
    return { roleId: role.roleId, role: role.name, boundAt: binding.boundAt };
  }

  load(host: string, sessionId: string): SharedContextViewV1 {
    return this.with(false, store => {
      const state = this.fold(store);
      const binding = this.bindingFor(store, state, host, sessionId);
      return { schemaVersion: "1.0.0" as const, global: globalView(state), globalMaxBytes: GLOBAL_CONTEXT_MAX_BYTES, binding,
        role: binding ? roleView(store.readRole(binding.roleId)) : null, roleMaxBytes: ROLE_CONTEXT_MAX_BYTES, failures: sessionFailures(state, host, sessionId) };
    }, { schemaVersion: "1.0.0" as const, global: null, globalMaxBytes: GLOBAL_CONTEXT_MAX_BYTES, binding: null, role: null, roleMaxBytes: ROLE_CONTEXT_MAX_BYTES, failures: [] });
  }

  private propose(caller: { host: string; sessionId: string; actor: string }, change: AdminChange, baseHash: string | null): ProposalResult {
    if (!caller.host || !caller.sessionId) throw invalid(msg("continuity.layers.sessionInvalid", {}), "CONTEXT_SESSION_INVALID");
    const id = `prop-${randomUUID()}`;
    this.with(true, store => store.addProposal({ id, target: changeTarget(change), change, baseHash, host: caller.host, sessionId: caller.sessionId,
      actor: caller.actor, createdAt: this.now().toISOString() }), null);
    return { pending: true, proposalId: id, adminUrl: this.adminUrl };
  }

  /** An agent's request to replace the global context; it applies only when the user signs it on the page. */
  proposeGlobal(caller: { host: string; sessionId: string; actor: string }, expectedStateToken: unknown, body: unknown): ProposalResult {
    const expected = checkedToken(expectedStateToken);
    const checked = checkedBody(body, "global");
    const current = this.with(false, store => this.fold(store).global?.recordHash ?? null, null);
    if (current !== expected) throw stale(current);
    return this.propose(caller, { op: "global.set", body: checked }, current);
  }

  /** An agent's request to bind its session to a registered role (or to unbind it with null). */
  proposeBinding(caller: { host: string; sessionId: string; actor: string }, role: unknown): ProposalResult {
    const name = role === null ? null : normalizeRoleName(role);
    if (role !== null && name === null) throw invalid(msg("continuity.layers.roleInvalid", { limit: ROLE_NAME_MAX_LENGTH }), "ROLE_NAME_INVALID");
    const state = this.with(false, store => this.fold(store), null);
    let roleId: string | null = null;
    if (name !== null) {
      const found = state ? [...state.roles.values()].find(candidate => candidate.key === roleKey(name)) : undefined;
      if (!found) throw invalid(msg("continuity.layers.roleNotRegistered", { role: name, adminUrl: this.pageText }), "ROLE_NOT_REGISTERED", { adminUrl: this.adminUrl });
      roleId = found.roleId;
    }
    const target = bindingTarget(caller.host, caller.sessionId);
    return this.propose(caller, { op: "binding.set", host: caller.host, sessionId: caller.sessionId, roleId }, state?.heads.get(target)?.recordHash ?? null);
  }

  /** A session bound to a role rebuilds that role's whole body; any session of the role may, guarded by the token. */
  saveRole(host: string, sessionId: string, expectedStateToken: unknown, body: unknown, actor: string): RoleContextView {
    const expected = checkedToken(expectedStateToken);
    const checked = checkedBody(body, "role");
    const refused = () => new WorkflowContractError("BINDING_REQUIRED", msg("continuity.layers.roleUnbound", { adminUrl: this.pageText }), { reasonCode: "ROLE_NOT_BOUND", adminUrl: this.adminUrl });
    // The binding check and the write share one transaction: a role deleted meanwhile gets no orphan body.
    const saved = this.with(false, store => store.transaction(() => {
      const binding = this.bindingFor(store, this.fold(store), host, sessionId);
      if (!binding) throw refused();
      const result = store.saveRole(binding.roleId, expected, checked, actor, this.now().toISOString());
      if (result.kind === "stale") throw stale(result.actualStateToken);
      return roleView(result.record)!;
    }), null);
    if (!saved) throw refused();
    return saved;
  }

  /**
   * The layers a hook adds for one actor. `full`: a context start (session start, resume, compaction, a subagent's
   * start, a host whose turn start is its context start), which gets every non-empty layer. Otherwise only what changed
   * since this actor last received it. Each layer is read on its own (AGS3-D-0069): one failing layer is announced and
   * the others are still given. A verification failure is announced once per change, with the revision in use.
   */
  hookText(host: string, sessionId: string, actorId: string, full: boolean): ContextLayerText | null {
    return this.with(false, store => {
      const now = this.now().toISOString();
      const lines: MessageRef[] = [];
      let state: AdminState;
      try {
        state = this.fold(store);
      } catch {
        lines.push(msg("hooks.contextLayers.unreadable", { layer: "admin-log" }));
        return lines;
      }
      const before = full ? null : store.delivered(actorId);
      const changed = !full && before !== null;
      const failures = sessionFailures(state, host, sessionId);
      const failureMark = failures.map(failure => `${failure.layer}:${failure.code}:${failure.revision ?? "-"}`).join(",");
      const global = globalView(state);
      const globalToken = `${global?.stateToken ?? ""}#${failureMark}`;
      if (full || before?.globalToken !== globalToken) {
        for (const failure of failures) {
          lines.push(msg("hooks.contextLayers.verifyFailed", { layer: failure.layer, revision: failure.revision === null ? "none" : String(failure.revision),
            code: failure.code, adminUrl: this.pageText }));
        }
        if (global && (full || before?.globalToken?.split("#")[0] !== global.stateToken)) {
          // An emptied layer is announced only to an actor that may still hold the earlier body.
          if (global.body) lines.push(msg("hooks.contextLayers.global", { stateToken: global.stateToken, changed: changed ? "yes" : "no", body: global.body }));
          else if (changed) lines.push(msg("hooks.contextLayers.cleared", { layer: "global", role: "" }));
        } else if (!global && changed && before?.globalToken?.split("#")[0]) {
          lines.push(msg("hooks.contextLayers.cleared", { layer: "global", role: "" }));
        }
      }
      let roleName: string | null = null;
      let roleToken: string | null = null;
      try {
        const binding = this.bindingFor(store, state, host, sessionId);
        const role = binding ? roleView(store.readRole(binding.roleId)) : null;
        roleName = binding?.role ?? null;
        roleToken = role?.stateToken ?? null;
        if (binding && role && (full || before?.role !== binding.role || before?.roleToken !== role.stateToken)) {
          if (role.body) lines.push(msg("hooks.contextLayers.role", { role: binding.role, stateToken: role.stateToken, changed: changed ? "yes" : "no", body: role.body }));
          else if (changed) lines.push(msg("hooks.contextLayers.cleared", { layer: "role", role: binding.role }));
        }
        store.touchSession(host, sessionId, now);
      } catch {
        lines.push(msg("hooks.contextLayers.unreadable", { layer: "role" }));
      }
      const delivery = { globalToken, role: roleName, roleToken };
      if (full || before?.globalToken !== delivery.globalToken || before?.role !== delivery.role || before?.roleToken !== delivery.roleToken) {
        try { store.recordDelivery(actorId, delivery, now); } catch { /* The text is still given; it may repeat next time. */ }
      }
      return lines.length > 0 ? lines : null;
    }, null);
  }

  // --- Admin page ---------------------------------------------------------------------------------------------------

  /** Everything the page shows (viewing needs no passkey). */
  adminState(): AdminPageState {
    return this.with(false, store => {
      const state = this.fold(store);
      const records = store.logRecords();
      const seen = store.allSessionSeen();
      const now = this.now().getTime();
      const bindings = [...state.bindings.values()].map(binding => {
        const lastUsedAt = new Date(Math.max(Date.parse(binding.boundAt), Date.parse(seen.get(bindingKey(binding.host, binding.sessionId)) ?? binding.boundAt))).toISOString();
        return { host: binding.host, sessionId: binding.sessionId, roleId: binding.roleId, boundAt: binding.boundAt, lastUsedAt, lapsed: now - Date.parse(lastUsedAt) > RETAIN_MS };
      });
      const labels = new Map(records.filter(record => record.target === "keys").flatMap(record => {
        try { const change = parseIntent(record.intent).change; return change.op === "key.add" ? [[change.credentialId, change.label] as const] : []; } catch { return []; }
      }));
      const roles = [...state.roles.values()].sort((a, b) => a.name.localeCompare(b.name)).map(role => {
        let context: RoleContextView | null = null;
        let contextError: string | null = null;
        try { context = roleView(store.readRole(role.roleId)); } catch (error) { contextError = error instanceof WorkflowContractError ? String(error.details?.reasonCode) : "UNREADABLE"; }
        return { roleId: role.roleId, name: role.name, createdAt: role.createdAt, context, contextError,
          bindingCount: bindings.filter(binding => binding.roleId === role.roleId && !binding.lapsed).length };
      });
      return {
        keys: [...state.keys.values()].map(key => ({ credentialId: key.credentialId, label: key.label, fingerprint: key.fingerprint, addedAt: key.addedAt, alg: key.alg,
          lastUsedAt: state.keyLastUsed.get(key.credentialId) ?? null })),
        bootstrap: state.bootstrap,
        resets: store.resets(),
        global: globalView(state),
        globalHistory: state.globalHistory.map(item => ({ revision: item.seq, body: item.body, updatedAt: item.issuedAt, credentialId: item.credentialId,
          keyLabel: labels.get(item.credentialId) ?? null })),
        roles,
        bindings,
        proposals: store.pendingProposals().map(proposal => ({ ...proposal, baseChanged: (state.heads.get(proposal.target)?.recordHash ?? null) !== proposal.baseHash })),
        failures: state.failures.map(failure => ({ ...failure, layer: failureLayer(failure.target), revision: state.heads.get(failure.target)?.seq ?? null })),
        lastSeq: state.lastSeq,
      };
    }, { keys: [], bootstrap: null, resets: [], global: null, globalHistory: [], roles: [], bindings: [], proposals: [], failures: [], lastSeq: 0 });
  }

  /**
   * Builds the intent the user's passkey signs. Checked against the current state first, so a change that would be
   * refused is refused before the passkey prompt. `bootstrap` is the first-key registration: refused once any key exists.
   */
  prepareIntent(change: unknown, bootstrap: boolean): { intent: string; challenge: string; allowCredentials: string[] } {
    const now = this.now().toISOString();
    return this.with(true, store => {
      const state = this.fold(store);
      const parsed = parseIntent(buildIntent(checkChangeShape(change), null, now));
      if (bootstrap && state.keys.size > 0) throw new AdminError("ADMIN_ALREADY_BOOTSTRAPPED", { bootstrap: state.bootstrap });
      if (!bootstrap && state.keys.size === 0) throw new AdminError("ADMIN_KEY_NOT_REGISTERED");
      if (parsed.change.op === "global.set" && Buffer.byteLength(parsed.change.body, "utf8") > GLOBAL_CONTEXT_MAX_BYTES) {
        throw new AdminError("ADMIN_CHANGE_INVALID", { reason: "TOO_LARGE", bytes: Buffer.byteLength(parsed.change.body, "utf8"), limit: GLOBAL_CONTEXT_MAX_BYTES });
      }
      const signer = bootstrap && parsed.change.op === "key.add" ? parsed.change.credentialId : [...state.keys.keys()][0]!;
      checkChange(state, parsed.change, signer);
      const head = state.heads.get(parsed.target)?.recordHash ?? null;
      const signed = buildIntent(parsed.change, head, now);
      return { intent: signed, challenge: intentChallenge(signed), allowCredentials: bootstrap ? [signer] : [...state.keys.keys()] };
    }, null as never);
  }

  /**
   * Appends one signed record. The whole check (freshness, chain head, signer, signature, the change's rules) and the
   * append share one BEGIN IMMEDIATE transaction. A repeated request ID returns the record already stored, so a page
   * that lost the response asks again instead of signing twice.
   */
  commit(input: { intent: string; assertion: AdminAssertion; requestId: string; proposalId?: string | null }): { record: AdminLogRecord; duplicate: boolean } {
    const now = this.now();
    const result = this.with(true, store => store.transaction(() => {
      const existing = store.recordByRequest(input.requestId);
      if (existing) return { record: existing, duplicate: true };
      const intent = parseIntent(input.intent);
      const issued = Date.parse(intent.issuedAt);
      if (now.getTime() - issued > ADMIN_INTENT_TTL_MS || issued - now.getTime() > 60_000) throw new AdminError("ADMIN_INTENT_EXPIRED");
      const state = this.fold(store);
      if (intent.target === "keys" && intent.prevTargetHash === null && intent.change.op === "key.add" && state.keys.size > 0) {
        throw new AdminError("ADMIN_ALREADY_BOOTSTRAPPED", { bootstrap: state.bootstrap });
      }
      if (intent.change.op === "global.set" && Buffer.byteLength(intent.change.body, "utf8") > GLOBAL_CONTEXT_MAX_BYTES) {
        throw new AdminError("ADMIN_CHANGE_INVALID", { reason: "TOO_LARGE" });
      }
      const proposal = input.proposalId ? store.proposal(input.proposalId) : null;
      if (input.proposalId && (proposal?.state !== "pending" || proposal.target !== intent.target)) throw new AdminError("ADMIN_PROPOSAL_NOT_FOUND");
      const unsigned = { target: intent.target, intent: input.intent, credentialId: input.assertion.credentialId, authenticatorData: input.assertion.authenticatorData,
        clientDataJSON: input.assertion.clientDataJSON, signature: input.assertion.signature, createdAt: now.toISOString() };
      const record = { ...unsigned, recordHash: adminRecordHash(unsigned) };
      verifyRecord(state, { ...record, seq: state.lastSeq + 1 });
      const appended = store.appendRecord(record, input.requestId);
      if (intent.change.op === "role.delete") store.deleteRoleBody(intent.change.roleId);
      if (proposal) store.decideProposal(proposal.id, "applied", now.toISOString());
      return { record: appended, duplicate: false };
    }), null as never);
    this.highWater.set(result.record.target, Math.max(result.record.seq, this.highWater.get(result.record.target) ?? 0));
    return result;
  }

  recordByRequest(requestId: string): AdminLogRecord | null {
    return this.with(false, store => store.recordByRequest(requestId), null);
  }

  rejectProposal(id: string): void {
    const done = this.with(false, store => store.decideProposal(id, "rejected", this.now().toISOString()), false);
    if (!done) throw new AdminError("ADMIN_PROPOSAL_NOT_FOUND");
  }

  /** The reset command (CLI only) after every key was lost: the log is archived and every signed item is back to its default. */
  reset(): AdminResetRecord {
    return this.with(true, store => {
      const records = store.logRecords();
      const reset = store.resetLog(records.at(-1)?.recordHash ?? null, this.now().toISOString());
      this.highWater.clear();
      return reset;
    }, null as never);
  }
}
