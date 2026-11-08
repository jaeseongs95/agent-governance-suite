import path from "node:path";

import { type AdminJevState, type AdminState, foldAdminLog, JEV_PRESETS, EDIT_EXEMPT_MAX_PATHS } from "./admin-log.js";
import { ContextLayerStore } from "./context-layer-store.js";
import { resolveContextLayerDatabasePath } from "./runtime-config.js";
import type { ClassificationJevSettings } from "./skill-classification/service.js";
import type { ProviderProfile, ProviderProfileRegistry } from "./skill-classification/types.js";

/**
 * The settings the admin page edits (AGS3-T-0024), read the one way every reader uses: the signed admin log, folded and
 * verified on each read (admin-log.ts). A record that fails is not applied; the setting keeps its last valid revision,
 * else its default. The precedence with the older environment settings (docs/user/admin-page.md):
 * - The edit gate's exempt paths: an environment value set for the process wins; the page shows the item as locked by
 *   it. Without one, the signed value applies; without that, the earlier default.
 * - JEV (4.0.0): only the signed settings and the provider AGS ships. The installation's classification config, its
 *   provider runtime and environment variables do not turn JEV on or off, bound its budget, name its route or model, or
 *   supply its key. With no signed record JEV is off.
 */
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

/** The signed model's profile (jev-provider.ts); null when none is chosen or AGS does not know it. */
export type JevProfileFor = (model: { providerId: string; modelId: string }) => ProviderProfile | null;

/** What keeps JEV from being asked now, in the order the page lists it (D-0075). */
export type JevMissing = "SWITCH_OFF" | "MODEL_NOT_SELECTED" | "MODEL_UNSUPPORTED" | "TRANSMISSION_NOT_ALLOWED" | "KEY_MISSING"
  | "BUDGET_MISSING" | "BUDGET_BELOW_ONE_CALL" | "BUDGET_EXHAUSTED";

/**
 * Whether JEV can be asked now: switched on, a model AGS knows, sending allowed, a key registered on the page, and a
 * budget that covers one call's reservation. Presets are separate: a preset uses JEV only when this is ready and it is on.
 */
export function jevReadiness(signed: AdminJevState | null, input: { keyStored: boolean; profileFor: JevProfileFor;
  usage?: { spentUsd: number | null; reservedUsd: number } | null }): { ready: boolean; missing: JevMissing[]; perCallUsd: number | null } {
  const missing: JevMissing[] = [];
  if (!signed?.enabled) missing.push("SWITCH_OFF");
  const profile = signed?.model ? input.profileFor(signed.model) : null;
  if (!signed?.model) missing.push("MODEL_NOT_SELECTED");
  else if (!profile) missing.push("MODEL_UNSUPPORTED");
  if (!signed?.transmissionAllowed) missing.push("TRANSMISSION_NOT_ALLOWED");
  if (!input.keyStored) missing.push("KEY_MISSING");
  const limit = signed?.limitUsd ?? null, perCall = profile?.maximumCostUsd ?? null;
  if (limit === null) missing.push("BUDGET_MISSING");
  else if (perCall !== null && limit < perCall) missing.push("BUDGET_BELOW_ONE_CALL");
  else if (perCall !== null && input.usage && input.usage.spentUsd !== null && input.usage.spentUsd + input.usage.reservedUsd + perCall > limit) missing.push("BUDGET_EXHAUSTED");
  return { ready: missing.length === 0, missing, perCallUsd: perCall };
}

/**
 * The classification runtime with JEV as the user signed it: on only with JEV and the skill classification preset on;
 * the installation's JEV profiles are dropped and the signed model's profile is the only JEV profile; the signed consent
 * and fallback travel with it. Vendor profiles and settings stay as the installation gives them.
 */
export function applyAdminJev<T extends { config: { jevEnabled: boolean }; registry: ProviderProfileRegistry; jev?: ClassificationJevSettings }>(
  runtime: T, signed: AdminJevState | null, profileFor: JevProfileFor): T & { jev: ClassificationJevSettings } {
  const enabled = (signed?.enabled ?? false) && jevPresetSwitches(signed)["skill-classification"] === true;
  const profile = enabled && signed?.model ? profileFor(signed.model) : null;
  const vendors = runtime.registry.profiles.filter(candidate => candidate.providerKind !== "jev");
  return { ...runtime, config: { ...runtime.config, jevEnabled: enabled },
    registry: { ...runtime.registry, profiles: profile ? [profile, ...vendors] : vendors },
    jev: { transmissionAllowed: enabled && signed!.transmissionAllowed, fallbackVendorId: enabled ? signed!.fallbackVendorId : null } };
}

// --- What the page shows ------------------------------------------------------------------------------------------

export interface AdminSignedSettings {
  jev: AdminJevState | null;
  jevKeys: Array<{ name: string; fingerprint: string; setAt: string; stored: boolean }>;
  editExempt: { paths: string[]; seq: number; issuedAt: string } | null;
}

/** The installation's classification settings as far as the page needs them now: vendors only. */
export interface JevInstallationView {
  configured: boolean;
  /** Vendors with a profile in the installation's registry (the choices for the fallback). */
  vendorIds: string[];
  /** Credential names the installation's remote vendor routes ask for, with the vendors that use each. */
  credentials: Array<{ name: string; vendorIds: string[] }>;
  /** JEV settings the installation still carries and AGS no longer reads (routes, profiles), for the migration notice. */
  ignoredJev: { routes: number; profiles: number };
  error: string | null;
}

/** The provider AGS ships, as the page shows it. */
export interface JevProviderView {
  providerId: string;
  label: string;
  endpoint: string;
  credentialName: string;
  /** What one call reserves from the budget. */
  perCallUsd: number;
  catalog:{ status: string; updatedAt: string | null; refreshHours: number; models: string[] };
  /** The fields one call sends (from the provider's wire encoding). */
  transmitted: { request: string[]; task: string[]; perSkill: string[] };
}

export interface AdminSettingsView {
  editGateExceptions: { paths: string[]; source: "environment" | "signed" | "none"; signedPaths: string[]; environmentPaths: string[];
    lockedBy: string | null; editable: boolean; maxPaths: number };
  jev: {
    signed: boolean; switchOn: boolean;
    /** Whether JEV can be asked now, and what is missing when it cannot (D-0075). */
    ready: boolean; missing: JevMissing[];
    presets: Array<{ presetId: string; tool: string; enabled: boolean }>;
    model: { providerId: string; modelId: string } | null;
    transmissionAllowed: boolean;
    fallback: { vendorId: string | null; options: string[] };
    providers: JevProviderView[];
    budget: { signedLimitUsd: number | null; perCallUsd: number | null };
    /** The page server process's own tally (spent since it started, plus reservations); null when it keeps none. */
    usage: { spentUsd: number | null; reservedUsd: number } | null;
    keys: Array<{ name: string; vendorIds: string[]; jev: boolean; fingerprint: string | null; setAt: string | null; stored: boolean; environment: boolean }>;
    installation: { configured: boolean; ignoredJev: { routes: number; profiles: number }; error: string | null };
  };
}

export function adminSettingsView(input: {
  environment: NodeJS.ProcessEnv;
  signed: AdminSignedSettings;
  installation: JevInstallationView;
  usage: { spentUsd: number | null; reservedUsd: number } | null;
  providers: JevProviderView[];
  profileFor: JevProfileFor;
}): AdminSettingsView {
  const { environment, signed, installation } = input;
  const environmentPaths = environmentExemptPaths(environment);
  const signedPaths = signed.editExempt?.paths ?? [];
  const jevNames = new Set(input.providers.map(provider => provider.credentialName));
  const names = new Map<string, string[]>([...jevNames].map(name => [name, []]));
  for (const credential of installation.credentials) names.set(credential.name, [...(names.get(credential.name) ?? []), ...credential.vendorIds]);
  for (const key of signed.jevKeys) if (!names.has(key.name)) names.set(key.name, []);
  const chosen = signed.jev?.model ? input.providers.find(provider => provider.providerId === signed.jev!.model!.providerId) : input.providers[0];
  const keyStored = signed.jevKeys.some(key => key.name === (chosen?.credentialName ?? "") && key.stored);
  const readiness = jevReadiness(signed.jev, { keyStored, profileFor: input.profileFor, usage: input.usage });
  return {
    editGateExceptions: { paths: environmentPaths ?? signedPaths, source: environmentPaths ? "environment" : signedPaths.length ? "signed" : "none",
      signedPaths, environmentPaths: environmentPaths ?? [], lockedBy: environmentPaths ? EDIT_EXEMPT_ENVIRONMENT : null, editable: !environmentPaths,
      maxPaths: EDIT_EXEMPT_MAX_PATHS },
    jev: {
      signed: signed.jev !== null, switchOn: signed.jev?.enabled ?? false, ready: readiness.ready, missing: readiness.missing,
      presets: JEV_PRESETS.map(preset => ({ presetId: preset.presetId, tool: preset.tool, enabled: jevPresetSwitches(signed.jev)[preset.presetId] === true })),
      model: signed.jev?.model ?? null, transmissionAllowed: signed.jev?.transmissionAllowed ?? false,
      fallback: { vendorId: signed.jev?.fallbackVendorId ?? null, options: installation.vendorIds },
      providers: input.providers,
      budget: { signedLimitUsd: signed.jev?.limitUsd ?? null, perCallUsd: readiness.perCallUsd ?? chosen?.perCallUsd ?? null },
      usage: input.usage,
      keys: [...names].sort(([a], [b]) => a.localeCompare(b)).map(([name, vendorIds]) => {
        const key = signed.jevKeys.find(candidate => candidate.name === name);
        // Only whether the variable is set is shown, never its value; a JEV key name's variable is not used (4.0.0).
        return { name, vendorIds: [...new Set(vendorIds)].sort(), jev: jevNames.has(name), fingerprint: key?.fingerprint ?? null, setAt: key?.setAt ?? null,
          stored: key?.stored ?? false, environment: Boolean(environment[name]) };
      }),
      installation: { configured: installation.configured, ignoredJev: installation.ignoredJev, error: installation.error },
    },
  };
}
