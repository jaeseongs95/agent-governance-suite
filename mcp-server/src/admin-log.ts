import path from "node:path";

import {
  ADMIN_RP_ID,
  AdminError,
  type AdminAssertion,
  type AdminErrorCode,
  type AdminPublicKey,
  importAdminKey,
  keyFingerprint,
  sha256,
  verifyAdminAssertion,
} from "./admin-webauthn.js";
import { SUPPORTED_LOCALES } from "./i18n-catalog.generated.js";

/**
 * The signed admin log (AGS3-T-0024, deliberation 2026-11-07): the only source of what the user decided on the admin
 * page — the passkeys, the global context, the role registry and the session-to-role bindings. Each record holds one
 * canonical intent the user's passkey signed. Records chain per target (prevTargetHash), so unrelated targets never
 * contend. Reading folds the whole log in order and keeps, per target, the last state whose chain and signatures are
 * valid; a record that fails is reported and never applied. Nothing here reads a materialized row to decide.
 */
export const ADMIN_DOMAIN = "ags.admin";
export const ADMIN_INTENT_VERSION = 1;
export const ADMIN_INTENT_TTL_MS = 10 * 60_000;
export const ROLE_NAME_MAX_LENGTH = 100;
export const KEY_LABEL_MAX_LENGTH = 60;
export const EDIT_EXEMPT_MAX_PATHS = 50;
const EDIT_EXEMPT_PATH_MAX_LENGTH = 1024;
/** A JEV key name is the credential name an approved route asks for (credentialEnvName in the provider runtime). */
export const JEV_KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
/** The JEV uses (presets) this installation has; each can be turned off on the page. */
export const JEV_PRESETS = [{ presetId: "skill-classification", tool: "classify_skills" }] as const;
export type JevPresetId = (typeof JEV_PRESETS)[number]["presetId"];
/** Targets of the settings the page edits besides the contexts (AGS3-T-0024 completion condition 2). */
export const SETTING_TARGETS = ["jev", "jevKeys", "editExempt"] as const;
/** Targets of settings 4.0.0 removed: their signed records and acks still verify, and change nothing. */
const RETIRED_SETTING_TARGETS: readonly string[] = ["locale"];
/** ADMIN_CHANGE_INVALID reasons (details.reason) of the settings; the page has a sentence for each. */
export const SETTING_CHANGE_REASONS = ["JEV_PRESET_UNKNOWN", "JEV_KEY_NOT_FOUND", "JEV_KEY_FINGERPRINT_MISMATCH", "SECRET_UNEXPECTED",
  "JEV_KEY_VAULT_UNAVAILABLE"] as const;

/**
 * Canonical JSON (sorted keys, no spaces), the same form convergence-logic.ts writes. Kept here so the hook-side
 * readers (edit gate) load the verifier without the workflow modules.
 */
export function canonicalJson(value: unknown, subject = "Admin intent"): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${subject}: non-finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, subject)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key], subject)}`).join(",")}}`;
  }
  throw new TypeError(`${subject}: value cannot be serialized`);
}

export type AdminChange =
  | { op: "key.add"; credentialId: string; publicKey: string; alg: number; label: string }
  | { op: "key.revoke"; credentialId: string }
  | { op: "global.set"; body: string }
  | { op: "role.add"; roleId: string; name: string }
  | { op: "role.rename"; roleId: string; name: string }
  | { op: "role.delete"; roleId: string }
  | { op: "binding.set"; host: string; sessionId: string; roleId: string | null }
  /**
   * JEV on or off, its budget (null: none, no JEV call), each preset's switch, the model (a provider AGS ships and one of
   * its pinned model names; null: none chosen), the consent to send requests to that provider, and the vendor asked when
   * JEV cannot advise (null: none), signed together. A record signed before 4.0.0 has only the first three and folds with
   * no model, no consent and no fallback.
   */
  | { op: "jev.set"; enabled: boolean; limitUsd: number | null; presets: Record<string, boolean>;
    model?: { providerId: string; modelId: string } | null; transmissionAllowed?: boolean; fallbackVendorId?: string | null }
  /** A JEV key: the signed record holds its fingerprint; the encrypted value is stored beside it (jev-key-vault.ts). */
  | { op: "jevKey.set"; name: string; fingerprint: string }
  | { op: "jevKey.delete"; name: string }
  /** The display locale, removed in 4.0.0 (everything renders in MODEL_LOCALE): kept so older signed records verify. */
  | { op: "locale.set"; locale: string | null }
  /** The edit gate's extra exempt directories (absolute paths), replaced as a whole. */
  | { op: "editExempt.set"; paths: string[] }
  /** The user saw the failed records of a target and keeps its current valid state (the page's [discard]). */
  | { op: "ack"; target: string };

export interface AdminIntent {
  v: number;
  domain: string;
  rpId: string;
  target: string;
  prevTargetHash: string | null;
  change: AdminChange;
  issuedAt: string;
}

export interface AdminLogRecord extends AdminAssertion {
  seq: number;
  target: string;
  /** The canonical intent string the passkey signed (its SHA-256 is the challenge). */
  intent: string;
  recordHash: string;
  createdAt: string;
}

export interface AdminKeyState extends AdminPublicKey {
  label: string;
  fingerprint: string;
  addedAt: string;
  addedSeq: number;
}

export interface AdminRoleState {
  roleId: string;
  name: string;
  /** NFC, trimmed, lower-cased: the uniqueness key. */
  key: string;
  createdAt: string;
  seq: number;
}

export interface AdminBindingState {
  host: string;
  sessionId: string;
  roleId: string;
  boundAt: string;
  seq: number;
}

export interface AdminGlobalState {
  body: string;
  seq: number;
  recordHash: string;
  issuedAt: string;
  credentialId: string;
}

export interface AdminSettingRevision {
  seq: number;
  issuedAt: string;
}

export interface AdminJevState extends AdminSettingRevision {
  enabled: boolean;
  limitUsd: number | null;
  presets: Record<string, boolean>;
  model: { providerId: string; modelId: string } | null;
  transmissionAllowed: boolean;
  fallbackVendorId: string | null;
}

export interface AdminJevKeyState extends AdminSettingRevision {
  name: string;
  fingerprint: string;
}

export interface AdminFailure {
  target: string;
  seq: number;
  code: AdminErrorCode;
  /** The change the failed record asks for, when its intent could be read: the page offers to sign it again. */
  change: AdminChange | null;
}

export interface AdminState {
  keys: Map<string, AdminKeyState>;
  revoked: Set<string>;
  /** The first key ever registered (trust on first use); the page always shows when and which. */
  bootstrap: { credentialId: string; fingerprint: string; at: string } | null;
  global: AdminGlobalState | null;
  /** Every valid global revision, newest first (the page's history). */
  globalHistory: AdminGlobalState[];
  roles: Map<string, AdminRoleState>;
  bindings: Map<string, AdminBindingState>;
  /** The settings the page edits; null (or absent) means no valid signed revision: the default or the environment applies. */
  jev: AdminJevState | null;
  jevKeys: Map<string, AdminJevKeyState>;
  editExempt: (AdminSettingRevision & { paths: string[] }) | null;
  heads: Map<string, { recordHash: string; seq: number }>;
  /** When each key last signed a valid record. */
  keyLastUsed: Map<string, string>;
  /** Failed records after the last valid record of their target: the target runs on its last valid state. */
  failures: AdminFailure[];
  lastSeq: number;
}

export function bindingTarget(host: string, sessionId: string): string {
  return `binding:${encodeURIComponent(host)}:${encodeURIComponent(sessionId)}`;
}

export function bindingKey(host: string, sessionId: string): string {
  return `${host}\u0000${sessionId}`;
}

/** NFC, trimmed, one line of at most 100 characters without control characters; null when it cannot be a role name. */
export function normalizeRoleName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFC").trim();
  return name && Array.from(name).length <= ROLE_NAME_MAX_LENGTH && !/\p{Cc}/u.test(name) ? name : null;
}

export function roleKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

/** The hash a record is stored under; any change to its signed parts changes it. */
export function adminRecordHash(record: Pick<AdminLogRecord, "intent" | "credentialId" | "authenticatorData" | "clientDataJSON" | "signature">): string {
  const { intent, credentialId, authenticatorData, clientDataJSON, signature } = record;
  return `sha256:${sha256(canonicalJson({ intent, credentialId, authenticatorData, clientDataJSON, signature }, "Admin record")).toString("hex")}`;
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

const ID = /^[A-Za-z0-9_-]{1,200}$/;

function budget(value: unknown): boolean {
  // The person sets the budget; there is no server cap.
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function presetSwitches(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 20 && entries.every(([id, on]) => /^[a-z0-9-]{1,60}$/u.test(id) && typeof on === "boolean");
}

/** A model choice's shape; whether AGS knows that provider and model is decided where it is used (jev-provider.ts). */
function jevModel(value: unknown): boolean {
  if (value === null) return true;
  const model = value as Record<string, unknown> | null;
  return !!model && typeof model === "object" && !Array.isArray(model) && Object.keys(model).sort().join(",") === "modelId,providerId"
    && typeof model.providerId === "string" && /^[a-z0-9-]{1,60}$/u.test(model.providerId)
    && typeof model.modelId === "string" && /^[A-Za-z0-9._:-]{1,100}$/u.test(model.modelId);
}

const VENDOR_ID = /^[A-Za-z0-9._-]{1,100}$/u;

/** Absolute (on this computer's platform), trimmed, one line, unique; the edit gate reads them as given. */
function exemptPaths(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > EDIT_EXEMPT_MAX_PATHS || new Set(value).size !== value.length) return false;
  return value.every(entry => typeof entry === "string" && entry.length > 0 && entry.length <= EDIT_EXEMPT_PATH_MAX_LENGTH
    && entry.trim() === entry && !/\p{Cc}/u.test(entry) && path.isAbsolute(entry));
}

/** The change's own shape; state-dependent rules are checked in `applyChange`. */
export function checkChangeShape(change: unknown): AdminChange {
  const value = change as Record<string, unknown> | null;
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort().join(",") : "";
  const ok = (() => {
    switch (value?.op) {
      case "key.add": return keys === "alg,credentialId,label,op,publicKey" && typeof value.credentialId === "string" && ID.test(value.credentialId)
        && text(value.publicKey, 4000) && Number.isInteger(value.alg) && typeof value.label === "string" && value.label.length <= KEY_LABEL_MAX_LENGTH;
      case "key.revoke": return keys === "credentialId,op" && typeof value.credentialId === "string" && ID.test(value.credentialId);
      case "global.set": return keys === "body,op" && typeof value.body === "string";
      case "role.add": case "role.rename": return keys === "name,op,roleId" && typeof value.roleId === "string" && ID.test(value.roleId)
        && normalizeRoleName(value.name) === value.name;
      case "role.delete": return keys === "op,roleId" && typeof value.roleId === "string" && ID.test(value.roleId);
      case "binding.set": return keys === "host,op,roleId,sessionId" && text(value.host, 200) && text(value.sessionId, 500)
        && (value.roleId === null || (typeof value.roleId === "string" && ID.test(value.roleId)));
      case "ack": return keys === "op,target" && typeof value.target === "string" && isAdminTarget(value.target);
      case "jev.set": return (keys === "enabled,limitUsd,op,presets" || (keys === "enabled,fallbackVendorId,limitUsd,model,op,presets,transmissionAllowed"
        && jevModel(value.model) && typeof value.transmissionAllowed === "boolean"
        && (value.fallbackVendorId === null || (typeof value.fallbackVendorId === "string" && VENDOR_ID.test(value.fallbackVendorId)))))
        && typeof value.enabled === "boolean" && budget(value.limitUsd) && presetSwitches(value.presets);
      case "jevKey.set": return keys === "fingerprint,name,op" && typeof value.name === "string" && JEV_KEY_NAME.test(value.name)
        && typeof value.fingerprint === "string" && FINGERPRINT.test(value.fingerprint);
      case "jevKey.delete": return keys === "name,op" && typeof value.name === "string" && JEV_KEY_NAME.test(value.name);
      case "locale.set": return keys === "locale,op" && (value.locale === null || (SUPPORTED_LOCALES as readonly unknown[]).includes(value.locale));
      case "editExempt.set": return keys === "op,paths" && exemptPaths(value.paths);
      default: return false;
    }
  })();
  if (!ok) throw new AdminError("ADMIN_CHANGE_INVALID", { op: typeof value?.op === "string" ? value.op.slice(0, 40) : null });
  return value as unknown as AdminChange;
}

/** The target a change belongs to; a record whose intent names another target is refused. */
export function changeTarget(change: AdminChange): string {
  switch (change.op) {
    case "key.add": case "key.revoke": return "keys";
    case "global.set": return "global";
    case "role.add": case "role.rename": case "role.delete": return "roles";
    case "binding.set": return bindingTarget(change.host, change.sessionId);
    case "ack": return change.target;
    case "jev.set": return "jev";
    case "jevKey.set": case "jevKey.delete": return "jevKeys";
    case "locale.set": return "locale";
    case "editExempt.set": return "editExempt";
  }
}

/** keys, global, roles, a setting target or binding:<host>:<sessionId> (each part URI-encoded and non-empty). */
export function isAdminTarget(target: string): boolean {
  if (target === "keys" || target === "global" || target === "roles" || (SETTING_TARGETS as readonly string[]).includes(target)
    || RETIRED_SETTING_TARGETS.includes(target)) return true;
  const parts = /^binding:([^:]+):([^:]+)$/.exec(target);
  if (!parts || target.length > 1000) return false;
  try { return bindingTarget(decodeURIComponent(parts[1]!), decodeURIComponent(parts[2]!)) === target; } catch { return false; }
}

export function buildIntent(change: AdminChange, prevTargetHash: string | null, issuedAt: string): string {
  // A new record may not use a retired setting; older ones still verify (parseIntent).
  if (change.op === "locale.set") throw new AdminError("ADMIN_CHANGE_INVALID", { op: change.op });
  const intent: AdminIntent = { v: ADMIN_INTENT_VERSION, domain: ADMIN_DOMAIN, rpId: ADMIN_RP_ID, target: changeTarget(change), prevTargetHash, change, issuedAt };
  return canonicalJson(intent, "Admin intent");
}

/** Parses a stored or submitted intent; only the exact canonical form of a well-formed intent is accepted. */
export function parseIntent(intent: string): AdminIntent {
  let parsed: AdminIntent;
  try {
    parsed = JSON.parse(intent) as AdminIntent;
    if (canonicalJson(parsed, "Admin intent") !== intent) throw new Error("noncanonical");
  } catch {
    throw new AdminError("ADMIN_INTENT_NONCANONICAL");
  }
  const keys = parsed && typeof parsed === "object" ? Object.keys(parsed).sort().join(",") : "";
  if (keys !== "change,domain,issuedAt,prevTargetHash,rpId,target,v" || parsed.v !== ADMIN_INTENT_VERSION || parsed.domain !== ADMIN_DOMAIN
    || parsed.rpId !== ADMIN_RP_ID || typeof parsed.target !== "string" || typeof parsed.issuedAt !== "string" || Number.isNaN(Date.parse(parsed.issuedAt))
    || !(parsed.prevTargetHash === null || typeof parsed.prevTargetHash === "string")) {
    throw new AdminError("ADMIN_INTENT_NONCANONICAL");
  }
  const change = checkChangeShape(parsed.change);
  if (changeTarget(change) !== parsed.target) throw new AdminError("ADMIN_CHANGE_INVALID", { target: parsed.target.slice(0, 100) });
  return parsed;
}

export function emptyAdminState(): AdminState {
  return { keys: new Map(), revoked: new Set(), bootstrap: null, global: null, globalHistory: [], roles: new Map(), bindings: new Map(),
    jev: null, jevKeys: new Map(), editExempt: null, heads: new Map(), keyLastUsed: new Map(), failures: [], lastSeq: 0 };
}

/**
 * Checks one change against the current state without applying it. `signer` is the credential that signs it. Throws
 * the reason a record with this change would be refused.
 */
export function checkChange(state: AdminState, change: AdminChange, signer: string): void {
  if (state.keys.size === 0) {
    // Trust on first use: only a key registering itself starts the log.
    if (change.op !== "key.add" || change.credentialId !== signer) throw new AdminError("ADMIN_KEY_NOT_REGISTERED");
  } else if (!state.keys.has(signer)) {
    throw new AdminError(state.revoked.has(signer) ? "ADMIN_KEY_REVOKED" : "ADMIN_KEY_UNKNOWN");
  }
  switch (change.op) {
    case "key.add":
      importAdminKey(change);
      if (state.keys.has(change.credentialId) || state.revoked.has(change.credentialId)) throw new AdminError("ADMIN_CHANGE_INVALID", { reason: "KEY_ALREADY_KNOWN" });
      return;
    case "key.revoke":
      if (!state.keys.has(change.credentialId)) throw new AdminError(state.revoked.has(change.credentialId) ? "ADMIN_KEY_REVOKED" : "ADMIN_KEY_UNKNOWN");
      if (state.keys.size === 1) throw new AdminError("ADMIN_LAST_KEY_REVOKE_REFUSED");
      return;
    case "global.set":
      return;
    case "role.add":
    case "role.rename": {
      const key = roleKey(change.name);
      const clash = [...state.roles.values()].find(role => role.key === key && role.roleId !== change.roleId);
      if (clash) throw new AdminError("ADMIN_CHANGE_INVALID", { reason: "ROLE_NAME_TAKEN", roleId: clash.roleId });
      if ((change.op === "role.add") === state.roles.has(change.roleId)) throw new AdminError("ADMIN_CHANGE_INVALID", { reason: change.op === "role.add" ? "ROLE_ID_TAKEN" : "ROLE_NOT_FOUND" });
      return;
    }
    case "role.delete":
      if (!state.roles.has(change.roleId)) throw new AdminError("ADMIN_CHANGE_INVALID", { reason: "ROLE_NOT_FOUND" });
      return;
    case "binding.set":
      if (change.roleId !== null && !state.roles.has(change.roleId)) throw new AdminError("ADMIN_CHANGE_INVALID", { reason: "ROLE_NOT_FOUND" });
      return;
    case "jevKey.delete":
      if (!state.jevKeys.has(change.name)) throw new AdminError("ADMIN_CHANGE_INVALID", { reason: "JEV_KEY_NOT_FOUND" });
      return;
    case "jev.set": {
      const unknown = Object.keys(change.presets).filter(id => !JEV_PRESETS.some(preset => preset.presetId === id));
      if (unknown.length) throw new AdminError("ADMIN_CHANGE_INVALID", { reason: "JEV_PRESET_UNKNOWN", presetId: unknown[0] });
      return;
    }
    case "ack": case "jevKey.set": case "locale.set": case "editExempt.set":
      return;
  }
}

function apply(state: AdminState, change: AdminChange, record: AdminLogRecord, intent: AdminIntent): void {
  switch (change.op) {
    case "key.add": {
      const key = { credentialId: change.credentialId, publicKey: change.publicKey, alg: change.alg, label: change.label,
        fingerprint: keyFingerprint(change.publicKey), addedAt: intent.issuedAt, addedSeq: record.seq };
      if (state.keys.size === 0 && !state.bootstrap) state.bootstrap = { credentialId: key.credentialId, fingerprint: key.fingerprint, at: intent.issuedAt };
      state.keys.set(key.credentialId, key);
      return;
    }
    case "key.revoke":
      state.keys.delete(change.credentialId);
      state.revoked.add(change.credentialId);
      return;
    case "global.set":
      state.global = { body: change.body, seq: record.seq, recordHash: record.recordHash, issuedAt: intent.issuedAt, credentialId: record.credentialId };
      state.globalHistory.unshift(state.global);
      return;
    case "role.add":
      state.roles.set(change.roleId, { roleId: change.roleId, name: change.name, key: roleKey(change.name), createdAt: intent.issuedAt, seq: record.seq });
      return;
    case "role.rename":
      state.roles.set(change.roleId, { ...state.roles.get(change.roleId)!, name: change.name, key: roleKey(change.name), seq: record.seq });
      return;
    case "role.delete":
      state.roles.delete(change.roleId);
      // A deleted role's bindings end with it; its ID is random and never comes back.
      for (const [key, binding] of state.bindings) if (binding.roleId === change.roleId) state.bindings.delete(key);
      return;
    case "binding.set":
      if (change.roleId === null) state.bindings.delete(bindingKey(change.host, change.sessionId));
      else state.bindings.set(bindingKey(change.host, change.sessionId), { host: change.host, sessionId: change.sessionId, roleId: change.roleId, boundAt: intent.issuedAt, seq: record.seq });
      return;
    case "jev.set":
      state.jev = { enabled: change.enabled, limitUsd: change.limitUsd, presets: { ...change.presets },
        model: change.model ? { ...change.model } : null, transmissionAllowed: change.transmissionAllowed ?? false,
        fallbackVendorId: change.fallbackVendorId ?? null, seq: record.seq, issuedAt: intent.issuedAt };
      return;
    case "jevKey.set":
      state.jevKeys.set(change.name, { name: change.name, fingerprint: change.fingerprint, seq: record.seq, issuedAt: intent.issuedAt });
      return;
    case "jevKey.delete":
      state.jevKeys.delete(change.name);
      return;
    case "locale.set":
      // Retired in 4.0.0: the record stays in the verified chain and changes nothing.
      return;
    case "editExempt.set":
      state.editExempt = { paths: [...change.paths], seq: record.seq, issuedAt: intent.issuedAt };
      return;
    case "ack":
      return;
  }
}

/** Verifies one record against the state before it; throws the reason it cannot be applied. */
export function verifyRecord(state: AdminState, record: AdminLogRecord): { intent: AdminIntent; change: AdminChange } {
  if (adminRecordHash(record) !== record.recordHash) throw new AdminError("ADMIN_RECORD_ALTERED");
  const intent = parseIntent(record.intent);
  if (intent.target !== record.target) throw new AdminError("ADMIN_CHANGE_INVALID", { reason: "TARGET_MISMATCH" });
  if (intent.prevTargetHash !== (state.heads.get(intent.target)?.recordHash ?? null)) throw new AdminError("ADMIN_TARGET_STALE");
  const change = intent.change;
  checkChange(state, change, record.credentialId);
  const key = state.keys.get(record.credentialId) ?? (change.op === "key.add" ? change : null);
  if (!key) throw new AdminError("ADMIN_KEY_UNKNOWN");
  verifyAdminAssertion(record.intent, record, key);
  return { intent, change };
}

/**
 * Folds the log in sequence order. A record applies only when its hash, canonical intent, target chain, signer and
 * signature are all valid against the state before it; otherwise it is recorded as a failure of its target and the
 * target keeps its last valid state. A tampered record therefore also invalidates the records chained after it.
 */
export function foldAdminLog(records: readonly AdminLogRecord[]): AdminState {
  const state = emptyAdminState();
  const failed: AdminFailure[] = [];
  for (const record of records) {
    state.lastSeq = Math.max(state.lastSeq, record.seq);
    try {
      const { intent, change } = verifyRecord(state, record);
      apply(state, change, record, intent);
      state.heads.set(intent.target, { recordHash: record.recordHash, seq: record.seq });
      state.keyLastUsed.set(record.credentialId, record.createdAt);
    } catch (error) {
      if (!(error instanceof AdminError)) throw error;
      let change: AdminChange | null;
      try { change = parseIntent(record.intent).change; } catch { change = null; }
      failed.push({ target: record.target, seq: record.seq, code: error.code, change });
    }
  }
  state.failures = failed.filter(failure => failure.seq > (state.heads.get(failure.target)?.seq ?? 0));
  return state;
}
