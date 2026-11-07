import path from "node:path";

import { type AdminJevState, type AdminState, foldAdminLog, JEV_BUDGET_MAX_USD, JEV_PRESETS, EDIT_EXEMPT_MAX_PATHS } from "./admin-log.js";
import { ContextLayerStore } from "./context-layer-store.js";
import { resolveContextLayerDatabasePath } from "./runtime-config.js";

/**
 * The settings the admin page edits (AGS3-T-0024), read the one way every reader uses: the signed admin log, folded and
 * verified on each read (admin-log.ts). A record that fails is not applied; the setting keeps its last valid revision,
 * else its default. The precedence with the older environment settings (docs/admin-page.md):
 * - The display locale and the edit gate's exempt paths: an environment value set for the process wins; the page shows
 *   the item as locked by it. Without one, the signed value applies; without that, the earlier default.
 * - JEV: the installation's classification config (AGENT_GOVERNANCE_CLASSIFICATION_CONFIG) bounds it (its jevEnabled
 *   and its budget); the signed switch turns it on inside that bound. The narrower of the two applies, and with no
 *   signed record JEV is off.
 * - A JEV key: an environment variable of the route's credential name wins over a key registered on the page.
 */
export const LOCALE_ENVIRONMENT_NAME = "AGENT_GOVERNANCE_LOCALE";
export const EDIT_EXEMPT_ENVIRONMENT = "AGENT_GOVERNANCE_PHASE_EXEMPT_PATHS";
export const CLASSIFICATION_CONFIG_ENVIRONMENT = "AGENT_GOVERNANCE_CLASSIFICATION_CONFIG";

/** The verified state of the shared file; null when nobody saved anything yet. Throws when the file cannot be read. */
export function readVerifiedAdminState(databasePath: string): AdminState | null {
  const store = ContextLayerStore.open(databasePath, false);
  if (!store) return null;
  try { return foldAdminLog(store.logRecords()); } finally { store.close(); }
}

export function verifiedAdminState(environment: NodeJS.ProcessEnv): AdminState | null {
  return readVerifiedAdminState(resolveContextLayerDatabasePath(environment));
}

/** The signed display locale: a value, a read failure, or null (none signed, or "follow the settings file"). */
export function signedLocale(environment: NodeJS.ProcessEnv): { value: string } | { failure: "LOCALE_SIGNED_UNREADABLE" } | null {
  let state: AdminState | null;
  try { state = verifiedAdminState(environment); } catch { return { failure: "LOCALE_SIGNED_UNREADABLE" }; }
  const locale = state?.locale?.locale ?? null;
  return locale === null ? null : { value: locale };
}

/** The environment's list, read as the edit gate always did: the platform delimiter, absolute entries only. */
export function environmentExemptPaths(environment: NodeJS.ProcessEnv): string[] | null {
  const raw = environment[EDIT_EXEMPT_ENVIRONMENT];
  if (raw === undefined || raw.trim() === "") return null;
  return raw.split(path.delimiter).map(entry => entry.trim()).filter(entry => path.isAbsolute(entry));
}

/**
 * The edit gate's extra exempt directories: the environment's list when it is set, else the signed list. A signed list
 * that cannot be read adds nothing (the gate stays closed for those paths, never opened by a failure).
 */
export function editExemptPaths(environment: NodeJS.ProcessEnv, read: () => AdminState | null = () => verifiedAdminState(environment)): string[] {
  const configured = environmentExemptPaths(environment);
  if (configured) return configured;
  try { return read()?.editExempt?.paths ?? []; } catch { return []; }
}

/** Each preset's switch: on unless the signed record turned it off. */
export function jevPresetSwitches(signed: AdminJevState | null): Record<string, boolean> {
  return Object.fromEntries(JEV_PRESETS.map(preset => [preset.presetId, signed?.presets[preset.presetId] ?? true]));
}

/** JEV runs only when the installation allows it and the user turned it on (default off). */
export function jevEnabled(installationAllows: boolean, signed: AdminJevState | null): boolean {
  return installationAllows && (signed?.enabled ?? false);
}

/** The JEV budget in force: the narrower of the installation's and the signed one, never above the server cap. */
export function jevBudgetLimit(installationLimitUsd: number | null, signedLimitUsd: number | null): number | null {
  const limits = [installationLimitUsd, signedLimitUsd].filter((limit): limit is number => limit !== null);
  return limits.length ? Math.min(JEV_BUDGET_MAX_USD, ...limits) : null;
}

/** The classification runtime with JEV as the user decided: off unless JEV and the skill classification preset are on. */
export function applyAdminJev<T extends { config: { jevEnabled: boolean } }>(runtime: T, signed: AdminJevState | null): T {
  const enabled = jevEnabled(runtime.config.jevEnabled, signed) && jevPresetSwitches(signed)["skill-classification"] === true;
  return { ...runtime, config: { ...runtime.config, jevEnabled: enabled } };
}

// --- What the page shows ------------------------------------------------------------------------------------------

export interface AdminSignedSettings {
  jev: AdminJevState | null;
  jevKeys: Array<{ name: string; fingerprint: string; setAt: string; stored: boolean }>;
  locale: { locale: string | null; seq: number; issuedAt: string } | null;
  editExempt: { paths: string[]; seq: number; issuedAt: string } | null;
}

export interface JevInstallationView {
  configured: boolean;
  /** The config's jevEnabled (true when there is no config: nothing then bounds it, and there are no routes either). */
  allows: boolean;
  mode: string | null;
  profileCount: number;
  limitUsd: number | null;
  /** Credential names the approved remote routes ask for, with the vendors that use each. */
  credentials: Array<{ name: string; vendorIds: string[] }>;
  error: string | null;
}

export interface AdminSettingsView {
  locale: { value: string; source: string; signed: string | null; options: readonly string[]; lockedBy: string | null; editable: boolean };
  editGateExceptions: { paths: string[]; source: "environment" | "signed" | "none"; signedPaths: string[]; environmentPaths: string[];
    lockedBy: string | null; editable: boolean; maxPaths: number };
  jev: {
    configured: boolean; installationAllows: boolean; enabled: boolean; signed: boolean; mode: string | null; profileCount: number; error: string | null;
    switchOn: boolean; presets: Array<{ presetId: string; tool: string; enabled: boolean }>;
    budget: { installationLimitUsd: number | null; signedLimitUsd: number | null; limitUsd: number | null; maxUsd: number };
    /** The page server process's own tally (spent since it started, plus reservations); null when it keeps none. */
    usage: { spentUsd: number | null; reservedUsd: number } | null;
    keys: Array<{ name: string; vendorIds: string[]; fingerprint: string | null; setAt: string | null; stored: boolean; environment: boolean }>;
    lockedBy: string | null;
  };
}

export function adminSettingsView(input: {
  environment: NodeJS.ProcessEnv;
  signed: AdminSignedSettings;
  locale: { value: string; source: string };
  localeOptions: readonly string[];
  installation: JevInstallationView;
  usage: { spentUsd: number | null; reservedUsd: number } | null;
}): AdminSettingsView {
  const { environment, signed, installation } = input;
  const localeLocked = environment[LOCALE_ENVIRONMENT_NAME] !== undefined;
  const environmentPaths = environmentExemptPaths(environment);
  const signedPaths = signed.editExempt?.paths ?? [];
  const names = new Map(installation.credentials.map(credential => [credential.name, credential.vendorIds]));
  for (const key of signed.jevKeys) if (!names.has(key.name)) names.set(key.name, []);
  return {
    locale: { value: input.locale.value, source: input.locale.source, signed: signed.locale?.locale ?? null, options: input.localeOptions,
      lockedBy: localeLocked ? LOCALE_ENVIRONMENT_NAME : null, editable: !localeLocked },
    editGateExceptions: { paths: environmentPaths ?? signedPaths, source: environmentPaths ? "environment" : signedPaths.length ? "signed" : "none",
      signedPaths, environmentPaths: environmentPaths ?? [], lockedBy: environmentPaths ? EDIT_EXEMPT_ENVIRONMENT : null, editable: !environmentPaths,
      maxPaths: EDIT_EXEMPT_MAX_PATHS },
    jev: {
      configured: installation.configured, installationAllows: installation.allows, enabled: jevEnabled(installation.allows, signed.jev),
      signed: signed.jev !== null, mode: installation.mode, profileCount: installation.profileCount, error: installation.error,
      switchOn: signed.jev?.enabled ?? false,
      presets: JEV_PRESETS.map(preset => ({ presetId: preset.presetId, tool: preset.tool, enabled: jevPresetSwitches(signed.jev)[preset.presetId] === true })),
      budget: { installationLimitUsd: installation.limitUsd, signedLimitUsd: signed.jev?.limitUsd ?? null,
        limitUsd: jevBudgetLimit(installation.limitUsd, signed.jev?.limitUsd ?? null), maxUsd: JEV_BUDGET_MAX_USD },
      usage: input.usage,
      keys: [...names].sort(([a], [b]) => a.localeCompare(b)).map(([name, vendorIds]) => {
        const key = signed.jevKeys.find(candidate => candidate.name === name);
        // Only whether the variable is set is shown, never its value.
        return { name, vendorIds, fingerprint: key?.fingerprint ?? null, setAt: key?.setAt ?? null, stored: key?.stored ?? false,
          environment: Boolean(environment[name]) };
      }),
      lockedBy: installation.configured && !installation.allows ? CLASSIFICATION_CONFIG_ENVIRONMENT : null,
    },
  };
}
