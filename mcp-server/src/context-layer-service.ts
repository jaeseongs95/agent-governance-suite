import { WorkflowContractError } from "../../contracts/types.js";
import { msg, type MessageRef } from "./i18n.js";
import {
  bodyDigest,
  type ContextApproval,
  type ContextHistoryRecord,
  type ContextLayerKind,
  type ContextLayerRecord,
  ContextLayerStore,
  type RoleBindingRecord,
} from "./context-layer-store.js";

/** User decision (2026-11-07): the global context holds 2000 bytes, a role context 1000 (UTF-8 of the body). */
export const GLOBAL_CONTEXT_MAX_BYTES = 2000;
export const ROLE_CONTEXT_MAX_BYTES = 1000;
export const ROLE_NAME_MAX_LENGTH = 100;

export interface ContextLayerView {
  body: string;
  stateToken: string;
  digest: string;
  bytes: number;
  maxBytes: number;
  updatedAt: string;
  updatedBy: string;
}

export interface SharedContextViewV1 {
  schemaVersion: "1.0.0";
  global: ContextLayerView | null;
  globalMaxBytes: number;
  /** The role this session is bound to, with the user's approval, or null. */
  binding: { role: string; boundAt: string } | null;
  role: ContextLayerView | null;
  roleMaxBytes: number;
}

/** A change the user is asked to approve; the server, not the caller, holds what was shown. */
export type PendingContextChange =
  | { kind: "global"; expectedStateToken: string | null; body: string; digest: string; bytes: number }
  | { kind: "binding"; host: string; sessionId: string; role: string | null; currentRole: string | null };

/** The text a hook adds, as catalog messages (rendered by the hook in the host locale). */
export type ContextLayerText = readonly MessageRef[];

/** NFC, trimmed, one line of at most 100 characters without control characters; null when the name cannot be a key. */
export function normalizeRoleName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFC").trim();
  return name && Array.from(name).length <= ROLE_NAME_MAX_LENGTH && !/\p{Cc}/u.test(name) ? name : null;
}

function invalid(ref: MessageRef, reasonCode: string, details: Record<string, unknown> = {}): WorkflowContractError {
  return new WorkflowContractError("INVALID_INPUT", ref, { reasonCode, ...details });
}

function checkedBody(value: unknown, kind: ContextLayerKind): { body: string; bytes: number } {
  if (typeof value !== "string") throw invalid(msg("continuity.layers.bodyInvalid", {}), "CONTEXT_LAYER_BODY_INVALID");
  const limit = kind === "global" ? GLOBAL_CONTEXT_MAX_BYTES : ROLE_CONTEXT_MAX_BYTES;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > limit) {
    throw invalid(msg("continuity.layers.tooLarge", { layer: kind, bytes, limit }), "CONTEXT_LAYER_TOO_LARGE", { actualBytes: bytes, maxBytes: limit });
  }
  return { body: value, bytes };
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

function view(record: ContextLayerRecord | null): ContextLayerView | null {
  if (!record) return null;
  // A stored body over its limit is an integrity failure (another writer or a damaged file), never shown or injected.
  const maxBytes = record.kind === "global" ? GLOBAL_CONTEXT_MAX_BYTES : ROLE_CONTEXT_MAX_BYTES;
  if (record.bytes > maxBytes || bodyDigest(record.body) !== record.digest) {
    throw new WorkflowContractError("INTEGRITY_FAILED", msg("continuity.layers.integrity", {}), { reasonCode: "CONTEXT_LAYER_INTEGRITY_FAILED", layer: record.kind });
  }
  const { body, stateToken, digest, bytes, updatedAt, updatedBy } = record;
  return { body, stateToken, digest, bytes, maxBytes, updatedAt, updatedBy };
}

/**
 * The shared context policy every entry point uses: MCP tools (after the user's form answer), lifecycle hooks and the
 * local admin page. It never reads natural language: the global context and the role bindings change only with an
 * approval the agent cannot produce, and the role a session may use comes only from the bindings table.
 */
export class ContextLayerService {
  constructor(
    /** Opens the shared store; `create: false` returns null when the file does not exist yet. */
    private readonly openStore: (create: boolean) => ContextLayerStore | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private with<T>(create: boolean, read: (store: ContextLayerStore) => T, absent: T): T {
    const store = this.openStore(create);
    if (!store) return absent;
    try { return read(store); } finally { store.close(); }
  }

  /**
   * The single role access decision: the role the user bound this session to (MCP form or admin page), or null. A
   * subagent's calls and hooks name its root session, so it inherits that session's binding. The session board role is
   * a display line the session writes itself and is never read here.
   */
  roleFor(store: ContextLayerStore, host: string, sessionId: string): RoleBindingRecord | null {
    return store.binding(host, sessionId);
  }

  load(host: string, sessionId: string): SharedContextViewV1 {
    return this.with(false, store => {
      const binding = this.roleFor(store, host, sessionId);
      return { schemaVersion: "1.0.0" as const, global: view(store.read("global")), globalMaxBytes: GLOBAL_CONTEXT_MAX_BYTES,
        binding: binding ? { role: binding.role, boundAt: binding.boundAt } : null,
        role: binding ? view(store.read("role", binding.role)) : null, roleMaxBytes: ROLE_CONTEXT_MAX_BYTES };
    }, { schemaVersion: "1.0.0" as const, global: null, globalMaxBytes: GLOBAL_CONTEXT_MAX_BYTES, binding: null, role: null, roleMaxBytes: ROLE_CONTEXT_MAX_BYTES });
  }

  /** Validates a global save before the user is asked; a stale token is refused without asking. */
  prepareGlobal(expectedStateToken: unknown, body: unknown): PendingContextChange {
    const expected = checkedToken(expectedStateToken);
    const checked = checkedBody(body, "global");
    const current = this.with(false, store => store.read("global")?.stateToken ?? null, null);
    if (current !== expected) throw stale(current);
    return { kind: "global", expectedStateToken: expected, body: checked.body, digest: bodyDigest(checked.body), bytes: checked.bytes };
  }

  /** Validates a bind (role) or unbind (null) of one session before the user is asked. */
  prepareBinding(host: string, sessionId: string, role: unknown): PendingContextChange {
    const name = role === null ? null : normalizeRoleName(role);
    if (role !== null && name === null) throw invalid(msg("continuity.layers.roleInvalid", { limit: ROLE_NAME_MAX_LENGTH }), "ROLE_NAME_INVALID");
    if (!host || !sessionId) throw invalid(msg("continuity.layers.sessionInvalid", {}), "CONTEXT_SESSION_INVALID");
    const currentRole = this.with(false, store => this.roleFor(store, host, sessionId)?.role ?? null, null);
    return { kind: "binding", host, sessionId, role: name, currentRole };
  }

  /** Applies exactly the change the user approved. The global save stays a compare-and-set: a save that landed while
   * the user was deciding makes this one stale, and nothing is written. */
  commit(change: PendingContextChange, actor: string, approval: ContextApproval):
    { kind: "global"; layer: ContextLayerView } | { kind: "binding"; binding: { host: string; sessionId: string; role: string; boundAt: string } | null } {
    const now = this.now().toISOString();
    return this.with(true, store => {
      if (change.kind === "binding") {
        const binding = store.setBinding(change.host, change.sessionId, change.role, approval, now);
        return { kind: "binding" as const, binding: binding ? { host: binding.host, sessionId: binding.sessionId, role: binding.role, boundAt: binding.boundAt } : null };
      }
      const saved = store.save("global", "", change.expectedStateToken, change.body, actor, approval, now);
      if (saved.kind === "stale") throw stale(saved.actualStateToken);
      return { kind: "global" as const, layer: view(saved.layer)! };
    }, null as never);
  }

  /** A session bound to a role rebuilds that role's whole body; any session of the role may, guarded by the token. */
  saveRole(host: string, sessionId: string, expectedStateToken: unknown, body: unknown, actor: string): ContextLayerView {
    const expected = checkedToken(expectedStateToken);
    const checked = checkedBody(body, "role");
    const refused = () => new WorkflowContractError("BINDING_REQUIRED", msg("continuity.layers.roleUnbound", {}), { reasonCode: "ROLE_NOT_BOUND" });
    const saved = this.with(false, store => {
      const binding = this.roleFor(store, host, sessionId);
      if (!binding) throw refused();
      const result = store.save("role", binding.role, expected, checked.body, actor, null, this.now().toISOString());
      if (result.kind === "stale") throw stale(result.actualStateToken);
      return view(result.layer)!;
    }, null);
    if (!saved) throw refused();
    return saved;
  }

  /**
   * The layers a hook adds for one actor. `full`: a context start (session start, resume, compaction, a subagent's
   * start, a host whose turn start is its context start), which gets every non-empty layer. Otherwise only a layer
   * whose state token differs from the one this actor last received. Delivery marks are written only when the shared
   * file already exists; a hook never creates it.
   */
  hookText(host: string, sessionId: string, actorId: string, full: boolean): ContextLayerText | null {
    return this.with(false, store => {
      const global = view(store.read("global"));
      const binding = this.roleFor(store, host, sessionId);
      const role = binding ? view(store.read("role", binding.role)) : null;
      const before = full ? null : store.delivered(actorId);
      const lines: MessageRef[] = [];
      const changed = !full && before !== null;
      if (global && (full || before?.globalToken !== global.stateToken)) {
        // An emptied layer is announced only to an actor that may still hold the earlier body.
        if (global.body) lines.push(msg("hooks.contextLayers.global", { stateToken: global.stateToken, changed: changed ? "yes" : "no", body: global.body }));
        else if (changed) lines.push(msg("hooks.contextLayers.cleared", { layer: "global", role: "" }));
      }
      if (binding && role && (full || before?.role !== binding.role || before?.roleToken !== role.stateToken)) {
        if (role.body) lines.push(msg("hooks.contextLayers.role", { role: binding.role, stateToken: role.stateToken, changed: changed ? "yes" : "no", body: role.body }));
        else if (changed) lines.push(msg("hooks.contextLayers.cleared", { layer: "role", role: binding.role }));
      }
      const delivery = { globalToken: global?.stateToken ?? null, role: binding?.role ?? null, roleToken: role?.stateToken ?? null };
      if (full || before?.globalToken !== delivery.globalToken || before?.role !== delivery.role || before?.roleToken !== delivery.roleToken) {
        store.recordDelivery(actorId, delivery, this.now().toISOString());
      }
      return lines.length > 0 ? lines : null;
    }, null);
  }

  /** Everything the local admin page shows. */
  adminState(): { global: ContextLayerView | null; history: ContextHistoryRecord[]; bindings: RoleBindingRecord[]; roles: Array<ContextLayerView & { role: string }> } {
    return this.with(false, store => ({
      global: view(store.read("global")),
      history: store.history("global"),
      bindings: store.listBindings(),
      roles: store.listRoles().map(record => ({ role: record.name, ...view(record)! })),
    }), { global: null, history: [], bindings: [], roles: [] });
  }
}
