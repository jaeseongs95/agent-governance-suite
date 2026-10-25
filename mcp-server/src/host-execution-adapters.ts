import type { ModelClassV1, ReasoningEffortV1 } from "../../contracts/types.js";
import { REASONING_EFFORT } from "../../contracts/types.js";
import defaultModelRoutingPresets from "../../skills/coordinate-subagents/references/model-routing-presets.json" with { type: "json" };
import type { HostExecutionAdapter, ResolvedModelCapabilityV1 } from "./host-attestation.js";

import { resolveCatalogModel, type CatalogMatchingStrategyV1 } from "../../skills/coordinate-subagents/scripts/model-catalog-adapter.mjs";
export type { CatalogMatchingStrategyV1 } from "../../skills/coordinate-subagents/scripts/model-catalog-adapter.mjs";

export interface CatalogModelEntryV1 {
  readonly model_class: ModelClassV1;
  readonly minimum_effort?: ReasoningEffortV1;
  readonly supported_efforts?: readonly ReasoningEffortV1[];
}

export interface ProviderModelCatalogV1 {
  readonly matching: CatalogMatchingStrategyV1;
  readonly models: Readonly<Record<string, CatalogModelEntryV1>>;
  readonly aliases?: Readonly<Record<string, string>>;
}

export interface ModelRoutingProviderPresetV1 {
  readonly host?: string;
  readonly minimum_efforts?: Readonly<Record<string, ReasoningEffortV1>>;
  readonly catalog?: ProviderModelCatalogV1;
}

export interface ModelRoutingPresetsV1 {
  readonly schema_version: number;
  readonly policy_revision?: string;
  readonly model_class_order: readonly ModelClassV1[];
  readonly effort_order: readonly ReasoningEffortV1[];
  readonly providers: Readonly<Record<string, ModelRoutingProviderPresetV1>>;
}

export interface ExecutionAdapterSuiteV1 {
  readonly policyRevision: string;
  /** Only adapters supplied by trusted installation composition are candidates. */
  readonly adapters: ReadonlyMap<string, HostExecutionAdapter>;
}

function resolveFromProviderCatalog(
  providerId: string,
  host: string,
  policyRevision: string,
  providerEntry: ModelRoutingProviderPresetV1 | undefined,
  rawModel: string,
  provenance: string = "adapter-policy",
): ResolvedModelCapabilityV1 | null {
  if (typeof rawModel !== "string" || rawModel.length === 0 || !providerEntry?.catalog) return null;
  const catalog = providerEntry.catalog;
  const models = catalog.models ?? {};
  const minimumEfforts = providerEntry.minimum_efforts ?? {};

  const canonicalKey = resolveCatalogModel(catalog, rawModel);
  if (!canonicalKey) return null;
  const entry = models[canonicalKey]!;
  const minimumReasoningEffort = minimumEfforts[rawModel]
    ?? minimumEfforts[canonicalKey]
    ?? entry.minimum_effort
    ?? null;
  const supportedEfforts = entry.supported_efforts && entry.supported_efforts.length > 0
    ? entry.supported_efforts
    : REASONING_EFFORT;

  return {
    provider: providerId,
    host,
    rawModel,
    resolvedModel: canonicalKey,
    modelClass: entry.model_class,
    minimumReasoningEffort,
    supportedEfforts,
    aliasUsed: rawModel !== canonicalKey,
    policyRevision,
    provenance,
  };
}

function createHostAdapter(
  providerId: string,
  host: string,
  policyRevision: string,
  providerEntry: ModelRoutingProviderPresetV1 | undefined,
): HostExecutionAdapter {
  return Object.freeze({
    host,
    provider: providerId,
    policyRevision,
    resolveModel(model: string, provenance: string = `${host}:adapter-policy`): ResolvedModelCapabilityV1 | null {
      return resolveFromProviderCatalog(providerId, host, policyRevision, providerEntry, model, provenance);
    },
    modelClassForModel(model: string): ModelClassV1 | null {
      return resolveFromProviderCatalog(providerId, host, policyRevision, providerEntry, model)?.modelClass ?? null;
    },
  });
}

/**
 * Builds vendor execution adapters from the single central routing/capability catalog JSON
 * (or an injected synthetic catalog for policy-update regression tests).
 */
export function createCatalogExecutionAdapters(
  presets: ModelRoutingPresetsV1 = defaultModelRoutingPresets as unknown as ModelRoutingPresetsV1,
): ExecutionAdapterSuiteV1 {
  if (!presets || typeof presets !== "object" || Array.isArray(presets)
    || !presets.providers || typeof presets.providers !== "object" || Array.isArray(presets.providers)) throw new Error("INVALID_EXECUTION_ADAPTER_CONFIGURATION");
  const policyRevision = typeof presets.policy_revision === "string" && presets.policy_revision.length > 0
    ? presets.policy_revision
    : "1.0.0";
  const adapters = new Map<string, HostExecutionAdapter>();
  for (const [providerId, entry] of Object.entries(presets.providers)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("INVALID_EXECUTION_ADAPTER_HOST");
    const host = entry.host;
    // Missing identity is an explicit configuration failure, never another host default.
    if (typeof host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(host)) throw new Error("INVALID_EXECUTION_ADAPTER_HOST");
    if (adapters.has(host)) throw new Error("DUPLICATE_EXECUTION_ADAPTER_HOST");
    adapters.set(host, createHostAdapter(providerId, host, policyRevision, entry));
  }
  // Object.freeze(Map) does not freeze its entries. Do not expose the mutable backing map.
  const view: ReadonlyMap<string, HostExecutionAdapter> = Object.freeze({
    size: adapters.size,
    get: (host: string) => adapters.get(host),
    has: (host: string) => adapters.has(host),
    entries: () => adapters.entries(), keys: () => adapters.keys(), values: () => adapters.values(),
    forEach(callback: (value: HostExecutionAdapter, key: string, map: ReadonlyMap<string, HostExecutionAdapter>) => void, thisArg?: unknown): void {
      adapters.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
    [Symbol.iterator]: () => adapters[Symbol.iterator](),
    [Symbol.toStringTag]: "ReadonlyMap",
  });
  return Object.freeze({policyRevision, adapters: view});
}

const defaultSuite = createCatalogExecutionAdapters();

/** Bundled installation composition, not a host-name allowlist in the consumer. */
export const defaultExecutionAdapters: ReadonlyMap<string, HostExecutionAdapter> = defaultSuite.adapters;

export const claudeCodeExecutionAdapter: HostExecutionAdapter = defaultSuite.adapters.get("claude-code")!;
export const codexExecutionAdapter: HostExecutionAdapter = defaultSuite.adapters.get("codex")!;
export const geminiExecutionAdapter: HostExecutionAdapter = defaultSuite.adapters.get("gemini")!;

export function modelClassForClaudeModel(model: string): ModelClassV1 | null {
  return claudeCodeExecutionAdapter.modelClassForModel(model);
}

export function modelClassForGeminiModel(model: string): ModelClassV1 | null {
  return geminiExecutionAdapter.modelClassForModel(model);
}
