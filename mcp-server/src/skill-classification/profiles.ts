import {readFile} from "node:fs/promises";
import {digestClassificationValue} from "./digest.js";
import type {ProviderConfiguration, ProviderProfile, ProviderProfileRegistry, SkillClassificationRequestV1} from "./types.js";

// Registry data is supplied by the approved environment; there are no qualified defaults.
export async function loadProviderProfileRegistry(path: string): Promise<ProviderProfileRegistry> {
  const bytes = await readFile(path);
  if (bytes.length > 1024 * 1024) throw new Error("PROVIDER_PROFILE_REGISTRY_TOO_LARGE");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isProviderProfileRegistry(value)) throw new Error("INVALID_PROVIDER_PROFILE_REGISTRY");
  return value;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const onlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const configurationKeys = ["profileId", "providerKind", "vendorId", "modelId", "modelRevision", "reasoningEffort", "supportedOptions", "approvedRouteRef", "qualificationRevision", "adapterRevision", "promptRevision", "maximumInputBytes", "maximumOutputTokens", "maximumCostUsd", "judgmentPolicy"];

/** The shared wire/configuration shape has no qualification or expiry fields. */
export function isProviderConfiguration(profile: unknown): profile is ProviderConfiguration {
  if (!object(profile) || !onlyKeys(profile, configurationKeys)) return false;
  for (const field of ["profileId", "vendorId", "modelId", "modelRevision", "approvedRouteRef", "qualificationRevision", "adapterRevision", "promptRevision"]) if (!text(profile[field])) return false;
  if (profile.providerKind !== "jev" && profile.providerKind !== "vendor") return false;
  if (profile.reasoningEffort !== null && !text(profile.reasoningEffort)) return false;
  if (!positiveInteger(profile.maximumInputBytes) || !positiveInteger(profile.maximumOutputTokens)) return false;
  if (profile.maximumCostUsd !== null && (typeof profile.maximumCostUsd !== "number" || !Number.isFinite(profile.maximumCostUsd) || profile.maximumCostUsd < 0)) return false;
  if (!object(profile.supportedOptions) || !onlyKeys(profile.supportedOptions, ["structuredOutput", "reasoningEfforts"]) || typeof profile.supportedOptions.structuredOutput !== "boolean" || !Array.isArray(profile.supportedOptions.reasoningEfforts)
    || !profile.supportedOptions.reasoningEfforts.every((effort: unknown) => effort === null || text(effort))) return false;
  if (profile.judgmentPolicy !== null) {
    if (!object(profile.judgmentPolicy) || !onlyKeys(profile.judgmentPolicy, ["neededAt", "notNeededAt"])) return false;
    const {neededAt, notNeededAt} = profile.judgmentPolicy;
    if (typeof neededAt !== "number" || typeof notNeededAt !== "number" || !Number.isFinite(neededAt) || !Number.isFinite(notNeededAt)
      || neededAt > 1 || notNeededAt < 0 || notNeededAt >= neededAt) return false;
  }
  return true;
}

/** Bind all profile configuration, including qualificationRevision; exclude the qualification record itself. */
export function digestProviderProfileConfiguration(profile: ProviderProfile | Omit<ProviderProfile, "qualification">): string {
  return digestClassificationValue(Object.fromEntries(Object.entries(profile).filter(([key]) => key !== "qualification")));
}

export function isProviderProfileRegistry(value: unknown): value is ProviderProfileRegistry {
  if (!object(value) || !onlyKeys(value, ["schemaVersion", "profileRevision", "profiles"]) || value.schemaVersion !== "1.0.0" || !text(value.profileRevision) || !Array.isArray(value.profiles)) return false;
  const ids = new Set<string>();
  return value.profiles.every((profile: unknown) => {
    if (!object(profile) || !onlyKeys(profile, [...configurationKeys, "qualification"])
      || !isProviderConfiguration(Object.fromEntries(Object.entries(profile).filter(([key]) => key !== "qualification")))) return false;
    const q = profile.qualification;
    if (!object(q) || !onlyKeys(q, ["status", "inventoryDigest", "taxonomyRevision", "modelRevision", "promptRevision", "validUntil", "profileConfigurationDigest"]) || !["PASS", "FAIL", "NOT_RUN"].includes(String(q.status)) || !["inventoryDigest", "taxonomyRevision", "modelRevision", "promptRevision", "validUntil"].every((field) => text(q[field]))
      || typeof q.profileConfigurationDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(q.profileConfigurationDigest)) return false;
    const id = String(profile.profileId);
    if (ids.has(id)) return false;
    ids.add(id);
    return true;
  });
}

export function selectFixedProfile(registry: ProviderProfileRegistry, kind: "jev" | "vendor", vendorId: string): ProviderProfile | null {
  const matches = registry.profiles.filter((profile) => profile.providerKind === kind && (kind === "jev" || profile.vendorId === vendorId));
  return matches.length === 1 ? matches[0]! : null;
}

export function validateProviderProfile(profile: ProviderProfile, request: SkillClassificationRequestV1, nowMs: number): string | null {
  if (!isProviderProfileRegistry({schemaVersion: "1.0.0", profileRevision: "validation", profiles: [profile]})) return "INVALID_PROFILE";
  const q = profile.qualification;
  if (q.profileConfigurationDigest !== digestProviderProfileConfiguration(profile)) return "QUALIFICATION_CONFIGURATION_MISMATCH";
  if (q.status !== "PASS") return "PROFILE_UNQUALIFIED";
  if (q.inventoryDigest !== request.inventoryDigest || q.taxonomyRevision !== request.taxonomyRevision || q.modelRevision !== profile.modelRevision || q.promptRevision !== profile.promptRevision) return "QUALIFICATION_MISMATCH";
  if (!Number.isFinite(Date.parse(q.validUntil)) || Date.parse(q.validUntil) <= nowMs) return "QUALIFICATION_EXPIRED";
  if (!profile.supportedOptions.structuredOutput || !profile.supportedOptions.reasoningEfforts.includes(profile.reasoningEffort)) return "UNSUPPORTED_OPTIONS";
  if (profile.maximumCostUsd === null) return "COST_UNKNOWN";
  if (profile.providerKind === "jev" && (profile.judgmentPolicy === null || profile.reasoningEffort !== null)) return "UNSUPPORTED_OPTIONS";
  return null;
}

export interface TokenPrices {uncachedInputUsdPer1k: number | null; cachedInputUsdPer1k: number | null; outputUsdPer1k: number | null}
export function estimateTokenCostUsd(prices: TokenPrices, inputTokens: number, cachedInputTokens: number, outputTokens: number): number | null {
  if (![inputTokens, cachedInputTokens, outputTokens].every((n) => Number.isSafeInteger(n) && n >= 0) || cachedInputTokens > inputTokens) return null;
  const terms = [[inputTokens - cachedInputTokens, prices.uncachedInputUsdPer1k], [cachedInputTokens, prices.cachedInputUsdPer1k], [outputTokens, prices.outputUsdPer1k]] as const;
  if (terms.some(([tokens, price]) => tokens > 0 && (price === null || !Number.isFinite(price) || price < 0))) return null;
  return terms.reduce((total, [tokens, price]) => total + (tokens === 0 ? 0 : tokens * price! / 1000), 0);
}
