import type { ModelClassV1, ReasoningEffortV1 } from "../../contracts/types.js";
import defaultModelRoutingPresets from "../../skills/coordinate-subagents/references/model-routing-presets.json" with { type: "json" };
import type {
  HostExecutionAdapter,
  ModelCapabilityJudgmentV1,
  ResolvedModelCapabilityV1,
} from "./host-attestation.js";

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
  readonly hosts?: readonly string[];
  readonly minimum_efforts?: Readonly<Record<string, ReasoningEffortV1>>;
  readonly catalog?: ProviderModelCatalogV1;
}

export interface HostProviderBindingConfigV1 {
  readonly providers: readonly string[];
}

export interface ModelRoutingPresetsV1 {
  readonly schema_version: number;
  readonly policy_revision?: string;
  readonly model_class_order: readonly ModelClassV1[];
  readonly effort_order: readonly ReasoningEffortV1[];
  readonly hosts?: Readonly<Record<string, HostProviderBindingConfigV1 | readonly string[]>>;
  readonly providers: Readonly<Record<string, ModelRoutingProviderPresetV1>>;
}

export interface ExecutionAdapterSuiteV1 {
  readonly policyRevision: string;
  /** Only adapters supplied by trusted installation composition are candidates. */
  readonly adapters: ReadonlyMap<string, HostExecutionAdapter>;
}

interface BoundProviderCatalogV1 {
  readonly providerId: string;
  readonly entry: ModelRoutingProviderPresetV1;
}

const HOST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

function isValidHostName(value: unknown): value is string {
  return typeof value === "string" && HOST_NAME_PATTERN.test(value);
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
  const supportedEfforts = entry.supported_efforts ?? [];

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

function judgeFromProviderCatalogs(
  host: string,
  policyRevision: string,
  bindings: readonly BoundProviderCatalogV1[],
  rawModel: string,
  provenance: string = `${host}:adapter-policy`,
): ModelCapabilityJudgmentV1 {
  if (typeof rawModel !== "string" || rawModel.length === 0) {
    return {
      status: "undetermined",
      reason: "INVALID_MODEL_IDENTIFIER",
      host,
      rawModel: typeof rawModel === "string" ? rawModel : "",
      provider: null,
      modelClass: null,
      policyRevision,
      provenance,
    };
  }
  const matches: ResolvedModelCapabilityV1[] = [];
  for (const { providerId, entry } of bindings) {
    const resolved = resolveFromProviderCatalog(providerId, host, policyRevision, entry, rawModel, provenance);
    if (resolved) matches.push(resolved);
  }
  if (matches.length === 1) {
    return { status: "resolved", ...matches[0]! };
  }
  if (matches.length > 1) {
    return {
      status: "undetermined",
      reason: "AMBIGUOUS_PROVIDER_MATCH",
      host,
      rawModel,
      provider: null,
      modelClass: null,
      policyRevision,
      provenance,
    };
  }
  return {
    status: "undetermined",
    reason: "MODEL_NOT_IN_CATALOG",
    host,
    rawModel,
    provider: null,
    modelClass: null,
    policyRevision,
    provenance,
  };
}

function createHostAdapter(
  host: string,
  policyRevision: string,
  bindings: readonly BoundProviderCatalogV1[],
): HostExecutionAdapter {
  const frozenBindings = Object.freeze([...bindings]);
  const providers = Object.freeze(frozenBindings.map((item) => item.providerId));
  return Object.freeze({
    host,
    ...(frozenBindings.length === 1 ? { provider: frozenBindings[0]!.providerId } : {}),
    providers,
    policyRevision,
    judgeModel(model: string, provenance: string = `${host}:adapter-policy`): ModelCapabilityJudgmentV1 {
      return judgeFromProviderCatalogs(host, policyRevision, frozenBindings, model, provenance);
    },
    resolveModel(model: string, provenance: string = `${host}:adapter-policy`): ResolvedModelCapabilityV1 | null {
      const judged = judgeFromProviderCatalogs(host, policyRevision, frozenBindings, model, provenance);
      if (judged.status !== "resolved") return null;
      return {
        provider: judged.provider,
        host: judged.host,
        rawModel: judged.rawModel,
        resolvedModel: judged.resolvedModel,
        modelClass: judged.modelClass,
        minimumReasoningEffort: judged.minimumReasoningEffort,
        supportedEfforts: judged.supportedEfforts,
        aliasUsed: judged.aliasUsed,
        policyRevision: judged.policyRevision,
        provenance: judged.provenance,
      };
    },
    modelClassForModel(model: string): ModelClassV1 | null {
      const judged = judgeFromProviderCatalogs(host, policyRevision, frozenBindings, model);
      return judged.status === "resolved" ? judged.modelClass : null;
    },
  });
}

function bindProviderToHost(
  hostBindings: Map<string, BoundProviderCatalogV1[]>,
  host: string,
  providerId: string,
  entry: ModelRoutingProviderPresetV1,
): void {
  const list = hostBindings.get(host) ?? [];
  if (!list.some((item) => item.providerId === providerId)) {
    list.push({ providerId, entry });
    hostBindings.set(host, list);
  }
}

/**
 * Builds host execution adapters from the central routing/capability catalog JSON
 * (or an injected synthetic catalog for policy-update regression tests).
 * Hosts (execution environments) and providers (model vendors) are many-to-many:
 * one host may resolve models across multiple vendor catalogs by model ID, and
 * one vendor catalog may be shared across multiple hosts.
 */
export function createCatalogExecutionAdapters(
  presets: ModelRoutingPresetsV1 = defaultModelRoutingPresets as unknown as ModelRoutingPresetsV1,
): ExecutionAdapterSuiteV1 {
  if (!presets || typeof presets !== "object" || Array.isArray(presets)
    || !presets.providers || typeof presets.providers !== "object" || Array.isArray(presets.providers)) throw new Error("INVALID_EXECUTION_ADAPTER_CONFIGURATION");
  if (presets.hosts !== undefined && (!presets.hosts || typeof presets.hosts !== "object" || Array.isArray(presets.hosts))) {
    throw new Error("INVALID_EXECUTION_ADAPTER_CONFIGURATION");
  }
  const policyRevision = typeof presets.policy_revision === "string" && presets.policy_revision.length > 0
    ? presets.policy_revision
    : "1.0.0";
  const hostBindings = new Map<string, BoundProviderCatalogV1[]>();
  const referencedProviders = new Set<string>();

  if (presets.hosts) {
    for (const [host, hostConfig] of Object.entries(presets.hosts)) {
      if (!isValidHostName(host)) throw new Error("INVALID_EXECUTION_ADAPTER_HOST");
      const providerIds = Array.isArray(hostConfig)
        ? hostConfig
        : (hostConfig && typeof hostConfig === "object" && Array.isArray((hostConfig as HostProviderBindingConfigV1).providers)
          ? (hostConfig as HostProviderBindingConfigV1).providers
          : null);
      if (!providerIds || providerIds.length === 0) throw new Error("INVALID_EXECUTION_ADAPTER_HOST");
      for (const providerId of providerIds) {
        if (typeof providerId !== "string" || !Object.hasOwn(presets.providers, providerId)) {
          throw new Error("INVALID_EXECUTION_ADAPTER_HOST");
        }
        const entry = presets.providers[providerId];
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("INVALID_EXECUTION_ADAPTER_HOST");
        bindProviderToHost(hostBindings, host, providerId, entry);
        referencedProviders.add(providerId);
      }
    }
  }

  for (const [providerId, entry] of Object.entries(presets.providers)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("INVALID_EXECUTION_ADAPTER_HOST");
    const declaredHosts: string[] = [];
    if (entry.host !== undefined) {
      if (!isValidHostName(entry.host)) throw new Error("INVALID_EXECUTION_ADAPTER_HOST");
      declaredHosts.push(entry.host);
    }
    if (entry.hosts !== undefined) {
      if (!Array.isArray(entry.hosts) || entry.hosts.length === 0 || entry.hosts.some((host) => !isValidHostName(host))) {
        throw new Error("INVALID_EXECUTION_ADAPTER_HOST");
      }
      for (const host of entry.hosts) {
        if (!declaredHosts.includes(host)) declaredHosts.push(host);
      }
    }
    if (declaredHosts.length === 0 && !referencedProviders.has(providerId)) {
      throw new Error("INVALID_EXECUTION_ADAPTER_HOST");
    }
    for (const host of declaredHosts) {
      bindProviderToHost(hostBindings, host, providerId, entry);
    }
  }

  const adapters = new Map<string, HostExecutionAdapter>();
  for (const [host, bindings] of hostBindings.entries()) {
    adapters.set(host, createHostAdapter(host, policyRevision, bindings));
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

const defaultPresets = defaultModelRoutingPresets as unknown as ModelRoutingPresetsV1;
const defaultSuite = createCatalogExecutionAdapters(defaultPresets);

/** Bundled installation composition, not a host-name allowlist in the consumer. */
export const defaultExecutionAdapters: ReadonlyMap<string, HostExecutionAdapter> = defaultSuite.adapters;

export const claudeCodeExecutionAdapter: HostExecutionAdapter = defaultSuite.adapters.get("claude-code")!;
export const codexExecutionAdapter: HostExecutionAdapter = defaultSuite.adapters.get("codex")!;
export const geminiExecutionAdapter: HostExecutionAdapter = defaultSuite.adapters.get("gemini")!;
export const antigravityExecutionAdapter: HostExecutionAdapter = defaultSuite.adapters.get("antigravity")!;

export function modelClassForClaudeModel(model: string): ModelClassV1 | null {
  return resolveFromProviderCatalog(
    "anthropic-claude-code",
    "claude-code",
    defaultSuite.policyRevision,
    defaultPresets.providers["anthropic-claude-code"],
    model,
  )?.modelClass ?? null;
}

export function modelClassForGeminiModel(model: string): ModelClassV1 | null {
  return resolveFromProviderCatalog(
    "google-gemini",
    "gemini",
    defaultSuite.policyRevision,
    defaultPresets.providers["google-gemini"],
    model,
  )?.modelClass ?? null;
}
